# -*- coding: utf-8 -*-
"""issue #20 回归：显卡算力 vs CUDA 包支持范围（no kernel image 的根因）。

背景：torch 轮子只在编译时把**部分算力**焊进去（cu128 实测 sm_70/75/80/86/90/100/120）。
比这个范围更老的卡（Kepler / Maxwell / Pascal，GTX 10 系及更早）驱动层仍然认卡，
torch.cuda.is_available() 也是 True —— 于是「装完自检通过」，一到推理就炸：
CUDA error: no kernel image is available for execution on the device（issue #20）。

这里锁死三件事：
  1) arch_supported() 的兼容规则（sm cubin 同大版本向下兼容 / compute PTX 向上即时编译）；
  2) cuda_error_kind() 能把这条报错认出来（供「自动改用 CPU」触发）；
  3) engine_gpu._probe() 在算力不匹配时把 device 判成 cpu、onnx 退回 CPUExecutionProvider。
"""
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import engine_gpu  # noqa: E402

# 本机装的 cu128 轮子的真实列表（与 issue #20 用户环境同源）
CU128 = ["sm_70", "sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"]


@pytest.mark.parametrize("cap,archs,expected", [
    ((6, 1), CU128, False),          # ★ issue #20：GTX 1060 / Pascal —— 有卡也没 kernel
    ((5, 2), CU128, False),          # Maxwell
    ((3, 7), CU128, False),          # Kepler
    ((7, 0), CU128, True),           # sm_70 的 cubin 在 sm_7x 上可用
    ((7, 5), CU128, True),
    ((8, 0), CU128, True),           # sm_80 cubin 在 sm_86 上可用（同大版本向下兼容）
    ((8, 6), ["sm_80"], True),       # 同上；反向不成立（见下一条）
    ((8, 0), ["sm_86"], False),
    ((8, 9), ["sm_86"], True),
    ((12, 0), CU128, True),          # Blackwell 有 sm_120
    ((12, 0), ["sm_90", "compute_90"], True),   # 仅 PTX：12.0 >= 9.0，可即时编译
    ((7, 0), ["compute_75"], False),            # PTX 目标比设备新 → 不行
    ((7, 0), ["compute_70"], True),
    ((8, 0), [], None),              # 信息不足 → 不下结论
    ((8, 0), ["gfx1100"], False),    # ROCm 的 gfx 版本不能当 sm 用
    (None, CU128, None),
])
def test_arch_supported(cap, archs, expected):
    assert engine_gpu.arch_supported(cap, archs) is expected


def test_min_supported_arch():
    assert engine_gpu.min_supported_arch(CU128) == (7, 0)
    assert engine_gpu.min_supported_arch(["compute_90"]) is None
    assert engine_gpu.min_supported_arch([]) is None


def test_parse_arch():
    assert engine_gpu._parse_arch("sm_86") == ("sm", 8, 6)
    assert engine_gpu._parse_arch("compute_120") == ("compute", 12, 0)
    for bad in ("", "sm", "sm_x", "sm_8", "gfx1100", None, "s_86"):
        assert engine_gpu._parse_arch(bad) is None


def test_cuda_error_kind_and_hint():
    issue20 = "CUDA error: no kernel image is available for execution on the device"
    assert engine_gpu.cuda_error_kind(issue20) == "no_kernel_image"
    assert "CPU" in engine_gpu.cuda_error_hint("no_kernel_image")
    assert engine_gpu.cuda_error_kind("CUDA out of memory. Tried to allocate 2.00 GiB") == "oom"
    assert engine_gpu.cuda_error_kind("CUDA error: device-side assert triggered") == "device_assert"
    assert engine_gpu.cuda_error_kind("an illegal memory access was encountered") == "illegal_memory"
    assert engine_gpu.cuda_error_kind("RuntimeError: something else") == ""
    assert engine_gpu.cuda_error_hint("") == ""


def test_probe_downgrades_when_arch_unsupported(monkeypatch):
    """把算力伪装成 sm_61（GTX 10 系）：device 必须是 cpu，且 onnx 退回 CPU。"""
    torch = pytest.importorskip("torch")
    if not torch.cuda.is_available():
        pytest.skip("本机没有可用的 CUDA，无法模拟算力不匹配")
    monkeypatch.setattr(torch.cuda, "get_device_capability", lambda *a, **k: (6, 1))
    gpu = engine_gpu._probe()
    assert gpu["cuda"] is True                  # 驱动层仍然认卡（自检照样通过 —— 这正是坑）
    assert gpu["arch_supported"] is False
    assert gpu["cuda_usable"] is False
    assert gpu["device"] == "cpu"               # ★ 关键：显式降到 CPU
    assert "sm_61" in gpu["arch_reason"]
    assert gpu["onnx_provider"] == "CPUExecutionProvider"


def test_probe_keeps_cuda_when_arch_supported():
    """本机（算力在支持范围内）必须仍然走 GPU —— 修复不能把好机器一起降级。"""
    torch = pytest.importorskip("torch")
    if not torch.cuda.is_available():
        pytest.skip("本机没有可用的 CUDA")
    gpu = engine_gpu._probe()
    assert gpu["arch_supported"] is True
    assert gpu["device"] == "cuda"
    assert gpu["onnx_provider"] == "CUDAExecutionProvider"


def _fake_muscriptor(monkeypatch, tmp_path, fail_first=True):
    """把 muscriptor 换成假实现：第一次按 GPU 加载并在推理时抛 CUDA 错误。"""
    muscriptor = pytest.importorskip("muscriptor")
    import engine_muscriptor as M
    load_calls = []

    class _Dev:
        def __init__(self, t):
            self.type = t

    class FakeModel:
        def __init__(self, t):
            self._device = _Dev(t)

        @classmethod
        def load_model(cls, arg, device=None, **kw):
            load_calls.append(device)
            return cls("cuda" if device in (None, "cuda", "mps") else "cpu")

        def transcribe(self, path, **kw):
            if self._device.type != "cpu" and fail_first:
                raise RuntimeError(
                    "CUDA error: no kernel image is available for execution on the device")
            return []

        def events_to_midi_bytes(self, events, beat_grid=None):
            return b"MThd" + b"\x00" * 10

    monkeypatch.setattr(muscriptor, "TranscriptionModel", FakeModel)
    monkeypatch.setattr(M, "_require_package", lambda: None)
    monkeypatch.setattr(M, "_count_notes", lambda p: 0)
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF")
    import audio_io
    monkeypatch.setattr(audio_io, "decode_to_wav", lambda p, sr=16000: str(wav))
    monkeypatch.setattr(audio_io, "remove_temp", lambda p: None)
    monkeypatch.setattr(M, "_find_local_model", lambda size: str(tmp_path / "model.safetensors"))
    monkeypatch.setattr(M, "_ensure_config", lambda *a, **k: None)
    return M, load_calls


def test_muscriptor_cuda_error_falls_back_to_cpu(monkeypatch, tmp_path):
    """★ issue #20 兜底：算力不匹配的报错不该让整次转录失败 —— 自动改用 CPU 重跑一次。"""
    M, load_calls = _fake_muscriptor(monkeypatch, tmp_path)
    logs = []
    out = str(tmp_path / "out.mid")
    M.transcribe_muscriptor(str(tmp_path / "in.wav"), out,
                            params={"model_size": "medium"}, log_cb=logs.append)
    assert load_calls[0] is None or str(load_calls[0]).startswith("cuda")   # 先按 GPU 试
    assert load_calls[-1] == "cpu"                 # ★ 失败后落到 CPU
    assert any("no kernel image" in s for s in logs), logs
    assert any("CPU" in s for s in logs), logs      # 日志说明原因，用户知道发生了什么


def test_muscriptor_oom_still_halves_batch(monkeypatch, tmp_path):
    """OOM 仍然走「批量减半」老路径，不能被新的 CUDA 分支抢走。"""
    M, load_calls = _fake_muscriptor(monkeypatch, tmp_path, fail_first=False)
    import muscriptor

    class OomModel(muscriptor.TranscriptionModel):
        def transcribe(self, path, **kw):
            if kw.get("batch_size", 1) >= 2:
                raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")
            return []

    monkeypatch.setattr(muscriptor, "TranscriptionModel", OomModel)
    logs = []
    M.transcribe_muscriptor(str(tmp_path / "in.wav"), str(tmp_path / "o.mid"),
                            params={"model_size": "medium", "muscriptor_batch": 4},
                            log_cb=logs.append)
    assert any("显存不足" in s for s in logs), logs
    assert not any("改用 CPU" in s for s in logs), logs   # OOM 不该触发 CPU 重跑
    assert len(load_calls) == 1                           # 没有重新加载模型

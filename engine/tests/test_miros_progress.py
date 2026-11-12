# -*- coding: utf-8 -*-
"""MIROS 进度透传（2026-11-12）

背景：MIROS 原先整曲一次性黑盒调用，任务中心/转录页一直停在起始值（3%），
结束时直接跳 100。修复后 engine_miros 自己按上游顺序驱动，在阶段边界与
每个推理批次打 `###PROG`，并支持暂停闸门。

这里锁住三件事：
1. `_emit_prog` 的输出形态（主进程 main/engine.js 与前端 ViewTranscribe 都靠它）。
2. 上游结构不符时抛 `_UpstreamShapeError`（调用方据此回落整调接口）。
3. 完整驱动流程的进度语义：阶段百分比覆盖 3→100，推理阶段携带 completed/total。
"""
import json
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import engine_miros  # noqa: E402


def _capture(log_cb_holder):
    def log_cb(msg):
        log_cb_holder.append(msg)
    return log_cb


def _prog_lines(lines):
    out = []
    for m in lines:
        s = m.strip()
        if s.startswith("###PROG "):
            out.append(json.loads(s[len("###PROG "):]))
    return out


def test_emit_prog_shapes():
    lines = []
    engine_miros._emit_prog(_capture(lines), completed=8, total=24)
    engine_miros._emit_prog(_capture(lines), percent=42.35, label="加载模型")
    engine_miros._emit_prog(_capture(lines), completed=8, total=24, percent=20.5, label="推理中")
    # 空 payload（什么都没给）不应该打行
    engine_miros._emit_prog(_capture(lines))
    # 没有 log_cb 也不能崩
    engine_miros._emit_prog(None, percent=10)

    ps = _prog_lines(lines)
    assert len(ps) == 3
    assert ps[0] == {"completed": 8, "total": 24}
    assert ps[1] == {"percent": 42.4, "label": "加载模型"}   # round(x,1)
    assert ps[2] == {"completed": 8, "total": 24, "percent": 20.5, "label": "推理中"}


def test_upstream_shape_error_when_symbols_missing():
    mt = types.SimpleNamespace(load_model_checkpoint=lambda args: None)  # 只有一半符号
    with pytest.raises(engine_miros._UpstreamShapeError) as ei:
        engine_miros._run_upstream_with_progress(mt, "a.wav", "b.mid", log_cb=None)
    assert "slice_padded_array" in str(ei.value)


def test_pause_wait_without_gate_is_noop():
    # 没有装 pause_gate 时不能抛（常驻 worker 里每条路径都会经过它）
    engine_miros._pause_wait()


def _fake_upstream(frames, n_seg, out_midi):
    """构造一个与上游 transcribe 模块同形的最小桩（不加载真模型）。"""
    calls = {"pause_checked": 0}

    class _Ns:
        def detach(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            import numpy as np
            # (B, C, L)：C 必须 >= 模型的解码通道数（桩里是 2）
            return np.zeros((1, 2, 4), dtype="float32")

    class _Model:
        audio_cfg = {"input_frames": frames, "sample_rate": 16000}

        def __init__(self):
            self.task_manager = types.SimpleNamespace(
                num_decoding_channels=2,
                detokenize_list_batches=lambda arrs, starts, return_events=True: ([], [], 0),
            )
            self.midi_output_inverse_vocab = {}

        def inference(self, x, task_tokens=None):
            calls["inference"] = calls.get("inference", 0) + 1
            assert task_tokens is None
            return _Ns()

    mt = types.ModuleType("fake_transcribe")
    mt.load_model_checkpoint = lambda args: _Model()

    def _slice(audio, hop, win):
        import numpy as np
        return np.zeros((n_seg, frames), dtype="float32")

    mt.slice_padded_array = _slice
    # 上游 merge 的第二个返回值是 Counter（engine_miros 会 `n_err_cnt += ...`）
    from collections import Counter
    mt.merge_zipped_note_events_and_ties_to_notes = lambda zipped: ([], Counter())
    mt.mix_notes = lambda notes: []

    def _write(pred_notes, output_dir, base, inv):
        p = os.path.join(output_dir, base + ".mid")
        with open(p, "wb") as f:
            f.write(b"MThd")
        return p

    mt.write_model_output_as_midi = _write
    return mt


def test_full_drive_reports_monotonic_progress(tmp_path):
    """端到端驱动（假上游 + 真 torch）：进度单调上升，推理段带 completed/total。"""
    pytest.importorskip("torch")
    pytest.importorskip("torchaudio")
    import numpy as np
    import soundfile as sf

    # 与真实路径一致：torchaudio>=2.9 的 load 依赖 torchcodec（运行时没打包），
    # engine_miros 在开头会打这个补丁 —— 测试里同样要打，否则读不了 wav。
    import transcribe_runtime as TR
    assert TR.patch_torchaudio_soundfile()

    # 1 秒静音 wav，段长 8000 帧 → 至少 2 段（n_seg 由桩固定为 30）
    wav = tmp_path / "in.wav"
    sf.write(str(wav), np.zeros(16000, dtype="float32"), 16000)

    frames, n_seg = 8000, 30
    mt = _fake_upstream(frames, n_seg, str(tmp_path / "out.mid"))

    lines = []
    out = engine_miros._run_upstream_with_progress(mt, str(wav), str(tmp_path / "out.mid"),
                                                   _capture(lines))
    assert out and os.path.exists(out)

    ps = _prog_lines(lines)
    assert ps, "必须至少打出一条 ###PROG"

    # 阶段点存在
    pct = [p["percent"] for p in ps if "percent" in p]
    assert pct[0] == 3 and pct[-1] == 100
    assert pct == sorted(pct), "总进度必须单调不减"

    # 推理阶段：completed/total 递增，percent 落在 20~90
    # （含推理开始前的 {completed:0,total:N} 起点行，之后每批一条）
    infer = [p for p in ps if "completed" in p and "total" in p]
    assert len(infer) == (n_seg + 7) // 8 + 1
    assert infer[0]["completed"] == 0 and "percent" not in infer[0]
    assert infer[1]["completed"] == 8
    assert infer[-1]["completed"] == n_seg
    for p in infer[1:]:
        assert p["total"] == n_seg
        assert 20 <= p["percent"] <= 90

    # 推理批次逐批推进（不是一次性跳到底）
    rates = [p["percent"] for p in infer[1:]]
    assert len(set(rates)) == len(rates)

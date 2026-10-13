# -*- coding: utf-8 -*-
"""v20（Worldline-R2）链路：WORLD 特征 → mel ONNX → 128bin/512hop 声码器。

上游 `Classic/WorldlineRenderer.cs:150-175`。这一路**不需要 native worldline.dll 也不需要
参考仓库**，所以能在这里端到端跑：两头 ONNX 都是普通文件。

盯住三件事：
  1. mel 模型**随包**（83.4 KB，sha256 固定）—— 它是 v20 自足的前提，丢了要立刻发现；
  2. 帧数**补到 16 的倍数**，且输出样本数 = 补齐后帧数 × 512（帧长/hop 一旦错位，这条必挂）；
  3. 缺资源时给的是**可行动的报错**，不是 NotImplementedError。

声码器（55 MB）不在仓库里，找不到时跳过数值部分、只测报错文案。
"""

import hashlib
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from singing.openutau.classic import worldline_renderer as WR  # noqa: E402

#: 随包 mel 模型的 sha256（来源与上游 commit 见 docs/VENDOR.md）
MEL_SHA256 = "1493ffc868c6fb8b66104e2c6a2902cbf1a8c02bb09215db014f02e9d0e82f94"

#: 机器上装好的通用声码器（与 test_diffsinger_multilang.py 同款约定）
INSTALLED_VOCODER = (r"E:\Midi\FuFumidi\FuFumidiData\diffsinger\vocoder"
                     r"\nsf_hifigan_44.1k_hop512_128bin_2024.02.onnx")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """默认不看机器上的环境变量，否则测的就不是被测代码了。"""
    monkeypatch.delenv("FUFUMIDI_MEL_ONNX", raising=False)
    monkeypatch.delenv("FUFUMIDI_R2_VOCODER", raising=False)
    monkeypatch.delenv("FUFUMIDI_DATA_ROOT", raising=False)


def test_bundled_mel_model_is_present_and_pinned():
    """mel 模型随包 —— 这是 v20 唯一必须自带的东西（83.4 KB）。"""
    assert os.path.isfile(WR.R2_MEL_BUNDLED), WR.R2_MEL_BUNDLED
    raw = open(WR.R2_MEL_BUNDLED, "rb").read()
    assert 60_000 < len(raw) < 120_000, "大小异常：%d" % len(raw)
    assert hashlib.sha256(raw).hexdigest() == MEL_SHA256
    assert WR.resolve_mel_model() == WR.R2_MEL_BUNDLED


def test_mel_model_resolution_order(monkeypatch, tmp_path):
    """环境变量 → 数据根 → 随包。"""
    mine = tmp_path / "mine.onnx"
    mine.write_bytes(b"x")
    monkeypatch.setenv("FUFUMIDI_MEL_ONNX", str(mine))
    assert WR.resolve_mel_model() == str(mine)

    monkeypatch.delenv("FUFUMIDI_MEL_ONNX")
    root = tmp_path / "data"
    (root / "diffsinger" / "mel").mkdir(parents=True)
    inroot = root / "diffsinger" / "mel" / "mel.onnx"
    inroot.write_bytes(b"y")
    monkeypatch.setenv("FUFUMIDI_DATA_ROOT", str(root))
    assert WR.resolve_mel_model() == str(inroot)


def test_missing_mel_model_error_is_actionable(monkeypatch, tmp_path):
    """随包那份被人删掉时，报错要说清楚：哪条路径、多大、怎么补救。"""
    monkeypatch.setattr(WR, "R2_MEL_BUNDLED", str(tmp_path / "nope.onnx"))
    monkeypatch.setenv("FUFUMIDI_DATA_ROOT", str(tmp_path / "empty"))
    with pytest.raises(RuntimeError) as e:
        WR.resolve_mel_model()
    msg = str(e.value)
    assert "FUFUMIDI_MEL_ONNX" in msg and "83.4 KB" in msg, msg


def test_missing_vocoder_error_is_actionable(monkeypatch, tmp_path):
    """没有 128bin/512hop 声码器时，指向资源中心的通用声码器。"""
    monkeypatch.setenv("FUFUMIDI_DATA_ROOT", str(tmp_path / "empty"))
    with pytest.raises(RuntimeError) as e:
        WR.resolve_r2_vocoder()
    msg = str(e.value)
    assert "128bin/512hop" in msg and "通用声码器" in msg, msg


def test_vocoder_env_override_and_hop_preference(monkeypatch, tmp_path):
    """环境变量最优先；数据根里优先挑 hop512+128bin，其余 onnx 兜底。"""
    mine = tmp_path / "mine.onnx"
    mine.write_bytes(b"x")
    monkeypatch.setenv("FUFUMIDI_R2_VOCODER", str(mine))
    assert WR.resolve_r2_vocoder() == str(mine)

    monkeypatch.delenv("FUFUMIDI_R2_VOCODER")
    d = tmp_path / "data" / "diffsinger" / "vocoder"
    d.mkdir(parents=True)
    (d / "aaa_other_44k_hop256_80bin.onnx").write_bytes(b"a")
    (d / "zzz_nsf_hifigan_44.1k_hop512_128bin.onnx").write_bytes(b"z")
    monkeypatch.setenv("FUFUMIDI_DATA_ROOT", str(tmp_path / "data"))
    assert os.path.basename(WR.resolve_r2_vocoder()).startswith("zzz_")


def test_synth_r2_is_no_longer_a_stub():
    """别再退回 NotImplementedError —— 这个桩曾经挂了很久。"""
    import inspect
    src = inspect.getsource(WR.WorldlineRenderer._synth_r2)
    assert "NotImplementedError" not in src
    assert "synth_features()" in src and "r2_synthesize(" in src
    assert WR.WorldlineRenderer(version=20).hop_size == 512


def _vocoder_or_skip():
    """优先用环境变量/数据根；都没有就看本机装好的那份。"""
    try:
        return WR.resolve_r2_vocoder()
    except RuntimeError:
        pass
    if os.path.isfile(INSTALLED_VOCODER):
        os.environ["FUFUMIDI_R2_VOCODER"] = INSTALLED_VOCODER
        return INSTALLED_VOCODER
    pytest.skip("本机没有 128bin/512hop 声码器")


def _shape(T):
    """上游 `WorldlineRenderer.cs:140-143`：`ceil((T + 12) / 16) * 16`，左边固定 4 帧。"""
    padded = -(-(T + 12) // 16) * 16
    return padded, 4, padded - T - 4


def test_r2_pad_matches_upstream():
    """补帧的三条语义：左 4 / 补到 16 的倍数 / **ap 补 1 而不是 0**。"""
    np = pytest.importorskip("numpy")
    S = 1025
    for T in (1, 15, 16, 17, 32, 40, 47, 64):
        f0 = np.full(T, 220.0, np.float32)
        sp = np.full((T, S), 0.5, np.float32)
        ap = np.full((T, S), 0.25, np.float32)
        padded, left, f0p, spp, app = WR.r2_pad(T, f0.reshape(-1), sp.reshape(-1),
                                               ap.reshape(-1), S)
        ep, el, er = _shape(T)
        assert (padded, left) == (ep, el), "T=%d → %r" % (T, (padded, left))
        assert padded % 16 == 0 and padded > T, "T=%d 补后 %d" % (T, padded)
        assert f0p.shape == (padded,) and spp.shape == (padded, S) and app.shape == (padded, S)
        # 左侧 4 帧 + 右侧 right 帧是补的；中间原样保留
        assert f0p[:left].tolist() == [0.0] * left and f0p[left + T:].tolist() == [0.0] * er
        assert (spp[:left] == 0).all() and (spp[left + T:] == 0).all()
        assert (app[:left] == 1).all() and (app[left + T:] == 1).all(), "ap 补的是 1"
        assert np.allclose(f0p[left:left + T], f0) and np.allclose(app[left:left + T], ap)


def test_r2_synthesize_chain_and_frame_padding():
    """端到端：合成特征 → mel → 波形；输出**只留 T 帧**并做首尾淡入淡出。"""
    pytest.importorskip("onnxruntime")
    np = pytest.importorskip("numpy")
    _vocoder_or_skip()

    S = WR.FFT_SIZE // 2 + 1
    assert S == 1025, "WORLD 特征宽 = fftSize/2+1"

    rng = np.random.default_rng(7)
    for T in (16, 32, 40, 47):
        f0 = np.full(T, 220.0, np.float32)
        sp = np.exp(rng.normal(-1.0, 0.4, (T, S))).astype(np.float32)
        ap = np.full((T, S), 1e-4, np.float32)
        wave = np.asarray(WR.r2_synthesize(T, f0.reshape(-1), sp.reshape(-1),
                                           ap.reshape(-1), S), np.float32)
        # ★ 上游 :183 裁掉左补的 4 帧、只取 T 帧 —— 不是补后长度
        assert wave.size == T * 512, "T=%d → %d 样本（应为 %d）" % (T, wave.size, T * 512)
        assert np.isfinite(wave).all(), "T=%d 波形有非有限值" % T
        assert np.abs(wave).max() > 1e-6, "T=%d 波形是静音" % T
        # ★ 上游 :184-193 首尾各 512 样本线性淡入淡出：第 0 个样本增益恰为 0
        assert wave[0] == 0.0, "T=%d 没有淡入（wave[0]=%r）" % (T, wave[0])
        peak = int(np.argmax(np.abs(wave)))
        assert abs(wave[-1]) < abs(wave[peak]), "T=%d 没有淡出" % T

def test_r2_synthesize_empty_is_safe():
    """0 帧不报错也不跑模型（空乐句的常见情形）。"""
    assert WR.r2_synthesize(0, [], [], [], 1025) == []

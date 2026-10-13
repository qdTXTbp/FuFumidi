# -*- coding: utf-8 -*-
"""hnsep 谐波/噪声分离的回归（OpenUtau.Core/Analysis/Hnsep.cs 的移植）。

上游 `Separate` 的签名刻意把网络参数化成 `predictMask` 回调，注释写明
「the network, **or a stand-in in tests**」—— 所以这里不需要 57 MB 的 ONNX 就能测：

**核心性质**：掩码恒为 1 时，ISTFT(STFT(x)) 必须**还原 x**。
这条同时压住了帧对齐的整数除法、centered 零填充、DC/Nyquist 取实、
以及「重叠相加除以窗平方和」四件事 —— 任何一处搬错都还原不回来。

真实模型的端到端验证另做（需要 hnsep_240512 包，不进 CI）。
"""
import os
import sys

import numpy as np
import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from singing.openutau import hnsep  # noqa: E402


def test_periodic_hann_is_periodic_not_symmetric():
    w = hnsep.periodic_hann(8)
    # periodic：分母 n。首个样本为 0、且**不以对称点收尾**（symmetric 版两端都是 0）
    assert abs(w[0] - 0.0) < 1e-12
    assert abs(w[-1] - (0.5 - 0.5 * np.cos(2 * np.pi * 7 / 8))) < 1e-12
    # symmetric 版会是 w[0]=w[-1]=0；这里必须不是
    assert abs(w[-1]) > 1e-6


def test_config_loads_from_yaml(tmp_path):
    p = tmp_path / 'hnsep.yaml'
    p.write_text('model: model.onnx\nsample_rate: 44100\nn_fft: 2048\nhop_length: 512\n', encoding='utf-8')
    c = hnsep.HnsepConfig.load(str(p))
    assert (c.model, c.sample_rate, c.n_fft, c.hop_length) == ('model.onnx', 44100, 2048, 512)


def _ones_mask(inp):
    """恒等掩码：实部 1、虚部 0 → 不改变频谱。"""
    shape = inp.shape  # [1, 2, bins, frames]
    out = np.zeros(shape, dtype=np.float32)
    out[0, 0] = 1.0
    return out.ravel()


#: 必须 > 2*n_fft，否则中段切片为空（n_fft=2048）
@pytest.mark.parametrize('n', [8192, 44100, 12345])
def test_identity_mask_reconstructs_input(n):
    rng = np.random.default_rng(7)
    x = rng.standard_normal(n) * 0.3
    w = hnsep.periodic_hann(2048)
    y = hnsep.separate(x, 2048, 512, w, _ones_mask)
    assert y.shape[0] == n, '输出必须与输入等长'
    # 恒等掩码下应还原。★ 只比中段：端点处窗平方和趋近 0（centered 零填充的边缘），
    # 上游用 `wsum > 1e-11` 兜底置 0，那里本就不该比。
    mid = slice(2048, n - 2048)
    assert mid.stop > mid.start, '样本太短，改用 > 2*n_fft 的长度'
    err = np.max(np.abs(y[mid] - x[mid]))
    assert err < 1e-9, '帧对齐/归一化搬错了：max|Δ|=%.3e' % err


def test_output_is_real_and_finite():
    x = np.sin(2 * np.pi * 440 * np.arange(44100) / 44100)
    w = hnsep.periodic_hann(2048)
    y = hnsep.separate(x, 2048, 512, w, _ones_mask)
    assert np.all(np.isfinite(y))
    assert np.isrealobj(y)


def test_zero_mask_gives_silence():
    def zeros_mask(inp):
        return np.zeros(inp.shape, dtype=np.float32).ravel()

    x = np.sin(2 * np.pi * 440 * np.arange(44100) / 44100)
    w = hnsep.periodic_hann(2048)
    y = hnsep.separate(x, 2048, 512, w, zeros_mask)
    assert np.max(np.abs(y)) < 1e-12, '全零掩码必须出静音'

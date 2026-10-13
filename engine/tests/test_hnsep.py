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

# ---------------------------------------------------------------- autoload（WP4-4）


def _reset():
    """每个用例都从干净状态起 —— 这两处都是**模块级**单例，会互相串。"""
    from singing.openutau import worldline
    hnsep._AUTOLOAD = None
    hnsep.set_instance(None)
    worldline.set_hnsep(None)


def _fake_package(root, model='model.onnx'):
    """造一个"看起来像"解包后的包目录（只放 yaml + 一个占位 onnx）。"""
    d = os.path.join(str(root), hnsep.PACKAGE_DIR_REL)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'hnsep.yaml'), 'w', encoding='utf-8') as f:
        f.write('model: %s\nsample_rate: 44100\nn_fft: 2048\nhop_length: 512\n' % model)
    with open(os.path.join(d, model), 'wb') as f:
        f.write(b'not-a-real-onnx')
    return d


def test_candidate_dirs_matches_resource_center_layout(tmp_path):
    """★ 落点契约：引擎去 `<模型目录>/hnsep/hnsep_240512/` 找。

    这个字面量与资源中心那条目（`main/models.js` 的 `hnsep_240512`）必须是**同一件事**；
    两边写不一致时**不会报错**，只会表现为"下载完了 v11 还说没装"。改任一边都要改这里。
    """
    assert hnsep.PACKAGE_DIR_REL == os.path.join('hnsep', hnsep.PACKAGE_ID)
    assert hnsep.PACKAGE_ID == 'hnsep_240512'
    ds = hnsep.candidate_dirs(str(tmp_path))
    assert ds[0] == os.path.join(str(tmp_path), 'hnsep', 'hnsep_240512')
    assert ds[1] == os.path.join(str(tmp_path), 'hnsep')      # 摊平放的兜底
    assert hnsep.candidate_dirs.__defaults__ == ('',)


def test_autoload_missing_is_harmless(tmp_path):
    """没装 → 返回 None 且**不抛错**，但要留下可读的原因。"""
    _reset()
    assert hnsep.autoload(str(tmp_path)) is None
    why = hnsep.autoload_error()
    assert why and 'missing' in why, why
    assert os.path.join(str(tmp_path), 'hnsep') in why, '原因里要写清找过哪'
    _reset()


def test_autoload_injects_into_worldline(tmp_path, monkeypatch):
    """★ 这条是重点：autoload 必须真的把实例注进 `worldline`（而不只是返回）。"""
    from singing.openutau import worldline

    class _Fake:
        sample_rate = 44100

        def harmonic(self, x):
            return list(x)

    fake = _Fake()
    monkeypatch.setattr(hnsep, 'load_package_dir', lambda d: fake)
    _fake_package(tmp_path)
    _reset()

    assert hnsep.autoload(str(tmp_path)) is fake
    assert hnsep.get_instance() is fake
    assert worldline._default_hnsep() is fake, '没注进去 → v11 仍然会说"没有装"'
    assert hnsep.autoload_error() is None
    _reset()


def test_autoload_swallows_load_failure(tmp_path, monkeypatch):
    """包坏了也**不抛**（包只坏在 v11 上，别的路径不该跟着挂）。"""
    def boom(d):
        raise RuntimeError('包坏了')

    monkeypatch.setattr(hnsep, 'load_package_dir', boom)
    _fake_package(tmp_path)
    _reset()

    assert hnsep.autoload(str(tmp_path)) is None
    assert '包坏了' in (hnsep.autoload_error() or '')
    _reset()


def test_autoload_caches_the_miss(tmp_path, monkeypatch):
    """失败也要缓存 —— v11 是**逐乐句**调的，不缓存就是每句扫一次盘。"""
    seen = []
    real = hnsep.candidate_dirs
    monkeypatch.setattr(hnsep, 'candidate_dirs',
                        lambda md='': (seen.append(md), real(md))[1])
    _reset()

    hnsep.autoload(str(tmp_path))
    first = len(seen)
    assert first > 0
    hnsep.autoload(str(tmp_path))
    hnsep.autoload(str(tmp_path))
    assert len(seen) == first, '第二次以后不该再扫盘'
    # force=True 必须能突破缓存
    hnsep.autoload(str(tmp_path), force=True)
    assert len(seen) > first
    _reset()


def test_autoload_with_garbage_model_does_not_raise(tmp_path):
    """走**真的** ONNX 加载路径：占位文件必然被 onnxruntime 拒，但必须被吞掉。"""
    pytest.importorskip('onnxruntime')
    _fake_package(tmp_path)
    _reset()
    assert hnsep.autoload(str(tmp_path)) is None
    assert hnsep.autoload_error(), '失败必须留下原因'
    _reset()


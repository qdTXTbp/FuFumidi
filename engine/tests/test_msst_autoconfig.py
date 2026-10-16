# -*- coding: utf-8 -*-
"""msst_autoconfig.analyze：从权重形状推结构量的回归锁。

为什么钉它：dim_head 曾经拿 `dim // heads` 推，而 MSST 里 inner_dim 常常 ≠ dim
（实测 dim 384 / heads 8 / dim_head 64 → inner 512），写错会让 rotary_embed.freqs 对不上
（期望 32、给成 24），pymss 直接 size mismatch，模型就"用不了"了。
"""
import os
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import msst_autoconfig as A  # noqa: E402


def _mel_band_sd(dim=384, heads=8, dim_head=64, depth=6, bands=60, stems=1, mid_depth=(0, 2, 4)):
    inner = heads * dim_head
    sd = {}
    for i in range(depth):
        pre = 'layers.%d.0.layers.0.' % i
        sd[pre + 'norm.gamma'] = torch.zeros(dim)
        sd[pre + 'to_qkv.weight'] = torch.zeros(3 * inner, dim)
        sd[pre + 'to_gates.weight'] = torch.zeros(heads, dim)
        sd[pre + 'rotary_embed.freqs'] = torch.zeros(dim_head // 2)
        sd[pre + 'to_out.0.weight'] = torch.zeros(dim, inner)
    sd['band_split.to_features.0.weight'] = torch.zeros(4, 4, 1, 1)
    for s in range(stems):
        for b in range(bands):
            for k in mid_depth:
                sd['mask_estimators.%d.to_freqs.%d.0.%d.weight' % (s, b, k)] = torch.zeros(8, 8)
    return sd


def test_dim_head_not_dim_over_heads():
    info = A.analyze(_mel_band_sd(dim=384, heads=8, dim_head=64))
    assert info['family'] == 'mel_band_roformer'
    assert info['dim'] == 384 and info['heads'] == 8
    # ★ 关键：64，不是 384 // 8 = 48
    assert info['dim_head'] == 64
    assert info['depth'] == 6 and info['num_bands'] == 60 and info['num_stems'] == 1
    assert info['mask_estimator_depth'] == 2
    assert info['linear_transformer_depth'] == 0


def test_dim_head_can_equal_dim_over_heads():
    info = A.analyze(_mel_band_sd(dim=256, heads=8, dim_head=32, depth=4, bands=8, stems=2))
    assert info['dim_head'] == 32 and info['num_stems'] == 2 and info['num_bands'] == 8


def test_non_roformer_returns_none():
    assert A.analyze({'encoder.0.weight': torch.zeros(2, 2)}) is None


def test_family_map_matches_main():
    # 与 main/separate-common.js 的 archSelfConfigurable 保持同一份清单
    assert A.family_for_arch('Mel-Band Roformer') == 'mel_band_roformer'
    assert A.family_for_arch('BS-Roformer') == 'bs_roformer'
    assert A.family_for_arch('HTDemucs') == 'htdemucs'
    assert A.family_for_arch('MDX23C') == 'mdx23c'
    assert A.family_for_arch('Apollo') == 'apollo'
    assert A.family_for_arch('UVR-VR') is None


def test_cache_path_prefers_cache_dir(tmp_path, monkeypatch):
    monkeypatch.setenv('FUFUMIDI_CACHE_DIR', str(tmp_path))
    p = A._cache_path('E:/models/vocal/x/thick.ckpt')
    assert p.startswith(str(tmp_path)) and p.endswith('thick.ckpt.yaml')
    assert os.path.isdir(os.path.join(str(tmp_path), 'msst_autocfg'))

# -*- coding: utf-8 -*-
"""转录选项回归：各模型预设的识别片段长度 / 低显存批上限 / 降噪默认值。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import presets as P
import engine_pt


def test_builtin_segment_sec_values():
    b = P._builtin_presets()
    assert b["Basic Pitch · 最优"]["params"]["segment_sec"] == 0
    assert b["MuScriptor · 最优"]["params"]["segment_sec"] == 5
    assert b["MuScriptor · 最优"]["params"].get("timbre_stabilize") is True
    st = b["MuScriptor · 音色稳定"]["params"]
    assert st["segment_sec"] == 5
    assert st["muscriptor_instruments"] == "probe"
    assert st["timbre_stabilize"] is True
    # A/B 后固化：MuScriptor 三规格默认指向音色稳定
    for key in ("muscriptor_small", "muscriptor_medium", "muscriptor_large"):
        assert P.MODEL_DEFAULT_PRESET[key] == "MuScriptor · 音色稳定"
    assert b["钢琴 · 最优"]["params"]["segment_sec"] == 10
    assert b["Aria-AMT · 最优"]["params"]["segment_sec"] == 30
    assert b["Transkun · 最优"]["params"]["segment_sec"] == 16


def test_builtin_denoise_off_by_default():
    b = P._builtin_presets()
    for name in ("Basic Pitch · 最优", "MuScriptor · 最优", "钢琴 · 最优", "分离 · 最优"):
        assert b[name]["params"].get("denoise_mode") == "off"


def test_piano_batch_cap_low_memory():
    assert engine_pt._batch_cap("quality", "cuda") == 32
    assert engine_pt._batch_cap("quality", "cuda", "low") == 16
    assert engine_pt._batch_cap("fast", "cuda", "low") == 4
    # CPU 先减半，再低显存减半
    assert engine_pt._batch_cap("quality", "cpu", "low") == 8
    assert engine_pt._batch_cap("quality", "cpu", "allow") == 16

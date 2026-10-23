# -*- coding: utf-8 -*-
"""转录选项回归：分块转录已移除 / 低显存批上限 / 降噪默认值。

★ 2026-10-21：「识别片段长度」（segment_sec）、静音分段（segment_silence*）、
  分段探测（probe_segments）三类分块转录整体移除 —— 实测块与块之间质量参差不齐。
  本文件的职责是**把移除固化成机器断言**：预设、引擎签名、CLI 都不许再出现这些键，
  防止以后有人"顺手加回来"。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import presets as P
import engine_pt

#: 已移除的分块转录键（预设 / 参数 / CLI 三层都不许复活）
DEAD_KEYS = (
    "segment_sec",
    "segment_silence",
    "silence_db",
    "min_silence",
    "max_segment",
    "segment_pad",
    "probe_segment_sec",
)


def test_builtin_presets_have_no_chunk_keys():
    """内置预设一律不含任何分块转录键。"""
    b = P._builtin_presets()
    for name, spec in b.items():
        params = spec.get("params") or {}
        for k in DEAD_KEYS:
            assert k not in params, "%s 仍含已移除的分块键 %s" % (name, k)
    # MuScriptor 的乐器组只允许 none / limit / 整曲 probe
    mi = b["MuScriptor · 最优"]["params"].get("muscriptor_instruments")
    assert mi in (None, "none", "probe"), mi


def test_builtin_presets_keep_expected_shape():
    """移除分块键不能顺手改掉别的默认值。"""
    b = P._builtin_presets()
    ms = b["MuScriptor · 最优"]["params"]
    assert ms["model_size"] == "medium"
    assert ms["prelude_forcing"] is True
    assert ms["precision"] == "fp32"
    assert ms["max_note_hold"] == 0
    assert b["钢琴 · 最优"]["params"]["model"] == "piano_pt"
    assert b["hFT-Transformer · 最优"]["params"]["model"] == "hft"
    for key in ("muscriptor_small", "muscriptor_medium", "muscriptor_large"):
        assert P.MODEL_DEFAULT_PRESET[key] == "MuScriptor · 最优"


def test_builtin_denoise_off_by_default():
    b = P._builtin_presets()
    for name in ("Basic Pitch · 最优", "MuScriptor · 最优", "钢琴 · 最优", "分离 · 最优"):
        assert b[name]["params"].get("denoise_mode") == "off"


def test_segment_modules_are_gone():
    """分块专用模块必须真的不在 engine 目录里（不是留着不 import）。"""
    eng = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for f in ("segment_options.py", "segmenter.py", "segment_probe.py"):
        assert not os.path.exists(os.path.join(eng, f)), "%s 应已删除" % f


def test_muscriptor_instruments_mode_rejects_segments():
    """'probe_segments'/'segments' 旧值按整曲探测兼容，绝不返回分段模式。"""
    import instrument_probe
    for raw in ("probe_segments", "segments", "PROBE_SEGMENTS"):
        assert instrument_probe.parse_mode(raw)[0] == "probe", raw
    assert instrument_probe.parse_mode("voice,drums")[0] == "limit"
    assert instrument_probe.parse_mode("none")[0] == "none"
    assert instrument_probe.parse_mode("")[0] == "none"


def test_piano_batch_cap_low_memory():
    assert engine_pt._batch_cap("quality", "cuda") == 32
    assert engine_pt._batch_cap("quality", "cuda", "low") == 16
    assert engine_pt._batch_cap("fast", "cuda", "low") == 4
    # CPU 先减半，再低显存减半
    assert engine_pt._batch_cap("quality", "cpu", "low") == 8
    assert engine_pt._batch_cap("quality", "cpu", "allow") == 16

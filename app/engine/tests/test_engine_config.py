# -*- coding: utf-8 -*-
"""engine / engine_perf 的配置结构与纯函数测试。

约束：不 import 任何重型 ML 库。engine.py 顶层只 import os；
engine_perf.py 顶层只 import os/sys。均不触发 torch / basic_pitch / demucs。
本文件只测：
  - engine.MODES / DEFAULT_MODE / DEFAULTS / merge_params
  - engine_perf.PERF_MODES / PERF_LABELS / resolve_threads 边界

不调用 apply_global / detect_recommended / make_basic_model（那些会触发重型导入）。
"""

import os

import engine
import engine_perf


# ---------- engine.MODES / DEFAULT_MODE ----------

def test_modes_keys():
    assert set(engine.MODES) == {"universal", "piano", "separate"}


def test_default_mode_valid():
    assert engine.DEFAULT_MODE == "universal"
    assert engine.DEFAULT_MODE in engine.MODES


# ---------- engine.DEFAULTS ----------

def test_defaults_keys_match_modes():
    assert set(engine.DEFAULTS) == set(engine.MODES)


def test_defaults_values_are_nonempty_dicts():
    for mode, params in engine.DEFAULTS.items():
        assert isinstance(params, dict)
        assert len(params) >= 1, f"{mode} 的默认参数为空"


def test_universal_defaults_have_expected_keys():
    d = engine.DEFAULTS["universal"]
    for key in ("onset_threshold", "frame_threshold", "minimum_note_length",
                "melodia_trick", "midi_tempo", "merge_overlap",
                "merge_gap_ms", "normalize_vel"):
        assert key in d, f"universal 默认缺 {key!r}"


def test_piano_defaults_have_expected_keys():
    d = engine.DEFAULTS["piano"]
    for key in ("onset_threshold", "min_note_ms", "merge_gap_ms", "include_pedal"):
        assert key in d, f"piano 默认缺 {key!r}"


def test_separate_defaults_have_expected_keys():
    d = engine.DEFAULTS["separate"]
    for key in ("onset_threshold", "frame_threshold", "include_drums",
                "midi_tempo"):
        assert key in d, f"separate 默认缺 {key!r}"


# ---------- engine.merge_params ----------

def test_merge_params_without_override_equals_defaults():
    assert engine.merge_params("universal", None) == engine.DEFAULTS["universal"]


def test_merge_params_partial_override():
    merged = engine.merge_params("universal", {"onset_threshold": 0.9})
    assert merged["onset_threshold"] == 0.9
    # 未覆盖的键保留默认值
    assert merged["frame_threshold"] == engine.DEFAULTS["universal"]["frame_threshold"]


def test_merge_params_unknown_mode():
    merged = engine.merge_params("不存在模式", {"a": 1})
    assert merged == {"a": 1}


# ---------- engine_perf.PERF_MODES / PERF_LABELS ----------

def test_perf_modes_definition():
    assert engine_perf.PERF_MODES == {"quality": 0, "balanced": 4, "fast": 2}


def test_perf_labels_keys_match_modes():
    assert set(engine_perf.PERF_LABELS) == set(engine_perf.PERF_MODES)


# ---------- engine_perf.resolve_threads 边界 ----------

def test_resolve_threads_fast_le_2():
    t = engine_perf.resolve_threads("fast")
    assert t is not None
    assert 1 <= t <= 2


def test_resolve_threads_balanced_le_4():
    t = engine_perf.resolve_threads("balanced")
    assert t is not None
    assert 1 <= t <= 4


def test_resolve_threads_quality_unlimited():
    assert engine_perf.resolve_threads("quality") is None


def test_resolve_threads_invalid_falls_back_to_quality():
    # 非法档位回退 quality → 不限线程（None），与 quality 行为一致
    assert engine_perf.resolve_threads("bogus") is None
    assert engine_perf.resolve_threads("超高性能") is None
    # None / 空串等同缺省 → quality
    assert engine_perf.resolve_threads(None) is None
    assert engine_perf.resolve_threads("") is None


def test_resolve_threads_respects_cpu_count(monkeypatch):
    # 人为放大核数：fast/balanced 命中各自档位上限
    monkeypatch.setattr(os, "cpu_count", lambda: 16)
    assert engine_perf.resolve_threads("fast") == 2
    assert engine_perf.resolve_threads("balanced") == 4
    assert engine_perf.resolve_threads("quality") is None


def test_resolve_threads_low_cpu_count(monkeypatch):
    # 只有 2 核时，balanced 也最多 2 核
    monkeypatch.setattr(os, "cpu_count", lambda: 2)
    assert engine_perf.resolve_threads("fast") == 2
    assert engine_perf.resolve_threads("balanced") == 2

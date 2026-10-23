# -*- coding: utf-8 -*-
"""P1-5 字级对齐（能量谷底 + 字数先验）回归测试。

用合成音频（等长正弦 burst + 静音间隔）做真值：每个 burst 的起点就是字边界，
因此可以量化"中位边界误差 <30ms"与"丢字检测"两件事，不需要人工标注数据集。
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import align_sofa as A  # noqa: E402


def bursts(n, dur=0.20, gap=0.10, sr=16000, f=220.0, missing_last=False):
    """n 个 burst，相邻 burst 之间 gap 静音；返回 (y, sr, 每个 burst 起点秒)。"""
    parts, onsets, t = [], [], 0.0
    for i in range(n):
        if missing_last and i == n - 1:
            break
        k = int(round(dur * sr))
        tt = np.arange(k, dtype=np.float32) / sr
        parts.append((0.25 * np.sin(2 * np.pi * f * tt)).astype(np.float32))
        onsets.append(t)
        t += dur
        if i != n - 1:
            parts.append(np.zeros(int(round(gap * sr)), dtype=np.float32))
            t += gap
    return np.concatenate(parts), sr, onsets


def test_clean_units_strips_punctuation_and_keeps_latin_words():
    assert A.clean_units("你好，世界！") == ["你", "好", "世", "界"]
    assert A.clean_units("I love 音乐 …") == ["I", "love", "音", "乐"]
    assert A.clean_units("   ") == []
    assert A.clean_units("abc123") == ["abc123"]


def test_align_five_chars_boundary_error_under_30ms():
    y, sr, onsets = bursts(5)
    r = A.align_signal(y, sr, "一二三四五")
    assert r["units"] == ["一", "二", "三", "四", "五"]
    assert len(r["chars"]) == 5
    # 字边界 = 第 2..5 个 burst 的起点
    err = A.boundary_error_ms(r["chars"][1:], onsets[1:])
    assert err is not None
    assert err < 30.0, "中位边界误差 %.1fms 应 <30ms" % err
    assert r["retention"] >= 0.95, r
    assert 150.0 <= r["medianMs"] <= 400.0


def test_missing_last_char_is_flagged():
    y, sr, onsets = bursts(6, missing_last=True)
    r = A.align_signal(y, sr, "一二三四五六")
    assert len(r["chars"]) == 6
    assert r["onsetCount"] == 5, "只有 5 个 burst → 5 个起音"
    assert r["onsetRatio"] < 0.95
    assert r["retention"] < 0.95, "丢字必须反映在 retention 上"
    assert r["keptRatio"] <= 1.0


def test_single_char_and_empty_audio_are_safe():
    y, sr, _ = bursts(1)
    r = A.align_signal(y, sr, "啊")
    assert len(r["chars"]) == 1
    assert r["chars"][0]["start"] >= 0
    assert r["chars"][0]["end"] > r["chars"][0]["start"]
    empty = A.align_signal(np.zeros(0, dtype=np.float32), sr, "啊")
    assert empty["chars"] == [] and empty["retention"] == 0.0


def test_silence_only_gives_low_retention():
    r = A.align_signal(np.zeros(8000, dtype=np.float32), 16000, "一二三")
    assert r["onsetCount"] == 0
    assert r["retention"] == 0.0


def test_boundary_error_helper_and_monotonic_chars():
    y, sr, _ = bursts(4)
    r = A.align_signal(y, sr, "啊依呜欸")
    starts = [c["start"] for c in r["chars"]]
    ends = [c["end"] for c in r["chars"]]
    assert starts == sorted(starts), "字起点必须严格递增"
    assert all(ends[i] > starts[i] for i in range(len(starts)))
    assert A.boundary_error_ms([], [0.1]) is None
    assert A.boundary_error_ms([{"start": 0.1}], []) is None

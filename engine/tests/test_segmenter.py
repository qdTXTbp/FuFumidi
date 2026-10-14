# -*- coding: utf-8 -*-
"""静音分段的纯函数测试（engine/segmenter.py）。

钉住的是**切点语义**，不是实现细节：只在完全静音上切、切在中点、首尾只留 pre-roll、
段太短合并、段太长在最安静处切。这些性质直接决定转录接缝处会不会丢音。
"""

import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import segmenter as S  # noqa: E402

SR = 8000


def tone(sec, amp=0.2, freq=440.0):
    t = np.arange(int(sec * SR)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype("float32")


def silence(sec):
    return np.zeros(int(sec * SR), dtype="float32")


def plan(x, **kw):
    return S.analyze(x, SR, **kw)


def test_no_silence_is_one_segment():
    p = plan(tone(30.0))
    assert len(p["segments"]) == 1
    assert p["segments"][0][0] == 0.0
    assert abs(p["segments"][0][1] - 30.0) < 0.05
    assert p["skipped_sec"] == 0.0


def test_middle_silence_splits_at_center():
    x = np.concatenate([tone(20.0), silence(10.0), tone(20.0)])
    p = plan(x)
    assert len(p["segments"]) == 2, p
    a, b = p["segments"]
    # 静音 20~30 s，中点 25 s：两段各留一半静音（保住混响尾/起音预备量）
    assert abs(a[1] - 25.0) < 0.1, a
    assert abs(b[0] - 25.0) < 0.1, b
    assert abs(p["skipped_sec"] - 10.0) < 0.2


def test_short_silence_is_not_a_cut():
    x = np.concatenate([tone(20.0), silence(1.0), tone(20.0)])   # 1 s < min_silence 2 s
    p = plan(x)
    assert len(p["segments"]) == 1, p["segments"]
    assert p["skipped_sec"] == 0.0


def test_leading_silence_keeps_only_pre_roll():
    x = np.concatenate([silence(19.0), tone(30.0)])
    p = plan(x, edge_keep=2.0)
    assert len(p["segments"]) == 1
    start = p["segments"][0][0]
    assert abs(start - 17.0) < 0.05, start          # 19 s 静音里只留最后 2 s
    assert abs(p["skipped_sec"] - 17.0) < 0.1


def test_trailing_silence_keeps_only_pre_roll():
    x = np.concatenate([tone(30.0), silence(12.0)])
    p = plan(x, edge_keep=2.0)
    end = p["segments"][-1][1]
    assert abs(end - 32.0) < 0.05, end              # 只留静音开头 2 s
    assert abs(p["skipped_sec"] - 10.0) < 0.1


def test_short_segment_merges_into_neighbour():
    # 两段音乐之间夹 8 s 静音，第二段只有 5 s → 短于 min_segment(20) 要并回前一段
    x = np.concatenate([tone(30.0), silence(8.0), tone(5.0)])
    p = plan(x, min_segment=20.0)
    assert len(p["segments"]) == 1, p["segments"]


def test_long_segment_splits_at_quietest_frame():
    # 60 s 音乐：前 25 s 满幅、中间 10 s 很轻（但不是静音）、后面 25 s 满幅
    x = np.concatenate([tone(25.0, 0.3), tone(10.0, 0.01), tone(25.0, 0.3)])
    p = plan(x, max_segment=40.0, min_segment=20.0)
    assert len(p["segments"]) == 2, p["segments"]
    cut = p["segments"][0][1]
    assert 25.0 <= cut <= 35.0, cut                 # 落在"很轻"的那 10 秒里
    assert abs(cut - 40.0) > 1.0, cut               # 不是按时间硬切在 40 s
    assert abs(cut - 30.0) < 3.0, cut               # 取该区间中点，不贴响段边缘


def test_all_silence_yields_no_segments():
    p = plan(silence(30.0))
    # 全是静音：没有可转录的核心 —— 但也不能崩，返回空段 + 全部跳过
    assert sum(b - a for a, b in p["segments"]) < 0.6, p
    assert abs(p["skipped_sec"] - 30.0) < 0.5, p


def test_auto_enabled_modes():
    assert S.auto_enabled(600.0, 120.0, "off")[0] is False
    assert S.auto_enabled(60.0, 20.0, "on")[0] is True
    assert S.auto_enabled(60.0, 20.0, "auto")[0] is False      # 太短，收益不足
    ok, why = S.auto_enabled(3600.0, 60.0, "auto")
    assert ok is False and "静音只占" in why                     # 静音占比太低
    ok, why = S.auto_enabled(3600.0, 600.0, "auto")
    assert ok is True and "分段可省" in why

# -*- coding: utf-8 -*-
"""分段探测纯逻辑测试。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from segment_probe import fixed_segments, build_constraints


def test_fixed_segments_basic():
    assert fixed_segments(130, 60) == [(0.0, 60.0), (60.0, 120.0), (120.0, 130.0)]


def test_fixed_segments_merges_tiny_tail():
    assert fixed_segments(125, 60, min_seg=8) == [(0.0, 60.0), (60.0, 125.0)]


def test_fixed_segments_clamps_and_empty():
    assert fixed_segments(0, 60) == []
    assert fixed_segments(-1, 60) == []
    # 段长被限制在 20..120（5 秒被夹到 20 秒）
    assert fixed_segments(50, 5)[0] == (0.0, 20.0)


def test_build_constraints_union_keeps_neighbor_and_global():
    per = [["acoustic_piano", "drums"], ["violin"], ["acoustic_piano", "cello"]]
    allowed, keep = build_constraints(per, max_groups=12, stable_min_hits=2)
    # 钢琴出现 2 段 -> 全局保留；鼓只出现 1 段但 always_keep -> 保留
    assert "acoustic_piano" in keep and "drums" in keep
    # 第 2 段（violin）也要允许相邻段的钢琴/大提琴，避免边界一闪一闪
    assert "violin" in allowed[1]
    assert "acoustic_piano" in allowed[1]
    assert "cello" in allowed[1]


def test_build_constraints_empty():
    assert build_constraints([]) == ([], [])
    assert build_constraints([[], []]) == ([[], []], [])


def test_build_constraints_caps_groups():
    per = [["g%d" % i for i in range(20)]]
    allowed, _ = build_constraints(per, max_groups=5)
    assert len(allowed[0]) == 5

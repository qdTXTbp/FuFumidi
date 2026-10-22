# -*- coding: utf-8 -*-
"""segment_options：所有模型的识别片段长度映射（纯函数测试）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import segment_options as so


def test_normalize_default_and_clamp():
    assert so.normalize_segment_sec(None) == 0.0
    assert so.normalize_segment_sec(0) == 0.0
    assert so.normalize_segment_sec(-3) == 0.0
    assert so.normalize_segment_sec("abc") == 0.0
    assert so.normalize_segment_sec(8) == 8.0
    assert so.normalize_segment_sec(0.1) == so.MIN_SEGMENT_SEC
    assert so.normalize_segment_sec(9999) == so.MAX_SEGMENT_SEC


def test_transkun_args():
    assert so.transkun_segment_args(0) == []
    args = so.transkun_segment_args(10)
    assert args[:2] == ["--segmentSize", "10.000"]
    assert args[2:4] == ["--segmentHopSize", "5.000"]


def test_piano_segment_samples():
    assert so.piano_segment_samples(0) is None
    assert so.piano_segment_samples(10) == 160000
    assert so.piano_segment_samples(2.5) == 40000


def test_muscriptor_segment_sec():
    assert so.muscriptor_segment_sec(0) == 5.0
    # MuScriptor 固定 5s：任何请求（包括 8s）都必须被忽略
    assert so.muscriptor_segment_sec(8) == 5.0
    assert so.muscriptor_segment_sec(30) == 5.0


def test_aria_len_ms():
    assert so.aria_len_ms(0) is None
    assert so.aria_len_ms(30) == 30000
    assert so.aria_len_ms(7.5) == 7500

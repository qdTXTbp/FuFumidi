# -*- coding: utf-8 -*-
"""segment_options：所有模型的识别片段长度映射（纯函数测试）。

★ 2026-10-23：这个能力已改成**默认不开启**（用户「改成不强制开启分段识别，
允许用户手动切换」）。所以本文件的第一组断言锁的是「0 / 不传 = 一律不动模型」，
那正是默认路径；只有显式给了秒数才映射。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import segment_options as so


def test_default_never_touches_the_model():
    """0 / None / 非法 → 各映射都返回"不改"（这是默认路径，必须零副作用）。"""
    assert so.normalize_segment_sec(None) == 0.0
    assert so.normalize_segment_sec(0) == 0.0
    assert so.normalize_segment_sec(-3) == 0.0
    assert so.normalize_segment_sec("abc") == 0.0
    assert so.transkun_segment_args(0) == []
    assert so.piano_segment_samples(0) is None
    assert so.aria_len_ms(0) is None
    # MuScriptor 未设置时返回模型默认 5.0（= 训练块长，不是"替用户决定"）
    assert so.muscriptor_segment_sec(0) == 5.0
    assert so.muscriptor_segment_sec(None) == 5.0


def test_normalize_clamp():
    assert so.normalize_segment_sec(8) == 8.0
    assert so.normalize_segment_sec(0.1) == so.MIN_SEGMENT_SEC
    assert so.normalize_segment_sec(9999) == so.MAX_SEGMENT_SEC


def test_transkun_args():
    args = so.transkun_segment_args(10)
    assert args[:2] == ["--segmentSize", "10.000"]
    assert args[2:4] == ["--segmentHopSize", "5.000"]


def test_piano_segment_samples():
    assert so.piano_segment_samples(10) == 160000
    assert so.piano_segment_samples(2.5) == 40000


def test_muscriptor_segment_sec():
    assert so.muscriptor_segment_sec(8) == 8.0


def test_aria_len_ms():
    assert so.aria_len_ms(30) == 30000
    assert so.aria_len_ms(7.5) == 7500

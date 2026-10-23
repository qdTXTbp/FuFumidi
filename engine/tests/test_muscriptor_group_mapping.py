# -*- coding: utf-8 -*-
"""探测器返回 program_* 时的近似映射：必须落到 MuScriptor 35 组之内，不能把非法组名传给硬约束。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine_muscriptor import _sanitize_groups


def test_program_token_maps_to_existing_group():
    assert _sanitize_groups(["program_105"]) == ["acoustic_guitar"]
    assert _sanitize_groups(["program_0"]) == ["acoustic_piano"]
    assert _sanitize_groups(["program_71"]) == ["clarinet"]


def test_program_token_is_deduped_with_existing_group():
    assert _sanitize_groups(["acoustic_guitar", "program_105"]) == ["acoustic_guitar"]


def test_unmapped_program_and_garbage_are_dropped():
    assert _sanitize_groups(["program_120", "not_a_group", "drums"]) == ["drums"]


def test_mapping_log_does_not_fail():
    lines = []
    assert _sanitize_groups(["program_105"], log_cb=lines.append) == ["acoustic_guitar"]
    assert any("acoustic_guitar" in x for x in lines)

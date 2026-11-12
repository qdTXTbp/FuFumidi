# -*- coding: utf-8 -*-
"""任务完成后释放内存/显存（2026-11-12 用户要求）

release_memory 的四步顺序不能反：丢模型引用 → gc → 清 CUDA 池 → 收缩 Windows 工作集。
这里用桩模块验证前两步与日志，CUDA / EmptyWorkingSet 在没有 GPU / 非 Windows 时
必须是**静默跳过**（绝不能抛）。
"""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import transcribe_runtime as TR  # noqa: E402


def test_proc_mem_mb_is_positive():
    mb = TR.proc_mem_mb()
    assert mb is None or mb > 1.0, "取不到就该返回 None，取到就是正数 MB"


def test_release_memory_clears_model_caches(monkeypatch):
    # 桩：basic-pitch 会话缓存
    fake_perf = types.ModuleType("engine_perf")
    fake_perf._basic_model_cache = {(4, False): object(), (8, False): object()}
    # 桩：钢琴引擎的模块级模型
    released = {"pt": 0}
    fake_pt = types.ModuleType("engine_pt")
    fake_pt._ENGINE = object()

    def _release():
        released["pt"] += 1
        fake_pt._ENGINE = None

    fake_pt._release_pt_engine = _release

    monkeypatch.setitem(sys.modules, "engine_perf", fake_perf)
    monkeypatch.setitem(sys.modules, "engine_pt", fake_pt)

    lines = []
    before, after, vram_b, vram_a = TR.release_memory(lambda m: lines.append(m), label="测试 ")

    assert fake_perf._basic_model_cache == {}, "basic-pitch 会话缓存必须被清空"
    assert released["pt"] == 1, "钢琴引擎的 _release_pt_engine 必须被调用一次"
    assert before is None or before > 0
    # 有内存读数时应该打一行可读日志
    if before is not None and after is not None:
        assert lines and lines[0].startswith("[内存] 测试 释放")
        assert "basic-pitch" in lines[0] and "钢琴" in lines[0]


def test_release_memory_never_raises_without_caches(monkeypatch):
    monkeypatch.delitem(sys.modules, "engine_perf", raising=False)
    monkeypatch.delitem(sys.modules, "engine_pt", raising=False)
    # 不传 log_cb、没有模型缓存：仍然不能抛
    res = TR.release_memory(None)
    assert isinstance(res, tuple) and len(res) == 4


def test_empty_working_set_is_safe():
    # 非 Windows 一律 False；Windows 上成功与否都只看返回值，不抛
    assert TR.empty_working_set() in (True, False)


def test_vram_helper_without_cuda():
    v = TR.proc_vram_mb()
    assert v is None or v >= 0

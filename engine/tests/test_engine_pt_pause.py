# -*- coding: utf-8 -*-
"""钢琴引擎（engine_pt）的分批前向 + 暂停闸门（用户 2026-10-14 要求）。

钢琴链路只有一次 engine.transcribe() 调用，暂停点在我们**自己写的**分批循环里
（engine_pt._chunked_forward，它替换了 pytorch_transcription_inference 的逐批循环）。这里钉住：
  1. 分批调用与「一次大批量」结果**逐元素相等**（自己写循环不许改变结果）；
  2. 闸门在**批次之间**被检查（不是只在开头一次）；
  3. 标记文件出现时循环真的卡住，删掉后从原处继续（已算的批**不重算**）；
  4. 慢机器上按实测耗时把后面的批减半；快机器保持性能档批量（不拖慢正常转录）；
  5. 暂停开启时**保证至少切两刀** —— 否则短曲子只有一批，中途根本停不下来。

不 import torch / piano_transcription_inference —— forward_fn 是假的。
"""
import os
import sys
import threading
import time

import numpy as np

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import engine_pt as EP  # noqa: E402
import pause_gate as PG  # noqa: E402


class _FakeForward:
    """镜像 pytorch_utils.forward：逐批 append，最后按 axis=0 拼接。"""

    def __init__(self):
        self.calls = []

    def __call__(self, model, x, batch_size):
        self.calls.append((len(x), batch_size))
        if not len(x):
            return {'out': np.zeros((0,), dtype=float)}
        parts = []
        pointer = 0
        while pointer < len(x):
            parts.append(np.asarray(x[pointer:pointer + batch_size], dtype=float) * 2.0)
            pointer += batch_size
        return {'out': np.concatenate(parts, axis=0)}


class _Gate:
    """假闸门：可指定 active，并数被问了几次。"""

    def __init__(self, active=True):
        self.active = active
        self.waits = 0

    def wait(self):
        self.waits += 1


class _FlagAfterFirstBatch:
    """第一批跑完就写暂停标记（= 用户正好在这一刻点了「暂停」）。"""

    def __init__(self, flag_path):
        self.flag = str(flag_path)
        self.batches = 0

    def __call__(self, model, x, batch_size):
        self.batches += 1
        if self.batches == 1:
            with open(self.flag, 'w', encoding='utf-8') as f:
                f.write('1')
        return {'out': np.asarray(x, dtype=float)}


def test_chunked_matches_single_batch():
    """分批（cap 各种取值）必须与一次大批量结果逐元素相等。"""
    x = list(range(37))
    off = _Gate(active=False)                      # 关掉暂停：走原来的 cap 分批
    single = EP._chunked_forward(_FakeForward(), None, x, len(x), gate=off)
    for cap in (1, 3, 8, 16, 32, 64):
        got = EP._chunked_forward(_FakeForward(), None, x, cap, gate=off)
        assert np.array_equal(single['out'], got['out']), 'cap=%r' % (cap,)


def test_empty_input_still_calls_forward_once():
    ff = _FakeForward()
    out = EP._chunked_forward(ff, None, [], 8, gate=_Gate(active=False))
    assert len(ff.calls) == 1
    assert len(out['out']) == 0


def test_gate_is_checked_between_batches():
    """开跑前 1 次 + 每批之前 1 次（10 段 / 每批 4 → 3 批）。"""
    x = list(range(10))
    gate = _Gate()
    EP._chunked_forward(_FakeForward(), None, x, 4, gate=gate)
    assert gate.waits == 4, gate.waits


def test_active_gate_splits_short_input_so_pause_is_possible():
    """片段数 ≤ 上限的文件也必须切两刀以上，否则中途停不下来。"""
    ff = _FakeForward()
    EP._chunked_forward(ff, None, list(range(5)), 32, gate=_Gate())
    assert [c[0] for c in ff.calls] == [2, 2, 1], ff.calls


def test_paused_run_starts_small_on_slow_machine():
    """慢机器（每批都超预算）→ 首批只有 4 段，之后继续减半：暂停响应是秒级，不是分钟级。"""
    ff = _FakeForward()
    ticks = {'n': 0}

    def clock():
        ticks['n'] += 1
        return ticks['n'] * 30.0       # 每批都超预算

    EP._chunked_forward(ff, None, list(range(40)), 32, gate=_Gate(), budget_s=6.0, clock=clock)
    assert [c[0] for c in ff.calls][:4] == [4, 2, 1, 1], ff.calls
    assert max(c[0] for c in ff.calls) <= 4, ff.calls


def test_paused_run_grows_back_to_cap_on_fast_machine():
    """快机器（每批远低于预算）→ 从 4 段翻倍回到性能档上限，速度不受暂停机制拖累。"""
    ff = _FakeForward()
    EP._chunked_forward(ff, None, list(range(200)), 32, gate=_Gate(), budget_s=6.0, clock=lambda: 0.0)
    assert [c[0] for c in ff.calls] == [4, 8, 16, 32, 32, 32, 32, 32, 12], ff.calls


def test_pause_between_batches_then_resume_without_recompute(tmp_path):
    flag = tmp_path / 'pause.flag'
    x = list(range(12))
    ff = _FlagAfterFirstBatch(flag)
    gate = PG.PauseGate(str(flag), None)
    result = {}
    done = threading.Event()

    def run():
        result['out'] = EP._chunked_forward(ff, None, x, 4, gate=gate)
        done.set()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    time.sleep(1.0)
    assert not done.is_set(), '标记文件在 → 循环必须停住'
    assert ff.batches == 1, '第一批已算完，后面的批不许开始：%r' % (ff.batches,)
    flag.unlink()                      # ← 「继续」
    assert done.wait(10.0), '删掉标记后应当接着跑完'
    assert ff.batches == 3, '12 段 / 每批 4 → 3 批，且不重跑第一批：%r' % (ff.batches,)
    assert list(result['out']['out']) == [float(v) for v in x]


def test_budget_shrinks_batch_on_slow_machine():
    """每批都超预算 → 后面的批减半（只缩不放），保证暂停响应是秒级。"""
    x = list(range(10))
    ff = _FakeForward()
    ticks = {'n': 0}

    def clock():
        ticks['n'] += 1
        return ticks['n'] * 10.0       # 每次读数差 10 秒 > budget 6 秒

    EP._chunked_forward(ff, None, x, 4, gate=_Gate(), budget_s=6.0, clock=clock)
    assert [c[0] for c in ff.calls] == [4, 2, 1, 1, 1, 1], ff.calls


def test_budget_does_not_shrink_fast_batches():
    """快机器（每批耗时远小于预算）→ 保持性能档的批量，不受暂停机制影响。"""
    x = list(range(10))
    ff = _FakeForward()
    EP._chunked_forward(ff, None, x, 4, gate=_Gate(), budget_s=6.0, clock=lambda: 0.0)
    assert [c[0] for c in ff.calls] == [4, 4, 2], ff.calls

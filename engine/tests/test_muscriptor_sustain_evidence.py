# -*- coding: utf-8 -*-
"""音频证据否决（僵尸音符的**证据式**收尾）—— 2026-10-14 用户要求：

「希望让模型自己不会推理出这种不合理的音符，而不是强行截断，
  因为如果音频真的有这么长的音符，这就会误伤。」

所以这里钉住三件事：
  1. **证据说"还在响" → 一个采样都不许切**（真实长音零误伤）；
  2. 证据说"最后有声时刻是 t" → 就收在 t（不是收在边界、更不是靠固定时长）；
  3. 证据函数缺失/抛异常/返回坏值 → **一律不动**（宁可不切也不误伤）。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from muscriptor.events import ChunkBoundary, OpenNoteTracker, set_sustain_evidence  # noqa: E402


class E:
    """极简词汇表：够了，用来驱动状态机。"""

    def __init__(self, type_, value=0):
        self.type = type_
        self.value = value


def vocab():
    # 上游 tracker 的语法：prologue 里 program+pitch 声明延音、tie 结束 prologue；
    # 块内 program/velocity/pitch 才真正开音（OpenNoteTracker.feed 的 pitch 分支）。
    return [E("shift", 0), E("program", 0), E("pitch", 60), E("tie"), E("velocity", 80)]


def open_note(tracker, t=0.0):
    """块内开音：velocity>0 + pitch → _open[(0,60)] = tick/frame_rate。"""
    tracker.feed(4)   # velocity 80
    tracker.feed(2)   # pitch 60 → 开音


def start_note(tracker, t, pitch_token=2):
    """在一个块的 prologue 之后起一个音（program 0 / pitch 60）。"""
    tracker.feed(1)      # program 0
    tracker.feed(2)      # pitch 60（prologue 里 = tie 声明）
    tracker.feed(3)      # tie → prologue 结束
    return tracker


def test_veto_keeps_genuinely_long_note():
    """证据说"仍在响" → 绝不切（真实超长音零误伤）。"""
    set_sustain_evidence(lambda pitch, upto: None)
    try:
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        start_note(tr, 0.0)
        open_note(tr)    # 开音 @ 0s
        acts = []
        for k in range(1, 40):          # 40 个块 ≈ 200 秒
            b = ChunkBoundary(k * 5.0, (k + 1) * 5.0)
            acts += tr.feed(b)
            tr.feed(1); tr.feed(2); tr.feed(3)   # 模型每块都声明"还在响"
        ends = [x for x in acts if type(x).__name__ == "_EndNote"]
        assert not ends, "证据说还在响，却被切了：%r" % ends
        assert tr.open_keys(), "音应该在还开着"
    finally:
        set_sustain_evidence(None)


def test_veto_ends_at_last_evidence_time():
    """证据给出"最后有声时刻" → 收在那一刻（不是边界、不是固定上限）。"""
    END = 12.5
    set_sustain_evidence(lambda pitch, upto: END if upto > 15.0 else None)
    try:
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        start_note(tr, 0.0)
        open_note(tr)
        acts = []
        for k in range(1, 5):           # 到 20 秒
            acts += tr.feed(ChunkBoundary(k * 5.0, (k + 1) * 5.0))
            tr.feed(1); tr.feed(2); tr.feed(3)
        ends = [x for x in acts if type(x).__name__ == "_EndNote"]
        assert len(ends) == 1, "应当只收尾一次：%r" % ends
        got = getattr(ends[0], "time", getattr(ends[0], "end_time", None))
        assert abs(got - END) < 1e-6, "应收在证据给的 %.1fs，实际 %r" % (END, got)
    finally:
        set_sustain_evidence(None)


def test_bad_evidence_never_cuts():
    """证据函数抛异常 / 返回坏值 → 一律不动。"""
    def boom(pitch, upto):
        raise RuntimeError("evidence blew up")

    set_sustain_evidence(boom)
    try:
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        start_note(tr, 0.0)
        open_note(tr)
        acts = []
        for k in range(1, 4):
            acts += tr.feed(ChunkBoundary(k * 5.0, (k + 1) * 5.0))
            tr.feed(1); tr.feed(2); tr.feed(3)
        assert not [x for x in acts if type(x).__name__ == "_EndNote"], "抛异常时不许切"
    finally:
        set_sustain_evidence(None)

    # 坏值：越界 / 非数字
    for bad in (999.0, -5.0, "abc"):
        set_sustain_evidence(lambda p, u, _b=bad: _b)
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        start_note(tr, 0.0)
        open_note(tr)
        acts = tr.feed(ChunkBoundary(5.0, 10.0))
        assert not [x for x in acts if type(x).__name__ == "_EndNote"], "坏证据 %r 不许切" % (bad,)
    set_sustain_evidence(None)


def test_no_evidence_keeps_upstream_behaviour():
    """没注入证据函数 = 上游行为（不动任何音）。"""
    set_sustain_evidence(None)
    tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
    tr.feed(ChunkBoundary(0.0, 5.0))
    start_note(tr, 0.0)
    open_note(tr)
    acts = []
    for k in range(1, 25):
        acts += tr.feed(ChunkBoundary(k * 5.0, (k + 1) * 5.0))
        tr.feed(1); tr.feed(2); tr.feed(3)
    assert not [x for x in acts if type(x).__name__ == "_EndNote"]
    assert tr.open_keys()

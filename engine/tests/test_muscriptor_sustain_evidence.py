# -*- coding: utf-8 -*-
"""音频证据式收尾（僵尸音符）—— 2026-10-14 用户要求：

「希望让模型自己不会推理出这种不合理的音符，而不是强行截断，
  因为如果音频真的有这么长的音符，这就会误伤。」

本文件钉住**五件事**（前三条来自第一版，后两条是定位到真因后补的）：
  1. 证据说"还在响"（None）→ 一个音都不许切（真实长音零误伤）；
  2. 证据说"最后有声时刻 t" → 就收在 t（不是收在块边界、更不是靠固定时长）；
  3. 证据缺失 / 抛异常 / 返回坏值 → 一律不动（宁可不切也不误伤）；
  4. **只会动"已经很长"的音**（_EVIDENCE_LONG_GUARD）：正常短音的收尾点是模型逐音给的，
     本来准确，不许被证据改写；
  5. 真因是"模型在块边界一次性吐掉几十个被迫延音的音"（实测 7:30 处 160 个音同时收尾、
     最长 37 秒），所以**块内 token 收尾也要过证据**：一个 20 秒的音在边界被模型关掉时，
     收尾点要落回证据给的那一刻（见 test_token_close_of_long_note_uses_evidence）。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from muscriptor.events import (  # noqa: E402
    ChunkBoundary,
    OpenNoteTracker,
    set_sustain_evidence,
    _EVIDENCE_LONG_GUARD,
    _EVIDENCE_MIN_GAIN,
)


class E:
    """极简词汇表：够了，用来驱动状态机。"""

    def __init__(self, type_, value=0):
        self.type = type_
        self.value = value


def vocab():
    # 上游 tracker 的语法：prologue 里 program+pitch 声明延音、tie 结束 prologue；
    # 块内 program/velocity/pitch 才真正开音（OpenNoteTracker.feed 的 pitch 分支）。
    return [
        E("shift", 0),        # 0
        E("program", 0),      # 1
        E("pitch", 60),       # 2
        E("tie"),             # 3
        E("velocity", 80),    # 4 起音
        E("velocity", 0),     # 5 note-off（块内收尾）
        E("shift", 400),      # 6 块内时间前进 4 s（400 tick @100 fps）
    ]


def declare_sustain(tracker):
    """模型在块首声明"这个音还在响"（prologue：program + pitch + tie）。

    ★ 必须带上 pitch：prologue 里没有声明的音符会被 tracker 按上游规则**关在块首**
      （`ended = [k for k in _open if k not in _tie_set]`）—— 第一版 helper 漏了它，
      于是每个块都把音关掉，四条用例全红。
    """
    tracker.feed(1)   # program 0
    tracker.feed(2)   # pitch 60 → 声明"这个音还在响"
    tracker.feed(3)   # tie → prologue 结束


def open_note(tracker):
    """块内开音（必须在 prologue 之后）：velocity>0 + pitch → _open[(0,60)]。"""
    tracker.feed(4)   # velocity 80
    tracker.feed(2)   # pitch 60 → 开音


def open_first_note(tracker):
    """第一个块：先声明延音（prologue）再在块内开音。"""
    declare_sustain(tracker)
    open_note(tracker)



def _ends(acts):
    return [x for x in acts if type(x).__name__ == "_EndNote"]


def _t(act):
    return float(getattr(act, "time", getattr(act, "end_time", 0.0)))


def test_veto_keeps_genuinely_long_note():
    """证据说"仍在响" → 绝不切（真实超长音零误伤）。"""
    set_sustain_evidence(lambda pitch, start, upto: None)
    try:
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        open_first_note(tr)
        acts = []
        for k in range(1, 40):          # 40 个块 ≈ 200 秒
            acts += tr.feed(ChunkBoundary(k * 5.0, (k + 1) * 5.0))
            declare_sustain(tr)
        assert not _ends(acts), "证据说还在响，却被切了：%r" % _ends(acts)
        assert tr.open_keys(), "音应该还开着"
    finally:
        set_sustain_evidence(None)


def test_veto_ends_at_last_evidence_time():
    """证据给出"最后有声时刻" → 收在那一刻（不是边界、不是固定上限）。"""
    END = 12.5
    set_sustain_evidence(lambda pitch, start, upto: END if upto > 15.0 else None)
    try:
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        open_first_note(tr)
        acts = []
        for k in range(1, 5):           # 到 20 秒
            acts += tr.feed(ChunkBoundary(k * 5.0, (k + 1) * 5.0))
            declare_sustain(tr)
        ends = _ends(acts)
        assert len(ends) == 1, "应当只收尾一次：%r" % ends
        assert abs(_t(ends[0]) - END) < 1e-6, "应收在证据给的 %.1fs，实际 %r" % (END, _t(ends[0]))
    finally:
        set_sustain_evidence(None)


def test_short_note_never_rewritten():
    """短音（< _EVIDENCE_LONG_GUARD）不许被证据改写 —— 它的收尾点是模型逐音给的。"""
    set_sustain_evidence(lambda pitch, start, upto: 0.1)
    try:
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        open_first_note(tr)
        # 边界落在 1.0 s：这个音才 1 秒，短于守门值 —— 证据再怎么说也不许动
        acts = tr.feed(ChunkBoundary(1.0, 6.0))
        assert not _ends(acts), "短音被证据改写了：%r" % _ends(acts)
        assert tr.open_keys()
    finally:
        set_sustain_evidence(None)


def test_token_close_of_long_note_uses_evidence():
    """★ 真因回归：模型在块边界一次性关掉一个 20 秒的音 → 收尾点要落回证据时刻。"""
    END = 2.5
    set_sustain_evidence(lambda pitch, start, upto: END)
    try:
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        open_first_note(tr)                     # 0 s 开音
        # 1 s 处过一个边界：这时音才 1 秒（短于守门值），证据否决不动它 ——
        # 于是下面那次块内收尾**只能**由 token 路径触发，正是要测的那条路。
        # 收尾点要落在本块窗口内（next_seek = 6.0 s，越窗的事件会被上游丢掉）。
        tr.feed(ChunkBoundary(1.0, 6.0))
        declare_sustain(tr)
        tr.feed(6)                              # shift +400 tick → 时间到 5.0 s
        acts = tr.feed(5) + tr.feed(2)          # velocity 0 + pitch → 块内收尾 @5 s
        ends = _ends(acts)
        assert ends, "模型收尾应当产生 _EndNote"
        assert abs(_t(ends[0]) - END) < 1e-6, (
            "长音在块内被模型关掉时应收在证据点 %.1fs，实际 %.3fs" % (END, _t(ends[0])))
    finally:
        set_sustain_evidence(None)


def test_bad_evidence_never_cuts():
    """证据函数抛异常 / 返回坏值 → 一律不动。"""
    def boom(pitch, start, upto):
        raise RuntimeError("evidence blew up")

    set_sustain_evidence(boom)
    try:
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        open_first_note(tr)
        acts = []
        for k in range(1, 8):
            acts += tr.feed(ChunkBoundary(k * 5.0, (k + 1) * 5.0))
            declare_sustain(tr)
        assert not _ends(acts), "抛异常时不许切"
    finally:
        set_sustain_evidence(None)

    for bad in (999.0, -5.0, "abc"):
        set_sustain_evidence(lambda p, s, u, _b=bad: _b)
        tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
        tr.feed(ChunkBoundary(0.0, 5.0))
        open_first_note(tr)
        acts = []
        for k in range(1, 8):
            acts += tr.feed(ChunkBoundary(k * 5.0, (k + 1) * 5.0))
            declare_sustain(tr)
        assert not _ends(acts), "坏证据 %r 不许切" % (bad,)
    set_sustain_evidence(None)


def test_no_evidence_keeps_upstream_behaviour():
    """没注入证据函数 = 上游行为（不动任何音）。"""
    set_sustain_evidence(None)
    tr = OpenNoteTracker(vocab(), frame_rate=100, max_note_hold=None)
    tr.feed(ChunkBoundary(0.0, 5.0))
    open_first_note(tr)
    acts = []
    for k in range(1, 25):
        acts += tr.feed(ChunkBoundary(k * 5.0, (k + 1) * 5.0))
        declare_sustain(tr)
    assert not _ends(acts)
    assert tr.open_keys()

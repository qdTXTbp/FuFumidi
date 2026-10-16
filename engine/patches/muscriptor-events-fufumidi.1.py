"""Public streaming events and per-chunk event builder.

`TranscriptionModel.transcribe` is a generator that yields these dataclasses
one at a time. Every :class:`NoteStartEvent` is guaranteed to be followed by
exactly one matching :class:`NoteEndEvent` (same `index`) later in the stream.
"""

import json as _json
import os as _os
import sys as _sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from muscriptor.tokenizer.notes import (
    MINIMUM_NOTE_DURATION_SEC,
    Event,
)


# ★ FuFumidi 诊断（2026-10-14）：把"谁关掉了音符"打出来。
# 为什么需要：长音频里会出现「一堆音在同一瞬间被收尾」，可能是三条规则中的任意一条
#   （块边界的 malformed 分支 / tie 段丢弃 / 证据式收尾），光看 MIDI 分不出来。
#   FUFUMIDI_TRACKER_TRACE=1 → 只打批量收尾；=2 → 连块内逐音收尾也打。
_TRACE = int(_os.environ.get("FUFUMIDI_TRACKER_TRACE") or "0")
# ★ 为什么落文件而不是打 stderr：引擎把子进程的 stdout/stderr 收进自己的日志协议，
#   只转发认识的 ### 前缀（实测 ###TRACKER 一行都没出来）。落文件最省事也最可靠。
_TRACE_FILE = _os.environ.get("FUFUMIDI_TRACKER_TRACE_FILE") or ""
_TRACE_FH = None


def _trace(kind, n, t, **extra):
    global _TRACE_FH
    if not (_TRACE and _TRACE_FILE) or not n:
        return
    if kind == "token_off" and _TRACE < 2:
        return
    try:
        if _TRACE_FH is None:
            _TRACE_FH = open(_TRACE_FILE, "a", encoding="utf-8")
        rec = {"k": kind, "n": int(n), "t": round(float(t), 3)}
        rec.update(extra)
        _TRACE_FH.write(_json.dumps(rec, ensure_ascii=False) + "\n")
        _TRACE_FH.flush()
    except Exception:
        pass

# ★ FuFumidi patch (0.3.0+fufumidi.1): 超长音符上限。
# 背景：块边界只关闭「不在 tie 段里」的音符，而 prelude_forcing 把 tie 段构造成
# 「当前还开着的音符」—— 于是块边界永远关不掉任何音符，一个音只能靠模型在块内显式
# 吐 note-off 才结束。模型在长音频里漏一次收尾，这个音就被强制延续下去，
# 实测 100 分钟录播出现 4320 秒（全曲 72%）的音符。
# 2026-10-14 更新：僵尸音符已改由**音频证据式收尾**（见 set_sustain_evidence）兜底，
# 所以这个时长上限**默认关闭（None = 不截断）** —— 按时长硬切会误伤音频里真实存在的长音；
# 界面上的调节开关也已移除，参数保留仅供显式指定硬保险时使用。
# 实测 cap=15s 对正常文件（时长上限 12.3s）零改动，对病态文件把最长音压回 15s。
DEFAULT_MAX_NOTE_HOLD_SEC: float | None = None


# ★ FuFumidi patch: 音频证据的**使用门槛**（2026-10-14 二次修订）。
#
# 为什么要有门槛：证据只能证明"这个音高此刻有没有能量"，它不该被用来改正常的短音
# （那些收尾点本来就是模型在块内逐音给的，准确）。实测病态输出长这样：
#   《原神》线上音乐会 2021：7:30 处**当时在响的 160 个音全部收在同一瞬间**，
#   12 个音长 37 秒；全曲 228 个 >15s 的音里 **227 个都落在这种"共享收尾瞬间"上**。
# 所以只在"这样收尾会让这个音 ≥ 2 秒"且"证据点比原收尾点早 ≥ 0.3 秒"时才改，
# 其余一律保持原样 —— 宁可不切，也不误伤。
_EVIDENCE_LONG_GUARD = 2.0     # 只对"会变成这么长"的收尾做证据修正（秒）
_EVIDENCE_MIN_GAIN = 0.3       # 证据点至少比原收尾点早这么多才值得改（秒）
_EVIDENCE_DROP = object()      # 证据的"删掉这颗音"哨兵（fn 返回负数时由 _evidence_end 转换）


# ★ FuFumidi patch: 音频证据钩子（2026-10-14）。
#
# 为什么不能靠时长上限：用户明确要求 —— 音频**真的有**长音时不许截断（那是误伤）。
# 而僵尸音的本质不是"太长"，是"音频早就没声了，模型却被强制继续"：
# 上游在块边界把 tracker.open_keys() 无条件塞进 tie 段（transcription_model.py:554），
# 于是模型每块都被迫声明"这些音还在响"，一颗漏收尾的音就永远关不掉。
#
# 修法：在块边界先用**音频**判断每个开着的音是否还有能量 —— 没能量就从 _open 里摘掉，
# 它自然不会被塞进强制 tie 段，模型也就不再被迫延续它（随后由既有的
# "不在 tie 集里就在边界收尾"逻辑正常关掉）。有能量的音一律不动。
#
# 由引擎层注入（engine_muscriptor.py 的 _make_pitch_evidence）。签名：
#     fn(pitch: int, start_time: float, upto_time: float) -> float
#       返回 None            = 没有证据 / 到该时刻为止仍有能量（不要动它）
#       返回一个时刻（秒）    = 该音高最后有能量的时刻（在这里收尾）
#       返回 drop 哨兵（由 set_sustain_evidence 的第二个参数注入）= ★ 这颗音在音频里
#                                 **根本不存在**（连它自己开头一秒都没有支撑）→
#                                 收在其起音处 = 零长度 → 引擎把它整颗删掉。
#       为什么用对象身份而不是数值（比如 -1）：坏证据必须一律无效 —— 负数同样是个
#       "合法但坏"的返回值，用数值当哨兵会让坏证据变成"删音符"。
#       为什么第四版要加这一档：星铁LIVE 26:20 的 D1 被拉成 24.65 秒，而它的
#       开头 1 秒里该音高只有 0.88 的突出度（≈ 没有这个音）。只砍尾巴会留下
#       "前 19 秒空白"的假长音 —— 更糟；音频否认的是整颗音。
#     ★ 第一版是 fn(pitch, upto)：判据是「边界前 0.5 秒整窗静音」，实测在连续有声段落里
#       一次都不触发（RMS 比阈值高 24~200 倍），等于没接线 —— 所以必须按音高、且要 start。
# 钩子缺省为 None = 保持上游行为。
_SUSTAIN_EVIDENCE = None
_SUSTAIN_DROP = None       # "删掉这颗音"哨兵（对象身份比较）


def set_sustain_evidence(fn, drop=None):
    """注入音频证据函数（None = 关闭该机制，回到上游行为）。

    ``drop`` 是可选的"删掉这颗音"哨兵对象：证据函数返回**同一个对象**时，
    这一对事件以零长度收尾，引擎据此把整颗音丢掉（见 _evidence_end）。
    """
    global _SUSTAIN_EVIDENCE, _SUSTAIN_DROP
    _SUSTAIN_EVIDENCE = fn
    _SUSTAIN_DROP = drop


_DRUM_INSTRUMENT = "drums"


@dataclass
class NoteStartEvent:
    pitch: int
    start_time: float
    index: int
    instrument: str


@dataclass
class NoteEndEvent:
    end_time: float
    start_event: NoteStartEvent

    @property
    def start_event_index(self) -> int:
        return self.start_event.index


@dataclass
class ProgressEvent:
    """A coarse transcription-progress signal, woven into the event stream.

    Marks that ``completed`` of ``total`` fixed-size audio chunks have been
    transcribed (``completed == 0`` is emitted once up front so consumers learn
    ``total`` and get a timing baseline; ``completed == total`` marks the end).
    These are deliberately coarse anchors — the frontend smooths between them
    and derives an ETA, since wall-clock time per chunk is only observable
    there. Advisory only: consumers that build notes/MIDI ignore them.
    """

    completed: int
    total: int


@dataclass
class ChunkBoundary:
    """Marks the start of a new model-output chunk in the token stream.

    ``seek_time`` is the chunk's start time in seconds; ``next_seek_time`` is
    the following chunk's start (``None`` for the last chunk), used to drop
    events the model emits past its window.
    """

    seek_time: float
    next_seek_time: float | None


@dataclass
class _StartNote:
    """A note opens: (program, pitch) starts sounding at `time`."""

    program: int
    pitch: int
    time: float


@dataclass
class _EndNote:
    """An open note closes: (program, pitch) stops sounding at `time`."""

    program: int
    pitch: int
    time: float


@dataclass
class _DrumHit:
    """An instantaneous drum hit at `time`; never enters the open set."""

    pitch: int
    time: float


_NoteAction = _StartNote | _EndNote | _DrumHit


class OpenNoteTracker:
    """The chunk-decoding state machine for the model's token stream.

    :meth:`feed` consumes the interleaved :class:`ChunkBoundary` markers and
    token indices and returns the note actions they imply; :meth:`finish`
    flushes the end-of-stream closes. All decode rules live here — the tie
    prologue (open notes absent from the tie set close at the boundary),
    malformed chunks (a shift before the ``tie`` token closes everything and
    drops the rest), the next_seek_time window, and retriggers.

    Two consumers share it: :func:`decode_model_tokens` turns the actions into
    indexed NoteStart/NoteEnd events, and the prelude-forcing path
    (``TranscriptionModel._generate_token_stream``) ignores the actions and
    reads :meth:`open_keys` at chunk boundaries — the ``(program, pitch)``
    pairs the next chunk's tie prologue must declare as sustained (see
    ``MT3Tokenizer.tie_section_token_ids``). One state machine serving both
    keeps decoding and forcing consistent by construction.
    """

    def __init__(self, vocab: list[Event], frame_rate: int = 100,
                 max_note_hold: float | None = DEFAULT_MAX_NOTE_HOLD_SEC):
        self._vocab = vocab
        self._frame_rate = frame_rate
        self._max_note_hold = max_note_hold
        # (program, pitch) -> onset time. Insertion-ordered: end-of-stream
        # closes replay in onset order.
        self._open: dict[tuple[int, int], float] = {}
        # Per-chunk state, reset at every ChunkBoundary.
        self._seek_time = 0.0
        self._next_seek_time: float | None = None
        self._start_tick = 0
        self._tick_state = 0
        self._program: int | None = None
        self._velocity: int | None = None
        self._in_prologue = True
        self._skip_rest = False
        self._tie_set: set[tuple[int, int]] = set()
        self._chunk_started = False

    def feed(self, item: "int | ChunkBoundary") -> list[_NoteAction]:
        if isinstance(item, ChunkBoundary):
            actions: list[_NoteAction] = []
            # If the previous chunk never closed its tie prologue (malformed:
            # no `tie` token before it ended), treat its tie set as empty so
            # every still-open note ends at that chunk's boundary.
            if self._chunk_started and self._in_prologue:
                actions = self._end_all(self._seek_time)
                _trace("boundary_end_all", len(actions), self._seek_time, seek=item.seek_time)
            # ★ FuFumidi patch: 音频证据否决 —— 必须在调用方用 open_keys() 构造强制 tie 段
            #   之前完成，所以就在同一个 feed(Boundary) 调用里做掉。
            _vetoed = self._veto_unsustained(item.seek_time)
            _trace("veto", len(_vetoed), item.seek_time)
            actions = actions + _vetoed
            self._seek_time = item.seek_time
            self._next_seek_time = item.next_seek_time
            self._start_tick = round(item.seek_time * self._frame_rate)
            self._tick_state = self._start_tick
            self._program = None
            self._velocity = None
            self._in_prologue = True
            self._skip_rest = False
            self._tie_set = set()
            self._chunk_started = True
            return actions

        event = self._vocab[item]
        etype = event.type

        if self._in_prologue:
            if etype == "tie":
                # End of the tie section: close prior notes not sustained here.
                self._in_prologue = False
                self._velocity = None
                ended = [k for k in self._open if k not in self._tie_set]
                # ★ FuFumidi patch: 被 tie 段声明「仍然响着」的音，若已经超过
                #   max_note_hold，也一并关掉（正好关在 onset + 上限处）。
                #   没有这一条就会出现「模型漏一次收尾 → 强制延续 → 越滚越长」。
                #   ★ 要杀的正是「被 tie 段声明为延音」的音 —— 它们才是不收尾的僵尸；
                #     不在 tie 集里的已由上面的 ended 关掉，别重复关。
                expired: list[tuple[int, int]] = []
                if self._max_note_hold is not None:
                    expired = [
                        k for k in self._open
                        if k in self._tie_set
                        and (self._seek_time - self._open[k]) > self._max_note_hold
                    ]
                _trace("tie_drop", len(ended), self._seek_time, tied=len(self._tie_set))
                actions = [_EndNote(*key, self._close_at(key, self._seek_time)) for key in ended]
                for key in expired:
                    actions.append(_EndNote(*key, self._open[key] + self._max_note_hold))
                for key in ended:
                    del self._open[key]
                for key in expired:
                    del self._open[key]
                return actions
            if etype == "shift":
                # No tie token: the chunk is malformed. Close all open notes at
                # the boundary and drop the rest of the chunk.
                self._in_prologue = False
                self._skip_rest = True
                return self._end_all(self._seek_time)
            if etype == "program":
                self._program = event.value
            elif etype == "pitch" and self._program is not None:
                self._tie_set.add((self._program, event.value))
            return []

        if self._skip_rest:
            return []

        if etype == "shift":
            if event.value > 0:
                self._tick_state = self._start_tick + event.value
        elif etype == "program":
            self._program = event.value
        elif etype == "velocity":
            self._velocity = event.value
        elif etype == "drum":
            time = self._tick_state / self._frame_rate
            if self._next_seek_time is None or time < self._next_seek_time:
                return [_DrumHit(event.value, time)]
        elif etype == "pitch":
            if self._program is None or self._velocity is None:
                return []
            time = self._tick_state / self._frame_rate
            if self._next_seek_time is not None and time >= self._next_seek_time:
                return []
            key = (self._program, event.value)
            actions = []
            if key in self._open:
                # ★ 模型在**块边界**一次性吐掉几十个音时（实测 100 个），收尾时刻只能落在
                #   边界，而它们真正停下的位置在更早的块里 —— 交给音频证据修。
                _end = self._close_at(key, time)
                del self._open[key]
                _trace("token_off", 1, time, pitch=event.value, retrigger=int(self._velocity > 0),
                       ev=None if _end == time else round(_end, 3))
                actions.append(_EndNote(*key, _end))
            if self._velocity > 0:
                self._open[key] = time
                actions.append(_StartNote(*key, time))
            return actions
        return []

    def finish(self) -> list[_NoteAction]:
        """End of stream: close anything still open.

        A well-formed final chunk uses the minimum-duration fallback; a chunk
        that ended mid-prologue closes at its boundary (matching the
        malformed-chunk rule in :meth:`feed`).
        """
        if self._chunk_started and self._in_prologue:
            _acts = self._end_all(self._seek_time)
            _trace("finish", len(_acts), self._seek_time)
            return _acts
        actions = [
            _EndNote(*key, onset + MINIMUM_NOTE_DURATION_SEC)
            for key, onset in self._open.items()
        ]
        self._open.clear()
        return actions

    def _evidence_end(self, key, start: float, upto: float):
        """问音频证据：这个音高最后在哪一刻还有能量（None = 没证据 / 还在响）。"""
        fn = _SUSTAIN_EVIDENCE
        if fn is None:
            return None
        try:
            t = fn(key[1], start, upto)
        except Exception:
            return None
        if t is None:
            return None
        if _SUSTAIN_DROP is not None and t is _SUSTAIN_DROP:
            return _EVIDENCE_DROP          # ★ 证据要求删掉这颗音（零长度收尾）
        try:
            t = float(t)
        except (TypeError, ValueError):
            return None
        if not (start <= t <= upto):
            return None
        return t

    def _close_at(self, key, time: float) -> float:
        """收尾时刻：默认 time；只有"这个音会变得很长"且证据明显更早时才改用证据点。"""
        start = self._open.get(key)
        if start is None or (time - start) < _EVIDENCE_LONG_GUARD:
            return time
        ev = self._evidence_end(key, start, time)
        if ev is _EVIDENCE_DROP:
            return start                   # ★ 零长度 = 引擎按"删掉这颗音"处理
        if ev is None or (time - ev) < _EVIDENCE_MIN_GAIN:
            return time
        return ev

    def _veto_unsustained(self, boundary_time: float) -> list[_NoteAction]:
        """把「音频其实已经没在响」的延音收尾（★ FuFumidi patch）。

        只在**边界**咨询证据函数，且**只在证据明确说"最后有声时刻"时**才动手：
        证据函数返回 None（仍在响）或抛异常时一律不动 —— 宁可不切，也不误伤。
        """
        fn = _SUSTAIN_EVIDENCE
        if fn is None or not self._open:
            return []
        out: list[_NoteAction] = []
        for key in list(self._open):
            start = self._open[key]
            ev = self._evidence_end(key, start, boundary_time)
            if ev is None:
                continue
            # 已经很长、但证据说它早就停了 → 就收在这里（也顺带把它从 open 里摘掉，
            # 于是下一块的强制 tie 段不会再逼模型"声明它还在响"）。
            if (boundary_time - start) < _EVIDENCE_LONG_GUARD:
                continue
            if ev is _EVIDENCE_DROP:
                # ★ 音频否认整颗音（连开头都没有支撑）→ 零长度收尾 = 删除。
                #   门槛（≥2 秒）在上面已经过了，不需要 MIN_GAIN。
                out.append(_EndNote(*key, start))
                del self._open[key]
                continue
            if (boundary_time - ev) < _EVIDENCE_MIN_GAIN:
                continue
            out.append(_EndNote(*key, ev))
            del self._open[key]
        return out

    def _end_all(self, time: float) -> list[_NoteAction]:
        # ★ 批量收尾正是"37 秒僵尸音"的产地（块边界的 malformed 分支会一次关掉一整批），
        #   所以这里逐个问证据，而不是统一盖成 time。
        actions: list[_NoteAction] = [
            _EndNote(*key, self._close_at(key, time)) for key in self._open
        ]
        self._open.clear()
        return actions

    def open_keys(self) -> list[tuple[int, int]]:
        """Sorted ``(program, pitch)`` pairs currently held open."""
        return sorted(self._open)


def decode_model_tokens(
    stream: Iterator[int | ChunkBoundary | ProgressEvent],
    vocab: list[Event],
    instrument_for_program: Callable[[int], str],
    frame_rate: int = 100,
) -> Iterator[NoteStartEvent | NoteEndEvent | ProgressEvent]:
    """Stream model token indices straight into NoteStart/NoteEnd events.

    ``stream`` interleaves :class:`ChunkBoundary` markers with token indices:
    each boundary starts a new chunk, followed by that chunk's tokens (EOS and
    anything after it already stripped). Tokens are consumed strictly in
    order: no buffering, no end-of-chunk sort. Each chunk begins with a *tie
    prologue* — ``(program, pitch)`` pairs for notes sustained from the
    previous chunk, terminated by a ``tie`` token — after which any prior open
    note not in that tie set is closed at the chunk boundary. The rest of the
    chunk drives note onsets/offsets directly.

    The decode rules themselves live in :class:`OpenNoteTracker`; this
    generator only turns its actions into events — minting indices, naming
    instruments, and pairing every NoteEndEvent with its NoteStartEvent.
    """
    tracker = OpenNoteTracker(vocab, frame_rate)
    open_notes: dict[tuple[int, int], NoteStartEvent] = {}
    next_index = 0

    def mint(pitch: int, start_time: float, instrument: str) -> NoteStartEvent:
        nonlocal next_index
        ev = NoteStartEvent(
            pitch=pitch, start_time=start_time, index=next_index, instrument=instrument
        )
        next_index += 1
        return ev

    def events_for(
        actions: list[_NoteAction],
    ) -> Iterator[NoteStartEvent | NoteEndEvent]:
        for action in actions:
            if isinstance(action, _EndNote):
                start = open_notes.pop((action.program, action.pitch))
                yield NoteEndEvent(end_time=action.time, start_event=start)
            elif isinstance(action, _StartNote):
                start = mint(
                    action.pitch, action.time, instrument_for_program(action.program)
                )
                open_notes[(action.program, action.pitch)] = start
                yield start
            else:  # _DrumHit: an instantaneous start/end pair
                start = mint(action.pitch, action.time, _DRUM_INSTRUMENT)
                yield start
                yield NoteEndEvent(
                    end_time=action.time + MINIMUM_NOTE_DURATION_SEC, start_event=start
                )

    for item in stream:
        if isinstance(item, ProgressEvent):
            # Advisory progress signal — pass straight through, untouched by
            # the decode state machine.
            yield item
            continue
        yield from events_for(tracker.feed(item))
    yield from events_for(tracker.finish())

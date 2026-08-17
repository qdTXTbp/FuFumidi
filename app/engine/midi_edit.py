# -*- coding: utf-8 -*-
"""
MIDI 微调编辑（批处理式，不破坏原始文件）
==========================================
常用编辑项参考 markusschwenk/midieditor 与 herbit2004/KEYS-MIDI：
- 撤销 / 重做（最深 10 步）
- 量化（1/4 · 1/8 · 1/16 音符网格）
- 移调（±半音，自动夹在 0~127）
- 力度缩放 / 去弱音
- 时长缩放 / 去短音
- 人声化（时序与力度微抖动）
- 删除音轨 / 保存 / 另存为 / 重新载入

所有操作都是「批处理」式的（作用于整条音轨的全部音符），
不提供逐个音符拖拽，因此不会破坏转录得到的可用结果。
"""

import io
import math
import random

import pretty_midi


class UndoManager:
    """基于 MIDI 文件快照的撤销/重做栈（最深 depth 步）。"""

    def __init__(self, depth=10):
        self.depth = max(1, int(depth))
        self._undo = []   # 历史快照（bytes）
        self._redo = []   # 被撤销的快照

    def snapshot(self, midi):
        buf = io.BytesIO()
        midi.write(buf)
        return buf.getvalue()

    def restore(self, data):
        return pretty_midi.PrettyMIDI(io.BytesIO(data))

    def push(self, midi):
        """编辑前把当前状态压栈（记录一次可撤销）。"""
        self._undo.append(self.snapshot(midi))
        if len(self._undo) > self.depth:
            self._undo.pop(0)
        self._redo.clear()

    def can_undo(self):
        return bool(self._undo)

    def can_redo(self):
        return bool(self._redo)

    def undo(self, midi):
        if not self._undo:
            return midi
        snap = self._undo.pop()
        self._redo.append(self.snapshot(midi))
        return self.restore(snap)

    def redo(self, midi):
        if not self._redo:
            return midi
        snap = self._redo.pop()
        self._undo.append(self.snapshot(midi))
        return self.restore(snap)


def total_notes(midi):
    """全部音符总数（统计用）。"""
    return sum(len(inst.notes) for inst in midi.instruments)


def describe(midi):
    """返回每条音轨信息列表：[(索引, 名称, 音色号, 是否打击乐, 音符数)]。"""
    rows = []
    for i, inst in enumerate(midi.instruments):
        name = inst.name or f"音轨 {i + 1}"
        rows.append((i, name, inst.program, bool(inst.is_drum), len(inst.notes)))
    return rows


def _grid_step(midi, grid):
    """把网格名换算成 tick 数（默认 1/4）。"""
    tp = max(1, int(midi.resolution))          # 每四分音符的 tick 数
    return {"1/4": float(tp), "1/8": float(tp) / 2.0,
            "1/16": float(tp) / 4.0}.get(str(grid), float(tp))


def quantize(midi, grid="1/8"):
    """把音符起止时间吸附到最近网格（1/4 · 1/8 · 1/16 音符）。"""
    step = _grid_step(midi, grid)
    for inst in midi.instruments:
        for note in inst.notes:
            s = int(round(midi.time_to_tick(note.start) / step) * step)
            e = int(max(round(midi.time_to_tick(note.end) / step) * step,
                        midi.time_to_tick(note.start) + 1))
            if e <= s:  # 保证起止不重叠
                e = s + int(step)
            note.start = midi.tick_to_time(s)
            note.end = midi.tick_to_time(e)
    return f"量化到 {grid} 音符"


def transpose(midi, semitones):
    """整轨移调（±半音，夹在 0~127）。"""
    st = int(semitones)
    moved = 0
    for inst in midi.instruments:
        for note in inst.notes:
            new_p = max(0, min(127, note.pitch + st))
            if new_p != note.pitch:
                note.pitch = new_p
                moved += 1
    sign = "+" if st >= 0 else ""
    return f"移调 {sign}{st} 半音（{moved} 个音符受影响）"


def velocity_scale(midi, percent=100):
    """力度整体缩放（percent%），夹在 1~127。"""
    p = float(percent) / 100.0
    for inst in midi.instruments:
        for note in inst.notes:
            note.velocity = int(max(1, min(127, round(note.velocity * p))))
    return f"力度缩放 ×{percent}%"


def delete_weak(midi, threshold=40):
    """删除力度低于 threshold 的弱音符。"""
    th = int(threshold)
    removed = 0
    for inst in midi.instruments:
        keep = []
        for n in inst.notes:
            if n.velocity >= th:
                keep.append(n)
            else:
                removed += 1
        inst.notes = keep
    return f"删除 {removed} 个弱音符（力度 < {th}）"


def delete_short(midi, min_ms=80):
    """删除时长短于 min_ms 的琐碎音符。"""
    min_dur = float(min_ms) / 1000.0
    removed = 0
    for inst in midi.instruments:
        keep = []
        for n in inst.notes:
            if (n.end - n.start) >= min_dur:
                keep.append(n)
            else:
                removed += 1
        inst.notes = keep
    return f"删除 {removed} 个过短音符（< {min_ms}ms）"


def duration_scale(midi, percent=100):
    """音符时长整体缩放（percent%），保持起点不变。"""
    p = float(percent) / 100.0
    for inst in midi.instruments:
        for note in inst.notes:
            note.end = note.start + max(0.01, (note.end - note.start) * p)
    return f"时长缩放 ×{percent}%"


def humanize(midi, amount=10):
    """人声化：时序抖动 ±amount ms，力度抖动 ±amount/2（轻量，可撤销）。"""
    jitter_ms = float(amount) / 1000.0
    vj = float(amount) / 2.0
    for inst in midi.instruments:
        for note in inst.notes:
            j = random.uniform(-jitter_ms, jitter_ms)
            note.start = max(0.0, note.start + j)
            note.end = max(note.start + 0.01, note.end + j)
            note.velocity = int(max(1, min(127,
                round(note.velocity + random.uniform(-vj, vj)))))
    return "人声化（时序/力度微抖动）"


def delete_track(midi, index):
    """删除指定索引的音轨。"""
    idx = int(index)
    if 0 <= idx < len(midi.instruments):
        name = midi.instruments[idx].name or f"音轨 {idx + 1}"
        del midi.instruments[idx]
        return f"已删除音轨「{name}」"
    return "未删除（音轨索引无效）"


def clean_dirty(midi, min_ms=50, min_vel=20, merge_gap=30):
    """一键清理脏数据：同音高重叠/近邻合并、删除过短音符、删除极弱音。

    - 合并：同音高的重叠 / 间隔 < merge_gap ms 的碎片合并为延音（取最强力度）
    - 删除：时长短于 min_ms 的琐碎音符、力度低于 min_vel 的极弱音符
    """
    merge_gap_s = float(merge_gap) / 1000.0
    min_dur = float(min_ms) / 1000.0
    merged = 0
    removed = 0
    for inst in midi.instruments:
        notes = sorted(inst.notes, key=lambda n: (n.pitch, n.start, n.end))
        cleaned = []
        for n in notes:
            if cleaned:
                last = cleaned[-1]
                if last.pitch == n.pitch and (n.start - last.end) <= merge_gap_s:
                    last.end = max(last.end, n.end)
                    if n.velocity > last.velocity:
                        last.velocity = n.velocity
                    merged += 1
                    continue
            cleaned.append(n)
        keep = []
        for n in cleaned:
            if (n.end - n.start) >= min_dur and n.velocity >= min_vel:
                keep.append(n)
            else:
                removed += 1
        inst.notes = keep
    return f"一键清理：合并 {merged} 处重叠/近邻音符，删除 {removed} 个短音/弱音"


def _overlaps_any(notes, ref):
    """音符 ref 的时间区间是否被其它音符重叠（同轨）。"""
    for n in notes:
        if n is ref:
            continue
        if n.start < ref.end and n.end > ref.start:
            return True
    return False


def add_vibrato(midi, min_ms=900, depth=400, rate=5.5):
    """给持续音符添加颤音（弯音控制器实现，模拟人声/弦乐颤音）。

    - 仅给时长 ≥ min_ms、且区间内无其它音符重叠的「单音」音符添加，
      避免影响和弦（弯音是全局的，叠音区间添加会串音）。
    - depth 为弯音量（默认 400 ≈ 0.1 半音），rate 为颤音频率 Hz。
    """
    min_dur = float(min_ms) / 1000.0
    added = 0
    for inst in midi.instruments:
        if inst.is_drum:
            continue
        notes = sorted(inst.notes, key=lambda n: n.start)
        for note in notes:
            dur = note.end - note.start
            if dur < min_dur:
                continue
            if _overlaps_any(notes, note):
                continue
            n_pb = max(2, int(rate * dur))
            for i in range(n_pb + 1):
                t = note.start + dur * i / n_pb
                bend = _clamp_bend(int(depth * math.sin(2 * math.pi * rate * (t - note.start))))
                inst.pitch_bends.append(pretty_midi.PitchBend(bend, t))
            added += 1
    return f"为 {added} 个持续音符添加颤音（弯音）"


def add_slides(midi, slide_ms=120, bend_per_semi=4096):
    """给相邻同轨音符的衔接添加滑音（弯音从前一音高滑向目标音高）。

    - 仅当两音符音高不同、且几乎首尾相接（间隔 < slide_ms/2）时触发；
    - 两音符各自区间内无其它音符重叠时才会添加，避免影响和弦。
    """
    slide_s = float(slide_ms) / 1000.0
    added = 0
    for inst in midi.instruments:
        if inst.is_drum:
            continue
        notes = sorted(inst.notes, key=lambda n: (n.start, n.pitch))
        for i in range(len(notes) - 1):
            a, b = notes[i], notes[i + 1]
            if a.pitch == b.pitch:
                continue
            gap = b.start - a.end
            if gap < 0 or gap > slide_s * 0.5:
                continue
            if _overlaps_any(notes, a) or _overlaps_any(notes, b):
                continue
            d = min(slide_s, a.end - a.start)
            start_bend = (b.pitch - a.pitch) * bend_per_semi
            n_steps = max(2, int(d * 100))
            for k in range(n_steps + 1):
                t = a.end - d + d * k / n_steps
                bend = _clamp_bend(int(start_bend * k / n_steps))
                inst.pitch_bends.append(pretty_midi.PitchBend(bend, t))
            inst.pitch_bends.append(pretty_midi.PitchBend(0, b.start))
            added += 1
    return f"为 {added} 处音符衔接添加滑音（弯音）"


def _clamp_bend(v):
    """弯音值夹在 MIDI 规范范围 -8192..8191。"""
    return max(-8192, min(8191, int(v)))

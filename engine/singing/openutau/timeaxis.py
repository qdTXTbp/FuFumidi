# -*- coding: utf-8 -*-
"""`TimeAxis` —— 照搬 `OpenUtau.Core/Util/TimeAxis.cs`（314 行）。

tick ↔ 毫秒 的换算轴：把工程的 timeSignatures / tempos 预编译成段表，
之后所有换算都是段内线性插值。音素化器与渲染器都依赖它。

照搬时保留了几处**看似多余但有意为之**的防御（这在 C# 源码里都写了注释）：
  - `IsValidBpm`：bpm 为 0/NaN/Inf 时 msPerTick 会变成 Inf/NaN，
    并污染其后**所有**段的 msPos；所以第 0 段必须回落到默认 120。
  - 段查找**从不抛异常**（NaN、超界一律夹到末段）：这些查询跑在渲染线程上，
    抛异常会把整个应用带崩。
  - `MsPosToTickPos` 对 NaN/Inf 的 tickPos 回落到段起点，而不是静默饱和成 int 极值。
这些边界不是"过度设计"，是 OpenUTAU 实际踩过的坑，照搬时不要"简化"掉。
"""

import math


class _TimeSigSegment:
    __slots__ = ('bar_pos', 'bar_end', 'tick_pos', 'tick_end',
                 'beat_per_bar', 'beat_unit', 'ticks_per_bar', 'ticks_per_beat')

    def __init__(self, bar_pos=0, tick_pos=0, beat_per_bar=4, beat_unit=4,
                 ticks_per_bar=0, ticks_per_beat=0):
        self.bar_pos = bar_pos
        self.bar_end = 2 ** 31 - 1          # int.MaxValue
        self.tick_pos = tick_pos
        self.tick_end = 2 ** 31 - 1
        self.beat_per_bar = beat_per_bar
        self.beat_unit = beat_unit
        self.ticks_per_bar = ticks_per_bar
        self.ticks_per_beat = ticks_per_beat


class _TempoSegment:
    __slots__ = ('tick_pos', 'tick_end', 'bpm', 'beat_per_bar', 'beat_unit',
                 'ms_pos', 'ms_end', 'ms_per_tick', 'ticks_per_ms')

    def __init__(self, tick_pos=0, bpm=0.0, beat_per_bar=4, beat_unit=4):
        self.tick_pos = tick_pos
        self.tick_end = 2 ** 31 - 1
        self.bpm = bpm
        self.beat_per_bar = beat_per_bar
        self.beat_unit = beat_unit
        self.ms_pos = 0.0
        self.ms_end = float('inf')
        self.ms_per_tick = 0.0
        self.ticks_per_ms = 0.0

    @property
    def ticks(self):
        return self.tick_end - self.tick_pos


DEFAULT_BPM = 120.0
DEFAULT_BEAT_PER_BAR = 4
DEFAULT_BEAT_UNIT = 4
INT_MAX = 2 ** 31 - 1


def _is_valid_bpm(bpm):
    """对应 `TimeAxis.IsValidBpm`：必须是有限正数。"""
    return math.isfinite(bpm) and bpm > 0


class TimeAxis:
    """照搬 TimeAxis。构造后需 `build_segments(project)` 才能查询。"""

    def __init__(self):
        self._time_sig_segments = []
        self._tempo_segments = []
        self.timestamp = 0

    # ---------------------------------------------------------------- 构建

    def build_segments(self, project):
        self.timestamp = 0          # C# 用 DateTime.Now.ToFileTimeUtc()，仅作变更标记
        res = project.resolution
        self._time_sig_segments = []
        for i, timesig in enumerate(project.time_signatures):
            pos_tick = 0
            if i > 0:
                last = self._time_sig_segments[-1]
                last_bar_pos = project.time_signatures[i - 1].bar_position
                pos_tick = last.tick_pos + last.ticks_per_bar * (timesig.bar_position - last_bar_pos)
            else:
                if timesig.bar_position != 0:
                    raise ValueError('First time signature must be at bar 0.')
            beat_per_bar = timesig.beat_per_bar if timesig.beat_per_bar > 0 else DEFAULT_BEAT_PER_BAR
            beat_unit = timesig.beat_unit if timesig.beat_unit > 0 else DEFAULT_BEAT_UNIT
            self._time_sig_segments.append(_TimeSigSegment(
                bar_pos=timesig.bar_position, tick_pos=pos_tick,
                beat_per_bar=beat_per_bar, beat_unit=beat_unit,
                ticks_per_bar=res * 4 * beat_per_bar // beat_unit,
                ticks_per_beat=res * 4 // beat_unit,
            ))
        if not self._time_sig_segments:
            self._time_sig_segments.append(_TimeSigSegment(
                bar_pos=0, tick_pos=0,
                beat_per_bar=DEFAULT_BEAT_PER_BAR, beat_unit=DEFAULT_BEAT_UNIT,
                ticks_per_bar=res * 4 * DEFAULT_BEAT_PER_BAR // DEFAULT_BEAT_UNIT,
                ticks_per_beat=res * 4 // DEFAULT_BEAT_UNIT,
            ))
        for i in range(len(self._time_sig_segments) - 1):
            self._time_sig_segments[i].bar_end = self._time_sig_segments[i + 1].bar_pos
            self._time_sig_segments[i].tick_end = self._time_sig_segments[i + 1].tick_pos

        self._tempo_segments = [_TempoSegment(
            tick_pos=s.tick_pos, beat_per_bar=s.beat_per_bar, beat_unit=s.beat_unit)
            for s in self._time_sig_segments]
        for i, tempo in enumerate(project.tempos):
            if i == 0 and tempo.position != 0:
                raise ValueError('First tempo must be at tick 0.')
            index = next((k for k, seg in enumerate(self._tempo_segments)
                          if seg.tick_pos >= tempo.position), -1)
            if index < 0:
                self._tempo_segments.append(_TempoSegment(
                    tick_pos=tempo.position, bpm=tempo.bpm,
                    beat_per_bar=self._tempo_segments[-1].beat_per_bar,
                    beat_unit=self._tempo_segments[-1].beat_unit))
            elif self._tempo_segments[index].tick_pos == tempo.position:
                self._tempo_segments[index].bpm = tempo.bpm
            else:
                self._tempo_segments.insert(index, _TempoSegment(
                    tick_pos=tempo.position, bpm=tempo.bpm,
                    beat_per_bar=self._tempo_segments[index - 1].beat_per_bar,
                    beat_unit=self._tempo_segments[index - 1].beat_unit))
        if not _is_valid_bpm(self._tempo_segments[0].bpm):
            self._tempo_segments[0].bpm = DEFAULT_BPM
        for i in range(len(self._tempo_segments) - 1):
            if not _is_valid_bpm(self._tempo_segments[i + 1].bpm):
                self._tempo_segments[i + 1].bpm = self._tempo_segments[i].bpm
            self._tempo_segments[i].tick_end = self._tempo_segments[i + 1].tick_pos
        for i, seg in enumerate(self._tempo_segments):
            seg.ms_per_tick = 60.0 * 1000.0 / (seg.bpm * res)
            seg.ticks_per_ms = seg.bpm * res / (60.0 * 1000.0)
            if i > 0:
                prev = self._tempo_segments[i - 1]
                seg.ms_pos = prev.ms_pos + prev.ticks * prev.ms_per_tick
                prev.ms_end = seg.ms_pos

    # ---------------------------------------------------------------- 段查找（不抛异常）

    def _tempo_segment_at_tick(self, tick):
        if not (isinstance(tick, float) and math.isnan(tick)):
            for seg in self._tempo_segments:
                if seg.tick_pos == tick or seg.tick_end > tick:
                    return seg
        return self._tempo_segments[-1]

    def _tempo_segment_at_ms(self, ms):
        if not (isinstance(ms, float) and math.isnan(ms)):
            for seg in self._tempo_segments:
                if seg.ms_pos == ms or seg.ms_end > ms:
                    return seg
        return self._tempo_segments[-1]

    def _timesig_segment_at_tick(self, tick):
        for seg in self._time_sig_segments:
            if seg.tick_pos == tick or seg.tick_end > tick:
                return seg
        return self._time_sig_segments[-1]

    def _timesig_segment_at_bar(self, bar):
        for seg in self._time_sig_segments:
            if seg.bar_pos == bar or seg.bar_end > bar:
                return seg
        return self._time_sig_segments[-1]

    # ---------------------------------------------------------------- 换算

    def get_bpm_at_tick(self, tick):
        return self._tempo_segment_at_tick(tick).bpm

    def tick_pos_to_ms_pos(self, tick):
        seg = self._tempo_segment_at_tick(tick)
        return seg.ms_pos + seg.ms_per_tick * (tick - seg.tick_pos)

    def ms_pos_to_non_exact_tick_pos(self, ms):
        seg = self._tempo_segment_at_ms(ms)
        return seg.tick_pos + (ms - seg.ms_pos) * seg.ticks_per_ms

    def ms_pos_to_tick_pos(self, ms):
        seg = self._tempo_segment_at_ms(ms)
        tick_pos = seg.tick_pos + (ms - seg.ms_pos) * seg.ticks_per_ms
        if not math.isfinite(tick_pos):
            return seg.tick_pos
        return int(round(max(-2 ** 31, min(INT_MAX, tick_pos))))

    def ticks_between_ms_pos(self, ms_pos, ms_end):
        return self.ms_pos_to_tick_pos(ms_end) - self.ms_pos_to_tick_pos(ms_pos)

    def ms_between_tick_pos(self, tick_pos, tick_end):
        return self.tick_pos_to_ms_pos(tick_end) - self.tick_pos_to_ms_pos(tick_pos)

    def ms_to_tick_at(self, offset_ms, ref_tick_pos):
        """毫秒时长 → tick 数；offset_ms 为负表示到 ref_tick_pos 结束。"""
        return self.ticks_between_ms_pos(
            self.tick_pos_to_ms_pos(ref_tick_pos),
            self.tick_pos_to_ms_pos(ref_tick_pos) + offset_ms)

    def tick_pos_to_bar_beat(self, tick):
        """返回 (bar, beat, remaining_ticks)。"""
        seg = self._timesig_segment_at_tick(tick)
        bar = seg.bar_pos + (tick - seg.tick_pos) // seg.ticks_per_bar
        tick_in_bar = tick - seg.tick_pos - seg.ticks_per_bar * (bar - seg.bar_pos)
        beat = tick_in_bar // seg.ticks_per_beat
        return bar, beat, tick_in_bar - beat * seg.ticks_per_beat

    def bar_beat_to_tick_pos(self, bar, beat):
        seg = self._timesig_segment_at_bar(bar)
        return seg.tick_pos + seg.ticks_per_bar * (bar - seg.bar_pos) + seg.ticks_per_beat * beat

    def next_bar_beat(self, bar, beat):
        seg = self._timesig_segment_at_bar(bar)
        next_beat = beat + 1
        if next_beat >= seg.beat_per_bar:
            return bar + 1, 0
        return bar, next_beat

    def tempos_between_ticks(self, start, end):
        out = [{'position': s.tick_pos, 'bpm': s.bpm} for s in self._tempo_segments
               if start < s.tick_end and s.tick_pos < end]
        if not out:
            seg = self._tempo_segment_at_tick(start)
            out = [{'position': start, 'bpm': seg.bpm}]
        return out

    def time_signature_at_tick(self, tick):
        s = self._timesig_segment_at_tick(tick)
        return {'bar_position': s.bar_pos, 'beat_per_bar': s.beat_per_bar, 'beat_unit': s.beat_unit}

    def time_signature_at_bar(self, bar):
        s = self._timesig_segment_at_bar(bar)
        return {'bar_position': s.bar_pos, 'beat_per_bar': s.beat_per_bar, 'beat_unit': s.beat_unit}

    def clone(self):
        c = TimeAxis()
        c._time_sig_segments = list(self._time_sig_segments)   # 段建好后不再改动，浅拷贝即可
        c._tempo_segments = list(self._tempo_segments)
        return c

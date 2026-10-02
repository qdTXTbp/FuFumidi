# -*- coding: utf-8 -*-
"""渲染期的乐句结构 —— **照搬** `OpenUtau.Core/Render/RenderPhrase.cs`（全文件，663 行 / 3 个类）。

`RenderNote` / `RenderPhone` / `RenderPhrase` 是渲染器真正读到的输入：
音素化、表达式解析、颤音/弯音/曲线采样在 `RenderPhrase` 的构造函数里**一次算完**，
之后渲染器（Classic / Worldline / DiffSinger…）只读不写。照搬这一层，等于把
"编辑器看到的音高曲线"和"引擎算出来的音高曲线"钉死在同一条算式上。

## 照搬的派生字段（容易看漏）
- `RenderNote`：`position = partPosition + note.Position - phrasePosition`（**相对乐句起点**），
  `end = position + duration`；`positionMs/endMs` 用**绝对 tick**（`partPosition + note.Position`）
  查时间轴，`durationMs = endMs - positionMs`。
- `RenderPhone`：`durCorrectionMs = Preutter - TailIntrude + TailOverlap`（不是简单相加），
  `leadingMs = Preutter`。
- `RenderPhrase.leading` 取**首个**音素的 `leading`；`positionMs` 取首个音素的 `positionMs`，
  `endMs` 取末个音素的 `endMs`。

## `Hash()` 必须逐字节照搬
两处 `Hash()` 都用 `BinaryWriter` 按固定顺序写字段再取 `XXH64`。
**写入顺序、类型宽度（float 4B / double 8B / int 4B / long 8B / ulong 8B）、
字符串的 7-bit 变长长度前缀**都不能变，否则缓存键与"输入是否变化"的判断会对不上，
表现为"同一份工程时快时慢、偶尔复用错缓存"。字节布局由 `binary_writer.BinaryWriter`
复刻（`Classic/ResamplerItem` 也用同一个），字符串用 7-bit 变长长度前缀 + UTF-8。

## 尚未照搬、因此目前走不到的分支（照搬时如实保留守卫）
- **表达式图**（`source.ExpressionGraph != null`）：三处 `? pitches.ToArray() : null`
  与 `graphCurves` 都依赖 `ExpressionGraph`，未搬 → 恒为 None，分支跳过。
- **MOD+**（`source.ModpSupported && source.ClassicSinger != null`）：依赖
  `ClassicSinger` / `OtoFrq`，未搬 → `classic_singer` 恒为 None，分支跳过。
  真走到说明地基已补齐，那时再把 C# 的 MOD+ 段落原样搬进 `_apply_mod_plus`。
- `FromPart`（依赖 `PhraseSource.FromPart`）与 `DeleteCacheFiles`（依赖 `PathManager`）
  同理未搬，见文末说明。

## 已知的载体差异（不是逻辑差异）
C# 里 `pitches` / `dynamics` / `curves` 都是 `float[]`，逐步累加会**每一步都舍到
float32**；Python 的 `list[float]` 是 float64。两者在同一条算式上会有约 1e-7 的
相对偏差（远低于 1e-6 半音，且最终哈希仍按 float32 写出）。要完全逐位相同，
得给这个包引入 numpy 的 float32 数组 —— 但那样这个包就不能脱离 numpy 单测了。
当前选择保留 float64，把"逐位一致"的目标限定在**同一实现内部**（缓存键自洽）。
"""

import math
import os

from typing import List, Optional, Tuple

from ..ustx.model import PitchPoint, PitchPointShape
from .binary_writer import BinaryWriter
from .format import Ustx
from .music_math import MusicMath, fdiv, idiv
from .phrase_layout import PhraseLayout
from .pipeline_source import CurveSource, NoteSource, PhonemeSource, PhraseSource
from .spline import CubicSplineSegment

#: 音高/曲线采样间隔（tick）—— C# 里是 `const int pitchInterval = 5` / `interval = 5`
PITCH_INTERVAL = 5


class RenderNote:
    """对应 RenderPhrase.cs 的 `RenderNote`。"""

    __slots__ = ('lyric', 'tone', 'tuning', 'adjusted_tone',
                 'position', 'duration', 'end',
                 'position_ms', 'duration_ms', 'end_ms')

    def __init__(self, note: NoteSource, axis, part_position: int, phrase_position: int):
        self.lyric = note.lyric
        self.tone = note.tone
        self.tuning = note.tuning
        self.adjusted_tone = note.adjusted_tone

        self.position = part_position + note.position - phrase_position
        self.duration = note.duration
        self.end = self.position + self.duration

        self.position_ms = axis.tick_pos_to_ms_pos(part_position + note.position)
        self.end_ms = axis.tick_pos_to_ms_pos(part_position + note.end)
        self.duration_ms = self.end_ms - self.position_ms

    def __repr__(self):
        return 'RenderNote(lyric=%r, tone=%d, pos=%d)' % (self.lyric, self.tone, self.position)


class RenderPhone:
    """对应 RenderPhrase.cs 的 `RenderPhone`。

    `hash` 是**单个音素**的缓存键：只覆盖影响出声的参数（时长、音色、resampler、
    flags、音量/力度/调制、包络…），刻意**不含**音高 —— 音高由乐句级 `RenderPhrase.hash`
    统一覆盖，这样同一个音素在不同音高下可以共用渲染结果。
    """

    #: 二级变体（xsy 交叉合成）的哈希掩码（对应 `Oto2HashMask`）
    OTO2_HASH_MASK = 0x5858585858585858

    def __init__(self, source: PhraseSource, phoneme: PhonemeSource, phrase_position: int):
        self.position = source.part_position + phoneme.position - phrase_position
        self.duration = phoneme.duration
        self.end = self.position + self.duration

        self.position_ms = phoneme.position_ms
        self.duration_ms = phoneme.duration_ms
        self.end_ms = phoneme.end_ms
        self.leading_ms = phoneme.preutter
        self.leading = phoneme.leading

        self.phoneme = phoneme.phoneme
        self.tone = phoneme.tone
        self.note_index = phoneme.note_index
        self.tempos = phoneme.tempos
        self.tempo = phoneme.tempo
        self.adjusted_tempo = phoneme.adjusted_tempo

        self.preutter_ms = phoneme.preutter
        self.overlap_ms = phoneme.overlap
        # 注意：不是 preutter+tailIntrude+tailOverlap 的简单加减，按 C# 原文写
        self.dur_correction_ms = phoneme.preutter - phoneme.tail_intrude + phoneme.tail_overlap

        self.resampler = phoneme.resampler
        self.flags: List[Tuple[str, Optional[int], str]] = phoneme.flags
        self.suffix = phoneme.suffix
        self.suffix2 = phoneme.suffix2
        self.volume = phoneme.volume
        self.velocity = phoneme.velocity
        self.modulation = phoneme.modulation
        self.envelope = phoneme.envelope
        self.direct = phoneme.direct
        self.tone_shift = phoneme.tone_shift
        self.driven_expressions = phoneme.driven

        self.oto = phoneme.oto
        self.oto2 = phoneme.oto2
        self.hash = self._compute_hash()

    def with_oto(self, oto) -> 'RenderPhone':
        """对应 `WithOto`：换成二级 oto 并**异或**上掩码，使两者的缓存文件互不覆盖。

        C# 用 `MemberwiseClone()` 浅拷贝；Python 侧用 `copy.copy` 保持同一语义
        （字段值共享引用，不深拷贝）。
        """
        import copy
        new = copy.copy(self)
        new.oto = oto
        new.hash = self.hash ^ RenderPhone.OTO2_HASH_MASK
        return new

    def _compute_hash(self) -> int:
        """照搬 C# 的 `Hash()`：写入顺序/类型宽度必须逐字节一致。"""
        w = BinaryWriter()
        w.write_double(self.adjusted_tempo)
        w.write_int(self.duration)
        w.write_str(self.phoneme)
        w.write_int(self.tone)

        w.write_str(self.resampler)
        for flag in self.flags or []:
            w.write_str(flag[0])
            if flag[1] is not None:
                w.write_int(flag[1])
        w.write_str(self.suffix)
        if self.suffix2 is not None:
            w.write_str(self.suffix2)
        w.write_float(self.volume)
        w.write_float(self.velocity)
        w.write_float(self.modulation)
        w.write_bool(self.direct)
        w.write_double(self.leading_ms)
        for point in self.envelope or []:
            w.write_float(point.x)
            w.write_float(point.y)
        return w.digest()

    def __str__(self):
        return '"%s" pos:%d' % (self.phoneme, self.position)

    __repr__ = __str__


class RenderPhrase:
    """对应 RenderPhrase.cs 的 `RenderPhrase`。

    ★ 构造函数里的**语句顺序本身是语义**：先定 `position`（后续 `RenderNote` /
    `RenderPhone` 都以它为 `phrasePosition`），再算音高数组（先铺平、再颤音、再弯音），
    然后 PITD，最后曲线与两个哈希。任何"整理成更漂亮的顺序"都可能改变结果。
    """

    def __init__(self, source: PhraseSource, phonemes: List[PhonemeSource],
                 phrase_start: int, phrase_end: int):
        # `phonemes.Skip(phraseStart).Take(phraseEnd - phraseStart)`
        phrase_phonemes = list(phonemes[phrase_start:phrase_end])
        notes_of = source.notes

        def at(i: int) -> NoteSource:
            """等价于 C# 的 `notesOf[i]` —— 负下标要像 C# 一样抛错，而不是绕回末尾。"""
            if i < 0 or i >= len(notes_of):
                raise IndexError('note index out of range: %d' % i)
            return notes_of[i]

        # ---- 选出本条乐句覆盖的音符下标（含延音、以及两侧恰好相邻的音符）
        u_notes = [phrase_phonemes[0].note_index]
        end_note = phrase_phonemes[-1].note_index
        while at(end_note).next != -1 and at(at(end_note).next).extends != -1:
            end_note = at(end_note).next
        while u_notes[-1] != end_note:
            u_notes.append(at(u_notes[-1]).next)
        tail = u_notes[-1]
        nxt = at(tail).next
        while nxt != -1 and at(nxt).extends == tail:
            u_notes.append(nxt)
            nxt = at(nxt).next
        if (at(u_notes[0]).prev != -1
                and at(at(u_notes[0]).prev).end == at(u_notes[0]).position):
            u_notes.insert(0, at(u_notes[0]).prev)
        if (at(u_notes[-1]).next != -1
                and at(u_notes[-1]).end == at(at(u_notes[-1]).next).position):
            u_notes.append(at(u_notes[-1]).next)

        self.singer = source.singer
        self.renderer = source.renderer
        self.wavtool = source.wavtool
        self.time_axis = source.axis

        position = source.part_position + phrase_phonemes[0].position
        end = source.part_position + phrase_phonemes[-1].end
        self.position = position
        self.end = end
        self.duration = end - position

        self.notes = [RenderNote(at(n), self.time_axis, source.part_position, position)
                      for n in u_notes]
        self.phones = [RenderPhone(source, p, position) for p in phrase_phonemes]

        self.leading = self.phones[0].leading

        self.position_ms = self.phones[0].position_ms
        self.end_ms = self.phones[-1].end_ms
        self.duration_ms = self.end_ms - self.position_ms
        self.leading_ms = self.phones[0].leading_ms

        # ---------------------------------------------------------- 音高
        pitch_start = position - source.part_position - self.leading
        pitches = [0.0] * (idiv(end - source.part_position - pitch_start, PITCH_INTERVAL) + 1)
        index = 0
        # 先按音符铺平
        for note_idx in u_notes:
            note = at(note_idx)
            while pitch_start + index * PITCH_INTERVAL < note.end and index < len(pitches):
                pitches[index] = note.adjusted_tone * 100
                index += 1
        index = max(1, index)
        while index < len(pitches):
            pitches[index] = pitches[index - 1]
            index += 1

        # 音符级音高（未加颤音/弯音）：给表达式图区分「颤音」与「弯音」，也是音高的兜底值
        pitches_before_vibrato = list(pitches) if source.expression_graph is not None else None

        # 颤音
        for note_idx in u_notes:
            note = at(note_idx)
            vib = note.vibrato
            if vib is None or vib.length <= 0:
                continue
            start_index = max(0, math.ceil((note.position - pitch_start) / PITCH_INTERVAL))
            end_index = min(len(pitches), idiv(note.end - pitch_start, PITCH_INTERVAL))
            # 用音符起点处的速度计算颤音周期（C# 注释如此）
            n_period = fdiv(vib.period, note.duration_ms)
            for i in range(start_index, end_index):
                n_pos = fdiv(pitch_start + i * PITCH_INTERVAL - note.position, note.duration)
                point = vib.evaluate(n_pos, n_period, note)
                pitches[i] = point.y * 100

        vibrato_pitches = list(pitches) if source.expression_graph is not None else None

        # 弯音点
        for note_idx in u_notes:
            note = at(note_idx)
            pitch_points = []
            for point in note.pitch_points:
                node_pos_ms = self.time_axis.tick_pos_to_ms_pos(source.part_position + note.position)
                pitch_points.append(PitchPoint(
                    self.time_axis.ms_pos_to_tick_pos(node_pos_ms + point.x) - source.part_position,
                    point.y * 10 + note.adjusted_tone * 100,
                    point.shape,
                    getattr(point, 'auto_completed', False)))
            if not pitch_points:
                pitch_points.append(PitchPoint(note.position, note.adjusted_tone * 100,
                                               PitchPointShape.IO, True))
                pitch_points.append(PitchPoint(note.end, note.adjusted_tone * 100,
                                               PitchPointShape.IO, True))
            if note_idx == u_notes[0] and pitch_points[0].x > pitch_start:
                pitch_points.insert(0, PitchPoint(pitch_start, pitch_points[0].y,
                                                  PitchPointShape.IO, True))
            elif pitch_points[0].x > note.position:
                pitch_points.insert(0, PitchPoint(note.position, pitch_points[0].y,
                                                  PitchPointShape.IO, True))
            if pitch_points[-1].x < note.end:
                pitch_points.append(PitchPoint(note.end, pitch_points[-1].y,
                                               PitchPointShape.IO, True))
            index = max(0, idiv(pitch_points[0].x - pitch_start, PITCH_INTERVAL))

            for i in range(len(pitch_points) - 1):
                point_1 = pitch_points[i] if i == 0 else pitch_points[i - 1]
                point0 = pitch_points[i]
                point1 = pitch_points[i + 1]
                point2 = pitch_points[i + 1] if i >= len(pitch_points) - 2 else pitch_points[i + 2]
                x = pitch_start + index * PITCH_INTERVAL

                # 弯音形状为 spline 且该点不是"自动补全"的端点时，走三次样条；
                # 注意判据用的是**原始** note.pitch_points 的数量（> 2），不是补全后的
                use_spline = (len(note.pitch_points) > 2
                              and point0.shape == PitchPointShape.SP
                              and not point1.auto_completed)
                if use_spline:
                    curve = CubicSplineSegment(
                        point_1.x, point_1.y,
                        point0.x, point0.y,
                        point1.x, point1.y,
                        point2.x, point2.y)
                    while x < point1.x and index < len(pitches):
                        pitch = curve.get_y(x)
                        base_pitch = (at(note.prev).adjusted_tone * 100
                                      if note.prev != -1 and x < at(note.prev).end
                                      else note.adjusted_tone * 100)
                        pitches[index] += pitch - base_pitch
                        index += 1
                        x += PITCH_INTERVAL
                else:
                    while x < point1.x and index < len(pitches):
                        pitch = MusicMath.interpolate_shape(
                            point0.x, point1.x, point0.y, point1.y, x, point0.shape)
                        base_pitch = (at(note.prev).adjusted_tone * 100
                                      if note.prev != -1 and x < at(note.prev).end
                                      else note.adjusted_tone * 100)
                        pitches[index] += pitch - base_pitch
                        index += 1
                        x += PITCH_INTERVAL

        # 音符 + 颤音 + 弯音（给表达式图用）
        parametric_pitches = list(pitches) if source.expression_graph is not None else None

        # ---------------------------------------------------------- MOD+
        if source.modp_supported and source.classic_singer is not None:
            pitches = self._apply_mod_plus(source, phrase_phonemes, pitches, pitch_start)

        # ---------------------------------------------------------- PITD
        self.pitches_before_deviation = list(pitches)
        pitch_curve = next((c for c in source.curves if c.abbr == Ustx.PITD), None)
        if pitch_curve is not None and not pitch_curve.is_empty:
            for i in range(len(pitches)):
                pitches[i] += pitch_curve.sample(pitch_start + i * PITCH_INTERVAL)

        # ---------------------------------------------------------- 表达式图（未照搬 → 恒跳过）
        graph_curves = None
        driven_curve_values = None
        if source.expression_graph is not None:
            raise NotImplementedError(
                '表达式图（ExpressionGraph）尚未照搬；PhraseSource.expression_graph 应为 None。')

        # ---------------------------------------------------------- 曲线
        curves: List[Tuple[str, List[float]]] = []
        dynamics = gender = breathiness = tone_shift = tension = voicing = xsy = None

        for descriptor in source.curve_descriptors:
            curve = next((c for c in source.curves if c.abbr == descriptor.abbr), None)
            if curve is None:
                curve = CurveSource.empty(descriptor.abbr, int(descriptor.default_value),
                                          float(descriptor.min))

            if (graph_curves is not None and curve.abbr != Ustx.PITD
                    and curve.abbr in graph_curves):
                raise NotImplementedError('表达式图驱动的曲线尚未照搬。')
            curve_sampled = _sample_curve(curve, pitch_start, len(pitches), _curve_convert)

            if curve.abbr == Ustx.PITD:
                pass
            elif curve.abbr == Ustx.DYN:
                dynamics = curve_sampled
            elif curve.abbr == Ustx.SHFC:
                tone_shift = curve_sampled
            elif curve.abbr == Ustx.GENC:
                gender = curve_sampled
            elif curve.abbr == Ustx.TENC:
                tension = curve_sampled
            elif curve.abbr == Ustx.BREC:
                breathiness = curve_sampled
            elif curve.abbr == Ustx.VOIC:
                voicing = curve_sampled
            elif curve.abbr == Ustx.XSY:
                xsy = curve_sampled
                # 每个音素的引导段内不参与交叉合成（置 0）
                for phone in self.phones:
                    start_idx = max(0, idiv(phone.position - phone.leading - pitch_start,
                                            PITCH_INTERVAL))
                    end_idx = min(len(xsy), max(0, idiv(phone.position - pitch_start,
                                                        PITCH_INTERVAL)))
                    for k in range(start_idx, end_idx):
                        xsy[k] = 0.0
            else:
                curves.append((curve.abbr, curve_sampled))

        # ---------------------------------------------------------- 颤音联动音量
        for note_idx in u_notes:
            note = at(note_idx)
            vib = note.vibrato
            if vib is None or vib.length <= 0 or vib.vol_link == 0:
                continue
            if dynamics is None:
                dynamics = [0.0] * (idiv(end - source.part_position - pitch_start,
                                         PITCH_INTERVAL) + 1)
            start_index = max(0, math.ceil((note.position - pitch_start) / PITCH_INTERVAL))
            end_index = min(len(pitches), idiv(note.end - pitch_start, PITCH_INTERVAL))
            n_period = fdiv(vib.period, note.duration_ms)
            for i in range(start_index, end_index):
                n_pos = fdiv(pitch_start + i * PITCH_INTERVAL - note.position, note.duration)
                ratio = vib.evaluate_volume(n_pos, n_period)
                dynamics[i] = dynamics[i] * ratio

        self.pitches = pitches
        self.pitches_before_vibrato = pitches_before_vibrato
        self.vibrato_pitches = vibrato_pitches
        self.parametric_pitches = parametric_pitches
        self.dynamics = dynamics
        self.gender = gender
        self.breathiness = breathiness
        self.tone_shift = tone_shift
        self.tension = tension
        self.voicing = voicing
        self.xsy = xsy
        self.curves = curves
        self.driven_curves = driven_curve_values
        self.pre_effect_hash = self._hash(False)
        self.hash = self._hash(True)

        # ---------------------------------------------------------- 布局
        try:
            layout = self.renderer.layout(self)
            start_ms = layout.position_ms - layout.leading_ms
            self.layout = PhraseLayout(start_ms,
                                       start_ms + layout.estimated_length_ms,
                                       layout.leading_ms,
                                       layout.estimated_length_ms)
        except Exception:
            # 歌手不可用时 Layout 会失败；退回音素跨度（照搬 C# 的兜底）
            self.layout = PhraseLayout(self.position_ms, self.end_ms, 0,
                                       self.end_ms - self.position_ms)

        self.cache_files: List[str] = []

    # ------------------------------------------------------------------ 内部

    def _apply_mod_plus(self, source, phrase_phonemes, pitches, pitch_start):
        """MOD+（对 oto 频率表做音高微调）。

        对应 C# 里 `source.ModpSupported && source.ClassicSinger != null` 那段。
        **尚未照搬**：需要 `ClassicSinger` 与 `OtoFrq`（M2-a 剩余部分）。
        当前 `PhraseSource.classic_singer` 恒为 None，所以这条分支不会被触发；
        真被触发说明地基已补齐 —— 那时把 C# 的 MOD+ 段落原样搬到这里。
        """
        raise NotImplementedError('MOD+ 需要 ClassicSinger / OtoFrq（尚未照搬）')

    def _hash(self, post_effect: bool) -> int:
        """对应 C# 的 `Hash(bool postEffect)`。

        `post_effect=False` 得到 `preEffectHash` —— 只覆盖"音素参数"，不含音高/曲线，
        用于判断"能否只改效果而不用重新合成"。

        ⚠ **上游既有怪癖（照搬，不"顺手修好"）**：这里写的是
        `timeAxis.Timestamp`，而 `RenderPhrase` 用的 `source.Axis` 是
        `project.timeAxis.Clone()`；C# 的 `TimeAxis.Clone()` 走 `new TimeAxis()`，
        `Timestamp` 没被复制 → 恒为 0。所以这一项**实际上对哈希没有贡献**
        （"改速度导致缓存失效"这件事由 pitches/dynamics 的数值间接覆盖）。
        我们的 `TimeAxis.clone()` 同样不复制 timestamp，行为一致。
        """
        w = BinaryWriter()
        w.write_str(self.singer.id)
        w.write_str(str(self.renderer) if self.renderer is not None else '')
        w.write_str(self.wavtool)
        w.write_long(self.time_axis.timestamp)
        for phone in self.phones:
            w.write_ulong(phone.hash)
        if post_effect:
            for array in (self.pitches, self.dynamics, self.gender, self.breathiness,
                          self.tone_shift, self.tension, self.voicing, self.xsy):
                if array is None:
                    w.write_str('null')
                else:
                    for v in array:
                        w.write_float(v)
            # 自定义曲线：写入顺序与 C# 一致（先名字，再逐个 float）
            for curve in self.curves:
                w.write_str(curve[0])
                for v in curve[1]:
                    w.write_float(v)
        return w.digest()

    # ------------------------------------------------------------------ 缓存文件

    def add_cache_file(self, file: str) -> None:
        """对应 `AddCacheFile`：只记**不含扩展名的文件名**，去重。"""
        if not file or not file.strip():
            return
        filename = os.path.splitext(os.path.basename(file))[0]
        if filename not in self.cache_files:
            self.cache_files.append(filename)

    def delete_cache_files(self, cache_dir: str) -> None:
        """对应 `DeleteCacheFiles`（宿主负责传缓存目录，C# 用 `PathManager.Inst.CachePath`）。

        ★ 注意 C# 的删除是**通配前缀** `${filename}*` —— 同一个音素的多个中间文件
        （`.wav` / `.frq` / 临时文件）靠这个前缀一起清掉，不要改成精确匹配。
        `singer is ClassicSinger` 时的 `Frq` 清理属于 M2-a 剩余部分，未搬。
        """
        import glob
        for filename in self.cache_files:
            for path in glob.glob(os.path.join(cache_dir, filename + '*')):
                try:
                    os.remove(path)
                except OSError:
                    pass
        self.cache_files.clear()

    # ------------------------------------------------------------------ xsy 变体

    @staticmethod
    def build_xsy_variant(src: 'RenderPhrase') -> 'RenderPhrase':
        """对应 `BuildXsyVariant`：每个带 oto2 的音素换成 oto2，并异或 xsy 掩码。

        原乐句**不被改动**（C# 是 MemberwiseClone 出副本）；副本共享
        `cache_files` 列表，这样两个变体的缓存文件会一起被清理。
        """
        import copy
        variant = copy.copy(src)
        variant.phones = [p.with_oto(p.oto2) if p.oto2 is not None else p for p in src.phones]
        variant.hash = src.hash ^ RenderPhone.OTO2_HASH_MASK
        return variant

    @staticmethod
    def from_part(project, track, part) -> List['RenderPhrase']:
        """对应 `RenderPhrase.FromPart(project, track, part)`：同步取快照 + 构建。

        给脚本与测试用的**一站式入口**（代际传 0：这是一次性构建，不参与
        "迟到结果"的判定）。part 没有可用音素时返回**空列表**（C# 的
        `new List<RenderPhrase>()`），不是 None。
        """
        source = PhraseSource.from_part(project, track, part, 0)
        if source is None:
            return []
        return source.build_phrases()

    def __repr__(self):
        return 'RenderPhrase(pos=%d, dur=%d, phones=%d, notes=%d)' % (
            self.position, self.duration, len(self.phones), len(self.notes))


def _curve_convert(x: float, curve: CurveSource) -> float:
    """对应 C# 里那个 `Func<float, CurveSource, float> convert`。

    只有 DYN（动态）需要换算：取值等于 `Min` 时视为 0（"这条曲线这帧没有标注"），
    否则按**分贝→线性**（曲线单位是 0.1 dB，所以先乘 0.1 再换算）。
    其余曲线一律原样返回。
    """
    if curve.abbr == Ustx.DYN:
        return 0.0 if x == curve.min else MusicMath.decibel_to_linear(x * 0.1)
    return x


def _sample_curve(curve: CurveSource, start: int, length: int, convert) -> List[float]:
    """对应 C# 的 `SampleCurve`：按 `interval = 5` 采样一条曲线。

    C# 返回 `float[]`，所以这里也把结果统一转成 float（非 DYN 曲线时
    `convert` 会原样返回 `Sample()` 的 int，不转就会在哈希里写错类型宽度）。
    """
    return [float(convert(curve.sample(start + i * PITCH_INTERVAL), curve))
            for i in range(length)]

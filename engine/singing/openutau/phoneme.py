# -*- coding: utf-8 -*-
"""音素模型 —— 照搬 `OpenUtau.Core/Ustx/UPhoneme.cs`（355 行）。

`UPhoneme` 是「一个音符被拆成若干音素」后的单个音素：它自己算 preutter / overlap /
包络 / resampler flags，并持有错误状态。编辑器底部的音素条带与渲染器都读它。

## 照搬时保留的语义（这些"绕"的地方都是必要的）
- `ValidateDuration`：时长是 `前导音符的 ExtendedEnd - position`，再被
  **下一个音素的起点**夹住；`Next.Parent == Parent.Next && Parent.End == Next.Parent.position`
  时特判为 `int.MaxValue`（跨音符同音素延续）。
- `ValidateDuration` 的错误记忆：`durationErrorException` 只在**仍然是同一条时长错误**时才清除，
  **音素化器报的错（ErrorException）不会被它顺手清掉**。
- `ValidateOverlap`：preutter 会被前一个音素的时长/间隙反复夹紧，且 `autoOverlap` 按比例缩放；
  最后把结果写回 **前一个音素** 的 `tailIntrude` / `tailOverlap`，并递归
  `Prev.ValidateEnvelope(...)`。
- `ValidateEnvelope`：p1.Y 被**赋值两次**（先 vol，后 atk*vol/100）—— 后一次生效。
  这不是笔误，照搬即可（C# 原文如此）；若要"修正"必须先与上游确认。
- `GetFadeIn/GetFadeOut` 的 5 / 35 是固定兜底值，只在 `crossfade && overlapped` 时用 overlap。
- `GetExpression` 的优先顺序：音符音素表达式(True) → 音素化器表达式(False) → 轨道描述符默认值(False)。
- `GetExpressionDescriptors`：**工程的表达式表，被轨道自己的同名项替换**（不是合并去重）。

## 与 C# 的等价性差异
- `track.Singer`（C# 的 USinger 属性）在我们的 UTrack 上叫 `singer_obj`
  （因为 `singer` 已被"歌手名字符串"占用）。调用处按此映射。
- `note.phonemeIndexes` 在 C# 是 UNote 上由所属 part 推出的下标集合；这里作为
  UNote 的运行时属性（`phoneme_indexes`），由调用方设置 —— 未设置时按空集合处理。
"""

from typing import Any, Dict, List, Optional, Tuple

from ..ustx.format import Ustx
from ..ustx.model import UEnvelope, Vector2
from .oto import UOto


class ValidateOptions:
    """对应 C# 的 `ValidateOptions`（校验范围开关）。

    C# 的完整字段是 `SkipTiming / SkipPhoneme / SkipPhonemizer / Part`
    （`skip_phoneme` / `skip_phonemizer` 在音素化编排里用）。
    """

    def __init__(self, skip_timing: bool = False, part: Any = None,
                 skip_phoneme: bool = False, skip_phonemizer: bool = False):
        self.skip_timing = skip_timing
        self.part = part
        self.skip_phoneme = skip_phoneme
        self.skip_phonemizer = skip_phonemizer


class UPhoneme:
    """对应 UPhoneme.cs 的 UPhoneme。"""

    def __init__(self):
        self.raw_position: int = 0
        self.raw_phoneme: str = 'a'
        self.index: int = 0

        self.position: int = 0                # tick
        self.phoneme: str = ''
        self.phoneme_mapped: str = ''
        self.envelope: UEnvelope = UEnvelope()
        self.oto: Optional[UOto] = None
        self.preutter: float = 0
        self.overlap: float = 0
        self.auto_preutter: float = 0
        self.auto_overlap: float = 0
        self.max_oto_preutter: float = 0
        self.adjacent: bool = False
        self.overlapped: bool = False
        self.tail_intrude: float = 0
        self.tail_overlap: float = 0
        self.preutter_delta: Optional[float] = None
        self.overlap_delta: Optional[float] = None
        self.attack_time_delta: Optional[float] = None
        self.release_time_delta: Optional[float] = None
        self.crossfade: bool = True

        self.parent: Any = None               # UNote
        self.duration: int = 0
        self.position_ms: float = 0
        self.end_ms: float = 0
        self.prev: Optional['UPhoneme'] = None
        self.next: Optional['UPhoneme'] = None
        self.error: bool = False
        self.error_exception: Optional[BaseException] = None
        self._duration_error_exception: Optional[BaseException] = None

    # ---------------------------------------------------------------- 派生量
    @property
    def end(self) -> int:
        return self.position + self.duration

    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.position_ms

    def __str__(self):
        return '"%s" pos:%d' % (self.phoneme, self.position)

    def clone(self) -> 'UPhoneme':
        c = UPhoneme()
        c.position = self.position
        c.phoneme = self.phoneme
        return c

    # ---------------------------------------------------------------- 校验入口

    def validate(self, options: ValidateOptions, project, track, part, note) -> None:
        self.error = bool(getattr(note, 'error', False))
        self._validate_duration(project, part)
        if self.error_exception is not None:
            self.error = True
        self._validate_oto(track, note)
        self._validate_overlap(project, track, part, note)
        self._validate_envelope(project, track, note)

    def _validate_duration(self, project, part) -> None:
        if self.error:
            return
        leading_note = self.parent.extends or self.parent
        self.duration = leading_note.extended_end - self.position
        if self.next is not None and self.parent is not None:
            if self.next.parent is self.parent.next and self.parent.end == self.next.parent.position:
                self.duration = 2 ** 31 - 1
            self.duration = min(self.duration, self.next.position - self.position)
        self.position_ms = project.time_axis.tick_pos_to_ms_pos(part.position + self.position)
        self.end_ms = project.time_axis.tick_pos_to_ms_pos(part.position + self.end)
        self.error = self.duration <= 0
        if self.error:
            # 记住这条异常，避免在反复校验之间闪烁；Validate() 会一直显示到它真的恢复
            if self._duration_error_exception is None:
                self._duration_error_exception = Exception('Phoneme duration is not positive.')
            if self.error_exception is None:
                self.error_exception = self._duration_error_exception
        elif self.error_exception is self._duration_error_exception:
            # 时长恢复合法（例如音素偏移被拖回来了）→ 清掉这条**时长**错误；
            # 音素化器报的错存在 error_exception 里，不能被顺手清掉
            self._duration_error_exception = None
            self.error_exception = None

    def _validate_oto(self, track, note) -> None:
        self.phoneme_mapped = ''
        if self.error:
            return
        singer = getattr(track, 'singer_obj', None)
        if singer is None or not singer.has_found or not singer.is_loaded:
            self.error = True
            if self.error_exception is None:
                self.error_exception = Exception('Singer is not loaded.')
            return
        found, oto = singer.try_get_oto(self.phoneme)
        if found:
            self.oto = oto
            self.error = False
            self.phoneme_mapped = oto.alias
        else:
            self.oto = None
            self.error = True
            if self.error_exception is None:
                self.error_exception = Exception('Oto not found for "%s".' % self.phoneme)
            self.phoneme_mapped = ''

    def _validate_overlap(self, project, track, part, note) -> None:
        if self.error:
            return
        consonant_stretch = 2 ** (1.0 - self.get_expression(project, track, Ustx.VEL)[0] / 100.0)
        self.auto_overlap = self.oto.overlap * consonant_stretch
        self.auto_preutter = self.max_oto_preutter = self.oto.preutter * consonant_stretch
        self.adjacent = False
        self.tail_intrude = 0
        self.tail_overlap = 0

        if self.prev is not None:
            gap_ms = self.position_ms - self.prev.end_ms
            prev_dur = self.prev.duration_ms
            max_preutter = self.auto_preutter
            if gap_ms <= 0:                       # 与前一个音符相邻
                self.adjacent = True
                if self.auto_overlap > 0:
                    if self.auto_preutter - self.auto_overlap > prev_dur * 0.5:
                        max_preutter = prev_dur * 0.5 / (self.auto_preutter - self.auto_overlap) * self.auto_preutter
                max_preutter = min(max_preutter, prev_dur)
                if self.prev.preutter < 5:
                    max_preutter = min(max_preutter, prev_dur + self.prev.preutter - 5)
            elif gap_ms < self.auto_preutter:     # 与前一个音符之间有个小间隙
                max_preutter = gap_ms
            if self.auto_preutter > max_preutter:
                ratio = (max_preutter / self.auto_preutter) if self.auto_preutter > 0 else 0.0
                self.auto_preutter = max_preutter
                self.auto_overlap *= ratio
            if self.auto_overlap < 0:
                self.auto_overlap = max(self.auto_overlap, min(0, 35 - prev_dur + self.auto_preutter))
        self.preutter = max(0.0, self.auto_preutter + (self.preutter_delta or 0))
        self.overlap = self.auto_overlap + (self.overlap_delta or 0)
        if self.prev is not None:
            if self.prev.duration_ms - self.preutter < 5:
                min_overlap = 5 - (self.prev.duration_ms - self.preutter)
                self.overlap = max(self.overlap, min_overlap)
            self.prev.tail_intrude = max(self.preutter, self.preutter - self.overlap) if self.adjacent else 0
            self.prev.tail_overlap = max(self.overlap, 0) if self.adjacent else 0
            self.overlapped = self.adjacent and self.overlap > 0
            self.prev._validate_envelope(project, track, self.prev.parent)

    def _validate_envelope(self, project, track, note) -> None:
        if self.error:
            return
        vol = self.get_expression(project, track, Ustx.VOL)[0]
        atk = self.get_expression(project, track, Ustx.ATK)[0]
        dec = self.get_expression(project, track, Ustx.DEC)[0]

        p0, p1, p2, p3, p4 = Vector2(), Vector2(), Vector2(), Vector2(), Vector2()
        p0.x = -self.preutter
        p1.x = max(p0.x + 5, p0.x + self.get_fade_in() + (self.attack_time_delta or 0))
        p2.x = max(0.0, p1.x)
        p4.x = self.duration_ms - self.tail_intrude + self.tail_overlap
        p3.x = max(p2.x, p4.x - self.get_fade_out() - (self.release_time_delta or 0))

        p0.y = 0.0
        p1.y = vol
        p1.y = atk * vol / 100.0      # 注意：C# 里 p1.Y 被赋值两次，后一次生效，照搬
        p2.y = vol
        p3.y = vol * (1.0 - dec / 100.0)
        p4.y = 0.0

        self.envelope.data[0] = p0
        self.envelope.data[1] = p1
        self.envelope.data[2] = p2
        self.envelope.data[3] = p3
        self.envelope.data[4] = p4

    # ---------------------------------------------------------------- 淡入/淡出

    def get_fade_in(self) -> float:
        if not self.crossfade or not self.overlapped:
            return 5
        return self.overlap

    def get_fade_out(self) -> float:
        if self.next is None or not self.next.crossfade or not self.next.overlapped:
            return 35
        return self.tail_overlap

    # ---------------------------------------------------------------- 表达式读写

    def get_expression(self, project, track, abbr: str) -> Tuple[float, bool]:
        """返回 `(值, 是用户显式设的)`：音符音素表达式 → 音素化器表达式 → 轨道默认值。"""
        descriptor = track.try_get_exp_descriptor(project, abbr)
        note = self.parent.extends or self.parent

        def _match(exp):
            return (exp.descriptor.abbr if exp.descriptor is not None else None) == abbr \
                and exp.index == self.index

        phoneme_exp = next((e for e in note.phoneme_expressions if _match(e)), None)
        if phoneme_exp is not None:
            return (phoneme_exp.value, True)
        phonemizer_exp = next((e for e in note.phonemizer_expressions if _match(e)), None)
        if phonemizer_exp is not None:
            return (phonemizer_exp.value, False)
        return (descriptor.custom_default_value if descriptor is not None else 0.0, False)

    def set_expression(self, project, track, abbr: str, value: Optional[float]) -> None:
        descriptor = track.try_get_exp_descriptor(project, abbr)
        if descriptor is None:
            return
        note = self.parent.extends or self.parent
        indexes = getattr(note, 'phoneme_indexes', None) or []
        if value is None:
            note.phoneme_expressions = [
                e for e in note.phoneme_expressions
                if not ((e.descriptor.abbr if e.descriptor is not None else None) == abbr and e.index == self.index
                        or (e.index is not None and e.index not in indexes))
            ]
        else:
            from ..ustx.model import UExpression

            def _match(e):
                return (e.descriptor.abbr if e.descriptor is not None else None) == abbr and e.index == self.index

            phoneme_exp = next((e for e in note.phoneme_expressions if _match(e)), None)
            if phoneme_exp is not None:
                phoneme_exp.descriptor = descriptor
                phoneme_exp.value = value
            else:
                note.phoneme_expressions.append(
                    UExpression(index=self.index, abbr=descriptor.abbr, descriptor=descriptor, _value=value))

    # ---------------------------------------------------------------- resampler flags

    def get_resampler_flags(self, project, track) -> List[Tuple[str, Optional[int], str]]:
        return self.build_resampler_flags(
            self.get_expression_descriptors(project, track),
            lambda abbr: self.get_expression(project, track, abbr)[0])

    @staticmethod
    def get_expression_descriptors(project, track) -> List[Any]:
        """工程的表达式表，**被轨道自己的同名项替换**（不是合并、不是去重）。"""
        expressions = list(project.expressions.values())
        track_abbrs = {te.abbr for te in track.track_expressions}
        expressions = [e for e in expressions if e.abbr not in track_abbrs]
        expressions.extend(track.track_expressions)
        return expressions

    @staticmethod
    def build_resampler_flags(expressions, get_value) -> List[Tuple[str, Optional[int], str]]:
        """按表达式生成 resampler flags。

        - Numerical：有 flag 才产出一条；`skipOutputIfDefault` 且值等于默认值时**跳过**。
        - Options：只有 `isFlag` 的才产出，取 `options[值]` 作为 flag 名（值无上下界校验）。
        """
        from ..ustx.model import UExpressionType
        flags: List[Tuple[str, Optional[int], str]] = []
        for descriptor in expressions:
            if descriptor.type == UExpressionType.NUMERICAL:
                if descriptor.flag:
                    value = int(get_value(descriptor.abbr))
                    if descriptor.skip_output_if_default and value == int(descriptor.default_value):
                        continue
                    flags.append((descriptor.flag, value, descriptor.abbr))
            elif descriptor.type == UExpressionType.OPTIONS:
                if descriptor.is_flag:
                    value = int(get_value(descriptor.abbr))
                    flags.append((descriptor.options[value], None, descriptor.abbr))
        return flags

    # ---------------------------------------------------------------- 语音色

    def get_voice_color(self, project, track) -> Optional[str]:
        exp = getattr(track, 'voice_color_exp', None)
        if exp is None:
            return None
        index = int(self.get_expression(project, track, Ustx.CLR)[0])
        if index < 0 or index >= len(exp.options or []):
            return None
        return exp.options[index]

    def get_voice_color2(self, project, track) -> Optional[str]:
        exp = getattr(track, 'voice_color2_exp', None)
        if exp is None:
            return None
        index = int(self.get_expression(project, track, Ustx.CLRY)[0])
        if index < 0 or index >= len(exp.options or []):
            return None
        return exp.options[index]

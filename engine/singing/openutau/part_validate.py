# -*- coding: utf-8 -*-
r"""工程校验的音素化段 —— **照搬**两处 C# 逻辑（合成一个无 UI 的同步入口）：

1. `UNote.Validate` / `UNote.ToPhonemizerNote`（`OpenUtau.Core/Ustx/UNote.cs` 88–165 行）
2. `UVoicePart.Validate` 里音素化相关段
   （`OpenUtau.Core/Ustx/UPart.cs` 114–310 行：音符链 → 分组 → 音素化 →
   把响应落成 `UPhoneme` 列表 → 覆写应用 → 安全夹紧 → 逐音素 Validate）

## 为什么单独成文件（而不是挂在 ustx 模型上）
C# 的 `UNote`/`UPart` 在同一程序集里能直接引用 `Api.Phonemizer` 与运行时
`UPhoneme`；我们的 `singing/ustx` 是纯数据模型包（不应依赖 `singing.openutau`），
所以这些**依赖运行时对象**的函数放在 openutau 包这边，文件边界在 docstring 记明。

## 照搬时保留的语义（别"整理"掉）
- ★ `Validate` 第一行 `duration = Math.Max(10, duration)` —— 最短 10 tick。
- ★ `Prev.End > position` → `Error = true` 且 `OverlapError = true` **提前 return**
  （后面的 singer 缺失检查不执行）。
- ★ `ToPhonemizerNote` 的歌词用正则 `\[(.*)\]` 提取 `phoneticHint` 并**从歌词里删掉**；
  `position` 是 **part.position + note.position**（工程绝对 tick）。
- ★ 音素化分组：`OverlapError` 与 `Extends != null` 的音符**不进组**；
  组 = 本音符 + 连续 `Extends == 本音符` 的延音音符。
- ★ 应用响应时 `rawPosition = phoneme.position - part.position`（转回 part 相对 tick）；
  **重复 index 的音素直接丢弃**（报错后 `continue`）。
- ★ 音素化器建议的表达式要过 `descriptor.type != Curve && min ≤ value ≤ max` 才收。
- ★ 安全夹紧从**后往前**：`position = min(position, next.position - 10)`。
- ★ 乱序只**告警一次**（`break`），不做静默修复。
"""

import logging
import re
from typing import Any, List, Optional

from .phoneme import UPhoneme, ValidateOptions
from .phonemizer import PhonemeAttributes
from .phonemizer_runner import PhonemizerRequest, PhonemizerResponse, phonemize

logger = logging.getLogger(__name__)

#: `UNote.cs` 12 行：`static readonly Regex phoneticHintPattern = new Regex(@"\[(.*)\]");`
_PHONETIC_HINT_PATTERN = re.compile(r'\[(.*)\]')


def _is_empty_override(o) -> bool:
    """对应 `UPhonemeOverride.IsEmpty`（UPhoneme.cs 340 行）。"""
    return ((o.phoneme is None or not str(o.phoneme).strip())
            and o.offset is None
            and o.preutter_delta is None
            and o.overlap_delta is None
            and o.attack_time_delta is None
            and o.release_time_delta is None)


# ---------------------------------------------------------------- UNote.Validate

def note_validate(note, options: ValidateOptions, project, track, part) -> None:
    """对应 `UNote.Validate(ValidateOptions, UProject, UTrack, UVoicePart)`。

    `Error` / `OverlapError` 在 C# 是 UNote 的运行时属性；我们的数据模型没有
    这两个字段，这里**动态设置**（与 `phoneme_indexes` 同一约定）。
    """
    note.duration = max(10, note.duration)
    note.position_ms = project.time_axis.tick_pos_to_ms_pos(part.position + note.position)
    note.end_ms = project.time_axis.tick_pos_to_ms_pos(part.position + note.end)
    if note.prev is not None and note.prev.end > note.position:
        note.error = True
        note.overlap_error = True
        return
    note.error = False
    note.overlap_error = False
    singer = getattr(track, 'singer_obj', None)
    if singer is None or not singer.has_found or not singer.is_loaded:
        note.error = True
    pitch = getattr(note, 'pitch', None)
    if pitch is not None and getattr(pitch, 'snap_first', False):
        if note.prev is not None and note.prev.end == note.position:
            pitch.data[0].y = (note.prev.adjusted_tone - note.adjusted_tone) * 10
        else:
            pitch.data[0].y = 0


# ---------------------------------------------------------- UNote.ToPhonemizerNote

def note_to_phonemizer_note(note, track, part):
    """对应 `UNote.ToPhonemizerNote(UTrack, UPart)`。

    从 `phonemeExpressions` 抽 VEL/ALT/CLR/SHFT 四种到 `PhonemeAttributes`
    （★ ALT 的 0 表示"没有 alt"，不写进属性）。
    """
    from ..ustx.format import Ustx
    from .phonemizer import Note as PhonemizerNote

    lrc = note.lyric
    phonetic_hint: Optional[str] = None
    m = _PHONETIC_HINT_PATTERN.search(lrc)
    if m:
        phonetic_hint = m.group(1)
        lrc = _PHONETIC_HINT_PATTERN.sub(lambda _m: '', lrc)

    attributes: List[PhonemeAttributes] = []
    for exp in note.phoneme_expressions:
        abbr = exp.abbr if exp.descriptor is None else exp.descriptor.abbr
        if abbr not in (Ustx.VEL, Ustx.ALT, Ustx.CLR, Ustx.SHFT):
            continue
        index = exp.index if exp.index is not None else 0
        attr = next((a for a in attributes if a.index == index), None)
        if attr is None:
            attr = PhonemeAttributes(index=index)
            attributes.append(attr)
        if abbr == Ustx.VEL:
            attr.consonant_stretch_ratio = 2 ** (1.0 - exp.value / 100.0)
        elif abbr == Ustx.ALT and exp.value != 0:   # 0 means no alt (nothing added)
            attr.alternate = int(exp.value)
        elif abbr == Ustx.CLR and track.voice_color_exp is not None:
            option_idx = int(exp.value)
            options = track.voice_color_exp.options or []
            if 0 <= option_idx < len(options):
                attr.voice_color = options[option_idx]
        elif abbr == Ustx.SHFT:
            attr.tone_shift = int(exp.value)

    return PhonemizerNote(
        lyric=lrc.strip(),
        phonetic_hint=phonetic_hint.strip() if phonetic_hint is not None else None,
        tone=note.tone,
        position=part.position + note.position,
        duration=note.duration,
        phoneme_attributes=attributes,
    )


# ------------------------------------------------------ UVoicePart.Validate（音素化段）

def validate_part_phonemes(options: ValidateOptions, project, track, part,
                           phonemizer, timestamp: int = 0) -> Optional[PhonemizerResponse]:
    """对应 `UVoicePart.Validate`（UPart.cs 114 行起）的音素化相关段。

    步骤：
      1. 音符 prev/next 链 + `Extends`/`ExtendedDuration` + 逐音符 `Validate`；
      2. 分组（跳过 OverlapError / Extends）→ `PhonemizerRequest` → `Phonemize`（同步）；
      3. 响应落成 `part.phonemes`（运行时 `UPhoneme`）+ `note.phonemeIndexes` +
         `note.phonemizerExpressions`；
      4. 用户覆写应用、乱序告警、安全夹紧、逐音素 `Validate`。

    返回 `PhonemizerResponse`（便于测试/宿主检查）；C# 里它被存进
    `phonemizerResponse` 字段等下一次 Validate 消费，同步版直接串起来。

    ★ 与 C# 的差异：`note.PhonemizerOverride` 的"按名字从工厂创建临时音素化器"
    属于编辑器基础设施（`PhonemizerFactory` 注册表在宿主侧），这里只支持
    「override 名 == 传入音素化器名 → 用它，否则回落 pIndex=0」，与 C# 找不到时
    `pIndex = 0` 的行为一致。
    """
    # ---- 1a. 音符链（UPart.cs 115–123）
    last_note = None
    for note in part.notes:
        note.prev = last_note
        note.next = None
        if last_note is not None:
            last_note.next = note
        last_note = note

    # ---- 1b. Extends / ExtendedDuration（UPart.cs 125–133）
    for note in part.notes:
        note.extended_duration = note.duration
        if (note.prev is not None and note.prev.end == note.position
                and note.lyric.startswith('+')):
            note.extends = note.prev.extends if note.prev.extends is not None else note.prev
            note.extends.extended_duration = note.end - note.extends.position
        else:
            note.extends = None

    # ---- 1c. 逐音符 Validate（UPart.cs 134–136）
    for note in part.notes:
        note_validate(note, options, project, track, part)

    # ---- 2. 分组 + 请求（UPart.cs 138–197）
    note_indexes: List[int] = []
    groups: List[List[Any]] = []
    track_phonemizers = [phonemizer]
    note_phonemizer_indices: List[int] = []

    note_index = 0
    for note in part.notes:
        if getattr(note, 'overlap_error', False) or note.extends is not None:
            note_index += 1
            continue
        group = [note]
        next_note = note.next
        while next_note is not None and next_note.extends is note:
            group.append(next_note)
            next_note = next_note.next
        groups.append([note_to_phonemizer_note(e, track, part) for e in group])
        note_indexes.append(note_index)

        p_index = 0
        if note.phonemizer_override:
            p_index = next((i for i, p in enumerate(track_phonemizers)
                            if p is not None and p.name == note.phonemizer_override), -1)
            if p_index == -1:
                # C# 会从 PhonemizerFactory 创建临时实例；引擎侧没有注册表，
                # 与 C# "找不到工厂"时的行为一致：回落 0
                p_index = 0
        note_phonemizer_indices.append(p_index)
        note_index += 1

    request = PhonemizerRequest(
        singer=track.singer_obj,
        part=part,
        timestamp=timestamp,
        note_indexes=note_indexes,
        notes=groups,
        phonemizers=track_phonemizers,
        note_phonemizer_indices=note_phonemizer_indices,
        time_axis=project.time_axis.clone(),
        project=project,
        track=track,
    )

    if not options.skip_phonemizer:
        response = phonemize(request)
    else:
        response = None

    # ---- 3. 应用响应（UPart.cs 199–247）
    if response is not None:
        part.phonemes.clear()
        for note in part.notes:
            note.phonemizer_expressions.clear()

        from ..ustx.model import UExpression, UExpressionType

        for i in range(len(response.phonemes)):
            indexes: List[int] = []
            ni = response.note_indexes[i]
            note = part.notes[ni] if 0 <= ni < len(part.notes) else None
            for j in range(len(response.phonemes[i])):
                src = response.phonemes[i][j]
                phoneme = UPhoneme()
                phoneme.raw_position = src.position - part.position
                phoneme.raw_phoneme = src.phoneme
                phoneme.index = src.index if src.index is not None else j
                phoneme.parent = note
                phoneme.error_exception = src.error
                # 重复 index 直接丢弃（报错后 continue）
                if any(p.parent is phoneme.parent and p.index == phoneme.index
                       for p in part.phonemes):
                    logger.error('Duplicate phoneme index.')
                    continue
                part.phonemes.append(phoneme)
                indexes.append(phoneme.index)
                if src.expressions:
                    for exp in src.expressions:
                        descriptor = track.try_get_exp_descriptor(project, exp.abbr)
                        if descriptor is not None:
                            if (descriptor.type != UExpressionType.CURVE
                                    and descriptor.min <= exp.value <= descriptor.max):
                                note.phonemizer_expressions.append(UExpression(
                                    index=phoneme.index,
                                    abbr=descriptor.abbr,
                                    descriptor=descriptor,
                                    _value=exp.value))
            indexes.sort()
            if note is not None:
                note.phoneme_indexes = indexes

    # ---- 4. 覆写 / 夹紧 / 逐音素 Validate（UPart.cs 252–310）
    if not options.skip_phoneme:
        last_phoneme = None
        for phoneme in part.phonemes:
            phoneme.prev = last_phoneme
            phoneme.next = None
            if last_phoneme is not None:
                last_phoneme.next = phoneme
            last_phoneme = phoneme

        for note in part.notes:
            note.phoneme_overrides = [o for o in note.phoneme_overrides
                                      if not _is_empty_override(o)]

        for phoneme in part.phonemes:
            phoneme.position = phoneme.raw_position
            phoneme.phoneme = phoneme.raw_phoneme
            phoneme.preutter_delta = None
            phoneme.overlap_delta = None
            phoneme.attack_time_delta = None
            phoneme.release_time_delta = None
            note = phoneme.parent
            if note is None:
                continue
            o = next((o for o in note.phoneme_overrides if o.index == phoneme.index), None)
            if o is not None:
                phoneme.position += o.offset if o.offset is not None else 0
                phoneme.phoneme = (o.phoneme
                                   if (o.phoneme is not None and str(o.phoneme).strip())
                                   else phoneme.raw_phoneme)
                phoneme.preutter_delta = o.preutter_delta
                phoneme.overlap_delta = o.overlap_delta
                phoneme.attack_time_delta = o.attack_time_delta
                phoneme.release_time_delta = o.release_time_delta

        # 音素化器应按顺序返回；乱序告警一次（不静默修复）
        for i in range(len(part.phonemes) - 1):
            if part.phonemes[i].raw_position > part.phonemes[i + 1].raw_position:
                logger.warning(
                    'Out-of-order phonemes in part %s: %s at %s comes after %s at %s.',
                    getattr(part, 'name', ''), part.phonemes[i].raw_phoneme,
                    part.phonemes[i].raw_position, part.phonemes[i + 1].raw_phoneme,
                    part.phonemes[i + 1].raw_position)
                break

        # 安全夹紧：从后往前，保证相邻音素至少隔 10 tick
        for i in range(len(part.phonemes) - 2, -1, -1):
            part.phonemes[i].position = min(part.phonemes[i].position,
                                            part.phonemes[i + 1].position - 10)

        for phoneme in part.phonemes:
            note = phoneme.parent
            if note is None:
                continue
            phoneme.validate(options, project, track, part, note)

    return response

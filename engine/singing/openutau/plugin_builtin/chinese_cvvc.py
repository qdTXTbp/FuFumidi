# -*- coding: utf-8 -*-
"""中文 CVVC 音素化器 —— **照搬** `OpenUtau.Plugin.Builtin/ChineseCVVCPhonemizer.cs`（264 行）。

C# 声明：`[Phonemizer("Chinese CVVC Phonemizer", "ZH CVVC", language: "ZH")]`

与中文 VCV 的差别：VCV 只查 `尾韵母 + 本字` 的整串别名；CVVC 要把一个音节拆成
**VC（前字尾韵母 + 本字声母）** 与 **CV（本字）** 两个音素，并靠 `presamp.ini` 里的
`[VOWEL]` / `[CONSONANT]` / `[REPLACE]` 三张表把歌词映射到声库的别名体系。

## 照搬时保留的语义（别"整理"掉）
1. `replace` 是**精确整串替换**（`pair.Key == lyric`），命中的话会**接着参与后面所有查表**
   —— 注意它改的是 `lyric`，而 `consonant` 是拿**替换后**的 `lyric` 再去 `consonants` 里查。
2. `consonant = consonants.get(lyric, lyric)`：查不到就用歌词本身当声母候选。
3. `prevVowel` 默认是字面量 `"-"`（不是空串），且只在**前邻歌词**能在 `vowels` 里查到
   时才替换。
4. `lyric == "-"` 或 `lyric.lower() == "r"` 是**独立提前返回**的分支：只产出一个
   `{prevVowel} R` 音素（查不到 oto 就返回这个名字本身）。
5. **同一段里 `toneShift`/`voiceColor` 的回落是"逐处调用"的轨道默认值**
   （`attrN.toneShift ?? GetParentToneShift()`）—— 这里按 attr 预计算，
   因为 `GetParentToneShift()` 对固定的 project/track 是纯函数，等价且更清楚。
6. ★ 查 VC 音素时，前邻存在时用的是 **前一个音符的 tone**（`prevNeighbour.Value.tone`），
   不是当前音符的 —— 这是 C# 原文，别"修正"成当前音。
7. `vcLen` 的三种算法与顺序：
   - 初值 120；
   - 若命中的 CV oto 有 `Preutter`：`vcLen = -ms_to_tick_at(-Preutter, endTick)`；
     `Overlap == 0 && vcLen < 120` 时 `min(120, vcLen*2)`；`Overlap < 0` 时
     改用 `-(Preutter - Overlap)` 重算（**覆盖**前一步，包括那个翻倍）。
   - 有前邻：`vcLen = Convert.ToInt32(min(prevDuration/1.5, max(30, vcLen*ratio)))`；
     无前邻：`vcLen = Convert.ToInt32(min(vcLen*2,     max(30, vcLen*ratio)))`。
     `ratio` 是 `attr1.consonantStretchRatio ?? GetParentConsonantStretchRatio()`。
     ★ `Convert.ToInt32(double)` 是**四舍六入五成双**（不是截断），Python 的 `round()`
     正好同语义 —— 用 `int(round(x))`，别写成 `int(x)`。
8. 句末（无后续邻居）会尝试追加 `{currVowel} R`，位置 `total - min(total/6, 60)`。
9. `SetUp` **会**调 `base.SetUp`（与中文 VCV 相反），所以 project/track 有值、
   轨道默认值也就能生效。

## 与 C# 的等价性差异
- `presamp.ini` 的读取走 `classic/ini.py`（同一份 `Ini.ReadBlocks`）。
  找不到文件 / 缺段 / 编码异常一律**吞掉并保持已解析的部分**（C# 也是 catch 住继续）——
  所以"缺 `[CONSONANT]` 段"会导致 `vowels` 有值而 `consonants` 为空，行为与 C# 一致。
- `Ini` 里那几个 `blocks.Find(...)`（`PRIORITY` / `ALIAS`）在 C# 里因为**少了方括号**
  而恒为 null（且结果未被使用），这里照搬成同样取不到，不"修正"。
"""

import os
from typing import List

from ..base_chinese import BaseChinesePhonemizer
from ..phonemizer import Note, Phoneme, PhonemeAttributes, Phonemizer, Result, register
from ..classic.ini import Ini

#: `Ini.ReadBlocks` 用的段头正则（对应 C# 的 `@"\[\w+\]"`）
HEADER_PATTERN = r'\[\w+\]'


@register
class ChineseCVVCPhonemizer(Phonemizer):
    """对应 `ChineseCVVCPhonemizer`。"""

    name = 'Chinese CVVC Phonemizer'
    tag = 'ZH CVVC'
    language = 'ZH'

    def __init__(self):
        super().__init__()
        self.vowels = {}
        self.consonants = {}
        self.replace = {}
        self.singer = None

    # ------------------------------------------------------------------ 歌手

    def set_singer(self, singer) -> None:
        """对应 `SetSinger`：同一个歌手直接返回；否则清表后从 `presamp.ini` 重载。

        ★ 注意 `if (this.singer == singer) return;` 在**清表之前** ——
        换回同一个歌手时表是保留的（不是清空重载）。照搬。
        """
        if self.singer is singer:
            return
        self.singer = singer
        self.vowels.clear()
        self.consonants.clear()
        self.replace.clear()
        if self.singer is None:
            return
        try:
            self._load_presamp_ini(singer)
        except Exception:
            # C# 只记日志、不抛；此处保持"已解析的部分"留在表里
            pass

    def _load_presamp_ini(self, singer) -> None:
        path = os.path.join(singer.location, 'presamp.ini')
        encoding = singer.text_file_encoding or 'utf-8'
        blocks = Ini.read_blocks_of(path, HEADER_PATTERN, encoding=encoding)

        vowel_block = Ini.find_block(blocks, '[VOWEL]')
        for ini_line in vowel_block.lines:
            parts = ini_line.line.split('=')
            if len(parts) >= 3:
                vowel_lower = parts[0]
                for sound in parts[2].split(','):
                    self.vowels[sound] = vowel_lower

        consonant_block = Ini.find_block(blocks, '[CONSONANT]')
        for ini_line in consonant_block.lines:
            parts = ini_line.line.split('=')
            if len(parts) >= 3:
                consonant = parts[0]
                for sound in parts[1].split(','):
                    self.consonants[sound] = consonant

        # C# 这两个 Find 的字符串**少了方括号**，恒为 null（且结果未被使用）——照搬
        Ini.find_block(blocks, 'PRIORITY')
        replace_block = Ini.find_block(blocks, '[REPLACE]')
        for ini_line in replace_block.lines:
            parts = ini_line.line.split('=')
            self.replace[parts[0]] = parts[1]

        Ini.find_block(blocks, 'ALIAS')

    # ------------------------------------------------------------------ 音素化

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prev_neighbours=None) -> Result:
        note = notes[0]
        lyric = note.lyric or ''

        # replace 是精确整串替换，且替换结果参与后面所有查表
        for key, value in self.replace.items():
            if key == lyric:
                lyric = value

        consonant = self.consonants.get(lyric, lyric)

        prev_vowel = '-'
        if prev_neighbour is not None:
            vowel = self.vowels.get(prev_neighbour.lyric)
            if vowel is not None:
                prev_vowel = vowel

        attr0 = self._attr(note, 0)
        attr1 = self._attr(note, 1)
        attr2 = self._attr(note, 2)
        t0 = note.tone + (attr0.tone_shift if attr0.tone_shift is not None
                          else self.get_parent_tone_shift())
        c0 = attr0.voice_color if attr0.voice_color is not None else self.get_parent_voice_color()
        t1 = note.tone + (attr1.tone_shift if attr1.tone_shift is not None
                          else self.get_parent_tone_shift())
        c1 = attr1.voice_color if attr1.voice_color is not None else self.get_parent_voice_color()
        t2 = note.tone + (attr2.tone_shift if attr2.tone_shift is not None
                          else self.get_parent_tone_shift())
        c2 = attr2.voice_color if attr2.voice_color is not None else self.get_parent_voice_color()

        # 单独成段的尾韵行：只产出 "{prevVowel} R"
        if lyric == '-' or lyric.lower() == 'r':
            oto1 = self.singer.try_get_mapped_oto('%s R' % prev_vowel, t0, c0)
            if oto1 is not None:
                return self.make_simple_result(oto1.alias)
            return self.make_simple_result('%s R' % prev_vowel)

        curr_vowel = self.vowels.get(lyric, lyric)
        total_duration = sum(n.duration for n in notes)

        oto = self.singer.try_get_mapped_oto('%s %s' % (prev_vowel, lyric), t0, c0)
        if oto is not None:
            if next_neighbour is None:
                oto1 = self.singer.try_get_mapped_oto('%s R' % curr_vowel, t1, c1)
                if oto1 is not None:
                    # 自动补尾韵
                    return Result(phonemes=[
                        Phoneme(phoneme=oto.alias),
                        Phoneme(phoneme=oto1.alias,
                                position=total_duration - min(total_duration // 6, 60)),
                    ])
            return self.make_simple_result(oto.alias)

        vc_len = 120
        end_tick = notes[-1].position + notes[-1].duration
        cv_oto = self.singer.try_get_mapped_oto(lyric, t1, c1)
        if cv_oto is not None:
            vc_len = -self.time_axis.ms_to_tick_at(-cv_oto.preutter, end_tick)
            if cv_oto.overlap == 0 and vc_len < 120:
                vc_len = min(120, vc_len * 2)      # 短 preutter 的爆破音
            if cv_oto.overlap < 0:
                vc_len = -self.time_axis.ms_to_tick_at(
                    -(cv_oto.preutter - cv_oto.overlap), end_tick)

        cv_oto_simple = self.singer.try_get_mapped_oto(lyric, t0, c0)
        if cv_oto_simple is not None:
            lyric = cv_oto_simple.alias

        vc_phoneme = '%s %s' % (prev_vowel, consonant)
        if prev_neighbour is not None:
            # ★ 用的是**前一个音符**的 tone
            vt = prev_neighbour.tone + (attr0.tone_shift if attr0.tone_shift is not None
                                        else self.get_parent_tone_shift())
            vc_hit = self.singer.try_get_mapped_oto(vc_phoneme, vt, c0)
            if vc_hit is not None:
                vc_phoneme = vc_hit.alias
            prev_duration = notes[0].position - prev_neighbour.position
            ratio = (attr1.consonant_stretch_ratio if attr1.consonant_stretch_ratio is not None
                     else self.get_parent_consonant_stretch_ratio())
            vc_len = _to_int32(min(prev_duration / 1.5, max(30, vc_len * ratio)))
        else:
            vc_hit = self.singer.try_get_mapped_oto(vc_phoneme, t0, c0)
            if vc_hit is not None:
                vc_phoneme = vc_hit.alias
            ratio = (attr1.consonant_stretch_ratio if attr1.consonant_stretch_ratio is not None
                     else self.get_parent_consonant_stretch_ratio())
            vc_len = _to_int32(min(vc_len * 2, max(30, vc_len * ratio)))

        if next_neighbour is None:      # 自动补尾韵
            oto0 = self.singer.try_get_mapped_oto('%s %s' % (prev_vowel, lyric), t0, c0)
            if oto0 is not None:
                oto_end = self.singer.try_get_mapped_oto('%s R' % curr_vowel, t1, c1)
                if oto_end is not None:
                    return Result(phonemes=[
                        Phoneme(phoneme=oto0.alias),
                        Phoneme(phoneme=oto_end.alias,
                                position=total_duration - min(total_duration // 6, 60)),
                    ])
            else:
                # 用 VC（若存在）
                if prev_neighbour is None:
                    vc_oto1 = self.singer.try_get_mapped_oto(vc_phoneme, t0, c0)
                else:
                    vc_oto1 = None
                if vc_oto1 is None and prev_neighbour is not None:
                    vt = prev_neighbour.tone + (attr0.tone_shift if attr0.tone_shift is not None
                                                else self.get_parent_tone_shift())
                    vc_oto1 = self.singer.try_get_mapped_oto(vc_phoneme, vt, c0)
                if vc_oto1 is not None:
                    vc_phoneme = vc_oto1.alias
                    oto_end = self.singer.try_get_mapped_oto('%s R' % curr_vowel, t2, c2)
                    if oto_end is not None:
                        return Result(phonemes=[
                            Phoneme(phoneme=vc_phoneme, position=-vc_len),
                            Phoneme(phoneme=cv_oto.alias if cv_oto is not None else lyric),
                            Phoneme(phoneme=oto_end.alias,
                                    position=total_duration - min(total_duration // 6, 60)),
                        ])
                # 只有基音 + 尾韵
                oto_end1 = self.singer.try_get_mapped_oto('%s R' % curr_vowel, t1, c1)
                if oto_end1 is not None:
                    return Result(phonemes=[
                        Phoneme(phoneme=(cv_oto_simple.alias if cv_oto_simple is not None
                                         else lyric)),
                        Phoneme(phoneme=oto_end1.alias,
                                position=total_duration - min(total_duration // 6, 60)),
                    ])

        oto = self.singer.try_get_mapped_oto(vc_phoneme, t0, c0)
        if oto is not None:
            return Result(phonemes=[
                Phoneme(phoneme=vc_phoneme, position=-vc_len),
                Phoneme(phoneme=cv_oto.alias if cv_oto is not None else lyric),
            ])
        return self.make_simple_result(cv_oto_simple.alias if cv_oto_simple is not None else lyric)

    # ------------------------------------------------------------------ 辅助

    @staticmethod
    def _attr(note: Note, index: int):
        return next((a for a in (note.phoneme_attributes or []) if a.index == index),
                    _DEFAULT_ATTR)

    # ---- Romanize / RomanizeNotes / ChangeLyric（C# 在本地又抄了一份，这里同样保留）

    @staticmethod
    def change_lyric(group: List[Note], lyric: str) -> List[Note]:
        """对应本文件里的 `ChangeLyric`（与 `BaseChinesePhonemizer` 的那份逐字相同）。"""
        return BaseChinesePhonemizer.change_lyric(group, lyric)

    def romanize(self, lyrics) -> List[str]:
        """对应 `protected virtual string[] Romanize`（子类可覆盖）。"""
        return BaseChinesePhonemizer.romanize(lyrics)

    def romanize_notes(self, groups) -> List[List[Note]]:
        """对应 `RomanizeNotes`。"""
        result_lyrics = self.romanize([g[0].lyric for g in groups])
        for group, lyric in zip(groups, result_lyrics):
            self.change_lyric(group, lyric)
        return groups

    def set_up(self, notes, project, track) -> None:
        """★ 这里**会**调 `base.SetUp`（与中文 VCV 相反）。"""
        super().set_up(notes, project, track)
        self.romanize_notes(notes)


#: 对应 C# 的 `?? default`。
#: ★ C# 里 `PhonemeAttributes` 是 **struct**，所以 `default` 是"字段全空"的实例
#: （若是 class，`attr0.toneShift` 就会 NRE —— 而"没有 phonemeAttributes"恰恰是最常见的情况）。
#: 我们的 dataclass 默认值正好也是全 None，直接复用即可，语义与 struct default 一致。
_DEFAULT_ATTR = PhonemeAttributes()


def _to_int32(v) -> int:
    """对应 C# 的 `Convert.ToInt32(double)`：**四舍六入五成双**，不是截断。

    Python 的 `round()` 与 C# 的 `Convert.ToInt32` 同为 banker's rounding，故直接可用；
    但如果写成 `int(v)` 就会变成截断 —— 在 `.5` 附近会差 1，进而改变 VC 音素的重叠长度。
    """
    return int(round(v))

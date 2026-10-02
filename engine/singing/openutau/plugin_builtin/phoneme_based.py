# -*- coding: utf-8 -*-
r"""音素驱动的音素化器基类 —— **照搬**
`OpenUtau.Plugin.Builtin/PhonemeBasedPhonemizer.cs`（226 行）。

与 `SyllableBasedPhonemizer` 那条线的区别：这条线**以"音素序列"为单位**做事 ——
先把歌词查成符号串（G2P），再把符号串均匀铺到音符时长上（`DistributeDuration`），
最后逐个符号换成声库别名（`GetPhonemeOrFallback`，由子类实现）。
`MonophonePhonemizer` / `LatinDiphonePhonemizer` 都继承它。

## 照搬时保留的语义（别"整理"掉）
1. 构造函数里 `Initialize()` 包在 `try/catch` 里 —— **`LoadG2p()` 抛错不会让构造失败**，
   `g2p` 就停在 `None`，之后 `Process` 里用它会抛。照搬（不改"更健壮"）。
2. `SetSinger` 会**重新** `LoadG2p()`（因为声库自带的词典可能不同）。
3. `?` 前缀 = **强制别名**：`"?abc"` → 直接产出 `"abc"`，不走任何查表。
4. `note.lyric == "-"` 且前邻存在 → 试 `"{前邻末符号} -"`。
5. `addTail`（默认 **true**，`MonophonePhonemizer` 里改成 false）在**没有下一邻居**时
   给符号串**追加一个 `"-"`**。
6. 对齐（`alignments`）的构造顺序：
   - 先按"每个元音对齐到一个非延音音符"添加（`position` 是该音符相对首音符的 tick）；
     ★ 消音（glide）特殊处理：`i >= 2 && isGlide[i-1] && !isVowel[i-2]` 时对齐到 **i-1**。
   - 再按 `"+n"` 歌词手动对齐（`int.TryParse(lyric.Substring(1))` → 下标 n-1）。
   - 最后加一个 `(phonemes.Length, position, true)` 收尾。
   - 按第 1 个分量**排序**，然后把**手动**对齐项与相邻"时间不递增或下标相同"的项互删。
   - ★ `Array.IndexOf(isVowel, true)` 找不到时返回 **-1**，于是
     `startTick = -ConsonantLength * -1 = +ConsonantLength`（正数！）—— 照搬这个 quirk。
7. `DistributeDuration` 的整数除法：有元音时辅音固定长（且合计不超过一半时长），
   元音平分剩余；**没有元音时**辅音平分总时长（此时 `consonants` 必 > 0，
   因为 `startIndex == endIndex` 已经早退）。
8. `GetSymbols`：无 `phoneticHint` 时查 G2P（**歌词小写化**）；有 hint 时按空白切分并
   **丢掉无效符号**。
9. `IG2pSymbols.GetSymbols` 只是内部 `GetSymbols` 的公开包装。

## 与 C# 的载体差异
- `List.Sort(comparison)` 在 C# 是**不稳定**的 introsort。这里用 Python 的稳定 `sorted`。
  对本题的对齐表（通常 < 16 项）C# 实际走插入排序，**是稳定的**，所以两者一致；
  但这是"巧合一致"，已在注释里记明。
- `int.TryParse` → 用正则 `^-?\d+$` 复刻（C# 接受可选负号与前导空白，这里按实际用法收紧）。
"""

import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..g2p import IG2p, IG2pSymbols
from ..phonemizer import Note, Phoneme, Phonemizer, Result

#: C# 的 `int.TryParse`：可选正负号 + 纯数字（实际用法里只出现正整数）
_INT_RE = re.compile(r'^[+-]?\d+$')


class PhonemeBasedPhonemizer(Phonemizer, IG2pSymbols):
    """对应 `PhonemeBasedPhonemizer`。子类要实现 `load_g2p` / `load_vowel_fallbacks` /
    `get_phoneme_or_fallback`。"""

    def __init__(self):
        super().__init__()
        #: 对应 `protected Dictionary<string, string[]> vowelFallback;`
        self.vowel_fallback: Dict[str, List[str]] = {}
        #: 对应 `protected USinger singer;`
        self.singer = None
        #: 对应 `protected IG2p g2p;`
        self.g2p: Optional[IG2p] = None
        #: 对应 `protected bool isDictionaryLoading;`
        self.is_dictionary_loading = False
        #: 对应 `protected readonly List<Tuple<int,int,bool>> alignments`
        self.alignments: List[Tuple[int, int, bool]] = []
        #: 对应 `public int ConsonantLength { get; set; } = 60;`
        self.consonant_length = 60
        #: 对应 `public bool addTail { get; set; } = true;`
        self.add_tail = True
        try:
            self.initialize()
        except Exception:
            # ★ 照搬：初始化失败**不让构造失败**，g2p 停在 None
            import logging
            logging.getLogger(__name__).error('Failed to initialize.')

    # ------------------------------------------------------------------ 子类钩子

    def load_g2p(self) -> IG2p:
        raise NotImplementedError

    def load_vowel_fallbacks(self) -> Dict[str, List[str]]:
        raise NotImplementedError

    def get_phoneme_or_fallback(self, prev_symbol: str, symbol: str, tone: int,
                                color: str, alt: str) -> str:
        raise NotImplementedError

    # ------------------------------------------------------------------ 生命周期

    def initialize(self) -> None:
        """对应 `Initialize`：加载 G2P 与元音回落表。"""
        self.g2p = self.load_g2p()
        self.vowel_fallback = self.load_vowel_fallbacks()

    def set_singer(self, singer) -> None:
        """对应 `SetSinger`：换歌手后**重新**加载 G2P。"""
        self.singer = singer
        self.g2p = self.load_g2p()

    # ------------------------------------------------------------------ 主流程

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prev_neighbours=None) -> Result:
        if self.is_dictionary_loading:
            return self.make_simple_result('')
        note = notes[0]

        # `?` 前缀 = 强制别名
        if note.lyric and note.lyric[0] == '?':
            return self.make_simple_result(note.lyric[1:])

        # 前一个音符的符号（没有前邻就是 None）
        prev_symbols = None if prev_neighbour is None else self._get_symbols(prev_neighbour)

        # 用户用 "-" 音符来生成 "<某音> -" 的收尾音
        if note.lyric == '-' and prev_symbols is not None:
            attr = self._first_attr(note)
            color = (attr.voice_color if attr.voice_color is not None
                     else self.get_parent_voice_color())
            alias = '%s -' % prev_symbols[-1]
            oto = self.mapped_oto(alias, note.tone, color)
            if oto is not None:
                return self.make_simple_result(oto.alias)
            return self.make_simple_result(alias)

        symbols = self._get_symbols(note)
        if self.add_tail and next_neighbour is None and symbols is not None:
            symbols = list(symbols) + ['-']
        if not symbols:
            # 没查到符号 —— 否则就当作"用户直接填了别名"
            return self.make_simple_result(note.lyric)

        is_vowel = [self.g2p.is_vowel(s) for s in symbols]
        is_glide = [self.g2p.is_glide(s) for s in symbols]
        phonemes = [Phoneme() for _ in symbols]

        # ---- 对齐
        self.alignments.clear()
        non_extension_notes = [n for n in notes if not self.is_syllable_vowel_extension_note(n)]
        for i in range(len(symbols)):
            if is_vowel[i] and len(self.alignments) < len(non_extension_notes):
                # 消音（glide）落在音符起点**之后**，所以 "辅音-消音-元音" 要对齐到消音那一格
                if i >= 2 and is_glide[i - 1] and not is_vowel[i - 2]:
                    self.alignments.append((
                        i - 1,
                        non_extension_notes[len(self.alignments)].position - notes[0].position,
                        False))
                else:
                    self.alignments.append((
                        i,
                        non_extension_notes[len(self.alignments)].position - notes[0].position,
                        False))
        position = notes[0].duration
        for i in range(1, len(notes)):
            tail = notes[i].lyric[1:] if len(notes[i].lyric) >= 1 else ''
            if _INT_RE.match(tail):
                self.alignments.append((int(tail) - 1, position, True))
            position += notes[i].duration
        self.alignments.append((len(phonemes), position, True))
        # ★ C# 的 `List.Sort` 不稳定；但对齐表通常 < 16 项（走插入排序，稳定），
        #   所以这里用稳定排序是等价的。已记档为"巧合一致"。
        self.alignments.sort(key=lambda a: a[0])
        i = 0
        while i < len(self.alignments):
            if self.alignments[i][2]:       # 手动项
                while i > 0 and (self.alignments[i - 1][1] >= self.alignments[i][1]
                                 or self.alignments[i - 1][0] == self.alignments[i][0]):
                    self.alignments.pop(i - 1)
                    i -= 1
                while (i < len(self.alignments) - 1
                       and (self.alignments[i + 1][1] <= self.alignments[i][1]
                            or self.alignments[i + 1][0] == self.alignments[i][0])):
                    self.alignments.pop(i + 1)
            i += 1

        # ---- 按对齐点分配时长
        start_index = 0
        first_vowel = is_vowel.index(True) if True in is_vowel else -1
        # ★ C# 的 `Array.IndexOf` 找不到返回 -1 → startTick 变成**正数**。照搬这个 quirk。
        start_tick = -self.consonant_length * first_vowel
        for alignment in self.alignments:
            self._distribute_duration(is_vowel, phonemes, start_index, alignment[0],
                                      start_tick, alignment[1])
            start_index = alignment[0]
            start_tick = alignment[1]
        self.alignments.clear()

        # ---- 选别名
        note_index = 0
        prev_symbol = '-' if prev_symbols is None else prev_symbols[-1]
        for i in range(len(symbols)):
            attr = self._attr(note, i)
            alt_obj = (attr.alternate if attr.alternate is not None
                       else self.get_parent_alternate())
            alt = str(alt_obj) if alt_obj is not None else ''
            color = (attr.voice_color if attr.voice_color is not None
                     else self.get_parent_voice_color())
            tone_shift = (attr.tone_shift if attr.tone_shift is not None
                          else self.get_parent_tone_shift())
            phoneme = phonemes[i]
            while (note_index < len(notes) - 1
                   and notes[note_index].position - note.position < phoneme.position):
                note_index += 1
            if i == 0 and prev_neighbours:
                tone = prev_neighbours[-1].tone
            else:
                tone = notes[note_index].tone
            phoneme.phoneme = self.get_phoneme_or_fallback(
                prev_symbol, symbols[i], tone + tone_shift, color, alt)
            phonemes[i] = phoneme
            prev_symbol = symbols[i]

        return Result(phonemes=phonemes)

    # ------------------------------------------------------------------ 辅助

    @staticmethod
    def is_syllable_vowel_extension_note(note: Note) -> bool:
        """对应 `IsSyllableVowelExtensionNote`：歌词以 `+~` / `+*` 开头。"""
        return note.lyric.startswith('+~') or note.lyric.startswith('+*')

    def _get_symbols(self, note: Note) -> Optional[List[str]]:
        """对应 `GetSymbols`（内部那份）。"""
        if not note.phonetic_hint:
            return self.g2p.query((note.lyric or '').lower())
        return [s for s in note.phonetic_hint.split() if self.g2p.is_valid_symbol(s)]

    def get_symbols(self, note: Note) -> List[str]:
        """对应 `IG2pSymbols.GetSymbols`（公开包装，供内部插件访问）。"""
        return self._get_symbols(note)

    @staticmethod
    def _attr(note: Note, index: int):
        from .chinese_cvvc import _DEFAULT_ATTR
        return next((a for a in (note.phoneme_attributes or []) if a.index == index),
                    _DEFAULT_ATTR)

    @staticmethod
    def _first_attr(note: Note):
        from .chinese_cvvc import _DEFAULT_ATTR
        attrs = note.phoneme_attributes or []
        return attrs[0] if attrs else _DEFAULT_ATTR

    def _distribute_duration(self, is_vowel: Sequence[bool], phonemes: List[Phoneme],
                             start_index: int, end_index: int,
                             start_tick: int, end_tick: int) -> None:
        """对应 `DistributeDuration`。**整数除法**（C# 两边都是 int）。"""
        if start_index == end_index:
            return
        consonants = 0
        vowels = 0
        duration = end_tick - start_tick
        for i in range(start_index, end_index):
            if is_vowel[i]:
                vowels += 1
            else:
                consonants += 1
        # 有元音时辅音给固定长（合计不超过一半时长）；没有元音时辅音平分总时长
        if vowels > 0:
            consonant_duration = (min(self.consonant_length, duration // 2 // consonants)
                                  if consonants > 0 else 0)
        else:
            consonant_duration = duration // consonants
        vowel_duration = ((duration - consonant_duration * consonants) // vowels
                          if vowels > 0 else 0)
        position = start_tick
        for i in range(start_index, end_index):
            if is_vowel[i]:
                phonemes[i].position = position
                position += vowel_duration
            else:
                phonemes[i].position = position
                position += consonant_duration

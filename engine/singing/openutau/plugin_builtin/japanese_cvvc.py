# -*- coding: utf-8 -*-
"""Japanese CVVC 音素化器（legacy）—— **照搬**
`OpenUtau.Plugin.Builtin/JapaneseCVVCPhonemizer.cs`（298 行）。

C# 声明：`[Phonemizer("Japanese CVVC Phonemizer (legacy)", "JA CVVC", "TUBS", language: "JA")]`

与 JA VCV 的区别：VCV 只查"整串别名"（`a な`），CVVC 还要在**下一个音符之前插一个 VC 音素**
（「本音符的元音 + 下一音符的声母」，如 `a k`），并把它的 `position` 提前到
`totalDuration - vcLength`。

C# 里原作者留了一句注释：`// can probably be cleaned up more but i have work in the morning.
have fun.` —— 这句照搬进注释，提醒后人**别顺手重构**：那一串分支的**顺序与重复**
（尤其两处相同的"只返回 currentLyric"早退）都是现有行为的一部分。

## 照搬时保留的语义（别"整理"掉）
1. **三张表的键值方向不一样**：`vowels` / `consonants` 是 `代表=成员,...`
   （键取**成员**、值取**代表**）；而 `substitution` 是 `原名,...=替代`
   （键取**原名**、值取**替代**）。照抄时很容易把方向搞反。
2. `originalCurrentLyric` 在**任何 oto 替换之前**就存下来了 —— 后面查"本音符元音"
   用的是它，而不是被替换成别名的 `currentLyric`。
3. `cfLyric`（`* {lyric}`）用的是**已被 phoneticHint 覆盖**的歌词。
4. `phoneticHint` 的分支**只试它自己**（不做 `-` 前缀、不做 `*` 前缀），
   命中就用别名、未命中就用 hint 原文（不回落到正常流程）。
5. `checkOtoUntilHit` 与 `checkOtoUntilHitVc` **失败语义相反**：
   前者"没有颜色匹配就取第一个"，后者"没有颜色匹配就**返回 false**"（不插入 VC）。
6. VC 的 `vcPhonemes` 是 `[主候选, 替代候选]`，替代候选**只有能在 `substitution` 里
   查到才填**（否则留空串 —— 空串会参与 `test + alt` 的 oto 查询，通常查不到，无碍）。
7. `vcLength`：先由**下一个音符**的 oto 决定（`Overlap < 0` 时用 `Preutter - Overlap`，
   否则用 `Preutter`，两者都过 `MsToTick`），再
   `Convert.ToInt32(min(totalDuration/2, vcLength * 拉伸比))` —— 注意 `totalDuration / 2`
   是**整数除法**，而 `Convert.ToInt32` 是**四舍六入五成双**。
8. 查下一音符的 oto 时用的是 `nextNeighbour` 的属性（attr index **0**）与
   `nextNeighbour.tone`，**不是**当前音符的。
9. `plainVowels` 含 `ん` 与 `ン` 两个（拨音大小写）；`nonVowels` 里 `R` / `-` / `息` / `吸`
   这些"非元音的伪音素"也被当成可以接 VC 的类别。
10. C# 的 `LastOrDefault().ToString() ?? string.Empty` 其实**永远不会**拿到空串
    （空序列的 `LastOrDefault()` 是 `char` 的 `'\0'`，`ToString()` 给 `"\0"`）。
    这里按"空串 → 查不到"处理 —— 结果相同（表里没有 `"\0"`），并在注释里记下这个 quirk。

## 与 C# 的载体差异
- `note.phoneticHint` → `note.phonetic_hint`、`note.phonemeAttributes` →
  `note.phoneme_attributes`、`attr.voiceColor` → `attr.voice_color` 等，纯命名。
- `MsToTick` 走基类的 `ms_to_tick`（需要宿主先 `set_timing`）。
"""

import unicodedata
from typing import Dict, List, Optional, Tuple

from ..phonemizer import Note, Phoneme, Phonemizer, Result, register
from ..oto import UOto

#: 单独成音节的元音（含拨音的大小写两种）
PLAIN_VOWELS = ('あ', 'い', 'う', 'え', 'お', 'を', 'ん', 'ン')

#: "非元音"类别 —— 这些歌词也允许在其后接 VC
NON_VOWELS = (
    '息', '吸', 'R', '-', 'k', 'ky', 'g', 'gy',
    's', 'sh', 'z', 'j', 't', 'ch', 'ty', 'ts',
    'd', 'dy', 'n', 'ny', 'h', 'hy', 'f', 'b',
    'by', 'p', 'py', 'm', 'my', 'y', 'r', '4',
    'ry', 'w', 'v', 'ng', 'l', '・', 'B', 'H',
)

#: 假名 → 元音。格式 `元音=假名,...`（**键取成员、值取代表**）
VOWELS = (
    'a=ぁ,あ,か,が,さ,ざ,た,だ,な,は,ば,ぱ,ま,ゃ,や,ら,わ,ァ,ア,カ,ガ,サ,ザ,タ,ダ,ナ,ハ,バ,パ,マ,ャ,ヤ,ラ,ワ',
    'e=ぇ,え,け,げ,せ,ぜ,て,で,ね,へ,べ,ぺ,め,れ,ゑ,ェ,エ,ケ,ゲ,セ,ゼ,テ,デ,ネ,ヘ,ベ,ペ,メ,レ,ヱ',
    'i=ぃ,い,き,ぎ,し,じ,ち,ぢ,に,ひ,び,ぴ,み,り,ゐ,ィ,イ,キ,ギ,シ,ジ,チ,ヂ,ニ,ヒ,ビ,ピ,ミ,リ,ヰ',
    'o=ぉ,お,こ,ご,そ,ぞ,と,ど,の,ほ,ぼ,ぽ,も,ょ,よ,ろ,を,ォ,オ,コ,ゴ,ソ,ゾ,ト,ド,ノ,ホ,ボ,ポ,モ,ョ,ヨ,ロ,ヲ',
    'n=ん',
    'u=ぅ,う,く,ぐ,す,ず,つ,づ,ぬ,ふ,ぶ,ぷ,む,ゅ,ゆ,る,ゥ,ウ,ク,グ,ス,ズ,ツ,ヅ,ヌ,フ,ブ,プ,ム,ュ,ユ,ル,ヴ',
    'N=ン',
    '・=・',
)

#: 假名/假名串 → 声母。格式同上
CONSONANTS = (
    'ch=ち,ちぇ,ちゃ,ちゅ,ちょ',
    'gy=ぎ,ぎぇ,ぎゃ,ぎゅ,ぎょ',
    'ts=つ,つぁ,つぃ,つぇ,つぉ',
    'ty=てぃ,てぇ,てゃ,てゅ,てょ',
    'py=ぴ,ぴぇ,ぴゃ,ぴゅ,ぴょ',
    'ry=り,りぇ,りゃ,りゅ,りょ',
    'ly=リ,リェ,リャ,リュ,リョ',
    'ny=に,にぇ,にゃ,にゅ,にょ',
    'r=ら,る,るぃ,れ,ろ',
    'hy=ひ,ひぇ,ひゃ,ひゅ,ひょ',
    'dy=でぃ,でぇ,でゃ,でゅ,でょ',
    'by=び,びぇ,びゃ,びゅ,びょ',
    'b=ば,ぶ,ぶぃ,べ,ぼ',
    'd=だ,で,ど,どぃ,どぅ',
    'g=が,ぐ,ぐぃ,げ,ご',
    'f=ふ,ふぁ,ふぃ,ふぇ,ふぉ',
    'h=は,はぃ,へ,ほ,ほぅ',
    'k=か,く,くぃ,け,こ',
    'j=じ,じぇ,じゃ,じゅ,じょ,ぢ,ぢぇ,ぢゃ,ぢゅ,ぢょ',
    'm=ま,む,むぃ,め,も',
    'n=な,ぬ,ぬぃ,ね,の',
    'p=ぱ,ぷ,ぷぃ,ぺ,ぽ',
    's=さ,す,すぃ,せ,そ',
    'sh=し,しぇ,しゃ,しゅ,しょ',
    't=た,て,と,とぃ,とぅ',
    'v=ヴ,ヴぁ,ヴぃ,ヴぅ,ヴぇ,ヴぉ',
    'ky=き,きぇ,きゃ,きゅ,きょ',
    'w=うぃ,うぅ,うぇ,うぉ,わ,ゐ,ゑ,を,ヰ,ヱ',
    'y=いぃ,いぇ,や,ゆ,よ',
    'z=ざ,ず,ずぃ,ぜ,ぞ',
    'dz=づ,づぃ',
    'my=み,みぇ,みゃ,みゅ,みょ',
    'ng=ガ,ギ,グ,ゲ,ゴ,ギェ,ギャ,ギュ,ギョ,カ゜,キ゜,ク゜,ケ゜,コ゜,キ゜ェ,キ゜ャ,キ゜ュ,キ゜ョ',
    'l=ラ,ル,レ,ロ',
    '・=・あ,・い,・う,・え,・お,・ん,・を,・ン',
)

#: 声库缺某些符号时的替代方案。格式 `原名,...=替代`（**键取原名、值取替代** —— 方向与前两张相反）
SUBSTITUTION = (
    'ty,ch,ts=t', 'j,dy=d', 'gy=g', 'ky=k', 'py=p', 'ny=n', 'ry=r', 'my=m',
    'hy,f=h', 'by,v=b', 'dz=z', 'l=r', 'ly=l',
)


def _build_member_lookup(table) -> Dict[str, str]:
    """`代表=成员,...` → `{成员: 代表}`（重复键抛错，不静默覆盖）。"""
    lookup: Dict[str, str] = {}
    for line in table:
        parts = line.split('=')
        head = parts[0]
        for member in parts[1].split(','):
            if member in lookup:
                raise ValueError('表里有重复键: %r' % member)
            lookup[member] = head
    return lookup


def _build_substitute_lookup(table) -> Dict[str, str]:
    """`原名,...=替代` → `{原名: 替代}`（方向与上面相反）。"""
    lookup: Dict[str, str] = {}
    for line in table:
        parts = line.split('=')
        target = parts[1]
        for orig in parts[0].split(','):
            if orig in lookup:
                raise ValueError('替代表里有重复键: %r' % orig)
            lookup[orig] = target
    return lookup


VOWEL_LOOKUP = _build_member_lookup(VOWELS)
CONSONANT_LOOKUP = _build_member_lookup(CONSONANTS)
SUBSTITUTE_LOOKUP = _build_substitute_lookup(SUBSTITUTION)


@register
class JapaneseCVVCPhonemizer(Phonemizer):
    """对应 `JapaneseCVVCPhonemizer`。"""

    name = 'Japanese CVVC Phonemizer (legacy)'
    tag = 'JA CVVC'
    author = 'TUBS'
    language = 'JA'

    def __init__(self):
        super().__init__()
        self.singer = None

    def set_singer(self, singer) -> None:
        """对应 `SetSinger`：只是把歌手存起来。"""
        self.singer = singer

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prev_neighbours=None) -> Result:
        note = notes[0]
        current_lyric = unicodedata.normalize('NFC', note.lyric or '')
        if note.phonetic_hint:
            current_lyric = unicodedata.normalize('NFC', note.phonetic_hint)
        # ★ 在任何 oto 替换**之前**存下来（后面查"本音符元音"用的是它）
        original_current_lyric = current_lyric
        cf_lyric = '* %s' % current_lyric

        if note.phonetic_hint:
            # 只试 hint 自己；命中用别名、未命中就用 hint 原文（不回落正常流程）
            hit, oto = self._check_oto_until_hit([current_lyric], note)
            if hit:
                current_lyric = oto.alias
        elif prev_neighbour is None:
            # 先试 "- XX"（若声库有），再试裸歌词
            initial = '- %s' % current_lyric
            hit, oto = self._check_oto_until_hit([initial, current_lyric], note)
            if hit:
                current_lyric = oto.alias
        elif current_lyric in PLAIN_VOWELS or current_lyric in NON_VOWELS:
            prev_lyric = unicodedata.normalize('NFC', prev_neighbour.lyric or '')
            if prev_neighbour.phonetic_hint:
                prev_lyric = unicodedata.normalize('NFC', prev_neighbour.phonetic_hint)
            # 前邻的**末字符**决定本音符用什么元音接（VV）
            vow = VOWEL_LOOKUP.get(self._last_char(prev_lyric))
            if vow is not None:
                vow_lyric = '%s %s' % (vow, current_lyric)
                # 先试 vowLyric，再试 cfLyric，最后试裸歌词
                hit, oto = self._check_oto_until_hit(
                    [vow_lyric, cf_lyric, current_lyric], note)
                if hit:
                    current_lyric = oto.alias
        else:
            hit, oto = self._check_oto_until_hit([cf_lyric, current_lyric], note)
            if hit:
                current_lyric = oto.alias

        if next_neighbour is not None and not next_neighbour.phonetic_hint:
            next_lyric = unicodedata.normalize('NFC', next_neighbour.lyric or '')

            # 下一个音符是单字符"纯元音"→ 不需要 VC
            if len(next_lyric) == 1 and next_lyric in PLAIN_VOWELS:
                return self.make_simple_result(current_lyric)

            # 本音符的元音（用**未替换**的 originalCurrentLyric 的末字符查）
            vowel = VOWEL_LOOKUP.get(self._last_char(original_current_lyric), '')

            # 下一音符的声母：先按**首字符**查，再（长度 ≥ 2 时）按**前两个字符**查
            consonant = ''
            first = self._first_char(next_lyric)
            if first in CONSONANT_LOOKUP:
                consonant = CONSONANT_LOOKUP[first]
            elif len(next_lyric) >= 2 and next_lyric[:2] in CONSONANT_LOOKUP:
                consonant = CONSONANT_LOOKUP[next_lyric[:2]]

            if consonant == '':
                return self.make_simple_result(current_lyric)

            vc_phoneme = '%s %s' % (vowel, consonant)
            vc_phonemes = [vc_phoneme, '']
            # 找可能的替代符号（**只有查得到才填**，否则留空串）
            sub = SUBSTITUTE_LOOKUP.get(consonant)
            if sub is not None:
                vc_phonemes[1] = '%s %s' % (vowel, sub)
            # ★ 只调**一次**并解包：返回的是 `(found, oto)` 元组，
            #   而元组恒为真 —— 写成 `if self._check_oto_until_hit_vc(...):` 会永远成立，
            #   然后在 `oto1 is None` 上炸。这正是本模块自己踩过的坑。
            vc_hit, oto1 = self._check_oto_until_hit_vc(vc_phonemes, note)
            if vc_hit:
                vc_phoneme = oto1.alias
            else:
                return self.make_simple_result(current_lyric)

            total_duration = sum(n.duration for n in notes)
            vc_length = 120
            # ★ 用的是**下一个音符**的 tone 与它的 attr index 0
            next_attr = self._attr(next_neighbour, 0)
            next_tone = next_neighbour.tone + (
                next_attr.tone_shift if next_attr.tone_shift is not None
                else self.get_parent_tone_shift())
            next_color = (next_attr.voice_color if next_attr.voice_color is not None
                          else self.get_parent_voice_color())
            next_oto = self.mapped_oto(next_lyric, next_tone, next_color)
            if next_oto is not None:
                # Overlap 为负时，vcLength 比 Preutter 更长
                if next_oto.overlap < 0:
                    vc_length = self.ms_to_tick(next_oto.preutter - next_oto.overlap)
                else:
                    vc_length = self.ms_to_tick(next_oto.preutter)
            # vcLength 还取决于**下一个音符**的速度（VEL）
            ratio = (next_attr.consonant_stretch_ratio
                     if next_attr.consonant_stretch_ratio is not None
                     else self.get_parent_consonant_stretch_ratio())
            # `totalDuration / 2` 是整数除法；`Convert.ToInt32` 是四舍六入五成双
            vc_length = int(round(min(idiv(total_duration, 2), vc_length * ratio)))

            return Result(phonemes=[
                Phoneme(phoneme=current_lyric),
                Phoneme(phoneme=vc_phoneme, position=total_duration - vc_length),
            ])

        # 没有下一个邻居
        return self.make_simple_result(current_lyric)

    # ------------------------------------------------------------------ 辅助

    @staticmethod
    def _last_char(s: str) -> str:
        """`s.LastOrDefault().ToString()`。★ C# 对**空串**给的是 `"\\0"`（char 的 default），
        而不是空串 —— 表里没有 `"\\0"`，所以与"查不到"等价。这里直接给一个必然查不到的键。"""
        return s[-1] if s else '\x00'

    @staticmethod
    def _first_char(s: str) -> str:
        """`s.FirstOrDefault().ToString()`（空串同上）。"""
        return s[0] if s else '\x00'

    @staticmethod
    def _attr(note: Note, index: int):
        from .chinese_cvvc import _DEFAULT_ATTR
        return next((a for a in (note.phoneme_attributes or []) if a.index == index),
                    _DEFAULT_ATTR)

    def _check_oto_until_hit(self, input_, note: Note):
        """对应 `checkOtoUntilHit`（attr index **0**）。返回 `(是否命中, UOto 或 None)`。

        颜色不匹配时**取第一个**命中项。
        """
        attr = self._attr(note, 0)
        color = (attr.voice_color if attr.voice_color is not None
                 else self.get_parent_voice_color())
        shift = (attr.tone_shift if attr.tone_shift is not None
                 else self.get_parent_tone_shift())
        alt = attr.alternate if attr.alternate is not None else self.get_parent_alternate()

        otos = []
        for test in input_:
            alt_suffix = str(alt) if alt is not None else ''
            alt_oto = self.mapped_oto(test + alt_suffix, note.tone + shift, color)
            if alt_oto is not None:
                otos.append(alt_oto)
                continue
            cand = self.mapped_oto(test, note.tone + shift, color)
            if cand is not None:
                otos.append(cand)

        if otos:
            oto = next((o for o in otos if o.is_color_match(color)), None)
            if oto is None:
                oto = otos[0]
            return True, oto
        return False, None

    def _check_oto_until_hit_vc(self, input_, note: Note):
        """对应 `checkOtoUntilHitVc`（attr index **1**）。

        ★ 与上面那份**失败语义相反**：颜色不匹配时**返回 false**，不取第一个命中项
        —— 也就是"没有该音色的 VC 就不插 VC"。
        """
        attr = self._attr(note, 1)
        color = (attr.voice_color if attr.voice_color is not None
                 else self.get_parent_voice_color())
        shift = (attr.tone_shift if attr.tone_shift is not None
                 else self.get_parent_tone_shift())
        alt = attr.alternate if attr.alternate is not None else self.get_parent_alternate()

        otos = []
        for test in input_:
            alt_suffix = str(alt) if alt is not None else ''
            alt_oto = self.mapped_oto(test + alt_suffix, note.tone + shift, color)
            if alt_oto is not None:
                otos.append(alt_oto)
                continue
            cand = self.mapped_oto(test, note.tone + shift, color)
            if cand is not None:
                otos.append(cand)

        if otos:
            oto = next((o for o in otos if o.is_color_match(color)), None)
            if oto is not None:
                return True, oto
        return False, None


def idiv(a: int, b: int) -> int:
    """C# 的整数除法（向零截断）。这里单独写一份以免与 `music_math.idiv` 的导入链纠缠。

    `totalDuration / 2` 在 C# 里两操作数都是 int → **整数除法**；Python 的 `//`
    在负数时是向下取整，会不同（totalDuration 恒 ≥ 0，但保持语义一致更稳妥）。
    """
    a = int(a)
    b = int(b)
    q = abs(a) // abs(b)
    return -q if (a < 0) != (b < 0) else q

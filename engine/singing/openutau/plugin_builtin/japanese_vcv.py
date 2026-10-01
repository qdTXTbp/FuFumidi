# -*- coding: utf-8 -*-
"""Japanese VCV 音素化器（legacy）—— **照搬**
`OpenUtau.Plugin.Builtin/JapaneseVCVPhonemizer.cs`（116 行）。

C# 声明：`[Phonemizer("Japanese VCV Phonemizer (legacy)", "JA VCV", language: "JA")]`

## 它做什么
把音符的歌词（假名/罗马字）按 **VCV（元音链）** 规则变成声库里的原音别名：
如果前一个音符存在，就用"前一个音符的**尾元音** + 当前歌词"作为首选别名
（如 `a な`），再依次回落到 `* な` / `な` / `- な`。

## 照搬时保留的语义（别"整理"掉）
1. **`vowels` 表的顺序就是优先级**：`a, e, i, o, n, u, N`，且 `ToDictionary` 在遇到
   重复键时会**抛异常** —— 所以表里不能有同一个假名出现在两行。构造时逐行拆解，
   `=` 左边是"元音名"（同时也是**别名**的一种，如 `a`），右边是假名清单。
   注意 `n=ん,n` 与 `N=ン,ng` 是两行：小写 `n` 表拨音 `ん`/`n`，大写 `N` 表 `ン`/`ng`。
2. **歌词先做 Unicode 归一化**（C# `.Normalize()` = NFC），这是"measure for Unicode"
   —— 同一个假名有合成/分解两种码点，不归一化就会查不到 oto，且**只在某些输入法下复现**。
3. 取"前一个歌词的最后一个 Unicode 元素"用的是 `ToUnicodeElements`（按**字素**切，
   不是按 `[0]`/`[-1]` 简单切字符）—— `きゃ` 要切出 `ゃ` 而不是 `ゃ` 的半个码点。
4. `phoneticHint` **只影响"命中时"**：命中就立刻返回 hint 的别名；**未命中则继续走正常流程**
   （不是"跳过正常流程"）。这两条合起来才是 C# 的行为 —— 因为 hint 是"首选覆盖"，
   而不是"唯一来源"。
5. `CheckOtoUntilHit` 逐个候选试 `singer.TryGetMappedOto`，收集**所有**命中的 oto 后
   先挑 `IsColorMatch(color)` 的那个，挑不到才取第一个 —— 不是"第一个命中的就用"。
   并且每个候选**先试 `test + alt`，失败了才试 `test`**（同一候选两者不会都进 otos）。
6. `alt` 是 `int?`：C# 里 `test + alt` 在 alt 为 null 时**等于 test**（字符串 + null → 空），
   Python 里直接 `test + alt` 会 TypeError，所以显式拼 `str(alt)` 或空串。
7. 全部试完仍没有 → 回落成**原歌词**（不报错）。
"""

import unicodedata

from ..phonemizer import Note, Phoneme, Phonemizer, Result, register
from ..oto import UOto

#: 假名 → 尾元音 的查表原始数据。**顺序即优先级**，且不能有重复键。
VOWELS = (
    'a=ぁ,あ,か,が,さ,ざ,た,だ,な,は,ば,ぱ,ま,ゃ,や,ら,わ,ァ,ア,カ,ガ,サ,ザ,タ,ダ,ナ,ハ,バ,パ,マ,ャ,ヤ,ラ,ワ,a',
    'e=ぇ,え,け,げ,せ,ぜ,て,で,ね,へ,べ,ぺ,め,れ,ゑ,ェ,エ,ケ,ゲ,セ,ゼ,テ,デ,ネ,ヘ,ベ,ペ,メ,レ,ヱ,e',
    'i=ぃ,い,き,ぎ,し,じ,ち,ぢ,に,ひ,び,ぴ,み,り,ゐ,ィ,イ,キ,ギ,シ,ジ,チ,ヂ,ニ,ヒ,ビ,ピ,ミ,リ,ヰ,i',
    'o=ぉ,お,こ,ご,そ,ぞ,と,ど,の,ほ,ぼ,ぽ,も,ょ,よ,ろ,を,ォ,オ,コ,ゴ,ソ,ゾ,ト,ド,ノ,ホ,ボ,ポ,モ,ョ,ヨ,ロ,ヲ,o',
    'n=ん,n',
    'u=ぅ,う,く,ぐ,す,ず,つ,づ,ぬ,ふ,ぶ,ぷ,む,ゅ,ゆ,る,ゥ,ウ,ク,グ,ス,ズ,ツ,ヅ,ヌ,フ,ブ,プ,ム,ュ,ユ,ル,ヴ,u',
    'N=ン,ng',
)


def _build_vowel_lookup():
    """对应 C# 静态构造里的 `SelectMany` + `ToDictionary`。

    重复键在 C# 会抛 `ArgumentException`；Python 侧同样抛 `ValueError`（不静默覆盖）——
    "静默取后者"会让元音判断在某些音节上悄悄错掉。
    """
    lookup = {}
    for line in VOWELS:
        parts = line.split('=')
        vowel = parts[0]
        for cv in parts[1].split(','):
            if cv in lookup:
                raise ValueError('VOWELS 表里有重复键: %r' % cv)
            lookup[cv] = vowel
    return lookup


#: 假名 → 尾元音
VOWEL_LOOKUP = _build_vowel_lookup()


@register
class JapaneseVCVPhonemizer(Phonemizer):
    """对应 `JapaneseVCVPhonemizer`。"""

    name = 'Japanese VCV Phonemizer (legacy)'
    tag = 'JA VCV'
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
        # C# `.Normalize()` = NFC
        current_lyric = unicodedata.normalize('NFC', note.lyric or '')

        if note.phonetic_hint:
            # 有 hint 时**先试 hint**；命中即返回；未命中则继续走下面的正常流程
            hit, ph = self._check_oto_until_hit(
                [unicodedata.normalize('NFC', note.phonetic_hint)], note)
            if hit:
                return Result(phonemes=[Phoneme(index=0, phoneme=ph.alias)])

        # 没有前邻音符时的别名，例如 "な" 对应 "- な"
        tests = ['- %s' % current_lyric, current_lyric]
        if prev_neighbour is not None:
            prev_lyric = unicodedata.normalize('NFC', prev_neighbour.lyric or '')
            if prev_neighbour.phonetic_hint:
                prev_lyric = unicodedata.normalize('NFC', prev_neighbour.phonetic_hint)
            # 取前一个歌词的**最后一个字素**，例如 "きゃ" / "- きゃ" → "ゃ"
            unicode = self.to_unicode_elements(prev_lyric)
            vow = VOWEL_LOOKUP.get(unicode[-1] if unicode else '')
            if vow is not None:
                # 把最初的 "- な" 换成 "a な"
                tests = ['%s %s' % (vow, current_lyric),
                         '* %s' % current_lyric,
                         current_lyric,
                         '- %s' % current_lyric]
        hit, oto = self._check_oto_until_hit(tests, note)
        if hit:
            return Result(phonemes=[Phoneme(index=0, phoneme=oto.alias)])
        return Result(phonemes=[Phoneme(index=0, phoneme=current_lyric)])

    def _check_oto_until_hit(self, input_, note: Note):
        """对应 `CheckOtoUntilHit`。返回 `(是否命中, UOto 或 None)`。"""
        attrs = note.phoneme_attributes or []
        attr = next((a for a in attrs if a.index == 0), None)
        if attr is not None:
            color = attr.voice_color if attr.voice_color is not None else self.get_parent_voice_color()
            shift = attr.tone_shift if attr.tone_shift is not None else self.get_parent_tone_shift()
            alt = attr.alternate if attr.alternate is not None else self.get_parent_alternate()
        else:
            color = self.get_parent_voice_color()
            shift = self.get_parent_tone_shift()
            alt = self.get_parent_alternate()

        otos = []
        for test in input_:
            # C# 的 `test + alt`：alt 为 null 时等于 test（字符串 + null → 空串）
            alt_suffix = str(alt) if alt is not None else ''
            oto_alt = self.singer.try_get_mapped_oto(test + alt_suffix, note.tone + shift, color)
            if oto_alt is not None:
                otos.append(oto_alt)
            else:
                oto_candidacy = self.singer.try_get_mapped_oto(test, note.tone + shift, color)
                if oto_candidacy is not None:
                    otos.append(oto_candidacy)

        if otos:
            # 先挑颜色匹配的，挑不到才取第一个
            oto = next((o for o in otos if o.is_color_match(color)), None)
            if oto is None:
                oto = otos[0]
            return True, oto
        return False, None

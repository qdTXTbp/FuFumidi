# -*- coding: utf-8 -*-
"""粤语 Syo 式音素化器 —— **照搬**
`OpenUtau.Plugin.Builtin/CantoneseSyoPhonemizer.cs`（358 行）。

C# 声明：
`[Phonemizer("Cantonese Syo-Style Phonemizer", "ZH-YUE SYO", "Lotte V", language: "ZH-YUE")]`

支持完整的粤拼音节，也支持「去掉韵尾辅音 / 下降复元音后的简写」回落；
歌词可写汉字，也可直接写粤拼。

## 照搬时保留的语义（别"整理"掉）
1. **声母判定是"先试两字符、再试一字符"**，且单字符那支显式排除 `ng`：
   `len > 2` 才试 `gw`/`kw`/`ng` 这种双字母声母；`len > 1` 才试单字母声母；
   `ng` 因为会在双字母那支被截走，单字母分支又要求 `lyric != "ng"`。
2. `phoneme0` 的初值是**整条歌词**（`string phoneme0 = lyric;`），查不到 oto 时
   就原样把它当音素名返回 —— 不是回落成别的名字。
3. 元音表命中时 `length1 = 120`、韵尾命中时 `length2 = 60`，两者都**上限为
   `totalDuration / 2`**（C# 整数除法，正数下等价 `//`）。
4. ★ `checkOtoUntilHit` 与 `checkOtoUntilHitFinal` 的**语义不同**：
   - 前者：只要**任意**一个候选命中就返回 true；颜色不匹配时回落取**第一个**。
   - 后者：必须存在**颜色匹配**的候选才返回 true（`otos.Count > 0` 还不够）。
   这是上游有意的差异（对应 ja/ZH 两族里"命中即返回"的两种写法），照搬。
5. `attr = note.phonemeAttributes?.FirstOrDefault(index == 0) ?? default`：
   `PhonemeAttributes` 在上游是 **struct**，`FirstOrDefault` 永不返回 null，
   所以 `?? default` 那一支实际不可达 —— 取不到时就是一个「字段全默认」的实例，
   其 `voiceColor/toneShift/alternate` 都是 null，于是**一律回落到轨道默认值**。
   这里用 `attr is None → 全部走 GetParent*` 等价实现（见 `_attr_of`）。
6. 第三段（开音节韵尾）能走到，只可能是元音表**未命中或命中但为空**，
   所以那句 `string.IsNullOrEmpty(phoneme1)` 是恒真的冗余守卫 —— 照搬保留。
7. `JyutpingConversion.RomanizeNotes` 里 `Enumerable.Zip(...).Last()` 只为**强制枚举**
   （副作用在 `ChangeLyric` 里），Python 用普通循环等价实现。

★ 载体差异：粤拼表同上（`base_chinese.set_jyutping_converter` 可注入；
未注入且无受支持库时汉字原样返回，与 C# 的 `Error.Default` 同义）。
"""

from typing import Dict, List, Optional, Tuple

from ..base_chinese import BaseChinesePhonemizer
from ..phonemizer import Note, Phoneme, Phonemizer, Result, register

#: 声母表（C# 的 `consonants` 逐字符相同）
_CONSONANTS = 'b,p,m,f,d,t,n,l,g,k,ng,h,gw,kw,w,z,c,s,j'

#: 韵母拆分表：`音节 = 拆出的两个音素`（C# 的 `vowels`）
_VOWELS = (
    'aap=aa p,aat=aa t,aak=aa k,aam=aa m,aan=aa n,aang=aa ng,aai=aa i,aau=aa u,'
    'ap=a p,at=a t,ak=a k,am=a m,an=a n,ang=a ng,ai=a i,au=a u,'
    'op=o p,ot=o t,ok=o k,om=o m,on=o n,ong=o ng,oi=o i,ou=o u,'
    'oet=oe t,oek=oe k,oeng=oe ng,oei=oe i,'
    'eot=eo t,eon=eo n,eoi=eo i,'
    'ep=e p,et=e t,ek=e k,em=e m,en=e n,eng=e ng,ei=e i,eu=e u,'
    'up=u p,ut=u t,uk=uu k,um=um,un=u n,ung=uu ng,ui=u i,'
    'yut=yu t,yun=yu n,'
    'ip=i p,it=i t,ik=ii k,im=i m,in=i n,ing=ii ng,iu=i u'
)

#: 元音替代表（C# 的 `substitution`）：`原音节… = 替代值`
_SUBSTITUTION = [
    'aap,aat,aak,aam,aan,aang,aai,aau=aa',
    'ap,at,ak,am,an,ang,ai,au=a',
    'op,ot,ok,om,on,ong,oi,ou=o',
    'oet,oek,oen,oeng,oei=oe',
    'eot,eon,eoi=eo',
    'ep,et,ek,em,en,eng,ei,eu=e',
    'uk,ung=uu',
    'up,ut,um,un,ui=u',
    'yut,yun=yu',
    'ik,ing=ii',
    'ip,it,im,in,iu=i',
]

#: 韵尾替代表（C# 的 `finalSub`）
_FINAL_SUB = [
    'ii ng=i ng',
    'ii k=i k',
    'uu k=u k',
    'uu ng=u ng',
    'oe t=eo t',
    'oe i=eo i',
]


def _expand(pairs: List[str]) -> Dict[str, str]:
    """把 `"a,b,c=X"` 形态展开成 `{a: X, b: X, c: X}`（对应 C# 的 `SelectMany` + `ToDictionary`）。"""
    out: Dict[str, str] = {}
    for line in pairs:
        parts = line.split('=')
        for orig in parts[0].split(','):
            out[orig] = parts[1]
    return out


_C_SET = set(_CONSONANTS.split(','))
_V_DICT: Dict[str, str] = dict(s.split('=') for s in _VOWELS.split(','))
# ★ 展开后的查表字典用**另一个名字**（`_SUBSTITUTE` / `_FINAL_SUBSTITUTE`），
#   不能重绑定上面那两张原始表：一致性测试要拿原始表逐项跟 C# 的数组字面量比。
_SUBSTITUTE = _expand(_SUBSTITUTION)
_FINAL_SUBSTITUTE = _expand(_FINAL_SUB)


@register
class CantoneseSyoPhonemizer(Phonemizer):
    """对应 `CantoneseSyoPhonemizer`（直接继承 `Phonemizer`）。"""

    name = 'Cantonese Syo-Style Phonemizer'
    tag = 'ZH-YUE SYO'
    author = 'Lotte V'
    language = 'ZH-YUE'

    def __init__(self):
        super().__init__()
        self.singer = None

    # ------------------------------------------------------------------ 歌手 / 预置

    def set_singer(self, singer) -> None:
        """对应 `SetSinger`：只存字段。"""
        self.singer = singer

    def set_up(self, notes: List[List[Note]], project, track) -> None:
        """对应 `SetUp`：先走基类，再把每组首音符的汉字歌词换成粤拼。"""
        super().set_up(notes, project, track)
        self._romanize_notes(notes)

    # ------------------------------------------------------------------ 粤拼转换

    @staticmethod
    def _romanize(lyrics) -> List[str]:
        """对应内嵌类 `JyutpingConversion.Romanize`（与 `BaseChinesePhonemizer`
        的同名方法逐句一致，只是转换器换成粤拼）。"""
        return BaseChinesePhonemizer.romanize_jyutping(lyrics)

    @classmethod
    def _romanize_notes(cls, groups: List[List[Note]]) -> List[List[Note]]:
        """对应 `JyutpingConversion.RomanizeNotes`（`ChangeLyric` 的副作用即改 `group[0]`）。"""
        result_lyrics = cls._romanize([g[0].lyric for g in groups])
        for group, lyric in zip(groups, result_lyrics):
            BaseChinesePhonemizer.change_lyric(group, lyric)
        return groups

    # ------------------------------------------------------------------ oto 查询

    def _attrs_of(self, note: Note, index: int):
        """取该下标的音素属性；缺失时返回 `None`（调用方一律回落轨道默认值）。

        对应 C# 的 `note.phonemeAttributes?.FirstOrDefault(a => a.index == index) ?? default`。
        `PhonemeAttributes` 上游是 struct，`default` 的三项覆盖值都是 null，
        所以"取不到"与"取到全默认实例"在**读取覆盖值时完全等价** —— 见模块 docstring 第 5 条。
        """
        for a in (note.phoneme_attributes or []):
            if a.index == index:
                return a
        return None

    def _color_shift_alt(self, note: Note, index: int) -> Tuple[str, int, Optional[int]]:
        attr = self._attrs_of(note, index)
        if attr is not None:
            color = attr.voice_color if attr.voice_color is not None else self.get_parent_voice_color()
            shift = attr.tone_shift if attr.tone_shift is not None else self.get_parent_tone_shift()
            alt = attr.alternate if attr.alternate is not None else self.get_parent_alternate()
        else:
            color = self.get_parent_voice_color()
            shift = self.get_parent_tone_shift()
            alt = self.get_parent_alternate()
        return color, shift, alt

    def _check_oto_until_hit(self, input_: List[str], note: Note):
        """对应 `checkOtoUntilHit`（attr.index == 0）。

        ★ 命中语义：只要**任意**候选命中即返回 True；颜色匹配优先，
        没有匹配的则回落取**第一个**。
        """
        color, shift, alt = self._color_shift_alt(note, 0)
        otos = []
        for test in input_:
            alt_suffix = str(alt) if alt is not None else ''
            oto_alt = self.mapped_oto(test + alt_suffix, note.tone + shift, color)
            if oto_alt is not None:
                otos.append(oto_alt)
            else:
                oto_candidacy = self.mapped_oto(test, note.tone + shift, color)
                if oto_candidacy is not None:
                    otos.append(oto_candidacy)
        if otos:
            oto = next((o for o in otos if o.is_color_match(color)), None)
            if oto is None:
                oto = otos[0]
            return True, oto
        return False, None

    def _check_oto_until_hit_final(self, input_: List[str], note: Note):
        """对应 `checkOtoUntilHitFinal`（attr.index == 1）。

        ★ 与前者**语义不同**：必须有**颜色匹配**的候选才算命中；
        `otos` 非空但颜色都不匹配时返回 False。
        """
        color, shift, alt = self._color_shift_alt(note, 1)
        otos = []
        for test in input_:
            alt_suffix = str(alt) if alt is not None else ''
            oto_alt = self.mapped_oto(test + alt_suffix, note.tone + shift, color)
            if oto_alt is not None:
                otos.append(oto_alt)
            else:
                oto_candidacy = self.mapped_oto(test, note.tone + shift, color)
                if oto_candidacy is not None:
                    otos.append(oto_candidacy)
        if otos:
            oto = next((o for o in otos if o.is_color_match(color)), None)
            if oto is not None:
                return True, oto
        return False, None

    # ------------------------------------------------------------------ 主逻辑

    def process(self, notes: List[Note], prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prevs=None) -> Result:
        note = notes[0]
        lyric = note.lyric
        consonant = ''
        vowel = ''

        # 1) 先试双字母声母（gw / kw / ng），再试单字母声母，否则整条当韵母
        if len(lyric) > 2 and lyric[0:2] in _C_SET:
            consonant = lyric[0:2]
            vowel = lyric[2:]
        elif len(lyric) > 1 and lyric[0:1] in _C_SET and lyric != 'ng':
            consonant = lyric[0:1]
            vowel = lyric[1:]
        else:
            vowel = lyric

        phoneme0 = lyric
        fin = '%s -' % vowel
        total_duration = sum(n.duration for n in notes)

        # 需要"插一个韵尾"时才走这条：0 段短促入声（有韵尾）。
        phoneme1 = _V_DICT.get(vowel)
        if phoneme1:
            # 韵尾至少 120 tick，但不超过半拍
            length1 = 120
            if length1 > total_duration // 2:
                length1 = total_duration // 2

            lyrics = [lyric]
            sub = _SUBSTITUTE.get(vowel)
            if sub is not None:
                lyrics.append(('%s%s' % (consonant, sub)) if consonant else sub)

            # 前邻是入声（-p/-t/-k 结尾）或没有前邻 → 试词首格式
            closed = prev_neighbour is not None and (
                prev_neighbour.lyric.endswith('p')
                or prev_neighbour.lyric.endswith('t')
                or prev_neighbour.lyric.endswith('k'))
            if prev_neighbour is None or closed:
                tests = ['- %s' % lyric, '- %s' % lyrics[1], lyric, lyrics[1]]
                hit, oto = self._check_oto_until_hit(tests, note)
                if hit:
                    phoneme0 = oto.alias
            else:
                hit, oto = self._check_oto_until_hit(lyrics, note)
                if hit:
                    phoneme0 = oto.alias

            length2 = 60
            if length2 > total_duration // 2:
                length2 = total_duration // 2

            if next_neighbour is None and self.mapped_oto(fin, note.tone) is not None:
                # 句末且声库里有 `{韵母} -` → 用 60 tick 的韵尾收束
                hit, oto = self._check_oto_until_hit_final([fin], note)
                if hit:
                    phoneme1 = oto.alias
                return Result(phonemes=[
                    Phoneme(phoneme=phoneme0),
                    Phoneme(phoneme=phoneme1, position=total_duration - length2),
                ])
            tails = [phoneme1]
            fin_sub = _FINAL_SUBSTITUTE.get(phoneme1)
            if fin_sub is not None:
                tails.append(fin_sub)
            hit, oto = self._check_oto_until_hit_final(tails, note)
            if hit:
                phoneme1 = oto.alias
            else:
                return self.make_simple_result(phoneme0)
            return Result(phonemes=[
                Phoneme(phoneme=phoneme0),
                Phoneme(phoneme=phoneme1, position=total_duration - length1),
            ])

        # 2) 开音节的元音收束：声库里没有对应韵尾就不插
        #    （能走到这里说明 phoneme1 为空/未命中，那句 IsNullOrEmpty 是恒真的冗余守卫）
        if next_neighbour is None and not phoneme1 and fin:
            length1 = 60
            if length1 > total_duration // 2:
                length1 = total_duration // 2

            lyrics = [lyric]
            closed = prev_neighbour is not None and (
                prev_neighbour.lyric.endswith('p')
                or prev_neighbour.lyric.endswith('t')
                or prev_neighbour.lyric.endswith('k'))
            if prev_neighbour is None or closed:
                hit, oto = self._check_oto_until_hit(['- %s' % lyric, lyric], note)
                if hit:
                    phoneme0 = oto.alias
            else:
                hit, oto = self._check_oto_until_hit(lyrics, note)
                if hit:
                    phoneme0 = oto.alias
                else:
                    return self.make_simple_result(phoneme0)

            hit, oto = self._check_oto_until_hit_final([fin], note)
            if hit:
                fin = oto.alias
            else:
                return self.make_simple_result(phoneme0)
            return Result(phonemes=[
                Phoneme(phoneme=phoneme0),
                Phoneme(phoneme=fin, position=total_duration - length1),
            ])

        # 3) 不拆分：试词首格式再试裸歌词，都不中就原样返回整条歌词
        closed = prev_neighbour is not None and (
            prev_neighbour.lyric.endswith('p')
            or prev_neighbour.lyric.endswith('t')
            or prev_neighbour.lyric.endswith('k'))
        if prev_neighbour is None or closed:
            hit, oto = self._check_oto_until_hit(['- %s' % lyric, lyric], note)
        else:
            hit, oto = self._check_oto_until_hit([lyric], note)
        if hit:
            phoneme0 = oto.alias
        else:
            return self.make_simple_result(phoneme0)
        return Result(phonemes=[Phoneme(phoneme=phoneme0)])

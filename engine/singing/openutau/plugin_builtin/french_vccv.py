# -*- coding: utf-8 -*-
r"""法语 VCCV 音素化器 —— **照搬**
`OpenUtau.Plugin.Builtin/FrenchVCCVPhonemizer.cs`（294 行）。

C# 声明：`[Phonemizer("French VCCV m2RUg Phonemizer", "FR VCCV", "Mim", language:"FR")]`

这是 `SyllableBasedPhonemizer` 基类的**第一个真实用户**（之前只有抽象基类自己）：
覆盖 `GetVowels` / `GetConsonants` / `GetDictionaryName` / `ProcessSyllable` /
`ProcessEnding` / `NoGap` / `GetTransitionBasicLengthMs` / `GetSymbols`，不牵任何
外部 G2p 类、不牵 YAML —— 缺 `cmudict_fr.txt` 词典时 `SetSinger` 仍能跑通
（`hasDictionary` 会变 True 但字典为空，`GetSymbols` 走 `phoneticHint` 分支不查字典）。

## 照搬时保留的语义（别"整理"掉）
1. ★ **C# 字段隐藏**：子类声明了 `private readonly Dictionary<string,string>
   dictionaryReplacements = …`，**隐藏**了基类的同名字段。于是基类方法（`SetSinger`
   里 `dictionaryReplacements.Clear()` / `GetSymbols` 里的替换查表）操作的是基类那个
   **永远空**的字段；子类的硬编码表**只**通过 `GetDictionaryPhonemesReplacement()`
   进 `G2pRemapper.replacements`。Python 没有字段隐藏 → 用**类常量 + 覆盖 getter**
   复刻：基类的 `self.dictionary_replacements` 保持空，硬编码表存在 `_REPL_MAP`。
2. ★ `dictionaryReplacements` 的构造用 `.Where(parts[0] != parts[1])` ——
   **丢掉自映射**（`"4=4"` 被丢；`"hh=h"` 保留因为 `hh != h`）。
3. ★ `GetSymbols` 覆盖里 `if (convert == null) return null;` 是**死代码**
   （`convert` 是 `new List<string>()`，永远非 null）—— 照搬。
4. ★ `ProcessSyllable` 里 `var lastC = cc.Length - 1; var firstC = 0;` 是两个
   **死局部变量**（声明后未用）—— 照搬时省略并在此记档（纯修饰性，不影响行为）。
5. ★ `IsVV` 分支里那段 `CanMakeAliasExtension` 被**注释掉**了（行 53–58）——
   照搬激活的那一支（`basePhoneme = $"{prevV} {v}"`），注释不搬。
6. ★ `prevV.Contains("'")` 的"声乐 fry"剥离只改**局部变量** `prevV`
   （`syllable.prevV` 不变 —— string 不可变、且 `prevV = syllable.prevV` 本就是拷贝）。
7. ★ `cc.Last()` 在 VCV 分支末尾的 `n+j → J` 规则：`if (cc[-1] == "j" and cc[-2] == "n")`。
8. ★ `ProcessEnding` 单辅音分支的 `vc = $"{v}{cc[0]} -"` —— **v 与 cc[0] 之间没有空格**
   （`"An -"` 而不是 `"A n -"`）；双辅音分支末尾的 `cci = $"{cc[i]}{cc[i+1]} -"` 同样无空格。
9. `NoGap => true`、`GetTransitionBasicLengthMs` 转调 `GetTransitionBasicLengthMsByOto`。

## 与 C# 的载体差异
- `cc.Last()` → `cc[-1]`；`cc[cc.Length-2]` → `cc[-2]`。
- `string.Split(string)` 在 C# 里按"整串分隔符"切；这里 vowels 用 `.split(" ")`、
  其余用 `.split(",")`，语义一致（单字符分隔符下 `Split(char[])` 与 `split(sep)` 等价）。
"""

from typing import Dict, List, Optional

from ..phonemizer import Note, PhonemeAttributes, register
from .syllable_based import Ending, Syllable, SyllableBasedPhonemizer

# ---------------------------------------------------------------- 常量表

#: 对应 `vowels = "A,E,e,2,9,i,o,O,u,y,a,U,0,A',E',e',2',9',i',o',O',u',y',a',U',0'".Split(",")`
VOWELS = ('A,E,e,2,9,i,o,O,u,y,a,U,0,A\',E\',e\',2\',9\',i\',o\',O\',u\',y\',a\',U\',0\''
          '').split(',')

#: 对应 `consonants = "b,d,f,g,Z,k,l,m,n,p,R,s,S,t,v,w,j,z,J,H,h,4,r,_hh".Split(",")`
CONSONANTS = 'b,d,f,g,Z,k,l,m,n,p,R,s,S,t,v,w,j,z,J,H,h,4,r,_hh'.split(',')

#: 对应那串 `dictionaryReplacements` 字面量（**未**丢自映射的原始串）
_REPL_RAW = (
    'aa=A;ai=E;ei=e;eu=2;ee=2;oe=9;ii=i;au=o;oo=O;ou=u;uu=y;an=a;in=U;un=U;on=0;uy=H;'
    'bb=b;dd=d;ff=f;gg=g;jj=Z;kk=k;ll=l;mm=m;nn=n;pp=p;rr=R;ss=s;ch=S;tt=t;vv=v;ww=w;'
    'yy=j;zz=z;gn=J;4=4;hh=h;')

#: ★ 对应 `.Where(parts.Length==2).Where(parts[0]!=parts[1]).ToDictionary(...)`
#:   —— **丢掉自映射**（`4=4` 被丢；`hh=h` 保留）
_REPL_MAP: Dict[str, str] = {
    parts[0]: parts[1]
    for entry in _REPL_RAW.split(';')
    if entry
    for parts in (entry.split('='),)
    if len(parts) == 2 and parts[0] != parts[1]
}

#: 对应 `arpabet` / `m2rUg` 两个数组（GetSymbols 覆盖里那份，各 35 项）
_ARPABET = ('aa,ai,ei,eu,ee,oe,ii,au,oo,ou,uu,an,in,un,on,uy,'
            'bb,dd,ff,gg,jj,kk,ll,mm,nn,pp,rr,ss,ch,tt,vv,ww,yy,zz,gn').split(',')
_M2RUG = ('A,E,e,2,2,9,i,o,O,u,y,a,U,U,0,H,'
          'b,d,f,g,Z,k,l,m,n,p,R,s,S,t,v,w,j,z,J').split(',')

#: 对应 `shortConsonants` / `longConsonants` / `hardConsonants`（声明后**只在
#:   ProcessSyllable 里用 hardConsonants**；另两个是死字段，照搬保留）
SHORT_CONSONANTS = 'R'.split(',')
LONG_CONSONANTS = 't,k,g,p,s,S,Z'.split(',')
HARD_CONSONANTS = 't,k,g,p,d,b'.split(',')


@register
class FrenchVCCVPhonemizer(SyllableBasedPhonemizer):
    """对应 `FrenchVCCVPhonemizer`（m2RUg 法语 VCCV）。"""

    name = 'French VCCV m2RUg Phonemizer'
    tag = 'FR VCCV'
    author = 'Mim'
    language = 'FR'

    # ------------------------------------------------------------------ 子类钩子

    def get_vowels(self) -> List[str]:
        return list(VOWELS)

    def get_consonants(self) -> List[str]:
        return list(CONSONANTS)

    def get_dictionary_name(self) -> Optional[str]:
        return 'cmudict_fr.txt'

    def get_dictionary_phonemes_replacement(self) -> Dict[str, str]:
        # ★ 返回**子类那份硬编码表**（对应被隐藏的子类字段）；
        #   基类的 self.dictionary_replacements 保持空 —— 见模块 docstring 第 1 条
        return dict(_REPL_MAP)

    @property
    def no_gap(self) -> bool:
        return True

    def get_transition_basic_length_ms(self, alias: str = '', tone: int = 0,
                                       attr: Optional[PhonemeAttributes] = None) -> float:
        return self.get_transition_basic_length_ms_by_oto(alias, tone, attr)

    # ------------------------------------------------------------------ GetSymbols

    def get_symbols(self, note: Note) -> Optional[List[str]]:
        original = super().get_symbols(note)
        if original is None:
            return None

        convert: List[str] = []
        for s in original:
            c = s
            for i in range(len(_ARPABET)):
                if s == _ARPABET[i]:
                    c = _M2RUG[i]
            convert.append(c)

        # ★ `if (convert == null) return null;` —— convert 是 list，永远非 null（死代码，照搬）
        if convert is None:  # pragma: no cover
            return None
        return convert

    # ------------------------------------------------------------------ ProcessSyllable

    def process_syllable(self, syllable: Syllable) -> Optional[List[str]]:
        prev_v = syllable.prev_v
        cc = syllable.cc
        v = syllable.v
        # ★ C# 里有 `var lastC = cc.Length - 1; var firstC = 0;` 两个死局部变量，照搬时省略

        base_phoneme: Optional[str] = None
        phonemes: List[str] = []

        # vocal fry 支持：只剥**局部变量**的撇号（syllable.prevV 不变）
        if "'" in prev_v:
            prev_v = prev_v.replace("'", '')

        # --------------------------- STARTING V ------------------------------- #
        if syllable.is_starting_v:
            base_phoneme = '- %s' % v

        # --------------------------- VV ------------------------------- #
        elif syllable.is_vv:
            # ★ C# 这里有一段被注释掉的 CanMakeAliasExtension 分支（行 53–58）——不搬
            base_phoneme = '%s %s' % (prev_v, v)

        # --------------------------- STARTING CV ------------------------------- #
        elif syllable.is_starting_cv_with_one_consonant:
            base_phoneme = '- %s%s' % (cc[0], v)
            if not self.has_oto(base_phoneme, syllable.tone):
                self.try_add_phoneme(phonemes, syllable.tone, '- %s' % cc[0])
                base_phoneme = '%s%s' % (cc[0], v)

        # --------------------------- STARTING CCV ------------------------------- #
        elif syllable.is_starting_cv_with_more_than_one_consonant:
            if cc[0] not in HARD_CONSONANTS:
                phonemes.append('- %s' % cc[0])

            base_phoneme = '%s%s' % (cc[-1], v)

            # CC + CCV support
            ccv = '%s%s%s' % (cc[-2], cc[-1], v)
            if self.has_oto(ccv, syllable.tone):
                base_phoneme = ccv

                for i in range(len(cc) - 2):
                    cci = '%s %s' % (cc[i], cc[i + 1])

                    if i == 0:
                        cci = '- %s%s_' % (cc[i], cc[i + 1])
                    if not self.has_oto(cci, syllable.tone):
                        cci = '%s%s_' % (cc[i], cc[i + 1])
                        if (i + 1 == len(cc) - 2
                                and self.has_oto('_%s' % ccv, syllable.tone)):
                            base_phoneme = '_%s' % ccv

                    self.try_add_phoneme(phonemes, syllable.tone, cci)
            else:
                # CC + CV support
                for i in range(len(cc) - 1):
                    cci = '%s%s_' % (cc[i], cc[i + 1])

                    if i == 0:
                        cci = '- %s%s_' % (cc[i], cc[i + 1])
                        if not self.has_oto(cci, syllable.tone):
                            cci = '%s%s_' % (cc[i], cc[i + 1])

                    if self.has_oto(cci, syllable.tone):
                        phonemes.append(cci)
                        if (i + 1 == len(cc) - 1
                                and self.has_oto('_%s%s' % (cc[-1], v), syllable.tone)):
                            base_phoneme = '_%s%s' % (cc[-1], v)
                    else:
                        cci = '%s %s' % (cc[i], cc[i + 1])
                        self.try_add_phoneme(phonemes, syllable.tone, cci)

        # --------------------------- VCV (one consonant) ------------------------------- #
        elif syllable.is_vcv_with_one_consonant:
            vc = '%s %s' % (prev_v, cc[0])
            phonemes.append(vc)
            base_phoneme = '%s%s' % (cc[0], v)

        # --------------------------- VCV (more than one consonant) ------------------------------- #
        else:
            vc = '%s %s' % (prev_v, cc[0])
            phonemes.append(vc)

            base_phoneme = '%s%s' % (cc[-1], v)

            # CC + CCV support
            ccv = '%s%s%s' % (cc[-2], cc[-1], v)
            if self.has_oto(ccv, syllable.tone):
                base_phoneme = ccv

                for i in range(len(cc) - 2):
                    cci = '%s %s' % (cc[i], cc[i + 1])

                    if not self.has_oto(cci, syllable.tone):
                        cci = '%s%s_' % (cc[i], cc[i + 1])
                        if (i + 1 == len(cc) - 2
                                and self.has_oto('_%s' % ccv, syllable.tone)):
                            base_phoneme = '_%s' % ccv

                    self.try_add_phoneme(phonemes, syllable.tone, cci)
            else:
                # CC + CV support
                for i in range(len(cc) - 1):
                    cci = '%s%s_' % (cc[i], cc[i + 1])

                    if self.has_oto(cci, syllable.tone):
                        phonemes.append(cci)
                        if (i + 1 == len(cc) - 1
                                and self.has_oto('_%s%s' % (cc[-1], v), syllable.tone)):
                            base_phoneme = '_%s%s' % (cc[-1], v)
                    else:
                        cci = '%s %s' % (cc[i], cc[i + 1])
                        if not self.has_oto(cci, syllable.tone):
                            cci = '%s%s' % (cc[i], cc[i + 1])
                        self.try_add_phoneme(phonemes, syllable.tone, cci)

            # convert 'n + j' to 'J'
            if cc[-1] == 'j' and cc[-2] == 'n':
                base_phoneme = 'J%s' % v

        phonemes.append(base_phoneme)
        return phonemes

    # ------------------------------------------------------------------ ProcessEnding

    def process_ending(self, ending: Ending) -> Optional[List[str]]:
        cc = ending.cc
        v = ending.prev_v

        phonemes: List[str] = []

        # --------------------------- ENDING V ------------------------------- #
        if ending.is_ending_v:
            phonemes.append('%s -' % v)

        else:
            # --------------------------- ENDING VC ------------------------------- #
            if ending.is_ending_vc_with_one_consonant:
                # ★ `vc = $"{v}{cc[0]} -"` —— v 与 cc[0] 之间**没有空格**（"An -"）
                vc = '%s%s -' % (v, cc[0])
                if self.has_oto(vc, ending.tone):
                    phonemes.append(vc)
                else:
                    vc = '%s %s' % (v, cc[0])
                    phonemes.append(vc)
                    phonemes.append('%s -' % cc[0])

            # --------------------------- ENDING VCC ------------------------------- #
            else:
                vc = '%s %s' % (v, cc[0])
                phonemes.append(vc)
                has_ending = False

                for i in range(len(cc) - 1):
                    cci = '%s %s' % (cc[i], cc[i + 1])

                    if i == len(cc) - 2:
                        # ★ `cci = $"{cc[i]}{cc[i + 1]} -"` —— 同样无空格
                        cci = '%s%s -' % (cc[i], cc[i + 1])
                        has_ending = True
                    if not self.has_oto(cci, ending.tone):
                        cci = '%s%s_' % (cc[i], cc[i + 1])
                        has_ending = False
                    if not self.has_oto(cci, ending.tone):
                        cci = '%s%s' % (cc[i], cc[i + 1])
                        has_ending = False

                    self.try_add_phoneme(phonemes, ending.tone, cci)

                if not has_ending:
                    self.try_add_phoneme(phonemes, ending.tone, '%s -' % cc[-1])

        return phonemes

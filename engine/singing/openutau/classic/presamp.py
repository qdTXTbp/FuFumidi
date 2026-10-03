# -*- coding: utf-8 -*-
r"""presamp.ini 解析 —— **照搬** `OpenUtau.Core/Classic/Presamp.cs`（731 行）。

`presamp.ini` 是 UTAU 的**日文连续音**（非 VCV）声库配置：它描述"这个别名怎么拆成
辅音+元音"，让 UTAU 能唱出 VCV 式的连续歌唱。规格说明见
https://delta-kimigatame.hatenablog.jp/entry/ar483589

## ★ 为什么数据表是生成的
`defVowels` / `defConsonants` / `defReplace` / `defPitches` 是**几百行日文与音高名**，
手抄必错且很难发现（表现为"某个片假名唱错"）。所以它们放在
`_presamp_data.py`（由 `_gen_presamp_data.py` 从 C# 抽取生成），
`tests/test_presamp.py` 会**重新生成并逐字节比对** —— 上游改表而生成文件没跟上，
测试立刻红。

## ★ 照搬时保留的语义（每一条都很容易被"整理"掉）
1. **编码嗅探的顺序**：UTF-8 严格 → 声库声明的编码（严格）→ 依次试
   **932(Shift-JIS) / 936(GBK) / 949(EUC-KR) / 950(Big5)**。
   ★ 全程"严格"模式：解不出就当这个编码不对，而不是替换成 `?` 蒙混过关。
2. ★ **手工解析而不走 `Ini.read_blocks`** —— 上游注释写明是为了
   "preserve exact Case Sensitivity"（`Ini.ReadBlocks` 会把段名转小写）。
   段名匹配用 `line.ToUpper()`，但**值的大小写原样保留**
   （`[VOWEL] a=ア=...` 里的大小写是要紧的）。
3. ★ **进入某段就清空对应的默认值** —— 声库写 `[VOWEL]` 只写一行时，
   意思是"我要**替换**整个母音表"，不是"追加一行"。
   `[CFLAGS]` 进入时清成空串（`CFlags` 默认 `"p0"`）。
4. ★ `[ALIAS_PRIORITY]` / `[ALIAS_PRIORITY_DIFAPPEND]` / `[ALIAS_PRIORITY_DIFPITCH]`
   **只认第一行**：后续行只在"当前已有 ≥5 条"时被当作新值（先 `Clear()` 再加）。
   上游默认各有 **5** 条，所以读到第 6 行才会覆盖。
5. ★ `[SU]` 行的三重校验：必须**同时**含 `%num%` `%append%` `%pitch%`，
   且整行匹配 `^(?:%num%|%append%|%pitch%)+$`，否则整行**忽略**。
6. `[NUM]` / `[APPEND]` / `[PITCH]` 会**跳过**匹配 `^@.+@$` 的行
   （那是引用别的表的写法，不是真条目）。
7. `MakePhonemeList` 的**拗音母音补全**：某个音素没有母音时，
   取它**最后一个字符**当键去找母音（`きゃ` → 找 `ゃ`）。
8. `ParseAlias` 的切分顺序：`VCPAD` / `VCVPAD` 切出**前垫**（`preVowel`）→
   取**首字符**存为 `saving`（先頭文字，UTAU 的产物命名靠它）→
   再按 `Nums` → `Appends` → `Pitches` → `_` 依次把**后缀**剥下来。
   ★ 剥后缀那步用的是 `new Regex(split[0]).Replace(phoneme, "", 1)` ——
     **是当正则用的**，不是普通字符串替换。
9. `PresampAliasRules.VCV` 是**带私有 backing field 的属性**，
   取值时才把 `%VCVPAD%` / `%CVPAD%` 替换成实际分隔符
   （所以改 `VCPAD` 后 `VCV` 会跟着变）。
"""

import io
import os
import re
from typing import Dict, List, Optional

from ._presamp_data import (DEF_APPENDS, DEF_CONSONANTS, DEF_NUMS,
                            DEF_PITCHES, DEF_REPLACE, DEF_VOWELS)

#: `Reset()` 里的默认优先级串（不在 `def*` 表里，单独硬编码在上游）
DEF_PRIORITIES = ['k', 'ky', 'g', 'gy', 't', 'ty', 'd', 'dy', 'ch', 'ts',
                  'b', 'by', 'p', 'py', 'r', 'ry']

#: 三种 alias 优先级的默认值（各 5 条，见语义第 4 条）
DEF_ALIAS_PRIORITY_DEFAULT = ['VCV', 'CVVC', 'CROSS_CV', 'CV', 'BEGINING_CV']
DEF_ALIAS_PRIORITY_DIFAPPEND = ['CVVC', 'VCV', 'CROSS_CV', 'CV', 'BEGINING_CV']
DEF_ALIAS_PRIORITY_DIFPITCH = ['CVVC', 'VCV', 'CROSS_CV', 'CV', 'BEGINING_CV']

#: `[SU]` 行的白名单正则
_SU_TOKEN_RE = re.compile(r'^(?:%num%|%append%|%pitch%)+$')
#: `[NUM]`/`[APPEND]`/`[PITCH]` 里要跳过的"引用写法"
_REF_RE = re.compile(r'^@.+@$')

_CP_FALLBACKS = ('cp932', 'cp936', 'cp949', 'cp950')   # Shift-JIS / GBK / EUC-KR / Big5


# ---------------------------------------------------------------- 小数据类


class PresampPhoneme:
    """对应 `PresampPhoneme`。"""

    def __init__(self, phoneme: str = ''):
        self.phoneme = phoneme
        self.vowel = ''
        self.vowel_vol = 100
        self.consonant = ''
        self.not_clossfade = False
        self.is_priority = False

    @property
    def has_vowel(self) -> bool:
        """对应 `HasVowel => Vowel != ""`。"""
        return self.vowel != ''

    @property
    def has_consonant(self) -> bool:
        """对应 `HasConsonant => Consonant != ""`。"""
        return self.consonant != ''


class PresampVowel:
    """对应 `PresampVowel`（`VowelLower=VowelUpper=发音列表`）。"""

    def __init__(self):
        self.vowel_lower = ''
        self.vowel_upper = ''
        self.phonemes: List[str] = []
        self.vol = 100


class PresampConsonant:
    """对应 `PresampConsonant`（`辅音=发音列表[=NotClossfade]`）。"""

    def __init__(self):
        self.consonant = ''
        self.phonemes: List[str] = []
        self.not_clossfade = False


class PresampAliasRules:
    """对应 `PresampAliasRules`。

    ★ `VCV` 是**属性**：私有字段 `vcv` 存模板，`get` 时才把 `%VCVPAD%`/`%CVPAD%`
      替换成实际分隔符 —— 所以运行时改 `VCPAD` 会连带改 `VCV`。照搬这个行为。
    """

    def __init__(self):
        self.vcpad = ' '
        self.vcvpad = ' '
        self._vcv = '%v%%VCVPAD%%CV%'
        self.begining_cv = '-%VCVPAD%%CV%'
        self.cross_cv = '*%VCVPAD%%CV%'
        self.vc = '%v%%vcpad%%c%,%c%%vcpad%%c%'
        self.cv = '%CV%,%c%%V%'
        self.c = '%c%'
        self.long_v = '%V%ー'
        self.ending1 = '%v%%VCPAD%R'
        self.ending2 = '-'

    @property
    def vcv(self) -> str:
        """对应 `VCV { get => Replacer(vcv); set => vcv = value; }`。"""
        return self._replacer(self._vcv)

    @vcv.setter
    def vcv(self, value: str) -> None:
        self._vcv = value

    def _replacer(self, s: str) -> str:
        """对应 `private string Replacer(string str)`（★ **顺序**不能反：
        先 `%CVPAD%` 后 `%VCVPAD%` —— 否则 `%VCVPAD%` 里的 `%CVPAD%` 子串会先被吃掉）。"""
        return s.replace('%CVPAD%', self.vcpad).replace('%VCVPAD%', self.vcvpad)


# ---------------------------------------------------------------- 主类


class Presamp:
    """对应 `partial class Presamp`。"""

    def __init__(self):
        self.file_exists = False
        self.vowels: Dict[str, PresampVowel] = {}
        self.consonants: Dict[str, PresampConsonant] = {}
        self.priorities: List[str] = []
        self.replace: Dict[str, str] = {}
        self.alias_rules = PresampAliasRules()
        self.prefixs: List[str] = []
        self.suffix_order: List[str] = []
        self.nums: List[str] = []
        self.appends: List[str] = []
        self.pitches: List[str] = []
        self.alias_priority_default: List[str] = []
        self.alias_priority_dif_append: List[str] = []
        self.alias_priority_dif_pitch: List[str] = []
        self.split = True
        self.must_vc = False
        self.cflags = ''
        self.vc_length_from_cv = True
        #: 0=不加 1=加尾音 2=把最后一个音转成尾音（见 `AddEnding` 的注释）
        self.add_ending = 0
        self.phoneme_list: Dict[str, PresampPhoneme] = {}
        self.reset()
        self.make_phoneme_list()

    # ------------------------------------------------------------ 默认值

    def reset(self) -> None:
        """对应 `Reset()`：恢复出厂默认（读 presamp.ini 之前也调它）。"""
        self.set_vowels(DEF_VOWELS)
        self.set_consonants(DEF_CONSONANTS)
        self.priorities = list(DEF_PRIORITIES)
        self.replace = dict(DEF_REPLACE)
        self.alias_rules = PresampAliasRules()
        self.prefixs = []                     # 上游注释：def: empty
        self.suffix_order = ['%num%', '%append%', '%pitch%']
        self.nums = list(DEF_NUMS)
        self.appends = list(DEF_APPENDS)
        self.pitches = list(DEF_PITCHES)
        self.alias_priority_default = list(DEF_ALIAS_PRIORITY_DEFAULT)
        self.alias_priority_dif_append = list(DEF_ALIAS_PRIORITY_DIFAPPEND)
        self.alias_priority_dif_pitch = list(DEF_ALIAS_PRIORITY_DIFPITCH)
        self.split = True
        self.must_vc = False
        self.cflags = 'p0'
        self.vc_length_from_cv = True
        self.add_ending = 1

    # ------------------------------------------------------------ 解析

    def read_presamp_ini(self, dir_path: str, text_file_encoding: str = 'shift_jis') -> None:
        """对应 `ReadPresampIni(dirPath, textFileEncoding)`。

        ★ 文件不存在时**不报错**：`file_exists = False` 并直接用默认表
          （`MakePhonemeList` 仍然会跑）。
        ★ 单个块的解析出错（上游 `catch { Log.Error(...); continue; }`）
          → 跳过那一行继续，**不让整个文件失败**。
        """
        self.reset()
        ini_path = os.path.join(dir_path, 'presamp.ini')
        if not os.path.isfile(ini_path):
            self.file_exists = False
            self.make_phoneme_list()
            return
        self.file_exists = True

        raw = io.open(ini_path, 'rb').read()
        encoding = self._detect_encoding(raw, text_file_encoding)
        lines = io.open(ini_path, 'r', encoding=encoding, errors='strict',
                        newline=None).read().splitlines()

        current_block = ''
        vowel_lines: Optional[List[str]] = None
        consonant_lines: Optional[List[str]] = None

        for line in lines:
            if line.startswith(';'):
                continue
            if line.startswith('[') and line.endswith(']'):
                current_block = line.upper()
                # ★ 进入段就清空对应默认值（语义第 3 条）
                if current_block == '[VOWEL]':
                    self.vowels.clear()
                elif current_block == '[CONSONANT]':
                    self.consonants.clear()
                elif current_block == '[PRIORITY]':
                    self.priorities.clear()
                elif current_block == '[REPLACE]':
                    self.replace.clear()
                elif current_block == '[PRE]':
                    self.prefixs.clear()
                elif current_block == '[NUM]':
                    self.nums.clear()
                elif current_block == '[APPEND]':
                    self.appends.clear()
                elif current_block == '[PITCH]':
                    self.pitches.clear()
                elif current_block == '[ALIAS_PRIORITY]':
                    self.alias_priority_default.clear()
                elif current_block == '[ALIAS_PRIORITY_DIFAPPEND]':
                    self.alias_priority_dif_append.clear()
                elif current_block == '[ALIAS_PRIORITY_DIFPITCH]':
                    self.alias_priority_dif_pitch.clear()
                elif current_block == '[CFLAGS]':
                    self.cflags = ''
                continue

            try:
                if current_block == '[VOWEL]':
                    if vowel_lines is None:
                        vowel_lines = []
                    vowel_lines.append(line)
                elif current_block == '[CONSONANT]':
                    if consonant_lines is None:
                        consonant_lines = []
                    consonant_lines.append(line)
                elif current_block == '[PRIORITY]':
                    self.priorities.extend(line.split(','))
                elif current_block == '[REPLACE]':
                    s = line.split('=', 1)
                    if len(s) >= 2:
                        self.replace[s[0]] = s[1]
                elif current_block == '[ALIAS]':
                    self._parse_alias_line(line)
                elif current_block in ('[ENDTYPE]', '[ENDTYPE1]'):
                    self.alias_rules.ending1 = line
                elif current_block == '[ENDTYPE2]':
                    self.alias_rules.ending2 = line
                elif current_block == '[VCPAD]':
                    if line:
                        self.alias_rules.vcpad = line
                elif current_block == '[PRE]':
                    if line not in self.prefixs:
                        self.prefixs.append(line)
                elif current_block == '[SU]':
                    self._parse_su_line(line)
                elif current_block == '[NUM]':
                    if not _REF_RE.match(line):
                        self.nums.append(line)
                elif current_block == '[APPEND]':
                    if not _REF_RE.match(line):
                        self.appends.append(line)
                elif current_block == '[PITCH]':
                    if not _REF_RE.match(line):
                        self.pitches.append(line)
                elif current_block == '[ALIAS_PRIORITY]':
                    self._only_first_wins(self.alias_priority_default, line)
                elif current_block == '[ALIAS_PRIORITY_DIFAPPEND]':
                    self._only_first_wins(self.alias_priority_dif_append, line)
                elif current_block == '[ALIAS_PRIORITY_DIFPITCH]':
                    self._only_first_wins(self.alias_priority_dif_pitch, line)
                elif current_block == '[SPLIT]':
                    if line == '0':
                        self.split = False
                    elif line == '1':
                        self.split = True
                elif current_block == '[MUSTVC]':
                    if line == '0':
                        self.must_vc = False
                    elif line == '1':
                        self.must_vc = True
                elif current_block == '[CFLAGS]':
                    self.cflags = line
                elif current_block == '[VCLENGTH]':
                    # ★ 上游是反的：0 → true、1 → false（别"修正"它）
                    if line == '0':
                        self.vc_length_from_cv = True
                    elif line == '1':
                        self.vc_length_from_cv = False
                elif current_block == '[ENDFLAG]':
                    try:
                        self.add_ending = int(line)
                    except ValueError:
                        pass
                # [VERSION] [LOCALE] [RESAMP] [TOOL] [BATNUM]：给编辑器用的，声库侧忽略
            except Exception:                                    # noqa: BLE001
                continue                                         # ★ 跳过这一行，不中断

        if vowel_lines is not None:
            self.set_vowels(vowel_lines)
        if consonant_lines is not None:
            self.set_consonants(consonant_lines)
        self.make_phoneme_list()

    @staticmethod
    def _detect_encoding(raw: bytes, default_encoding: str) -> str:
        """★ 语义第 1 条：UTF-8 严格 → 声库声明编码（严格）→ 932/936/949/950 依次试。"""
        for enc in ('utf-8', default_encoding):
            try:
                raw.decode(enc, errors='strict')
                return enc
            except (UnicodeDecodeError, LookupError):
                continue
        for enc in _CP_FALLBACKS:
            try:
                raw.decode(enc, errors='strict')
                return enc
            except (UnicodeDecodeError, LookupError):
                continue
        return default_encoding

    def _parse_alias_line(self, line: str) -> None:
        """对应 `[ALIAS]` 段：键统一大写，值原样（大小写要紧）。"""
        parts = line.split('=', 1)
        if len(parts) < 2:
            return
        key = parts[0].upper()
        r = self.alias_rules
        if key == 'VCV':
            r.vcv = parts[1]
        elif key == 'BEGINING_CV':
            r.begining_cv = parts[1]
        elif key == 'CROSS_CV':
            r.cross_cv = parts[1]
        elif key == 'VC':
            r.vc = parts[1]
        elif key == 'CV':
            r.cv = parts[1]
        elif key == 'C':
            r.c = parts[1]
        elif key == 'LONG_V':
            r.long_v = parts[1]
        elif key == 'VCPAD':
            if parts[1]:
                r.vcpad = parts[1]
        elif key == 'VCVPAD':
            if parts[1]:
                r.vcvpad = parts[1]
        elif key == 'ENDING1':
            r.ending1 = parts[1]
        elif key == 'ENDING2':
            r.ending2 = parts[1]

    @staticmethod
    def _only_first_wins(target: List[str], line: str) -> None:
        """★ 语义第 4 条：只有"当前已 ≥5 条"时，这行才作为**新值**（先清再加）。"""
        if len(target) >= 5:
            target.clear()
            target.append(line)

    def _parse_su_line(self, line: str) -> None:
        """★ 语义第 5 条：必须同时含三个占位符，且整行只由它们拼成。"""
        if '%num%' not in line or '%append%' not in line or '%pitch%' not in line:
            return
        if not _SU_TOKEN_RE.match(line):
            return
        self.suffix_order = re.findall(r'%num%|%append%|%pitch%', line)

    # ------------------------------------------------------------ 音素表

    def make_phoneme_list(self) -> None:
        """对应 `MakePhonemeList()`。

        顺序：先铺辅音（**先到先得**，不覆盖），再用母音补/建，
        然后**拗音母音补全**（取末字符查表），最后打 `is_priority` 标记。
        """
        self.phoneme_list = {}

        for pc in self.consonants.values():
            if pc.consonant not in self.phoneme_list:
                pp = PresampPhoneme(pc.consonant)
                pp.consonant = pc.consonant
                pp.not_clossfade = pc.not_clossfade
                self.phoneme_list[pc.consonant] = pp
            for phoneme in pc.phonemes:
                if phoneme not in self.phoneme_list:
                    pp = PresampPhoneme(phoneme)
                    pp.consonant = pc.consonant
                    pp.not_clossfade = pc.not_clossfade
                    self.phoneme_list[phoneme] = pp

        for pv in self.vowels.values():
            for phoneme in pv.phonemes:
                pp = self.phoneme_list.get(phoneme)
                if pp is not None:
                    pp.vowel = pv.vowel_lower
                    pp.vowel_vol = pv.vol
                else:
                    pp = PresampPhoneme(phoneme)
                    pp.vowel = pv.vowel_lower
                    pp.vowel_vol = pv.vol
                    self.phoneme_list[phoneme] = pp

        # ★ 拗音母音补全：没母音的音素，用**最后一个字符**当键去找
        for pp in list(self.phoneme_list.values()):
            if not pp.has_vowel and pp.phoneme:
                vowel = self.phoneme_list.get(pp.phoneme[-1])
                if vowel is not None:
                    pp.vowel = vowel.vowel
                    pp.vowel_vol = vowel.vowel_vol

        for p in self.priorities:
            phoneme = self.phoneme_list.get(p)
            if phoneme is not None:
                phoneme.is_priority = True

    # ------------------------------------------------------------ 别名切分

    def parse_alias(self, lyric: str):
        """对应 `ParseAlias(lyric)` → `(preVowel, phoneme, suffix)`。"""
        pre_vowel = ''
        phoneme = lyric
        suffix = ''

        r = self.alias_rules
        if r.vcpad and phoneme and r.vcpad in phoneme:
            split = phoneme.split(r.vcpad)
            if len(split) > 1:
                pre_vowel = split[0]
                phoneme = split[1]
        elif r.vcvpad and phoneme and r.vcvpad in phoneme:
            split = phoneme.split(r.vcvpad)
            if len(split) > 1:
                pre_vowel = split[0]
                phoneme = split[1]

        if phoneme == '':
            return pre_vowel, phoneme, suffix

        saving = phoneme[:1]
        phoneme = phoneme[1:]

        # ★ 剥后缀用的是**正则**替换（上游 `new Regex(split[0]).Replace(phoneme, "", 1)`）
        for group in (self.nums, self.appends, self.pitches):
            for token in group:
                if token and token in phoneme:
                    split = phoneme.split(token)
                    suffix = re.sub(split[0], '', phoneme, count=1) + suffix
                    phoneme = split[0]
        if '_' in phoneme:
            split = phoneme.split('_')
            suffix = re.sub(split[0], '', phoneme, count=1) + suffix
            phoneme = split[0]

        return pre_vowel, saving + phoneme, suffix

    # ------------------------------------------------------------ 母音/辅音表

    def set_vowels(self, items) -> None:
        """对应 `SetVowels(List<string>)` 与 `SetVowels(Dictionary<...>)`。

        行格式 `小写=大写=发音1,发音2…[=音量]`；**≥3 段**才收；
        重名**后来者覆盖**（上游注释："Assign via indexer to bypass Duplicate Key crashes"）。
        """
        if isinstance(items, dict):
            self.vowels = dict(items)
            return
        d: Dict[str, PresampVowel] = {}
        for line in items:
            parts = line.split('=')
            if len(parts) >= 3:
                v = PresampVowel()
                v.vowel_lower = parts[0]
                v.vowel_upper = parts[1]
                v.phonemes = parts[2].split(',')
                if len(parts) >= 4:
                    try:
                        v.vol = int(parts[3])
                    except ValueError:
                        pass
                d[v.vowel_lower] = v
        self.vowels = d

    def set_consonants(self, items) -> None:
        """对应 `SetConsonants(List<string>)` 与 `SetConsonants(Dictionary<...>)`。

        行格式 `辅音=发音1,发音2…[=1]`；第三段**恰好是 `"1"`** 才置
        `not_clossfade`（`== "1"` 是字符串比较，别改成"非零"）。
        """
        if isinstance(items, dict):
            self.consonants = dict(items)
            return
        d: Dict[str, PresampConsonant] = {}
        for line in items:
            parts = line.split('=')
            if len(parts) >= 2:
                c = PresampConsonant()
                c.consonant = parts[0]
                c.phonemes = parts[1].split(',')
                if len(parts) >= 3 and parts[2] == '1':
                    c.not_clossfade = True
                d[c.consonant] = c
        self.consonants = d

    @staticmethod
    def try_get_lines_from_ini_brocks(blocks, header: str):
        """对应 `TryGetLinesFromIniBrocks(...)` → `(ok, lines)`。

        ★ 方法名里的 **`Brocks` 是上游的拼写错误**（应为 Blocks）。本仓库照搬保留 ——
          与 `MargeExpression`（上游确实是 Marge 不是 Merge）同一原则：
          名字是 API 的一部分，改掉会让"与上游对照"这件事失去锚点。
        """
        for b in blocks or []:
            if getattr(b, 'header', None) == header:
                return True, getattr(b, 'lines', None)
        return False, None
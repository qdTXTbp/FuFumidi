# -*- coding: utf-8 -*-
r"""音节驱动的音素化器基类 —— **照搬**
`OpenUtau.Plugin.Builtin/SyllableBasedPhonemizer.cs`（2204 行）。

这是内置音素化器里最重的一条基类线（`SyllableBased` 家族有 17 个子类）。
它把「一个音符 + 它的延音」切成若干 **Syllable**（`[V] [C..] [V]`）与一个
**Ending**（句末的 `[V] [C..] [tail]`），然后让子类用 `ProcessSyllable` /
`ProcessEnding` 把每个音节翻成别名串，最后由基类统一**对齐到 tick**。

## 与 PhonemeBased 那条线的分工
- `PhonemeBased`：先 G2P 出符号串，再**均匀铺**到音符时长上（`DistributeDuration`）。
- `SyllableBased`：先按**元音位置**切音节，每个音节内部按"辅音从后面往前挤、
  元音占住锚点"的方式排（`MakePhonemes` + `ScalePhonemes`），并且支持
  YAML 配置（`replacements` / `fallbacks` / `vowelsustains` / `isglides`）。

## 照搬时保留的语义（别"整理"掉）
1. ★ **`Syllable` / `Ending` 在 C# 里是 `struct`（值语义）**。这里用 `dataclass`
   承载，凡是 C# 会把结构体**按值传递**的地方都显式 `copy.copy()`，
   否则"改副本不影响原对象"的语义会丢。已显式处理的点：
   - `Process` 里 `var syllable = syllables[i]` → `copy.copy(syllables[i])`
     （所以对 `prevBasePhoneme` / `nextBasePhoneme` 的赋值**不会写回数组**）；
   - `ApplyBoundaryReplacements(Syllable/Ending)` 是**按值**入参 → 内部先 `copy.copy()`。
2. ★ `AssignAllAffixes` 里的 `attr = dynamicAttributes?.FirstOrDefault(...)
   ?? notes[0].phonemeAttributes?.FirstOrDefault(...) ?? default` ——
   因为 `PhonemeAttributes` 是 struct，`FirstOrDefault()` **永远不会返回 null**，
   所以第一个 `??` 只在 `dynamicAttributes == null` 时触发。
   **"回落到 notes[0].phonemeAttributes" 这一支在实践中不可达**（死代码）。照搬。
3. ★ `altExpr.value` 那一步是 `(int)altExpr.value` —— **向零截断**，不是四舍五入。
4. ★ `MakePhonemes` 末尾的 `isEnding ? count-1 : count-1` 两个分支**完全相同**
   （上游笔误），照搬，不"修正"。
5. ★ `containerLength / 3`（`NoGap` 分支）与 `(int)(containerLength * 0.8)`（`ScalePhonemes`）
   都是**整数除 / 向零截断**。
6. ★ `vel = (float)(100.0 - 100.0 * Math.Log2(ratio))` —— `(float)` 是 **float32 舍入**，
   走 `as_float32()`。
7. ★ `Syllable.duration == -1` 是"没有前邻"的哨兵（`IsShort` 靠它跳过判断）。
8. ★ `GetSymbols` 里字典替换的写法是
   `TryGetValue(phoneme)` `else if TryGetValue(subResult[i])` —— **两个键完全相同**，
   第二个分支是死代码。照搬。
9. ★ `ValidateAlias` 最后那段 `if (HasOto(legacyTarget)) return legacyTarget;
   return legacyTarget;` —— **无论如何都返回 legacyTarget**。照搬。
10. ★ `SetSinger` 的 `UpdateYamlIfNeeded` 会把旧版本 YAML **改名备份**再写模板
    （`{名}_backup({版本}){扩展名}`），版本比较用 `System.Version` / `double` 双规则。
11. ★ `SyllableBasedPhonemizer` 的 `Process` 把「tail 当音节」的那种 bucket
    标成 **isEnding = false**；只有句末补的那个 ending 才是 `true`。
12. ★ `TokenizePhonemes` 的 `allKnown` 顺序：`Distinct()`（**保序**）之后再
    `OrderByDescending(length)`（**稳定**排序）—— 不能换成 `set`。
13. ★ `Ending.tail` 为空串时 `HasTail == false`，`ApplyBoundaryReplacements(Ending)`
    会把它当成 `"null"` 占位符参与规则匹配。
14. `consExceptions` 是**声明后从未使用**的死字段（照搬保留）。

## 与 C# 的载体差异（都写在代码注释里）
- **YAML 反序列化**：C# 用 YamlDotNet 的
  `DeserializerBuilder().WithNamingConvention(Underscored).IgnoreUnmatchedProperties()`。
  这里用 PyYAML + 手写 `from_plain()`：**已知键取值、未知键忽略、缺失取默认**，
  与 `IgnoreUnmatchedProperties` 等价；`Replacement.from` 在 Python 是保留字，
  故字段名改为 `from_`（YAML 键仍是 `from`）。
- **`YamlWatcher`** 的后端不可用（Python 无 `FileSystemWatcher`）→ 走
  `classic/yaml_watcher.py` 的**可注入后端**，默认不监视（与 `OtoWatcher` 同一决策）。
- **`SingerManager.Inst.ScheduleReload`** 与 **`VoiceColorRemappingNotification`**
  是应用层单例 → 前者复用 `classic.oto_watcher.scheduler`，后者做成可注入的空实现。
- `lock (currentSinger)` / `lock (builder)` → 一个模块级 `threading.RLock()`
  （C# 的 `lock` 是 `Monitor`，可重入；用 `Lock` 会自锁死 —— 本项目已踩过一次）。
"""

import copy
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..classic.oto_watcher import scheduler as _singer_reload_scheduler
from ..classic.yaml_watcher import YamlWatcher
from ..g2p import G2pDictionary, G2pFallbacks, G2pRemapper, IG2p, IG2pSymbols
from ..music_math import as_float32, idiv
from ..phonemizer import (Note, Phoneme, PhonemeAttributes, PhonemeExpression,
                          Phonemizer, Result)

logger = logging.getLogger(__name__)


# ====================================================================== 常量

#: 对应 `private const string FORCED_ALIAS_SYMBOL = "?"`
FORCED_ALIAS_SYMBOL = '?'

#: 对应 `wordSeparators = new[] { " ", "_" }`（`Split(char[])`：按**任一字符**切）
WORD_SEPARATORS = re.compile(r'[ _]')

#: 对应 `wordSeparator = new[] { "  " }`（两个空格，`Split(string[])`）
WORD_SEPARATOR = '  '

#: 对应 `IsGroupKeyword` 里那个内联数组
GROUP_KEYWORDS = ('vowel', 'vowels', 'consonant', 'consonants',
                  'affricate', 'fricative', 'aspirate', 'semivowel',
                  'liquid', 'nasal', 'stop', 'tap')

#: 对应 C# 的 `?? default`。★ `PhonemeAttributes` 是 **struct**，
#: 所以"取不到"的语义是"字段全空的实例"，不是 `None`。
#: 与 `chinese_cvvc._DEFAULT_ATTR` 是同一个概念（那边先定义，这里同样复用它）。
DEFAULT_ATTR = PhonemeAttributes()

#: C# 的 `lock (...) { }` 是 `Monitor`（**可重入**）。用 `Lock` 会在
#: `HasOto` ← `ValidateAlias` ← `HasOto` 这类嵌套里把自己锁死。
_SINGER_LOCK = threading.RLock()
_BUILDER_LOCK = threading.RLock()

#: 对应 `DocManager.Inst.ExecuteCmd(new VoiceColorRemappingNotification(-1, true))`。
#: 应用层通知，引擎侧默认不做任何事（宿主可替换）。
voice_color_remapping_notifier = lambda: None  # noqa: E731


def _singer_is_loaded(singer) -> bool:
    """对应 C# 的 `USinger.Loaded`（= `Found && Loaded`）。

    ★ 注意 `USinger` 的 `loaded` 字段与 `Loaded` 属性**不是一回事**：
    `Loaded` 还要求 `Found`。测试替身若只有 `loaded` 字段，则按它判断
    （替身要照抄真实现的属性面 —— 见 `phonemizer.mapped_oto` 的教训）。
    """
    if singer is None:
        return False
    is_loaded = getattr(singer, 'is_loaded', None)
    if is_loaded is not None:
        return bool(is_loaded)
    return bool(getattr(singer, 'loaded', False))


def _first_attr_or_default(attributes: Optional[Sequence[PhonemeAttributes]],
                           index: int) -> PhonemeAttributes:
    """对应 `attributes?.FirstOrDefault(a => a.index == index) ?? default`。

    ★ struct 的 `FirstOrDefault` 不会返回 null ——
    所以"没找到"与"attributes 为 null"在这里**都**得到 `default`。
    """
    if attributes is None:
        return DEFAULT_ATTR
    for a in attributes:
        if a.index == index:
            return a
    return DEFAULT_ATTR


# ====================================================================== 结构体


@dataclass
class Syllable:
    """对应 `struct Syllable` —— `[V] [C..] [V]`。"""

    #: 前一个音节的元音（做 VC 用）
    prev_v: str = ''
    #: CC（辅音串），可为空
    cc: List[str] = field(default_factory=list)
    #: "基"音（不一定是元音 —— 只看辅音时它可能就是辅音）
    v: str = ''
    #: 元音的起点。所有 VC / CC 都排在它前面
    position: int = 0
    #: 前一个音符的时长（也就是 VC / CC 的容器）
    duration: int = 0
    #: VC / CC 的 tone
    tone: int = 0
    #: VC / CC 的其它音素属性
    attr: Optional[List[PhonemeAttributes]] = None
    #: 基"元音"音素的 tone
    vowel_tone: int = 0
    #: 基"元音"音素的其它属性
    vowel_attr: Optional[List[PhonemeAttributes]] = None
    #: 0 = 没有从前一词借辅音；1 = 第 1 个是从前一词借的
    prev_word_consonants_count: int = 0
    #: 为 true 时，若元音相同可把音素写成 null 来表示"延续上一个别名"
    can_alias_be_extended: bool = False

    # ---- 前视 / 上下文
    next_v: str = ''
    next_cc: List[str] = field(default_factory=list)
    prev_base_phoneme_value: str = ''
    next_base_phoneme_value: str = ''

    # ---- helpers（全部是纯读出，没有副作用）

    @property
    def next_vowel(self) -> str:
        """对应 `NextVowel => nextV ?? string.Empty`。"""
        return self.next_v or ''

    @property
    def next_cc_safe(self) -> List[str]:
        """对应 `NextCC => nextCc ?? Array.Empty<string>()`。"""
        return self.next_cc or []

    @property
    def prev_base_phoneme(self) -> str:
        return self.prev_base_phoneme_value or ''

    @prev_base_phoneme.setter
    def prev_base_phoneme(self, v: str):
        self.prev_base_phoneme_value = v

    @property
    def next_base_phoneme(self) -> str:
        return self.next_base_phoneme_value or ''

    @next_base_phoneme.setter
    def next_base_phoneme(self, v: str):
        self.next_base_phoneme_value = v

    @property
    def is_starting_v(self) -> bool:
        return self.prev_v == '' and len(self.cc) == 0

    @property
    def is_vv(self) -> bool:
        return self.prev_v != '' and len(self.cc) == 0

    @property
    def is_starting_cv(self) -> bool:
        return self.prev_v == '' and len(self.cc) > 0

    @property
    def is_vcv(self) -> bool:
        return self.prev_v != '' and len(self.cc) > 0

    @property
    def is_starting_cv_with_one_consonant(self) -> bool:
        return self.prev_v == '' and len(self.cc) == 1

    @property
    def is_vcv_with_one_consonant(self) -> bool:
        return self.prev_v != '' and len(self.cc) == 1

    @property
    def is_starting_cv_with_more_than_one_consonant(self) -> bool:
        return self.prev_v == '' and len(self.cc) > 1

    @property
    def is_vcv_with_more_than_one_consonant(self) -> bool:
        return self.prev_v != '' and len(self.cc) > 1

    @property
    def previous_word_cc(self) -> List[str]:
        """对应 `cc.Take(prevWordConsonantsCount).ToArray()`。"""
        return self.cc[:self.prev_word_consonants_count]

    @property
    def current_word_cc(self) -> List[str]:
        """对应 `cc.Skip(prevWordConsonantsCount).ToArray()`。"""
        return self.cc[self.prev_word_consonants_count:]

    def __str__(self):
        return '(%s) %s %s' % (self.prev_v, ' '.join(self.cc) if self.cc else '', self.v)


@dataclass
class Ending:
    """对应 `struct Ending` —— 句末的 `[V] [C..] [tail]`。"""

    #: 最后一个音节的元音（做 VC 用）
    prev_v: str = ''
    #: 句末真正的 CC
    cc: List[str] = field(default_factory=list)
    #: 尾巴的歌词/符号本身（"R" / "br" / "-" 之类）
    tail: str = ''
    #: 最后一个音符的 position + duration；所有音素必须小于它
    position: int = 0
    #: 最后一个音节的长度（VC / CC / C- 的最大容器）
    duration: int = 0
    #: 来自最后一个音节的 tone
    tone: int = 0
    #: 来自最后一个音节的其它属性
    attr: Optional[List[PhonemeAttributes]] = None

    @property
    def has_tail(self) -> bool:
        """对应 `HasTail => !string.IsNullOrEmpty(tail)`。"""
        return bool(self.tail)

    @property
    def is_ending_v(self) -> bool:
        return len(self.cc) == 0

    @property
    def is_ending_vc(self) -> bool:
        return len(self.cc) > 0

    @property
    def is_ending_vc_with_one_consonant(self) -> bool:
        return len(self.cc) == 1

    @property
    def is_ending_vc_with_more_than_one_consonant(self) -> bool:
        return len(self.cc) > 1

    def __str__(self):
        return '(%s) %s' % (self.prev_v, ' '.join(self.cc) if self.cc else '')


# ====================================================================== YAML 模型


@dataclass
class Replacement:
    """对应嵌套类 `Replacement`。`from` 是 Python 保留字 → 字段名 `from_`。"""

    from_: Any = None
    to: Any = None
    where: str = 'inside'

    @property
    def from_list(self) -> List[str]:
        """对应 `FromList`。

        ★ C#：`from is string` → 单元素；`from is IEnumerable<object>` → 逐项
        `ToString() ?? "null"`；**其余 → 空列表**。
        `"null"` 那支在 C# 里其实取不到（`ToString()` 不为 null），
        而真正的 `null` 元素会让 C# 抛 NRE —— 这里对 `None` 元素返回 `"null"`，
        是**有意偏离**（把崩溃换成它本来就想要的那个默认值），已在文档记明。
        """
        return _replacement_list(self.from_)

    @property
    def to_list(self) -> List[str]:
        return _replacement_list(self.to)

    @classmethod
    def from_plain(cls, d: Any) -> 'Replacement':
        if not isinstance(d, dict):
            return cls()
        return cls(from_=d.get('from'), to=d.get('to'), where=d.get('where', 'inside'))


def _replacement_list(v: Any) -> List[str]:
    """`Replacement.FromList` / `ToList` 的共用实现。"""
    if isinstance(v, str):
        return [v]
    if isinstance(v, (list, tuple)):
        return ['null' if x is None else str(x) for x in v]
    return []


@dataclass
class SymbolData:
    """对应 `YAMLData.SymbolData`。"""

    symbol: str = ''
    type: str = ''


@dataclass
class Timeline:
    """对应 `YAMLData.Timings`（类名叫 Timings，这里避免与复数容器混淆）。"""

    symbol: str = ''
    value: float = 0.0


@dataclass
class DiphthongData:
    """对应 `YAMLData.DiphthongData`。"""

    from_: str = ''
    to: str = ''


@dataclass
class VowelSustainData:
    """对应 `YAMLData.VowelSustainData`。"""

    symbol: str = ''
    sustain: str = ''
    offset: float = 0.0


@dataclass
class YAMLData:
    """对应嵌套类 `YAMLData`。

    ★ 数组型字段的默认值是**空数组**（C# `= Array.Empty<T>()`），**不是 null** ——
    所以 `SetSinger` 里 `data.timings != null` 恒真（循环体为空）。
    """

    version: Optional[str] = None
    isglides: Optional[bool] = None
    symbols: List[SymbolData] = field(default_factory=list)
    replacements: List[Replacement] = field(default_factory=list)
    fallbacks: List[Replacement] = field(default_factory=list)
    timings: List[Timeline] = field(default_factory=list)
    diphthongs: List[DiphthongData] = field(default_factory=list)
    vowelsustains: List[VowelSustainData] = field(default_factory=list)

    @classmethod
    def from_plain(cls, d: Any) -> 'YAMLData':
        """对应 `TolerantDeserializer.Deserialize<YAMLData>`（未知键忽略）。"""
        if not isinstance(d, dict):
            return cls()
        data = cls(version=d.get('version'), isglides=d.get('isglides'))
        data.symbols = [SymbolData(symbol=_s(s.get('symbol')), type=_s(s.get('type')))
                        for s in (d.get('symbols') or []) if isinstance(s, dict)]
        data.replacements = [Replacement.from_plain(r)
                             for r in (d.get('replacements') or [])]
        data.fallbacks = [Replacement.from_plain(r)
                          for r in (d.get('fallbacks') or [])]
        data.timings = [Timeline(symbol=_s(t.get('symbol')), value=_f(t.get('value')))
                        for t in (d.get('timings') or []) if isinstance(t, dict)]
        data.diphthongs = [DiphthongData(from_=_s(x.get('from')), to=_s(x.get('to')))
                           for x in (d.get('diphthongs') or []) if isinstance(x, dict)]
        data.vowelsustains = [
            VowelSustainData(symbol=_s(v.get('symbol')), sustain=_s(v.get('sustain')),
                             offset=_f(v.get('offset')))
            for v in (d.get('vowelsustains') or []) if isinstance(v, dict)]
        return data


def _s(v: Any) -> str:
    return v if isinstance(v, str) else ('' if v is None else str(v))


def _f(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ====================================================================== 版本比较


#: 对应 `System.Version.TryParse`（至少 `主.次`，最多四段，缺的段按 **-1** 补）
_VERSION_RE = re.compile(r'^\s*(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$')

#: 对应 `double.TryParse`（InvariantCulture：可选符号 / 小数点 / 指数）
_DOUBLE_RE = re.compile(r'^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$')


def _parse_version(s: str) -> Optional[Tuple[int, int, int, int]]:
    """对应 `Version.TryParse`。**缺的段补 -1**（这正是 `1.2 < 1.2.0` 的原因）。"""
    if s is None:
        return None
    m = _VERSION_RE.match(s)
    if not m:
        return None
    return tuple(int(g) if g is not None else -1 for g in m.groups())  # type: ignore


def _try_parse_double(s: str) -> bool:
    """对应 `double.TryParse(s, out _)`（InvariantCulture）。"""
    return bool(s) and bool(_DOUBLE_RE.match(s.strip()))


def read_version_fast(file_path: str) -> str:
    """对应 `ReadVersionFast`：逐行找 `version:`，取冒号后的第一段并去引号。"""
    try:
        with open(file_path, encoding='utf-8') as f:
            for line in f:
                trimmed = line.strip()
                if trimmed.lower().startswith('version:'):
                    parts = trimmed.split(':', 1)
                    if len(parts) > 1:
                        return parts[1].strip().strip('"\'')
    except OSError:
        pass
    return ''


# ====================================================================== 基类


class SyllableBasedPhonemizer(Phonemizer, IG2pSymbols):
    """对应 `SyllableBasedPhonemizer`（**抽象、不注册**）。"""

    #: 对应 `protected double TransitionBasicLengthMs => 100;`
    TRANSITION_BASIC_LENGTH_MS = 100.0

    # ---- 静态状态（C# 是 `static` 字段，**跨实例共享**）
    global_sbp_generation = 0
    singer_yaml_watcher: Optional[YamlWatcher] = None
    plugin_yaml_watcher: Optional[YamlWatcher] = None
    currently_watched_singer_dir: Optional[str] = None
    currently_watched_plugin_dir: Optional[str] = None
    #: 对应 `private static readonly ConcurrentDictionary<string, (DateTime, YAMLData)> YamlCache`
    yaml_cache: Dict[str, Tuple[float, YAMLData]] = {}

    def __init__(self):
        super().__init__()
        self.local_sbp_generation = 0
        self._singer_loaded = False

        self.singer = None
        #: 对应 `private Dictionary<Type, IG2p> dictionaries`（键是**子类类型**）
        self.dictionaries: Dict[type, IG2p] = {}
        self.error = ''

        #: 对应 `protected HashSet<string> runtimeGlides`
        self.runtime_glides: set = set()
        self.enable_glides = True

        # ---- 符号表（子类多半会覆盖 GetVowels / GetConsonants）
        self.vowels: List[str] = []
        self.consonants: List[str] = []
        #: 对应 `tails = "-,R".Split(',')`
        self.tails: List[str] = ['-', 'R']
        self.affricate: List[str] = []
        self.fricative: List[str] = []
        self.aspirate: List[str] = []
        self.semivowel: List[str] = []
        self.liquid: List[str] = []
        self.nasal: List[str] = []
        self.stop: List[str] = []
        self.tap: List[str] = []

        self.dictionary_replacements: Dict[str, str] = {}
        self.phoneme_overrides: Dict[str, float] = {}
        self.yaml_fallbacks: List[Replacement] = []
        #: 声明后从未使用（照搬 C# 的死字段）
        self.cons_exceptions: List[str] = []
        self.diphthong_tails: Dict[str, str] = {}
        self.diphthong_splits: Dict[str, List[str]] = {}
        self.vowel_sustains: Dict[str, Tuple[str, float]] = {}

        self.merging_replacements: List[Replacement] = []
        self.splitting_replacements: List[Replacement] = []

        # ---- YAML 默认值的备份（`SetSinger` 用它们"重置回默认再叠加"）
        self._backup_vowels: Optional[List[str]] = None
        self._backup_consonants: Optional[List[str]] = None
        self._backup_diphthong_tails: Optional[Dict[str, str]] = None
        self._backup_diphthong_splits: Optional[Dict[str, List[str]]] = None
        self._backup_dictionary_replacements: Optional[Dict[str, str]] = None
        self._backup_vowel_sustains: Optional[Dict[str, Tuple[str, float]]] = None

    # ================================================================== 子类钩子

    def get_vowels(self) -> List[str]:
        """对应**抽象** `GetVowels()`。"""
        raise NotImplementedError

    def get_consonants(self) -> List[str]:
        """对应 `virtual GetConsonants()`（C# 默认**抛 NotImplementedException**）。"""
        raise NotImplementedError

    def process_syllable(self, syllable: Syllable) -> Optional[List[str]]:
        """对应**抽象** `ProcessSyllable`。"""
        raise NotImplementedError

    def process_ending(self, ending: Ending) -> Optional[List[str]]:
        """对应**抽象** `ProcessEnding`。"""
        raise NotImplementedError

    def get_aliases_fallback(self) -> Optional[Dict[str, str]]:
        return None

    def init(self) -> None:
        pass

    def get_dictionary_name(self) -> Optional[str]:
        return None

    def get_base_g2ps(self) -> List[IG2p]:
        return []

    @property
    def enable_phoneme_tokenization(self) -> bool:
        return False

    @property
    def no_gap(self) -> bool:
        """对应 `protected virtual bool NoGap => true;`"""
        return True

    @property
    def yaml_file_name(self) -> Optional[str]:
        return None

    @property
    def yaml_template(self) -> Optional[bytes]:
        return None

    @property
    def yaml_version(self) -> Optional[str]:
        return None

    # ================================================================== 字典状态

    @property
    def has_dictionary(self) -> bool:
        """对应 `hasDictionary => dictionaries.ContainsKey(GetType())`。"""
        return type(self) in self.dictionaries

    @property
    def dictionary(self) -> IG2p:
        """★ 对应 `dictionaries[GetType()]` —— 键不存在时 C# 抛 `KeyNotFoundException`。"""
        return self.dictionaries[type(self)]

    @property
    def is_dictionary_loading(self) -> bool:
        """★ 对应 `dictionaries[GetType()] == null` —— **同样会因缺键而抛**。"""
        return self.dictionaries[type(self)] is None

    # ================================================================== 主流程

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prev_neighbours=None) -> Result:
        """对应 `Process(Note[] notes, ...)`。"""
        self.error = ''
        if self.singer is None or not _singer_is_loaded(self.singer):
            return self.make_simple_result('')
        if self.local_sbp_generation != SyllableBasedPhonemizer.global_sbp_generation:
            self.set_singer(self.singer)
        main_note = notes[0]
        if (main_note.lyric or '').startswith(FORCED_ALIAS_SYMBOL):
            return self._make_forced_alias_result(main_note)
        if self.has_dictionary and self.is_dictionary_loading:
            return self.make_simple_result('')

        self.runtime_glides.clear()

        # 向前看一个 ending（如果存在）
        next_ending = (self.make_ending([next_neighbour])
                       if next_neighbour is not None else None)
        syllables = self.make_syllables(notes, self.make_ending(prev_neighbours or []),
                                        next_ending)
        if syllables is None:
            return self._handle_error()

        predicted_bases = [''] * len(syllables)
        for i in range(len(syllables)):
            mod = self.apply_boundary_replacements_syllable(syllables[i])
            if mod.v in self.tails:
                predicted_bases[i] = mod.v
            else:
                temp_phonemes = self.process_syllable(mod)
                last = temp_phonemes[-1] if temp_phonemes else None
                # ★ `LastOrDefault() ?? mod.v`：只有 **None** 才回落，空串不回落
                predicted_bases[i] = last if last is not None else mod.v

        all_phoneme_symbols: List[str] = []
        #: `(符号串, duration, position, isEnding, tone, vowel)`
        buckets: List[Tuple[List[str], int, int, bool, int, str]] = []
        running_prev_base_phoneme = ''

        for i in range(len(syllables)):
            # ★ C# 的 struct 拷贝：后面写 prevBasePhoneme 不会回写数组
            syllable = copy.copy(syllables[i])
            syllable.prev_base_phoneme = running_prev_base_phoneme
            syllable.next_base_phoneme = (predicted_bases[i + 1]
                                          if i + 1 < len(syllables) else '')

            is_slur_note = i < len(notes) and self.is_syllable_vowel_extension_note(notes[i])

            # 滑音音符且元音与上一个相同 → 跳过边界替换，免得 YAML 插入多余辅音
            if is_slur_note and syllable.prev_v == syllable.v:
                modified_syllable = syllable
            else:
                modified_syllable = self.apply_boundary_replacements_syllable(syllable)

            if modified_syllable.v in self.tails:
                ending = Ending(prev_v=modified_syllable.prev_v,
                                cc=list(modified_syllable.cc),
                                tail=modified_syllable.v,
                                position=modified_syllable.position,
                                duration=modified_syllable.duration,
                                tone=modified_syllable.tone,
                                attr=modified_syllable.attr)
                ending_phonemes = self.process_ending(ending)
                if ending_phonemes:
                    # ★ isEnding = **false**（只有句末补的那个才是 true）
                    buckets.append((list(ending_phonemes), modified_syllable.duration,
                                    modified_syllable.position, False,
                                    modified_syllable.tone, ''))
                    all_phoneme_symbols.extend(ending_phonemes)
                running_prev_base_phoneme = modified_syllable.v
                continue

            syllable_phonemes = self.process_syllable(modified_syllable)
            if syllable_phonemes:
                buckets.append((list(syllable_phonemes), modified_syllable.duration,
                                modified_syllable.position, False,
                                modified_syllable.tone, modified_syllable.v))
                all_phoneme_symbols.extend(syllable_phonemes)
                last = syllable_phonemes[-1]
                running_prev_base_phoneme = last if last is not None else ''

        if next_neighbour is None:
            try_ending = self.make_ending(notes)
            if try_ending is not None:
                modified_ending = self.apply_boundary_replacements_ending(try_ending)
                ending_phonemes = self.process_ending(modified_ending)
                if ending_phonemes:
                    buckets.append((list(ending_phonemes), modified_ending.duration,
                                    modified_ending.position, True,
                                    try_ending.tone, ''))
                    all_phoneme_symbols.extend(ending_phonemes)

        working_attributes = (list(main_note.phoneme_attributes)
                              if main_note.phoneme_attributes is not None else [])
        self.sync_attributes(notes, all_phoneme_symbols, 0, working_attributes)

        phonemes: List[Phoneme] = []
        global_phoneme_index = 0
        for symbols, duration, position, is_ending, tone, vowel in buckets:
            made_phonemes = [p for p in
                             self._make_phonemes(symbols, duration, position, is_ending,
                                                 tone, list(working_attributes),
                                                 global_phoneme_index)
                             if p.phoneme is not None]
            current_count = len(made_phonemes)

            if not is_ending and made_phonemes:
                base_phoneme = made_phonemes[-1]
                base_alias = base_phoneme.phoneme if base_phoneme.phoneme is not None else ''

                sustain = ''
                offset = 0.0
                has_sustain = False
                # ★ C# 的 `out` 变量在 `||` 两侧共用；第一支命中就短路
                if base_alias in self.vowel_sustains:
                    sustain, offset = self.vowel_sustains[base_alias]
                    has_sustain = True
                elif vowel and vowel in self.vowel_sustains:
                    sustain, offset = self.vowel_sustains[vowel]
                    has_sustain = True

                if has_sustain:
                    mapped_sustain = self._validate_alias_if_needed(sustain, tone)
                    if self.has_oto(mapped_sustain, tone) or self.has_oto(sustain, tone):
                        offset_ticks = self.ms_to_tick(
                            self.get_transition_basic_length_ms_by_constant() * offset)
                        made_phonemes.append(Phoneme(
                            phoneme=sustain,
                            position=base_phoneme.position + offset_ticks,
                            index=global_phoneme_index + current_count))
                        current_count += 1

            phonemes.extend(made_phonemes)
            global_phoneme_index += current_count

        # 重新编号，让 UI 看到连续的 0,1,2...
        for i in range(len(phonemes)):
            phonemes[i].index = i

        final_phonemes = self.assign_all_affixes(list(phonemes), notes,
                                                 prev_neighbours or [],
                                                 working_attributes)
        return Result(phonemes=final_phonemes)

    def assign_all_affixes(self, phonemes: List[Phoneme], notes, prevs,
                           dynamic_attributes: Optional[List[PhonemeAttributes]] = None
                           ) -> List[Phoneme]:
        """对应 `AssignAllAffixes`。★ `Phoneme` 在 C# 是 struct：`phonemes[i]` 是**拷贝**。"""
        note_index = 0
        for i in range(len(phonemes)):
            # ★ `dynamicAttributes?.FirstOrDefault(...) ?? notes[0].phonemeAttributes?...`
            #   因为 struct 的 FirstOrDefault 不返回 null，只有 dynamicAttributes 为
            #   **null** 时才会回落到 notes[0] —— 那一支实践上不可达（见模块 docstring 第 2 条）
            if dynamic_attributes is not None:
                attr = _first_attr_or_default(dynamic_attributes, i)
            else:
                attr = _first_attr_or_default(notes[0].phoneme_attributes, i)

            phoneme = phonemes[i]

            alt_value = (attr.alternate if attr.alternate is not None
                         else self.get_parent_alternate())
            alt = str(alt_value) if alt_value is not None else None

            if not alt and phoneme.expressions is not None:
                alt_expr = next((e for e in phoneme.expressions if e.abbr == 'alt'), None)
                if alt_expr is not None and alt_expr.abbr == 'alt' and alt_expr.value > 0:
                    alt_value = int(alt_expr.value)     # ★ (int)double = 向零截断
                    alt = str(alt_value)
            if alt is None:
                alt = ''

            color = (attr.voice_color if attr.voice_color is not None
                     else self.get_parent_voice_color())
            tone_shift = (attr.tone_shift if attr.tone_shift is not None
                          else self.get_parent_tone_shift())

            while (note_index < len(notes) - 1
                   and notes[note_index].position - notes[0].position < phoneme.position):
                note_index += 1

            note_start_position = notes[note_index].position - notes[0].position
            if phoneme.position < note_start_position:
                if note_index > 0:
                    tone = notes[note_index - 1].tone
                elif prevs:
                    tone = prevs[-1].tone
                else:
                    tone = notes[note_index].tone
            else:
                tone = notes[note_index].tone

            validated_alias = phoneme.phoneme
            if validated_alias is not None:
                validated_alias = self._validate_alias_if_needed(validated_alias,
                                                                 tone + tone_shift)
                mapped = self.map_phoneme(validated_alias, tone + tone_shift, color, alt,
                                          self.singer)

                if alt and alt != '0' and mapped == validated_alias:
                    alt_oto = self.mapped_oto('%s%s' % (validated_alias, alt),
                                              tone + tone_shift, color)
                    if alt_oto is not None:
                        mapped = alt_oto.alias

                phoneme.phoneme = mapped

                if alt_value is not None and alt_value > 0:
                    expr_list = (list(phoneme.expressions)
                                 if phoneme.expressions is not None else [])
                    expr_list = [e for e in expr_list if e.abbr != 'alt']
                    expr_list.append(PhonemeExpression(abbr='alt', value=alt_value))
                    phoneme.expressions = expr_list
            else:
                phoneme.phoneme = None
                phoneme.position = 0

            phonemes[i] = phoneme
        return phonemes

    def _handle_error(self) -> Result:
        """对应 `HandleError()`：把 `error` 当成**一个音素名**返回。"""
        return Result(phonemes=[Phoneme(phoneme=self.error)])

    # ================================================================== SetSinger

    def set_singer(self, singer) -> None:
        """对应 `SetSinger` —— 字典 / YAML 装载与缓存。"""
        if (self._singer_loaded and self.singer is singer
                and self.local_sbp_generation == SyllableBasedPhonemizer.global_sbp_generation):
            return

        self.local_sbp_generation = SyllableBasedPhonemizer.global_sbp_generation
        self.singer = singer
        self.dictionaries.clear()

        if self.singer is None or not _singer_is_loaded(self.singer):
            self._singer_loaded = False
            return

        singer_folder = self.singer.location if self.singer.location else None
        self._setup_yaml_watchers(singer_folder, self.plugin_dir)

        if not self.yaml_file_name:
            # ---- 没有 YAML：直接用子类硬编码的表
            if self._backup_vowels is not None:
                self.vowels = self._backup_vowels
            else:
                self.vowels = self.get_vowels()

            if self._backup_consonants is not None:
                self.consonants = self._backup_consonants
            else:
                self.consonants = self.get_consonants()

            if self._backup_dictionary_replacements is not None:
                self.dictionary_replacements.clear()
                self.dictionary_replacements.update(self._backup_dictionary_replacements)

            if not self.has_dictionary:
                self.read_dictionary_and_init()
            else:
                self.init()
            self._singer_loaded = True
            return

        # ---- 有 YAML：全局（插件目录）+ 声库目录 两份，声库的**后解析、覆盖全局**
        global_file = os.path.join(self.plugin_dir, self.yaml_file_name)
        singer_file = (os.path.join(self.singer.location, self.yaml_file_name)
                       if (singer is not None and _singer_is_loaded(singer)
                           and self.singer.location)
                       else None)

        def update_yaml_if_needed(file_path: Optional[str], is_global: bool) -> None:
            """对应 `UpdateYamlIfNeeded`（C# 的**局部函数**，闭包 YamlFileName/Template/Version）。"""
            if not file_path:
                return

            should_write_template = False
            should_backup_old_file = False
            current_version = 'unknown'

            if os.path.isfile(file_path):
                if self.yaml_template is not None and self.yaml_version:
                    try:
                        current_version = read_version_fast(file_path)

                        if not current_version:
                            should_write_template = True
                            should_backup_old_file = True
                        else:
                            curr_v = _parse_version(current_version)
                            target_v = _parse_version(self.yaml_version)
                            if curr_v is not None and target_v is not None:
                                if curr_v < target_v:
                                    should_write_template = True
                                    should_backup_old_file = True
                            elif (current_version != self.yaml_version
                                  and not _try_parse_double(current_version)):
                                # 版本号不是纯数字（如 "1.3b"）时的字符串回落
                                should_write_template = True
                                should_backup_old_file = True
                    except Exception as ex:
                        logger.error("Syntax error detected in '%s'. "
                                     'Skipping template update to protect data. %s',
                                     file_path, ex)
                        return
            elif is_global and self.yaml_template is not None:
                should_write_template = True

            if should_backup_old_file and os.path.isfile(file_path):
                try:
                    safe_version = current_version if current_version else 'unknown'
                    base = os.path.splitext(self.yaml_file_name)
                    backup_name = '%s_backup(%s)%s' % (base[0], safe_version, base[1])
                    backup_file = os.path.join(os.path.dirname(file_path), backup_name)
                    if os.path.isfile(backup_file):
                        os.remove(backup_file)
                    os.replace(file_path, backup_file)
                    logger.info('Old %s backed up to %s', self.yaml_file_name, backup_file)
                except Exception as e:
                    logger.error('Failed to back up %s. Aborting overwrite. %s',
                                 file_path, e)
                    return

            if should_write_template:
                try:
                    with open(file_path, 'wb') as f:
                        f.write(self.yaml_template)
                    logger.info("'%s' created or updated to version %s",
                                file_path, self.yaml_version or 'default')
                except Exception as e:
                    logger.error('Failed to write template to %s: %s', file_path, e)

        update_yaml_if_needed(global_file, True)
        update_yaml_if_needed(singer_file, False)

        # 解析顺序：全局在前、声库在后（声库覆盖全局）
        files_to_parse: List[str] = []
        if os.path.isfile(global_file):
            files_to_parse.append(global_file)
        if singer_file and os.path.isfile(singer_file):
            files_to_parse.append(singer_file)

        # 备份硬编码默认值（只备一次）
        if self._backup_vowels is None:
            self._backup_vowels = self.get_vowels() or []
        if self._backup_consonants is None:
            self._backup_consonants = self.get_consonants() or []
        if self._backup_dictionary_replacements is None:
            self._backup_dictionary_replacements = dict(self.dictionary_replacements)
        if self._backup_diphthong_tails is None:
            self._backup_diphthong_tails = dict(self.diphthong_tails)
        if self._backup_diphthong_splits is None:
            self._backup_diphthong_splits = dict(self.diphthong_splits)

        # 叠加前先"重置回默认"
        self.vowels = self._backup_vowels
        self.consonants = self._backup_consonants
        # ★ 注意这里把 tails 重置成 **只有 "-"**（不是字段默认的 ['-','R']）
        self.tails = '-'.split(',')

        self.fricative = []
        self.aspirate = []
        self.semivowel = []
        self.liquid = []
        self.nasal = []
        self.stop = []
        self.tap = []
        self.affricate = []

        self.dictionary_replacements.clear()
        self.dictionary_replacements.update(self._backup_dictionary_replacements)

        self.diphthong_tails.clear()
        self.diphthong_tails.update(self._backup_diphthong_tails)

        self.diphthong_splits.clear()
        self.diphthong_splits.update(self._backup_diphthong_splits)

        self.merging_replacements.clear()
        self.splitting_replacements.clear()
        self.yaml_fallbacks.clear()
        self.phoneme_overrides.clear()
        if self._backup_vowel_sustains is None:
            self._backup_vowel_sustains = dict(self.vowel_sustains)
        self.vowel_sustains.clear()
        self.vowel_sustains.update(self._backup_vowel_sustains)

        for file in files_to_parse:
            try:
                data = self._load_yaml_cached(file)
                if data is None:
                    continue

                if data.symbols:
                    symbol_lookup: Dict[str, List[str]] = {}
                    for s in data.symbols:
                        # `.Where(s => !IsNullOrEmpty(symbol) && !IsNullOrEmpty(type))`
                        if s.symbol and s.type:
                            symbol_lookup.setdefault(s.type, []).append(s.symbol)

                    def sl(key: str) -> List[str]:
                        return symbol_lookup.get(key, [])

                    yaml_vowels = sl('vowel') + sl('diphthong')
                    self.vowels = _concat_distinct(yaml_vowels, self.vowels)

                    self.tails = _concat_distinct(sl('tail'), self.tails)

                    y_fricative = sl('fricative')
                    self.fricative = _concat_distinct(y_fricative, self.fricative)
                    y_aspirate = sl('aspirate')
                    self.aspirate = _concat_distinct(y_aspirate, self.aspirate)
                    y_semivowel = sl('semivowel')
                    self.semivowel = _concat_distinct(y_semivowel, self.semivowel)
                    y_liquid = sl('liquid')
                    self.liquid = _concat_distinct(y_liquid, self.liquid)
                    y_nasal = sl('nasal')
                    self.nasal = _concat_distinct(y_nasal, self.nasal)
                    y_stop = sl('stop')
                    self.stop = _concat_distinct(y_stop, self.stop)
                    y_tap = sl('tap')
                    self.tap = _concat_distinct(y_tap, self.tap)
                    y_affricate = sl('affricate')
                    self.affricate = _concat_distinct(y_affricate, self.affricate)

                    yaml_consonants = (y_fricative + y_aspirate + y_semivowel + y_liquid
                                       + y_nasal + y_stop + y_tap + y_affricate)
                    self.consonants = _concat_distinct(yaml_consonants, self.consonants)

                    # 双元音的自动尾巴检测
                    yaml_diphthongs = _distinct(sl('diphthong'))
                    for d in yaml_diphthongs:
                        custom = next((x for x in data.diphthongs if x.from_ == d), None)
                        if custom is not None and custom.to:
                            self.diphthong_tails[d] = custom.to
                        else:
                            self.diphthong_tails[d] = d + '-'

                if data.isglides is not None:
                    self.enable_glides = data.isglides

                for t in data.timings:
                    self.phoneme_overrides[t.symbol] = t.value

                if data.replacements:
                    local_merge: List[Replacement] = []
                    local_split: List[Replacement] = []

                    for raw in data.replacements:
                        from_key = _replacement_from_key(raw.from_)
                        self.merging_replacements = [
                            r for r in self.merging_replacements
                            if _replacement_from_key(r.from_) != from_key]
                        self.splitting_replacements = [
                            r for r in self.splitting_replacements
                            if _replacement_from_key(r.from_) != from_key]

                        if isinstance(raw.from_, str):
                            self.dictionary_replacements.pop(raw.from_, None)

                        from_list = raw.from_list
                        to_list = raw.to_list
                        parsed_from: Any = from_list[0] if len(from_list) == 1 else list(from_list)
                        parsed_to: Any = to_list[0] if len(to_list) == 1 else list(to_list)

                        clean = Replacement(from_=parsed_from, to=parsed_to, where=raw.where)
                        if isinstance(parsed_from, str):
                            local_split.append(clean)
                        else:
                            local_merge.append(clean)

                    self.merging_replacements[0:0] = local_merge
                    self.splitting_replacements[0:0] = local_split

                if data.fallbacks:
                    local_fallbacks = [df for df in data.fallbacks
                                       if len(df.from_list) > 0 and len(df.to_list) > 0]
                    self.yaml_fallbacks[0:0] = local_fallbacks

                for d in data.diphthongs:
                    if d.from_ and d.to:
                        self.diphthong_tails[d.from_] = d.to

                for v in data.vowelsustains:
                    if v.symbol and v.sustain:
                        self.vowel_sustains[v.symbol] = (v.sustain, v.offset)

            except Exception as ex:
                logger.error('Failed to parse %s: %s', file, ex)

        if not self.has_dictionary:
            self.read_dictionary_and_init()
        else:
            self.init()
        self._singer_loaded = True

    # ---- YAML watcher（C# 是 static 字段 + 一次性安装）

    def _setup_yaml_watchers(self, singer_dir: Optional[str],
                             plugin_dir: Optional[str]) -> None:
        """对应 `SetupYamlWatchers`。"""
        cls = SyllableBasedPhonemizer

        if singer_dir and cls.currently_watched_singer_dir != singer_dir:
            if cls.singer_yaml_watcher is not None:
                cls.singer_yaml_watcher.dispose()
            cls.singer_yaml_watcher = None
            cls.currently_watched_singer_dir = singer_dir

            if os.path.isdir(singer_dir):
                cls.singer_yaml_watcher = YamlWatcher(
                    singer_dir, lambda: self._on_yaml_changed(singer_dir, 'Singer'))

        if plugin_dir and cls.currently_watched_plugin_dir != plugin_dir:
            if cls.plugin_yaml_watcher is not None:
                cls.plugin_yaml_watcher.dispose()
            cls.plugin_yaml_watcher = None
            cls.currently_watched_plugin_dir = plugin_dir

            if os.path.isdir(plugin_dir):
                cls.plugin_yaml_watcher = YamlWatcher(
                    plugin_dir, lambda: self._on_yaml_changed(plugin_dir, 'Global Plugin'))

    def _on_yaml_changed(self, directory: str, kind: str) -> None:
        """两个 watcher 回调的共同实现（C# 里是两段几乎相同的 lambda）。"""
        logger.info("[SyllableBasedPhonemizer] %s YAML change detected in '%s'. Reloading...",
                    kind, directory)
        time.sleep(0.2)
        SyllableBasedPhonemizer.yaml_cache.clear()
        SyllableBasedPhonemizer.global_sbp_generation += 1
        self._singer_loaded = False

        if self.singer is not None:
            _singer_reload_scheduler.schedule_reload(self.singer)
            try:
                voice_color_remapping_notifier()
            except Exception:
                pass

    # ---- YAML 读盘缓存

    @staticmethod
    def clear_yaml_cache() -> None:
        SyllableBasedPhonemizer.yaml_cache.clear()

    @classmethod
    def _load_yaml_cached(cls, file_path: str) -> Optional[YAMLData]:
        """对应 `LoadYamlCached`：按「全路径 + 最后修改时间」缓存。"""
        full_path = os.path.abspath(file_path)
        try:
            last_write = os.path.getmtime(full_path)
        except OSError:
            last_write = 0.0

        cached = cls.yaml_cache.get(full_path)
        if cached is not None and cached[0] == last_write:
            return cached[1]

        try:
            import yaml
            with open(full_path, encoding='utf-8-sig') as f:
                parsed = YAMLData.from_plain(yaml.safe_load(f))
            cls.yaml_cache[full_path] = (last_write, parsed)
            return parsed
        except Exception as ex:
            logger.error("Failed to deserialize YAML at '%s': %s", full_path, ex)
            return None

    # ================================================================== 配置文件

    def read_dictionary_and_init(self) -> None:
        """对应 `ReadDictionaryAndInit`。"""
        dictionary_name = self.get_dictionary_name()
        if dictionary_name is None and not self.yaml_file_name:
            return
        try:
            self._read_dictionary(dictionary_name)
            self.init()
        except Exception as ex:
            logger.error('Failed to read dictionary %s: %s', dictionary_name, ex)

    def _read_dictionary(self, dictionary_name: Optional[str]) -> None:
        """对应 `ReadDictionary`。"""
        try:
            phoneme_symbols: Dict[str, bool] = {}

            for vowel in self.get_vowels():
                phoneme_symbols[vowel] = True
            for consonant in (self.consonants if len(self.consonants) > 0
                              else self.get_consonants()):
                phoneme_symbols[consonant] = False

            child_dict = self.get_dictionary_phonemes_replacement() or {}
            safe_dict = dict(child_dict)

            self.dictionaries[type(self)] = G2pRemapper(
                self.load_base_dictionary(), phoneme_symbols, safe_dict)
        except Exception as ex:
            logger.error('Failed to read dictionary %s: %s', dictionary_name, ex)

    def load_base_dictionary(self) -> IG2p:
        """对应 `LoadBaseDictionary`。"""
        g2ps: List[IG2p] = []

        if self.yaml_file_name:
            path = os.path.join(self.plugin_dir, self.yaml_file_name)

            if not os.path.isfile(path) and self.yaml_template is not None:
                os.makedirs(self.plugin_dir, exist_ok=True)
                with open(path, 'wb') as f:
                    f.write(self.yaml_template)

            # 声库目录的（最高优先）
            # ★ C# 写的是 `singer.Found && singer.Loaded`，而 `Loaded` 本身就含 `Found`，
            #   所以等价于 `singer.Loaded` —— 统一走 `_singer_is_loaded()`，
            #   免得测试替身（只有 `loaded` 没有 `is_loaded`）在这里炸 AttributeError。
            if _singer_is_loaded(self.singer):
                file = os.path.join(self.singer.location, self.yaml_file_name)
                if os.path.isfile(file):
                    try:
                        with open(file, encoding='utf-8-sig') as f:
                            g2ps.append(G2pDictionary.new_builder().load(f.read()).build())
                    except Exception as e:
                        logger.error('Failed to load %s: %s', file, e)

            # 插件目录的（回落）
            if os.path.isfile(path):
                try:
                    with open(path, encoding='utf-8-sig') as f:
                        g2ps.append(G2pDictionary.new_builder().load(f.read()).build())
                except Exception as e:
                    logger.error('Failed to load %s: %s', path, e)
        else:
            dictionary_name = self.get_dictionary_name()
            if dictionary_name:
                filename = os.path.join(self.dictionaries_path, dictionary_name)
                if os.path.isfile(filename):
                    with open(filename, encoding='utf-8-sig') as f:
                        dictionary_text = f.read()
                    builder = G2pDictionary.new_builder()
                    for vowel in self.get_vowels():
                        builder.add_symbol(vowel, True)
                    for consonant in self.get_consonants():
                        builder.add_symbol(consonant, False)
                    builder.add_entry('a', ['a'])
                    self.parse_dictionary(dictionary_text, builder)
                    g2ps.append(builder.build())

        child_g2ps = self.get_base_g2ps()
        if child_g2ps:
            g2ps.extend(child_g2ps)

        return G2pFallbacks(g2ps)

    def parse_dictionary(self, dictionary_text: str, builder) -> None:
        """对应 `ParseDictionary`（C# 的注释写着 "Is Running Async!"，其实**不是**异步）。

        格式：`词` + **两个空格** + `音素 音素 ...`；`;;;` 开头是注释。
        ★ `line.Trim().Split({"  "}, StringSplitOptions.None)` —— **保留空段**，
        所以分隔符前后的空格会被算进 part 里。
        """
        replacements = self.get_dictionary_phonemes_replacement()
        for line in re.split(r'\r\n|\n', dictionary_text):
            if not line:                                   # RemoveEmptyEntries
                continue
            if line.startswith(';;;'):
                continue
            parts = line.strip().split(WORD_SEPARATOR)
            if len(parts) != 2:
                continue
            key = parts[0].lower()
            values = [(replacements[n] if (replacements and n in replacements) else n)
                      for n in self.get_dictionary_word_phonemes(parts[1])]
            with _BUILDER_LOCK:
                builder.add_entry(key, values)

    def get_dictionary_word_phonemes(self, phonemes_string: str) -> List[str]:
        """对应 `GetDictionaryWordPhonemes`（默认按**单空格**切）。"""
        return phonemes_string.split(' ')

    def get_dictionary_phonemes_replacement(self) -> Dict[str, str]:
        """对应 `GetDictionaryPhonemesReplacement`（默认给 `dictionaryReplacements`）。"""
        return self.dictionary_replacements

    # ================================================================== 音节切分

    def make_syllables(self, input_notes, prev_ending: Optional[Ending],
                       next_ending: Optional[Ending] = None
                       ) -> Optional[List[Syllable]]:
        """对应 `MakeSyllables`：把符号串切成音节（不含句末 ending）。"""
        symbols, vowel_ids, notes = self._get_symbols_and_vowels(input_notes)
        if symbols is None or vowel_ids is None or notes is None:
            return None
        first_vowel_id = vowel_ids[0]
        if len(notes) < len(vowel_ids):
            self.error = ('Not enough extension notes, %d more expected'
                          % (len(vowel_ids) - len(notes)))
            return None

        syllables: List[Optional[Syllable]] = [None] * len(vowel_ids)

        if prev_ending is not None:
            beginning_cc = list(prev_ending.cc)
            beginning_cc.extend(symbols[:first_vowel_id])
            syllables[0] = Syllable(
                prev_v=prev_ending.prev_v,
                cc=beginning_cc,
                v=symbols[first_vowel_id],
                tone=prev_ending.tone,
                attr=prev_ending.attr,
                duration=prev_ending.duration,
                position=0,
                vowel_tone=notes[0].tone,
                vowel_attr=notes[0].phoneme_attributes,
                prev_word_consonants_count=len(prev_ending.cc))
        else:
            syllables[0] = Syllable(
                prev_v='',
                cc=list(symbols[:first_vowel_id]),
                v=symbols[first_vowel_id],
                tone=notes[0].tone,
                attr=notes[0].phoneme_attributes,
                duration=-1,                      # ★ -1 = "没有前邻"的哨兵
                position=0,
                vowel_tone=notes[0].tone,
                vowel_attr=notes[0].phoneme_attributes)

        note_i = 1
        ccs: List[str] = []
        position = 0
        last_symbol_i = first_vowel_id + 1
        # ★ C# 用的是**单个** `&`（非短路位与）。两个操作数都是纯的，语义等同于 `&&`
        while last_symbol_i < len(symbols) and note_i < len(notes):
            if last_symbol_i not in vowel_ids:
                ccs.append(symbols[last_symbol_i])
            else:
                position += notes[note_i - 1].duration
                syllables[note_i] = Syllable(
                    prev_v=syllables[note_i - 1].v,
                    cc=list(ccs),
                    v=symbols[last_symbol_i],
                    tone=notes[note_i - 1].tone,
                    attr=notes[note_i - 1].phoneme_attributes,
                    duration=notes[note_i - 1].duration,
                    position=position,
                    vowel_tone=notes[note_i].tone,
                    vowel_attr=notes[note_i].phoneme_attributes,
                    can_alias_be_extended=True)
                ccs = []
                note_i += 1
            last_symbol_i += 1

        for i in range(len(syllables)):
            if i < len(syllables) - 1:
                syllables[i].next_v = syllables[i + 1].v
                syllables[i].next_cc = list(syllables[i + 1].cc or [])
            elif next_ending is not None:
                syllables[i].next_v = next_ending.prev_v
                syllables[i].next_cc = list(next_ending.cc or [])
            else:
                syllables[i].next_v = ''
                syllables[i].next_cc = []

        return syllables

    def make_ending(self, input_notes) -> Optional[Ending]:
        """对应 `MakeEnding`。"""
        if (not input_notes
                or (input_notes[0].lyric or '').startswith(FORCED_ALIAS_SYMBOL)):
            return None

        symbols, vowel_ids, notes = self._get_symbols_and_vowels(input_notes)
        if symbols is None or vowel_ids is None or notes is None:
            return None

        return Ending(
            prev_v=symbols[vowel_ids[-1]],
            cc=list(symbols[vowel_ids[-1] + 1:]),
            tone=notes[-1].tone,
            attr=notes[-1].phoneme_attributes,
            duration=sum(n.duration for n in notes[len(vowel_ids) - 1:]),
            position=sum(n.duration for n in notes))

    def _get_symbols_and_vowels(self, notes):
        """对应 `GetSymbolsAndVowels`（私有）。"""
        main_note = notes[0]
        symbols = self.get_symbols(main_note)
        if symbols is None:
            return None, None, None
        if len(symbols) == 0:
            symbols = ['']

        symbols = self.apply_replacements(list(symbols), False)
        symbols = self._apply_extensions(symbols, notes)
        vowel_ids = self._extract_vowels(symbols)
        if len(vowel_ids) == 0:
            vowel_ids.append(len(symbols) - 1)
        if len(notes) < len(vowel_ids):
            notes = self.handle_not_enough_notes(notes, vowel_ids)
        return symbols, vowel_ids, notes

    def handle_not_enough_notes(self, notes, vowel_ids: List[int]):
        """对应 `HandleNotEnoughNotes`：音节比音符多时，把**最后一个音符**切碎。"""
        new_notes = list(notes[:-1])                     # SkipLast(1)
        last_note = notes[-1]
        position = last_note.position
        notes_to_split = len(vowel_ids) - len(new_notes)
        # ★ C#：`lastNote.duration / notesToSplit / 15 * 15` —— 整数除法链
        duration = idiv(idiv(last_note.duration, notes_to_split), 15) * 15
        for i in range(notes_to_split):
            duration_final = (duration if i != notes_to_split - 1
                              else last_note.duration - duration * (notes_to_split - 1))
            new_notes.append(Note(position=position, duration=duration_final,
                                  tone=last_note.tone,
                                  phoneme_attributes=last_note.phoneme_attributes))
            position += duration_final
        return new_notes

    def handle_word_not_found(self, note: Note) -> Optional[List[str]]:
        """对应 `HandleWordNotFound`：把"映射后的歌词"或 `"word not found"` 记进 `error`。"""
        attr = _first_attr_or_default(note.phoneme_attributes, 0)
        alt_obj = (attr.alternate if attr.alternate is not None
                   else self.get_parent_alternate())
        alt = str(alt_obj) if alt_obj is not None else ''
        color = (attr.voice_color if attr.voice_color is not None
                 else self.get_parent_voice_color())
        tone_shift = (attr.tone_shift if attr.tone_shift is not None
                      else self.get_parent_tone_shift())
        mpdlyric = self.map_phoneme(note.lyric, note.tone + tone_shift, color, alt, self.singer)
        if self.has_oto(mpdlyric, note.tone):
            self.error = mpdlyric
        else:
            self.error = 'word not found'
        return None

    def is_syllable_vowel_extension_note(self, note: Note) -> bool:
        """对应 `IsSyllableVowelExtensionNote`：歌词以 `+~` / `+*` 开头。"""
        return note.lyric.startswith('+~') or note.lyric.startswith('+*')

    def replace_phoneme(self, phoneme: str, tone: int) -> str:
        """对应 `ReplacePhoneme`。"""
        if not phoneme:
            return ''
        replaced = self.dictionary_replacements.get(phoneme)
        if replaced is not None:
            return replaced
        return phoneme

    # ================================================================== 别名校验

    def validate_alias(self, alias: str, tone: int = 0) -> str:
        """对应 `ValidateAlias`：oto 里没有这个别名时，按 YAML fallbacks 做子串替换。"""
        if not alias:
            return alias
        if self.singer is None or not _singer_is_loaded(self.singer):
            return alias
        if self.has_oto(alias, tone):
            return alias

        # `Where(Count == 1).OrderByDescending(FromList[0].Length)` —— 稳定排序
        single_rules = sorted([r for r in self.yaml_fallbacks if len(r.from_list) == 1],
                              key=lambda r: len(r.from_list[0]), reverse=True)

        # 第一段：**只**替换那一个缺失的 token（例如 "x uw" → "sh uw"）
        for rule in single_rules:
            from_str = rule.from_list[0].strip('()')
            if from_str in alias:
                for target in rule.to_list:
                    candidate = alias.replace(from_str, target)
                    if self.has_oto(candidate, tone):
                        return candidate

        # 第二段：级联回落（只在第一段完全失败时走）
        cascaded_alias = alias
        changed = False

        for rule in single_rules:
            from_str = rule.from_list[0].strip('()')
            if from_str in cascaded_alias:
                for target in rule.to_list:
                    candidate = cascaded_alias.replace(from_str, target)
                    if self.has_oto(candidate, tone):
                        return candidate
                if rule.to_list:
                    cascaded_alias = cascaded_alias.replace(from_str, rule.to_list[0])
                    changed = True

        if changed and self.has_oto(cascaded_alias, tone):
            return cascaded_alias

        legacy_fallbacks = self.get_aliases_fallback()
        if legacy_fallbacks is not None and alias in legacy_fallbacks:
            legacy_target = legacy_fallbacks[alias]
            # ★ 两行 C# 都 `return legacyTarget` —— HasOto 判了等于没判
            if self.has_oto(legacy_target, tone):
                return legacy_target
            return legacy_target

        return cascaded_alias if changed else alias

    def _validate_alias_if_needed(self, alias: str, tone: int) -> str:
        """对应 `ValidateAliasIfNeeded`（现在就是 `ValidateAlias`）。"""
        return self.validate_alias(alias, tone)

    # ================================================================== 过渡时长

    def get_transition_basic_length_ms(self, alias: str = '', tone: int = 0,
                                       attr: Optional[PhonemeAttributes] = None) -> float:
        """对应**两个**重载 `GetTransitionBasicLengthMs(string)` 与
        `GetTransitionBasicLengthMs(string, int, PhonemeAttributes)`（后者转调前者）。

        ★ 子类若覆盖，请保留 `(self, alias='', tone=0, attr=None)` 的签名。
        """
        return self.get_transition_basic_length_ms_by_constant()

    def get_transition_basic_length_ms_by_constant(self) -> float:
        """对应 `GetTransitionBasicLengthMsByConstant`。"""
        return self.TRANSITION_BASIC_LENGTH_MS * self.get_tempo_note_length_factor()

    def get_transition_multiplier(self, alias: Optional[str]) -> float:
        """对应 `GetTransitionMultiplier`：YAML `timings` 里的逐符号倍率。"""
        if alias is not None and self.phoneme_overrides and alias in self.phoneme_overrides:
            return self.phoneme_overrides[alias]
        return 1.0

    def get_transition_basic_length_ms_by_oto(self, alias: str, tone: int = 0,
                                              attr: Optional[PhonemeAttributes] = None
                                              ) -> float:
        """对应 `GetTransitionBasicLengthMsByOto`：按命中 oto 的 `Preutter` 算。"""
        if not alias:
            return self.get_transition_basic_length_ms_by_constant()

        if attr is None:
            attr = DEFAULT_ATTR
        color = attr.voice_color if attr.voice_color is not None else ''
        alt = str(attr.alternate) if attr.alternate is not None else ''
        tone_shift = attr.tone_shift if attr.tone_shift is not None else 0

        validated_alias = self._validate_alias_if_needed(alias, tone + tone_shift)
        mapped_alias = self.map_phoneme(validated_alias, tone + tone_shift, color, alt,
                                        self.singer)

        if alt and alt != '0' and mapped_alias == validated_alias:
            alt_oto = self.mapped_oto('%s%s' % (validated_alias, alt), tone + tone_shift, color)
            if alt_oto is not None:
                mapped_alias = alt_oto.alias

        # ★ 这里是 C# 的 **2 参**重载 → color 传 None（不是空串）
        oto = self.mapped_oto(mapped_alias, tone + tone_shift)
        if oto is not None:
            if oto.overlap < 0:
                return oto.preutter - oto.overlap
            return oto.preutter

        return self.get_transition_basic_length_ms_by_constant()

    def get_tempo_note_length_factor(self) -> float:
        """对应 `GetTempoNoteLengthFactor`：1 → 0.3 的音符长度系数。"""
        return (300 - max(90, min(300, self.bpm))) / (300 - 90) / 3 + 0.33

    # ================================================================== 属性钩子

    def sync_attributes(self, notes, phoneme_symbols: List[str], start_index: int,
                        attr_list: List[PhonemeAttributes]) -> None:
        """对应 `SyncAttributes`。"""
        for i in range(len(phoneme_symbols)):
            global_idx = start_index + i
            existing_idx = next((k for k, a in enumerate(attr_list)
                                 if a.index == global_idx), -1)
            attr = (attr_list[existing_idx] if existing_idx >= 0
                    else PhonemeAttributes(index=global_idx))

            attr = self.get_dynamic_phoneme_attributes(phoneme_symbols[i], global_idx,
                                                       attr, notes)

            if existing_idx >= 0:
                attr_list[existing_idx] = attr
            else:
                attr_list.append(attr)

    def get_dynamic_phoneme_attributes(self, alias: str, index: int,
                                       current_attr: PhonemeAttributes, notes
                                       ) -> PhonemeAttributes:
        """对应 `GetDynamicPhonemeAttributes`（默认原样返回）。"""
        return current_attr

    def is_short(self, syllable_or_ending) -> bool:
        """对应**两个**重载 `IsShort(Syllable)` / `IsShort(Ending)`。"""
        if isinstance(syllable_or_ending, Ending):
            return self.tick_to_ms(syllable_or_ending.duration) \
                < self.get_transition_basic_length_ms() * 2
        return (syllable_or_ending.duration != -1
                and self.tick_to_ms(syllable_or_ending.duration)
                < self.get_transition_basic_length_ms() * 2)

    # ================================================================== oto 查询

    def has_oto(self, alias: str, tone: int) -> bool:
        """对应 `HasOto`：三段试查（带音高 → 裸别名 → 空音色）。"""
        current_singer = self.singer
        if current_singer is None or not _singer_is_loaded(current_singer) or not alias:
            return False

        try:
            # ★ C# 是 `lock (currentSinger)`（可重入 Monitor）→ 这里用模块级 RLock
            with _SINGER_LOCK:
                if not _singer_is_loaded(current_singer):
                    return False
                if self.mapped_oto(alias, tone) is not None:
                    return True
                if current_singer.try_get_oto(alias)[0]:
                    return True
                if self.mapped_oto(alias, tone, '') is not None:
                    return True
        except (RuntimeError, KeyError) as ex:
            logger.error('Race/corruption detected in HasOto: singer %r, alias %r, tone %s: %s',
                         getattr(current_singer, 'id', '?'), alias, tone, ex)
            raise
        return False

    def try_add_phoneme(self, source_phonemes: List[str], tone: int, *target_phonemes,
                        is_glide: bool = False) -> bool:
        """对应**两个**重载：`TryAddPhoneme(list, tone, params string[])` 与
        `TryAddPhoneme(list, tone, bool isGlide, params string[])`。

        ★ Python 没有重载，这里用**仅关键字参数** `is_glide` 选择：
        `try_add_phoneme(lst, tone, 'a', 'b')` → 前者；加 `is_glide=True` → 后者。
        （C# 里第二个重载会顺带把这个音素登记成滑音。）
        """
        for phoneme in target_phonemes:
            if self.has_oto(phoneme, tone):
                source_phonemes.append(phoneme)
                if is_glide:
                    self.glides(phoneme)
                return True
        return False

    def can_make_alias_extension(self, syllable: Syllable) -> bool:
        """对应 `CanMakeAliasExtension`。"""
        return (syllable.can_alias_be_extended and syllable.prev_v == syllable.v
                and len(syllable.cc) == 0)

    def are_tones_from_the_same_subbank(self, tone1: int, tone2: int) -> bool:
        """对应 `AreTonesFromTheSameSubbank`。"""
        subbanks = self.singer.subbanks
        if len(subbanks) == 1:
            return True
        if tone1 == tone2:
            return True
        for subbank in subbanks:
            tone_set = subbank.tone_set
            if tone1 in tone_set and tone2 in tone_set:
                return True
            if (tone1 in tone_set) != (tone2 in tone_set):
                return False
        return True

    # ================================================================== 符号 → 音节

    def get_symbols(self, note: Note) -> Optional[List[str]]:
        """对应 `virtual string[] GetSymbols(Note)`（同时就是 `IG2pSymbols.GetSymbols`）。"""
        def get_symbols_raw(lyrics: str) -> List[str]:
            if not lyrics:
                return []
            # 回落：只按空格切分
            if not self.enable_phoneme_tokenization:
                return [s for s in lyrics.split(' ') if s]
            if ' ' in lyrics:
                parts = [s for s in lyrics.split(' ') if s]
                result_list: List[str] = []
                for part in parts:
                    result_list.extend(self.tokenize_phonemes(part))
                return result_list
            return self.tokenize_phonemes(lyrics)

        if note.lyric in self.tails:
            return [note.lyric]

        if self.has_dictionary:
            if note.phonetic_hint:
                return get_symbols_raw(note.phonetic_hint)

            result: List[str] = []
            subwords = [s for s in WORD_SEPARATORS.split(note.lyric.strip().lower()) if s]
            for subword in subwords:
                sub_result = self.dictionary.query(subword)
                if sub_result is None:
                    sub_result = self.handle_word_not_found(note)
                    if sub_result is None:
                        return None
                else:
                    for i in range(len(sub_result)):
                        phoneme = sub_result[i]
                        if phoneme in self.dictionary_replacements:
                            sub_result[i] = self.dictionary_replacements[phoneme]
                        elif sub_result[i] in self.dictionary_replacements:
                            # ★ 与上一行**同一个键** —— 死代码（照搬）
                            sub_result[i] = self.dictionary_replacements[sub_result[i]]
                result.extend(sub_result)
            return result
        return get_symbols_raw(note.lyric)

    def tokenize_phonemes(self, raw: str) -> List[str]:
        """对应 `TokenizePhonemes`：贪心最长匹配（"kwh" / "sh" / "dx" 优先）。"""
        tokens: List[str] = []
        if not raw:
            return tokens

        known_vowels = self.get_vowels() or []
        known_consonants = ((self.consonants
                             if self.consonants is not None and len(self.consonants) > 0
                             else (self.get_consonants() or [])))

        # ★ `Where(nonEmpty).Distinct().OrderByDescending(s.Length)`：
        #   Distinct **保序**，OrderByDescending **稳定** —— 不能用 set 顶替
        merged = list(known_vowels) + list(known_consonants) + list(self.tails or [])
        uniq = _distinct([s for s in merged if s])
        all_known = sorted(uniq, key=len, reverse=True)

        i = 0
        while i < len(raw):
            matched = False
            for symbol in all_known:
                if raw.startswith(symbol, i):
                    tokens.append(symbol)
                    i += len(symbol)
                    matched = True
                    break
            if not matched:
                tokens.append(raw[i])
                i += 1
        return tokens

    def is_glide(self, alias: str) -> bool:
        """对应 `IsGlide`：只有被 `glides()` 动态标记过、且 `enableGlides` 为真才算。"""
        return alias in self.runtime_glides and self.enable_glides

    def glides(self, alias: str) -> None:
        """对应 `glides(alias)`：在 `ProcessSyllable` / `ProcessEnding` 里标一个滑音。"""
        self.runtime_glides.add(alias)

    # ================================================================== 边界替换

    def is_group_keyword(self, rule_phoneme: str) -> bool:
        """对应 `IsGroupKeyword`。"""
        clean_rule = rule_phoneme.strip('()')
        base_group = re.split(r'[!=&]', clean_rule)[0]
        return base_group in GROUP_KEYWORDS

    def is_group_match(self, rule_phoneme: str, actual_phoneme: str) -> bool:
        """对应 `IsGroupMatch`：`vowel` / `consonant` / `nasal&liquid` / `vowel!a=i` 这类组语法。"""
        clean_rule = rule_phoneme.strip('()')
        base_group = re.split(r'[!=&]', clean_rule)[0]

        # ★ 原文注释："Replaced '+' with '&' for group addition"
        if '&' in clean_rule:
            added = re.split(r'[!=]', clean_rule[clean_rule.index('&') + 1:])[0]
            for inc in added.split(','):
                if self.is_group_match(inc, actual_phoneme) if self.is_group_keyword(inc) \
                        else inc == actual_phoneme:
                    return True

        in_base_group = False
        if base_group in ('vowel', 'vowels'):
            in_base_group = actual_phoneme in self.get_vowels()
        elif base_group in ('consonant', 'consonants'):
            in_base_group = actual_phoneme in (self.consonants
                                               if len(self.consonants) > 0
                                               else self.get_consonants())
        elif base_group == 'affricate':
            in_base_group = actual_phoneme in self.affricate
        elif base_group == 'fricative':
            in_base_group = actual_phoneme in self.fricative
        elif base_group == 'aspirate':
            in_base_group = actual_phoneme in self.aspirate
        elif base_group == 'semivowel':
            in_base_group = actual_phoneme in self.semivowel
        elif base_group == 'liquid':
            in_base_group = actual_phoneme in self.liquid
        elif base_group == 'nasal':
            in_base_group = actual_phoneme in self.nasal
        elif base_group == 'stop':
            in_base_group = actual_phoneme in self.stop
        elif base_group == 'tap':
            in_base_group = actual_phoneme in self.tap

        if not in_base_group:
            return False

        if '!' in clean_rule:
            excluded = re.split(r'[=&]', clean_rule[clean_rule.index('!') + 1:])[0]
            if actual_phoneme in excluded.split(','):
                return False

        if '=' in clean_rule:
            restricted = re.split(r'[!&]', clean_rule[clean_rule.index('=') + 1:])[0]
            if actual_phoneme not in restricted.split(','):
                return False

        return True

    def apply_replacements(self, input_phonemes: List[str], is_boundary: bool) -> List[str]:
        """对应 `ApplyReplacements`：YAML `replacements` 的整串匹配引擎。"""
        if not self.merging_replacements and not self.splitting_replacements:
            return input_phonemes

        final_phonemes: List[str] = []
        idx = 0

        def _where_ok(r: Replacement) -> bool:
            return (r.where == 'all'
                    or (not is_boundary and r.where == 'inside')
                    or (is_boundary and r.where == 'boundary'))

        # `OrderByDescending(Count).ThenByDescending(Sum(len))` —— 都用稳定排序
        valid_rules = sorted(
            [r for r in (list(self.merging_replacements) + list(self.splitting_replacements))
             if _where_ok(r)],
            key=lambda r: (-len(r.from_list), -sum(len(s) for s in r.from_list)))
        valid_splits = sorted(
            [r for r in self.splitting_replacements if _where_ok(r)],
            key=lambda r: -sum(len(s) for s in r.from_list))

        def _split_to(to_ph: str):
            """把 `to` 元素按 `+` 拆开，并认出第一个"组关键字"分量。

            返回 `(clean_parts, base_group_to)`；`base_group_to` 为 `None` 表示纯字面量。
            """
            parts = to_ph.split('+')
            clean_parts: List[Optional[str]] = [None] * len(parts)
            base_group_to: Optional[str] = None

            for k in range(len(parts)):
                part_no_parens = parts[k].strip('()')
                m = re.search(r'[!=&]', part_no_parens)
                potential_group = part_no_parens[:m.start()] if m else part_no_parens

                if base_group_to is None and self.is_group_keyword(potential_group):
                    base_group_to = potential_group
                    clean_parts[k] = potential_group   # 只存组名
                else:
                    clean_parts[k] = part_no_parens    # 字面量
            return clean_parts, base_group_to

        def _render(clean_parts, base_group_to: Optional[str], substitute: str) -> str:
            """对应 `string.Join("", cleanParts)`，并把组名那一段换成捕获到的音素。"""
            return ''.join(substitute if (base_group_to is not None and cp == base_group_to)
                           else cp for cp in clean_parts)

        while idx < len(input_phonemes):
            replaced = False

            for rule in valid_rules:
                from_array = rule.from_list

                if from_array and idx + len(from_array) <= len(input_phonemes):
                    match = True
                    captures: Dict[str, List[str]] = {}

                    for j in range(len(from_array)):
                        rule_ph = from_array[j]
                        actual_ph = input_phonemes[idx + j]

                        clean_rule_ph = rule_ph.strip('()')
                        base_rule_ph = re.split(r'[!=&]', clean_rule_ph)[0]

                        if self.is_group_keyword(base_rule_ph):
                            if self.is_group_match(rule_ph, actual_ph):
                                captures.setdefault(base_rule_ph, []).append(actual_ph)
                            else:
                                match = False
                                break
                        elif rule_ph != actual_ph:
                            match = False
                            break

                    if match:
                        to_array = rule.to_list
                        if to_array:
                            # 对应 C# 的 `captureIndices`：同一条规则里同名组按出现次数依次取
                            capture_indices: Dict[str, int] = {}
                            for to_ph in to_array:
                                clean_parts, base_group_to = _split_to(to_ph)
                                captured = captures.get(base_group_to) if base_group_to else None
                                if captured:
                                    c_idx = capture_indices.get(base_group_to, 0)
                                    if c_idx >= len(captured):
                                        c_idx = len(captured) - 1
                                    final_phonemes.append(
                                        _render(clean_parts, base_group_to, captured[c_idx]))
                                    capture_indices[base_group_to] = c_idx + 1
                                else:
                                    final_phonemes.append(''.join(clean_parts))

                        idx += len(from_array)
                        replaced = True
                        break

            # 单音素拆分规则的回落段
            if not replaced and valid_splits:
                current_phoneme = input_phonemes[idx]
                single_replaced = False
                for rule in valid_splits:
                    from_array = rule.from_list
                    if not from_array or len(from_array) != 1:
                        continue

                    rule_ph = from_array[0]
                    clean_rule_ph = rule_ph.strip('()')
                    base_rule_ph = re.split(r'[!=&]', clean_rule_ph)[0]

                    matched = (self.is_group_match(rule_ph, current_phoneme)
                               if self.is_group_keyword(base_rule_ph)
                               else rule_ph == current_phoneme)

                    if matched:
                        to_array = rule.to_list
                        if to_array:
                            for to_ph in to_array:
                                clean_parts, base_group_to = _split_to(to_ph)
                                if base_group_to is not None:
                                    # ★ 这里没有"捕获字典"，直接拿**当前音素**回填
                                    final_phonemes.append(
                                        _render(clean_parts, base_group_to, current_phoneme))
                                else:
                                    final_phonemes.append(''.join(clean_parts))
                            single_replaced = True
                            break
                if not single_replaced:
                    final_phonemes.append(input_phonemes[idx])
                idx += 1
            elif not replaced:
                final_phonemes.append(input_phonemes[idx])
                idx += 1

        return final_phonemes

    # ---- 边界替换（两个重载）

    def apply_boundary_replacements_syllable(self, syllable: Syllable) -> Syllable:
        """对应 `ApplyBoundaryReplacements(Syllable)`。

        ★ C# 是**按值**入参 → 这里先 `copy.copy()`，绝不改到调用者的对象。
        """
        if not self.merging_replacements and not self.splitting_replacements:
            return syllable

        syllable = copy.copy(syllable)

        current_phonemes: List[str] = []
        has_prev_v = bool(syllable.prev_v)
        has_v = bool(syllable.v)

        current_phonemes.append(syllable.prev_v if has_prev_v else 'null')
        if syllable.cc is not None:
            current_phonemes.extend(syllable.cc)
        if has_v:
            current_phonemes.append(syllable.v)

        is_boundary = (has_prev_v and syllable.position == 0) or not has_prev_v
        final_phonemes = self.apply_replacements(current_phonemes, is_boundary)

        new_prev_v = ''
        new_v = ''
        new_cc: List[str] = []

        if final_phonemes:
            first_ph = final_phonemes[0]
            if first_ph == 'null':
                new_prev_v = ''
                final_phonemes.pop(0)
            else:
                new_prev_v = first_ph
                final_phonemes.pop(0)

            if has_v and final_phonemes:
                vowels_list = self.get_vowels()
                v_index = len(final_phonemes) - 1
                for i in range(len(final_phonemes) - 1, -1, -1):
                    if final_phonemes[i] in vowels_list:
                        v_index = i
                        break
                new_v = final_phonemes[v_index]
                for i in range(v_index):
                    new_cc.append(final_phonemes[i])
            else:
                new_cc.extend(final_phonemes)

        syllable.prev_v = new_prev_v
        syllable.cc = new_cc
        syllable.v = new_v
        return syllable

    def apply_boundary_replacements_ending(self, ending: Ending) -> Ending:
        """对应 `ApplyBoundaryReplacements(Ending)`（同样是**按值**入参）。"""
        if not self.merging_replacements and not self.splitting_replacements:
            return ending

        ending = copy.copy(ending)

        current_phonemes: List[str] = []
        has_prev_v = bool(ending.prev_v)
        current_phonemes.append(ending.prev_v if has_prev_v else 'null')
        if ending.cc is not None:
            current_phonemes.extend(ending.cc)
        has_tail = ending.has_tail
        current_phonemes.append(ending.tail if has_tail else 'null')

        final_phonemes = self.apply_replacements(current_phonemes, True)

        new_prev_v = ''
        new_tail = ''
        new_cc: List[str] = []

        if final_phonemes:
            first_ph = final_phonemes[0]
            new_prev_v = '' if first_ph == 'null' else first_ph
            final_phonemes.pop(0)

        if final_phonemes:
            last_ph = final_phonemes[-1]
            new_tail = '' if last_ph == 'null' else last_ph
            final_phonemes.pop()

        new_cc.extend(final_phonemes)

        ending.prev_v = new_prev_v
        ending.cc = new_cc
        ending.tail = new_tail
        return ending

    # ================================================================== 延音

    def _apply_extensions(self, symbols: List[str], notes) -> List[str]:
        """对应 `ApplyExtensions`：`+~` / `+*` 延音音符不推进元音下标。"""
        new_symbols: List[str] = []
        vowel_ids = self._extract_vowels(symbols)
        if len(vowel_ids) == 0:
            vowel_ids.append(len(symbols) - 1)
        last_vowel_i = 0
        new_symbols.extend(symbols[:vowel_ids[last_vowel_i] + 1])
        i = 1
        while i < len(notes) and last_vowel_i + 1 < len(vowel_ids):
            if not self.is_syllable_vowel_extension_note(notes[i]):
                prev_vowel = vowel_ids[last_vowel_i]
                last_vowel_i += 1
                vowel = vowel_ids[last_vowel_i]
                new_symbols.extend(symbols[prev_vowel + 1: prev_vowel + 1 + (vowel - prev_vowel)])
            else:
                new_symbols.append(symbols[vowel_ids[last_vowel_i]])
            i += 1
        new_symbols.extend(symbols[vowel_ids[last_vowel_i] + 1:])
        return new_symbols

    def _extract_vowels(self, symbols: List[str]) -> List[int]:
        """对应 `ExtractVowels`。"""
        vowels = self.get_vowels()
        return [i for i in range(len(symbols)) if symbols[i] in vowels]

    # ================================================================== 音素排布

    def _make_phonemes(self, phoneme_symbols: List[str], container_length: int,
                       position: int, is_ending: bool, tone: int = 0,
                       attributes: Optional[List[PhonemeAttributes]] = None,
                       global_start_index: int = 0) -> List[Phoneme]:
        """对应 `MakePhonemes`：把符号串排成带 position 的音素。"""
        count = len(phoneme_symbols)
        phonemes: List[Optional[Phoneme]] = [None] * count

        # ---- 每个"下一位"的过渡长度（trueLengths[0] 从不被写入）
        true_lengths = [0] * count
        for i in range(1, count):
            prev_phoneme_i = count - i
            current_phoneme_i = count - i - 1

            next_global_index = global_start_index + prev_phoneme_i
            next_p_attr = _first_attr_or_default(attributes, next_global_index)

            next_alias = phoneme_symbols[prev_phoneme_i]
            current_alias = phoneme_symbols[current_phoneme_i]

            base_length_ms: float
            stretch = (next_p_attr.consonant_stretch_ratio
                       if next_p_attr.consonant_stretch_ratio is not None else 1.0)

            override_ratio = (self.get_transition_multiplier(current_alias)
                              if current_alias is not None else 1.0)

            if override_ratio != 1.0:
                base_length_ms = self.get_transition_basic_length_ms_by_constant()
                stretch *= override_ratio
            else:
                base_length_ms = self.get_transition_basic_length_ms(next_alias, tone,
                                                                     next_p_attr)

            true_lengths[i] = self.ms_to_tick(base_length_ms * stretch)

        # ---- 滑音锚点：最多锚一个（贴着元音的那个）
        anchor_i = 0
        if not is_ending and count > 1:
            immediate_consonant_i = count - 2
            if (phoneme_symbols[immediate_consonant_i] is not None
                    and self.is_glide(phoneme_symbols[immediate_consonant_i])):
                anchor_i = 1

        for i in range(count):
            phoneme_i = count - i - 1
            global_index = global_start_index + phoneme_i
            validated_alias = phoneme_symbols[phoneme_i]
            p_attr = _first_attr_or_default(attributes, global_index)

            if validated_alias is not None:
                expr_list: List[PhonemeExpression] = []
                if p_attr.consonant_stretch_ratio is not None:
                    # ★ `(float)(...)` —— float32 舍入
                    vel = as_float32(100.0 - 100.0 * math.log2(p_attr.consonant_stretch_ratio))
                    expr_list.append(PhonemeExpression(abbr='vel', value=vel))
                if p_attr.alternate is not None and p_attr.alternate > 0:
                    expr_list.append(PhonemeExpression(abbr='alt', value=p_attr.alternate))

                phonemes[phoneme_i] = Phoneme(
                    phoneme=validated_alias,
                    index=global_index,
                    expressions=expr_list if expr_list else None)

                if i == 0:
                    if is_ending:
                        stretch = (p_attr.consonant_stretch_ratio
                                   if p_attr.consonant_stretch_ratio is not None else 1.0)

                        ph = phonemes[phoneme_i]
                        override_ratio = (self.get_transition_multiplier(ph.phoneme)
                                          if ph.phoneme is not None else 1.0)

                        if override_ratio != 1.0:
                            base_length_ms = self.get_transition_basic_length_ms_by_constant()
                            ph.position = self.ms_to_tick(base_length_ms * stretch
                                                          * override_ratio)
                        else:
                            base_length_ms = self.get_transition_basic_length_ms_by_oto(
                                ph.phoneme, tone, p_attr)
                            if self.no_gap:
                                # 吸附模式：可见的 50 tick 锚点，且不超过音符的 1/3
                                target_ticks = 50
                                max_allowed = idiv(container_length, 3)
                                ph.position = min(target_ticks, max_allowed)
                            else:
                                ph.position = self.ms_to_tick(base_length_ms)
                    else:
                        total = 0
                        for k in range(1, anchor_i + 1):
                            total += true_lengths[k]
                        phonemes[phoneme_i].position = -total
                else:
                    phonemes[phoneme_i].position = true_lengths[i]
            else:
                phonemes[phoneme_i] = Phoneme(phoneme=None, position=0, index=global_index)

        # ★ `isEnding ? count-1 : count-1` —— 两个分支**完全相同**（上游笔误），照搬
        return self._scale_phonemes(phonemes, position, count - 1, container_length)

    def _scale_phonemes(self, phonemes: List[Optional[Phoneme]], start_position: int,
                        phonemes_count: int,
                        container_length_tick: int = -1) -> List[Phoneme]:
        """对应 `ScalePhonemes`：把过渡整体压到容器的 80% 以内，并倒排 position。"""
        offset = 0
        length_modifier = 1.0

        if container_length_tick > 0:
            all_transitions_length_tick = sum(p.position for p in phonemes)
            # ★ `(int)(...)` = 向零截断
            max_allowed_consonant_tick = int(container_length_tick * 0.8)

            if all_transitions_length_tick > max_allowed_consonant_tick:
                length_modifier = max_allowed_consonant_tick / all_transitions_length_tick

        for i in range(len(phonemes) - 1, -1, -1):
            if phonemes[i].phoneme is None:
                continue
            final_length_tick = int(phonemes[i].position * length_modifier)
            phonemes[i].position = start_position - final_length_tick - offset
            offset += final_length_tick

        return [p for p in phonemes if p.phoneme is not None]

    # ================================================================== 私有

    def _make_forced_alias_result(self, note: Note) -> Result:
        """对应 `MakeForcedAliasResult`：`?abc` → 直接产出 `abc`。"""
        return self.make_simple_result(note.lyric[1:])


# ====================================================================== 工具


def _distinct(items: Sequence[str]) -> List[str]:
    """对应 LINQ 的 `Distinct()`：**保序**去重（不能用 `set`）。"""
    return list(dict.fromkeys(items))


def _concat_distinct(a: Sequence[str], b: Sequence[str]) -> List[str]:
    """对应 `a.Concat(b).Distinct().ToArray()`。"""
    return _distinct(list(a) + list(b))


def _replacement_from_key(from_obj: Any) -> str:
    """对应 `GetFromKey(object fromObj)`：字符串原样；可枚举则逗号拼接；否则空串。"""
    if isinstance(from_obj, str):
        return from_obj
    if isinstance(from_obj, (list, tuple)):
        return ','.join('' if x is None else str(x) for x in from_obj)
    return ''

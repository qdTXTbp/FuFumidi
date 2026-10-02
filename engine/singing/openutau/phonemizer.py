# -*- coding: utf-8 -*-
"""音素化器基类 —— 照搬 `OpenUtau.Core/Api/Phonemizer.cs`（323 行）。

这是 OpenUTAU「编辑器与引擎解耦」的另一半：渲染器负责"音素怎么出声"，
音素化器负责"歌词怎么变成音素"。

## 照搬时保留的语义（不要"优化"掉）
- 方法名与调用时序：`SetSinger`(抽象) → `SetUp` → `Process`(抽象) → `CleanUp`；
  `SetTiming` 由宿主调用，用于 tick↔ms 换算。
- `Note.position/duration`、`Phoneme.position` 的单位都是 **tick**（不是 ms）。
- `Phoneme.index` 是**可选**的，但同一个音素化器必须保持一致（要么全带 index，要么全不带）。
- `Phoneme.phoneme` 返回的是**未做音高映射**的别名（如 "あ"），
  音高映射交给 `MapPhoneme()` 在之后做。
- `GetParent*` 系列一律读**轨道级**表达式的 `CustomDefaultValue`，
  这是「轨道默认值」参与音素化的唯一入口。

## 与 C# 的等价性差异（已核实，记录在此）
- `ToUnicodeElements`：C# 用 `StringInfo.GetTextElementEnumerator`（真正的字素簇）。
  Python 标准库没有等价物，这里用「基字符 + 后续组合记号」近似 ——
  覆盖常见情况，但复杂字素簇（emoji ZWJ 序列等）会不同。
- `DictionariesPath` / `PluginDir`：C# 读 `PathManager`，
  这里读环境变量（`FUFUMIDI_DICT_DIR` / `FUFUMIDI_PLUGIN_DIR`），缺省为空串。
"""

import math
import unicodedata
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..ustx.format import Ustx


@dataclass
class Note:
    """输入：一个音符（对应 C# `Phonemizer.Note`）。"""

    lyric: str = ''
    phonetic_hint: Optional[str] = None
    tone: int = 0
    position: int = 0        # tick
    duration: int = 0        # tick
    phoneme_attributes: List['PhonemeAttributes'] = field(default_factory=list)


@dataclass
class PhonemeAttributes:
    """音素级覆盖值（对应 C# `Phonemizer.PhonemeAttributes`）。"""

    index: int = 0
    consonant_stretch_ratio: Optional[float] = None
    tone_shift: Optional[int] = None
    alternate: Optional[int] = None
    voice_color: Optional[str] = None


@dataclass
class PhonemeExpression:
    """音素建议的表达式值（对应 C# `Phonemizer.PhonemeExpression`）。"""

    abbr: str = ''
    value: float = 0


@dataclass
class Phoneme:
    """输出：一个音素（对应 C# `Phonemizer.Phoneme`）。"""

    index: Optional[int] = None
    phoneme: str = ''
    position: int = 0        # tick
    error: Optional[str] = None
    expressions: List[PhonemeExpression] = field(default_factory=list)


@dataclass
class Result:
    """`process()` 的返回值（对应 C# `Phonemizer.Result`）。"""

    phonemes: List[Phoneme] = field(default_factory=list)


class Phonemizer(ABC):
    """音素化器插件基类（对应 C# `Api.Phonemizer`）。"""

    # 对应 C# 的 [Phonemizer(name, tag, author, language)]
    name: str = ''
    tag: str = ''
    language: str = ''
    author: str = ''

    def __init__(self):
        self.name = type(self).name
        self.tag = type(self).tag
        self.language = type(self).language
        self.author = getattr(type(self), 'author', '')
        self.set_up_exception: Optional[BaseException] = None
        self.bpm: float = 0.0
        self.time_axis = None
        self.project = None
        self.track = None

    # ---------------------------------------------------------------- 宿主调用

    @abstractmethod
    def set_singer(self, singer: Any) -> None:
        """用户切换歌手时调用。可在此加载歌手专属资源（如自定义词典）。"""

    @property
    def legacy_mapping(self) -> bool:
        """对应 C# `LegacyMapping`：是否沿用旧的音素再映射行为。新音素化器不要覆盖。"""
        return False

    def set_up(self, notes: List[List[Note]], project: Any, track: Any) -> None:
        self.project = project
        self.track = track

    @abstractmethod
    def process(self, notes: List[Note], prev: Optional[Note], next_: Optional[Note],
                prev_neighbour: Optional[Note], next_neighbour: Optional[Note],
                prevs: List[Note]) -> Result:
        """音素化的主逻辑。

        notes           一个音符及其延音（≥1）
        prev / next     前/后一个音符（若有）
        prev_neighbour  紧邻时才等于 prev，否则 None
        next_neighbour  紧邻时才等于 next，否则 None
        prevs           前一个音符及其延音（可能为空，但不会是 None）
        """

    def clean_up(self) -> None:
        pass

    def set_timing(self, time_axis) -> None:
        """由宿主调用：设置 tick↔ms 换算所需的时间轴。音素化器内部不要调。"""
        self.time_axis = time_axis
        self.bpm = time_axis.get_bpm_at_tick(0)

    def __str__(self):
        return '[%s] %s' % (self.tag, self.name)

    # ---------------------------------------------------------------- 路径

    @property
    def dictionaries_path(self) -> str:
        import os
        return os.environ.get('FUFUMIDI_DICT_DIR', '')

    @property
    def plugin_dir(self) -> str:
        import os
        return os.environ.get('FUFUMIDI_PLUGIN_DIR', '')

    # ---------------------------------------------------------------- 换算（C# 里标了 Obsolete 但仍在用）

    def tick_to_ms(self, tick: int) -> float:
        return self.time_axis.tick_pos_to_ms_pos(tick)

    def ms_to_tick(self, ms: float) -> int:
        return self.time_axis.ms_pos_to_tick_pos(ms)

    # ---------------------------------------------------------------- 工具

    @staticmethod
    def to_unicode_elements(lyric: str) -> List[str]:
        """把字符串切成「字素簇」。

        ⚠ 与 C# 的 `StringInfo.GetTextElementEnumerator` **不完全等价**：
        Python 标准库没有字素簇迭代器，这里用「基字符 + 后续组合记号」近似。
        常见歌词（含假名/汉字/拉丁）结果一致；emoji ZWJ 序列等复杂簇会不同。
        """
        out: List[str] = []
        for ch in lyric:
            if out and unicodedata.combining(ch):
                out[-1] += ch
            elif out and unicodedata.category(ch) == 'Mn':
                out[-1] += ch
            else:
                out.append(ch)
        return out

    def make_simple_result(self, phoneme: str) -> Result:
        return Result(phonemes=[Phoneme(phoneme=phoneme)])

    # ---------------------------------------------------------------- 轨道级默认值

    def get_parent_consonant_stretch_ratio(self) -> float:
        """速度（VEL）的轨道默认值 → 辅音伸缩比：`2 ** (1 - vel/100)`。"""
        if self.project is not None and self.track is not None:
            desc = self.track.try_get_exp_descriptor(self.project, Ustx.VEL)
            if desc is not None:
                return math.pow(2, 1.0 - desc.custom_default_value / 100.0)
        return 1

    def get_parent_tone_shift(self) -> int:
        if self.project is not None and self.track is not None:
            desc = self.track.try_get_exp_descriptor(self.project, Ustx.SHFT)
            if desc is not None:
                return int(desc.custom_default_value)
        return 0

    def get_parent_alternate(self) -> Optional[int]:
        if self.project is not None and self.track is not None:
            desc = self.track.try_get_exp_descriptor(self.project, Ustx.ALT)
            if desc is not None and desc.custom_default_value != 0:
                return int(desc.custom_default_value)
        return None

    def get_parent_voice_color(self) -> str:
        if self.project is not None and self.track is not None:
            desc = self.track.try_get_exp_descriptor(self.project, Ustx.CLR)
            if desc is not None and desc.options is not None:
                index = int(desc.custom_default_value)
                if 0 <= index < len(desc.options):
                    return desc.options[index] or ''
        return ''

    # ---------------------------------------------------------------- oto 查询（统一入口）

    def mapped_oto(self, phoneme: str, tone: int, color: Optional[str] = None):
        """取映射后的 oto，**返回单值**（找到就给 oto，找不到给 `None`）。

        ★ 一律走这里，别直接 `self.singer.try_get_mapped_oto(...)` 然后当裸值用。

        原因：`USinger.try_get_mapped_oto` 返回的是 **`(found, oto)` 元组**
        （照搬 C# 的 `bool TryGetMappedOto(..., out UOto oto)`）。若某个音素化器
        把它当裸值（`if oto is not None:`），在真 `ClassicSinger` 上会拿到
        `(True, <UOto>)`，`is not None` 为真 → 后续 `oto.is_color_match(...)` 直接
        `AttributeError: 'tuple' object has no attribute 'is_color_match'`。

        更麻烦的是：如果测试替身也返回裸值，这个错误**永远不会被测出来**
        （替身与真实现接口不一致 → 测试全绿、真机崩）。所以这里**严格解包**：
        替身一旦返回裸值就立刻 `TypeError`，把问题挡在测试阶段。
        """
        found, oto = self.singer.try_get_mapped_oto(phoneme, tone, color)
        return oto if found else None

    # ---------------------------------------------------------------- 音高映射

    @staticmethod
    def map_phoneme(phoneme: str, tone: int, color: str, alt: str, singer: Any) -> str:
        """把音素别名映射到合适的音高别名（如 "あ" → "あC5"）。

        先试带 alt 后缀的别名，再试不带 alt 的；都没有就原样返回。
        singer 需实现 `try_get_mapped_oto(alias, tone, color) -> oto|None`，oto 有 `.alias`。
        """
        # ★ 与 `mapped_oto` 同样的理由：必须在**调用处**严格解包
        found, oto = singer.try_get_mapped_oto(phoneme + (alt or ''), tone, color)
        if found:
            return oto.alias
        found, oto = singer.try_get_mapped_oto(phoneme, tone, color)
        if found:
            return oto.alias
        return phoneme


# ---------------------------------------------------------------- 注册表（对应 PhonemizerFactory）

_REGISTRY: Dict[str, type] = {}


def register(cls: type) -> type:
    """对应 C# 的 [PhonemizerAttribute] 自动注册。"""
    if not getattr(cls, 'name', ''):
        raise ValueError('Phonemizer 必须有非空 name')
    _REGISTRY[cls.tag or cls.name] = cls
    return cls


def registered() -> Dict[str, type]:
    return dict(_REGISTRY)

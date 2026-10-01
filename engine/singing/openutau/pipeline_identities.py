# -*- coding: utf-8 -*-
"""管线用的标识与"影响范围" —— **照搬** `OpenUtau.Core/Pipeline/Identities.cs`（62 行）。

这四样东西是"快照 + 增量失效"那套机制的地基：
- `PartId` / `DocRevision`：**值语义**的标识（C# 是 `readonly record struct`），
  可以当字典键、可以比较大小（`CompareTo`），所以**必须可哈希且按值相等**。
  `PhraseSource` 里那两个字段（`PartId` / `DocRevision`）原先在我们这边是 `Any` 占位，
  现在有真类型了。
- `ImpactKind` / `ImpactSet`：一条改动声明自己会波及哪儿，用来决定哪些快照要作废。

## 照搬时保留的语义
- `ImpactKind` 的数值是 **0/1/2/4/8/16**（各自独立成位），不是 0..5 的连续序号 ——
  照搬时别"整理"。
- `PartId.ToString()` 用 `"N"` 格式 → **32 位小写十六进制、无连字符**
  （Python 的 `uuid.UUID.hex` 正好一致）。
- `ImpactSet.All` / `.None` / `.MixOnly` 是**静态单例**（C# `static` 属性只构造一次）；
  `PartOf` / `CurvesOf` / `TrackOf` 是工厂方法。
- C# 的可选参数默认是 `null`，所以 `ImpactSet(ImpactKind.None)` 的 `Part`/`Track`/
  `CurveAbbrs` 都是 null。Python 用 `None` 对齐（**不是**空列表 —— `CurveAbbrs` 为 null
  与为空列表在 C# 里是不同的东西）。
"""

import uuid
from dataclasses import dataclass, field
from typing import Any, List, Optional


@dataclass(frozen=True)
class PartId:
    """对应 `readonly record struct PartId(Guid Value)`。"""

    value: uuid.UUID = field(default_factory=uuid.uuid4)

    @staticmethod
    def new() -> 'PartId':
        """对应 `PartId.New()`。"""
        return PartId(uuid.uuid4())

    def compare_to(self, other: 'PartId') -> int:
        """对应 `CompareTo`（按 Guid 的字节序比较）。"""
        return (self.value.int > other.value.int) - (self.value.int < other.value.int)

    def __str__(self):
        """对应 `Value.ToString("N")`：32 位小写十六进制、无连字符。"""
        return self.value.hex


@dataclass(frozen=True)
class DocRevision:
    """对应 `readonly record struct DocRevision(long Value)`。"""

    value: int = 0

    def compare_to(self, other: 'DocRevision') -> int:
        return (self.value > other.value) - (self.value < other.value)

    def __str__(self):
        return str(self.value)


class ImpactKind:
    """对应 `enum ImpactKind`。**数值各自成位**，不是连续序号。"""

    NONE = 0        # 没有触及任何与渲染有关的状态
    PART = 1        # 某个 part 的结构变了（音符 / 音素 / 分组）
    CURVES = 2      # 某个 part 的曲线点变了
    MIX = 4         # 只动了混音参数（音量 / 声像 / 静音 / 效果）
    TRACK = 8       # 某条轨的配置变了（歌手 / 渲染器 / 表达式）
    PROJECT = 16    # 工程级变化（时间轴 / 工程表达式）—— 全都受影响


@dataclass
class ImpactSet:
    """对应 `readonly struct ImpactSet`：一条改动声明的"爆炸半径"。"""

    kind: int = ImpactKind.NONE
    part: Any = None
    track: Any = None
    #: 注意：C# 里 null 与空列表**不同**，这里用 None 对齐
    curve_abbrs: Optional[List[str]] = None

    # ---- 静态单例（C# 是 static 属性，只构造一次）
    @staticmethod
    def all() -> 'ImpactSet':
        return ImpactSet(ImpactKind.PROJECT)

    @staticmethod
    def none() -> 'ImpactSet':
        return ImpactSet(ImpactKind.NONE)

    @staticmethod
    def mix_only() -> 'ImpactSet':
        return ImpactSet(ImpactKind.MIX)

    # ---- 工厂
    @staticmethod
    def part_of(part) -> 'ImpactSet':
        return ImpactSet(ImpactKind.PART, part=part)

    @staticmethod
    def curves_of(part, *abbrs) -> 'ImpactSet':
        return ImpactSet(ImpactKind.CURVES, part=part, curve_abbrs=list(abbrs))

    @staticmethod
    def track_of(track) -> 'ImpactSet':
        return ImpactSet(ImpactKind.TRACK, track=track)

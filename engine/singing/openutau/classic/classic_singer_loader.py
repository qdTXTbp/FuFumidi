# -*- coding: utf-8 -*-
"""声库发现 —— **照搬** `OpenUtau.Core/Classic/ClassicSingerLoader.cs`（30 行）。

遍历 `PathManager.Inst.SingersPaths` 下的每个目录，用 `VoicebankLoader.SearchAll()`
找出所有声库，再按 `SingerType` 决定实例化成哪种 `USinger`。

## 照搬时保留的语义
- `AdjustSingerType` 的 switch 按 `SingerType` **精确值**分派，`default` 落到
  `ClassicSinger`。注意 `USingerType.DiffSinger = 0x5` 同时含 `Classic(0x1)|Vogen(0x4)`，
  不能按位判。
- **每个搜索路径各建一个 `VoicebankLoader`**（不是共用一个）—— `VoicebankLoader`
  把 `base_path` 存在字段里，共用会把结果串味。
- 搜索路径的顺序 = 返回列表的顺序（先路径、路径内按 `SearchAll` 的顺序）。
- `SearchAll()` 返回的每个 `Voicebank` 都**恰好**变成一个 singer（可能为 null 让调用方过滤）。

## 与 C# 的载体差异
- C# 直接 `new Core.Enunu.EnunuSinger(v)` / `DiffSingerSinger` / `VoicevoxSinger`。
  这三个**尚未照搬**，所以改成**注册表**：未注册时**回落到 `ClassicSinger`**
  （C# 的 `default` 分支就是它）。等它们搬进来时各自
  `register_singer_factory(USingerType.ENUNU, ...)` 即可。
  > 注意：C# 里 `new EnunuSinger(v) as USinger` 若类型不对会得到 **null**
  > （`as` 而不是强转），调用方要能容忍 null。Python 侧没有类型强转，
  > 工厂直接返回对象；`find_all_singers` 照 C# 的语义**不过滤**，
  > 由调用方决定怎么处理 None。
- `PathManager.Inst.SingersPaths` → `ClassicHost.singers_paths`（宿主注入）。
"""

from typing import Any, Callable, Dict, List, Optional

from ..oto import Voicebank
from ..singer import USinger, USingerType
from .classic_singer import ClassicSinger
from .resampler_item import host
from .voicebank_loader import VoicebankLoader

#: 非 Classic 歌手类型的工厂表（id → `fn(voicebank) -> USinger`）
_SINGER_FACTORIES: Dict[int, Callable[[Voicebank], USinger]] = {}


def register_singer_factory(singer_type: int, factory: Callable[[Voicebank], USinger]) -> None:
    """登记某个 `USingerType` 的构造器（对应 `AdjustSingerType` 的 case 分支）。"""
    _SINGER_FACTORIES[singer_type] = factory


def registered_singer_types() -> List[int]:
    return sorted(_SINGER_FACTORIES)


def reset_singer_factories() -> None:
    """清空工厂表（**仅供测试**；C# 无对应物 —— 它的分支是写死的 `case`）。"""
    _SINGER_FACTORIES.clear()


def adjust_singer_type(voicebank: Voicebank) -> USinger:
    """对应 `AdjustSingerType`。"""
    factory = _SINGER_FACTORIES.get(voicebank.singer_type)
    if factory is not None:
        return factory(voicebank)
    return ClassicSinger(voicebank)


def find_all_singers() -> List[Optional[USinger]]:
    """对应 `FindAllSingers`。

    ★ 每个路径**各建一个 loader**（`base_path` 是它的字段）。
    ★ 返回值不过滤 None，与 C# 的 `Select(AdjustSingerType)`（可能产出 null）一致。
    """
    singers: List[Optional[USinger]] = []
    for path in host.singers_paths:
        loader = VoicebankLoader(path)
        for voicebank in loader.search_all():
            singers.append(adjust_singer_type(voicebank))
    return singers


__all__ = [
    'adjust_singer_type', 'register_singer_factory', 'registered_singer_types',
    'reset_singer_factories', 'find_all_singers', 'ClassicSinger', 'USingerType',
]

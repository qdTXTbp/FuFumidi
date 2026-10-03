# -*- coding: utf-8 -*-
"""渲染投影快照 —— **照搬** `OpenUtau.Core/Render/RenderProjection.cs`（42 行）。

「一个 part 当前长什么样」的**不可变快照**：乐句列表 + 每句的预计算布局 + 渲染完成情况。
UI 只读它，不直接读文档，因此重绘与渲染线程解耦。

## ★ 照搬时保留的语义
1. ★ **`Ready` 的定义是"当前每一句都有 pcm"**：`phrases.Count > 0` 且全部 rendered。
   ★ 所以**空 part 的 `ready` 是 False**（不是 True）—— 一个音都没有 ≠ 渲染好了。
2. `Revision` 在**每次 Build 时自增**（`++revision`），哪怕内容没变 —— 它是
   "投影被重建过几次"的单调计数，UI 用它丢弃过期的异步结果。
3. 快照本身**只读**（C# 用 `readonly struct` + `sealed class` + `readonly` 字段），
   Python 用 frozen dataclass。

## ★ 载体差异
- C# 的 `ulong Hash` → Python `int`（哈希值本身是 64 位无符号；本仓库的
  `RenderPhrase._hash` 也是 Python int，语义一致）。
- `IReadOnlyList<PhraseView>` → `List`（调用方约定不修改；C# 的只读视图在 Python 里
  没有对应类型，靠约定 + 测试保证）。
"""

from dataclasses import dataclass, field
from typing import List

from .phrase_layout import PhraseLayout


@dataclass(frozen=True)
class PhraseView:
    """对应 `readonly struct PhraseView`：一句乐句的展示视图。"""

    hash: int
    layout: PhraseLayout
    rendered: bool


@dataclass(frozen=True)
class RenderProjection:
    """对应 `sealed class RenderProjection`：某个 part 的渲染派生数据快照。

    ★ 上游注释要点：这是**不可变、带版本号**的快照，由 UI 线程上的 `RenderView`
      构建并投递；**播放会话不参与** —— 展示跟随文档，而不是"恰好在跑的那次播放"。
    """

    part: object
    revision: int
    phrases: List[PhraseView] = field(default_factory=list)
    #: ★ "当前每一句都有 pcm"。空 part → False。
    ready: bool = False

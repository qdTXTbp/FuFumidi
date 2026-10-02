# -*- coding: utf-8 -*-
"""拼接器接口 —— **照搬** `OpenUtau.Core/Classic/IWavtool.cs`（11 行）。

resampler 只负责"单个音素 → 一个 wav 文件"，**把音素按时间轴拼成一条乐句**是
wavtool 的活：叠加、skipOver 裁剪、包络、交叉淡化。

C# 的接口注释就是命令行契约（外部 wavtool 也该按这个理解）：

    <output file> <input file> <STP> <note length>
    [<p1> <p2> <p3> <v1> <v2> <v3> [<v4> <overlap> <p4> [<p5> <v5>]]]

## 与 C# 的载体差异
- `CancellationTokenSource cancellation` → 一个 `threading.Event`
  （判据是 `.is_set()`）；传 `None` 表示不取消。C# 的
  `cancellation.IsCancellationRequested` 与之等价。
- C# 的 `List<ResamplerItem>` → Python 的 `List[ResamplerItem]`。
"""

from abc import ABC, abstractmethod
from typing import List, Optional


class IWavtool(ABC):
    """对应 C# 的 `IWavtool`。"""

    @abstractmethod
    def concatenate(self, resampler_items: List, temp_path: str,
                    cancellation=None) -> Optional[List[float]]:
        """对应 `Concatenate(...)`：把音素样本拼成整条乐句（取消时返回 `None`）。"""

    @abstractmethod
    def check_permissions(self) -> None:
        """对应 `CheckPermissions`：非 Windows 上补执行位（内置实现是空操作）。"""

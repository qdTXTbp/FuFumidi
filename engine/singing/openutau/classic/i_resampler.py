# -*- coding: utf-8 -*-
"""变调器接口 —— **照搬** `OpenUtau.Core/Classic/IResampler.cs`（25 行）。

经典（UTAU）线里"把一个音素按音高拉伸"这一步是**可替换**的：可以是随包自带的
Worldline（纯 C#/原生库），也可以是用户放进 resamplers 目录的任意外部程序。
渲染器只依赖这个接口。

## 与 C# 的载体差异
- C# 的 `ILogger`（Serilog）在 Python 侧就是标准库的 `logging.Logger`。
  接口签名保留 `logger` 参数，因为外部实现要往里写自己进程的 stdout/stderr。
- C# 的 `ResamplerManifest? Manifest`（可空）→ Python 的 `Optional[ResamplerManifest]`。
"""

from abc import ABC, abstractmethod
from typing import List, Optional

from .resampler_manifest import ResamplerManifest


class IResampler(ABC):
    """对应 C# 的 `IResampler`。"""

    @property
    @abstractmethod
    def file_path(self) -> str:
        """对应 `FilePath`：工具自身的绝对路径（Worldline 是原生库路径）。"""

    @property
    @abstractmethod
    def no_wrapper_script(self) -> bool:
        """对应 `NoWrapperScript`：是否**不需要**外层包装脚本（原生库/自包含实现为真）。"""

    @abstractmethod
    def do_resampler(self, args, logger) -> List[float]:
        """对应 `DoResampler(ResamplerItem, ILogger)`：直接交出样本。"""

    @abstractmethod
    def do_resampler_returns_file(self, args, logger) -> Optional[str]:
        """对应 `DoResamplerReturnsFile(...)`：只交出**输出文件路径**（缓存复用）。"""

    @abstractmethod
    def check_permissions(self) -> None:
        """对应 `CheckPermissions`：非 Windows 上补执行位（Windows 上是空实现）。"""

    @property
    @abstractmethod
    def manifest(self) -> Optional[ResamplerManifest]:
        """对应 `Manifest`：自描述清单（没有就是 `None`）。"""

    @abstractmethod
    def supports_flag(self, abbr: str) -> bool:
        """对应 `SupportsFlag(abbr)`：认不认某个表达式缩写对应的 flag。"""

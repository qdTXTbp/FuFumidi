# -*- coding: utf-8 -*-
"""自带的变调器 —— **照搬** `OpenUtau.Core/Classic/WorldlineResampler.cs`（66 行）。

OpenUTAU 有一条**不依赖任何外部程序**的 Classic 线：变调用自带的 Worldline
（`Render/Worldline.Resample` + 原生 `worldline` 库），拼接用自带的 `SharpWavtool`。
这个类就是那条线的变调半边 —— 本项目的方针也是走这条路（见
`docs/utau/selection-report.md`：不分发 UTAU 原版闭源 exe）。

## 照搬时保留的语义
- `NoWrapperScript = true`（原生库/自带实现，不需要外层包装脚本）。
- `Manifest` 里三个表达式 `Mt`(tension) / `Mb`(breathiness) / `Mv`(voicing) 与
  **`expressionFilter = false`** —— 后者意味着"不按清单过滤 flag"，
  三个表达式只是**声明它能用**，供界面展示。
- `SupportsFlag` **恒为 true**（Worldline 接受任何 flag，不认识的会被 `GetFlag` 忽略）。

## 与 C# 的载体差异
- `PathManager.Inst.RootPath` → 可注入宿主 `ClassicHost.root_path`；
  文件名按平台补 `.dll` / `.dylib` / `.so`（C# 用 `OS.IsWindows()` 等判断，
  这里用 `sys.platform`）。
- `DoResampler` 里对两种 `SynthRequestError` 的**用户可读消息包装**
  （`MessageCustomizableException` + `<translate:...>` 键）属于 UI 层（M3，未照搬）：
  这里保留**异常类型**（渲染器按类型分支）并把音素名带进消息。
- `ILogger`（Serilog）→ 标准库 `logging.Logger`；本类不往里写（C# 原实现也不写，
  进程输出由 `ExeResampler` 负责）。
"""

import logging
import os
import sys
from typing import List, Optional

from ..renderers import get_cache_lock
from ..wave import Wave
from ..worldline import CutOffBeforeOffsetError, CutOffExceedDurationError, resample
from ...ustx.model import UExpressionDescriptor, UExpressionType
from . import resampler_item
from .i_resampler import IResampler
from .resampler_manifest import ResamplerManifest

logger = logging.getLogger(__name__)


def _native_extension() -> str:
    """对应 `OS.IsWindows() ? ".dll" : OS.IsMacOS() ? ".dylib" : ".so"`。"""
    if sys.platform == 'win32':
        return '.dll'
    if sys.platform == 'darwin':
        return '.dylib'
    return '.so'


class WorldlineResampler(IResampler):
    """对应 C# 的 `WorldlineResampler`。"""

    #: `public const string name = "worldline";`
    NAME = 'worldline'

    def __init__(self, root_path: Optional[str] = None):
        root = resampler_item.host.root_path if root_path is None else root_path
        self._file_path = os.path.join(root, self.NAME + _native_extension())
        # `NoWrapperScript = true`
        self._no_wrapper_script = True

    # ------------------------------------------------------------------ IResampler

    @property
    def file_path(self) -> str:
        return self._file_path

    @property
    def no_wrapper_script(self) -> bool:
        return self._no_wrapper_script

    def do_resampler(self, args, logger=None) -> List[float]:
        """对应 `DoResampler(item, logger)`：直接调 `Worldline.Resample`。

        ★ 两种 `SynthRequestError` 在 C# 里会被包成 `MessageCustomizableException`
        （带翻译键的 UI 文案）。那层文案属 M3；这里**保留异常类型**并补上音素名，
        渲染器照样能按类型分支。
        """
        try:
            return resample(args)
        except CutOffExceedDurationError:
            raise CutOffExceedDurationError(
                'Failed to render\n Oto error: cutoff exceeds audio duration \n%s'
                % args.phone.phoneme, item=args) from None
        except CutOffBeforeOffsetError:
            raise CutOffBeforeOffsetError(
                'Failed to render\n Oto error: cutoff before offset \n%s'
                % args.phone.phoneme, item=args) from None

    def do_resampler_returns_file(self, args, logger=None) -> Optional[str]:
        """对应 `DoResamplerReturnsFile`：把结果写成 16 位 WAV 缓存文件并返回路径。"""
        samples = self.do_resampler(args, logger)
        with get_cache_lock(args.output_file):
            Wave.write_mono16_wav(args.output_file, samples)
        return args.output_file

    def check_permissions(self) -> None:
        """对应 `CheckPermissions() { }` —— 自带实现不需要补执行位。"""
        return None

    @property
    def manifest(self) -> ResamplerManifest:
        """对应 `Manifest`：声明 Mt / Mb / Mv 三个表达式，且**不过滤** flag。"""
        manifest = ResamplerManifest()
        manifest.expression_filter = False
        for name, abbr, mn, mx, default, flag in (
                ('tension', 'ten', -100, 100, 0, 'Mt'),
                ('breathiness', 'brea', -100, 100, 0, 'Mb'),
                ('voicing', 'voi', 0, 100, 100, 'Mv')):
            descriptor = UExpressionDescriptor(
                name=name, abbr=abbr, type=UExpressionType.NUMERICAL,
                min=mn, max=mx, default_value=default, flag=flag,
                is_flag=bool(flag))
            manifest.expressions[abbr] = descriptor
        return manifest

    def supports_flag(self, abbr: str) -> bool:
        """对应 `SupportsFlag(abbr) => true`：Worldline 认所有 flag。"""
        return True

    def __str__(self):
        # 对应 `ToString() => name`
        return self.NAME

    __repr__ = __str__

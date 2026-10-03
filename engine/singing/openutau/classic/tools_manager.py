# -*- coding: utf-8 -*-
"""工具管理器 —— **照搬** `OpenUtau.Core/Classic/ToolsManager.cs`（140 行）。

它是"渲染时要用的 resampler / wavtool 从哪来"的唯一来源：
先放两份内置拼接器（`SharpWavtool(true/false)`）与一份内置变调器
（`WorldlineResampler`），再把用户放在 `ResamplersPath` / `WavtoolsPath` 下的
外部程序扫进来，按**字符串名**建索引。`ClassicRenderer` 全程通过它取工具。

## 照搬时保留的语义（别"整理"掉）
1. ★ **名对不上就回落，而不是报错**：
   `GetResampler` 回落 `worldline`、`GetWavtool` 回落 `convergence`。
   只有当**回落项本身也不在表里**时才会抛（C# `KeyNotFoundException` ↔ Python `KeyError`）。
2. ★ `SearchResamplers` / `SearchWavtools` 的 `catch` 里会
   **`resamplers.Clear()`（连刚加进去的内置项一起清掉）**，而随后的
   `foreach` 又只按当前（空）列表重建索引 —— 于是**目录建不出来/枚举失败**时，
   整张表连同回落项一起消失。这是上游既有行为（看着很危险），照搬。
   触发条件很现实：宿主没配 `ResamplersPath`（空串）时 `CreateDirectory("")` 就会抛。
3. `LoadResampler` / `LoadWavtool` 按**扩展名 + 平台**分派，且判据不同：
   - 两者都有 `(IsWindows || WinePath 非空) && (".exe" | ".bat")` 这一支；
   - 非 Windows 上 resampler 收 `.sh` 或**无扩展名**（都走 `ExeResampler`），
     wavtool 收 `.sh` 或**无扩展名**（走 `UnixWavtool`）。
   ★ 注意非 Windows 那支**不看 WinePath**。
4. `.exe`/`.bat` 的大小写：C# 先 `ToLower()` 再比，这里一致。

## ★ 载体差异
- C# 是 `SingletonBase<ToolsManager>`（`ToolsManager.Inst`）。Python 侧用
  **可注入的模块级实例**：`get_tools_manager()` / `set_tools_manager(...)` ——
  与 `worldline.get_native()`、`ClassicSingerLoader` 的工厂注册同一套路。
- `PathManager.Inst.ResamplersPath / WavtoolsPath` → 读 `resampler_item.host`
  （**函数内**取，这样宿主可以在运行期被换掉）。
- ★ `_locker` 必须是**可重入锁**：`Initialize()` 持锁后调 `SearchResamplers()`，
  后者**自己又** `lock(_locker)`。C# 的 `Monitor` 同线程可重入，
  Python 的 `threading.Lock` 不行 → 会在第一次 `Initialize()` 就自锁死
  （计划文档陷阱 #21 的同一类）。
- `Directory.EnumerateFiles(..., RecurseSubdirectories: true)` → `os.walk`。
  两者都**不保证顺序**，这里同样不排序（排序会是行为变更）。
"""

import os
import threading
from typing import Dict, List, Optional

from ..os_util import is_windows
from ..singer import Preferences
from .exe_resampler import ExeResampler
from .exe_wavtool import ExeWavtool
from .sharp_wavtool import SharpWavtool
from .unix_wavtool import UnixWavtool
from .voicebank_loader import cs_get_extension
from .worldline_resampler import WorldlineResampler


def _host():
    """取当前宿主（`PathManager.Inst` 的替身）。函数内导入避免包初始化成环。"""
    from . import resampler_item
    return resampler_item.host


def _enumerate_files(base: str) -> List[str]:
    """对应 `Directory.EnumerateFiles(base, "*", RecurseSubdirectories: true)`。"""
    out: List[str] = []
    for root, _dirs, files in os.walk(base):
        for n in files:
            out.append(os.path.join(root, n))
    return out


class ToolsManager:
    """对应 `ToolsManager`。"""

    def __init__(self):
        # ★ RLock：见模块 docstring 的"可重入"说明
        self._locker = threading.RLock()
        self._resamplers: List = []
        self._wavtools: List = []
        self._resamplers_map: Dict[str, object] = {}
        self._wavtools_map: Dict[str, object] = {}

    # ------------------------------------------------------------------ 只读视图

    @property
    def resamplers(self) -> List:
        """对应 `Resamplers`（返回**副本**，与 C# 的 `ToList()` 一致）。"""
        with self._locker:
            return list(self._resamplers)

    @property
    def wavtools(self) -> List:
        """对应 `Wavtools`。"""
        with self._locker:
            return list(self._wavtools)

    # ------------------------------------------------------------------ 分派

    def load_resampler(self, file_path: str, base_path: str) -> Optional[ExeResampler]:
        """对应 `LoadResampler`。"""
        if not os.path.isfile(file_path):
            return None
        ext = cs_get_extension(file_path).lower()
        if (is_windows() or bool(Preferences.wine_path)) and ext in ('.exe', '.bat'):
            return ExeResampler(file_path, base_path)
        if (not is_windows()) and (ext == '.sh' or ext == ''):
            return ExeResampler(file_path, base_path)
        return None

    def load_wavtool(self, file_path: str, base_path: str):
        """对应 `LoadWavtool`。"""
        if not os.path.isfile(file_path):
            return None
        ext = cs_get_extension(file_path).lower()
        if (is_windows() or bool(Preferences.wine_path)) and ext in ('.exe', '.bat'):
            return ExeWavtool(file_path, base_path)
        if (not is_windows()) and (ext == '.sh' or ext == ''):
            return UnixWavtool(file_path, base_path)
        return None

    # ------------------------------------------------------------------ 扫描

    def initialize(self) -> None:
        """对应 `Initialize`。"""
        with self._locker:
            self.search_resamplers()
            self.search_wavtools()

    def search_resamplers(self) -> None:
        """对应 `SearchResamplers`。"""
        with self._locker:
            self._resamplers.clear()
            self._resamplers_map.clear()
            self._resamplers.append(WorldlineResampler())
            base_path = getattr(_host(), 'resamplers_path', '') or ''
            try:
                os.makedirs(base_path, exist_ok=True)
                for file in _enumerate_files(base_path):
                    driver = self.load_resampler(file, base_path)
                    if driver is not None:
                        self._resamplers.append(driver)
            except Exception:                              # noqa: BLE001
                # ★ 照搬：连内置的 WorldlineResampler 一起清掉（见 docstring 第 2 条）
                self._resamplers.clear()
            for resampler in self._resamplers:
                self._resamplers_map[str(resampler)] = resampler

    def search_wavtools(self) -> None:
        """对应 `SearchWavtools`。"""
        with self._locker:
            self._wavtools.clear()
            self._wavtools_map.clear()
            self._wavtools.append(SharpWavtool(True))
            self._wavtools.append(SharpWavtool(False))
            base_path = getattr(_host(), 'wavtools_path', '') or ''
            try:
                os.makedirs(base_path, exist_ok=True)
                for file in _enumerate_files(base_path):
                    driver = self.load_wavtool(file, base_path)
                    if driver is not None:
                        self._wavtools.append(driver)
            except Exception:                              # noqa: BLE001
                self._wavtools.clear()
            for wavtool in self._wavtools:
                self._wavtools_map[str(wavtool)] = wavtool

    # ------------------------------------------------------------------ 取用

    @staticmethod
    def _fallback(table: Dict[str, object], key: str, kind: str):
        """回落取值；表里连回落项都没有时抛 `KeyError`。

        ★ 与 C# 的差异只在**消息**：C# 是索引器抛的 `KeyNotFoundException`（消息只有键名），
        这里补上"表是空的、通常是宿主没给可用工具目录"的提示。异常**类型**语义不变
        （`KeyError` ↔ `KeyNotFoundException`），`except` 分支照常能接住。
        """
        if key in table:
            return table[key]
        raise KeyError(
            '工具表里没有 %s 的回落项 %r（表里现有：%r）。'
            '最常见的原因是宿主没提供可用的工具目录：DataPath 为空时 '
            'SearchResamplers/SearchWavtools 会走上游「扫描失败即清空整张表」的分支。'
            % (kind, key, sorted(table)))

    def get_resampler(self, name: Optional[str]):
        """对应 `GetResampler`：名对不上回落 `worldline`；回落项也没有则 `KeyError`。"""
        with self._locker:
            if name is not None and name in self._resamplers_map:
                return self._resamplers_map[name]
            return self._fallback(self._resamplers_map, WorldlineResampler.NAME, 'resampler')

    def get_wavtool(self, name: Optional[str]):
        """对应 `GetWavtool`：名对不上回落 `convergence`；回落项也没有则 `KeyError`。"""
        with self._locker:
            if name is not None and name in self._wavtools_map:
                return self._wavtools_map[name]
            return self._fallback(self._wavtools_map, SharpWavtool.NAME_CONVERGENCE, 'wavtool')


#: 模块级实例（对应 C# 的 `ToolsManager.Inst`，但**可注入**）
_default: Optional[ToolsManager] = None


def get_tools_manager() -> ToolsManager:
    """对应 `ToolsManager.Inst`。

    ★ C# 在启动时（`SplashWindow.axaml.cs`）就调了一次 `ToolsManager.Inst.Initialize()`，
    设置页与轨道设置页也会再调（用户新放了工具就重扫）。也就是说
    **"运行中的 OpenUTAU"里它永远是扫描过的**。所以这里首次创建时顺手 `initialize()`，
    对齐那个稳态；要一个干净实例请 `set_tools_manager(ToolsManager())`。
    """
    global _default
    if _default is None:
        _default = ToolsManager()
        _default.initialize()
    return _default


def set_tools_manager(manager: Optional[ToolsManager]) -> None:
    """替换/清空模块级实例（测试与宿主注入用）。"""
    global _default
    _default = manager

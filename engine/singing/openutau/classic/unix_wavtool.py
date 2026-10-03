# -*- coding: utf-8 -*-
"""Unix 外部 wavtool —— **照搬** `OpenUtau.Core/Classic/UnixWavtool.cs`（110 行）。

Linux / macOS 上的用户自备 wavtool（`.sh` 或无扩展名的可执行脚本）走这条；
Windows 上的 `.exe`/`.bat` 走 `ExeWavtool`（那个要生成 bat 脚本，见它的 docstring）。

## 照搬时保留的语义（别"整理"掉）
1. ★ **每条 item 都单独调一次 wavtool**（循环体里 `ProcessRunner.Run`）——
   与 `ExeWavtool` 的"生成一个 bat 一次性跑完"完全不同。别把两者统一。
2. 调用前先 `File.Delete(tempPath)`（C# 对不存在的路径是**静默 no-op**）。
3. 只有当某个 item 的输出文件**不存在**时，才在**同一把缓存锁**下补跑 resampler；
   已经存在的直接复用（这就是"第二次渲染不再变调"的来源）。
4. 跑完后如果存在同名的 `.whd` + `.dat`（UTAU 的"两段式"音频容器），
   按 **whd → dat** 顺序拼进 temp 文件并删掉这两个中间文件。
5. `GenerateParameters` 有**两条形态**：
   - `item.phone.direct`（直接音素）：`"temp" "output" offset {durationMs:F1} env`
   - 否则：`"temp" "output" skipOver dur env`
   注意第一条用的是 `durationMs`（`F1`，一位小数），第二条用的是 `dur`
   （`{duration:G999}@{adjustedTempo:G999}{+/-}{durCorrection}`）。
6. `GetEnvelope` 的 11 个数**不是**信封点本身，而是"相对量 + 绝对值"混合：
   `env0.x-env0.x`（恒 0）、`env1.x-env0.x`、`env4.x-env3.x`、`env0.y`、`env1.y`、
   `env3.y`、`env4.y`、`item.overlap`、`env4.x-env4.x`（恒 0）、`env2.x-env1.x`、`env2.y`。
   两个"恒 0"项是上游留的占位，**照搬**（命令行的位置不能少）。
7. `CheckPermissions` 在非 Windows 上补 `0o755`。
"""

import os
from typing import List, Optional

from ..process_runner import run as run_process
from ..renderers import get_cache_lock
from ..wave import Wave
from .i_wavtool import IWavtool
from .voicebank_loader import cs_double


def _g999(v) -> str:
    """对应 C# 的 `:G999`（无 InvariantCulture 的默认 `double.ToString()` 行为）。"""
    return cs_double(v)


class UnixWavtool(IWavtool):
    """对应 `UnixWavtool`。"""

    def __init__(self, file_path: str, base_path: str):
        self._file_path = file_path
        try:
            self._name = os.path.relpath(file_path, base_path)
        except ValueError:                                    # 跨盘符（.NET 返回原路径）
            self._name = file_path

    @property
    def file_path(self) -> str:
        return self._file_path

    def __str__(self) -> str:
        return self._name

    # ------------------------------------------------------------------ 拼接

    def concatenate(self, resampler_items: List, temp_path: str,
                    cancellation=None) -> Optional[List[float]]:
        """对应 `Concatenate`。"""
        if cancellation is not None and cancellation.is_set():
            return None

        if os.path.exists(temp_path):
            os.remove(temp_path)

        from . import resampler_item as _ri

        # `PathManager.Inst.CachePath` 的替身（函数内取值：宿主可能在运行期被替换）
        cache_path = getattr(_ri.host, 'cache_path', '') or ''

        for item in resampler_items:
            if not os.path.isfile(item.output_file):
                with get_cache_lock(item.output_file):
                    item.resampler.do_resampler_returns_file(item, _get_logger())

            parameters = self.generate_parameters(item, temp_path)
            run_process(self._file_path, parameters, _get_logger(),
                        work_dir=cache_path, timeout_ms=5 * 60 * 1000)

        # UTAU 的"两段式"输出：whd（头）+ dat（数据）
        whd_file = temp_path + '.whd'
        dat_file = temp_path + '.dat'
        if os.path.isfile(whd_file) and os.path.isfile(dat_file):
            with open(temp_path, 'wb') as out:
                for f in (whd_file, dat_file):
                    with open(f, 'rb') as src:
                        out.write(src.read())
            try:
                os.remove(whd_file)
            except OSError:
                pass
            try:
                os.remove(dat_file)
            except OSError:
                pass

        if not temp_path or os.path.isfile(temp_path):
            return Wave.get_samples(temp_path)
        return []

    def generate_parameters(self, item, temp_path: str) -> str:
        """对应 `GenerateParameters`。"""
        envelope = self.get_envelope(item)
        # ★ `{item.durCorrection}` 在 C# 里是**无格式**的 `double.ToString()`（不是 :G999，
        #   但两者对 double 的输出相同）—— 0.0 要写成 "0" 而不是 "0.0"，
        #   所以必须过 `cs_double` 而不是直接拼。
        dur = '%s@%s%s%s' % (_g999(item.phone.duration), _g999(item.phone.adjusted_tempo),
                             '+' if item.dur_correction >= 0 else '',
                             cs_double(item.dur_correction))

        if item.phone.direct:
            return '"%s" "%s" %s %.1f %s' % (temp_path, item.output_file,
                                             _g999(item.offset), item.phone.duration_ms, envelope)
        return '"%s" "%s" %s %s %s' % (temp_path, item.output_file,
                                       _g999(item.skip_over), dur, envelope)

    def get_envelope(self, item) -> str:
        """对应 `GetEnvelope`（11 个数，含两个恒 0 的占位 —— 见模块 docstring 第 6 条）。"""
        env = item.phone.envelope
        parts = [
            _g999(env[0].x - env[0].x),
            _g999(env[1].x - env[0].x),
            _g999(env[4].x - env[3].x),
            _g999(env[0].y),
            _g999(env[1].y),
            _g999(env[3].y),
            _g999(env[4].y),
            _g999(item.overlap),
            _g999(env[4].x - env[4].x),
            _g999(env[2].x - env[1].x),
            _g999(env[2].y),
        ]
        return ' '.join(parts)

    def check_permissions(self) -> None:
        """对应 `CheckPermissions`：非 Windows 上补执行位。"""
        from ..os_util import is_windows
        if is_windows() or not os.path.isfile(self._file_path):
            return
        os.chmod(self._file_path, (7 << 6) | (5 << 3) | 5)


def _get_logger():
    """Serilog 的 `Log.Logger` 在 Python 侧就是标准库 logger（与其它模块一致）。"""
    import logging
    return logging.getLogger('openutau')

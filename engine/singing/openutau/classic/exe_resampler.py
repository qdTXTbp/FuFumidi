# -*- coding: utf-8 -*-
"""外部 resampler（用户自备的 `resample.exe` / `moresampler.exe` …）—— **照搬**
`OpenUtau.Core/Classic/ExeResampler.cs`（141 行）。

UTAU 生态里"变调"这一步绝大多数时候是**外部程序**：把 wav 路径、音名、flags、
音高串当命令行参数传进去，它吐一个变调后的 wav。本类就是那个调用方。

## 照搬时保留的语义（别"整理"掉）
1. ★ 构造函数**不检查 `FilePath` 是否为空**就继续算别的字段：
   文件不存在时 `FilePath` 是 `None`、`_isLegalPlugin` 为假，但
   `NoWrapperScript` / `Manifest` / `useWine` **照样算出来**（它们只看扩展名与偏好设置）。
   随后 `do_resampler_returns_file` 靠 `_isLegalPlugin` 提前返回 `None`。
2. `NoWrapperScript = ext != ".exe" && ext != ".bat"` —— 语义是
   **"不是 Windows 可执行文件"**，于是 `.sh`/无扩展名的原生 resampler 会被标记为
   "不需要外层脚本"。`ExeWavtool` 会拿这个标志决定"这条 resampler 得由谁先跑"。
3. `useWine = winePath 非空 && !NoWrapperScript` —— 只在**非原生**工具上走 wine。
4. ★ `moresampler` 的补丁：文件名（不含扩展名）恰好是 `moresampler` 时，
   去同目录把 `moreconfig.txt` 里的 `resampler-compatibility` 行修成 `on`
   （没有这一行就追加）。**文件不存在也会创建**。失败只记日志。
5. `LoadManifest` 找的是**同路径换扩展名为 `.yaml`**；不存在或解析失败都返回
   **空清单**（`ResamplerManifest()`），不抛异常。
6. ★ `do_resampler` 的条件是 `IsNullOrEmpty(tmpFile) || File.Exists(tmpFile)` ——
   看着像笔误（应为 `&&`），但**照搬**：`tmpFile` 为空时会走到"打开空路径"并抛错。
   实际触发不了，因为 `do_resampler_returns_file` 只在 `_isLegalPlugin` 为假时返回
   `None`，而那种情况下调用方也不该来要样本。
7. 外部程序跑完**却没有产出输出文件**时抛 `ResamplerFailedException`，
   消息里带该进程的**完整输出**（这是排查"为啥不出声"的唯一线索）。
8. `CheckPermissions` 在非 Windows 上给工具补 `0o755`（UTAU 的 `resample` 常见没执行位）。

## ★ 载体差异
- `Preferences.Default.WinePath` 是全局单例 → 走 `singer.Preferences` 类字段
  （项目既有做法）。测试里直接改 `Preferences.wine_path` 即可。
- `Path.GetRelativePath` → `os.path.relpath`；跨盘符时 .NET 会**返回原绝对路径**，
  Python 会抛 `ValueError`，这里按 .NET 行为兜成原路径。
- `FormattableString.Invariant` → f-string 默认格式（两者都是"最短可往返"，
  且都不受本机 locale 影响）。
"""

import os
from typing import List, Optional

from ..base64_util import encode_int12_list
from ..music_math import MusicMath
from ..os_util import is_windows
from ..process_runner import run as run_process
from ..renderer import ResamplerFailedException
from ..singer import Preferences
from ..wave import Wave
from .i_resampler import IResampler
from .resampler_manifest import ResamplerManifest
from .voicebank_loader import cs_double

#: 对应 C# 的 `moreconfig.txt` 里那一行（**字符完全一致**，含空格）
_COMPAT_LINE = 'resampler-compatibility on'
_COMPAT_PREFIX = 'resampler-compatibility'


def _relpath(base: str, target: str) -> str:
    """对应 `Path.GetRelativePath`：跨盘符时 .NET 返回原绝对路径。"""
    try:
        return os.path.relpath(target, base)
    except ValueError:
        return target


#: 公开别名：`ExeWavtool` 生成 bat 时也要用同一个 `Path.GetRelativePath` 语义。
#: 与 `cs_double` 同理 —— **只留一份**，否则两处对"跨盘符怎么办"的处理会悄悄分叉。
rel_path = _relpath


def _change_ext(path: str, new_ext: str) -> str:
    """对应 `Path.ChangeExtension`。"""
    root, _ = os.path.splitext(path)
    return root + new_ext


class ExeResampler(IResampler):
    """对应 `ExeResampler`。"""

    def __init__(self, file_path: str, base_path: str):
        self._file_path: Optional[str] = None
        self._name = ''
        self._is_legal_plugin = False
        if os.path.isfile(file_path):
            self._file_path = file_path
            self._name = _relpath(base_path, file_path)
            self._is_legal_plugin = True

        # 原生（非 exe/bat）工具无法从 wine 里调起，必须直接调 —— 见 docstring 第 2 条
        from .voicebank_loader import cs_get_extension
        ext = cs_get_extension(file_path).lower()
        self._no_wrapper_script = (ext != '.exe' and ext != '.bat')

        self._wine_path = Preferences.wine_path
        self._use_wine = bool(self._wine_path) and not self._no_wrapper_script

        self._manifest = self.load_manifest()

        # 让 moresampler 满意（上游原话）
        try:
            if os.path.splitext(os.path.basename(file_path))[0] == 'moresampler':
                more_config = os.path.join(os.path.dirname(file_path), 'moreconfig.txt')
                self.fix_more_config(more_config)
        except Exception:                                     # noqa: BLE001
            pass

    # ------------------------------------------------------------------ 接口属性

    @property
    def file_path(self) -> str:
        return self._file_path

    @property
    def no_wrapper_script(self) -> bool:
        return self._no_wrapper_script

    @property
    def manifest(self) -> Optional[ResamplerManifest]:
        return self._manifest

    @property
    def is_legal_plugin(self) -> bool:
        return self._is_legal_plugin

    def __str__(self) -> str:
        return self._name

    # ------------------------------------------------------------------ 清单

    def load_manifest(self) -> ResamplerManifest:
        """对应 `LoadManifest`：同路径的 `.yaml`；不可用就给**空清单**。"""
        try:
            manifest_path = _change_ext(self._file_path or '', '.yaml')
            if not os.path.isfile(manifest_path):
                return ResamplerManifest()
            return ResamplerManifest.load(manifest_path)
        except Exception:                                     # noqa: BLE001
            return ResamplerManifest()

    def fix_more_config(self, more_config_path: str) -> None:
        """对应 `FixMoreConfig`：把 `resampler-compatibility` 修成 `on`。"""
        lines: List[str] = []
        if os.path.isfile(more_config_path):
            with open(more_config_path, 'r', encoding='utf-8', errors='replace') as f:
                lines = f.read().split('\n')
                # C# `ReadAllLines` 不带行尾；split 会多出一个空尾巴
                if lines and lines[-1] == '':
                    lines.pop()
        for i in range(len(lines)):
            if lines[i].startswith(_COMPAT_PREFIX):
                if lines[i] == _COMPAT_LINE:
                    return                                    # 已经是对的，不动
                lines[i] = _COMPAT_LINE
                with open(more_config_path, 'w', encoding='utf-8') as f:
                    f.write('\n'.join(lines) + '\n')
                return
        lines.append(_COMPAT_LINE)
        with open(more_config_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')

    # ------------------------------------------------------------------ 执行

    def do_resampler(self, args, logger) -> List[float]:
        """对应 `DoResampler`：拿到输出文件再解码成样本。"""
        tmp_file = self.do_resampler_returns_file(args, logger)
        # ★ 照搬上游的 `||`（见 docstring 第 6 条）
        if not tmp_file or os.path.isfile(tmp_file):
            return Wave.get_samples(tmp_file)
        return []

    def do_resampler_returns_file(self, args, logger) -> Optional[str]:
        """对应 `DoResamplerReturnsFile`：只跑进程、只回输出文件路径。"""
        if not self._is_legal_plugin:
            return None

        tmp_file = args.output_file
        # ★ 命令行里的 **double 参数一律过 `cs_double`**：C# 的 `FormattableString.Invariant`
        #   只固定了区域，格式仍是 `double.ToString()` —— 120.0 要写成 "120" 而不是 "120.0"。
        #   `velocity` / `volume` / `modulation` 是 `int`，直接写十进制。
        arg_param = (
            '"%s" "%s" %s %d "%s" %s %s %s %s %d %d !%s %s'
            % (args.input_temp, tmp_file, MusicMath.get_tone_name(args.tone),
               args.velocity, args.get_flags_string(),
               cs_double(args.offset), cs_double(args.dur_required),
               cs_double(args.consonant), cs_double(args.cutoff),
               args.volume, args.modulation,
               cs_double(args.tempo), encode_int12_list(args.pitches))
        )
        try:
            logger.info(' > %s %s' % (self._file_path, arg_param))
        except Exception:                                     # noqa: BLE001
            pass

        if self._use_wine:
            output = run_process(self._wine_path, '%s %s' % (self._file_path, arg_param), logger)
        else:
            output = run_process(self._file_path, arg_param, logger)

        if not os.path.isfile(tmp_file):
            raise ResamplerFailedException('\n%s' % output)
        return tmp_file

    def check_permissions(self) -> None:
        """对应 `CheckPermissions`：非 Windows 上补执行位。"""
        if is_windows() or not self._file_path or not os.path.isfile(self._file_path):
            return
        os.chmod(self._file_path, (7 << 6) | (5 << 3) | 5)

    def supports_flag(self, abbr: str) -> bool:
        """对应 `SupportsFlag`：没清单或清单不筛表达式 → 一律认。"""
        if self._manifest is None or not self._manifest.expression_filter:
            return True
        return abbr in self._manifest.expressions

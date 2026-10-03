# -*- coding: utf-8 -*-
r"""外部 wavtool（Windows 上的 `.exe` / `.bat`）—— **照搬**
`OpenUtau.Core/Classic/ExeWavtool.cs`（224 行）。

与 `UnixWavtool` 的分工完全不同（**别把两者统一**）：
`UnixWavtool` 是"每条 item 单独跑一次工具"；`ExeWavtool` 是**生成一个 `temp.bat`
把整条乐句一次跑完**（老 UTAU 的 wavtool 就是这种批处理式的用法）。

## 照搬时保留的语义（别"整理"掉）
1. ★ **只有 `NoWrapperScript` 为真的 resampler 才在这里先跑一遍**：
   "内置 worldline 与 Linux/macOS 的 resampler 没法从 bat 里调起，只能直接调"。
   其余的 resampler 是**由 `temp_helper.bat` 在批处理内部调起**的 —— 也就是说
   「谁负责跑 resampler」在两条分支上是**有意不对称**的（见计划文档陷阱 22）。
2. `useWine = !IsNullOrEmpty(winePath)` —— ★ 注意这里**没有** `&& !NoWrapperScript`
   （与 `ExeResampler` 不同）。照搬这个不对称。
3. `WriteSetUp` 里 `@set samples=44100` 是**写死**的，与声库采样率无关。
4. ★ `EscapeFlags` 的正则是 `[&/\\|<>\""'!:#\n\t].` —— 字符类后面**还跟着一个 `.`**，
   所以它删的是"一个特殊字符 **+ 紧随其后的一个字符**"。这是上游既有行为
   （看着像笔误，但这是防命令注入的那道闸，改了行为就变了），**照搬**。
5. `ConvertToWindowsPath` 是给 wine 用的：先记录是否绝对路径（开头 `/`），
   然后把 `\ `（反斜杠+空格）里的反斜杠删掉，再把 `/` 全换成 `\`，最后给绝对路径加 `Z:` 前缀。
6. `CheckPermissions` 在 `ExeWavtool` 里是**空实现**（不像 `ExeResampler`/`UnixWavtool`
   会 chmod）—— 因为 Windows 上没有执行位这回事。
7. `PrepareHelper` 写的 `temp_helper.bat` 只在**不存在**时创建（在缓存锁下），
   之后一直复用。

## ★ 载体差异
- `Encoding.GetEncoding(0)`（Windows 的 ANSI 代码页）→ Python 的 `'mbcs'` 编解码器；
  非 Windows 用**不带 BOM** 的 UTF-8（上游注释：BOM 会让 wine 下的 bat 出问题）。
- `StreamWriter.WriteLine` 用的是 `Environment.NewLine` → 这里按平台写 `\r\n` / `\n`。
- `PathManager.Inst.CachePath` → `resampler_item.host.cache_path`（可注入宿主）。
"""

import os
import re
from typing import List, Optional

from ..base64_util import encode_int12_list
from ..music_math import MusicMath
from ..os_util import is_windows
from ..process_runner import run as run_process
from ..renderers import get_cache_lock
from ..singer import Preferences
from ..wave import Wave
from .exe_resampler import rel_path
from .i_wavtool import IWavtool
from .voicebank_loader import cs_double

#: ★ 对应 `Regex.Replace(flag, @"[&/\\|<>\""'!:#\n\t].", "")` —— **末尾那个 `.` 是上游原文**，
#: 所以匹配的是「一个特殊字符 + 任意一个字符」，两者都被删掉。见模块 docstring 第 4 条。
_FLAG_SPECIAL_RE = re.compile("[&/\\\\|<>\x22'!:#\\n\\t].")

#: 对应 `EscapeFlags` 里那张后缀表（顺序也一致）
_FLAG_EXTENSIONS = (
    '.exe', '.py', '.app', '.bat', '.cmd', '.sh', '.vbs', '.js', '.wsf', '.msi', '.com', '.pif',
    '.scr', '.hta', '.cpl', '.jar', '.ps1', '.psm1', '.msh', '.msh1', '.msh2', '.mshxml',
    '.msh1xml', '.msh2xml',
)

_PROGRESS_WIDTH = 40


def _os_encoding() -> str:
    """对应 `OS.IsWindows() ? Encoding.GetEncoding(0) : UTF8`（见模块 docstring）。"""
    return 'mbcs' if is_windows() else 'utf-8'


def _newline() -> str:
    """对应 `StreamWriter.WriteLine` 的 `Environment.NewLine`。"""
    return '\r\n' if is_windows() else '\n'


def escape_flags(flag: str) -> str:
    """对应 `EscapeFlags`：防 bat 命令行注入。

    ★ 后缀表那一段是 C# 的 `foreach` —— **单趟、无 break**。命中一个后缀剥掉之后，
    后面的后缀接着拿**已经变短的** flag 继续比。别写成"命中就 break"。
    """
    flag = _FLAG_SPECIAL_RE.sub('', flag)
    for ext in _FLAG_EXTENSIONS:                       # 单趟，不 break
        if flag.lower().endswith(ext):
            flag = flag[:len(flag) - len(ext)]
    low = flag.lower()
    if low.startswith('https://'):
        flag = flag[8:]
    elif low.startswith('http://'):
        flag = flag[7:]
    return flag


def convert_to_windows_path(linux_path: str) -> str:
    """对应 `ConvertToWindowsPath`（给 wine 用）。

    ★ 空串会在 `path[0]` 上抛 `IndexError`（C# 同样在 `path[0]` 上抛）。
    """
    chars = list(linux_path)
    absolute = chars[0] == '/'
    for i in range(len(chars) - 1, 0, -1):
        if chars[i] == ' ' and chars[i - 1] == '\\':
            del chars[i - 1]
            i -= 1                                     # 对应 `i--`（照搬）
    for i in range(len(chars)):
        if chars[i] == '/':
            chars[i] = '\\'
    windows_path = ''.join(chars)
    return ('Z:' + windows_path) if absolute else windows_path


class ExeWavtool(IWavtool):
    """对应 `ExeWavtool`。"""

    #: 对应 `static object tempBatLock`（串行化 temp.bat 的写入与执行）
    _temp_bat_lock = __import__('threading').Lock()

    def __init__(self, file_path: str, base_path: str):
        self._file_path = file_path
        self._name = rel_path(base_path, file_path)
        # 编码名（字符串），别名刻意不叫 `_os_encoding` —— 那是模块级函数名，
        # 同名会让 `self._os_encoding()` 变成"对字符串做调用"。
        self._encoding = _os_encoding()
        self._wine_path = Preferences.wine_path
        # ★ 注意：这里**没有** `&& !NoWrapperScript`（与 ExeResampler 不同），照搬
        self._use_wine = bool(self._wine_path)

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

        import logging
        logger = logging.getLogger('openutau')

        from . import resampler_item as _ri
        cache_path = getattr(_ri.host, 'cache_path', '') or ''

        # 自带（不依赖外层脚本）的 resampler 只能在这里直接调 —— 见 docstring 第 1 条
        for item in resampler_items:
            if (getattr(item.resampler, 'no_wrapper_script', False)
                    and not (cancellation is not None and cancellation.is_set())
                    and not os.path.isfile(item.output_file)):
                with get_cache_lock(item.output_file):
                    item.resampler.do_resampler_returns_file(item, logger)

        self.prepare_helper(cache_path, logger)

        bat_path = os.path.join(cache_path, 'temp.bat')
        with ExeWavtool._temp_bat_lock:
            self._write_bat(bat_path, resampler_items, temp_path, cache_path)
            if self._use_wine:
                run_process(self._wine_path, bat_path, logger,
                            work_dir=cache_path, timeout_ms=5 * 60 * 1000)
            else:
                run_process(bat_path, '', logger,
                            work_dir=cache_path, timeout_ms=5 * 60 * 1000)

        if not temp_path or os.path.isfile(temp_path):
            return Wave.get_samples(temp_path)
        return []

    # ------------------------------------------------------------------ 生成 bat

    def _write_bat(self, bat_path: str, items: List, temp_path: str, cache_path: str) -> None:
        with open(bat_path, 'w', encoding=self._encoding, newline='') as f:
            self.write_set_up(f, items, temp_path, cache_path)
            for i in range(len(items)):
                self.write_item(f, items[i], i, len(items), cache_path)
            self.write_tear_down(f)

    def prepare_helper(self, cache_path: str, logger=None) -> None:
        """对应 `PrepareHelper`：`temp_helper.bat` 不存在才写（在缓存锁下）。"""
        temp_helper = os.path.join(cache_path, 'temp_helper.bat')
        with get_cache_lock(temp_helper):
            if not os.path.isfile(temp_helper):
                self._write_lines(temp_helper, self._helper_lines())

    def _write_lines(self, path: str, lines: List[str]) -> None:
        with open(path, 'w', encoding=self._encoding, newline='') as f:
            f.write(''.join(line + _newline() for line in lines))

    @staticmethod
    def _helper_lines() -> List[str]:
        """对应 `WriteHelper`。"""
        return [
            '@if exist %temp% goto A',
            '@"%resamp%" %1 %temp% %2 %vel% %flag% %5 %6 %7 %8 %params%',
            ':A',
            '@"%tool%" "%output%" %temp% %stp% %3 %env%',
        ]

    def write_set_up(self, w, items: List, temp_path: str, cache_path: str) -> None:
        """对应 `WriteSetUp`（注意 `samples` 写死 44100）。"""
        nl = _newline()
        w.write('@rem project=' + nl)
        w.write('@set loadmodule=' + nl)
        w.write('@set tempo=%s%s' % (cs_double(items[0].tempo), nl))
        w.write('@set samples=44100%s' % nl)
        w.write('@set oto=%s%s' % (self.convert_if_needed(cache_path), nl))
        w.write('@set tool=%s%s' % (self.convert_if_needed(self._file_path), nl))
        temp_file = rel_path(cache_path, temp_path)
        w.write('@set output=%s%s' % (self.convert_if_needed(temp_file), nl))
        w.write('@set helper=temp_helper.bat%s' % nl)
        w.write('@set cachedir=%s%s' % (self.convert_if_needed(cache_path), nl))
        w.write('@set flag="%s"%s' % ('', nl))          # globalFlags 恒为空串
        w.write('@set env=0 5 35 0 100 100 0%s' % nl)
        w.write('@set stp=0%s' % nl)
        w.write(nl)
        # ★ bat 里的 `%output%` 必须写成 `%%output%%`：这是 `%` 格式化，
        #   不转义的话 `%o` 会被当成八进制占位符直接抛 TypeError。
        w.write('@del "%%output%%" 2>nul%s' % nl)
        w.write('@mkdir "%%cachedir%%" 2>nul%s' % nl)
        w.write(nl)

    def write_item(self, w, item, index: int, total: int, cache_path: str) -> None:
        """对应 `WriteItem`。"""
        nl = _newline()
        w.write('@set resamp=%s%s' % (self.convert_if_needed(item.resampler.file_path), nl))
        w.write('@set params=%d %d !%s %s%s'
                % (item.volume, item.modulation, cs_double(item.tempo),
                   encode_int12_list(item.pitches), nl))
        w.write('@set flag="%s"%s' % (escape_flags(item.get_flags_string()), nl))
        w.write('@set env=%s%s' % (self.get_envelope(item), nl))
        w.write('@set stp=%s%s' % (cs_double(item.skip_over), nl))
        w.write('@set vel=%d%s' % (item.velocity, nl))
        rel_output = rel_path(cache_path, item.output_file)
        w.write('@set temp="%%cachedir%%\\%s"%s' % (self.convert_if_needed(rel_output), nl))

        tone_name = MusicMath.get_tone_name(item.tone)
        dur = '%s@%s%s%s' % (cs_double(item.phone.duration), cs_double(item.phone.adjusted_tempo),
                             '+' if item.dur_correction >= 0 else '',
                             cs_double(item.dur_correction))
        rel_input = rel_path(cache_path, item.input_temp)
        w.write('@echo %s%s' % (self.make_progress_bar(index + 1, total), nl))
        if item.phone.direct:
            w.write('@"%%tool%%" "%%output%%" "%%oto%%\\%s" %s %.1f %%env%%%s'
                    % (self.convert_if_needed(rel_input), cs_double(item.offset),
                       item.phone.duration_ms, nl))
        else:
            w.write('@call %%helper%% "%%oto%%\\%s" %s %s %s %s %s %s %s %d%s'
                    % (self.convert_if_needed(rel_input), tone_name, dur,
                       cs_double(item.preutter), cs_double(item.offset),
                       cs_double(item.dur_required), cs_double(item.consonant),
                       cs_double(item.cutoff), index, nl))

    @staticmethod
    def write_tear_down(w) -> None:
        """对应 `WriteTearDown`（whd + dat 两段式输出）。"""
        nl = _newline()
        w.write('@if not exist "%output%.whd" goto E' + nl)
        w.write('@if not exist "%output%.dat" goto E' + nl)
        w.write('copy /Y "%output%.whd" /B + "%output%.dat" /B "%output%"' + nl)
        w.write('del "%output%.whd"' + nl)
        w.write('del "%output%.dat"' + nl)
        w.write(':E' + nl)

    @staticmethod
    def make_progress_bar(index: int, total: int) -> str:
        """对应 `MakeProgressBar`（宽度 40）。"""
        fill = index * _PROGRESS_WIDTH // total
        return '%s%s(%d/%d)' % ('#' * fill, '-' * (_PROGRESS_WIDTH - fill), index, total)

    @staticmethod
    def convert_if_needed(path: str) -> str:
        """对应 `ConvertIfNeeded`：非 Windows 上转成 wine 看得懂的 Windows 路径。"""
        return path if is_windows() else convert_to_windows_path(path)

    def get_envelope(self, item) -> str:
        """对应 `GetEnvelope`（11 个数，含两个恒 0 占位）。"""
        env = item.phone.envelope
        return ' '.join([
            cs_double(env[0].x - env[0].x),
            cs_double(env[1].x - env[0].x),
            cs_double(env[4].x - env[3].x),
            cs_double(env[0].y),
            cs_double(env[1].y),
            cs_double(env[3].y),
            cs_double(env[4].y),
            cs_double(item.overlap),
            cs_double(env[4].x - env[4].x),
            cs_double(env[2].x - env[1].x),
            cs_double(env[2].y),
        ])

    def check_permissions(self) -> None:
        """对应 `ExeWavtool.CheckPermissions` —— **空实现**（Windows 没有执行位）。"""
        return None

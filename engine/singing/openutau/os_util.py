# -*- coding: utf-8 -*-
"""平台探测与"打开文件夹/网页" —— **照搬** `OpenUtau.Core/Util/OS.cs`（119 行）。

C# 里是 `static class OS`（命名空间是 `OpenUtau`，不在 `.Util` 下，虽然文件放在 `Util/`）。
Python 侧用**模块级函数**顶替静态类。

## 命名说明（载体差异）
叫 `os_util` 而不是 `os` —— 避免与标准库 `os` 同名。**这是命名差异，不是文件边界差异**。

## 照搬时保留的语义
1. `WhereIs` 先看**当前目录**（`File.Exists(filename)` 对相对路径成立）再扫 `PATH`，
   命中返回**绝对路径**；全落空返回 `None`（不是抛错）。
2. `GetOpener` 在 Linux 上按 `xdg-open → mimeopen → gnome-open → open` 顺序找，
   都找不到**抛 `IOException`**（这里对应 `OSError`）—— 不静默返回空串。
3. `GetWrappedPath` 只在**非 Windows** 上加引号（Windows 交给 shell 语义）。
4. `GotoFile` 在 Linux 上退化为 `OpenFolder(dirname)`（没有"选中某文件"的概念）。
5. `AppExists` 在 macOS 上判的是**目录且以 `.app` 结尾**，其它平台判文件。
"""

import os
import subprocess
import sys
from typing import Optional

#: 对应 `linuxOpeners`
LINUX_OPENERS = ('xdg-open', 'mimeopen', 'gnome-open', 'open')


def is_windows() -> bool:
    """对应 `OS.IsWindows()`。"""
    return sys.platform.startswith('win')


def is_macos() -> bool:
    """对应 `OS.IsMacOS()`。"""
    return sys.platform == 'darwin'


def is_linux() -> bool:
    """对应 `OS.IsLinux()`。"""
    return sys.platform.startswith('linux')


def is_android() -> bool:
    """对应 `OS.IsAndroid()`（Python 标准库判不出，只能看 `sys.platform`）。"""
    return sys.platform.startswith('android') or 'ANDROID_ROOT' in os.environ


def is_ios() -> bool:
    """对应 `OS.IsIOS()`。"""
    return sys.platform == 'ios'


def where_is(filename: str) -> Optional[str]:
    """对应 `WhereIs`：先当前目录、再扫 `PATH`；找不到返回 `None`。"""
    if not filename:
        return None
    if os.path.isfile(filename):
        return os.path.abspath(filename)
    for p in (os.environ.get('PATH') or '').split(os.pathsep):
        if not p:
            continue
        full = os.path.join(p, filename)
        if os.path.isfile(full):
            return full
    return None


def get_updater_rid() -> str:
    """对应 `GetUpdaterRid`：按平台 + 进程架构给出 RID。

    ★ 与 `native_lib.platform_rid()` 的区别：这里区分 `osx-arm64` / `osx-x64`
    （更新器要按架构下载），而原生库那边上游只有一个通用 `osx/`。
    C# 在不认识的平台上 `throw new NotSupportedException()` —— 这里对应 `NotImplementedError`。
    """
    import platform
    arch = (platform.machine() or '').lower()
    arm = arch in ('arm64', 'aarch64')
    x86 = arch in ('x86', 'i386', 'i686', 'x86_32')
    if is_windows():
        if x86:
            return 'win-x86'
        if arm:
            return 'win-arm64'
        return 'win-x64'
    if is_macos():
        return 'osx-arm64' if arm else 'osx-x64'
    if is_linux():
        return 'linux-arm64' if arm else 'linux-x64'
    raise NotImplementedError('unsupported platform for updater rid: %s' % sys.platform)


def get_opener() -> str:
    """对应 `GetOpener`：Windows → `explorer.exe`，macOS → `open`，Linux 逐个探测。"""
    if is_windows():
        return 'explorer.exe'
    if is_macos():
        return 'open'
    for opener in LINUX_OPENERS:
        full = where_is(opener)
        if full:
            return full
    raise OSError('None of %s found.' % ', '.join(LINUX_OPENERS))


def get_wrapped_path(path: str) -> str:
    """对应 `GetWrappedPath`：非 Windows 上加引号。"""
    return path if is_windows() else '"%s"' % path


def open_folder(path: str) -> None:
    """对应 `OpenFolder`：目录存在才调用平台打开器。"""
    if os.path.isdir(path):
        subprocess.Popen([get_opener(), get_wrapped_path(path)])


def goto_file(path: str) -> None:
    """对应 `GotoFile`：Windows 用 `/select,`、macOS 用 `-R`，Linux 退化成开目录。"""
    if not os.path.isfile(path):
        return
    wrapped = get_wrapped_path(path)
    if is_windows():
        subprocess.Popen([get_opener(), '/select, %s' % wrapped])
    elif is_macos():
        subprocess.Popen([get_opener(), ' -R %s' % wrapped])
    else:
        open_folder(os.path.dirname(path))


def open_web(url: str) -> None:
    """对应 `OpenWeb`。"""
    subprocess.Popen([get_opener(), url])


def app_exists(path: str) -> bool:
    """对应 `AppExists`：macOS 认 `.app` 目录，其余认文件。"""
    if is_macos():
        return os.path.isdir(path) and path.endswith('.app')
    return os.path.isfile(path)

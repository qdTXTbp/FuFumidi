# -*- coding: utf-8 -*-
"""`worldline` 原生库的**路径解析**（照搬 .NET 的 `runtimes/<rid>/native/` 布局）。

为什么需要单独一层
------------------
C# 侧写的是 `[DllImport("worldline")]`，CLR 会沿着「应用目录 → `runtimes/<rid>/native/`」
自动解析，所以 OpenUTAU 只要把 dll 放进 `runtimes/` 就能用。
Python 的 `ctypes.CDLL('worldline')` 只搜系统动态库路径 —— 打包（asar / 安装目录）
之后**必然找不到**，于是「变调」这一整条链路在真机上不可用。

之所以一直没暴露：一致性测试是**直接指向** `_ref/OpenUtau/runtimes/...` 的绝对路径，
测试全绿而发布版跑不起来。本模块补的就是这一层「去哪儿找库」。

搜索顺序（与 .NET 的解析优先级同构）
------------------------------------
1. 调用方显式传入的路径（**优先尝试**，排障用）
2. 环境变量 `FUFUMIDI_WORLDLINE`（指向具体文件）
3. 环境变量 `FUFUMIDI_NATIVE_DIR`（指向一个根目录，根下按 `<rid>/` 组织）
4. 本包 `openutau/native/<rid>/` —— **随引擎分发的那一份**（推荐路径）
5. 引擎根 `<engine>/native/<rid>/` —— 宿主想另放一份时的位置
6. 环境变量 `OPENUTAU_REF` 指向的参考仓库 `<ref>/runtimes/<rid>/native/`（仅开发排障）

★ 显式路径是「优先尝试」而**不是硬覆盖**：某条候选不存在就继续往下找。
一条过期的排障路径不应该把整个变调链路弄坏。真需要硬覆盖时，直接把路径交给
`WorldlineNative(path)`（`get_native(path)` 就是这么做的）。

找不到时返回 `None`，由 `WorldlineNative` 走它既有的「不可用」分支
（`available is False`，纯逻辑照常工作，真调 DSP 才抛错）—— 不抛异常、不静默换实现。
"""

import os
import platform
import sys
from typing import List, Optional

#: 本包内的随分发目录。与 .NET 的 `runtimes/` 同级语义，只是名字更短。
PKG_NATIVE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'native')

#: RID → 库文件名。RID 命名沿用 .NET / OpenUTAU 的约定。
LIB_BY_RID = {
    'win-x64': 'worldline.dll',
    'win-arm64': 'worldline.dll',
    'win-x86': 'worldline.dll',
    'linux-x64': 'libworldline.so',
    'linux-arm64': 'libworldline.so',
    'osx': 'libworldline.dylib',
}


def _arch_suffix(machine: str) -> Optional[str]:
    """`platform.machine()` → .NET 的架构段（x64 / arm64 / x86）。识别不出返回 None。"""
    m = (machine or '').strip().lower()
    if m in ('amd64', 'x86_64', 'x64'):
        return 'x64'
    if m in ('arm64', 'aarch64'):
        return 'arm64'
    if m in ('x86', 'i386', 'i686', 'x86_32'):
        return 'x86'
    return None


def platform_rid() -> Optional[str]:
    """当前平台的 RID（与 .NET `RuntimeInformation.RuntimeIdentifier` 同构）。

    上游 `osx` 目录只有一个通用二进制、不按架构再分，这里照搬。
    平台或架构识别不出来时返回 `None`，调用方回落到「按库名逐目录找」。
    """
    plat = sys.platform
    arch = _arch_suffix(platform.machine())
    if plat.startswith('win'):
        return ('win-' + arch) if arch in ('x64', 'arm64', 'x86') else None
    if plat.startswith('linux'):
        return ('linux-' + arch) if arch in ('x64', 'arm64') else None
    if plat.startswith('darwin'):
        return 'osx'
    return None


def library_name(rid: Optional[str] = None) -> str:
    """该平台上的原生库文件名。RID 不认识时按当前平台兜底。"""
    rid = rid or platform_rid()
    if rid in LIB_BY_RID:
        return LIB_BY_RID[rid]
    if sys.platform.startswith('win'):
        return 'worldline.dll'
    if sys.platform.startswith('darwin'):
        return 'libworldline.dylib'
    return 'libworldline.so'


def engine_root() -> str:
    """引擎根目录（`<engine>/`）——`singing/openutau/native_lib.py` 往上三层。"""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def search_roots() -> List[str]:
    """按优先级列出候选根目录；每个根下再拼 `<rid>/<库名>` 与裸 `<库名>`。"""
    roots: List[str] = []
    env_dir = os.environ.get('FUFUMIDI_NATIVE_DIR')
    if env_dir:
        roots.append(env_dir)
    roots.append(PKG_NATIVE_DIR)
    roots.append(os.path.join(engine_root(), 'native'))
    ref = os.environ.get('OPENUTAU_REF')
    if ref:
        # 参考仓库里是 `runtimes/<rid>/native/`，多一层 `native`，这里按同样的形态补
        roots.append(os.path.join(ref, 'runtimes'))
    return roots


def candidates(extra: Optional[str] = None) -> List[str]:
    """所有候选路径（去重、保序）。"""
    rid = platform_rid()
    name = library_name(rid)
    out: List[str] = []

    def add(p: Optional[str]) -> None:
        if p and p not in out:
            out.append(p)

    add(extra)
    add(os.environ.get('FUFUMIDI_WORLDLINE'))
    for root in search_roots():
        if rid:
            # 参考仓库形态多一层 native（.NET 的 runtimes/<rid>/native/）
            if os.path.basename(root) == 'runtimes':
                add(os.path.join(root, rid, 'native', name))
            add(os.path.join(root, rid, name))
        add(os.path.join(root, name))
    return out


def resolve_worldline(extra: Optional[str] = None) -> Optional[str]:
    """返回第一个**真实存在**的库路径；都不存在返回 `None`。

    不抛异常：找不到库是 `WorldlineNative` 已经处理好的正常分支（`available=False`）。
    """
    for p in candidates(extra):
        try:
            if os.path.isfile(p):
                return p
        except OSError:      # 路径含非法字符等
            continue
    return None


def describe() -> str:
    """给人看的一行诊断（排障时打日志用）。"""
    rid = platform_rid() or '<unknown>'
    found = resolve_worldline()
    return 'rid=%s lib=%s found=%s' % (rid, library_name(), found or '<not found>')

# -*- coding: utf-8 -*-
"""`Core.Format.Ustx` 常量 —— 实际定义在 `singing.ustx.format`，这里只做转发。

（它位于 ustx 包内以免 ustx ↔ openutau 循环导入；这个模块只是给
`from singing.openutau.format import Ustx` 这种写法留个顺手入口。）
"""

from ..ustx.format import ALL, Ustx  # noqa: F401

__all__ = ['Ustx', 'ALL']

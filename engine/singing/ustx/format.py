# -*- coding: utf-8 -*-
"""`Core.Format.Ustx` 的常量表 —— 照搬 `OpenUtau.Core/Format/Ustx.cs`。

这些是**表达式缩写**（expression abbreviation），音符 / 轨道 / 音素都用它们互相引用。
必须与 OpenUTAU 逐字一致，否则读写 .ustx 时表达式对不上。

放在 ustx 包内（而不是 openutau 包）是因为它本就属于 ustx 格式，
且 ustx 的模型与 openutau 的音素化器都要用它，放这里可以避免循环导入。
"""


class Ustx:
    DYN = 'dyn'
    PITD = 'pitd'
    CLR = 'clr'
    ENG = 'eng'
    VEL = 'vel'
    VOL = 'vol'
    ATK = 'atk'
    DEC = 'dec'
    GEN = 'gen'
    GENC = 'genc'
    BRE = 'bre'
    BREC = 'brec'
    LPF = 'lpf'
    NORM = 'norm'
    MOD = 'mod'
    MODP = 'mod+'
    ALT = 'alt'
    DIR = 'dir'
    SHFT = 'shft'
    SHFC = 'shfc'
    TENC = 'tenc'
    VOIC = 'voic'
    CLRY = 'clry'
    XSY = 'xsy'
    RPIT = 'rpit'
    PITO = 'pito'


# 按字母序的完整清单，供一致性测试逐项核对
ALL = tuple(sorted(v for k, v in vars(Ustx).items() if k.isupper() and isinstance(v, str)))

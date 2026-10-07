# -*- coding: utf-8 -*-
r"""工程格式嗅探与读取 —— **照搬** `OpenUtau.Core/Format/Formats.cs`。

★ `DetectProjectFormat`（:23-52）的两个关键点：
  1. **只读前 10 行**（:25-28）—— 不整文件读，大工程也能秒判
  2. **判据有顺序**：`[#SETTING]`（Ust）**优先于** `ustx_version:`（Ustx）。
     `.ust` 文件里也可能出现 `ustx_version` 字样，反之 `.ustx` 里不会有 `[#SETTING]`；
     顺序照抄就是对的，别"优化"成字典查表。

对照我们现状：`singing/ustx/format.py` 只做「当前格式的读写 + 0.4/0.5/0.6/0.7 迁移」，
**没有嗅探**，所以主进程只能靠扩展名猜 —— 改错扩展名就报「不是合法工程」。
"""

import io
import os
from enum import Enum
from typing import List, Optional


class ProjectFormat(Enum):
    """对应 `ProjectFormats`（:8）。顺序不重要，名字要一致。"""

    UNKNOWN = 'Unknown'
    VSQ3 = 'VSQ3'
    VSQ4 = 'VSQ4'
    UST = 'Ust'
    USTX = 'Ustx'
    MIDI = 'Midi'
    UFDATA = 'Ufdata'
    MUSICXML = 'Musicxml'
    SVP = 'Svp'


# ---- 判据常量（:10-18），逐字照搬
_UST_MATCH = '[#SETTING]'
_USTX_MATCH_JSON = '"ustxVersion":'
_USTX_MATCH_YAML = 'ustx_version:'
_VSQ3_MATCH = 'VSQ3.00'
_VSQ4_MATCH = 'VSQ4.00'
_MIDI_MATCH = 'MThd'
_UFDATA_MATCH = '"formatVersion":'
_MUSICXML_MATCH = 'score-partwise'
_SVP_VERSION = '"version":'
_SVPDATA = '"database":'
_SVP2 = '"mouthOpening":'

#: `DetectProjectFormat` 只看前这么多行（:25）
SNIFF_LINES = 10


def detect_project_format(file_path: str) -> ProjectFormat:
    """照搬 `DetectProjectFormat`（:23-52）。

    ★ **只读前 10 行**；判据顺序照抄（Ust 在 Ustx 之前）。
    """
    lines: List[str] = []
    try:
        with io.open(file_path, encoding='utf-8-sig', errors='replace') as f:
            for i in range(SNIFF_LINES):
                line = f.readline()
                if not line:
                    break
                lines.append(line)
    except OSError:
        return ProjectFormat.UNKNOWN
    text = '\n'.join(lines)

    if _UST_MATCH in text:                      # :35-36
        return ProjectFormat.UST
    if _USTX_MATCH_JSON in text or _USTX_MATCH_YAML in text:   # :37-38
        return ProjectFormat.USTX
    if _VSQ3_MATCH in text:                     # :39-40
        return ProjectFormat.VSQ3
    if _VSQ4_MATCH in text:                     # :41-42
        return ProjectFormat.VSQ4
    if _MIDI_MATCH in text:                     # :43-44
        return ProjectFormat.MIDI
    if _UFDATA_MATCH in text:                   # :45-46
        return ProjectFormat.UFDATA
    if _MUSICXML_MATCH in text:                 # :47-48
        return ProjectFormat.MUSICXML
    if _SVP2 in text:                           # :49-50
        return ProjectFormat.SVP
    if _SVP_VERSION in text or _SVPDATA in text:  # :51-52
        return ProjectFormat.SVP
    return ProjectFormat.UNKNOWN                # :53-54


#: 哪些格式我们**目前**能读（`ReadProject` 的分派，:56-95）
_READABLE = {ProjectFormat.USTX, ProjectFormat.UST, ProjectFormat.MIDI}


def read_project(file_paths: List[str]):
    """照搬 `ReadProject`（:56-95）—— 按嗅探结果分派。

    ★ 我们只实现了 `ustx` 与 `ust`（`singing/ustx/format.py` 与
      `singing/openutau/classic/ust.py`）；`midi` 走主进程那条路。
      其余格式**明确报不支持**，而不是静默返回 None（对齐 :59-61 的 `files.Length < 1`）。
    """
    from .format import load as load_ustx
    from ..openutau.classic import ust as classic_ust

    if not file_paths:
        return None
    fmt = detect_project_format(file_paths[0])
    if fmt is ProjectFormat.USTX:
        return load_ustx(file_paths[0])
    if fmt is ProjectFormat.UST:
        # ★ 传**整个列表**：对应 C# `Ust.Load(string[] files)`，支持多文件合并；
        #   传单个字符串会被当字符序列迭代（静默截成 'C'）。
        return classic_ust.load(file_paths)
    if fmt is ProjectFormat.MIDI:
        raise NotImplementedError(
            'MIDI 工程由主进程转换后再交给引擎（当前 Python 侧不直接读）')
    raise NotImplementedError('暂不支持的工程格式：%s（%s）'
                              % (fmt.name, os.path.basename(file_paths[0])))


def is_readable(fmt: ProjectFormat) -> bool:
    return fmt in _READABLE

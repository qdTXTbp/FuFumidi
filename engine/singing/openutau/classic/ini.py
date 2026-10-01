# -*- coding: utf-8 -*-
"""INI 分块读取 —— **照搬** `OpenUtau.Core/Classic/Ini.cs`（57 行）。

用于读 `presamp.ini` 这类"`[段名]` + `键=值`"的文件。

## 照搬时保留的语义（别"整理"掉）
- **空行跳过**，其余每一行（**包括段头行本身**）都先塞进当前段；循环结束后再把
  每段的第 0 行取出来当 `header` 并**从 lines 里删掉**。
- **不跳过注释**：`;` / `//` 开头的行照样进 `lines`。调用方靠
  `Split('=')` 后的长度判断过滤，别在这里加"注释过滤"——那会改变调用方看到的内容。
- 段头判定用 `Regex.IsMatch`（**部分匹配**，不是整行匹配）。
- 第一个段头出现之前若有非空行 → 抛错（C# 抛 `FileFormatException`）。
  照搬成 `ValueError`：**必须抛**，否则"文件开头有乱码"会被静默当成段内容。
- `trim=True`（默认）时逐行 `Trim()`。C# 的 `Trim()` 会一并去掉 `\\r`，
  所以 Python 侧用 `strip()` 处理（等价，且不需要先按行拆 `\\r\\n`）。
"""

import re
from typing import Iterable, List, Optional


class IniLine:
    """对应 `IniLine`。"""

    __slots__ = ('file', 'line_number', 'line')

    def __init__(self, file: str = '', line_number: int = 0, line: str = ''):
        self.file = file
        self.line_number = line_number
        self.line = line

    def __repr__(self):
        return '"%s"\nat line %d:\n"%s"' % (self.file, self.line_number + 1, self.line)


class IniBlock:
    """对应 `IniBlock`。"""

    __slots__ = ('header', 'lines')

    def __init__(self, header: str = ''):
        self.header = header
        self.lines: List[IniLine] = []


class Ini:
    """对应 `static class Ini`。"""

    @staticmethod
    def read_blocks(reader: Iterable[str], file: str, header_pattern: str,
                    trim: bool = True) -> List[IniBlock]:
        """对应 `Ini.ReadBlocks`。

        `reader` 可以是文件对象、也可以是行列表（Python 侧不需要 `StreamReader`）。
        """
        header_regex = re.compile(header_pattern)
        blocks: List[IniBlock] = []
        line_number = -1
        for raw in reader:
            line = raw.strip() if trim else raw.rstrip('\n')
            line_number += 1
            if not line:
                continue
            if header_regex.search(line):
                blocks.append(IniBlock())
            if not blocks:
                raise ValueError('Unexpected beginning of ust file.')
            blocks[-1].lines.append(IniLine(file=file, line=line, line_number=line_number))
        for block in blocks:
            block.header = block.lines[0].line
            block.lines.pop(0)
        return blocks

    @staticmethod
    def read_blocks_of(path: str, header_pattern: str, encoding: str = 'utf-8',
                       trim: bool = True) -> List[IniBlock]:
        """便捷入口：直接按路径读（C# 侧由调用方自己开 `StreamReader`）。"""
        with open(path, encoding=encoding, errors='replace') as f:
            return Ini.read_blocks(f, path, header_pattern, trim)

    @staticmethod
    def find_block(blocks: List[IniBlock], header: str) -> Optional[IniBlock]:
        """对应 C# 的 `blocks.Find(block => block.header == header)`（找不到返回 None）。"""
        return next((b for b in blocks if b.header == header), None)

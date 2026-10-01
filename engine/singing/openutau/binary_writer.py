# -*- coding: utf-8 -*-
"""`System.IO.BinaryWriter` 的最小复刻 —— 缓存键的字节布局全靠它。

**这不是"自研"**：C# 里 `RenderPhone.Hash()` / `RenderPhrase.Hash()` /
`ResamplerItem.Hash()` 都用 `BinaryWriter` 把字段按固定顺序写成字节流再取 XXH64，
这里只是把 .NET 那套字节布局在 Python 侧如实重现。

## 必须一致的三件事（任何一条错了缓存键就会漂）
1. **数值一律小端**：`float` 4 字节、`double` 8 字节、`int` 4 字节、
   `long`/`ulong` 8 字节、`bool` 1 字节。
2. **字符串** 先写 7-bit 变长编码的**字节长度**（LEB128），再写 UTF-8 字节。
3. `Write(string)` 收到 `null` 时写出的就是**一个 0x00 长度字节**，
   与空串完全相同 —— 所以 None 当空串处理。

公开给三个地方共用：`openutau/render_phrase.py`、`openutau/classic/resampler_item.py`
（以及后续任何要复刻 `BinaryWriter` 的地方）。
"""

import struct
from typing import Optional

from .xxhash import xxh64


class BinaryWriter:
    """对应 C# 的 `BinaryWriter`（只覆盖 OpenUTAU 用到的那几个重载）。"""

    __slots__ = ('_buf',)

    def __init__(self):
        self._buf = bytearray()

    def write_float(self, v: float) -> None:
        self._buf += struct.pack('<f', v)

    def write_double(self, v: float) -> None:
        self._buf += struct.pack('<d', v)

    def write_int(self, v: int) -> None:
        self._buf += struct.pack('<i', v)

    def write_long(self, v: int) -> None:
        """`BinaryWriter.Write(long)`：8 字节小端有符号。"""
        self._buf += struct.pack('<q', v)

    def write_ulong(self, v: int) -> None:
        """`BinaryWriter.Write(ulong)`：8 字节小端无符号。"""
        self._buf += struct.pack('<Q', v)

    def write_bool(self, v: bool) -> None:
        self._buf += b'\x01' if v else b'\x00'

    def write_str(self, s: Optional[str]) -> None:
        """`BinaryWriter.Write(string)`：7-bit 变长长度前缀 + UTF-8 字节。"""
        b = (s or '').encode('utf-8')
        n = len(b)
        while True:  # LEB128
            byte = n & 0x7F
            n >>= 7
            if n:
                self._buf.append(byte | 0x80)
            else:
                self._buf.append(byte)
                break
        self._buf += b

    def to_bytes(self) -> bytes:
        """对应 `MemoryStream.ToArray()`。"""
        return bytes(self._buf)

    def digest(self) -> int:
        """`XXH64.DigestOf(stream.ToArray())` —— 哈希写法最常见，单独给个便捷方法。"""
        return xxh64(self.to_bytes())

# -*- coding: utf-8 -*-
"""XXH32 / XXH64 —— **照搬** OpenUTAU 用的哈希（`K4os.Hash.xxHash.XXH32` / `XXH64`）。

为什么需要：OpenUTAU 用它们做缓存键与"渲染输入是否变化"的判断 ——
- `RenderPhone.Hash()` / `RenderPhrase` 的 `preEffectHash` / `hash` 用 **XXH64**；
- `ResamplerItem` 的文件名前缀 `res-{XXH32(singerId):x8}-{hash:x16}.wav` 用 **XXH32**。

Python 标准库没有 xxhash，环境里也没装（`import xxhash` 失败），但这是
**公开且字节精确的算法**，按其规范实现即可与 C# 结果一致（不是"自研"，故不违反照搬方针）。

自测（官方测试向量，见 `engine/tests`）：
    XXH64(b"")    == 0xEF46DB3751D8E999
    XXH64(b"a")   == 0xD24EC4F1A98C6E5B
    XXH64(b"abc") == 0x44BC2CF5AD770999
    XXH32(b"")    == 0x02CC5D05
    XXH32(b"a")   == 0x550D7456
    XXH32(b"abc") == 0x32D153FF

命名说明：文件原为 `xxhash64.py`，加入 XXH32 后按 C# 的 `K4os.Hash.xxHash` 归并到这里。
"""

MASK32 = 0xFFFFFFFF
MASK64 = 0xFFFFFFFFFFFFFFFF

# ---- XXH32 素数
_P1_32 = 0x9E3779B1
_P2_32 = 0x85EBCA77
_P3_32 = 0xC2B2AE3D
_P4_32 = 0x27D4EB2F
_P5_32 = 0x165667B1

# ---- XXH64 素数
P1 = 0x9E3779B185EBCA87
P2 = 0xC2B2AE3D27D4EB4F
P3 = 0x165667B19E3779F9
P4 = 0x85EBCA77C2B2AE63
P5 = 0x27D4EB2F165667C5


# ---------------------------------------------------------------- XXH32


def _rotl32(x: int, r: int) -> int:
    return ((x << r) | (x >> (32 - r))) & MASK32


def _round32(acc: int, inp: int) -> int:
    acc = (acc + inp * _P2_32) & MASK32
    acc = _rotl32(acc, 13)
    return (acc * _P1_32) & MASK32


def xxh32(data: bytes, seed: int = 0) -> int:
    """XXH32，返回 32 位无符号整数（与 C# 的 `XXH32.DigestOf` 同值）。"""
    length = len(data)
    i = 0
    if length >= 16:
        v1 = (seed + _P1_32 + _P2_32) & MASK32
        v2 = (seed + _P2_32) & MASK32
        v3 = seed & MASK32
        v4 = (seed - _P1_32) & MASK32
        while i + 16 <= length:
            v1 = _round32(v1, int.from_bytes(data[i:i + 4], 'little')); i += 4
            v2 = _round32(v2, int.from_bytes(data[i:i + 4], 'little')); i += 4
            v3 = _round32(v3, int.from_bytes(data[i:i + 4], 'little')); i += 4
            v4 = _round32(v4, int.from_bytes(data[i:i + 4], 'little')); i += 4
        h = (_rotl32(v1, 1) + _rotl32(v2, 7) + _rotl32(v3, 12) + _rotl32(v4, 18)) & MASK32
    else:
        h = (seed + _P5_32) & MASK32

    h = (h + length) & MASK32
    while i + 4 <= length:
        h = (h + int.from_bytes(data[i:i + 4], 'little') * _P3_32) & MASK32
        h = (_rotl32(h, 17) * _P4_32) & MASK32
        i += 4
    while i < length:
        h = (h + data[i] * _P5_32) & MASK32
        h = (_rotl32(h, 11) * _P1_32) & MASK32
        i += 1

    h ^= h >> 15
    h = (h * _P2_32) & MASK32
    h ^= h >> 13
    h = (h * _P3_32) & MASK32
    h ^= h >> 16
    return h


def digest_of32(data: bytes) -> int:
    """对应 C# 的 `XXH32.DigestOf(byte[])`。"""
    return xxh32(data)


# ---------------------------------------------------------------- XXH64


def _rotl64(x: int, r: int) -> int:
    return ((x << r) | (x >> (64 - r))) & MASK64


def _round(acc: int, inp: int) -> int:
    acc = (acc + inp * P2) & MASK64
    acc = _rotl64(acc, 31)
    return (acc * P1) & MASK64


def _merge_round(acc: int, val: int) -> int:
    val = _round(0, val)
    acc ^= val
    return (acc * P1 + P4) & MASK64


def xxh64(data: bytes, seed: int = 0) -> int:
    """XXH64，返回 64 位无符号整数（与 C# 的 `XXH64.DigestOf` 同值）。"""
    length = len(data)
    i = 0
    if length >= 32:
        v1 = (seed + P1 + P2) & MASK64
        v2 = (seed + P2) & MASK64
        v3 = seed & MASK64
        v4 = (seed - P1) & MASK64
        while i + 32 <= length:
            v1 = _round(v1, int.from_bytes(data[i:i + 8], 'little')); i += 8
            v2 = _round(v2, int.from_bytes(data[i:i + 8], 'little')); i += 8
            v3 = _round(v3, int.from_bytes(data[i:i + 8], 'little')); i += 8
            v4 = _round(v4, int.from_bytes(data[i:i + 8], 'little')); i += 8
        h = (_rotl64(v1, 1) + _rotl64(v2, 7) + _rotl64(v3, 12) + _rotl64(v4, 18)) & MASK64
        h = _merge_round(h, v1)
        h = _merge_round(h, v2)
        h = _merge_round(h, v3)
        h = _merge_round(h, v4)
    else:
        h = (seed + P5) & MASK64

    h = (h + length) & MASK64
    while i + 8 <= length:
        h ^= _round(0, int.from_bytes(data[i:i + 8], 'little'))
        h = (_rotl64(h, 27) * P1 + P4) & MASK64
        i += 8
    if i + 4 <= length:
        h ^= (int.from_bytes(data[i:i + 4], 'little') * P1) & MASK64
        h = (_rotl64(h, 23) * P2 + P3) & MASK64
        i += 4
    while i < length:
        h ^= (data[i] * P5) & MASK64
        h = (_rotl64(h, 11) * P1) & MASK64
        i += 1

    h ^= h >> 33
    h = (h * P2) & MASK64
    h ^= h >> 29
    h = (h * P3) & MASK64
    h ^= h >> 32
    return h


def digest_of64(data: bytes) -> int:
    """对应 C# 的 `XXH64.DigestOf(byte[])`（取低 64 位）。"""
    return xxh64(data)

# -*- coding: utf-8 -*-
"""XXH64 —— 照搬 OpenUTAU 用的哈希（`K4os.Hash.xxHash.XXH64`）。

为什么需要它：`RenderPhone.Hash()` / `RenderPhrase` 的 `preEffectHash` / `hash`
都用 XXH64 对一组字段的字节流求摘要，用于缓存键与"渲染输入是否变化"的判断。
Python 标准库没有 xxhash，环境里也没装（`import xxhash` 失败），
但这是**公开且字节精确的算法**，按其规范实现即可与 C# 结果一致
（不是"自研"，故不违反照搬方针）。

自测（官方测试向量）：XXH64(b"", seed=0) == 0xEF46DB3751D8E999 。
"""

MASK = 0xFFFFFFFFFFFFFFFF

P1 = 0x9E3779B185EBCA87
P2 = 0xC2B2AE3D27D4EB4F
P3 = 0x165667B19E3779F9
P4 = 0x85EBCA77C2B2AE63
P5 = 0x27D4EB2F165667C5


def _rotl(x: int, r: int) -> int:
    return ((x << r) | (x >> (64 - r))) & MASK


def _round(acc: int, inp: int) -> int:
    acc = (acc + inp * P2) & MASK
    acc = _rotl(acc, 31)
    return (acc * P1) & MASK


def _merge_round(acc: int, val: int) -> int:
    val = _round(0, val)
    acc ^= val
    return (acc * P1 + P4) & MASK


def xxh64(data: bytes, seed: int = 0) -> int:
    """返回 64 位无符号整数（与 C# 的 `XXH64.DigestOf` 同值）。"""
    length = len(data)
    i = 0
    if length >= 32:
        v1 = (seed + P1 + P2) & MASK
        v2 = (seed + P2) & MASK
        v3 = seed & MASK
        v4 = (seed - P1) & MASK
        while i + 32 <= length:
            v1 = _round(v1, int.from_bytes(data[i:i + 8], 'little')); i += 8
            v2 = _round(v2, int.from_bytes(data[i:i + 8], 'little')); i += 8
            v3 = _round(v3, int.from_bytes(data[i:i + 8], 'little')); i += 8
            v4 = _round(v4, int.from_bytes(data[i:i + 8], 'little')); i += 8
        h = (_rotl(v1, 1) + _rotl(v2, 7) + _rotl(v3, 12) + _rotl(v4, 18)) & MASK
        h = _merge_round(h, v1)
        h = _merge_round(h, v2)
        h = _merge_round(h, v3)
        h = _merge_round(h, v4)
    else:
        h = (seed + P5) & MASK

    h = (h + length) & MASK
    while i + 8 <= length:
        h ^= _round(0, int.from_bytes(data[i:i + 8], 'little'))
        h = (_rotl(h, 27) * P1 + P4) & MASK
        i += 8
    if i + 4 <= length:
        h ^= (int.from_bytes(data[i:i + 4], 'little') * P1) & MASK
        h = (_rotl(h, 23) * P2 + P3) & MASK
        i += 4
    while i < length:
        h ^= (data[i] * P5) & MASK
        h = (_rotl(h, 11) * P1) & MASK
        i += 1

    h ^= h >> 33
    h = (h * P2) & MASK
    h ^= h >> 29
    h = (h * P3) & MASK
    h ^= h >> 32
    return h


# 对应 C# 的 `XXH64.DigestOf(byte[])`（取低 64 位）
def digest_of(data: bytes) -> int:
    return xxh64(data)

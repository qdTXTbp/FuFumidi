# -*- coding: utf-8 -*-
"""UTAU 的 12 位音高编码 —— **照搬** `OpenUtau.Core/Util/Base64.cs`（77 行）。

外部 resampler（`resample.exe` / `moresampler` / …）的命令行最后一个参数是
**整段音高曲线**，用的是 UTAU 自己的一套 base64 变体：
每个音高值编成 **2 个字符**（12 位，负数先 +4096），连续重复的用 `#N#` 行程压缩。

## 命名说明（载体差异）
C# 的文件是 `Util/Base64.cs`、类名 `Base64`。Python 侧叫 `base64_util` 而不是
`base64` —— 避免与标准库 `base64` 同名（同一个包里出现 `openutau/base64.py`
会让任何把包目录塞进 `sys.path` 的用法踩到标准库）。**这是命名差异，不是文件边界差异**。

## 照搬时保留的语义
1. 编码是 **12 位**（`& 0x3F` 取低 6 位、`>> 6` 取高 6 位），所以音高被夹在
   `[-2048, 2047]` 之外时会**静默截断**（上游就这样；调用方负责给合法值）。
2. 负数处理是 **`+= 4096`**（不是按位与），于是 `-1 → 4095`。
3. 行程压缩只压**紧邻的完全相同编码**，且 `#` 之间写重复次数：
   首个不重复；出现重复时先补前一个，再写 `#N#`；结尾若还在重复要再补一次。
   ★ 注意 `dups` 统计的是「与上一个**不同**之前连续重复了多少次」——
   `[A,A,A]` 编码成 `A#2#`，`[A,B,B]` 编码成 `AB#1#`。
"""

from typing import Iterable, List

#: 对应 `private const string intToBase64`（注意是 UTAU 自己的字母表，不是标准 base64）
INT_TO_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


def encode_int12(data: int) -> str:
    """对应私有重载 `Base64EncodeInt12(int)`：单个值 → 2 个字符。"""
    if data < 0:
        data += 4096
    return INT_TO_BASE64[(data >> 6) & 0x003F] + INT_TO_BASE64[data & 0x003F]


def encode_int12_list(data: Iterable[int]) -> str:
    """对应 `Base64EncodeInt12(int[])`：逐个编码后做 `#N#` 行程压缩。"""
    items: List[str] = [encode_int12(int(d)) for d in data]

    out: List[str] = []
    last = ''
    dups = 0
    for b in items:
        if last == b:
            dups += 1
        elif dups == 0:
            out.append(b)
        else:
            out.append('#')
            out.append(str(dups))
            out.append('#')
            dups = 0
            out.append(b)
        last = b
    if dups != 0:
        out.append('#')
        out.append(str(dups))
        out.append('#')
    return ''.join(out)


def to_file(base64str: str, file_path: str, logger=None) -> None:
    """对应 `Base64ToFile`：把标准 base64 文本解码落盘；失败只记日志、不抛。"""
    import base64 as _b64
    try:
        with open(file_path, 'wb') as f:
            f.write(_b64.b64decode(base64str))
    except Exception as e:                                   # noqa: BLE001
        if logger is not None:
            logger.error('%s' % e)

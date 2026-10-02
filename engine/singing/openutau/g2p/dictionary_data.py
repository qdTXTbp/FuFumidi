# -*- coding: utf-8 -*-
"""G2P 字典的反序列化结构 —— **照搬** `OpenUtau.Core/Api/G2pDictionaryData.cs`(19)。

C# 是 `[YamlIgnore]` 之外的一个纯数据类，供 YamlDotNet 反序列化 `g2p.yaml` 用：
    symbols: [{symbol: AA, type: vowel}, ...]
    entries: [{grapheme: hello, phonemes: [hh, ah, l, ow]}, ...]

Python 侧用 dataclass，并提供一个**从普通 dict 构造**的入口 —— 因为我们的 YAML
反序列化（`pyyaml`）给的是普通 dict/list，而不是 C# 那种带类型信息的反射。
"""

from dataclasses import dataclass, field
from typing import Any, List, Optional


@dataclass
class SymbolData:
    """对应 C# 的 `G2pDictionaryData.SymbolData`。"""

    symbol: str = ''
    type: str = ''


@dataclass
class G2pDictionaryData:
    """对应 C# 的 `G2pDictionaryData`。

    `symbols` / `entries` 在 C# 里可为 `null`（YAML 里没写那段），所以这里用
    `Optional` 与 `None` 默认值对齐 —— 别改成空列表，"有没有这一段"是有意义的。
    """

    symbols: Optional[List[SymbolData]] = None
    entries: Optional[List['Entry']] = field(default=None)

    @staticmethod
    def from_plain(plain: Any) -> 'G2pDictionaryData':
        """从 YAML 反序列化出来的普通 dict 构造（对应 C# 的 YamlDotNet 反序列化）。

        ★ 缺失的键给 `None` 而不是空列表 —— 与 C# 的反序列化结果一致
        （C# 里没写 `symbols:` 就是 `null`）。
        """
        if not isinstance(plain, dict):
            return G2pDictionaryData()
        symbols = plain.get('symbols')
        entries = plain.get('entries')
        return G2pDictionaryData(
            symbols=None if symbols is None else [
                SymbolData(symbol=(s or {}).get('symbol', '') or '',
                           type=(s or {}).get('type', '') or '')
                for s in symbols],
            entries=None if entries is None else [
                Entry(grapheme=(e or {}).get('grapheme', '') or '',
                      phonemes=list((e or {}).get('phonemes') or []))
                for e in entries],
        )


@dataclass
class Entry:
    """对应 C# 的 `G2pDictionaryData.Entry`。"""

    grapheme: str = ''
    phonemes: List[str] = field(default_factory=list)

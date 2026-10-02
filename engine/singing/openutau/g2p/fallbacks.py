# -*- coding: utf-8 -*-
"""G2P 字典的回落链 —— **照搬** `OpenUtau.Core/Api/G2pFallbacks.cs`(57)。

按顺序持有若干字典，"先有的先用"。它服务"声库自带词典优先、内置词典兜底"这类场景。

## 照搬时保留的语义（别"想当然"）
1. `is_valid_symbol` = **任一**字典认识就算有效。
2. `is_vowel` / `is_glide` = **第一个"认识这个符号"的字典说了算**
   （判据是 `IsValidSymbol`，不是 `IsVowel`）—— 后面的字典不参与投票。
3. `query` / `unpack_hint` = **第一个返回非 `None` 的**。
4. `unpack_hint` 实际**永远**命中第一个字典：`G2pDictionary.UnpackHint` 从
   不返回 null（只可能返回空数组）。也就是说这一层在这里是"透明"的 —— 照搬，
   别改成"空数组也算没命中"，那会改变多字典场景的行为。
"""

from typing import List, Optional, Sequence

from .i_g2p import IG2p


class G2pFallbacks(IG2p):
    """对应 `G2pFallbacks`。"""

    def __init__(self, dictionaries: Sequence[IG2p]):
        self.dictionaries = list(dictionaries)

    def is_valid_symbol(self, symbol: str) -> bool:
        return any(d.is_valid_symbol(symbol) for d in self.dictionaries)

    def is_vowel(self, symbol: str) -> bool:
        for d in self.dictionaries:
            if d.is_valid_symbol(symbol):
                return d.is_vowel(symbol)
        return False

    def is_glide(self, symbol: str) -> bool:
        for d in self.dictionaries:
            if d.is_valid_symbol(symbol):
                return d.is_glide(symbol)
        return False

    def query(self, grapheme: str) -> Optional[List[str]]:
        for d in self.dictionaries:
            result = d.query(grapheme)
            if result is not None:
                return result
        return None

    def unpack_hint(self, hint: str, separator: str = ' ') -> Optional[List[str]]:
        for d in self.dictionaries:
            result = d.unpack_hint(hint, separator)
            if result is not None:
                return result
        return None

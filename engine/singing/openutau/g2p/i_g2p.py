# -*- coding: utf-8 -*-
"""G2P 接口 —— **照搬** `OpenUtau.Core/Api/IG2p.cs`(21) + `Api/IG2pSymbols.cs`(9)。

C# 里这是两个文件（都是接口，加起来 30 行），这里合成一个模块；对应关系在类注释里。

## 照搬时保留的语义
- `Query(grapheme)` **返回 `None` 表示"查不到"**，与"查到空数组"是两回事 ——
  `G2pFallbacks` 靠 `!= null` 决定要不要试下一个字典。
- `UnpackHint(hint, separator=' ')`：按分隔符切开、**只保留有效符号**。
  ★ C# 的 `string.Split(char)` **保留空串**（`"a  b".Split(' ')` → `["a","","b"]`），
  Python 的 `str.split()` 默认会**吞掉空段** —— 这里显式用 `split(sep)` 并保留空串，
  反正空串会被 `IsValidSymbol` 过滤掉，但"保留空串"这一点在行为上要对齐。
- `IG2pSymbols.GetSymbols(note)`：把音符映射成符号串（`SyllableBasedPhonemizer` 实现它）。
"""

from abc import ABC, abstractmethod
from typing import List, Optional


class IG2p(ABC):
    """对应 C# 的 `interface IG2p`。"""

    @abstractmethod
    def is_valid_symbol(self, symbol: str) -> bool:
        """该符号是否是本字典认识的音素。"""

    @abstractmethod
    def is_vowel(self, symbol: str) -> bool:
        """该符号是否是元音（未登记的符号返回 False）。"""

    @abstractmethod
    def is_glide(self, symbol: str) -> bool:
        """该符号是否是滑音/流音（英语的 y / w / l / r 那一类）。"""

    @abstractmethod
    def query(self, grapheme: str) -> Optional[List[str]]:
        """字素 → 音素列表；**查不到返回 `None`**（不是空列表）。"""

    @abstractmethod
    def unpack_hint(self, hint: str, separator: str = ' ') -> Optional[List[str]]:
        """把"提示串"按分隔符切开、去掉无效符号后的音素列表。"""


class IG2pSymbols(ABC):
    """对应 C# 的 `interface IG2pSymbols`。

    （C# 里是单独一个 9 行的文件；本模块合并之，因为只有一个成员。）
    """

    @abstractmethod
    def get_symbols(self, note) -> List[str]:
        """把一个音符映射成符号串数组。"""

# -*- coding: utf-8 -*-
"""G2P 音素重映射 —— **照搬** `OpenUtau.Core/Api/G2pRemapper.cs`（53 行）。

它包住另一个 `IG2p`，在**查表结果**上再叠一层「音素 → 音素」的替换，同时用自己那份
`phonemeSymbols` 覆盖「什么是有效符号 / 什么是元音」。`SyllableBasedPhonemizer`
的 `ReadDictionary()` 就是用它把 `GetVowels()` / `GetConsonants()`（子类**硬编码**的
符号表）套到 `LoadBaseDictionary()`（可能是 YAML/G2P 模型）上面 ——
**这正是"子类说了算"的那一步**。

## 照搬时保留的语义（别"整理"掉）
1. `query` 在 `mapped.query` 返回 `None` 时**原样返回 `None`**（不是空列表）——
   上层 `GetSymbols` 靠这个 `None` 去走 `HandleWordNotFound`。
2. `query` 先 `Clone()` 再改 —— 所以映射结果**不会污染**被包的字典内部数组。
   Python 用 `list(...)` 复制，语义一致。
3. `is_valid_symbol` / `is_vowel` 用**自己**的 `phonemeSymbols`，
   **不查** `mapped` —— 也就是说被包的字典认为有效的符号，这里可能判无效。照搬。
4. `is_glide` **只**看 `glideSymbols`（默认空集），**不透传**给 `mapped`。
   ★ 这是个容易"顺手改好"的地方：`SyllableBasedPhonemizer` 里 glides 靠
   `runtimeGlides` + 自己的 `IsGlide()` 处理，根本不走这里。照搬，别透传。
5. `unpack_hint` 用 `Split(separator)`（**保留空串**）再按 `ContainsKey` 过滤。
"""

from typing import Dict, Iterable, List, Optional, Set

from .i_g2p import IG2p


class G2pRemapper(IG2p):
    """对应 `G2pRemapper`。

    参数与 C# 构造函数一一对应：
        mapped            被包装的字典
        phoneme_symbols   `{符号: 是否元音}`，**决定** `is_valid_symbol` / `is_vowel`
        replacements      `{音素: 替换值}`，作用在 `query` 的结果上（**只影响 `query`**）
        glide_symbols     额外声明的滑音集合（C# 默认 `null` → 空集）
    """

    def __init__(self, mapped: IG2p, phoneme_symbols: Dict[str, bool],
                 replacements: Dict[str, str],
                 glide_symbols: Optional[Set[str]] = None):
        self.mapped = mapped
        self.phoneme_symbols = phoneme_symbols
        self.replacements = replacements
        #: ★ `glideSymbols ?? new HashSet<string>()`：**不做**透传
        self.glide_symbols = glide_symbols if glide_symbols is not None else set()

    # ------------------------------------------------------------------ IG2p

    def is_valid_symbol(self, symbol: str) -> bool:
        return symbol in self.phoneme_symbols

    def is_vowel(self, symbol: str) -> bool:
        return self.phoneme_symbols.get(symbol, False)

    def is_glide(self, symbol: str) -> bool:
        return symbol in self.glide_symbols

    def query(self, grapheme: str) -> Optional[List[str]]:
        phonemes = self.mapped.query(grapheme)
        if phonemes is None:
            return None
        out = list(phonemes)                      # C# 是 Clone()：别改到别人的数组
        for i in range(len(out)):
            replacement = self.replacements.get(out[i])
            if replacement is not None:
                out[i] = replacement
        return out

    def unpack_hint(self, hint: str, separator: str = ' ') -> List[str]:
        """★ C# 的 `Split(char)` 保留空串；这里同样用 `split(sep)`（不吞空段）。"""
        return [s for s in hint.split(separator) if s in self.phoneme_symbols]

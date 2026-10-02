# -*- coding: utf-8 -*-
"""G2P 字典（Trie 实现）—— **照搬** `OpenUtau.Core/Api/G2pDictionary.cs`(154)。

字典存成 **trie**（字典树）以求紧凑与快速查找 —— C# 原文注释就引了维基那条链接。

## 照搬时保留的语义（别"整理"掉）
1. `query` 命中时返回的是**副本**（C# `node.symbols.Clone()`）—— 调用方可以随意改，
   不会污染字典内部。
2. `add_symbol(symbol, type)` 的**三态**：
   - `type == "vowel"` → `isVowel = True`
   - `type` 是 `"semivowel"` / `"liquid"` → 加进滑音集合
   - **其余 type → 把该符号从滑音集合里移除**（不是"什么都不做"）
   所以同一个符号先后用不同 type 登记，结果由**最后一次**决定。
3. `add_entry` 在叶子处把音素列表**按已登记的符号过滤**（`Where(ContainsKey)`）——
   也就是说：**符号必须先登记，条目才认得它**。C# 的 doc 注释专门写了这句
   （"Must finish adding symbols before adding entries, otherwise symbols get ignored"）。
   ★ 过滤发生在**写入时**而不是查询时：先 `add_entry` 再 `add_symbol`，那条条目就永远
   少了那个音素。照搬。
4. `BuildTrie` 是递归建树，**不覆盖**已有子节点；叶子重复写入时后者覆盖前者。
5. `unpack_hint` 用 `Split(separator)` —— **保留空段**，再按 `ContainsKey` 过滤。
6. `is_vowel(symbol)` = "登记过**且**登记为元音"；`is_glide` 只看滑音集合
   （所以一个符号可以是滑音但不是"有效符号"吗？不会 —— 滑音集合只由 add_symbol 写入，
   它同时也写进了 phonemeSymbols）。
"""

from typing import Dict, Iterable, List, Optional, Set

from .dictionary_data import G2pDictionaryData
from .i_g2p import IG2p


class TrieNode:
    """对应 C# 的嵌套私有类 `TrieNode`（提为模块级，便于测试与阅读）。"""

    __slots__ = ('children', 'symbols')

    def __init__(self):
        self.children: Dict[str, 'TrieNode'] = {}
        self.symbols: Optional[List[str]] = None


class G2pDictionary(IG2p):
    """对应 `G2pDictionary`。用 `G2pDictionary.new_builder()` 构造。"""

    def __init__(self, root: TrieNode, phoneme_symbols: Dict[str, bool],
                 glide_symbols: Set[str]):
        self._root = root
        self._phoneme_symbols = phoneme_symbols      # (音素 → 是否元音)
        self._glide_symbols = glide_symbols

    # ------------------------------------------------------------------ IG2p

    def is_valid_symbol(self, symbol: str) -> bool:
        return symbol in self._phoneme_symbols

    def is_vowel(self, symbol: str) -> bool:
        """登记过**且**登记为元音才算（`TryGetValue && isVowel`）。"""
        return self._phoneme_symbols.get(symbol, False)

    def is_glide(self, symbol: str) -> bool:
        return symbol in self._glide_symbols

    def query(self, grapheme: str) -> Optional[List[str]]:
        return self._query_trie(self._root, grapheme, 0)

    def unpack_hint(self, hint: str, separator: str = ' ') -> List[str]:
        """★ C# 的 `Split(char)` 保留空段；这里同样用 `split(sep)`（不吞空段）。"""
        return [s for s in hint.split(separator) if s in self._phoneme_symbols]

    # ------------------------------------------------------------------ 内部

    def _query_trie(self, node: TrieNode, word: str, index: int) -> Optional[List[str]]:
        if index == len(word):
            if node.symbols is None:
                return None
            return list(node.symbols)          # C# 是 Clone()：返回副本
        child = node.children.get(word[index])
        if child is not None:
            return self._query_trie(child, word, index + 1)
        return None

    # ------------------------------------------------------------------ Builder

    class Builder:
        """对应 C# 的嵌套 `G2pDictionary.Builder`。"""

        def __init__(self):
            self._root = TrieNode()
            self._phoneme_symbols: Dict[str, bool] = {}
            self._glide_symbols: Set[str] = set()

        def add_symbol(self, symbol: str, type_or_is_vowel, is_glide: Optional[bool] = None):
            """对应 C# 的**三个重载**（按第二个参数的类型/个数分派）：
            `AddSymbol(symbol, type)` / `(symbol, isVowel)` / `(symbol, isVowel, isGlide)`。
            """
            if isinstance(type_or_is_vowel, str) and is_glide is None:
                # AddSymbol(symbol, type)
                type_ = type_or_is_vowel
                self._phoneme_symbols[symbol] = (type_ == 'vowel')
                if type_ in ('semivowel', 'liquid'):
                    self._glide_symbols.add(symbol)
                else:
                    # ★ 是**移除**，不是什么都不做
                    self._glide_symbols.discard(symbol)
            elif is_glide is None:
                # AddSymbol(symbol, isVowel) —— 不碰滑音集合
                self._phoneme_symbols[symbol] = bool(type_or_is_vowel)
            else:
                # AddSymbol(symbol, isVowel, isGlide)
                is_vowel = bool(type_or_is_vowel)
                self._phoneme_symbols[symbol] = is_vowel
                if is_glide and not is_vowel:
                    self._glide_symbols.add(symbol)
                else:
                    self._glide_symbols.discard(symbol)
            return self

        def add_entry(self, grapheme: str, symbols: Iterable[str]):
            """对应 `AddEntry`。★ 必须在**符号登记完之后**再调，否则音素会被过滤掉。"""
            self._build_trie(self._root, grapheme, 0, list(symbols))
            return self

        def _build_trie(self, node: TrieNode, grapheme: str, index: int,
                        symbols: List[str]) -> None:
            if index == len(grapheme):
                # ★ 在**写入时**按已登记符号过滤（照搬 C#）
                node.symbols = [s for s in symbols if s in self._phoneme_symbols]
                return
            ch = grapheme[index]
            child = node.children.get(ch)
            if child is None:
                child = TrieNode()
                node.children[ch] = child
            self._build_trie(child, grapheme, index + 1, symbols)

        def load(self, data) -> 'G2pDictionary.Builder':
            """对应三个 `Load` 重载（字符串 / 流 / 数据对象）。

            字符串与文本流走 YAML 反序列化（C# 用 `Core.Yaml.DefaultDeserializer`），
            这里用项目的 `yaml`（PyYAML）并显式转成 `G2pDictionaryData`。
            """
            if isinstance(data, G2pDictionaryData):
                pass
            elif isinstance(data, dict):
                data = G2pDictionaryData.from_plain(data)
            else:
                import yaml
                data = G2pDictionaryData.from_plain(yaml.safe_load(data) or {})

            if data.symbols is not None:
                for symbol_data in data.symbols:
                    self.add_symbol(symbol_data.symbol, symbol_data.type)
            if data.entries is not None:
                for entry in data.entries:
                    self.add_entry(entry.grapheme, entry.phonemes)
            return self

        def build(self) -> 'G2pDictionary':
            return G2pDictionary(self._root, self._phoneme_symbols, self._glide_symbols)

    @staticmethod
    def new_builder() -> 'G2pDictionary.Builder':
        return G2pDictionary.Builder()

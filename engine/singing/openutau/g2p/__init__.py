# -*- coding: utf-8 -*-
"""字素→音素（G2P）子系统 —— **照搬** `OpenUtau.Core/Api/` 与 `Core/G2p/`。

## 为什么放在 `openutau/g2p/` 而不是两个目录
C# 把这几件东西按**命名空间**分在两处：接口与实现基类在 `Api/`，具体语言实现在
`Core/G2p/`。这里按**子系统**归到一个子包（`Api/` 在 C# 里本来就是个杂类命名空间，
我们已经把其中的 `Phonemizer` 放在 `phonemizer.py`）。文件级的对应关系逐条写在
各模块的 docstring 里。

## 它服务谁
`SyllableBasedPhonemizer` / `PhonemeBasedPhonemizer` 这两条基类线要它：
- `IG2p`：查符号是否有效 / 是否元音 / 是否滑音，查字素对应的音素
- `IG2pSymbols`：把音符映射成符号串（`SyllableBasedPhonemizer` 实现它）

`G2pPack` 的"未登录词用 ONNX 预测"这一段需要推理后端；本包把它做成**可注入**
（见 `pack.py`），没注入时退化成 C# 里 `Session == null` 的既有路径（返回空 → 查不到）。

## 已照搬
- `i_g2p.py`          `Api/IG2p.cs` + `Api/IG2pSymbols.cs`
- `dictionary_data.py` `Api/G2pDictionaryData.cs`
- `dictionary.py`     `Api/G2pDictionary.cs`（Trie + Builder）
- `fallbacks.py`      `Api/G2pFallbacks.cs`
- `pack.py`           `Api/G2pPack.cs`（ONNX 会话可注入）

## 未照搬（后续）
- `G2pRemapper.cs`（音素重映射）、各类具体语言 G2p（`ArpabetG2p` 等）
"""

from .dictionary import G2pDictionary, TrieNode  # noqa: F401
from .dictionary_data import G2pDictionaryData, SymbolData  # noqa: F401
from .fallbacks import G2pFallbacks  # noqa: F401
from .i_g2p import IG2p, IG2pSymbols  # noqa: F401
from .pack import G2pPack, is_all_punct, set_onnx_session_factory  # noqa: F401

__all__ = [
    'IG2p', 'IG2pSymbols',
    'G2pDictionaryData', 'SymbolData',
    'G2pDictionary', 'TrieNode',
    'G2pFallbacks',
    'G2pPack', 'set_onnx_session_factory', 'is_all_punct',
]

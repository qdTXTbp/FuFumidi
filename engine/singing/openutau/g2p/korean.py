# -*- coding: utf-8 -*-
r"""韩语 G2P —— **照搬** `OpenUtau.Core/G2p/KoreanG2p.cs`（98 行）。

★ 本文件**手写**（不在这 10 个生成之列 —— `g2p/_gen_g2p_modules.py` 的注释里
  已写明原因）：它**额外覆写了 `Predict`**，把谚文按字分解成初声/中声/终声（jamo），
  这段逻辑不是模板能表达的。但两张静态表仍然**取自生成器的解析结果**（见文件头注）。

## ★ 为什么要做谚文分解
神经网络 G2p 的输入是**字母表里的符号**。韩语的谚文（한글）是**组合字**
（U+AC00..U+D79F，每字 = 初声 × 中声 × 终声），而模型只认基本字母。
所以预测前必须把谚文拆成 jamo：

```
Code = cp - 0xAC00
codaCode   = Code % 28;  Code = (Code - codaCode) // 28
nucleusCode= Code % 21;  Code = (Code - nucleusCode) // 21
onsetCode  = Code
→ onset[onsetCode] + nucleus[nucleusCode] + coda[codaCode]
```

★ 上游用 `int`（32 位有符号）承载 `Code`；最大码点差是 `0xD79F - 0xAC00 = 11103`，
远小于 `2^31`，所以 C# 与 Python 的整数运算结果一致。

★ 拆不出的字符（超出 `0xAC00..0xD79F`，或分解后下标越界）**原样保留**，
不丢字、不报错。

## 静态表
| 表 | 项数 | 说明 |
|---|---|---|
| `graphemes` | 53 | 前 4 个空串占位 + 19 辅音 + 10 复杂辅音 + 21 元音（ㄱ…ㅣ） |
| `phonemes` | 37 | 前 4 个空串占位 + 33 个 ARPA 式音素（K L M N NG P T a b ch … y） |
| `ONSET` | 19 | 初声表（索引 0..18） |
| `NUCLEUS` | 21 | 中声表（索引 0..20） |
| `CODA` | 28 | 终声表（索引 0..27，**索引 0 是空格** = 无终声） |

## 与 C# 的载体差异
- `Data.Resources.g2p_ko` → 磁盘上的 `g2p-ko.zip`（`g2p/models.py` 解析）。
- `InferenceSession` → 可注入会话工厂；没装 onnxruntime 时 `session is None`，
  `predict` 返回空、`query` 退化为纯词典。
- `TryDivideHangeul(char, out string)` 的 C# `out` 参数 → 返回 `str | None`。
"""

import threading
from typing import Dict, List, Optional

from . import models
from .pack import G2pPack

#: 包文件名（对应上游的 `Data.Resources.g2p_ko`）
PACK_NAME = 'g2p-ko.zip'

#: 对应 C# 的 `graphemes`（**前 4 项是空串占位**）
GRAPHEMES = (
    '', '', '', '', 'ㄱ', 'ㄲ',
    'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄸ',
    'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄾ', 'ㅀ',
    'ㅁ', 'ㅂ', 'ㅃ', 'ㅄ', 'ㅅ', 'ㅆ',
    'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ',
    'ㅍ', 'ㅎ', 'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ',
    'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
    'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ',
    'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
)

#: 对应 C# 的 `phonemes`（前 4 项同样是空串占位）
PHONEMES = (
    '', '', '', '', 'K', 'L',
    'M', 'N', 'NG', 'P', 'T', 'a',
    'b', 'ch', 'd', 'e', 'eo', 'eu',
    'g', 'h', 'i', 'j', 'jj', 'k',
    'kk', 'm', 'n', 'o', 'p', 'pp',
    'r', 's', 'ss', 't', 'tt', 'u',
    'w', 'y',
)

#: 对应 `private static readonly string onset`（19 项）
ONSET = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
#: 对应 `nucleus`（21 项）
NUCLEUS = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
#: 对应 `coda`（28 项，★ **索引 0 是空格**，表示"无终声"）
CODA = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'

#: 对应 `UnicodeHangeulBase` / `UnicodeHangeulLast` —— 谚文音节区间的两端（闭区间）
UNICODE_HANGEUL_BASE = 0xAC00
UNICODE_HANGEUL_LAST = 0xD79F

_CACHE_LOCK = threading.Lock()
_CACHE: Optional[Dict[str, object]] = None


def build_grapheme_indexes(graphemes=GRAPHEMES) -> Dict[str, int]:
    """对应 `graphemes.Skip(4).Select((g, i) => Tuple.Create(g, i)).ToDictionary(t => t.Item1, t => t.Item2 + 4)`。"""
    out: Dict[str, int] = {}
    for i, g in enumerate(graphemes[4:]):
        out[g] = i + 4
    return out


def try_divide_hangeul(ch: str) -> Optional[str]:
    """对应 `TryDivideHangeul(char c, out string result)` → jamo 串（拆不出返回 None）。

    ★ C# 的 `out result = ""` + `return false` → Python 侧返回 `None`
      （用空串会和"合法的空分解"混淆）。
    """
    code = ord(ch)
    if code > UNICODE_HANGEUL_LAST or code < UNICODE_HANGEUL_BASE:
        return None
    rest = code - UNICODE_HANGEUL_BASE
    coda_index = rest % 28
    rest = (rest - coda_index) // 28
    nucleus_index = rest % 21
    rest = (rest - nucleus_index) // 21
    onset_index = rest
    # ★ 表长之外的码点会越界（C# 同样会 IndexOutOfRange）——先挡掉，返回 None
    if (onset_index >= len(ONSET) or nucleus_index >= len(NUCLEUS)
            or coda_index >= len(CODA)):
        return None
    return ONSET[onset_index] + NUCLEUS[nucleus_index] + CODA[coda_index]


class KoreanG2p(G2pPack):
    """对应 `KoreanG2p`。第一次构造时真读包（之后走进程级缓存）。"""

    def __init__(self, pack: Optional[bytes] = None):
        super().__init__()
        global _CACHE
        with _CACHE_LOCK:
            if _CACHE is None:
                data = pack if pack is not None else models.load_model_bytes(PACK_NAME)
                built, session = self.load_pack(
                    data,
                    lambda s: s.lower(),
                    lambda s: self.remove_tail_digits(s.lower()))
                _CACHE = {
                    'grapheme_indexes': build_grapheme_indexes(),
                    'phonemes': list(PHONEMES),
                    'dict': built,
                    'session': session,
                    'pred_cache': {},
                }
            cache = _CACHE

        self.grapheme_indexes = cache['grapheme_indexes']
        self.phonemes = cache['phonemes']
        self.dict = cache['dict']
        self.session = cache['session']
        self.pred_cache = cache['pred_cache']

    def predict(self, grapheme: str) -> List[str]:
        """对应 `protected override string[] Predict(string grapheme)`。

        ★ 覆写的唯一理由：**谚文是组合字，模型只认基本字母**，
          所以先把整串里的每个谚文拆成 jamo，拆不出的**原样保留**，
          再交给基类 `predict`。
        """
        out = []
        for ch in grapheme:
            jamo = try_divide_hangeul(ch)
            out.append(jamo if jamo is not None else ch)
        return super().predict(''.join(out))

    @staticmethod
    def reset_cache() -> None:
        """清进程级缓存（**仅供测试**；C# 的静态字段活到进程结束）。"""
        global _CACHE
        with _CACHE_LOCK:
            _CACHE = None

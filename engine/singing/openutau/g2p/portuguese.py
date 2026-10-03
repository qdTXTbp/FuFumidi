# -*- coding: utf-8 -*-
r"""PortugueseG2p —— **照搬** `OpenUtau.Core/G2p/PortugueseG2p.cs`（48 行）。

★ 本文件由 `_gen_g2p_modules.py` **从 C# 源码生成，不要手改**
  （两张静态表各几十项，手抄必错）。要改请改生成脚本后重跑；
  `tests/test_g2p_models.py` 会逐项验证表与 C# 一致。

## 静态表（生成自 C#，行号见下）
| 表 | 项数 | C# 源码行 |
|---|---|---|
| `graphemes` | 47 | 第 9 行 |
| `phonemes` | 42 | 第 16 行 |

★ `graphemes` 的**前 4 项是空串占位**（上游的编码约定），构造时用
  `Skip(4)` + `i + 4` 建索引 —— 也就是真实下标从 4 起。照搬，别改成从 0 开始。

## LoadPack 变体：`identity+identity`
`prepGrapheme` = `s => s`（恒等）
`prepPhoneme`  = `s => s`（恒等）

## 与 C# 的载体差异
- `Data.Resources.g2p_pt`（程序集**内嵌资源**）→ 磁盘上的 `g2p-pt.zip`
  （路径由 `g2p/models.py` 解析）。
- `InferenceSession` → `G2pPack` 的**可注入会话工厂**（`models.install_onnx_session_factory()`）。
  没装 onnxruntime 时 `session is None` → 未登录词预测返回空、`query` 退化为纯词典
  （这正是 C# 里 `Session == null` 的既有分支，不是我们新加的降级）。
- C# 的 `lock (lockObj)` + 静态字段做"每进程只装一次" → Python 侧模块级缓存
  （模型 1.7MB + ONNX 会话，重复装载代价大）。
"""

import threading
from typing import Dict, List, Optional

from . import models
from .pack import G2pPack

#: 包文件名（对应上游的 `Data.Resources.g2p_pt`）
PACK_NAME = 'g2p-pt.zip'

#: 对应 C# 的 `graphemes`（**前 4 项是空串占位**）
GRAPHEMES = (
    '', '', '', '', '-', 'a',
    'b', 'c', 'd', 'e', 'f', 'g',
    'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's',
    't', 'u', 'v', 'w', 'x', 'y',
    'z', 'à', 'á', 'â', 'ã', 'ç',
    'è', 'é', 'ê', 'í', 'î', 'ó',
    'ô', 'õ', 'ú', 'û', 'ü',
)

#: 对应 C# 的 `phonemes`
PHONEMES = (
    '', '', '', '', 'E', 'J',
    'L', 'O', 'R', 'S', 'X', 'Z',
    'a', 'a~', 'b', 'd', 'dZ', 'e',
    'e~', 'f', 'g', 'i', 'i~', 'j',
    'j~', 'k', 'l', 'm', 'n', 'o',
    'o~', 'p', 'r', 's', 't', 'tS',
    'u', 'u~', 'v', 'w', 'w~', 'z',
)

_CACHE_LOCK = threading.Lock()
#: 对应 C# 的静态缓存（graphemeIndexes / dict / session / predCache）
_CACHE: Optional[Dict[str, object]] = None


def build_grapheme_indexes(graphemes=GRAPHEMES) -> Dict[str, int]:
    """对应 `graphemes.Skip(4).Select((g, i) => Tuple.Create(g, i)).ToDictionary(t => t.Item1, t => t.Item2 + 4)`。

    ★ `i` 是 **Skip 之后**的下标，所以最终键值是 `i + 4`。
    """
    out: Dict[str, int] = {}
    for i, g in enumerate(graphemes[4:]):
        out[g] = i + 4
    return out


class PortugueseG2p(G2pPack):
    """对应 `PortugueseG2p`。第一次构造时真读包（之后走进程级缓存）。"""

    def __init__(self, pack: Optional[bytes] = None):
        super().__init__()
        global _CACHE
        with _CACHE_LOCK:
            if _CACHE is None:
                data = pack if pack is not None else models.load_model_bytes(PACK_NAME)
                built, session = self.load_pack(data, lambda s: s, lambda s: s)
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

    @staticmethod
    def reset_cache() -> None:
        """清进程级缓存（**仅供测试**；C# 的静态字段活到进程结束）。"""
        global _CACHE
        with _CACHE_LOCK:
            _CACHE = None

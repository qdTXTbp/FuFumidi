# -*- coding: utf-8 -*-
"""ARPA 音素表 G2P —— **照搬** `OpenUtau.Core/G2p/ArpabetG2p.cs`（50 行）。

英文的"字素→ARPA 音素"表：词表命中直接给音素，未登录词走包里的 ONNX 预测。

## 两张静态表（照搬，别"整理"）
- `graphemes`：**前 4 项是空串**，然后是 `'` 与 `-`，再是 a..z（共 32 项）。
  构造时 `Skip(4)` 之后再 `Select((g, i) => i + 4)` —— 所以**下标是 4..31**，
  正好对上 `phonemes` 的前 4 个空串（下标 0..3 不用）。
  这个"前 4 个占位"是上游的编码约定，别改成从 0 开始。
- `phonemes`：43 项，前 4 个空串。

## 与 C# 的载体差异
- `Data.Resources.g2p_arpabet`（**程序集内嵌资源**）→ 磁盘上的 `G2p/Data/g2p-arpabet.zip`。
  路径由宿主注入（`set_data_dir`）；没注入时抛 `FileNotFoundError` 并说明怎么配。
- `InferenceSession` → 沿用 `G2pPack` 那套**可注入的会话工厂**（`g2p.pack.set_onnx_session_factory`）。
  没注入时 `session is None` → 未登录词预测返回空（= C# 里 `Session == null` 的既有分支）。
- C# 用 `lock (lockObj)` + 静态字段做"每进程只装一次"的缓存。Python 侧同样在模块级缓存
  （2.4MB 的包 + 会话，重复装载代价大）。
"""

import os
import threading
from typing import Dict, List, Optional

from .pack import G2pPack

#: 包文件名（对应 `Data.Resources.g2p_arpabet`）
PACK_NAME = 'g2p-arpabet.zip'

#: 对应 C# 的 `graphemes`（**前 4 项是空串**，是上游的编码约定）
GRAPHEMES = (
    '', '', '', '', "'", '-', 'a', 'b', 'c', 'd', 'e',
    'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
    'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
)

#: 对应 C# 的 `phonemes`（前 4 项同样是空串）
PHONEMES = (
    '', '', '', '', 'aa', 'ae', 'ah', 'ao', 'aw', 'ay', 'b', 'ch',
    'd', 'dh', 'eh', 'er', 'ey', 'f', 'g', 'hh', 'ih', 'iy', 'jh',
    'k', 'l', 'm', 'n', 'ng', 'ow', 'oy', 'p', 'r', 's', 'sh', 't',
    'th', 'uh', 'uw', 'v', 'w', 'y', 'z', 'zh',
)

_DATA_DIR: Optional[str] = None
_CACHE_LOCK = threading.Lock()
#: 对应 C# 的静态缓存（每进程只装一次）
_CACHE: Optional[Dict[str, object]] = None


def set_data_dir(path: Optional[str]) -> None:
    """注入 G2P 数据目录（宿主在启动时调，指向 OpenUTAU 的 `G2p/Data/`）。"""
    global _DATA_DIR
    _DATA_DIR = path


def g2p_data_dir() -> Optional[str]:
    return _DATA_DIR


def build_grapheme_indexes(graphemes=GRAPHEMES) -> Dict[str, int]:
    """对应 C# 的 `graphemes.Skip(4).Select((g, i) => i + 4).ToDictionary(...)`。

    ★ `i` 是 **Skip 之后**的下标，所以最终的键值是 `i + 4`（下标 4..31）。
    """
    return {g: i + 4 for i, g in enumerate(graphemes[4:])}


class ArpabetG2p(G2pPack):
    """对应 `ArpabetG2p`。第一次构造时才真正读包（之后走进程级缓存）。"""

    def __init__(self, pack: Optional[bytes] = None):
        super().__init__()
        global _CACHE
        with _CACHE_LOCK:
            if _CACHE is None:
                data = pack if pack is not None else _read_pack()
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

    @staticmethod
    def reset_cache() -> None:
        """清掉进程级缓存（**仅供测试**；C# 无对应物 —— 它的静态字段活到进程结束）。"""
        global _CACHE
        with _CACHE_LOCK:
            _CACHE = None


def _read_pack(pack_name: str = PACK_NAME) -> bytes:
    """从注入的数据目录读包。"""
    if _DATA_DIR is None:
        raise FileNotFoundError(
            '未配置 G2P 数据目录 —— 请调用 arpabet.set_data_dir(<OpenUTAU 的 G2p/Data 目录>)。'
            '（C# 侧这份数据是程序集内嵌资源 Data.Resources.g2p_arpabet，我们这边是磁盘文件）')
    path = os.path.join(_DATA_DIR, pack_name)
    if not os.path.isfile(path):
        raise FileNotFoundError('找不到 %s（数据目录 = %s）' % (pack_name, _DATA_DIR))
    with open(path, 'rb') as f:
        return f.read()

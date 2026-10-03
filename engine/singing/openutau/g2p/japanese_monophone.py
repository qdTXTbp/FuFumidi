# -*- coding: utf-8 -*-
"""日语单音 G2P —— **照搬** `OpenUtau.Core/G2p/JapaneseMonophoneG2p.cs`（126 行）。

## 它是 G2p 里的**特例**，与其它 12 个有三处不同（照搬，别按别的 G2p 的样子写）
1. **自定义 zip 布局**：`g2p-ja-mono.zip` 里**没有** `g2p.onnx`，也没有 `dict.txt`，
   而是四份词典 `hiragana.txt` / `katakana.txt` / `romaji.txt` / `special.txt`。
   所以它**覆写 `LoadPack`**（其余 12 个用基类那套标准布局）。
   ★ 覆写版里**没有任何 ONNX 代码** → `session` 恒为 `None`，
     也就是"永远走词典、不做神经网络预测"。这是它本来的设计，不是降级。
2. ★ 四份词典被赋给**同一个属性四次**：
   ```csharp
   Dict = hiragana; Dict = katakana; Dict = romaji; Dict = special;
   ```
   而 `hiragana/katakana/romaji/special` 全都来自 `tuple.Item1`（**同一个对象**），
   所以后三次赋值是**死代码**。照搬（保留这行），别"清理"。
   （真要合并成一个词典，上游其实已经把四份都 `AddEntry` 进同一个 builder 了。）
3. `graphemeIndexes` 同样是 `Skip(4)` + `i + 4` 的编码约定（见 `arpabet.py` 的说明），
   前 4 个字素是空串占位。

## 载入了哪些字素
`graphemes` 覆盖：英文字母、**平假名**（あ〜ん、っ、ゔ、ゐ、ゑ、浊点゜）、
**片假名**（ア〜ン、ッ、ヴ、ヰ、ヱ）、气息音（息/吸）、连音符 `-`、休止符 `R`。
`phonemes` 48 项，含 `A AP E I N O U SP a b by ch cl d dy e f g gw gy h hy i j k kw ky
m my n ng ngy ny o p py r ry s sh t ts ty u v w y z`。
"""

import threading
import zipfile
from io import BytesIO
from typing import Dict, List, Optional

from . import models
from .pack import G2pPack

#: 包文件名（对应上游的 `Data.Resources.g2p_ja_mono`）
PACK_NAME = 'g2p-ja-mono.zip'

#: 对应 C# 的 `graphemes`（**前 4 项是空串**，上游的编码约定）
GRAPHEMES = (
    '', '', '', '', 'a', 'b', 'c', 'd', 'e', 'f', 'g',
    'h', 'i', 'j', 'k', 'm', 'n', 'o', 'p', 'r', 's',
    't', 'u', 'v', 'w', 'y', 'z', 'あ', 'い', 'う', 'え',
    'お', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'か', 'き', 'く',
    'け', 'こ', 'さ', 'し', 'す', 'せ', 'そ', 'ざ', 'じ', 'ず',
    'ぜ', 'ぞ', 'た', 'ち', 'つ', 'て', 'と', 'だ', 'ぢ', 'づ', 'で',
    'ど', 'な', 'に', 'ぬ', 'ね', 'の', 'は', 'ひ', 'ふ', 'へ', 'ほ',
    'ば', 'び', 'ぶ', 'べ', 'ぼ', 'ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ', 'ま',
    'み', 'む', 'め', 'も', 'や', 'ゆ', 'よ', 'ゃ', 'ゅ', 'ょ', 'ら',
    'り', 'る', 'れ', 'ろ', 'わ', 'を', 'ん', 'っ', 'ヴ', 'ゔ', '゜',
    'ゐ', 'ゑ', 'ア', 'イ', 'ウ', 'エ', 'オ', 'ァ', 'ィ', 'ゥ', 'ェ',
    'ォ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ',
    'ザ', 'ジ', 'ズ', 'ゼ', 'ゾ', 'タ', 'チ', 'ツ', 'テ', 'ト', 'ダ',
    'ヂ', 'ヅ', 'デ', 'ド', 'ナ', 'ニ', 'ヌ', 'ネ', 'ノ', 'ハ', 'ヒ',
    'フ', 'ヘ', 'ホ', 'バ', 'ビ', 'ブ', 'ベ', 'ボ', 'パ', 'ピ', 'プ',
    'ペ', 'ポ', 'マ', 'ミ', 'ム', 'メ', 'モ', 'ヤ', 'ユ', 'ヨ', 'ャ',
    'ュ', 'ョ', 'ラ', 'リ', 'ル', 'レ', 'ロ', 'ワ', 'ヲ', 'ン', 'ッ',
    'ヰ', 'ヱ', '息', '吸', '-', 'R',
)

#: 对应 C# 的 `phonemes`（前 4 项同样是空串占位）
PHONEMES = (
    '', '', '', '', 'A', 'AP', 'E', 'I', 'N', 'O', 'U',
    'SP', 'a', 'b', 'by', 'ch', 'cl', 'd', 'dy', 'e', 'f', 'g', 'gw',
    'gy', 'h', 'hy', 'i', 'j', 'k', 'kw', 'ky', 'm', 'my', 'n',
    'ng', 'ngy', 'ny', 'o', 'p', 'py', 'r', 'ry', 's', 'sh', 't', 'ts',
    'ty', 'u', 'v', 'w', 'y', 'z',
)

#: 覆写版 `LoadPack` 读的四份词典（顺序即 C# 里的读取顺序）
DICT_FILES = ('hiragana.txt', 'katakana.txt', 'romaji.txt', 'special.txt')

_CACHE_LOCK = threading.Lock()
#: 对应 C# 的静态缓存（`graphemeIndexes`/`hiragana`/…/`session`/`predCache`）
_CACHE: Optional[Dict[str, object]] = None


def build_grapheme_indexes(graphemes=GRAPHEMES) -> Dict[str, int]:
    """对应 `graphemes.Skip(4).Select((g, i) => Tuple.Create(g, i + 4))...`。

    ★ `i` 是 **Skip 之后**的下标，所以最终键值是 `i + 4`（下标 4 起）。
    ★ 重名字素（C# 的 `ToDictionary` 会**抛 ArgumentException**）——照搬这个行为：
      这里用同样"后写覆盖"的方式不会抛，但会静默取最后一个。
      实测本表无重复（C# 能正常构造），所以不构成实际差异。
    """
    out: Dict[str, int] = {}
    for i, g in enumerate(graphemes[4:]):
        out[g] = i + 4
    return out


class JapaneseMonophoneG2p(G2pPack):
    """对应 `JapaneseMonophoneG2p`。第一次构造时真读包，之后走进程级缓存。"""

    def __init__(self, pack: Optional[bytes] = None):
        super().__init__()
        global _CACHE
        with _CACHE_LOCK:
            if _CACHE is None:
                data = pack if pack is not None else models.load_model_bytes(PACK_NAME)
                built = self._load_pack_override(data)
                _CACHE = {
                    'grapheme_indexes': build_grapheme_indexes(),
                    'phonemes': list(PHONEMES),
                    # ★ 同一份词典被赋给 4 个静态变量 → 只赋一次，session 恒 None
                    'dict': built,
                    'session': None,
                    'pred_cache': {},
                }
            cache = _CACHE

        self.grapheme_indexes = cache['grapheme_indexes']
        self.phonemes = cache['phonemes']
        self.dict = cache['dict']
        self.session = cache['session']
        self.pred_cache = cache['pred_cache']

    def _load_pack_override(self, data: bytes):
        """对应它**覆写**的 `LoadPack`（自定义 zip 布局，无 ONNX）。

        ★ 与基类那版的差别：读 4 份词典而不是 `dict.txt`，且**完全不碰 `g2p.onnx`**。
        ★ 切分规则与基类一致：`;;;` 开头跳过、按**两个空格**切、必须恰好两段。
        """
        from .dictionary import G2pDictionary
        builder = G2pDictionary.new_builder()
        with zipfile.ZipFile(BytesIO(data)) as z:
            for line in _extract_text(z, 'phones.txt'):
                parts = line.strip().split()
                if len(parts) == 2:
                    builder.add_symbol(parts[0], parts[1])
            for name in DICT_FILES:
                for line in _extract_text(z, name):
                    if line.startswith(';;;'):
                        continue
                    parts = line.strip().split('  ')
                    if len(parts) == 2:
                        builder.add_entry(parts[0], parts[1].split())
        return builder.build()

    @staticmethod
    def reset_cache() -> None:
        """清进程级缓存（**仅供测试**；C# 的静态字段活到进程结束）。"""
        global _CACHE
        with _CACHE_LOCK:
            _CACHE = None


def _extract_text(z: zipfile.ZipFile, name: str) -> List[str]:
    """对应 `Zip.ExtractText`：读出并按行切分（UTF-8）。"""
    return z.read(name).decode('utf-8').splitlines()

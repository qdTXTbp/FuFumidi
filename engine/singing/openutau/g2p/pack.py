# -*- coding: utf-8 -*-
r"""G2P 打包字典（字典 + 未登录词 ONNX 预测）—— **照搬** `OpenUtau.Core/Api/G2pPack.cs`(136)。

一个 `g2p-*.zip` 里有三样：`dict.txt`（词表）、`phones.txt`（符号表）、`g2p.onnx`
（未登录词的 seq2seq 预测模型）。本类把三者装成一个 `IG2p`：
**词表命中就直接返回；未命中才走 ONNX 预测**，并把结果缓存进 `PredCache`。

## 照搬时保留的语义（别"整理"掉）
1. `kAllPunct = ^[\p{P}]$` —— **只匹配"恰好一个标点字符"**的串！
   类没有量词、又带首尾锚点，所以 `"!!"`（两个字符）**不匹配**。
   Python 的 `re` 没有 `\p{P}`，这里用 `unicodedata.category(ch).startswith('P')` 等价实现，
   并**保留"只判一个字符"这一点**。
2. `query` 的顺序：空串或纯标点 → `None`；先问 `dict`；`dict` 给 `None` 才看缓存、
   再 `predict`；预测结果为空 → `None`；命中则**写缓存并返回副本**。
   ★ "`dict` 命中就**不查缓存**" 是原文结构（`phonemes == null && !cache.TryGetValue`），
   照搬。
3. 词表里 `phone.txt` 的每行是 `符号<空白>类型`，**必须恰好两段**；
   `dict.txt` 按**两个空格**切分，**必须恰好两段**，且**以 `;;;` 开头的行整行跳过**。
   两处的 `prepGrapheme` / `prepPhoneme` 是调用方给的预处理（`ArpabetG2p` 传的是
   小写化 + 去掉尾部数字）。
4. `remove_tail_digits` 是**循环**去尾（`"aa12"` → `"aa"`）。
5. `predict`：自回归解码 —— 从 `tgt = [2]` 起，每次把 `(src, tgt, t)` 喂进去，
   预测出 `2` 就把 `t` 前移、否则把预测符号接到 `tgt`；循环条件是
   `t[0] < src 长度 && tgt 长度 < 48`；最后 `DecodePhonemes(tgt.Skip(1))`。
6. `encode_word`：**小写**后逐字符查表，**查不到的字符直接丢掉**（不是插占位）。

## 与 C# 的载体差异
- `InferenceSession`（`Microsoft.ML.OnnxRuntime`）→ **可注入的会话工厂**
  （`set_onnx_session_factory`）。没注入时 `session is None` → `predict` 返回空数组
  → `query` 返回 `None`。这**正是 C# 里 `Session == null` 的既有分支**，所以不是行为差异，
  而是"没装推理后端"时两边落点相同。
- `Zip.ExtractText` / `Zip.ExtractBytes` → `zipfile`；C# 的 `ExtractText` 会把内容
  按行切开并丢掉行尾的 `\\r`，这里同样处理（`dict.txt` 实测是 CRLF）。
"""

import re
import unicodedata
import zipfile
from io import BytesIO
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from .dictionary import G2pDictionary
from .i_g2p import IG2p

#: 对应 `protected readonly static Regex kAllPunct = new Regex(@"^[\p{P}]$")`
#: ★ 只判**一个**字符（类没有量词 + 首尾锚点），这里显式实现这一点。
_PUNCT_RE = re.compile(r'^\W$', re.UNICODE)

#: 预测循环里的上界（C# 里写死 48）
_MAX_PRED_LEN = 48
#: `tgt` 的起始符号（C# 里是 `new int[,] { { 2 } }`）
_TGT_START = 2

_SESSION_FACTORY: Optional[Callable[[bytes], object]] = None


def set_onnx_session_factory(factory: Optional[Callable[[bytes], object]]) -> None:
    """注入 ONNX 会话工厂（宿主在启动时调；传 None 恢复为"没有推理后端"）。

    `factory(onnx_bytes)` 需返回一个对象，带
    `run({'src': ..., 'tgt': ..., 't': ...}) -> [输出]` 的接口（见 `predict`）。
    """
    global _SESSION_FACTORY
    _SESSION_FACTORY = factory


def is_all_punct(s: str) -> bool:
    """对应 `kAllPunct.IsMatch(s)`。

    ★ C# 的 `\\p{P}` 是"Unicode 标点"类。这里用 `unicodedata.category` 判定，
    并**只接受长度为 1 的串** —— 因为原正则的字符类没有量词。
    """
    if len(s) != 1:
        return False
    return unicodedata.category(s).startswith('P')


class G2pPack(IG2p):
    """对应抽象的 `G2pPack`。子类构造时填好下面几个成员。"""

    def __init__(self):
        self.grapheme_indexes: Dict[str, int] = {}
        self.phonemes: List[str] = []
        self.dict: Optional[IG2p] = None
        self.session: Optional[object] = None
        self.pred_cache: Dict[str, List[str]] = {}

    # ------------------------------------------------------------------ 装载

    def load_pack(self, data: bytes,
                  prep_grapheme: Optional[Callable[[str], str]] = None,
                  prep_phoneme: Optional[Callable[[str], str]] = None
                  ) -> Tuple[IG2p, Optional[object]]:
        """对应 `LoadPack(data, prepGrapheme, prepPhoneme)`。返回 `(dict, session)`。"""
        prep_grapheme = prep_grapheme or (lambda s: s)
        prep_phoneme = prep_phoneme or (lambda s: s)

        with zipfile.ZipFile(BytesIO(data)) as z:
            dict_txt = _extract_text(z, 'dict.txt')
            phones_txt = _extract_text(z, 'phones.txt')
            g2p_data = z.read('g2p.onnx')

        builder = G2pDictionary.new_builder()
        for line in phones_txt:
            parts = line.strip().split()
            if len(parts) == 2:
                builder.add_symbol(prep_phoneme(parts[0]), parts[1])
        for line in dict_txt:
            if line.startswith(';;;'):
                continue
            # ★ 按**两个空格**切分，且必须恰好两段
            parts = line.strip().split('  ')
            if len(parts) == 2:
                builder.add_entry(prep_grapheme(parts[0]),
                                  [prep_phoneme(s) for s in parts[1].split()])
        built = builder.build()

        session = None
        if _SESSION_FACTORY is not None:
            session = _SESSION_FACTORY(g2p_data)
        return built, session

    @staticmethod
    def remove_tail_digits(s: str) -> str:
        """对应 `RemoveTailDigits`：**循环**去掉尾部的数字。"""
        while s and s[-1].isdigit():
            s = s[:-1]
        return s

    # ------------------------------------------------------------------ IG2p

    def is_valid_symbol(self, symbol: str) -> bool:
        return self.dict.is_valid_symbol(symbol)

    def is_vowel(self, symbol: str) -> bool:
        return self.dict.is_vowel(symbol)

    def is_glide(self, symbol: str) -> bool:
        return self.dict.is_glide(symbol)

    def query(self, grapheme: str) -> Optional[List[str]]:
        if len(grapheme) == 0 or is_all_punct(grapheme):
            return None
        phonemes = self.dict.query(grapheme)
        if phonemes is None:
            cached = self.pred_cache.get(grapheme)
            if cached is not None:
                phonemes = cached
            else:
                phonemes = self.predict(grapheme)
                if len(phonemes) == 0:
                    return None
                self.pred_cache[grapheme] = phonemes
        return list(phonemes)       # C# 是 Clone()：返回副本

    def unpack_hint(self, hint: str, separator: str = ' ') -> Optional[List[str]]:
        return self.dict.unpack_hint(hint, separator)

    # ------------------------------------------------------------------ 未登录词预测

    def predict(self, grapheme: str) -> List[str]:
        """对应 `Predict`：自回归解码。`session is None` 时返回空数组（照搬 C#）。"""
        import numpy as np
        src = self.encode_word(grapheme)
        if len(src[0]) == 0 or self.session is None:
            return []
        src_len = len(src[0])
        tgt = [_TGT_START]
        t = 0
        while t < src_len and len(tgt) < _MAX_PRED_LEN:
            # ★★ 三个「不真跑模型就发现不了」的载体坑，都记在这里：
            #
            # 1) C# 调的是 `Session.Run(inputs)` —— IInferenceSession 有一个
            #    「只给输入、返回**全部**输出」的重载，所以它不传输出名。
            #    Python 的 `run(output_names, input_feed, ...)` 第一个位置参数
            #    **是输出名且必填**，直接 `run(feed)` 会抛
            #    「missing 1 required positional argument: 'input_feed'」。
            #    传 `None` 等价于"全部输出"（模型只有一个输出 `pred`）。
            #
            # 2) ★ dtype 必须是 **int32**。C# 的 `Tensor<int>`/`DenseTensor<int>`
            #    映射到 onnxruntime 就是 int32；而 numpy 默认 int64，直接喂
            #    Python list 会得到
            #    「INVALID_ARGUMENT : Unexpected input data type. Actual: (tensor(int64)),
            #     expected: (tensor(int32))」。所以三个输入都要显式指定 dtype。
            #
            # 3) ★ 输出 shape 是 **[1]**（不是标量也不是二维），所以只取 `[0][0]`。
            #    C# 那边 `AsTensor<int>()[0]` 同样只取一层 —— 一致。
            feed = {
                'src': np.array([src[0]], dtype=np.int32),
                'tgt': np.array([tgt], dtype=np.int32),
                't': np.array([t], dtype=np.int32),
            }
            outputs = self.session.run(None, feed)
            pred = int(np.asarray(outputs[0]).ravel()[0])
            if pred != _TGT_START:
                tgt.append(pred)
            else:
                t += 1
        return self.decode_phonemes(tgt[1:])

    def encode_word(self, grapheme: str) -> List[List[int]]:
        """对应 `EncodeWord`：小写后逐字符查表，**查不到的字符丢掉**。"""
        encoded = []
        for c in grapheme.lower():
            index = self.grapheme_indexes.get(c)
            if index is not None:
                encoded.append(index)
        return [encoded]

    def decode_phonemes(self, indexes: Sequence[int]) -> List[str]:
        """对应 `DecodePhonemes`。"""
        return [self.phonemes[i] for i in indexes]


def _extract_text(z: zipfile.ZipFile, name: str) -> List[str]:
    """对应 `Zip.ExtractText(data, name)`：按行切开并去掉行尾的 `\\r`。

    ★ C# 的 `ExtractText` 实测对 `dict.txt`（CRLF）给出的是**去掉 `\\r` 的行**，
    所以这里显式 `splitlines()`（它会一并处理 `\\r\\n`）。
    """
    return z.read(name).decode('utf-8', 'replace').splitlines()

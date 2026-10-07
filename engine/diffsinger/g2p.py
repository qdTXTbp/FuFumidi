# -*- coding: utf-8 -*-
r"""DiffSinger 的 g2p（词典 + 音素符号决策）—— **照搬**
`OpenUtau.Core/DiffSinger/DiffSingerBasePhonemizer.cs` 的 `LoadG2p`（:138-170）、
`IsPhonemeSupported`（:172-175）、`ValidatePhoneme`（:180-192）、
`ParsePhoneticHint`（:194-197）、`GetSymbols`（:207-231）。

★ **复用**已照搬的 `singing.openutau.g2p.dictionary.G2pDictionary`（`G2pDictionary.cs`）与
  `singing.openutau.base_chinese.BaseChinesePhonemizer.romanize`（`BaseChinesePhonemizer.cs`），
  不在本文件里重写 Trie 与拼音。

## ★ 我们旧实现踩过的坑（本文件的 docstring 就是为了防它复发）
旧 `lyrics_to_phonemes` 对非汉字走 `_phoneme_by_bare()` 的**裸名兜底**：
把音素表按字母序（`en/* < ja/* < ko/* < zh/*`）一找，裸名 `n` 命中的是 `ko/n` ——
所以中文歌词 `n/i/h` 一直被音素化成 **`ko/n` `ko/i` `ko/h`**。

上游没有这个兜底：`ValidatePhoneme` 只做**一次**确定性的尝试 ——
先试原符号，不合法就**只加 `langCode + "/"` 前缀**再试，还不合法返回**空串**（被丢弃）。
`n` → 裸 `n` 不合法 → `zh/n` 合法 → 结果唯一且正确。
"""

import io
import os
import re
from typing import Dict, List, Optional, Sequence, Tuple

import yaml

from singing.openutau.g2p.dictionary import G2pDictionary

from . import RenderError
from .utils import phoneme_language

#: 上游 `GetDictionaryName()`（各语言子类覆写）；`DiffSingerBasePhonemizer` 默认空串
DEFAULT_DICT_NAME = ''


def dictionary_name(lang_code: str) -> str:
    """对应 `GetDictionaryName()` —— 有语言码就是 `dsdict-<lang>.yaml`，否则 `dsdict.yaml`。"""
    return 'dsdict-%s.yaml' % lang_code if lang_code else 'dsdict.yaml'


def load_ds_g2p(root: str, lang_code: str,
                warn: Optional[List[str]] = None) -> Tuple[G2pDictionary, str]:
    """对应 `LoadG2p`（:138-170）→ `(词典, 实际用的词典名)`。

    顺序（照搬 :143-152）：
      1. `dsdict-<lang>.yaml`
      2. `dsdict.yaml`
    ★ **命中第一个存在的文件即 break**。
    ★ 两个都没有时**降级**读 `dictionary-<lang>.txt`（Tab 分隔的 `词<TAB>音素 音素`），
      并往 `warn` 里写一条 —— 这是**本仓库相对上游的唯一放宽**（用户已定"txt 降级"），
      用于救只带 txt 的旧声库。上游完全没有这个分支。
    """
    warn = warn if warn is not None else []
    candidates = [dictionary_name(lang_code), 'dsdict.yaml']
    for name in candidates:
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            continue
        with io.open(path, encoding='utf-8') as f:
            data = yaml.safe_load(f) or {}
        builder = G2pDictionary.new_builder().load(data)
        # ★ :164-165 SP / AP 强制标为 vowel
        builder.add_symbol('SP', True)
        builder.add_symbol('AP', True)
        return builder.build(), name

    # ---- 降级：dictionary-<lang>.txt
    txt_name = 'dictionary-%s.txt' % lang_code if lang_code else 'dictionary.txt'
    txt_path = os.path.join(root, txt_name)
    if os.path.isfile(txt_path):
        warn.append('未找到 %s，已降级使用 %s（上游不认这个文件）'
                    % (' / '.join(candidates), txt_name))
        builder = G2pDictionary.new_builder()
        with io.open(txt_path, encoding='utf-8') as f:
            for line in f:
                line = line.rstrip('\r\n')
                if not line or '\t' not in line:
                    continue
                word, phonemes = line.split('\t', 1)
                syms = phonemes.split()
                if syms:
                    builder.add_entry(word.strip(), syms)
        builder.add_symbol('SP', True)
        builder.add_symbol('AP', True)
        return builder.build(), txt_name

    raise RenderError('在 %s 下找不到词典（试过 %s 与 %s）'
                      % (root, ' / '.join(candidates), txt_name))


# ---------------------------------------------------------------- 符号校验

def is_phoneme_supported(tokens: Dict[str, int], phoneme: str) -> bool:
    """对应 `IsPhonemeSupported`（:172-175）。"""
    return phoneme in tokens


def validate_phoneme(g2p: G2pDictionary, tokens: Dict[str, int], phoneme: str,
                     lang_code: str) -> str:
    """对应 `ValidatePhoneme`（:180-192）→ 合法则返回（可带前缀），否则**空串**。

    ★ **只加一次 `langCode + "/"` 前缀** —— 这是与旧实现最大的区别：
      旧实现会拿音素表按字母序"猜"一个裸名命中项（`n` → `ko/n`），这里没有这种猜测。

    ```csharp
    if (g2p.IsValidSymbol(phoneme) && phonemeTokens.ContainsKey(phoneme)) return phoneme;
    if (langCode != String.Empty) {
        var withLang = langCode + "/" + phoneme;
        if (g2p.IsValidSymbol(withLang) && phonemeTokens.ContainsKey(withLang)) return withLang;
    }
    return String.Empty;
    ```
    """
    if g2p.is_valid_symbol(phoneme) and is_phoneme_supported(tokens, phoneme):
        return phoneme
    if lang_code:
        with_lang = lang_code + '/' + phoneme
        if g2p.is_valid_symbol(with_lang) and is_phoneme_supported(tokens, with_lang):
            return with_lang
    return ''


def parse_phonetic_hint(hint: str, g2p: G2pDictionary, tokens: Dict[str, int],
                        lang_code: str) -> List[str]:
    """对应 `ParsePhoneticHint`（:194-197）—— 空格切分 + 逐个校验，**丢弃非法项**。

    ★ 上游用 `hint.Split()`（按**空白**切分，不只是空格），Python 用 `.split()` 等价。
    """
    return [s for s in (validate_phoneme(g2p, tokens, p, lang_code)
                        for p in hint.split()) if s]


# ---------------------------------------------------------------- 音素决策

#: 汉字（含扩展 A/B 与兼容区）。假名/谚文不在此列：它们的词典本来就是假名/谚文。
_CJK_RE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')


def get_symbols(g2p: G2pDictionary, tokens: Dict[str, int], lyric: str,
                phonetic_hint: Optional[str], lang_code: str
                ) -> Tuple[List[str], List[str]]:
    """对应 `GetSymbols`（:207-231）→ `(音素列表, 被拒符号列表)`。

    四级优先（**照搬，不要改**）：
      1. `phoneticHint` 非空 → 直接当音素解析
      2. 查 g2p 词典：`Query(lyric)` 或 `Query(lyric.lower())`
      3. 词典未命中 → **把歌词当 phoneticHint**（于是裸 `n` 会被加上 `zh/` 前缀）
      4. 仍为空 → 返回空列表
    """
    rejected: List[str] = []
    if phonetic_hint:
        out = parse_phonetic_hint(phonetic_hint, g2p, tokens, lang_code)
        return out, [p for p in phonetic_hint.split() if p not in out]

    # ★ 汉字 → 拼音（**本仓库补上的一步**，2026-10-06）
    #
    #   DiffSinger 的中文词典（`dsdict-zh.yaml` / `dictionary-zh.txt`）的 grapheme 是**拼音**：
    #   `a → zh/a`、`bu → zh/bu`…… 汉字必须先转拼音才可能命中。
    #   上游这一步在 `BaseChinesePhonemizer.Romanize` 里，本仓库的 `render` / `sing-render`
    #   两条路径都**没接**上，于是：中文声库 + 汉字歌词 → `Query('不')` 恒为 None →
    #   「音素化没有产出任何音素（歌词是否为空？）」/「没有可渲染的音素」，用户完全看不懂。
    #   实测声库：花火（中文，dsdict-zh.yaml 正常）。
    if lyric and _CJK_RE.search(lyric):
        try:
            syls = [s for s in romanize([lyric]) if s]
        except Exception:                       # noqa: BLE001 —— 转不了就退回老路径
            syls = []
        if syls:
            expanded: List[str] = []
            ok_all = True
            for syl in syls:
                # ★ `query` 命中但音素被过滤空（符号登记晚于条目）时返回的是**空表**，
                #   不是 None —— 两者都要当"没查到"处理，否则会静默产出 0 个音素。
                r = g2p.query(syl)
                if not r:
                    r = g2p.query(syl.lower())
                if not r:
                    by_hint = parse_phonetic_hint(syl, g2p, tokens, lang_code)
                    if not by_hint:
                        ok_all = False
                        break
                    expanded.extend(by_hint)
                else:
                    expanded.extend(r)
            if ok_all and expanded:
                return expanded, rejected

    result = g2p.query(lyric)
    if result is None:
        result = g2p.query(lyric.lower())
    if result is not None:
        return list(result), rejected

    out = parse_phonetic_hint(lyric, g2p, tokens, lang_code)
    return out, [p for p in lyric.split() if p not in out]


def romanize(lyrics: Sequence[str]) -> List[str]:
    """汉字 → 无声调拼音（**复用** `BaseChinesePhonemizer.Romanize`）。

    ★ 复用已照搬的实现，不再写第二份 —— `tests/test_openutau_core_matches_source.py`
      已在强制它与上游 csharp-pinyin 的一致性。
    """
    from singing.openutau.base_chinese import BaseChinesePhonemizer
    return BaseChinesePhonemizer.romanize(lyrics)


def lang_id_of(phoneme: str, language_ids: Dict[str, int]) -> int:
    """对应 `:421` 的 `GetValueOrDefault(PhonemeLanguage(phoneme), 0)`。"""
    return int(language_ids.get(phoneme_language(phoneme), 0))

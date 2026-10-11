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

#: 假名（平/片）出现检测
_KANA_RE = re.compile(r'[\u3041-\u30ff\u31f0-\u31ff]')

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
        # ★ 先登记符号、再建条目：add_entry 只保留「已登记为符号」的音素
        #   （登记晚于条目会被静默丢掉，query 返回空表 —— 2026-10-11 实测）。
        #   元音判定用最小启发式：a/i/u/e/o（含长音大写）与 N 算元音，其余按辅音。
        _VOWELS = {'a', 'i', 'u', 'e', 'o', 'A', 'I', 'U', 'E', 'O', 'N'}
        entries = []
        with io.open(txt_path, encoding='utf-8') as f:
            for line in f:
                line = line.rstrip('\r\n')
                if not line or '\t' not in line:
                    continue
                word, phonemes = line.split('\t', 1)
                syms = phonemes.split()
                if syms:
                    entries.append((word.strip(), syms))
                    for s in syms:
                        if s not in ('SP', 'AP'):
                            builder.add_symbol(s, s in _VOWELS)
        for word, syms in entries:
            builder.add_entry(word, syms)
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

    # ★ 假名 → 罗马字（仅 ja）：日文声库的 txt 词典键是罗马字（yaml 版键是假名、
    #   上面的直查就能中），假名歌词必须先转拍再查 —— 否则「い / じゃ / ……」
    #   全部「歌词无法识别」（2026-10-11，liu2_ying2 实测）。
    if lang_code == 'ja' and lyric and _KANA_RE.search(lyric):
        moras = kana_to_romaji(lyric)
        syms2: List[str] = []
        ok = bool(moras)
        for m in moras:
            r = g2p.query(m) or g2p.query(m.lower())
            if not r:
                by_hint = parse_phonetic_hint(m, g2p, tokens, lang_code)
                if not by_hint:
                    ok = False
                    break
                syms2.extend(by_hint)
            else:
                syms2.extend(r)
        if ok and syms2:
            return syms2, rejected

    out = parse_phonetic_hint(lyric, g2p, tokens, lang_code)
    return out, [p for p in lyric.split() if p not in out]


def romanize(lyrics: Sequence[str]) -> List[str]:
    """汉字 → 无声调拼音（**复用** `BaseChinesePhonemizer.Romanize`）。

    ★ 复用已照搬的实现，不再写第二份 —— `tests/test_openutau_core_matches_source.py`
      已在强制它与上游 csharp-pinyin 的一致性。
    """
    from singing.openutau.base_chinese import BaseChinesePhonemizer
    return BaseChinesePhonemizer.romanize(lyrics)


# ---------------------------------------------------------------- 假名 → 罗马字
#
# ★ 背景（2026-10-11，liu2_ying2 实测）：日文 DS 声库的 `dictionary-ja.txt` 是**罗马字键**
#   （ka→k a、si→s i……167 行，全表无一个假名键）。OpenUTAU 的日语音素化器会把假名歌词
#   先转成罗马字再查词典；本仓库缺了这一步，于是「い / じゃ / ……」整句整句报
#   「歌词无法识别」—— 把语言改对也没用，因为词典里根本没有假名键。
#
#   这里的拼法**对齐词典实际收的键**（shi/si、chi/ti、ji/ja、tsu/tu 多套拼法都收了，
#   取最常见的一套），片假名经 Unicode 平移映射到同一套读音。
_KANA_MORA = {
    # 清音（あ行～わ行）
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
    'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
    'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
    'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
    'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
    'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
    'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
    'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
    'わ': 'wa', 'を': 'wo', 'ん': 'n',
    # 濁音 / 半濁音
    'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
    'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
    'だ': 'da', 'ぢ': 'di', 'づ': 'du', 'で': 'de', 'ど': 'do',
    'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
    'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
    'ゔ': 'vu',
}
# 拗音 / 小書き（基綴 + ゃゅょぁぃぅぇぉ）
_KANA_COMBO = {
    'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
    'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
    'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
    'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
    'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
    'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
    'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
    'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
    'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
    'ぢゃ': 'ja', 'ぢゅ': 'ju', 'ぢょ': 'jo',
    'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
    'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',
    'ふぁ': 'fa', 'ふぃ': 'fi', 'ふぇ': 'fe', 'ふぉ': 'fo', 'ふゅ': 'fyu',
    'てぃ': 'ti', 'とぅ': 'tu', 'でぃ': 'di', 'どぅ': 'du',
    'うぁ': 'wa', 'うぃ': 'wi', 'うぇ': 'we', 'うぉ': 'wo',
    'ヴぁ': 'va', 'ヴぃ': 'vi', 'ヴぇ': 've', 'ヴぉ': 'vo',
    'しぇ': 'she', 'ちぇ': 'che', 'じぇ': 'je', 'つぁ': 'tsa', 'つぃ': 'tsi',
    'つぇ': 'tse', 'つぉ': 'tso', 'てゅ': 'tyu', 'でゃ': 'dya', 'でょ': 'dyo',
}
# 小書き単独（促音外的）：当普通元音处理
_KANA_SMALL_ALONE = {'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o'}
_KATA_SHIFT = 0x60  # 片假名 → 平假名的 Unicode 偏移


def _to_hiragana(ch: str) -> str:
    """片假名（ァ～ヶ）→ 平假名；其余原样返回。"""
    code = ord(ch)
    if 0x30A1 <= code <= 0x30F6:
        return chr(code - _KATA_SHIFT)
    return ch


def kana_to_romaji(text: str) -> List[str]:
    """假名歌词 → 罗马字拍列表（每个元素对应词典的一个键）。

    规则：2 字组合（拗音/小書き）优先于单字；「っ」促音重复下一拍的第一个辅音字母；
    「ー」长音重复前一拍的尾元音；认不得的字符原样塞进列表（交给上层拒绝/兜底）。
    """
    text = ''.join(_to_hiragana(c) for c in text)
    out: List[str] = []
    i = 0
    while i < len(text):
        if i + 1 < len(text) and text[i:i + 2] in _KANA_COMBO:
            out.append(_KANA_COMBO[text[i:i + 2]])
            i += 2
            continue
        ch = text[i]
        if ch in _KANA_MORA:
            out.append(_KANA_MORA[ch])
        elif ch in _KANA_SMALL_ALONE:
            out.append(_KANA_SMALL_ALONE[ch])
        elif ch == 'っ':  # 促音：重复下一拍首辅音（如 った → t + ta）
            nxt = None
            for j in range(i + 1, len(text)):
                if text[j] in _KANA_MORA:
                    nxt = _KANA_MORA[text[j]]
                    break
            out.append(nxt[0] if nxt else 't')
        elif ch == 'ー':  # 长音：重复前一个拍的尾元音字母
            if out:
                out.append(out[-1][-1])
        else:
            out.append(ch)
        i += 1
    return out


def lang_id_of(phoneme: str, language_ids: Dict[str, int]) -> int:
    """对应 `:421` 的 `GetValueOrDefault(PhonemeLanguage(phoneme), 0)`。"""
    return int(language_ids.get(phoneme_language(phoneme), 0))

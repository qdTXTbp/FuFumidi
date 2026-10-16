# -*- coding: utf-8 -*-
"""假名歌词的日语 g2p 自测。

★ 场景（2026-10-11，liu2_ying2 实测）：日文 DS 声库的 txt 词典键是罗马字
  （ka→k a、si→s i……），假名歌词必须先转拍再查 —— 否则整轨「歌词无法识别」。
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from diffsinger.g2p import kana_to_romaji, load_ds_g2p, get_symbols, _KANA_RE   # noqa: E402


def _build_ja_txt_dict(tmp_path):
    """按 liu2_ying2 的 dictionary-ja.txt 形态造一份迷你词典（罗马字键）。"""
    lines = [
        'cl\tcl', 'a\ta', 'i\ti', 'u\tu', 'e\te', 'o\to', 'n\tN',
        'ka\tk a', 'ki\tk i', 'ku\tk u', 'ke\tk e', 'ko\tk o',
        'sa\ts a', 'si\ts i', 'su\ts u', 'se\ts e', 'so\ts o',
        'ta\tt a', 'ti\tt i', 'tu\tt u', 'te\tt e', 'to\tt o',
        'na\tn a', 'ni\tn i', 'nu\tn u', 'ne\tn e', 'no\tn o',
        'ha\th a', 'hi\th i', 'hu\th u', 'he\th e', 'ho\th o',
        'ma\tm a', 'mi\tm i', 'mu\tm u', 'me\tm e', 'mo\tm o',
        'ya\ty a', 'yu\ty u', 'yo\ty o',
        'ra\tr a', 'ri\tr i', 'ru\tr u', 're\tr e', 'ro\tr o',
        'wa\tw a', 'wo\tw o',
        'ga\tg a', 'gi\tg i', 'gu\tg u', 'ge\tg e', 'go\tg o',
        'za\tz a', 'zi\tz i', 'zu\tz u', 'ze\tz e', 'zo\tz o',
        'da\td a', 'di\td i', 'du\td u', 'de\td e', 'do\td o',
        'ba\tb a', 'bi\tb i', 'bu\tb u', 'be\tb e', 'bo\tb o',
        'pa\tp a', 'pi\tp i', 'pu\tp u', 'pe\tp e', 'po\tp o',
        'ja\tj a', 'ji\tj i', 'ju\tj u', 'jo\tj o',
        'sha\tsh a', 'shu\tsh u', 'sho\tsh o',
        'cha\tch a', 'chu\tch u', 'cho\tch o',
        'tsu\tts u',
        'kya\tky a', 'kyu\tky u', 'kyo\tky o',
        'rya\try a', 'ryu\try u', 'ryo\try o',
    ]
    root = tmp_path / 'vb'
    root.mkdir()
    (root / 'dictionary-ja.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return str(root)


@pytest.fixture()
def ja_g2p(tmp_path):
    g2p, used = load_ds_g2p(_build_ja_txt_dict(tmp_path), 'ja')
    assert used == 'dictionary-ja.txt'
    return g2p


@pytest.fixture()
def ja_tokens(ja_g2p):
    tokens = {}
    for sym, is_vowel in ja_g2p.iter_symbols() if hasattr(ja_g2p, 'iter_symbols') else []:
        tokens[sym] = 0
    return tokens


def test_kana_to_romaji_basic():
    assert kana_to_romaji('い') == ['i']
    assert kana_to_romaji('や') == ['ya']
    assert kana_to_romaji('じゃ') == ['ja']
    assert kana_to_romaji('ありがとう') == ['a', 'ri', 'ga', 'to', 'u']
    assert kana_to_romaji('きょう') == ['kyo', 'u']
    assert kana_to_romaji('った') == ['t', 'ta']       # 促音重复下一拍首辅音
    assert kana_to_romaji('コーヒー') == ['ko', 'o', 'hi', 'i']  # 片假名 + 长音
    assert kana_to_romaji('ファ') == ['fa']             # 片假名小書き


def test_get_symbols_kana_uses_ja_dict(ja_g2p, ja_tokens):
    tokens = {}
    for i, sym in enumerate(['cl', 'a', 'i', 'u', 'e', 'o', 'N', 'k', 's', 't', 'n',
                             'h', 'm', 'y', 'r', 'w', 'g', 'z', 'd', 'b', 'p', 'j',
                             'sh', 'ch', 'ts', 'ky', 'ry']):
        tokens[sym] = i
    raw, rejected = get_symbols(ja_g2p, tokens, 'い', None, 'ja')
    assert raw == ['i'] and not rejected
    raw, rejected = get_symbols(ja_g2p, tokens, 'じゃ', None, 'ja')
    assert raw == ['j', 'a'] and not rejected
    raw, rejected = get_symbols(ja_g2p, tokens, 'ありがとう', None, 'ja')
    assert raw == ['a', 'r', 'i', 'g', 'a', 't', 'o', 'u'] and not rejected


def test_kana_regex():
    assert _KANA_RE.search('いや')
    assert _KANA_RE.search('アイウ')
    assert not _KANA_RE.search('漢字abc')

# -*- coding: utf-8 -*-
r"""歌词输入建议 —— 仿 Synthesizer V2 的「输入即候选」。

## 目标行为

| 输入 | 下方建议（按优先级） |
|---|---|
| `你` | `ni` → `n` → `i` |
| `气声` | `AP` |

## ★ 语言是**轨道级**设置，不由歌词自动判断

与 OpenUtau 一致：语言在**轨道上选**（`UTrack.language`，照搬新版上游的
`USingerTrack.Language`）。同一个多语言声库（`en`/`ja`/`ko`/`zh`）用哪套词典、
哪些音素合法，由轨道决定 —— 本模块的 `language` 参数就是这么传进来的。

★ 所以**不做**「按字符集猜语言」：用户选了 `ja`，输入汉字也不该被猜成 `zh`。

## 候选来源（按优先级排序）

1. **本身是合法音素** —— 直接可用（`zh/n`、`ja/i`、`AP`、`SP`…）
2. **术语表** —— 中文演唱术语 → 音素（气声/呼吸→`AP`、换气/休止→`SP`…）
3. **音节表命中** —— 输入的拼音在词典里有（如 `ni`）
4. **汉字 → 拼音**（`pypinyin`）
5. **拼音 → 声母 / 韵母** 拆分 —— `ni` → `n` + `i`

★ 排序原则：**本身能用的 > 只是拆分片段**。所以 `ni` 排在 `n`/`i` 之前。

## ★ 为什么叫「建议」而不是「纠错」

输入错字时**不静默改写** —— 用户可能故意写 `n` 表示唱 `ni`。
本模块只**给候选**，由用户点选，与 SV2 的交互一致。
"""

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

# ---------------------------------------------------------------- 拼音拆分

#: 声母表 —— ★ **长的在前**（`zh` 先于 `z`），否则 `zhang` 会被拆成 `z`+`hang`
PINYIN_INITIALS: Sequence[str] = (
    'zh', 'ch', 'sh',
    'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
    'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w',
)

#: 韵母表 —— ★ **长的在前**（`ang` 先于 `a`，`ai` 先于 `a`）
PINYIN_FINALS: Sequence[str] = (
    'iang', 'uang', 'iong', 'ueng', 'iang', 'iong',
    'ang', 'eng', 'ing', 'ong',
    'ian', 'uan', 'van', 'iao', 'uai', 'uei', 'iou', 'uen',
    'ai', 'ei', 'ao', 'ou', 'an', 'en',
    'in', 'un', 'vn', 'ia', 'ie', 'ua', 'uo', 'ui', 'iu', 've', 'ue',
    'a', 'o', 'e', 'i', 'u', 'v',
)

#: 整体认读音节 —— 不拆声母韵母
WHOLE_SYLLABLES = frozenset({
    'zhi', 'chi', 'shi', 'ri', 'zi', 'ci', 'si',
    'yi', 'wu', 'yu', 'ye', 'yue', 'yuan', 'yin', 'yun', 'ying',
})


def normalize_pinyin(s: str) -> str:
    """小写 + `ü`→`v`（pypinyin 用 `v` 或 `ü`，两边都要能比）。"""
    return (s or '').strip().lower().replace('ü', 'v')


def split_pinyin(syl: str):
    """拼音音节 → `(声母, 韵母)`；拆不出声母时返回 `(None, 音节)`。"""
    s = normalize_pinyin(syl)
    if not s:
        return None, ''
    if s in WHOLE_SYLLABLES:
        return None, s
    for ini in PINYIN_INITIALS:
        if s.startswith(ini) and len(s) > len(ini):
            rest = s[len(ini):]
            for fin in PINYIN_FINALS:
                if rest == fin:
                    return ini, fin
            return ini, rest
    return None, s


# ---------------------------------------------------------------- 术语表

#: 中文演唱术语 → 可直接用的音素/记号。
#: ★ 只收**语义明确**的，不收有歧义的（避免误导）。
LYRIC_TERMS: Dict[str, Sequence[str]] = {
    '气声': ('AP',),
    '气音': ('AP',),
    '轻声': ('AP',),
    '弱气声': ('AP',),
    '呼吸': ('AP',),
    '换气': ('SP', 'brec'),
    '休止': ('SP',),
    '停顿': ('SP',),
    '静默': ('SP',),
    '耳语': ('brec', 'AP'),
    '沙哑': ('brec',),
    '气音声': ('brec', 'AP'),
    '怒': ('tenc',),
    '哭': ('brec', 'voic'),
    '笑': ('voic',),
    '渐强': ('dyn',),
    '渐弱': ('dyn',),
    '滑音': ('pitd',),
    '颤音': ('pitd',),
    '重音': ('pitd', 'dyn'),
    '高声': ('dyn',),
    '低声': ('dyn',),
}

#: 符号/记号别名（用户可能输入这些来表达音素）
SYMBOL_ALIASES: Dict[str, Sequence[str]] = {
    '-': ('SP',), '_': ('SP',), '.': ('SP',), '、': ('SP',),
    'AP': ('AP',), 'SP': ('SP',), 'SIL': ('SP',), 'PAU': ('SP',),
    'br': ('br',), 'VF': ('vf',),
}

#: 常见误输（`错字 → 正确音素`），只收**确定**的
TYPO_ALIASES: Dict[str, Sequence[str]] = {
    'a': ('AP', 'a'),          # 有人用 a 表示弱唱
    '阿': ('AP', 'a'),
    '啊': ('AP', 'a'),
    '唔': ('AP', 'w'),
    '嗯': ('AP', 'en'),
    '唔嗯': ('AP', 'en'),
}


# ---------------------------------------------------------------- 建议结果

@dataclass
class Suggestion:
    """一条建议。`kind` 供 UI 分组/着色，`score` 供排序。"""

    text: str
    kind: str = 'phoneme'     # phoneme | syllable | initial | final | term | alias
    score: float = 0.0
    note: str = ''

    def as_dict(self) -> dict:
        return {'text': self.text, 'kind': self.kind,
                'score': round(self.score, 3), 'note': self.note}


def _dedup(items: Sequence[Suggestion]) -> List[Suggestion]:
    """按 text 去重，保留**分数最高**的那条。"""
    best: Dict[str, Suggestion] = {}
    for s in items:
        cur = best.get(s.text)
        if cur is None or s.score > cur.score:
            best[s.text] = s
    return sorted(best.values(), key=lambda s: (-s.score, len(s.text), s.text))


def suggest_lyric(text: str, language: str = 'zh',
                  phoneme_tokens: Optional[Dict[str, int]] = None,
                  max_items: int = 12) -> List[Suggestion]:
    """给一条歌词输入返回候选（`language` 由**轨道**决定，不自动判断）。

    `phoneme_tokens` 给了才会启用「是否合法音素」的判定与音素补全
    （`zh/n` 可由裸 `n` 补出）。
    """
    raw = (text or '').strip()
    if not raw:
        return []
    tokens = phoneme_tokens or {}
    out: List[Suggestion] = []

    def is_phoneme(s: str) -> bool:
        return bool(s) and (s in tokens if tokens else s.isascii())

    # ---- 1) 本身已经是合法音素 / 记号
    if is_phoneme(raw):
        out.append(Suggestion(raw, 'phoneme', 100.0, '音素'))
    for alt in SYMBOL_ALIASES.get(raw.lower(), ()):
        if is_phoneme(alt):
            out.append(Suggestion(alt, 'phoneme', 92.0, '记号'))
    for alt in TYPO_ALIASES.get(raw, ()):
        if is_phoneme(alt):
            out.append(Suggestion(alt, 'alias', 84.0, '常见写法'))

    # ---- 2) 术语表（长词优先，避免「气声」被「气」抢走）
    # ★ **精确命中就到此为止**：输入「气声」已经明确表达了术语，
    #   再逐字转拼音给 `qi`/`sheng`/`q`/`sh` 只是噪音（用户不会唱「气声」两个字）。
    term_hit = False
    for term in sorted(LYRIC_TERMS, key=len, reverse=True):
        if raw == term:
            term_hit = True
            for i, cand in enumerate(LYRIC_TERMS[term]):
                if is_phoneme(cand):
                    out.append(Suggestion(cand, 'term', 88.0 - i,
                                          '术语「%s」' % term))
            break
        if len(term) >= 2 and term in raw:
            for i, cand in enumerate(LYRIC_TERMS[term]):
                if is_phoneme(cand):
                    out.append(Suggestion(cand, 'term', 70.0 - i,
                                          '含术语「%s」' % term))
    if term_hit:
        return _dedup(out)[:max_items]

    # ---- 3) 裸音素补前缀（`n` → `zh/n`；语言取自**轨道**）
    if raw and '/' not in raw and raw.lower() not in ('ap', 'sp', 'br', 'vf'):
        prefixed = '%s/%s' % (language, raw)
        if prefixed in tokens:
            # ★ 88 分 > 别名的 84 分：**轨道语言的音素优先于「常见写法」猜测**。
            #   否则输 `a` 会先给 `AP`（typo 别名）而不是 `zh/a`。
            out.append(Suggestion(prefixed, 'phoneme', 88.0,
                                  '%s 语素' % language))
        # 同一条 raw 可能对应多个语种（多语言声库），都给
        if tokens:
            hits = sorted(k for k in tokens
                          if k.endswith('/' + raw) and k.split('/')[0] != language)
            for h in hits[:4]:
                out.append(Suggestion(h, 'phoneme', 64.0, '其它语种'))

    # ---- 4) 汉字 → 拼音
    pinyins: List[str] = []
    if any('぀' <= ch <= 'ヿ' or '一' <= ch <= '鿿'
           for ch in raw):
        for ch in raw:
            p = _hanzi_to_pinyin(ch)
            if p:
                pinyins.append(p)
    # ---- 5) 输入本来就是拼音
    # ★ **已经是合法音素/记号的不要再当拼音拆** —— `SP` 会被拆成 `s`+`p`、
    #   `AP` 拆成 `a`+`p`，全是噪音（实测踩到）。
    if not pinyins and not is_phoneme(raw) and not is_phoneme(raw.lower()):
        if re_pinyin(raw):
            pinyins = [raw]
    if (not pinyins and not is_phoneme(raw) and not is_phoneme(raw.lower())
            and normalize_pinyin(raw) and re_pinyin(normalize_pinyin(raw))):
        # ★ 这条分支也要挡音素 —— 否则 `SP` → `sp` → 拆成 `s`+`p`（实测踩到）
        pinyins = [normalize_pinyin(raw)]

    # ★ **多字只给逐字音节，不给声母/韵母碎片** —— 「你好」的 `n`/`i`/`h`/`ao`
    #   对用户没有意义（他不会把一个词拆成两半唱）；单字才给拆分。
    multi = len(pinyins) > 1
    for syl in pinyins:
        out.append(Suggestion(syl, 'syllable', 76.0, '音节'))
        if multi:
            continue
        ini, fin = split_pinyin(syl)
        if ini:
            out.append(Suggestion(ini, 'initial', 60.0, '声母'))
        if fin and fin != syl:
            out.append(Suggestion(fin, 'final', 56.0, '韵母'))

    return _dedup(out)[:max_items]


def re_pinyin(s: str) -> bool:
    """粗判是否像拼音音节（用于区分「拼音」与「其它」）。"""
    s = normalize_pinyin(s)
    if not s or not s.isascii() or not s.isalpha():
        return False
    if s in WHOLE_SYLLABLES:
        return True
    return any(s.startswith(i) for i in PINYIN_INITIALS) or s in tuple(
        normalize_pinyin(x) for x in 'aeiouv')


def _hanzi_to_pinyin(ch: str) -> Optional[str]:
    """单字 → 无声调拼音（`pypinyin`；缺库时返回 None）。

    ★ 缺 `pypinyin` 时**不报错**、返回 None —— 候选里就没有拼音项，
      其余候选（音素/术语/拆分）照常给。
    """
    try:
        from singing.openutau.base_chinese import hanzi_to_pinyin
        return normalize_pinyin(hanzi_to_pinyin(ch)) or None
    except Exception:  # noqa: BLE001
        return None

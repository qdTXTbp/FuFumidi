# -*- coding: utf-8 -*-
"""歌词输入建议的验收（仿 SV2 的「输入即候选」）。

★ 两条**硬性**期望（用户给的例子）：
    输入 `你`   → 建议含 ni、n、i（按此顺序）
    输入 `气声` → 建议含 AP
★ 以及一条**设计约束**：语言由**轨道**决定（`language` 参数），不从歌词自动判断。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


def texts(items):
    return [x.text for x in items]


def main():
    from diffsinger import suggest as SG

    tokens = {'zh/n': 1, 'zh/i': 2, 'zh/a': 3, 'AP': 4, 'SP': 5,
              'ja/i': 6, 'ja/a': 7, 'en/n': 8, 'ko/n': 9,
              'ko/a': 10}

    print('--- ★ 用户给的第一个例子：输入「你」---')
    r = SG.suggest_lyric('你', 'zh', tokens)
    t = texts(r)
    check('  建议含 ni / n / i', {'ni', 'n', 'i'} <= set(t), t)
    check('  ★ 顺序是 ni → n → i（整音节优先于拆分片段）',
          t[:3] == ['ni', 'n', 'i'], t[:4])
    check('  ni 标为 syllable、n 为 initial、i 为 final',
          (r[0].kind, r[1].kind, r[2].kind) == ('syllable', 'initial', 'final'),
          [(x.text, x.kind) for x in r[:3]])

    print()
    print('--- ★ 用户给的第二个例子：输入「气声」---')
    r2 = SG.suggest_lyric('气声', 'zh', tokens)
    t2 = texts(r2)
    check('  建议含 AP', 'AP' in t2, t2)
    check('  ★ AP 排第一', t2 and t2[0] == 'AP', t2)
    check('  ★ AP 标为 term（术语）', r2[0].kind == 'term', r2[0].kind)
    check('  ★ 精确命中术语后不给逐字拼音噪音（无 qi/sheng/q/sh）',
          not ({'qi', 'sheng', 'q', 'sh'} & set(t2)), t2)

    print()
    print('--- 其它术语 ---')
    for term, want in (('耳语', 'AP'), ('换气', 'SP'), ('休止', 'SP'),
                       ('轻声', 'AP'), ('呼吸', 'AP')):
        got = texts(SG.suggest_lyric(term, 'zh', tokens))
        check('  %-4s → %s（排第一）' % (term, want), got and got[0] == want, got)

    print()
    print('--- ★ 语言由轨道决定，不从歌词自动判断 ---')
    zh = texts(SG.suggest_lyric('n', 'zh', tokens))
    ja = texts(SG.suggest_lyric('n', 'ja', tokens))
    ko = texts(SG.suggest_lyric('n', 'ko', tokens))
    check('  同一输入「n」，轨道=zh → zh/n 排第一', zh and zh[0] == 'zh/n', zh)
    # ★ 该声库的 ja/ko 词典里**没有 n 音素**，所以 ja/n 不该被编造出来 ——
    #   正确行为是回落到其它语种的同名音素。这本身就是一条判据。
    check('  轨道=ja 且 ja/n 不存在 → 不编造 ja/n', 'ja/n' not in ja, ja)
    check('  轨道=ja 时仍给出存在的同名音素（en/n / ko/n）',
          any(x.startswith(('en/', 'ko/')) for x in ja), ja)
    check('  轨道=zh 与 ja 的首选不同（确实按轨道语言走）', zh[0] != ja[0], (zh[0], ja[0]))
    # 用一个三语都有的音素验证「首选随轨道变」
    a_zh = texts(SG.suggest_lyric('a', 'zh', tokens))
    a_ja = texts(SG.suggest_lyric('a', 'ja', tokens))
    a_ko = texts(SG.suggest_lyric('a', 'ko', tokens))
    check('  轨道=zh → zh/a 首选', a_zh and a_zh[0] == 'zh/a', a_zh)
    check('  轨道=ja → ja/a 首选', a_ja and a_ja[0] == 'ja/a', a_ja)
    check('  轨道=ko → ko/a 首选', a_ko and a_ko[0] == 'ko/a', a_ko)

    print()
    print('--- 已经是合法音素时不该乱猜 ---')
    for q in ('zh/n', 'AP', 'SP'):
        got = texts(SG.suggest_lyric(q, 'zh', tokens))
        check('  %-6s → 只有它自己' % q, got == [q], got)

    print()
    print('--- 拼音拆分表（长的在前）---')
    # ★ `xue` 的韵母是 **üe（写作 ue）**；`ve` 是**单韵母** ü 的写法，两者不同。
    #   加 `ue` 到韵母表就是为了让它拆得出来（之前 `xue` 拆不出韵母）。
    for syl, ini, fin in (('zhang', 'zh', 'ang'), ('shi', None, 'shi'),
                           ('ni', 'n', 'i'), ('jiao', 'j', 'iao'),
                           ('xue', 'x', 'ue'), ('nue', 'n', 'ue'),
                           ('zi', None, 'zi'), ('liu', 'l', 'iu')):
        got = SG.split_pinyin(syl)
        check('  %-6s → %-4s + %-5s' % (syl, ini, fin), got == (ini, fin), got)
    check('  整体认读不拆（shi/zi/yi）',
          SG.split_pinyin('shi')[0] is None and SG.split_pinyin('yi')[0] is None)
    check('  ü 与 v 等价（lüe → l + ve）', SG.split_pinyin('lüe') == ('l', 've'),
          SG.split_pinyin('lüe'))

    print()
    print('--- 多字：只给逐字音节，不给碎片 ---')
    r3 = SG.suggest_lyric('你好', 'zh', tokens)
    t3 = texts(r3)
    check('  你好 → ni + hao', t3[:2] == ['ni', 'hao'], t3)
    check('  ★ 不给 n / i / h / ao 碎片', not ({'n', 'i', 'h', 'ao'} & set(t3)), t3)

    print()
    print('--- 单字拼音给拆分 ---')
    t4 = texts(SG.suggest_lyric('zhang', 'zh', tokens))
    check('  zhang → zhang / zh / ang', t4[:3] == ['zhang', 'zh', 'ang'], t4)

    print()
    print('--- 边界 ---')
    check('  空输入 → 空列表', SG.suggest_lyric('', 'zh', tokens) == [])
    check('  纯空格 → 空列表', SG.suggest_lyric('   ', 'zh', tokens) == [])
    t5 = texts(SG.suggest_lyric('n', 'zh', tokens, max_items=2))
    check('  max_items 生效', len(t5) <= 2, t5)
    check('  无音素表时也能给（只用形状判断）',
          len(SG.suggest_lyric('ni', 'zh', {}, 6)) >= 1,
          texts(SG.suggest_lyric('ni', 'zh', {}, 6)))
    check('  候选无重复', len(set(texts(SG.suggest_lyric('你', 'zh', tokens)))) ==
          len(texts(SG.suggest_lyric('你', 'zh', tokens))))

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())

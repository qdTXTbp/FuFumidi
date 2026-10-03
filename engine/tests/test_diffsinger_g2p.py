# -*- coding: utf-8 -*-
"""`diffsinger/voicebank.py` + `diffsinger/g2p.py` 的验收（P1）。

重点验证旧实现最严重的那个 bug 已修掉：
**歌词 `n`/`i`/`h` 之前被音素化成 `ko/n`/`ko/i`/`ko/h`**（裸名兜底按字母序
命中 `ko/*`），对齐上游后必须是 `zh/n`/`zh/i`/`zh/h`。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from diffsinger import g2p as G, voicebank as V   # noqa: E402
from diffsinger import RenderError                 # noqa: E402

_P, _F = [], []

BANK = os.environ.get('DIFFSINGER_TEST_BANK') or \
    r'C:\Users\26276\Downloads\Compressed\liu2_ying2'


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def main():
    if not os.path.isdir(BANK):
        print('跳过：找不到声库 %s（设 DIFFSINGER_TEST_BANK 指向一个 DiffSinger 声库）' % BANK)
        return 0

    # ---------------- 1. 声库探测
    print('--- 声库探测 ---')
    singer = V.load_singer(BANK)
    check('dsdur/dsconfig.yaml 读到', singer.dur.root.endswith('dsdur'), singer.dur.root)
    check('★ A 层 frame_ms 来自 dsdur（%.6f ms）' % singer.dur.frame_ms,
          abs(singer.dur.frame_ms - 11.609977) < 1e-3, singer.dur.frame_ms)
    check('★ B 层 frame_ms 来自 vocoder（%.6f ms）' % singer.vocoder.frame_ms,
          abs(singer.vocoder.frame_ms - 11.609977) < 1e-3, singer.vocoder.frame_ms)
    check('音素表 189 条（.json 取值，不是行号）', len(singer.phoneme_tokens) == 189,
          len(singer.phoneme_tokens))
    check('  zh/n 的 token id 来自 JSON', singer.phoneme_tokens.get('zh/n') == 163,
          singer.phoneme_tokens.get('zh/n'))
    check('  SP=2 / AP=1', singer.phoneme_tokens.get('SP') == 2
          and singer.phoneme_tokens.get('AP') == 1,
          (singer.phoneme_tokens.get('SP'), singer.phoneme_tokens.get('AP')))
    check('use_lang_id=false → 不读语言表', singer.language_ids == {},
          singer.language_ids)
    check('声学配置 mel_base=%s vocoder mel_base=%s'
          % (singer.acoustic.mel_base, singer.vocoder.mel_base),
          singer.acoustic.mel_base == singer.vocoder.mel_base)
    check('★ max_depth 换算（contAcc=true → 0.6 原值）',
          abs(singer.acoustic.max_depth - 0.6) < 1e-9, singer.acoustic.max_depth)
    check('  use_energy_embed=false（所以不喂 energy）',
          singer.acoustic.use_energy_embed is False)
    check('  use_breathiness/voicing/tension_embed=true',
          singer.acoustic.use_breathiness_embed
          and singer.acoustic.use_voicing_embed
          and singer.acoustic.use_tension_embed)
    check('声码器来自声库自带 dsvocoder/',
          'dsvocoder' in singer.vocoder.root, singer.vocoder.root)
    check('pitch_controllable 来自 vocoder.yaml',
          isinstance(singer.vocoder.pitch_controllable, bool),
          singer.vocoder.pitch_controllable)
    for which in ('linguistic', 'dur', 'acoustic', 'vocoder'):
        p = singer.model(which)
        check('  模型 %s 存在' % which, os.path.isfile(p), p)

    # ---------------- 2. 缺 dsdur 必须抛
    print('--- 缺 dsdur 时报错（对齐上游 :160-164）---')
    import tempfile
    tmp = tempfile.mkdtemp(prefix='fufumidi-nodur-')
    try:
        raised = False
        try:
            V.load_ds_dur(tmp)
        except RenderError as e:
            raised = 'dsdur' in str(e)
        check('★ 缺 dsdur/ → RenderError 且提到 dsdur', raised)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    # ---------------- 3. 词典
    print('--- 词典加载（dsdict-zh.yaml 优先）---')
    warn: list = []
    d, name = G.load_ds_g2p(singer.dur.root, 'zh', warn)
    check('实际用的词典是 dsdict-zh.yaml', name == 'dsdict-zh.yaml', name)
    check('★ 没有降级告警（YAML 命中）', not warn, warn)
    check('★ 解析出非 0 条目（旧实现是 0）', d.query('ao') == ['zh/ao'], d.query('ao'))
    check('  SP/AP 强制为 vowel',
          d.is_vowel('SP') and d.is_vowel('AP'))
    check('  zh/i 是 vowel、zh/n 不是', d.is_vowel('zh/i') and not d.is_vowel('zh/n'))
    check('  is_glide 存在（本声库无半元音，全 False）',
          d.is_glide('zh/y') is False)

    # ---------------- 4. ★ 关键修复：n → zh/n（不是 ko/n）
    print('--- ★ 关键：歌词 n/i/h/ao 的音素化 ---')
    tokens = singer.phoneme_tokens
    for lyric, want in (('n', ['zh/n']), ('i', ['zh/i']),
                        ('h', ['zh/h']), ('ao', ['zh/ao'])):
        syms, rej = G.get_symbols(d, tokens, lyric, None, 'zh')
        check('get_symbols(%r) == %r' % (lyric, want), syms == want,
              'got=%r rejected=%r' % (syms, rej))
        check('  ★ 不是 ko/%s' % lyric, not any(s.startswith('ko/') for s in syms), syms)

    # ---------------- 5. ValidatePhoneme 的前缀兜底
    print('--- ValidatePhoneme（只加一次 lang 前缀）---')
    check('zh/n 已合法 → 原样返回',
          G.validate_phoneme(d, tokens, 'zh/n', 'zh') == 'zh/n')
    check('★ 裸 n → 加 zh/ 前缀',
          G.validate_phoneme(d, tokens, 'n', 'zh') == 'zh/n')
    check('★ 裸 o → 加 zh/ 前缀',
          G.validate_phoneme(d, tokens, 'o', 'zh') == 'zh/o')
    check('★ 非法符号 → 空串（不是 None、也不猜）',
          G.validate_phoneme(d, tokens, 'zzz', 'zh') == '',
          G.validate_phoneme(d, tokens, 'zzz', 'zh'))
    check('★ 不猜裸名：zzz 不会变成 en/zzz 之类',
          G.validate_phoneme(d, tokens, 'zzz', 'zh') == '')

    # ---------------- 6. phoneticHint 优先
    print('--- phoneticHint 优先级 ---')
    syms, rej = G.get_symbols(d, tokens, 'n', 'zh/n', 'zh')
    check('phoneticHint 优先于词典', syms == ['zh/n'], syms)
    syms, rej = G.get_symbols(d, tokens, 'zzz', 'zh/a zh/i', 'zh')
    check('phoneticHint 空格切分成多音素', syms == ['zh/a', 'zh/i'], syms)
    syms, rej = G.get_symbols(d, tokens, 'a b c', None, 'zh')
    check('★ 歌词本身当 hint 逐个校验（3 个音素）', syms == ['zh/a', 'zh/b', 'zh/c'],
          'got=%r rejected=%r' % (syms, rej))
    syms, rej = G.get_symbols(d, tokens, 'qqq', None, 'zh')
    check('★ 全部非法 → 空列表（交给上层退 SP）', syms == [], syms)

    # ---------------- 7. 汉字 → 拼音（复用）
    print('--- 汉字 romanize（复用 BaseChinesePhonemizer）---')
    # ★ 依赖 pypinyin。**随包的 resources/python 里没装**（只在系统 python 里有），
    #   所以打包后的应用走不了汉字路径 —— 见 memory 里记录的那个缺口。
    try:
        import pypinyin  # noqa: F401
        has_pinyin = True
    except ImportError:
        has_pinyin = False
    got = G.romanize(['你', '好'])
    if has_pinyin:
        check('romanize(你好) == [ni, hao]', got == ['ni', 'hao'], got)
    else:
        print('  SKIP romanize：当前 python 没装 pypinyin'
              '（★ 随包 python 缺这个依赖，打包后汉字歌词无法转拼音）')
        check('romanize 在无 pypinyin 时原样返回（不崩）', got == ['你', '好'], got)

    # ---------------- 8. 语言 id
    print('--- 语言 id ---')
    check('lang_id_of("zh/n") 在空表时为 0', G.lang_id_of('zh/n', {}) == 0)
    check('lang_id_of("n") 在表里有值时取到',
          G.lang_id_of('zh/n', {'zh': 4}) == 4)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())

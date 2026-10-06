# -*- coding: utf-8 -*-
r"""多语声库（`use_lang_id: true`，如 Ria）的 `languages` 输入。

上游（OpenUTAU master）在**四处**喂 `languages`，形状都等于 `tokens`（`[1, n]`）：

| 阶段 | 上游位置 | 取值 | 语言表 |
|---|---|---|---|
| dsdur linguistic | `DiffSingerBasePhonemizer.cs:417-425` | 逐音素 `p.Language()`（符号前缀） | `dsdur/dsconfig.yaml` |
| acoustic | `DiffSingerRenderer.cs:312-321` | `PaddedLanguageIds`（head/tail/间隙 SP 硬编码 0） | 根 `dsconfig.yaml`（`DiffSingerSinger.cs:130-137`） |
| dsvariance linguistic | `DiffSingerVariance.cs:161-169` | `PaddedLanguageIds` | `dsvariance/dsconfig.yaml` |
| dspitch linguistic | `DiffSingerPitch.cs:150-158` | `PaddedLanguageIds` | `dspitch/dsconfig.yaml` |

★ 两处都**只在 `use_lang_id` 为真时**加这个输入 —— `Onnx.VerifyInputNames`
是双向严格的：单语声库（花火/空/芙宁娜）多给一个 `languages` 会直接抛「多余」。

★ 本测试同时锁住一个**真实**约束：Ria 的 `fs2.lang_embed.weight` 是 `[4, 256]`
—— 合法语言 id 只有 0..3，和 `languages.json` 的 `ja=1/yue=2/zh=3` 对得上，
0 是给无前缀音素（SP/AP/CL）和填充段留的槽。
"""
import os
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from diffsinger import RenderError                                  # noqa: E402
from diffsinger import voicebank as V                               # noqa: E402
from diffsinger.g2p import lang_id_of                               # noqa: E402
from diffsinger.phonemizer import build_linguistic_inputs           # noqa: E402

_P, _F = [], []

#: 多语声库（installed 数据目录；没有就跳过真实渲染那段）
MULTI = os.environ.get('DS_TEST_MULTILANG_BANK') or \
    r'E:\Midi\FuFumidi\FuFumidiData\diffsinger-voicebanks\Ria'
#: 单语声库（用来证明**不会**多喂 languages）
MONO = os.environ.get('DS_TEST_MONO_BANK') or \
    r'E:\Midi\FuFumidi\FuFumidiData\diffsinger-voicebanks\花火'
VOC = os.environ.get('DS_TEST_VOCODER') or \
    r'E:\Midi\FuFumidi\FuFumidiData\diffsinger\vocoder\nsf_hifigan_44.1k_hop512_128bin_2024.02.onnx'


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _fake_cfg(root, languages=None, use_lang_id=True, with_path=False):
    """造一个阶段配置：dsdur/acoustic 有 `path()`，dsvariance/dspitch 只有 `model()`。"""
    cfg = types.SimpleNamespace(root=root, languages=languages, use_lang_id=use_lang_id)
    if with_path:
        cfg.path = lambda *parts: os.path.join(root, *parts)
    return cfg


def _write_langs(d, name, mapping):
    import json
    p = os.path.join(d, name)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(mapping, f)
    return p


def case_loaders():
    print('--- ① 语言表读取（两种配置风格）---')
    d = tempfile.mkdtemp(prefix='ds-lang-')
    _write_langs(d, 'dur.languages.json', {'ja': 1, 'yue': 2, 'zh': 3})
    _write_langs(d, 'vari.languages.json', {'zh': 9})

    dur = _fake_cfg(d, 'dur.languages.json', True, with_path=True)
    var = _fake_cfg(d, 'vari.languages.json', True, with_path=False)
    check('dsdur 风格（有 path()）读到 {ja:1,yue:2,zh:3}',
          V.load_language_ids(dur) == {'ja': 1, 'yue': 2, 'zh': 3},
          V.load_language_ids(dur))
    check('dsvariance 风格（只有 model()/root）也能读到',
          V.load_language_ids(var) == {'zh': 9}, V.load_language_ids(var))
    check('use_lang_id=false → 不读文件，返回 {}',
          V.load_language_ids(_fake_cfg(d, 'nope.json', False, True)) == {})
    check('use_lang_id=true 但文件缺失 → 抛 RenderError',
          _raises(lambda: V.load_language_ids(_fake_cfg(d, 'missing.json', True, True)),
                  RenderError))

    print('--- ② stage_language_ids（按阶段取，单语不读）---')
    aco = _fake_cfg(d, 'dur.languages.json', True, with_path=True)
    check('第一个 use_lang_id=true 的表被选中',
          V.stage_language_ids(aco, dur) == {'ja': 1, 'yue': 2, 'zh': 3})
    check('★ 全部 use_lang_id=false → 空表（模型也没有 languages 输入）',
          V.stage_language_ids(_fake_cfg(d, 'dur.languages.json', False, True)) == {})
    check('None 配置被跳过', V.stage_language_ids(None, aco) == {'ja': 1, 'yue': 2, 'zh': 3})


def _raises(fn, exc):
    try:
        fn()
    except exc:
        return True
    except Exception:  # noqa: BLE001
        return False
    return False


def case_linguistic_inputs():
    print('--- ③ dsdur linguistic 的 languages（逐音素，符号前缀）---')
    ids = {'ja': 1, 'yue': 2, 'zh': 3}
    # 上游：phrasePhonemes.SelectMany(n => n.Phonemes).Select(p => p.Language())
    symbols = ['SP', 'zh/n', 'zh/i', 'AP', 'zh/h', 'zh/ao', 'SP']
    langs = [lang_id_of(s, ids) for s in symbols]
    check('无前缀 → 0，zh/* → 3', langs == [0, 3, 3, 0, 3, 3, 0], langs)

    multi = types.SimpleNamespace(dur=types.SimpleNamespace(use_lang_id=True))
    mono = types.SimpleNamespace(dur=types.SimpleNamespace(use_lang_id=False))
    feeds = build_linguistic_inputs(multi, list(range(7)), [3, 3, 1], [1, 2, 3], langs)
    check('★ use_lang_id=true → 有 languages', 'languages' in feeds,
          sorted(feeds))
    check('  形状 [1, n] 且与 tokens 等长',
          tuple(feeds['languages'].shape) == (1, 7), feeds['languages'].shape)
    check('  dtype=int64（上游 DenseTensor<Int64>）',
          str(feeds['languages'].dtype) == 'int64', feeds['languages'].dtype)
    check('  值正确', list(feeds['languages'][0]) == langs,
          list(feeds['languages'][0]))

    mono_feeds = build_linguistic_inputs(mono, [1, 2], [1], [1], [0, 0])
    check('★ use_lang_id=false → 绝不出现 languages（多给会被 VerifyInputNames 抛）',
          'languages' not in mono_feeds, sorted(mono_feeds))
    check('  但传了也不报错（忽略）',
          'languages' not in build_linguistic_inputs(mono, [1], [1], [1]))
    check('★ 多语声库漏传 languages → 抛 RenderError（不再静默渲错）',
          _raises(lambda: build_linguistic_inputs(multi, [1, 2], [1], [1]), RenderError))
    check('★ 长度不等 → 抛 RenderError',
          _raises(lambda: build_linguistic_inputs(multi, [1, 2], [1], [1], [0]),
                  RenderError))


def case_real_banks():
    print('--- ④ 真实声库的语言表 ---')
    if not os.path.isdir(MULTI):
        print('  SKIP 找不到多语声库：%s' % MULTI)
        return
    singer = V.load_singer(MULTI, VOC if os.path.isfile(VOC) else None)
    check('Ria: dsdur 语言表 ja=1/yue=2/zh=3',
          singer.language_ids == {'ja': 1, 'yue': 2, 'zh': 3}, singer.language_ids)
    check('★ Ria: 声学侧语言表来自**根** dsconfig',
          singer.acoustic_language_ids == {'ja': 1, 'yue': 2, 'zh': 3},
          singer.acoustic_language_ids)
    check('Ria: 音素表带语言前缀（zh/aa 与 ja/aa 同 id）',
          singer.phoneme_tokens.get('zh/aa') == singer.phoneme_tokens.get('ja/aa'),
          (singer.phoneme_tokens.get('zh/aa'), singer.phoneme_tokens.get('ja/aa')))
    check('Ria: 无前缀的 SP 也有 id（不属于任何语言）',
          'SP' in singer.phoneme_tokens and lang_id_of('SP', singer.language_ids) == 0)

    if os.path.isdir(MONO):
        m = V.load_singer(MONO)
        check('花火: use_lang_id=false → 两张表都是空（不喂 languages）',
              m.language_ids == {} and m.acoustic_language_ids == {},
              (m.language_ids, m.acoustic_language_ids))
    else:
        print('  SKIP 单语声库对照：%s' % MONO)


def case_real_render():
    print('--- ⑤ Ria 端到端渲染 + 抓取各阶段真实输入 ---')
    if not os.path.isdir(MULTI):
        print('  SKIP 找不到多语声库：%s' % MULTI)
        return
    import numpy as np
    from diffsinger import session as S
    from diffsinger import pipeline as P

    seen = []
    orig = S.run_session

    def spy(model_path, feeds, providers, label, identifier=None, cache_dir=None):
        seen.append((label, {k: np.asarray(v) for k, v in feeds.items()}))
        # ★ 不带 cache_dir：避免命中旧缓存后看不到真正的输入
        return orig(model_path, feeds, providers, label, identifier, None)

    S.run_session = spy
    try:
        cfg = {'voicebank': MULTI, 'language': 'zh', 'bpm': 120, 'device': 'cpu',
               'vocoder': VOC if os.path.isfile(VOC) else None,
               'notes': [{'startBeat': 0, 'durBeat': 1, 'pitch': 60, 'lyric': 'ni'},
                         {'startBeat': 1, 'durBeat': 1, 'pitch': 62, 'lyric': 'hao'}]}
        r = P.render_phrase(cfg)
    finally:
        S.run_session = orig

    s = r['wav']
    peak = float(max(abs(float(x)) for x in s)) if len(s) else 0.0
    check('★ Ria 渲染成功（此前直接抛「尚未实现」）', r.get('ok') and len(s) > 0,
          r.get('warnings'))
    check('  有声且不削顶（peak=%.3f）' % peak, 0.01 < peak < 0.99, peak)
    check('  时长合理（2 拍 @120BPM = 1s + 首尾 padding）',
          0.9 <= r['duration_ms'] / 1000.0 <= 2.0,
          r['duration_ms'])

    by_label = {}
    for label, feeds in seen:
        by_label.setdefault(label, []).append(feeds)
    stages = [lab for lab, _ in seen]
    check('  四个阶段都跑了：%s' % stages,
          all(x in stages for x in ('dsdur linguistic', 'dsvariance linguistic',
                                    'acoustic', 'vocoder')), stages)

    for label in ('dsdur linguistic', 'dsvariance linguistic', 'acoustic'):
        got = by_label.get(label) or [{}]
        f = got[0]
        if 'languages' not in f:
            check('★ %s 收到 languages' % label, False, sorted(f))
            continue
        vals = set(int(v) for v in np.asarray(f['languages']).reshape(-1))
        check('★ %s 收到 languages（值域 %s）' % (label, sorted(vals)),
              vals == {0, 3}, vals)
        check('  %s 的 languages 与 tokens 等长' % label,
              np.asarray(f['languages']).shape == np.asarray(f['tokens']).shape,
              (np.asarray(f['languages']).shape, np.asarray(f['tokens']).shape))

    voc = by_label.get('vocoder') or [{}]
    check('  vocoder 不喂 languages（上游也不喂）',
          'languages' not in voc[0], sorted(voc[0]))


def main():
    case_loaders()
    print()
    case_linguistic_inputs()
    print()
    case_real_banks()
    print()
    case_real_render()
    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


# ★ 真正被 pytest 强制的那一条：所有判据都走 check()，失败就非 0。
#   （本文件其余部分是 case_*，只由 main() 串起来，避免 pytest 重复收集。）
def test_diffsinger_multilang():
    assert main() == 0


if __name__ == '__main__':
    sys.exit(main())
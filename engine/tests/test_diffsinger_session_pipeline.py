# -*- coding: utf-8 -*-
r"""把 notes 接进 M1–M6 管线的验收（**真实声库 + 真实对象**，不是替身）。

★ 这一层此前是缺的：`singing/openutau/diffsinger/` 里的 M1–M6 从没被 CLI 调通过，
  前端一直走旧的 `diffsinger.pipeline`（**无乐句缓存**）。

本测试要证的四件事：
  1. `notes → UProject/UTrack/UVoicePart` 的桥能建出**能被 PhraseSource 吃下**的对象
  2. 音素化产出 **canonical** 形状（补 `error`/`parent`，A 层不产出这两个）
  3. 走的是**真实** `PhraseSource.from_part` → `build_phrases` → `render_requests`
  4. **乐句 wav 缓存生效**（第二遍显著更快，且缓存文件名符合渲染器规则）

★ 为什么不用替身 phrase：那只能验时序，验不出「管线真的接通了」。
  早先 `test_diffsinger_real_project.py` 就是替身版，本测试补上真实版。
"""
import asyncio
import glob
import os
import re
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BANK = os.environ.get(
    'DS_TEST_BANK',
    r'C:\Users\26276\Downloads\Compressed\liu2_ying2')

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


def main():
    if not os.path.isdir(BANK):
        print('  SKIP 声库不存在：%s（设 DS_TEST_BANK 指向一个多语言声库）' % BANK)
        return 0

    from singing.openutau.diffsinger.session import (SingerAdapter, build_project,
                                                     phonemize, render_notes)
    from diffsinger import voicebank as VB

    notes = [
        {'startBeat': 0, 'durBeat': 1, 'pitch': 60, 'lyric': 'ni'},
        {'startBeat': 1, 'durBeat': 1, 'pitch': 62, 'lyric': 'hao'},
    ]

    print('--- ① notes → 工程对象 ---')
    proj, track, part = build_project(notes, 120, 'zh')
    check('  resolution 恒 480（只读属性，不能赋值）', proj.resolution == 480, proj.resolution)
    check('  拍 → tick（1 拍 = 480）', [n.position for n in part.notes] == [0, 480],
          [n.position for n in part.notes])
    check('  时长也按 tick', [n.duration for n in part.notes] == [480, 480],
          [n.duration for n in part.notes])
    check('  轨道带语言（轨道级属性）', track.language == 'zh', track.language)
    check('  renderer 名为 DIFFSINGER', track.renderer_settings.renderer == 'DIFFSINGER')

    print()
    print('--- ② 颤音：必须建成 UVibrato 对象而不是 int ---')
    n2 = dict(notes[0]); n2['vibrato'] = True; n2['vibDepth'] = 40; n2['vibFreq'] = 5.0
    _p, _t, p2 = build_project([n2], 120, 'zh')
    v = p2.notes[0].vibrato
    check('★ vibrato 是对象（有 .length）', v is not None and hasattr(v, 'length'),
          type(v).__name__)
    check('  period = 1000/Hz ≈ 200ms', v is not None and 195 <= v.period <= 205,
          getattr(v, 'period', None))
    check('  不颤时为 None（`VibratoSource.of` 据此跳过）',
          build_project([notes[0]], 120, 'zh')[2].notes[0].vibrato is None)

    print()
    print('--- ③ singer 适配成上游 USinger 接口 ---')
    singer = SingerAdapter(VB.load_singer(BANK))
    for f in ('subbanks', 'has_found', 'is_loaded', 'frqs'):
        check('  有 %s' % f, hasattr(singer, f))
    check('  try_get_oto 返回 (False, None)（DS 无 oto）',
          singer.try_get_oto('anything') == (False, None))
    check('  其余属性代理到 DS 声库（dur 在）', hasattr(singer, 'dur'))
    check('  id 用目录', isinstance(singer.id, str) and BANK.split(os.sep)[-1] in singer.id,
          singer.id)

    print()
    print('--- ④ 音素化产出 canonical 形状 ---')
    _p3, _t3, p3 = build_project(notes, 120, 'zh')
    n_ph = phonemize(p3, singer, _p3, track=_t3, language='zh')
    check('  出了音素', n_ph > 0, n_ph)
    check('★ 每个音素都有 .error（A 层不产出，由适配补）',
          all(hasattr(x, 'error') for x in p3.phonemes))
    check('★ 每个音素都有 .parent（指向所属音符）',
          all(hasattr(x, 'parent') for x in p3.phonemes))
    check('  parent 都解析到了真实音符（不是 None）',
          all(x.parent is not None for x in p3.phonemes),
          [(x.phoneme, x.parent) for x in p3.phonemes])
    check('  parent 是 part.notes 里的对象',
          all(any(x.parent is nn for nn in p3.notes) for x in p3.phonemes))
    check('  有 .end 派生量（from_part 用它切句）',
          all(isinstance(x.end, int) for x in p3.phonemes))
    check('  音素名带语言前缀', all('/' in x.phoneme for x in p3.phonemes),
          [x.phoneme for x in p3.phonemes])

    print()
    print('--- ⑤ 音符前链（PhraseSource 的前置条件）---')
    check('  prev/next 已铺好', p3.notes[0].next is p3.notes[1]
          and p3.notes[1].prev is p3.notes[0])
    check('  extends 已判定（本用例无延音 → None）', p3.notes[0].extends is None)
    check('  extended_duration 已填', p3.notes[0].extended_duration == 480)

    print()
    print('--- ⑥ 端到端渲染 + ★ 缓存生效 ---')
    cache = tempfile.mkdtemp(prefix='fufumidi-m1m6-')

    def run():
        t0 = time.time()
        r = asyncio.run(render_notes(notes, BANK, bpm=120, language='zh',
                                     cache_dir=cache))
        return time.time() - t0, r

    t1, r1 = run()
    check('  第 1 遍成功', r1.get('ok'), r1.get('error'))
    if not r1.get('ok'):
        print('  （渲染失败，后续判据跳过）')
        print('\n结果: %d passed, %d failed' % (len(_P), len(_F)))
        return 1
    check('  出了乐句', r1['phrases'] >= 1, r1['phrases'])
    check('  采样非空', len(r1['samples']) > 0, len(r1['samples']))
    check('  时长合理（2 拍 ≈ 1s）', 0.5 <= r1['duration_ms'] / 1000 <= 3.0,
          r1['duration_ms'])
    s = r1['samples']
    peak = float(max(abs(x) for x in s))
    check('  峰值在合理区间（有声，不削顶）', 0.01 < peak < 0.99, peak)

    files = glob.glob(os.path.join(cache, 'ds-*.wav'))
    check('★ 生成了乐句缓存文件', len(files) >= 1, files)
    check('★ 缓存文件名符合渲染器规则（ds-<16hex>-depth1.00-steps20.wav）',
          all(re.match(r'^ds-[0-9a-f]{16}-depth\d+\.\d{2}-steps\d+\.wav$',
                       os.path.basename(f)) for f in files),
          [os.path.basename(f) for f in files])

    t2, r2 = run()
    check('  第 2 遍成功', r2.get('ok'), r2.get('error'))
    check('★ 第 2 遍命中缓存（更快）', t2 < t1,
          '第1遍 %.1fs → 第2遍 %.1fs' % (t1, t2))
    check('  两遍结果长度一致', len(r2['samples']) == len(r1['samples']),
          (len(r1['samples']), len(r2['samples'])))

    print()
    print('--- ⑦ 边界 ---')
    r3 = asyncio.run(render_notes([], BANK))
    check('  空 notes → 明确报错（不抛异常）',
          r3.get('ok') is False and '音符' in str(r3.get('error')), r3.get('error'))
    r4 = asyncio.run(render_notes(notes, os.path.join(BANK, '__nope__')))
    check('  坏声库路径 → 明确报错',
          r4.get('ok') is False and r4.get('error'), r4.get('error'))
    r5 = asyncio.run(render_notes(
        [{'startBeat': 0, 'durBeat': 1, 'pitch': 60, 'lyric': 'zzz'}], BANK))
    check('  无效歌词 → 不崩（要么报错要么出声）',
          isinstance(r5.get('ok'), bool), r5.get('error'))

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())

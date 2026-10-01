# -*- coding: utf-8 -*-
"""singing 抽象层的对照测试（M1）。

M1 的验收标准是「**行为不变**」，所以这里不测「结果好不好听」，只测：
  1. 适配器的输出与**直接调用原函数**逐位一致（UTAU：`render_track`）；
  2. 音素化器读出来的字段与 oto.ini 原值一致；
  3. 注册表可解析、未知名字报错、未接的渲染器明确抛 NotImplementedError；
  4. DiffSinger 音素化在**有真实声库时**能跑出非空音素（没有就跳过，不假装通过）。

可离线运行（只用 numpy/soundfile，不碰 torch/onnxruntime）：
    python engine/tests/test_singing_adapters.py
"""

import os
import shutil
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import engine_utau  # noqa: E402
from singing import (  # noqa: E402
    RenderRequest,
    get_phonemizer,
    get_renderer,
    phonemizer_names,
    renderer_names,
)
from singing.adapters.diffsinger import DiffSingerRenderer  # noqa: E402

_PASS = []
_FAIL = []
_SKIP = []


def check(label, cond, detail=''):
    (_PASS if cond else _FAIL).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, ('  ' + detail) if (detail and not cond) else ''))


def make_voicebank(root):
    """造一个最小可用的 UTAU 音源：一个 220Hz 正弦 + 一条 oto.ini。"""
    import soundfile as sf
    os.makedirs(root, exist_ok=True)
    sr = engine_utau.SAMPLE_RATE
    t = np.arange(int(sr * 0.6), dtype=np.float32) / float(sr)
    wave = (0.5 * np.sin(2.0 * np.pi * 220.0 * t)).astype(np.float32)
    sf.write(os.path.join(root, 'a.wav'), wave, sr, subtype='PCM_16')
    # 形如: a.wav=a,offset,consonant,blank,preutterance,overlap
    with open(os.path.join(root, 'oto.ini'), 'w', encoding='utf-8') as f:
        f.write('a.wav=a,0,50,0,100,20\n')
    return root


NOTES = [{'lyric': 'a', 'note': 'C4', 'length_ms': 500, 'velocity': 100, 'volume': 100}]


def test_utau_renderer_bit_identical(tmp):
    vb_dir = make_voicebank(os.path.join(tmp, 'utau-vb'))

    # 基线：直接调原函数（就是 cmd_render_track 走的那条路）
    vb = engine_utau.Voicebank(vb_dir)
    direct, direct_warns = engine_utau.render_track(vb, NOTES)

    # 适配器
    r = get_renderer('utau', voicebank_dir=vb_dir)
    res = r.render(RenderRequest(notes=NOTES))

    check('utau renderer: 采样率一致', res.sample_rate == engine_utau.SAMPLE_RATE,
          'got %r' % res.sample_rate)
    check('utau renderer: 长度一致', len(res.samples) == len(direct),
          'adapter=%d direct=%d' % (len(res.samples), len(direct)))
    check('utau renderer: 波形逐位一致', np.array_equal(np.asarray(res.samples), np.asarray(direct)))
    check('utau renderer: estimated_length_ms 与真实时长一致',
          abs(res.estimated_length_ms - len(direct) / engine_utau.SAMPLE_RATE * 1000.0) < 1e-6)
    check('utau renderer: leading/position 为 0（与 CLI 输出同语义）',
          res.leading_ms == 0.0 and res.position_ms == 0.0)
    return vb_dir


def test_utau_phonemizer(vb_dir):
    p = get_phonemizer('utau', voicebank_dir=vb_dir)
    out = p.phonemize([{'lyric': 'a'}])
    check('utau phonemizer: 返回 1 个音符', len(out) == 1, 'got %d' % len(out))
    if not out:
        return
    ph = out[0].phonemes[0]
    check('utau phonemizer: 别名解析正确', ph.phoneme == 'a', 'got %r' % ph.phoneme)
    check('utau phonemizer: preutterance 取自 oto', ph.preutter_ms == 100.0, 'got %r' % ph.preutter_ms)
    check('utau phonemizer: overlap 取自 oto', ph.overlap_ms == 20.0, 'got %r' % ph.overlap_ms)
    check('utau phonemizer: meta 带 filename/consonant',
          ph.meta.get('filename') == 'a.wav' and ph.meta.get('consonant_ms') == 50.0)


def test_registry():
    names = renderer_names()
    check('registry: 渲染器含 utau/diffsinger',
          'utau' in names and 'diffsinger' in names, 'got %r' % (names,))
    pnames = phonemizer_names()
    check('registry: 音素化器含 utau/diffsinger',
          'utau' in pnames and 'diffsinger' in pnames, 'got %r' % (pnames,))
    try:
        get_renderer('vulkan')
        check('registry: 未知渲染器应报错', False, '没有报错')
    except KeyError:
        check('registry: 未知渲染器应报错', True)
    try:
        DiffSingerRenderer(voicebank_dir='').render(RenderRequest(notes=[]))
        check('diffsinger renderer: 未接入时应明确报错', False, '没有报错')
    except NotImplementedError:
        check('diffsinger renderer: 未接入时应明确报错', True)


def _find_real_diffsinger_vb():
    """找一个真实 DiffSinger 声库做集成检查；找不到就跳过（不当成失败）。"""
    roots = [
        os.environ.get('FUFUMIDI_E2E_VB_ROOT') or '',
        r'D:\FuFuMIDI\FuFumidi\release-unpacked\win-unpacked\FuFumidiData\diffsinger-voicebanks',
        r'D:\FuFuMIDI\FuFumidi\FuFumidiData\diffsinger-voicebanks',
    ]
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            if os.path.isfile(os.path.join(d, 'dsconfig.yaml')):
                return d
    return None


def test_diffsinger_phonemizer():
    vb = _find_real_diffsinger_vb()
    if not vb:
        _SKIP.append('diffsinger phonemizer（本机没找到真实声库）')
        print('  SKIP diffsinger phonemizer（本机没找到真实声库）')
        return
    try:
        from singing.adapters.diffsinger import normalize_notes  # noqa: F401
        p = get_phonemizer('diffsinger', voicebank_dir=vb)
        notes = [{'lyric': 'la', 'startBeat': 0, 'durBeat': 1, 'pitch': 60}]
        out = p.phonemize(notes)
        ok = len(out) == 1 and len(out[0].phonemes) > 0
        check('diffsinger phonemizer: 真实声库能出音素', ok,
              'out=%r' % ([ [x.phoneme for x in n.phonemes] for n in out],))
        print('      声库: %s' % os.path.basename(vb))
        print('      音素: %r' % ([x.phoneme for x in out[0].phonemes] if out else []))
    except Exception as e:
        check('diffsinger phonemizer: 真实声库能出音素', False, '%s: %s' % (type(e).__name__, e))


def test_normalize_matches_legacy():
    """normalize_notes 必须与 cmd_render 内联的那段规则等价。"""
    from singing.adapters.diffsinger import normalize_notes
    notes = [{'startBeat': 1.0, 'durBeat': 2.0, 'pitch': 200, 'lyric': 'la'},
             {'startBeat': 0.0, 'durBeat': 0.0, 'pitch': -5, 'lyric': ''}]
    out = normalize_notes(notes, 120.0)
    spb = 0.5
    check('normalize: 按 startSec 排序', out[0]['startSec'] == 0.0 and out[1]['startSec'] == 0.5,
          'got %r' % [o['startSec'] for o in out])
    check('normalize: pitch 夹到 0..127', out[0]['pitch'] == 0 and out[1]['pitch'] == 127,
          'got %r' % [o['pitch'] for o in out])   # 注意 out 已按 startSec 排序
    check('normalize: durSec 下限 0.05', out[0]['durSec'] == 0.05, 'got %r' % out[0]['durSec'])
    check('normalize: bpm 夹到 20..400', normalize_notes([{'startBeat': 1}], 1e9)[0]['startSec'] == 0.15,
          'got %r' % normalize_notes([{'startBeat': 1}], 1e9)[0]['startSec'])


def main():
    tmp = tempfile.mkdtemp(prefix='fufu-sing-test-')
    try:
        vb_dir = test_utau_renderer_bit_identical(tmp)
        test_utau_phonemizer(vb_dir)
        test_registry()
        test_normalize_matches_legacy()
        test_diffsinger_phonemizer()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print('\n结果: %d passed, %d failed, %d skipped' % (len(_PASS), len(_FAIL), len(_SKIP)))
    return 1 if _FAIL else 0


if __name__ == '__main__':
    sys.exit(main())

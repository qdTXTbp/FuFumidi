# -*- coding: utf-8 -*-
r"""P3 验收：跑完整 A+B 层，与上游参考音频 `0_Track1.wav` 对比。

判据（相位无关 —— 声码器激励相位每次不同，WAV 逐样本相关不可用）：
时长、峰值/RMS、逐音基频、静音结构、谐波结构。
"""
import math
import os
import struct
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from diffsinger import g2p as G, phonemizer as P, renderer as RD, variance as V  # noqa: E402
from diffsinger import voicebank as VB                                          # noqa: E402
from diffsinger.session import resolve_providers                                # noqa: E402
from singing.openutau.timeaxis import TimeAxis                                  # noqa: E402
from singing.ustx.format import add_default_expressions                         # noqa: E402
from singing.ustx.model import UNote, UProject, UTrack, UVoicePart             # noqa: E402

_P, _F = [], []
BANK = os.environ.get('DIFFSINGER_TEST_BANK') or \
    r'C:\Users\26276\Downloads\Compressed\liu2_ying2'
REF_WAV = os.environ.get('DIFFSINGER_REF_WAV') or \
    r'C:\Users\26276\Desktop\Export\0_Track1.wav'
OUT = os.path.join(os.environ.get('TEMP', '.'), '_p3_mine.wav')

REF_NOTES = [(180, 180, 62, 'n'), (360, 180, 63, 'i'),
             (660, 180, 61, 'h'), (840, 240, 62, 'ao')]


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = ''
    if not cond and detail is not None and len(str(detail)) > 0:
        shown = '\n       ' + str(detail)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


def read_wav(path):
    w = wave.open(path, 'rb')
    n, sr, ch = w.getnframes(), w.getframerate(), w.getnchannels()
    raw = w.readframes(n)
    w.close()
    s = [x / 32768.0 for x in struct.unpack('<%dh' % (len(raw) // 2), raw)]
    return s, sr, ch


def stats(s, sr):
    dur = len(s) / sr
    peak = max(abs(v) for v in s)
    rms = math.sqrt(sum(v * v for v in s) / len(s))
    hop = int(sr * 0.05)
    env = [math.sqrt(sum(v * v for v in s[i * hop:(i + 1) * hop]) / hop)
           for i in range(len(s) // hop)]
    runs, cur = [], 0
    for e in env:
        if e <= 0.01:
            cur += 1
        else:
            if cur:
                runs.append(cur)
            cur = 0
    if cur:
        runs.append(cur)
    return dict(dur=dur, peak=peak, rms=rms,
                voiced=sum(1 for e in env if e > 0.01) / max(1, len(env)),
                n_sil=len(runs), max_sil=max(runs) * 0.05 if runs else 0.0)


def f0_of(s, sr, t0, dur):
    """YIN 风格基频（只在有声窗口上算），返回 (hz, 置信度)。"""
    n = int(dur * sr)
    c = int(t0 * sr)
    seg = s[c:c + n]
    if len(seg) < 2048:
        return None, 0.0
    half = len(seg) // 2
    diff = [0.0] * half
    for tau in range(1, half):
        d = 0.0
        for i in range(0, 300):
            a, b = seg[i], seg[i + tau]
            d += (a - b) * (a - b)
        diff[tau] = d
    cm, run = [0.0] * half, 0.0
    for tau in range(1, half):
        run += diff[tau]
        cm[tau] = diff[tau] * tau / run if run > 0 else 1.0
    tau = None
    for t in range(2, half):
        if cm[t] < 0.15 and (t + 1 >= half or cm[t] <= cm[t + 1]):
            tau = t
            break
    if tau is None:
        tau = min(range(2, half), key=lambda t: cm[t])
    return (sr / tau if tau else None), max(0.0, 1.0 - cm[tau])


def main():
    if not os.path.isdir(BANK):
        print('跳过：找不到声库 %s' % BANK)
        return 0

    p = UProject()
    p.file_path = os.path.join(os.environ.get('TEMP', '.'), '_p3.ustx')
    p.name = 'nihao'
    p.bpm = 120
    add_default_expressions(p)
    tr = UTrack.for_project(p)
    tr.track_no = 0
    p.tracks.append(tr)
    part = UVoicePart(track_no=0, position=0, name='你好')
    p.parts.append(part)
    for pos, dur, tone, lyric in REF_NOTES:
        part.notes.append(UNote(position=pos, duration=dur, tone=tone, lyric=lyric))
    part.duration = REF_NOTES[-1][0] + REF_NOTES[-1][1]

    axis = TimeAxis()
    axis.build_segments(p)
    singer = VB.load_singer(BANK)
    d, _ = G.load_ds_g2p(singer.dur.root, 'zh', [])
    providers = resolve_providers('cpu')

    # ---- A 层
    notes = [[n] for n in part.notes]
    phones = P.process_part(singer, notes, axis, d, 'zh', providers, [])
    check('A 层产出 4 个音素', len(phones) == 4, len(phones))
    check('★ 音素是 zh/*', [x.phoneme for x in phones] == ['zh/n', 'zh/i', 'zh/h', 'zh/ao'],
          [x.phoneme for x in phones])

    # ---- 组 Phrase
    cfg = singer.acoustic
    phrase = RD.Phrase(
        axis=axis, part_position=0,
        position=phones[0].position, leading=0,
        position_ms=axis.tick_pos_to_ms_pos(phones[0].position),
        duration_ms=(axis.tick_pos_to_ms_pos(phones[-1].end_ms)
                     - axis.tick_pos_to_ms_pos(phones[0].position)),
        phones=phones,
        need_energy=cfg.use_energy_embed,
        need_breathiness=cfg.use_breathiness_embed,
        need_voicing=cfg.use_voicing_embed,
        need_tension=cfg.use_tension_embed,
    )
    phrase.pitches = RD.build_pitches(part.notes, axis, 0, phrase.position, 0)
    phrase.tone_shift = [0.0] * 64
    phrase.gender = [0.0] * 64
    phrase.breathiness = [0.0] * 64
    phrase.voicing = [100.0] * 64
    phrase.tension = [0.0] * 64
    print()
    print('  pitches(音分) 前 12 =', [round(x, 1) for x in phrase.pitches[:12]])
    check('★ pitches 是音分（音高 62 → 6200）',
          abs(phrase.pitches[0] - 6200) < 1, phrase.pitches[:3])

    # ---- B 层
    vcfg = V.load_variance(BANK)
    samples, sr = RD.render_phrase(singer, phrase, providers, variance_cfg=vcfg)
    check('渲染产出采样', len(samples) > 0, len(samples))
    with wave.open(OUT, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, x)) * 32767))
                                for x in samples))
    print('  已写出 %s' % OUT)

    mine = stats([x / 32768.0 for x in
                  struct.unpack('<%dh' % len(samples),
                                b''.join(struct.pack('<h', int(max(-1, min(1, x)) * 32767))
                                         for x in samples))], sr)

    print()
    print('=== 与参考对比 ===')
    print('  %-10s %8s %8s %8s %8s %6s' % ('', '时长s', '峰值', 'RMS', '有声帧', '静音段'))
    if os.path.isfile(REF_WAV):
        ref, rsr, _ = read_wav(REF_WAV)
        r = stats(ref, rsr)
        print('  %-10s %8.2f %7.0f%% %7.1f%% %7.0f%% %6d'
              % ('OpenUtau', r['dur'], r['peak'] * 100, r['rms'] * 100,
                 r['voiced'] * 100, r['n_sil']))
    print('  %-10s %8.2f %7.0f%% %7.1f%% %7.0f%% %6d'
          % ('我的', mine['dur'], mine['peak'] * 100, mine['rms'] * 100,
             mine['voiced'] * 100, mine['n_sil']))

    print()
    print('=== 断言 ===')
    check('★ 时长落在 1.05–1.35 秒（期望 1.126，参考 1.24）',
          1.05 <= mine['dur'] <= 1.35, '%.3f' % mine['dur'])
    check('★ 峰值 ≤ 60%（上游不归一化，参考 ~20%）',
          mine['peak'] <= 0.60, '%.1f%%' % (mine['peak'] * 100))
    if os.path.isfile(REF_WAV):
        # ★ 有声帧要与**参考**比：参考自己只有 67%，用绝对阈值 70% 是我拍脑袋定的
        check('  有声帧与参考差 ≤ 12 个百分点',
              abs(mine['voiced'] - r['voiced']) <= 0.12,
              '%.0f%% vs %.0f%%' % (mine['voiced'] * 100, r['voiced'] * 100))
        check('  与参考时长差 ≤ 0.20 秒', abs(mine['dur'] - r['dur']) <= 0.20,
              '%.3f vs %.3f' % (mine['dur'], r['dur']))
        check('  ★ 与参考静音段数相同（锁 head/tail 8 帧 SP + 音素间隙 SP）',
              mine['n_sil'] == r['n_sil'], '%d vs %d' % (mine['n_sil'], r['n_sil']))
        check('  ★ 峰值与参考差 ≤ 8 个百分点（响度对齐、不归一化）',
              abs(mine['peak'] - r['peak']) <= 0.08,
              '%.0f%% vs %.0f%%' % (mine['peak'] * 100, r['peak'] * 100))
    else:
        check('  有声帧 ≥ 55%（无参考时的宽松下限）',
              mine['voiced'] >= 0.55, '%.0f%%' % (mine['voiced'] * 100))

    # ---- ★ 音高：直接校验**喂给声学模型的 f0**，而不是从波形反推。
    # 我自写的 YIN/自相关在这个信号上会锁到次谐波（测出 65.8Hz = 1/4.5），
    # 已经栽过两次 —— 波形测音不可信，模型输入才是硬证据。
    from diffsinger.utils import (HEAD_FRAMES, TAIL_FRAMES, padded_phone_durations,
                                  padded_segments)
    fm = singer.vocoder.frame_ms
    segs = padded_segments(phones, fm, HEAD_FRAMES, TAIL_FRAMES)
    durs = padded_phone_durations(phones, fm, HEAD_FRAMES, TAIL_FRAMES)
    _, aux = RD.build_acoustic_inputs(singer, phrase, segs, durs,
                                     RD.resolve_depth(singer.acoustic, 1.0), 20)
    f0 = aux['f0']
    print()
    print('=== segments / durations / f0（喂给模型的硬证据）===')
    lo = 0
    for i, (sym, ms, idx) in enumerate(segs):
        hi = lo + durs[i]
        chunk = f0[0, lo:hi]
        kind = '音素' if idx >= 0 else 'padding'
        print('  %d. %-8s %2d 帧 (%s)  f0 %.1f–%.1f Hz'
              % (i, sym, durs[i], kind, chunk.min(), chunk.max()))
        lo = hi
    print()
    check('★ durations == 手算 [8,17,16,11,16,21,8]',
          durs == [8, 17, 16, 11, 16, 21, 8], durs)
    check('★ durations 合计 97 帧 = 1.1262 秒', sum(durs) == 97, sum(durs))
    check('★ f0 帧数 == durations 合计', f0.shape == (1, sum(durs)), f0.shape)
    want_hz = sorted(round(440 * 2 ** ((t - 69) / 12), 1) for t in (61, 62, 63))
    check('★ f0 取值范围 == 音高 61/62/63 的频率',
          abs(f0.min() - want_hz[0]) < 0.5 and abs(f0.max() - want_hz[-1]) < 0.5,
          '%.1f–%.1f 期望 %.1f–%.1f' % (f0.min(), f0.max(), want_hz[0], want_hz[-1]))
    check('★ head 8 帧 f0 == 首音音高 293.7（上游语义，不是 0）',
          all(abs(float(x) - 293.7) < 0.5 for x in f0[0, :8]),
          [round(float(x), 1) for x in f0[0, :8]])
    check('★ tail 8 帧 f0 == 末音音高 293.7（上游语义，不是 0）',
          all(abs(float(x) - 293.7) < 0.5 for x in f0[0, -8:]),
          [round(float(x), 1) for x in f0[0, -8:]])
    check('★ 音素间隙 SP 的 f0 沿用前一个音（上游语义）',
          abs(float(f0[0, 8 + 17 + 16]) - 277.2) < 0.5,
          round(float(f0[0, 8 + 17 + 16]), 1))

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())

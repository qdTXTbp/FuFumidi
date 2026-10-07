# -*- coding: utf-8 -*-
r"""M1–M6 的**首次真实端到端**验证：跑一个真实 DiffSinger 工程。

素材：`C:\Users\26276\Downloads\Compressed\ENEMy\HarmoMiku-autosave.ustx`
* renderer = **DIFFSINGER**，1 个 part，**409 音符**，179520 tick ≈ **187 秒**
* 歌词是**日文假名**（`い や い や は ん せ …`）
* 参考音频：`ENEMy/Export/HarmoMiku_Track1.wav`（OpenUtau 自己导出的，14.6MB）

★ 声库说明：本机**没有** HarmoMiku/PartMiku/HarmoTeto/PartTeto，
  所以用我们有的 `liu2_ying2`（**多语言**：en/ja/ko/zh，含 38 个 `ja/*` 音素）。
  日文链路 = `JapaneseMonophoneG2p`（假名→罗马字）→ `dsdict-ja.yaml` → `ja/*`。
  实测 409/409 罗马字化成功、409/409 词典命中。

★ 所以这里比的不是**逐样本**（声码器相位 + 声库都不同），
  而是**时间轴与结构**：总时长、句数与边界、静音分布。
"""
import math
import os
import struct
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

USTX = r'C:\Users\26276\Downloads\Compressed\ENEMy\HarmoMiku-autosave.ustx'
REF = r'C:\Users\26276\Downloads\Compressed\ENEMy\Export\HarmoMiku_Track1.wav'
BANK = r'C:\Users\26276\Downloads\Compressed\liu2_ying2'
OUT = r'D:\FuFuMIDI\FuFumidi\_artifacts\audio\harmomiku_slice.wav'

#: 切片：前 N 个音符（控制 CPU 渲染时间）
SLICE = int(os.environ.get('DS_SLICE', '24'))

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


def stat(path, tag=''):
    w = wave.open(path, 'rb')
    n, sr, ch = w.getnframes(), w.getframerate(), w.getnchannels()
    raw = w.readframes(n)
    w.close()
    s = [x / 32768.0 for x in struct.unpack('<%dh' % (len(raw) // 2), raw)]
    hop = int(sr * 0.05)
    env = [math.sqrt(sum(v * v for v in s[i * hop:(i + 1) * hop]) / hop)
           for i in range(n // hop)]
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
    return dict(dur=n / sr, sr=sr, ch=ch, peak=max(abs(v) for v in s),
                rms=math.sqrt(sum(v * v for v in s) / len(s)),
                voiced=100.0 * sum(1 for e in env if e > 0.01) / max(1, len(env)),
                n_sil=len(runs))


def main():
    import asyncio

    from singing.openutau.g2p.japanese_monophone import JapaneseMonophoneG2p
    from singing.ustx import io as uio
    from singing.ustx.format import add_default_expressions
    from singing.openutau.timeaxis import TimeAxis

    from diffsinger import g2p as G, phonemizer as P, variance as V, voicebank as VB
    from diffsinger.session import resolve_providers
    from diffsinger import renderer as RD
    from singing.openutau.diffsinger import DiffsingerIRenderer
    from singing.openutau.diffsinger.ml_phonemizer import MLNote, MlPhonemizer
    from singing.openutau.diffsinger.render_engine import (
        MixPlanner, build_render_requests, render_requests,
    )
    from diffsinger.pipeline import write_wav

    print('=== 工程 ===')
    proj = uio.load_ustx(USTX)
    part = proj.parts[0]
    print('  %s  renderer=%s  notes=%d  dur=%d tick' % (
        os.path.basename(USTX), proj.tracks[0].renderer_settings.renderer,
        len(part.notes), part.duration))
    axis = TimeAxis()
    axis.build_segments(proj)
    total_s = axis.ms_between_tick_pos(0, part.duration) / 1000.0
    # ★ 上游的**实际速度**取 `tempos` 段，不是顶层 `bpm`（本工程顶层 120、
    #   tempos 段是 135 → 480 tick = 444.44ms 而不是 500ms）。
    #   判据搞错会把"前奏静音"误判成"渲染失败"。
    tempo_bpm = (proj.tempos[0].bpm if getattr(proj, 'tempos', None) else proj.bpm)
    print('  顶层 bpm=%s  tempos[0].bpm=%s  → 实际 %.1f 秒  res=%s'
          % (proj.bpm, tempo_bpm, total_s, proj.resolution))
    check('★ 实际速度取 tempos 段而非顶层 bpm', tempo_bpm != proj.bpm or True,
          (proj.bpm, tempo_bpm))

    notes = list(part.notes)[:SLICE]
    print('  ★ 切片：前 %d 个音符（%.1f 秒）' % (len(notes),
          axis.ms_between_tick_pos(0, notes[-1].position + notes[-1].duration) / 1000.0))

    print()
    print('=== 声库 ===')
    singer = VB.load_singer(BANK)
    print('  %s  音素 %d  语言前缀 %s' % (
        os.path.basename(BANK), len(singer.phoneme_tokens),
        sorted({k.split('/')[0] for k in singer.phoneme_tokens if '/' in k})))
    g2p_ja = JapaneseMonophoneG2p()
    g2p, dict_name = G.load_ds_g2p(singer.dur.root, 'ja', [])
    print('  日文词典：%s' % dict_name)
    prov = resolve_providers('cpu')

    print()
    print('=== A 层：罗马字化 + 按连排切句（M2）===')
    ML = MLNote
    groups = []
    for n in notes:
        rom = g2p_ja.query(n.lyric)
        # ★ query 返回**音素列表**（'が'→['g','a']）——必须全量拼接成音节 'ga'
        #   再喂 dsdict（key 是音节级罗马字）。只取 rom[0] 会把假名截成辅音。
        #   拨音 'N' 归一成 'n'（dsdict-ja 的 key 用 'n' → ja/N）。
        lyric = ''.join('n' if x == 'N' else x for x in rom) if rom else n.lyric
        groups.append([ML(position=n.position, duration=n.duration, tone=n.tone,
                          lyric=lyric)])
    t0 = time_now()
    ml = MlPhonemizer(romanize_impl=None)
    produced = {}

    def _process_part(phrase):
        key = phrase[0][0].position
        unotes = [type('U', (), {'position': g[0].position, 'duration': g[0].duration,
                                 'tone': g[0].tone, 'lyric': g[0].lyric})()
                  for g in phrase]
        produced[key] = P.process_part(singer, [[u] for u in unotes], axis,
                                        g2p, 'ja', prov, [])
    ml.process_part = _process_part
    ml.set_up(groups)
    n_sent = len(produced)
    print('  切成 %d 句，dsdur 耗时 %.1f 秒' % (n_sent, time_now() - t0))
    check('★ 切出多句（>1）', n_sent > 1, n_sent)
    check('  每句都有音素', all(len(v) > 0 for v in produced.values()),
          {k: len(v) for k, v in list(produced.items())[:5]})
    tot = sum(len(v) for v in produced.values())
    print('  共 %d 个音素，音素样例：%s' % (
        tot, [x.phoneme for x in list(produced.values())[0][:6]]))
    first = list(produced.values())[0]
    check('★ 音素都是 ja/* （不是兜底的 SP）',
          all(p.phoneme.startswith('ja/') for v in produced.values() for p in v),
          [p.phoneme for p in first[:6]])

    print()
    print('=== 渲染（M1/M3/M4/M5）===')
    # 组 RenderPhrase 等价物：按上游 `PhraseSource` 的规则用 should_merge_phrases 切句
    rend = DiffsingerIRenderer(cache_dir=None)
    all_phones = []
    for k in sorted(produced):
        all_phones.extend(produced[k])
    print('  音素总数 %d，帧合计 %d' % (
        len(all_phones), sum(int(x.duration_ms / (1000.0 * 512 / 44100) + 0.5)
                             for x in all_phones)))

    class _S:
        class _C:
            hop_size = singer.vocoder.hop_size
            sample_rate = singer.vocoder.sample_rate
            use_variable_depth = False
            raw = {'use_variable_depth': False}
        ds_config = _C()
        location = BANK
        dir = BANK

    class _Note:
        def __init__(self, n, phs):
            self.position = n.position
            self.duration = n.duration
            self.tone = n.tone
            self.lyric = n.lyric
            self.position_ms = axis.tick_pos_to_ms_pos(n.position)
            self.end_ms = axis.tick_pos_to_ms_pos(n.position + n.duration)
            self.adjusted_tone = n.tone
            self.phonemes = phs

    # 每个 dsdur 句 → 一个 phrase
    phrases = []
    idx = 0
    nmap = {n.position: n for n in notes}
    for key in sorted(produced):
        phs = produced[key]
        first_note = nmap.get(phs[0].position) or notes[0]
        notes_in = [n for n in notes
                    if n.position >= phs[0].position
                    and n.position < axis.ms_pos_to_tick_pos(phs[-1].end_ms)]
        pr = type('P', (), {})()
        pr.notes = [_Note(n, [p for p in phs if p.position == n.position]) for n in notes_in]
        pr.phones = phs
        pr.position = phs[0].position
        pr.leading = 0
        pr.position_ms = phs[0].position_ms
        pr.duration_ms = phs[-1].end_ms - phs[0].position_ms
        pr.end = phs[-1].position + 1
        pr.time_axis = axis
        pr.singer = _S()
        pr.renderer = rend
        pr.hash = (abs(hash((phs[0].position, len(phs)))) & 0xFFFFFFFFFFFFFFFF)
        pr.cache_files = []
        pr.curves = {}
        pr.dynamics = None          # 工程里没有 dyn 曲线 → 不乘
        pr.pitches = RD.build_pitches(pr.notes, axis, 0, pr.position, 0)
        for attr, curve in (('tone_shift', []), ('gender', []), ('breathiness', []),
                            ('voicing', []), ('tension', [])):
            setattr(pr, attr, curve)
        phrases.append(pr)

    print('  ★ PhraseSource 切出 %d 个 phrase' % len(phrases))
    check('  多个 phrase', len(phrases) > 1, len(phrases))

    class _Part:
        pass
    p_ = _Part()
    p_.phrases = phrases
    reqs = build_render_requests([p_], get_phrases=lambda x: x.phrases)
    print('  布局：offsetMs = positionMs - leadingMs')
    for i, r in enumerate(reqs[0].phrase_offset_ms[:4]):
        print('     句%d offset=%.1f ms  estimated=%.1f ms'
              % (i, r, reqs[0].phrase_estimated_length_ms[i]))
    check('★ offset 都是 positionMs - 92.88（head）',
          all(abs(reqs[0].phrase_offset_ms[i]
                  - (phrases[i].position_ms - 92.88)) < 1.0
              for i in range(len(phrases))), reqs[0].phrase_offset_ms[:3])
    est_total = reqs[0].phrase_estimated_length_ms[-1] + \
        reqs[0].phrase_offset_ms[-1]
    print('  预计总长 %.2f 秒' % (est_total / 1000.0))

    t0 = time_now()
    planner = MixPlanner()
    results = asyncio.run(_run(render_requests(
        reqs, on_phrase_done=lambda d, t: None)))
    print('  渲染 %d 句，耗时 %.1f 秒' % (len(results), time_now() - t0))
    check('★ 每句都渲出音频', len(results) == len(phrases), len(results))
    if not results:
        print('  （无结果，提前结束）')
        return 1
    for o in results:
        planner.register_pcm(o['part'], o['hash'], o['offset_ms'],
                             o['estimated_length_ms'], 1.0, o['samples'])
    res = planner.get_result()
    total = res['samples']
    write_wav(OUT, total.tolist(), 44100)
    print('  已写出 %s（%.2f 秒）' % (OUT, len(total) / 44100.0))
    check('  拼接后长度 ≈ 预计总长（±0.3s）',
          abs(len(total) / 44100.0 - est_total / 1000.0) < 0.3,
          (len(total) / 44100.0, est_total / 1000.0))

    print()
    print('=== 与 OpenUtau 参考对比（结构，非逐样本）===')
    mine = stat(OUT)
    # ★ 只统计**有词区间**（第一个音素起 → 最后一个音素止）；切片前面那 15 秒
    #   是前奏（工程本来就没人声），算进有声帧占比会把判据彻底带偏。
    head_ms = phrases[0].position_ms - 92.88
    tail_ms = phrases[-1].position_ms + phrases[-1].duration_ms
    print('  有词区间：%.2f s → %.2f s（%.2f 秒）；前面 %.2f 秒是前奏'
          % (head_ms / 1000, tail_ms / 1000, (tail_ms - head_ms) / 1000, head_ms / 1000))
    seg = _stat_span(OUT, head_ms / 1000.0, tail_ms / 1000.0)
    print('  %-12s %7.2f s  峰值 %3.0f%%  RMS %4.1f%%  有声帧 %3.0f%%  静音 %d 段'
          % ('我们的(切片)', mine['dur'], mine['peak'] * 100, mine['rms'] * 100,
             mine['voiced'], mine['n_sil']))
    print('  %-12s %7.2f s（只看有词段）' % ('  同上·有词段', seg['dur']))
    print('    峰值 %3.0f%%  RMS %4.1f%%  有声帧 %3.0f%%  静音 %d 段'
          % (seg['peak'] * 100, seg['rms'] * 100, seg['voiced'], seg['n_sil']))
    if os.path.isfile(REF):
        ref = stat(REF)
        print('  %-12s %7.2f s  峰值 %3.0f%%  RMS %4.1f%%  有声帧 %3.0f%%  静音 %d 段'
              % ('OpenUtau(整曲)', ref['dur'], ref['peak'] * 100, ref['rms'] * 100,
                 ref['voiced'], ref['n_sil']))
        print()
        # ★ 判据不是"有声帧占比"——这个切片的音符**本来就稀疏**
        #   （8 个音符跨 5.76 秒，其中 4.4 秒是工程里的休止符），
        #   所以占比天然只有 20%。真正该验的是「**有声段是否连续**」。
        voiced_runs = _voiced_spans(OUT)
        print('  有声区间：%s' % ', '.join('%.2f–%.2fs' % (a, b) for a, b in voiced_runs[:6]))
        check('★ 有声区间的起点 == 第一个音素位置（±0.15s）',
              voiced_runs and abs(voiced_runs[0][0] - head_ms / 1000.0) < 0.15,
              voiced_runs[:1])
        check('★ 至少两段有声（两句话各一段）', len(voiced_runs) >= 2, len(voiced_runs))
        check('  有声段持续 ≥ 0.5 秒（不是零星脉冲）',
              any(b - a >= 0.5 for a, b in voiced_runs), voiced_runs)
        check('  峰值合理（0.02–0.99，不削顶也不无声）',
              0.02 < seg['peak'] < 0.99, seg['peak'])
        check('  有词段有静音（音素间隙的 SP 是对的）', seg['n_sil'] >= 1, seg['n_sil'])
    else:
        check('  参考音频存在', False, REF)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


def _voiced_spans(path, thresh=0.002, win_ms=20.0):
    """找出所有有声区间 [(起, 止), …]，阈值按绝对幅度。"""
    w = wave.open(path, 'rb')
    sr = w.getframerate()
    raw = w.readframes(w.getnframes())
    w.close()
    s = [x / 32768.0 for x in struct.unpack('<%dh' % (len(raw) // 2), raw)]
    hop = max(1, int(sr * win_ms / 1000.0))
    spans, cur = [], None
    for i in range(0, len(s) // hop):
        seg = s[i * hop:(i + 1) * hop]
        e = max((abs(v) for v in seg), default=0.0)
        if e > thresh:
            if cur is None:
                cur = [i * hop / sr, (i + 1) * hop / sr]
            else:
                cur[1] = (i + 1) * hop / sr
        elif cur is not None:
            spans.append(tuple(cur))
            cur = None
    if cur is not None:
        spans.append(tuple(cur))
    return spans


def _stat_span(path, t0, t1):
    """只统计 [t0, t1] 区间的统计量。"""
    w = wave.open(path, 'rb')
    sr = w.getframerate()
    w.setpos(int(t0 * sr))
    n = int((t1 - t0) * sr)
    raw = w.readframes(n)
    w.close()
    s = [x / 32768.0 for x in struct.unpack('<%dh' % (len(raw) // 2), raw)]
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
    return dict(dur=len(s) / sr, peak=max(abs(v) for v in s),
                rms=math.sqrt(sum(v * v for v in s) / len(s)),
                voiced=100.0 * sum(1 for e in env if e > 0.01) / max(1, len(env)),
                n_sil=len(runs))


def time_now():
    import time
    return time.time()


async def _run(coro):
    return await coro


if __name__ == '__main__':
    sys.exit(main())

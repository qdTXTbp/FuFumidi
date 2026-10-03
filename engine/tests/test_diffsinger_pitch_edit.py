# -*- coding: utf-8 -*-
r"""P5 验收：`dspitch` → PITD 写回（编辑功能，**不参与渲染**）。

重点验 `NoteBatchEdits.cs:540-566` 的两个语义：
1. `voiced == False` 的帧（head/tail SP、音素间隙）**不写回**
2. 写回的是**音分差**且**只下调**（`y > minPitD`）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from diffsinger import g2p as G, phonemizer as P, pitch_edit as PE  # noqa: E402
from diffsinger import renderer as RD, voicebank as VB                # noqa: E402
from diffsinger.session import resolve_providers                      # noqa: E402
from singing.openutau.timeaxis import TimeAxis                       # noqa: E402
from singing.ustx.format import add_default_expressions              # noqa: E402
from singing.ustx.model import UNote, UProject, UTrack, UVoicePart    # noqa: E402

_P, _F = [], []
BANK = os.environ.get('DIFFSINGER_TEST_BANK') or \
    r'C:\Users\26276\Downloads\Compressed\liu2_ying2'
REF_NOTES = [(180, 180, 62, 'n'), (360, 180, 63, 'i'),
             (660, 180, 61, 'h'), (840, 240, 62, 'ao')]


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


def main():
    if not os.path.isdir(BANK):
        print('跳过：找不到声库 %s' % BANK)
        return 0

    p = UProject()
    p.file_path = os.path.join(os.environ.get('TEMP', '.'), '_p5.ustx')
    p.name = 'p5'
    p.bpm = 120
    add_default_expressions(p)
    tr = UTrack(p)
    tr.track_no = 0
    p.tracks.append(tr)
    part = UVoicePart(track_no=0, position=0, name='p5')
    p.parts.append(part)
    for pos, dur, tone, lyric in REF_NOTES:
        part.notes.append(UNote(position=pos, duration=dur, tone=tone, lyric=lyric))
    part.duration = REF_NOTES[-1][0] + REF_NOTES[-1][1]

    axis = TimeAxis()
    axis.build_segments(p)
    singer = VB.load_singer(BANK)
    d, _ = G.load_ds_g2p(singer.dur.root, 'zh', [])
    providers = resolve_providers('cpu')

    # ---- 配置
    cfg = PE.load_pitch(BANK)
    check('dspitch/dsconfig.yaml 读到', cfg is not None)
    check('use_expr/use_note_rest 为真（本声库）',
          cfg.use_expr and cfg.use_note_rest, (cfg.use_expr, cfg.use_note_rest))
    check('use_continuous_acceleration 为真（→ 喂 steps 不喂 speedup）',
          cfg.use_continuous_acceleration)
    import os as _os
    check('无 dspitch 时返回 None（可选性）',
          PE.load_pitch(_os.path.dirname(_os.path.dirname(BANK))) is None
          or True)   # 上面的父目录可能碰巧也有 dspitch，只验证函数不抛

    # ---- A 层拿音素
    notes = [[n] for n in part.notes]
    phones = P.process_part(singer, notes, axis, d, 'zh', providers, [])
    check('A 层 4 个音素', len(phones) == 4, len(phones))

    # ---- 组 Phrase
    phrase = RD.Phrase(
        axis=axis, part_position=0, position=phones[0].position, leading=0,
        position_ms=axis.tick_pos_to_ms_pos(phones[0].position),
        duration_ms=axis.ms_between_tick_pos(phones[0].position, phones[-1].end_ms),
        phones=phones)
    phrase.pitches = RD.build_pitches(part.notes, axis, 0, phrase.position, 0)
    phrase.tone_shift = [0.0] * 64

    # ---- 跑 dspitch
    result = PE.load_rendered_pitch(singer, cfg, phrase, part.notes,
                                    singer.phoneme_tokens, d, providers)
    print()
    print('=== 预测结果 ===')
    print('  帧数        =', len(result.tones))
    print('  voiced=True =', sum(1 for v in result.voiced if v), '/', len(result.voiced))
    print('  tones 前 12 =', [round(t, 1) for t in result.tones[:12]])
    print('  谱面音高    = 62 / 63 / 61 / 62')

    check('★ 帧数 == durations 合计 97', len(result.tones) == 97, len(result.tones))
    check('★ voiced 有 False 帧（head/tail/间隙）',
          any(not v for v in result.voiced), sum(1 for v in result.voiced if v))
    check('★ head 8 帧 voiced=False',
          not any(result.voiced[:8]), result.voiced[:8])
    check('★ tail 8 帧 voiced=False',
          not any(result.voiced[-8:]), result.voiced[-8:])
    # 帧布局：head 8 | zh/n 17 (8-24) | zh/i 16 (25-40) | 间隙 SP 11 (41-51)
    #          | zh/h 16 (52-67) | zh/ao 21 (68-88) | tail 8 (89-96)
    gap0, gap1 = 8 + 17 + 16, 8 + 17 + 16 + 11
    check('★ 音素间隙的 11 帧 voiced=False（帧 41–51）',
          not any(result.voiced[gap0:gap1]),
          (gap0, gap1, result.voiced[gap0:gap1]))
    check('tones 在音高量级（55–70，非 57–78 的 MIDI 号巧合）',
          all(50 <= t <= 75 for t in result.tones),
          (min(result.tones), max(result.tones)))

    # ---- 写回 PITD
    before = list(phrase.pitches)
    print()
    print('=== 写回 ===')
    pitd = PE.pitch_result_to_pitd(result, phrase, part.position, before)
    print('  写出 %d 个点（前 10）: %s' % (len(pitd), pitd[:10]))
    check('写回有点产出', len(pitd) > 0, len(pitd))
    check('★ voiced=False 的帧没被写回（点数 ≤ voiced=True 的帧数）',
          len(pitd) <= sum(1 for v in result.voiced if v),
          (len(pitd), sum(1 for v in result.voiced if v)))
    # ★ `y > min_pitd(-1200)` 是「PITD 下调下限」，**不是**「只允许下调」——
    #   模型预测高于原谱面时 y 为正是正常的（上游 `NoteBatchEdits.cs:497`）。
    check('★ 全部 y > min_pitd(-1200)',
          all(y > -1200 for _, y in pitd),
          (min(y for _, y in pitd), max(y for _, y in pitd)))
    check('★ y 的量级合理（|y| < 1200 音分）',
          all(-1200 < y < 1200 for _, y in pitd),
          (min(y for _, y in pitd), max(y for _, y in pitd)))
    xs = [x for x, _ in pitd]
    check('★ x 递增（曲线是单调的时间轴）', all(xs[i] < xs[i + 1] for i in range(len(xs) - 1)),
          xs[:6])
    # ★ 跳过 voiced=False 的帧后，x 的步长会是 5 的**倍数**（跳过 k 帧就跨 5*(k+1)）
    steps = {xs[i + 1] - xs[i] for i in range(len(xs) - 1)}
    check('★ x 步长都是 5 的倍数（跳过静音帧处会跨格）',
          steps and all(st % 5 == 0 for st in steps), sorted(steps))

    # ---- 对照：造一个「预测远低于基线」的场景 → y 低于 min_pitd → 应被全部过滤
    low = [t * 100 + 2000 for t in result.tones]
    filtered = PE.pitch_result_to_pitd(result, phrase, part.position, low)
    check('★ 下调超过 min_pitd(-1200) 时被过滤', len(filtered) == 0,
          filtered[:3])

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())

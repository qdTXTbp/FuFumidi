# -*- coding: utf-8 -*-
r"""P2 阶段门：只跑 A 层（音素化器），与上游逐项比对。

用 `C:\Users\26276\Desktop\Export\0.ustx` 的 4 音谱面（上游自己导出的那份），
校验音素序列、`word_div` / `word_dur`、`positionMs` / `durationMs`。

★ 这段完全确定性（只有 `dsdur` 的 ONNX 推理，无随机），所以最适合逐项对齐 ——
  两层（A/B）任何一层错都表现为"时长不对"，不隔离就无法定位是哪层。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from diffsinger import g2p as G, phonemizer as P, voicebank as V   # noqa: E402
from diffsinger.session import resolve_providers                    # noqa: E402
from singing.openutau.timeaxis import TimeAxis                     # noqa: E402
from singing.ustx.format import add_default_expressions            # noqa: E402
from singing.ustx.model import UNote, UProject, UTrack, UVoicePart  # noqa: E402
from singing.ustx import io as uio                                  # noqa: E402

_P, _F = [], []
BANK = os.environ.get('DIFFSINGER_TEST_BANK') or \
    r'C:\Users\26276\Downloads\Compressed\liu2_ying2'


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


# 上游 0.ustx 的谱面：resolution 480 / bpm 120
REF_NOTES = [(180, 180, 62, 'n'), (360, 180, 63, 'i'),
             (660, 180, 61, 'h'), (840, 240, 62, 'ao')]
# 手算（计划 §三）：padding 500ms 减在第 1 组上
EXP_WORD_DUR = [42, 16, 27, 16, 21]


def main():
    if not os.path.isdir(BANK):
        print('跳过：找不到声库 %s' % BANK)
        return 0

    # ---- 造一个只含这 4 音的工程（只为拿到 TimeAxis）
    p = UProject()
    p.file_path = os.path.join(os.environ.get('TEMP', '.'), '_p2_probe.ustx')
    p.name = 'probe'
    # ★ 必须与上游 0.ustx 一致（resolution 固定 480，bpm 120），否则所有 ms 值差 2 倍
    p.bpm = 120
    add_default_expressions(p)
    tr = UTrack.for_project(p)
    tr.track_no = 0
    p.tracks.append(tr)
    part = UVoicePart(track_no=0, position=0, name='probe')
    p.parts.append(part)
    for pos, dur, tone, lyric in REF_NOTES:
        part.notes.append(UNote(position=pos, duration=dur, tone=tone, lyric=lyric))
    part.duration = REF_NOTES[-1][0] + REF_NOTES[-1][1]

    axis = TimeAxis()
    axis.build_segments(p)
    fms = axis.tick_pos_to_ms_pos(480)
    # ★ 480 tick = **1 拍**；120bpm 下一拍是 500ms（不是 1000ms）
    check('TimeAxis: 480 tick @120bpm = %.1f ms（应为 500）' % fms,
          abs(fms - 500.0) < 1e-6, fms)

    # ---- 加载
    singer = V.load_singer(BANK)
    d, name = G.load_ds_g2p(singer.dur.root, 'zh', [])
    providers = resolve_providers('cpu')

    # ---- 逐项打印 A 层的中间量（这次是为了看清楚，不是断言）
    frame_ms = singer.dur.frame_ms
    notes = [[n] for n in part.notes]              # 一个字一个音符
    tokens_map = singer.phoneme_tokens

    print()
    print('=== A 层中间量 ===')
    syms = []
    for w in notes:
        s, _ = G.get_symbols(d, tokens_map, str(w[0].lyric), None, 'zh')
        syms.append(s)
    print('  每字音素:', syms)

    from diffsinger.phonemizer import (
        DEFAULT_PAUSE, PADDING_MS, PhonemesPerNote, DsPhoneme,
        cumulative_sum, frames_between_ticks, process_word)
    last = notes[-1][-1]
    end_tick = last.position + last.duration
    pp = [PhonemesPerNote(-1, notes[0][0].tone, [DsPhoneme('SP')])]
    note_ph_index = [1]
    for w in notes:
        wps = process_word(w, syms[len(note_ph_index) - 1], d, lambda n, i: '')
        pp[-1].phonemes.extend(wps[0].phonemes)
        pp.extend(wps[1:])
        note_ph_index.append(note_ph_index[-1] + sum(len(n.phonemes) for n in wps))
    pp.append(PhonemesPerNote(end_tick, last.tone))
    pp[0].position = axis.ms_pos_to_tick_pos(
        axis.tick_pos_to_ms_pos(pp[1].position) - PADDING_MS)

    print('  分组数 %d（= 音符数 %d + 2）' % (len(pp), len(notes)))
    print('  group ticks   =', [g.position for g in pp])
    print('  group 音素数   =', [len(g.phonemes) for g in pp])
    print('  音素序列       =', [x.symbol for g in pp for x in g.phonemes])

    word_div = [len(g.phonemes) for g in pp[:-1]]
    word_dur = [frames_between_ticks(axis, a.position, b.position, frame_ms)
                for a, b in zip(pp, pp[1:])]
    print('  word_div       =', word_div, ' 期望', [1, 1, 1, 1, 0])
    print('  word_dur       =', word_dur, ' 手算', EXP_WORD_DUR)
    print('  sum(word_div)  =', sum(word_div), ' tokens =', len(note_ph_index) - 1 + 1)

    print()
    print('=== 断言 ===')
    flat = [x.symbol for g in pp for x in g.phonemes]
    check('★ 分组数 == 音符数 + 2', len(pp) == len(notes) + 2, len(pp))
    check('★ 音素序列 == [SP, zh/n, zh/i, zh/h, zh/ao]',
          flat == ['SP', 'zh/n', 'zh/i', 'zh/h', 'zh/ao'], flat)
    check('★ 不是 ko/*（旧实现错在这）', not any(s.startswith('ko/') for s in flat), flat)
    check('  第 0 组是 SP + 位置为负（padding 500ms）',
          flat[0] == 'SP' and pp[0].position < 0, (flat[0], pp[0].position))
    # padding 500ms：pp[1] = 180 tick = 187.5ms → 187.5-500 = -312.5ms → -300 tick
    check('  第 0 组位置 == -300 tick（187.5ms − 500ms padding = −312.5ms）',
          pp[0].position == -300, pp[0].position)
    check('  末组是空、位置 == endTick',
          len(pp[-1].phonemes) == 0 and pp[-1].position == end_tick,
          (len(pp[-1].phonemes), pp[-1].position, end_tick))
    # ★ pp[:-1] 排除的是**终止组**（无音素），所以 5 个值全是 1
    check('  word_div == [1,1,1,1,1]（Take(N-1) 排除终止组）',
          word_div == [1, 1, 1, 1, 1], word_div)
    check('  ★ word_dur == 手算 %s' % EXP_WORD_DUR, word_dur == EXP_WORD_DUR, word_dur)

    # ---- 跑真实推理拿 UPhoneme
    print()
    print('=== 真实 dsdur 推理 ===')
    phones = P.process_part(singer, notes, axis, d, 'zh', providers, [])
    for ph in phones:
        print('  %-8s pos=%5d tick  posMs=%8.2f  durMs=%7.2f  endMs=%8.2f'
              % (ph.phoneme, ph.position, ph.position_ms, ph.duration_ms, ph.end_ms))
    check('产出 4 个音素', len(phones) == 4, len(phones))
    check('★ 音素符号正确',
          [x.phoneme for x in phones] == ['zh/n', 'zh/i', 'zh/h', 'zh/ao'],
          [x.phoneme for x in phones])
    check('★ 位置递增', all(phones[i].position < phones[i + 1].position
                            for i in range(len(phones) - 1)),
          [x.position for x in phones])
    check('★ 位置落在音符范围内（180..1080 tick）',
          all(0 <= x.position <= 1080 for x in phones),
          [x.position for x in phones])
    check('★ 时长为正', all(x.duration_ms > 0 for x in phones),
          [round(x.duration_ms, 1) for x in phones])
    span = phones[-1].end_ms - phones[0].position_ms
    print('  首音起 %.1f ms → 末音止 %.1f ms（跨度 %.1f ms）'
          % (phones[0].position_ms, phones[-1].end_ms, span))
    check('★ 跨度与谱面同量级（800–1400ms）', 700 < span < 1500, span)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())

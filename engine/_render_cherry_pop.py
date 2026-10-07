# -*- coding: utf-8 -*-
"""Cherry pop UST × 流萤（liu2_ying2，DiffSinger 多语言声库）渲染样片。

流程 = 应用同款 M1–M6 管线（session.render_notes 的工程版）：
  formats.read_project 加载 .ust → 清洗 UTAU VCV 歌词 → 流萤声库 + ja 音素化
  → PhraseSource 切句 → DiffSingerRenderer（dsdur→variance→acoustic→vocoder）
  → MixPlanner 拼接 → WAV。
"""
import asyncio
import os
import re
import sys
import time

sys.path.insert(0, r'D:/FuFuMIDI/FuFumidi/engine')

UST = r'C:/Users/26276/Downloads/Compressed/Cherry pop UST/Cherry pop UST/Cherry pop UST/MAIN.ust'
BANK = r'C:/Users/26276/Downloads/Compressed/liu2_ying2'
OUT = r'D:/FuFuMIDI/FuFumidi/_artifacts/cherry_pop_liuying_preview.wav'

#: 渲染从第一个演唱音符起的这么多秒（CPU 渲染耗时可控；负数 = 整曲）
SECONDS = float(os.environ.get('RENDER_SECONDS', '30'))

# UTAU VCV："- あ" / "a た" / "i ちぇ"；尾部可能带音高注释 "とE4"
_PITCH_SUFFIX = re.compile(r'[A-G][#b]?\d+$')


def clean_lyric(lyric: str):
    """VCV 歌词 → 纯音节；休止/未知返回 None（该音符从渲染中剔除）。"""
    s = (lyric or '').strip()
    if not s or s in ('R', 'r', 'x', 'X'):
        return None
    s = s.split()[-1]              # 去掉 VCV 前音连接部分
    s = _PITCH_SUFFIX.sub('', s)   # 去掉音高后缀（とE4 → と）
    return s or None


def main():
    from singing.ustx.formats import read_project
    from singing.ustx.model import UVoicePart

    print('=== 加载工程 ===')
    proj = read_project([UST])
    part = next(p for p in proj.parts if isinstance(p, UVoicePart))
    track = proj.tracks[part.track_no]
    print('  %s  tempo=%s  音符=%d' % (os.path.basename(UST),
          [(t.position, t.bpm) for t in proj.tempos], len(part.notes)))

    # ---- 清洗歌词 + 切片（保留原始 tick 时间轴；休止即音素化管线里的空隙）
    from singing.openutau.timeaxis import TimeAxis
    axis = TimeAxis()
    axis.build_segments(proj)
    first = part.notes[0].position
    cleaned = []
    for n in part.notes:
        lrc = clean_lyric(n.lyric)
        if lrc is None:
            continue
        if SECONDS > 0 and axis.tick_pos_to_ms_pos(n.position - first) > SECONDS * 1000:
            break
        n.lyric = lrc
        cleaned.append(n)
    part.notes = cleaned
    for n in part.notes:
        n.prev = n.next = n.extends = None
    span_s = axis.ms_between_tick_pos(part.notes[0].position,
                                      part.notes[-1].position + part.notes[-1].duration) / 1000.0
    print('  清洗后 %d 个音符，覆盖 %.1f 秒（歌词样例 %s）'
          % (len(cleaned), span_s, [n.lyric for n in cleaned[:8]]))

    # ---- 罗马字化：DS 日文词典（dsdict-ja.yaml）按**罗马字**查表，
    #      假名要先过 JapaneseMonophoneG2p（与上游 DiffSinger 日文链路一致）
    from singing.openutau.g2p.japanese_monophone import JapaneseMonophoneG2p
    g2p_ja = JapaneseMonophoneG2p()
    n_miss = 0
    for n in part.notes:
        # ★ query 返回音素列表（'が'→['g','a']）——必须全量拼接成音节 'ga'；
        #   只取 rom[0] 会把假名截成辅音（发音完全不对）。'N'→'n' 对齐 dsdict key。
        rom = g2p_ja.query(n.lyric)
        if rom:
            n.lyric = ''.join('n' if x == 'N' else x for x in rom)
        else:
            n_miss += 1
    print('  罗马字化：样例 %s  未命中 %d/%d'
          % ([n.lyric for n in part.notes[:8]], n_miss, len(part.notes)))

    # ---- 声库 + 渲染器（与 render_notes 相同的装配）
    from diffsinger import voicebank as VB
    from singing.openutau.diffsinger.session import SingerAdapter, phonemize
    from singing.openutau.diffsinger.diffsinger_renderer import DiffsingerIRenderer
    from singing.openutau.diffsinger.render_engine import (
        MixPlanner, build_render_requests, render_requests,
    )
    from singing.openutau.pipeline_source import PhraseSource
    from diffsinger.pipeline import write_wav

    print('=== 声库：%s ===' % os.path.basename(BANK))
    singer = SingerAdapter(VB.load_singer(BANK))
    track.singer_obj = singer
    track.language = 'ja'
    renderer = DiffsingerIRenderer(cache_dir=None)
    renderer.depth = 1.0
    renderer.steps = 20
    track.renderer_settings.renderer_obj = renderer

    print('=== 音素化（ja）===')
    t0 = time.time()
    n_ph = phonemize(part, singer, proj, track=track, language='ja')
    print('  %d 音素，耗时 %.1f 秒' % (n_ph, time.time() - t0))
    if not n_ph:
        print('没有音素 —— 歌词与声库语言不匹配？')
        return 1

    print('=== 切句 + 渲染 ===')
    src = PhraseSource.from_part(proj, track, part, generation=0)
    phrases = src.build_phrases()
    print('  %d 个乐句' % len(phrases))
    _by_part = {id(part): phrases}
    reqs = build_render_requests([part], get_phrases=lambda p: _by_part[id(p)])

    async def _run():
        return await render_requests(reqs)

    t0 = time.time()
    results = asyncio.run(_run())
    print('  渲染 %d/%d 句，耗时 %.1f 秒' % (
        len(results), len(phrases), time.time() - t0))
    if not results:
        print('渲染无结果')
        return 1

    planner = MixPlanner()
    for o in results:
        planner.register_pcm(o['part'], o['hash'], o['offset_ms'],
                             o['estimated_length_ms'], 1.0, o['samples'])
    mix = planner.get_result()
    samples = mix['samples']
    sr = planner.sample_rate
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    write_wav(OUT, samples.tolist(), sr)
    peak = (max(abs(float(v)) for v in samples) if len(samples) else 0.0)
    print('\n✓ 已写出 %s（%.1f 秒，%d Hz，峰值 %.0f%%）'
          % (OUT, len(samples) / sr, sr, 100 * peak))
    return 0


if __name__ == '__main__':
    sys.exit(main())

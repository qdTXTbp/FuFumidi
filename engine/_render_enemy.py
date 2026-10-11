# -*- coding: utf-8 -*-
"""ENEMy.ustx × 流萤（liu2_ying2）渲染样片 —— 原生 ustx 工程直渲。

与 Cherry pop 脚本的区别：
* 工程是原生 ustx（read_project 直接吃），音符自带 pitch 弯音点 + UVibrato，
  M1–M6 管线（pipeline_source → render_phrase）会原样带上，无需任何转换。
* 轨道原 renderer=CLASSIC（足立レイ/重音テト，本机无）→ 换流萤 DS 演唱，
  歌词已是纯假名（ustx 无 VCV 前音连接符），只需罗马字化。
"""
import asyncio
import os
import re
import sys
import time

sys.path.insert(0, r'D:/FuFuMIDI/FuFumidi/engine')

USTX = r'C:/Users/26276/Downloads/Compressed/ENEMy/ENEMy.ustx'
BANK = r'C:/Users/26276/Downloads/Compressed/liu2_ying2'
OUT = r'D:/FuFuMIDI/FuFumidi/_artifacts/enemy_liuying_preview.wav'
TRACK = int(os.environ.get('RENDER_TRACK', '0'))
SECONDS = float(os.environ.get('RENDER_SECONDS', '30'))


def main():
    from singing.ustx.formats import read_project
    from singing.ustx.model import UVoicePart

    print('=== 加载工程 ===')
    proj = read_project([USTX])
    part = next(p for p in proj.parts
                if isinstance(p, UVoicePart) and p.track_no == TRACK)
    track = proj.tracks[TRACK]
    print('  %s  tempo=%s  轨=%s  part.position=%d  音符=%d'
          % (os.path.basename(USTX), [(t.position, t.bpm) for t in proj.tempos],
             track.track_name, part.position, len(part.notes)))
    n_pitch = sum(len(n.pitch.data) for n in part.notes)
    n_vib = sum(1 for n in part.notes if n.vibrato and n.vibrato.length)
    print('  弯音点 %d  颤音音符 %d（原生带进渲染管线）' % (n_pitch, n_vib))

    # ---- 剔除休止 + 罗马字化 + 切片
    from singing.openutau.timeaxis import TimeAxis
    axis = TimeAxis()
    axis.build_segments(proj)
    from singing.openutau.g2p.japanese_monophone import JapaneseMonophoneG2p
    g2p_ja = JapaneseMonophoneG2p()

    abs0 = part.position + part.notes[0].position
    kept, n_miss = [], 0
    for n in part.notes:
        lrc = (n.lyric or '').strip()
        if not lrc or lrc == 'R':
            continue
        if SECONDS > 0 and axis.tick_pos_to_ms_pos(part.position + n.position - abs0) > SECONDS * 1000:
            break
        # ★ query 返回**音素列表**（'が'→['g','a']），必须**全量拼接**成音节
        #   'ga' 再喂 dsdict（key 是音节级罗马字）。只取 rom[0] 会把所有假名
        #   截成辅音（'が'→'g'）——发音完全不对的根因。
        #   拨音 'N' 归一成 'n'（dsdict-ja 的 key 用 'n' → ja/N）。
        rom = g2p_ja.query(lrc)
        if rom:
            n.lyric = ''.join('n' if x == 'N' else x for x in rom)
        else:
            n_miss += 1
        kept.append(n)
    part.notes = kept
    span_s = axis.ms_between_tick_pos(part.position + kept[0].position,
                                      part.position + kept[-1].position + kept[-1].duration) / 1000.0
    print('  保留 %d 音符（%.1f 秒），歌词样例 %s，罗马字未命中 %d'
          % (len(kept), span_s, [n.lyric for n in kept[:8]], n_miss))

    # ---- 声库 + 渲染器（M1–M6 装配，与 session.render_notes 相同）
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
        print('没有音素')
        return 1
    print('  音素样例: %s' % [p.phoneme for p in part.phonemes[:10]])

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

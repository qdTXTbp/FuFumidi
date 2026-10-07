# -*- coding: utf-8 -*-
"""表达式曲线 → UTAU 渲染通路测试（engine_openutau.build_part 的曲线挂载）。

★ 钉死「画了曲线渲染不理」的断层：应用侧 `track.curves`（DYN/BRE/GEN）此前
  只被采样成逐音符起点值，**连续曲线从未进过渲染**。现在 build_part 把它转成
  UCurve 挂上 part.curves，render_phrase 从那里采样（dyn→dynamics、genc→gender、
  brec→breathiness）。

三个硬语义：
  1. 坐标：beat × 480 = part 内 tick（part.position 恒 0）
  2. DYN 单位：前端 0..100 → ustx 0.1dB（-240..0），`ustx = round(v×2.4) − 240`
  3. GEN/genc 同为 -100..100 直传；BRE 直传正半轴

可离线运行：python engine/tests/test_curve_render.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

PASS = 0


def check(cond, msg):
    global PASS
    if not cond:
        raise AssertionError(msg)
    PASS += 1
    print('  ok -', msg)


def main():
    import engine_openutau as EOU
    from singing.openutau.pipeline_source import CurveSource
    from singing.openutau.render_phrase import _curve_convert, _sample_curve

    proj = EOU.build_project(120.0)
    curves = [
        {'abbr': 'DYN', 'points': [{'beat': 0, 'value': 100},
                                   {'beat': 4, 'value': 50},
                                   {'beat': 8, 'value': 0}]},
        {'abbr': 'GEN', 'points': [{'beat': 0, 'value': -30}, {'beat': 2, 'value': 40}]},
        {'abbr': 'BRE', 'points': [{'beat': 1, 'value': 60}]},
        {'abbr': 'VOL', 'points': [{'beat': 0, 'value': 80}]},      # playback 模式 → 不进引擎
        {'abbr': 'PIT', 'points': [{'beat': 0, 'value': 100}, {'beat': 1, 'value': -60}]},
        # ↑ PIT（轨级音高偏差，音分）现在**进引擎**：→ ustx 的 pitd，render_phrase
        #   会对渲染音高做 pitches[i] += pitd.sample(...)（音分偏差，语义与上游一致）
        'garbage', None,
    ]
    part = EOU.build_part(proj, proj.tracks[0], [], tpb=480, curves=curves)

    print('[build_part] 曲线挂载')
    by_abbr = {c.abbr: c for c in part.curves}
    check('dyn' in by_abbr and 'genc' in by_abbr and 'brec' in by_abbr,
          'DYN/GEN/BRE 三条曲线挂上 part.curves')
    check('vol' not in by_abbr, 'VOL（播放侧）不进引擎')
    check('pitd' in by_abbr and list(zip(by_abbr['pitd'].xs, by_abbr['pitd'].ys))
          == [(0, 100), (480, -60)], 'PIT 音分偏差 → pitd 曲线（beat×tpb tick）')

    dyn = by_abbr['dyn']
    check(list(dyn.xs) == [0, 1920, 3840], 'beat→tick 坐标（×480）')
    check(list(dyn.ys) == [0, -120, -240], 'DYN 单位转换 100→0 / 50→-120 / 0→-240（0.1dB）')
    check(dyn.descriptor is not None and dyn.descriptor.abbr == 'dyn', 'descriptor 挂上（渲染采样要用）')

    gen = by_abbr['genc']
    check(list(gen.ys) == [-30, 40], 'GEN 直传（同为 -100..100）')
    check(list(by_abbr['brec'].ys) == [60], 'BRE 直传正半轴')

    print('[render_phrase] 采样与 DYN 换算')
    src = CurveSource.of(dyn, 0)
    check(src.sample(0) == 0, 'tick 0 → 0（0dB 全音量）')
    check(src.sample(960) == -60, '两点间线性插值（tick 960 = beat 2 → -60）')
    check(_curve_convert(0, src) > 0.99, 'DYN 0（0dB）→ 线性 ≈1.0')
    check(_curve_convert(-240, src) == 0.0, 'DYN min（-240）→ 线性 0（静音帧）')
    sampled = _sample_curve(src, 0, 16, _curve_convert)
    check(len(sampled) == 16 and all(isinstance(x, float) for x in sampled),
          '_sample_curve 按 5-tick 间隔采样成 float 数组')

    print('[build_part] 占位 dyn 曲线逻辑')
    part_noc = EOU.build_part(proj, proj.tracks[0], [], tpb=480, curves=None)
    check(any(c.abbr == 'dyn' for c in part_noc.curves),
          '无曲线时保留占位 dyn（旧行为不破坏）')
    check(len([c for c in part.curves if c.abbr == 'dyn']) == 1,
          '有真实 dyn 曲线时不挂占位（顶掉用户曲线就是 bug）')

    print('[CLI] notes JSON dict 形态')
    notes, curves_out = EOU._load_notes('{"notes":[{"startBeat":0,"durBeat":1,"pitch":60}],'
                                        '"curves":[{"abbr":"DYN","points":[{"beat":0,"value":80}]}]}')
    check(len(notes) == 1 and curves_out and curves_out[0]['abbr'] == 'DYN',
          '{notes, curves} dict 形态双双取出')
    notes2, curves2 = EOU._load_notes('[{"startBeat":0}]')
    check(len(notes2) == 1 and curves2 is None, '裸数组形态兼容（curves=None）')

    print('\nALL PASS (%d checks)' % PASS)


if __name__ == '__main__':
    main()

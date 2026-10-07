# -*- coding: utf-8 -*-
"""多点变速（tempoMap）渲染链路测试 —— 离线可跑，不加载任何模型。

测的是「**拍→tick 与 tempo 无关；tick→ms 由 TimeAxis 沿段换算**」这一铁律在
三条链路上都成立：

  1. UTAU 管线（engine_openutau.build_project / build_part）
     ★ build_part 旧实现走 `startBeat × 60000/bpm → ms → tick` 弯路，单点时
       数值巧合相等，多点下全部错位 —— 这里用 8 拍后降速的工程钉死该回归。
  2. DiffSinger 旧管线（diffsinger.pipeline._make_axis）
  3. DiffSinger M1–M6 管线（singing/openutau/diffsinger/session.build_project）

可离线运行：python engine/tests/test_multi_tempo_render.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

PASS = 0

#: 多点变速：0 拍 120bpm，8 拍起 90bpm
TEMPOS = [{'beat': 0, 'bpm': 120}, {'beat': 8, 'bpm': 90}]


def check(cond, msg):
    global PASS
    if not cond:
        raise AssertionError(msg)
    PASS += 1
    print('  ok -', msg)


def approx(a, b, tol=1e-3):
    return abs(a - b) <= tol


def main():
    # ---------------- 共同的期望值（手算）：
    # beat 8  = tick 3840 = 4.0s（0..8 拍 @120bpm，60/120=0.5s/拍）
    # beat 10 = tick 4800；tick→ms = 4000 + (2 拍 @90bpm)×(60/90)×1000 = 4000+1333.33
    beat10_ms = 4000.0 + 2.0 * (60.0 / 90.0) * 1000.0        # ≈ 5333.33

    print('[openutau] build_project + build_part')
    import engine_openutau as EOU

    proj = EOU.build_project(120.0, TEMPOS)
    check(len(proj.tempos) == 2, 'tempos 两点')
    check(proj.tempos[1].position == 8 * 480 and proj.tempos[1].bpm == 90,
          '第二点 8 拍处 90bpm（beat→tick 直换）')
    axis = proj.time_axis
    check(approx(axis.tick_pos_to_ms_pos(8 * 480), 4000.0), 'beat 8 → 4.0s')
    check(approx(axis.tick_pos_to_ms_pos(10 * 480), beat10_ms), 'beat 10 → 5333.3ms（沿段换算）')

    track = proj.tracks[0]
    part = EOU.build_part(proj, track, [
        {'startBeat': 10, 'durBeat': 1, 'pitch': 60, 'lyric': 'あ'},
        {'startBeat': 2, 'durBeat': 1, 'pitch': 62, 'lyric': 'か'},
    ], tpb=480)
    check(part.notes[0].position == 10 * 480,
          '降速段音符起点 = 4800 tick（旧 ms 弯路会算成 4560 —— 回归钉死）')
    check(part.notes[1].position == 2 * 480, '首段音符起点 = 960 tick')

    # 单点 tempo_map 缺省：行为与旧实现一致（不破坏老调用）
    proj1 = EOU.build_project(96.0, None)
    check(len(proj1.tempos) == 1 and proj1.tempos[0].bpm == 96, '无 tempo_map 时单点 bpm 兜底')

    print('[diffsinger] pipeline._make_axis')
    from diffsinger.pipeline import _make_axis
    notes = [{'startBeat': 10, 'durBeat': 1, 'pitch': 60, 'lyric': '啊'}]
    axis2, proj2 = _make_axis({'bpm': 120.0, 'tempos': TEMPOS}, notes)
    check(proj2.tempos[1].position == 8 * 480, '第二点 8 拍处')
    check(approx(axis2.tick_pos_to_ms_pos(10 * 480), beat10_ms), 'tick→ms 沿段换算')
    check(proj2.parts[0].notes[0].position == 10 * 480, '音符位置 4800 tick（与 tempo 无关）')

    axis3, proj3 = _make_axis({'bpm': 110.0}, notes)
    check(len(proj3.tempos) == 1 and proj3.tempos[0].bpm == 110, '无 tempos 时单点兜底')

    print('[diffsinger] session.build_project / render 入口签名')
    from singing.openutau.diffsinger.session import build_project
    proj4, _tr, part4 = build_project(notes, 120.0, 'zh', tempos=TEMPOS)
    check(len(proj4.tempos) == 2 and proj4.tempos[1].bpm == 90, 'M1–M6 管线 tempos 两点')
    check(part4.notes[0].position == 10 * 480, '音符位置 4800 tick')
    check(approx(proj4.time_axis.tick_pos_to_ms_pos(10 * 480), beat10_ms), '时间轴沿段换算')

    # 非法 tempoMap 不拖垮渲染（坏点丢弃 + 空表兜底）
    proj5, _tr5, _p5 = build_project(notes, 120.0, 'zh',
                                     tempos=[{'beat': -1, 'bpm': 999}, 'x', None])
    check(len(proj5.tempos) == 1 and proj5.tempos[0].bpm == 120, '全坏 tempos → 单点兜底')

    print('\nALL PASS (%d checks)' % PASS)


if __name__ == '__main__':
    main()

# -*- coding: utf-8 -*-
"""颤音 8 参在**渲染链路**上的映射测试（engine_openutau.build_part /
diffsinger session.build_project）—— 离线可跑，不加载任何模型。

★ 钉死一个真实存量 bug：旧 `build_part` 给 UVibrato 传了不存在的
  `length_in/length_out` 参数 → dataclass 抛 TypeError 被 except 吞掉 →
  颤音从未构造成功（恒为默认 length=0 = **关**）。UTAU 管线的颤音
  一直是哑的。这里断言 `length == 100`，改回去立刻红。

可离线运行：python engine/tests/test_vibrato_link.py
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


FULL = {
    'startBeat': 0, 'durBeat': 1, 'pitch': 60, 'lyric': 'あ',
    'vibrato': True, 'vibDepth': 40, 'vibFreq': 5.0, 'vibFade': 0,
    'vibIn': 20, 'vibOut': 10, 'vibShift': 25, 'vibDrift': -30, 'vibVolLink': 10,
}
LEGACY = {
    'startBeat': 0, 'durBeat': 1, 'pitch': 60, 'lyric': 'あ',
    'vibrato': True, 'vibDepth': 40, 'vibFreq': 5.0, 'vibFade': 15,
}


def main():
    print('[openutau] build_part')
    import engine_openutau as EOU

    proj = EOU.build_project(120.0)
    part = EOU.build_part(proj, proj.tracks[0], [FULL], tpb=480)
    vib = part.notes[0].vibrato
    check(vib is not None and vib.length == 100,
          '★ 颤音真正构造成功（旧实现 TypeError 吞掉 → length 恒 0 = 哑）')
    check(vib.period == 200.0, '5Hz → 200ms')
    check(vib.depth == 40.0, 'depth 直传')
    check(vib.vib_in == 20.0 and vib.vib_out == 10.0, 'in/out 分离')
    check(vib.shift == 25.0 and vib.drift == -30.0 and vib.vol_link == 10.0,
          'shift/drift/volLink 进 UVibrato')

    part2 = EOU.build_part(proj, proj.tracks[0], [LEGACY], tpb=480)
    vib2 = part2.notes[0].vibrato
    check(vib2.vib_in == 15.0 and vib2.vib_out == 15.0,
          '旧工程只有 vibFade → in=out 兜底')

    off = EOU.build_part(proj, proj.tracks[0],
                         [{'startBeat': 0, 'durBeat': 1, 'pitch': 60,
                           'lyric': 'あ', 'vibrato': False}], tpb=480)
    check(off.notes[0].vibrato is None or off.notes[0].vibrato.length == 0,
          'vibrato=false → 颤音关')

    print('[diffsinger] session.build_project')
    from singing.openutau.diffsinger.session import build_project
    proj3, _tr, part3 = build_project([FULL], 120.0, 'zh')
    vib3 = part3.notes[0].vibrato
    check(vib3 is not None and vib3.length == 100, 'length 显式 100（不再塞 tick 数）')
    check(vib3.period == 200.0 and vib3.depth == 40.0, 'period/depth 映射')
    check(vib3.vib_in == 20.0 and vib3.vib_out == 10.0, 'in/out 分离')
    check(vib3.shift == 25.0 and vib3.drift == -30.0 and vib3.vol_link == 10.0,
          'shift/drift/volLink 映射')

    # in/out 互约束（C# setter 语义：out ≤ 100 − in）—— 通过 UVibrato setter 天然生效
    over = dict(FULL, vibIn=70, vibOut=50)
    proj4, _tr, part4 = build_project([over], 120.0, 'zh')
    vib4 = part4.notes[0].vibrato
    check(vib4.vib_in + vib4.vib_out <= 100.0 + 1e-6,
          'in/out 互约束（in=70/out=50 → 和 ≤ 100）')

    print('\nALL PASS (%d checks)' % PASS)


if __name__ == '__main__':
    main()

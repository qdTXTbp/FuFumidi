# -*- coding: utf-8 -*-
"""per-note 参数（velocity/volume/gender/breath）→ 音素级表达式测试。

★ 钉死「属性面板调了没反应」的断层：这些参数一直被前端传给引擎，
  但 build_part 从没消费过（UNote 模型也没有这些字段）。现在 build_part /
  session.build_project 把原始 JSON 挂在 `UNote._app_note`，音素化之后由
  `note_expressions.apply_note_expressions` 写成音素级表达式
  （vel / vol / genc / brec），渲染链路 `phoneme.get_expression` 直接消费。

★ 时机语义：表达式按音素 index 匹配 → 必须音素化后挂。离线测试手工造
  UPhoneme（不需要声库）。

可离线运行：python engine/tests/test_note_expressions.py
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


def make_phonemes(part, note, indexes):
    """手工造 canonical UPhoneme（parent/index 铺好，等同音素化产物）。"""
    from singing.openutau.phoneme import UPhoneme
    for i in indexes:
        ph = UPhoneme()
        ph.parent = note
        ph.index = i
        part.phonemes.append(ph)


def main():
    import engine_openutau as EOU
    from singing.openutau.format import Ustx
    from singing.openutau.note_expressions import apply_note_expressions

    print('[openutau] build_part → apply_note_expressions → get_expression')
    proj = EOU.build_project(120.0)
    track = proj.tracks[0]
    full = {'startBeat': 0, 'durBeat': 1, 'pitch': 60, 'lyric': 'あ',
            'velocity': 80, 'volume': 60, 'gender': -30, 'breath': 45}
    bare = {'startBeat': 2, 'durBeat': 1, 'pitch': 62, 'lyric': 'か'}
    part = EOU.build_part(proj, track, [full, bare], tpb=480)
    n1, n2 = part.notes
    check(getattr(n1, '_app_note', None) is full, '原始 JSON 挂在 _app_note')
    make_phonemes(part, n1, [0, 1])       # 两个音素
    make_phonemes(part, n2, [0])

    count = apply_note_expressions(proj, track, part)
    check(count == 4 * 2, '音符 1 挂 4 项 × 2 音素 = 8 条（音符 2 无参数不挂）')

    # 消费端反查：get_expression 的匹配逻辑与渲染链路一字不差
    ph0 = part.phonemes[0]
    v, is_set = ph0.get_expression(proj, track, Ustx.VEL)
    check(v == 80.0 and is_set, 'vel=80 显式生效（渲染里 → resampler 速度）')
    v, is_set = ph0.get_expression(proj, track, Ustx.VOL)
    check(v == 60.0 and is_set and abs(v * 0.01 - 0.6) < 1e-9, 'vol=60 → 线性 0.6（包络幅度）')
    v, _ = ph0.get_expression(proj, track, Ustx.GENC)
    check(v == -30.0, 'genc=-30（resampler flag g）')
    v, _ = ph0.get_expression(proj, track, Ustx.BREC)
    check(v == 45.0, 'brec=45（resampler flag B）')
    # 同一音符的第二个音素同样生效（音符级值 → 全音素）
    v, is_set = part.phonemes[1].get_expression(proj, track, Ustx.VEL)
    check(v == 80.0 and is_set, '音符级值覆盖该音符全部音素')
    # 没传参数的音符 → 描述符默认值（不假装生效）
    v, is_set = part.phonemes[2].get_expression(proj, track, Ustx.VEL)
    check(v == 100.0 and not is_set, '无参数音符回默认 vel=100（非显式）')

    print('[diffsinger] session.build_project → apply')
    from singing.openutau.diffsinger.session import build_project
    proj2, _tr, part2 = build_project([full], 120.0, 'zh')
    check(getattr(part2.notes[0], '_app_note', None) is full, 'DS 管线同样挂 _app_note')
    make_phonemes(part2, part2.notes[0], [0])
    apply_note_expressions(proj2, _tr, part2)
    v, is_set = part2.phonemes[0].get_expression(proj2, _tr, Ustx.VOL)
    check(v == 60.0 and is_set, 'DS 侧 vol 显式生效（volume 进包络）')


    print('[phoneme override] build_part / session 映射')
    from singing.openutau.phoneme import UPhoneme as _UP
    ov_note = {'startBeat': 0, 'durBeat': 2, 'pitch': 60, 'lyric': 'あ',
               'phonemeOverrides': [
                   {'index': 0, 'offset': 100, 'preutterDelta': -5, 'overlapDelta': 10},
                   {'index': 1, 'offset': -50},
                   {'index': 7, 'offset': 30},        # index 无界也照挂（渲染侧按实际音素数忽略）
                   'x', {'index': -1}, {'index': 2},  # 坏条目 / 无值条目
               ]}
    part5 = EOU.build_part(proj, track, [ov_note], tpb=480)
    on = part5.notes[0]
    check(len(on.phoneme_overrides) == 3, '3 条有效覆写挂上（坏条目/无值条目丢弃）')
    # 精确换算：120bpm → 0.5s/拍 → 480 tick；100ms = 0.1s → 96 tick
    o0 = next(o for o in on.phoneme_overrides if o.index == 0)
    check(o0.offset == 96, 'offset 100ms @120bpm → 96 tick（480×0.1/0.5）')
    check(o0.preutter_delta == -5.0 and o0.overlap_delta == 10.0, 'delta 直传 ms 域')
    o1 = next(o for o in on.phoneme_overrides if o.index == 1)
    check(o1.offset == -48, '负偏移 -50ms → -48 tick')

    proj6, _tr6, part6 = build_project([ov_note], 120.0, 'zh')
    on6 = part6.notes[0]
    check(len(on6.phoneme_overrides) == 3, 'DS 管线同样挂 3 条')
    o06 = next(o for o in on6.phoneme_overrides if o.index == 0)
    check(o06.offset == 96, 'DS 侧 offset 100ms → 96 tick')

    print('\nALL PASS (%d checks)' % PASS)


if __name__ == '__main__':
    main()

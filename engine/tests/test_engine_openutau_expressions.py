# -*- coding: utf-8 -*-
"""每音符表达式是否真的落到音素上（对齐 OpenUTAU 的 Note.phonemeExpressions）。

造一个工程 + 轨道 + 一段音素，走 `build_part` 与 `UPhoneme.get_expression` 的真实路径，
断言：
  1. 传入 expressions 后，音符携带的 phoneme_expressions 覆盖到**每个**音素下标；
  2. 值被描述符夹到合法区间（如 atk 传 250 → 100）；
  3. 不传 expressions 时回落到轨道默认值（volume=100 / velocity=100 / shift=0）——
     守住「不传就是原行为」，避免改成默认全 0 把老工程静音。
  4. 识别不了的 abbr（如 'zzz'）被静默忽略，不抛异常。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import engine_openutau as eo  # noqa: E402
from singing.ustx import UTrack  # noqa: E402
from singing.openutau.phoneme import UPhoneme  # noqa: E402

_PASS, _FAIL = [], []


def check(label, cond, detail=''):
    (_PASS if cond else _FAIL).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def make_phonemes(part, track, project, note, count=3):
    """给音符造 count 个音素（下标 0..count-1），模拟音素化后的状态。

    ★ 真实音素化给每个音符分配的下标是 **0..本音符音素数-1**（见
      `test_openutau_core_matches_source.py` 的 `phoneme_indexes == [0]` 断言），
      所以音符级表达式落在 index 0 上，也就是**首个音素（通常是元音）**。
    """
    phs = []
    for i in range(count):
        ph = UPhoneme()
        ph.index = i
        ph.parent = note
        ph.phoneme = 'a'
        phs.append(ph)
    note.phoneme_indexes = list(range(count))
    return phs


def main():
    project = eo.build_project(bpm=120.0)
    track = UTrack(track_no=0)
    track.project = project

    print('--- 传 expressions：落到每个音素 ---')
    notes = [{'startBeat': 0.0, 'durBeat': 1.0, 'pitch': 69, 'lyric': 'a',
              'expressions': {'vol': 60, 'vel': 30, 'atk': 250, 'shft': 20, 'zzz': 1}}]
    part = eo.build_part(project, track, notes, tpb=480)
    check('音符被建出来', len(part.notes) == 1, len(part.notes))
    note = part.notes[0]
    got = [(e.index, e.abbr, round(float(e.value), 2)) for e in note.phoneme_expressions]
    check('表达式写到了音符的 phoneme_expressions 上', len(got) > 0, got)
    check('识别不了的 abbr 被忽略', all(a != 'zzz' for _, a, _ in got), got)

    phs = make_phonemes(part, track, project, note, count=3)
    first = phs[0]
    check('vol 落在首个音素上 = 60', first.get_expression(project, track, 'vol')[0] == 60.0,
          first.get_expression(project, track, 'vol'))
    check('vel 落在首个音素上 = 30', first.get_expression(project, track, 'vel')[0] == 30.0,
          first.get_expression(project, track, 'vel'))
    check('atk 被夹到描述符上限 100（传的是 250）',
          first.get_expression(project, track, 'atk')[0] == 100.0,
          first.get_expression(project, track, 'atk'))
    check('shft 落在首个音素上 = 20', first.get_expression(project, track, 'shft')[0] == 20.0,
          first.get_expression(project, track, 'shft'))
    check('第二个音素不受影响（仍是默认值）',
          phs[1].get_expression(project, track, 'vol')[0] == 100.0,
          phs[1].get_expression(project, track, 'vol'))
    check('显式设过的标记为 True（与上游 GetExpression 的 bool 一致）',
          first.get_expression(project, track, 'vol')[1] is True)

    print('--- 不传 expressions：回落轨道默认值（守住老行为）---')
    part2 = eo.build_part(project, track, [{'startBeat': 0.0, 'durBeat': 1.0,
                                            'pitch': 60, 'lyric': 'a'}], tpb=480)
    note2 = part2.notes[0]
    check('没有表达式项', len(note2.phoneme_expressions) == 0, note2.phoneme_expressions)
    phs2 = make_phonemes(part2, track, project, note2, count=1)
    check('vol 回落到默认 100', phs2[0].get_expression(project, track, 'vol')[0] == 100.0,
          phs2[0].get_expression(project, track, 'vol'))
    check('vel 回落到默认 100', phs2[0].get_expression(project, track, 'vel')[0] == 100.0,
          phs2[0].get_expression(project, track, 'vel'))

    print('--- 显式 phoneme_indexes：只作用在指定音素上 ---')
    part3 = eo.build_part(project, track, [
        {'startBeat': 0.0, 'durBeat': 1.0, 'pitch': 60, 'lyric': 'a',
         'expressions': {'vol': 42}, 'phoneme_indexes': [7]},
    ], tpb=480)
    idxs = [e.index for e in part3.notes[0].phoneme_expressions]
    check('index 用的是调用方给的下标', idxs == [7], idxs)

    print('--- 音素级覆盖 phoneme_expressions：同一音符里各音素取值不同 ---')
    part4 = eo.build_part(project, track, [
        {'startBeat': 0.0, 'durBeat': 1.0, 'pitch': 60, 'lyric': 'ka',
         'expressions': {'vol': 90},
         'phoneme_expressions': [
             {'index': 1, 'expressions': {'vol': 55, 'atk': 250}},   # 元音：轻一点 + atk 越界要夹住
             {'index': 0, 'expressions': {'vol': 100}},               # 辅音：原样
             {'index': 9, 'expressions': {'vol': 10}},                # 越界下标：留着但引擎侧不会命中
             {'index': 'x', 'expressions': {'vol': 10}},              # 下标非法：整条跳过
             {'index': 2},                                            # 没有 expressions：跳过
             'not-a-dict',                                            # 类型不对：跳过
         ]},
    ], tpb=480)
    note4 = part4.notes[0]
    got4 = sorted([(e.index, e.abbr, round(float(e.value), 2)) for e in note4.phoneme_expressions])
    check('音素级覆盖写到了对应下标上',
          (1, 'vol', 55.0) in got4 and (1, 'atk', 100.0) in got4, got4)
    # 4 条 = (0,vol,100) (1,atk,100) (1,vol,55) (9,vol,10)：
    #   非法下标 'x' / 缺 expressions / 非 dict 三类脏数据被跳过；
    #   音符级的 (0,vol,90) 因为被音素级覆盖而**不再重复下发**（见下一条断言）。
    check('非法/缺字段的条目被跳过，且被覆盖的下标不再重复下发',
          all(not isinstance(i, str) for i, _, _ in got4) and len(got4) == 4
          and (0, 'vol', 100.0) in got4 and (0, 'vol', 90.0) not in got4, got4)
    phs4 = make_phonemes(part4, track, project, note4, count=2)
    check('元音（下标 1）拿到音素级取值 55，而不是音符级的 90',
          phs4[1].get_expression(project, track, 'vol')[0] == 55.0,
          phs4[1].get_expression(project, track, 'vol'))
    check('辅音（下标 0）拿到自己的 100，不被元音覆盖',
          phs4[0].get_expression(project, track, 'vol')[0] == 100.0,
          phs4[0].get_expression(project, track, 'vol'))
    check('音符级 expressions 仍然生效（作为未覆盖音素的底）',
          'vol' in [a for _, a, _ in got4])

    print('--- 音素级覆盖的健壮性：整条都是脏数据也不该抛 ---')
    part5 = eo.build_part(project, track, [
        {'startBeat': 0.0, 'durBeat': 1.0, 'pitch': 60, 'lyric': 'a',
         'phoneme_expressions': 'nonsense'},
        {'startBeat': 1.0, 'durBeat': 1.0, 'pitch': 60, 'lyric': 'a',
         'phoneme_expressions': [None, 3, {'index': -1, 'expressions': {'vol': 1}}]},
    ], tpb=480)
    check('脏数据不抛异常、也不产生表达式项',
          len(part5.notes) == 2 and all(len(x.phoneme_expressions) == 0 for x in part5.notes),
          [len(x.phoneme_expressions) for x in part5.notes])

    print('\n结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
    return 0 if not _FAIL else 1


if __name__ == '__main__':
    sys.exit(main())

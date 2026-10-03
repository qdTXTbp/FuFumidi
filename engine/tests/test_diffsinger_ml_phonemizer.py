# -*- coding: utf-8 -*-
r"""ML 音素化器切句层的验收（M2）。

照搬基准：`OpenUtau.Core/MachineLearningPhonemizer.cs`
（`SetUp` :20-59、`Process` :62-84、`CleanUp` :86-89、`ChangeLyric` :100-113）。

★ 三个最容易照搬错的点，各有专门断言：
  1. 罗马化在**切句之前**
  2. 切句判据是 **tick 精确相等**（差 1 tick 就切）
  3. **单句异常不中断整首**；且末尾必须 flush（漏掉会丢最后一句）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.diffsinger.ml_phonemizer import (  # noqa: E402
    MLNote, MlPhonemizer,
)

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


def _collect(m):
    """接一个记录式的 process_part，返回记录列表。"""
    calls = []
    m.process_part = lambda phrase: calls.append([g[0].lyric for g in phrase])
    return calls


def main():
    print('--- 切句：参考谱面（180/360/660/840，各 180/180/180/240）---')
    m = MlPhonemizer()
    calls = _collect(m)
    m.set_up([[MLNote(180, 180, 62, 'n')], [MLNote(360, 180, 63, 'i')],
              [MLNote(660, 180, 61, 'h')], [MLNote(840, 240, 62, 'ao')]])
    check('★ 切成 2 句', len(calls) == 2, calls)
    check('  句1 = [n, i]（180+180==360 连排）', calls[0] == ['n', 'i'], calls[:1])
    check('  句2 = [h, ao]（360+180=540 ≠ 660 → 断开）', calls[1] == ['h', 'ao'],
          calls[1:])

    print()
    print('--- 边界：全连排 / 全断开 / 单字 ---')
    m2 = MlPhonemizer()
    c2 = _collect(m2)
    m2.set_up([[MLNote(0, 480, 60, 'a')], [MLNote(480, 480, 62, 'b')],
               [MLNote(960, 480, 64, 'c')]])
    check('★ 全连排 → 1 句 [a,b,c]', c2 == [['a', 'b', 'c']], c2)

    m3 = MlPhonemizer()
    c3 = _collect(m3)
    m3.set_up([[MLNote(i * 1000, 100, 60, 'x')] for i in range(4)])
    check('★ 每字都断开 → 4 句', c3 == [['x']] * 4, c3)

    m4 = MlPhonemizer()
    c4 = _collect(m4)
    m4.set_up([[MLNote(500, 100, 60, 'solo')]])
    check('★ 只有一个字 → 1 句（末尾 flush，:51-59）', c4 == [['solo']], c4)

    print()
    print('--- 切句判据是 tick 精确相等（差 1 tick 就切）---')
    m5 = MlPhonemizer()
    c5 = _collect(m5)
    # 480+480=960，但下一音在 961（差 1 tick）
    m5.set_up([[MLNote(0, 480, 60, 'a')], [MLNote(961, 480, 62, 'b')]])
    check('★ 差 1 tick → 切成 2 句（不是"小于阈值"）', len(c5) == 2, c5)

    m6 = MlPhonemizer()
    c6 = _collect(m6)
    # 0 + 480 == 480 —— 位置要落在 480（不是 960），才叫"恰好相等"
    m6.set_up([[MLNote(0, 480, 60, 'a')], [MLNote(480, 480, 62, 'b')]])
    check('★ 恰好相等 → 1 句', len(c6) == 1, c6)

    print()
    print('--- 罗马化在切句之前（:30-31）---')
    order = []
    m7 = MlPhonemizer()
    m7.romanize_impl = lambda lys: (order.append('romanize'), ['ni', 'hao'])[1]
    m7.process_part = lambda phrase: order.append(
        'part:' + ','.join(g[0].lyric for g in phrase))
    m7.set_up([[MLNote(0, 480, 60, '你')], [MLNote(480, 480, 62, '好')]])
    check('★ romanize 先于 process_part', order[0] == 'romanize', order)
    check('  process_part 收到的是**罗马化后**的歌词',
          order[1] == 'part:ni,hao', order)

    m8 = MlPhonemizer()
    seen = {}

    def _capture_phrase(phrase):
        g0 = phrase[0][0]
        seen['lyric'] = g0.lyric
        seen['position'] = g0.position
        seen['duration'] = g0.duration
        seen['tone'] = g0.tone
        seen['hint'] = g0.phonetic_hint

    m8.romanize_impl = lambda lys: ['pinyin-1']
    m8.process_part = _capture_phrase
    m8.set_up([[MLNote(180, 240, 67, '你', phonetic_hint='ni3')]])
    check('★ ChangeLyric 只换 lyric，position/duration/tone/phoneticHint 保留',
          seen == {'lyric': 'pinyin-1', 'position': 180, 'duration': 240,
                   'tone': 67, 'hint': 'ni3'}, seen)

    print()
    print('--- 单句异常不中断整首（:43-50）---')
    m9 = MlPhonemizer()
    seen_sent = []

    def _boom(phrase):
        text = ','.join(g[0].lyric for g in phrase)
        seen_sent.append(text)
        if text == 'b':
            raise RuntimeError('这句炸了')

    m9.process_part = _boom
    # ★ 三个字**互不连排**（各 100 长度、间隔 400）→ 3 句；
    #   若 a/b 位置连续会合并成一句，就测不到"异常不中断"了。
    m9.set_up([[MLNote(0, 100, 60, 'a')], [MLNote(500, 100, 62, 'b')],
               [MLNote(1000, 100, 64, 'c')]])
    check('★ 三句都尝试了（中间那句抛异常也不中断）', len(seen_sent) == 3, seen_sent)

    print()
    print('--- Process 查表与错误语义（:62-84）---')
    m10 = MlPhonemizer()
    m10.part_result = {180: [('zh/n', 0), ('zh/a', 240)]}
    got = m10.process([MLNote(180, 480, 62, 'n')])
    check('★ 查到该句的音素', got == [('zh/n', 0), ('zh/a', 240)], got)

    m11 = MlPhonemizer()
    m11.unrecognized_lyrics = {180: ''}
    check('★ 空歌词 → "Phoneme not found for this note"',
          _raises(m11, MLNote(180, 480, 62, 'x'), 'not found'))

    m12 = MlPhonemizer()
    m12.unrecognized_lyrics = {180: 'zzz'}
    check('★ 非空未识别 → Unrecognized phoneme "zzz"',
          _raises(m12, MLNote(180, 480, 62, 'x'), 'Unrecognized phoneme'))

    m13 = MlPhonemizer()
    m13.last_process_part_exception = RuntimeError('inner')
    check('★ 整句失败 → "Phonemizer failed to process." 且带内层异常',
          _raises(m13, MLNote(180, 480, 62, 'x'), 'failed to process')
          and _cause_is(m13, MLNote(180, 480, 62, 'x')))

    m14 = MlPhonemizer()
    check('  其它缺表 → "Part result not found"',
          _raises(m14, MLNote(180, 480, 62, 'x'), 'not found'))

    print()
    print('--- CleanUp（:86-89）---')
    m15 = MlPhonemizer()
    m15.part_result = {1: [('x', 0)]}
    m15.unrecognized_lyrics = {1: 'y'}
    m15.clean_up()
    check('★ 两张表都清空', not m15.part_result and not m15.unrecognized_lyrics)

    m16 = MlPhonemizer()
    m16.part_result = {1: [('x', 0)]}
    m16.unrecognized_lyrics = {1: 'y'}
    _collect(m16)
    m16.set_up([[MLNote(0, 100, 60, 'a')]])
    check('  set_up 开头也会重置（:23-26）', not m16.unrecognized_lyrics)

    print()
    print('--- 空输入 ---')
    m17 = MlPhonemizer()
    c17 = _collect(m17)
    m17.set_up([])
    check('groups 为空 → 不报错、不产出', c17 == [])

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


def _raises(m, note, needle) -> bool:
    try:
        m.process([note])
        return False
    except Exception as e:  # noqa: BLE001
        return needle in str(e)


def _cause_is(m, note) -> bool:
    try:
        m.process([note])
    except Exception as e:  # noqa: BLE001
        return isinstance(e.__cause__, RuntimeError)
    return False


if __name__ == '__main__':
    sys.exit(main())

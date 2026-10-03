# -*- coding: utf-8 -*-
"""验证 `Classic/UstNote.cs`（.ust 单个音符块的读写）。

重点是那些**很容易被"简化"掉**的语义：空串数值、UST 2.0 与 <2.0 的两套时值、
`?` 前缀、弯音三分支、PBM 的长度、PBS/PreUtterance 的写法。
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.classic.ust_note import FileFormatError, UstNote, parse_float  # noqa: E402
from singing.ustx.model import (PitchPoint, PitchPointShape, UPitch,  # noqa: E402
                                 UVibrato)

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


class _Line:
    def __init__(self, line):
        self.line = line


def _src():
    repo = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))
    p = os.path.join(repo, '_ref', 'OpenUtau', 'OpenUtau.Core', 'Classic', 'UstNote.cs')
    if not os.path.isfile(p):
        return ''
    return open(p, encoding='utf-8-sig').read().replace('\r\n', '\n')


def main():
    src = _src()

    # ---------------- 源码一致性
    check('源码: ParseFloat 空串返回 true 且值 0',
          'if (string.IsNullOrEmpty(s))' in src and 'value = 0;' in src and 'return true;' in src)
    check('源码: UST 2.0 与 <2.0 的两套时值判定（三者齐全 / 只有 length）',
          'if (delta != null && duration != null && length != null)' in src
          and 'else if (length != null)' in src)
    check('源码: Write 总是写 PreUtterance=（空值）', 'writer.WriteLine("PreUtterance=");' in src)
    check('源码: PBM 长度 = 点数（含首点），PBW/PBY = 点数-1',
          'for (var i = 0; i < points.Count; ++i)' in src
          and 'for (var i = 1; i < points.Count; ++i)' in src)
    check('源码: 只有 points.Count > 1 才写回 pitch', 'if (points.Count > 1) {' in src)
    check('源码: VBR 字段序 length,period,depth,in,out,shift,drift',
          'vibrato.length},{vibrato.period},{vibrato.depth},{vibrato.@in},{vibrato.@out}' in src)

    # ---------------- parse_float
    check('★ parse_float("") → (True, 0.0)（空串是合法数值）',
          parse_float('') == (True, 0.0), parse_float(''))
    check('parse_float("12.5") → (True, 12.5)', parse_float('12.5') == (True, 12.5))
    check('parse_float("abc") → (False, 0.0)', parse_float('abc') == (False, 0.0))

    # ---------------- UST < 2.0
    n = UstNote()
    tempo = n.parse(0, 480, [_Line('Length=240'), _Line('Lyric=あ'), _Line('NoteNum=69')])
    check('★ UST<2.0：只有 Length → position=lastNoteEnd、duration=length',
          (n.position, n.duration) == (480, 240), (n.position, n.duration))
    check('UST<2.0：Lyric / NoteNum / 无 Tempo', n.lyric == 'あ' and n.note_num == 69 and tempo is None)

    # ---------------- UST 2.0
    n2 = UstNote()
    n2.parse(100, 500, [_Line('Length=240'), _Line('Delta=40'), _Line('Duration=200'),
                        _Line('Lyric=?a')])
    check('★ UST2.0：Delta+Duration+Length 齐全 → position=lastNotePos+delta、duration=Duration',
          (n2.position, n2.duration) == (140, 200), (n2.position, n2.duration))
    check('★ Lyric 的前导 "?" 被剥掉', n2.lyric == 'a', n2.lyric)

    # ---------------- 空 Length
    n3 = UstNote()
    try:
        n3.parse(0, 0, [_Line('Length='), _Line('PreUtterance=')])
        check('★ Length=（空值）不报错，且时长为 0', n3.duration == 0, n3.duration)
    except FileFormatError as e:
        check('★ Length=（空值）不报错，且时长为 0', False, e)

    # ---------------- 缺 '=' 的行
    try:
        UstNote().parse(0, 0, [_Line('NoEqualsSign')])
        check('不含 "=" 的行抛 FileFormatError', False)
    except FileFormatError:
        check('不含 "=" 的行抛 FileFormatError', True)

    # ---------------- 弯音
    n4 = UstNote()
    n4.parse(0, 0, [_Line('PBS=0;0'), _Line('PBW=120,-120'), _Line('PBY=50,-50'),
                     _Line('PBM=r,s')])
    pts = [(p.x, p.y, p.shape) for p in n4.pitch.data]
    check('弯音：PBS 定位起点，PBW/PBY 走增量，PBM 定形状',
          pts == [(0, 0, PitchPointShape.O), (120, 50, PitchPointShape.L), (0, -50, PitchPointShape.IO)],
          pts)

    n5 = UstNote()
    n5.parse(0, 0, [_Line('PBS=0;0'), _Line('PBW=120'), _Line('PBY=50')])
    check('★ 弯音：只改 X 的分支（点数-1 == len(PBW) 且无 PBY）',
          n5.pitch is not None and [(p.x, p.y) for p in n5.pitch.data] == [(0, 0), (120, 50)],
          [(p.x, p.y) for p in n5.pitch.data] if n5.pitch else None)

    # ---------------- Envelope / VBR
    n6 = UstNote()
    n6.parse(0, 0, [_Line('Envelope=0,5,35,0,100,100,0')])
    check('Envelope：decay = 100 - v3', n6.decay == 0, n6.decay)
    n6b = UstNote()
    n6b.parse(0, 0, [_Line('Envelope=0,5,35,0,100,80,0')])
    check('Envelope：v3=80 → decay=20', n6b.decay == 20, n6b.decay)
    n6c = UstNote()
    n6c.parse(0, 0, [_Line('Envelope=0,5,35')])
    check('★ Envelope：不足 7 段直接不改（decay 仍为 None）', n6c.decay is None, n6c.decay)

    n7 = UstNote()
    n7.parse(0, 0, [_Line('VBR=60,150,30,10,20,5,1')])
    v = n7.vibrato
    check('VBR：七个字段按位置读',
          (v.length, v.period, v.depth, v.vib_in, v.vib_out, v.shift, v.drift)
          == (60.0, 150.0, 30.0, 10.0, 20.0, 5.0, 1.0),
          (v.length, v.period, v.depth, v.vib_in, v.vib_out, v.shift, v.drift))
    n7b = UstNote()
    n7b.parse(0, 0, [_Line('VBR=180,150,30')])
    check('★ VBR：length 被 UVibrato 的 0..100 钳制（照搬 C# setter，非本文件 bug）',
          n7b.vibrato.length == 100, n7b.vibrato.length)

    # ---------------- 未知参数静默忽略
    n8 = UstNote()
    try:
        n8.parse(0, 0, [_Line('SomeUnknownKey=123')])
        check('未知参数静默忽略（不抛）', True)
    except FileFormatError as e:
        check('未知参数静默忽略（不抛）', False, e)

    # ---------------- 写回
    buf = io.StringIO()
    u = UstNote(lyric='a', duration=240, note_num=69, velocity=100, intensity=80,
                pitch=UPitch(data=[PitchPoint(x=0, y=0, shape=PitchPointShape.O),
                                   PitchPoint(x=120, y=50, shape=PitchPointShape.L)]),
                vibrato=UVibrato(length=60))
    u.write(buf)
    text = buf.getvalue()
    lines = text.splitlines()
    check('write：前四行固定是 Length/Lyric/NoteNum/PreUtterance=（空值）',
          lines[:4] == ['Length=240', 'Lyric=a', 'NoteNum=69', 'PreUtterance='],
          lines[:4])
    check('write：Velocity/Intensity 各占一行', 'Velocity=100' in lines and 'Intensity=80' in lines)
    check('write：PBS 用分号、PBW/PBY 用逗号、PBM 长度=点数',
          'PBS=0;0' in lines and 'PBW=120' in lines and 'PBY=50' in lines and 'PBM=r,s' in lines,
          lines)
    check('write：VBR 七字段', lines[-1] == 'VBR=60,175,25,10,10,0,0', lines[-1])

    # 单点弯音不写
    buf2 = io.StringIO()
    UstNote(lyric='a', duration=10, note_num=60,
            pitch=UPitch(data=[PitchPoint(x=0, y=0)])).write(buf2)
    check('★ write：点数 < 2 时**不写** PBS/PBW/PBY/PBM',
          not any(l.startswith('PB') for l in buf2.getvalue().splitlines()),
          buf2.getvalue())

    # forPlugin 才写 @filename/@alias
    buf3 = io.StringIO()
    UstNote(lyric='a', duration=10, note_num=60,
            filename='wav/a.wav', alias='a').write(buf3, for_plugin=True)
    check('write：forPlugin=True 时才写 @filename / @alias',
          '@filename=wav/a.wav' in buf3.getvalue() and '@alias=a' in buf3.getvalue())

    # ---------------- clone
    n9 = UstNote(lyric='x', position=10, duration=20, note_num=30, velocity=90)
    c9 = n9.clone()
    c9.velocity = 50
    check('clone：深拷贝（改克隆不影响原件）', n9.velocity == 90 and c9.velocity == 50)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())
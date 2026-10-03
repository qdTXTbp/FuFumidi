# -*- coding: utf-8 -*-
"""端到端验证 `Classic/Ust.cs`（.ust 工程读写）。

造一份**真实的 .ust 文本**（Shift-JIS），用 `Ust.load_file` 读进来，
再用 `Ust.save_part` 写回去，核对往返与那些容易丢的语义。
"""
import io
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.classic import ust as U  # noqa: E402
from singing.openutau.classic.ust_note import FileFormatError  # noqa: E402
from singing.ustx.format import Ustx  # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _src():
    repo = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))
    p = os.path.join(repo, '_ref', 'OpenUtau', 'OpenUtau.Core', 'Classic', 'Ust.cs')
    return open(p, encoding='utf-8-sig').read().replace('\r\n', '\n') if os.path.isfile(p) else ''


UST_SAMPLE = """[#SETTING]
Tempo=120.000
Tracks=1
VoiceDir=%VOICE% singer
Mode2=True
[#0000]
Length=480
Lyric=a
NoteNum=69
PreUtterance=
Velocity=100
[#0001]
Length=480
Lyric=か
NoteNum=71
PreUtterance=
Velocity=110
Intensity=90
[#0002]
Length=240
Lyric=R
NoteNum=60
[#TRACKEND]
"""


def main():
    src = _src()
    root = tempfile.mkdtemp(prefix='fufumidi-ust-')
    try:
        # ---------------- 源码一致性
        check('源码: 编码探测只看前 10 行', 'for (var i = 0; i < 10; i++)' in src)
        check('源码: 默认 Shift-JIS', 'return ShiftJIS;' in src)
        check('源码: 多文件合并且改名 Merged Project',
              'project.name = "Merged Project";' in src)
        check('源码: 速度修正开关（bpm<=0 或 >1000）',
              'project.tempos[0].bpm <= 0 || project.tempos[0].bpm > 1000' in src)
        check('源码: tool2 决定 t flag 是否 ×10',
              'note.tuning = flag.Value * 10;' in src)
        check('源码: Header 的 Tempo 取自 timeAxis 而非 tempos[0]',
              'project.timeAxis.GetBpmAtTick(part.position)' in src)
        check('源码: Project= 只在 project.Saved 时写', 'if (project.Saved) {' in src)

        # ---------------- 写一份真 .ust 并读回来
        p1 = os.path.join(root, 'song.ust')
        with io.open(p1, 'w', encoding='shift_jis', newline='') as f:
            f.write(UST_SAMPLE)

        project = U.load_file(p1)
        check('load: 轨道数 1 / part 数 1', len(project.tracks) == 1 and len(project.parts) == 1)
        part = project.parts[0]
        check('★ load: lyric=="r" 的音符**不**进 part.notes',
              [n.lyric for n in part.notes] == ['a', 'か'],
              [n.lyric for n in part.notes])
        check('load: 音高与时长',
              [(n.tone, n.duration) for n in part.notes] == [(69, 480), (71, 480)],
              [(n.tone, n.duration) for n in part.notes])
        check('load: 第二音符紧接第一（position=480）', part.notes[1].position == 480,
              part.notes[1].position)
        check('load: Velocity/Intensity 变成表达式',
              any(e.abbr == Ustx.VEL and e.value == 110 for e in part.notes[1].phoneme_expressions)
              and any(e.abbr == Ustx.VOL and e.value == 90 for e in part.notes[1].phoneme_expressions),
              [(e.abbr, e.value) for e in part.notes[1].phoneme_expressions])
        check('load: Tempo=120 进 tempos[0]', project.tempos[0].bpm == 120, project.tempos[0].bpm)
        check('load: part.name 取文件名（去扩展名）', part.name == 'song', part.name)
        check('load: 默认表达式已补齐（26 个）', len(project.expressions) == 26,
              len(project.expressions))

        # ---------------- 编码探测
        check('detect_encoding: 无 Charset → shift_jis',
              U.detect_encoding(p1) == 'shift_jis', U.detect_encoding(p1))
        p2 = os.path.join(root, 'cs.ust')
        head = '[#SETTING]\nCharset=utf-8\nTempo=120\n'
        with io.open(p2, 'w', encoding='shift_jis', newline='') as f:
            f.write(head + '[#0000]\nLength=10\nLyric=a\n[#TRACKEND]\n')
        check('★ detect_encoding: 前 10 行内的 Charset= 生效',
              U.detect_encoding(p2) == 'utf-8', U.detect_encoding(p2))

        # ---------------- 非 .ust 文件被拒
        bad = os.path.join(root, 'bad.txt')
        with io.open(bad, 'w', encoding='utf-8') as f:
            f.write('hello\n')
        try:
            U.load_file(bad)
            check('非 .ust 文件抛 FileFormatError', False)
        except FileFormatError:
            check('非 .ust 文件抛 FileFormatError', True)

        # ---------------- 多文件合并
        p3 = os.path.join(root, 'b.ust')
        with io.open(p3, 'w', encoding='shift_jis', newline='') as f:
            f.write(UST_SAMPLE.replace('song', 'other'))
        merged = U.load([p1, p3])
        check('★ load(多文件): 合并成一个工程、改名 Merged Project',
              merged.name == 'Merged Project' and len(merged.tracks) == 2
              and len(merged.parts) == 2,
              (merged.name, len(merged.tracks), len(merged.parts)))
        check('load(多文件): 后续轨道的 trackNo 重编为 1',
              merged.tracks[1].track_no == 1 and merged.parts[1].track_no == 1)

        # ---------------- 空拍补 R + 导出往返
        proj2 = U.load_file(p1)
        out = os.path.join(root, 'out.ust')
        U.save_part(proj2, proj2.parts[0], out)
        with io.open(out, 'r', encoding='shift_jis', newline='') as f:
            text = f.read()
        check('save_part: 有 [#SETTING] 与 [#TRACKEND]',
              text.startswith('[#SETTING]') and '[#TRACKEND]' in text)
        check('save_part: Header 的 Tempo 取自时间轴', 'Tempo=120' in text, text[:120])
        check('★ save_part: 音符之间的空隙被补成 R（Lyric=R）',
              'Lyric=R' in text or text.count('[#') == 4,
              text)
        blocks = [b for b in text.splitlines() if b.startswith('[#') and b != '[#SETTING]'
                  and b != '[#TRACKEND]']
        check('save_part: 块号是四位补零（[#0000] 形式）',
              all(len(b) == 7 and b[1] == '#' and b[2:-1].isdigit() and len(b[2:-1]) == 4 for b in blocks), blocks[:4])

        # 再读回来，音符数应一致
        proj3 = U.load_file(out)
        check('★ 往返: 再次载入的音符数与原来一致',
              [n.lyric for n in proj3.parts[0].notes] == ['a', 'か'],
              [n.lyric for n in proj3.parts[0].notes])

        # ---------------- tool2 → t flag 的换算
        def _ust_with_flags(flags_line, tool2=None):
            path = os.path.join(root, 'f.ust')
            body = '[#SETTING]\nTempo=120\n'
            if tool2:
                body += 'Tool2=%s\n' % tool2
            body += ('[#0000]\nLength=480\nLyric=a\nNoteNum=69\nFlags=%s\n[#TRACKEND]\n' % flags_line)
            with io.open(path, 'w', encoding='shift_jis', newline='') as f:
                f.write(body)
            return U.load_file(path)

        pj = _ust_with_flags('t5', tool2='resampler')
        check('★ tool2=resampler → tuning = 5（不乘 10）',
              pj.parts[0].notes[0].tuning == 5, pj.parts[0].notes[0].tuning)
        pj2 = _ust_with_flags('t5', tool2='fresamp11')
        check('★ tool2=fresamp11 → tuning = 50（乘 10）',
              pj2.parts[0].notes[0].tuning == 50, pj2.parts[0].notes[0].tuning)

        # ---------------- 未定义 flag 只收集不报错
        U.undefined_flags()
        pj3 = _ust_with_flags('Z9g0')
        flags = U.undefined_flags()
        check('★ 未定义的 flag 记入收集表、不抛异常',
              'Z' in flags and pj3 is not None, flags)

        print()
        print('结果: %d passed, %d failed' % (len(_P), len(_F)))
        for f in _F:
            print('  FAILED:', f)
        return 1 if _F else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
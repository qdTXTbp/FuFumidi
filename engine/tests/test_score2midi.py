# -*- coding: utf-8 -*-
r"""「变谱」（乐谱 → MIDI）的验收：engine/engine_score2midi.py

用一份**手写的小谱子**把 MusicXML 里最容易搞错的几件事全钉住：

* `divisions` 单位的位置换算（错一个单位，整曲时值全乱）；
* 多声部：一个小节里两个声部靠 `<backup>` 分叉（钢琴左手/右手）；
* `<chord/>` 和弦（起点相同、不推进游标）；
* 连音线要并成一个长音；
* 速度/拍号/调号 → MIDI meta，且**速度中途变化**要按速度表算总时长；
* 休止符推进时间但不发音；
* `.mxl`（zip 包）也要能读。
"""
import json
import os
import subprocess
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ENGINE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'engine_score2midi.py')

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


FIXTURE = '''<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part>
    <score-part id="P2"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>
      <direction><direction-type><dynamics><mf/></dynamics></direction-type>
        <sound tempo="90" dynamics="88"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><tie type="start"/>
        <voice>1</voice><type>quarter</type><notations><tied type="start"/></notations></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><tie type="stop"/>
        <voice>1</voice><type>quarter</type><notations><tied type="stop"/></notations></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><rest/><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <direction><sound tempo="120"/></direction>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>'''


def run_engine(in_path, out_path):
    r = subprocess.run([sys.executable, ENGINE, 'to-midi', '--in', in_path, '--out', out_path],
                       capture_output=True, timeout=120)
    out = r.stdout.decode('utf-8', 'replace')
    res = None
    for line in out.splitlines():
        if line.startswith('###RESULT '):
            res = json.loads(line[len('###RESULT '):])
    return res


def events_of(path):
    import mido
    mid = mido.MidiFile(path)
    tracks = []
    for tr in mid.tracks:
        t = 0
        evs = []
        for msg in tr:
            t += msg.time
            if msg.type in ('note_on', 'note_off'):
                evs.append((t, msg.type, msg.note))
            elif msg.type in ('set_tempo', 'time_signature', 'key_signature'):
                evs.append((t, msg.type,
                            getattr(msg, 'tempo', None) or (getattr(msg, 'numerator', ''), getattr(msg, 'denominator', '')),
                            getattr(msg, 'key', '')))
        tracks.append(evs)
    return mid, tracks


def on_off(evs):
    ons = [(t, n) for (t, k, n) in evs if k == 'note_on']
    offs = [(t, n) for (t, k, n) in evs if k == 'note_off']
    return ons, offs


def main():
    d = tempfile.mkdtemp(prefix='score2midi-')
    src = os.path.join(d, 't.musicxml')
    with open(src, 'w', encoding='utf-8') as f:
        f.write(FIXTURE)
    mid_path = os.path.join(d, 't.mid')

    print('--- ① MusicXML → MIDI ---')
    res = run_engine(src, mid_path)
    check('转换成功', bool(res and res.get('ok')), res)
    if not (res and res.get('ok')):
        print('\n结果: %d passed, %d failed' % (len(_P), len(_F)))
        return 1
    check('part 名从 <part-list> 读到（Piano / Flute）',
          [t['name'] for t in res['tracks']] == ['Piano', 'Flute'], res['tracks'])
    check('tpb=480 / bpm=90 / 4/4 / C',
          (res['tpb'], res['bpm'], res['timeSig'], res['key']) == (480, 90, '4/4', 'C'), res)
    check('两次速度变化（90 → 120）', res['tempoChanges'] == 2, res['tempoChanges'])
    check('★ 总时长按速度表算：4.667s（只按 90 会算成 5.33s）',
          abs(res['durationMs'] - 4666) <= 3, res['durationMs'])
    check('音符数 7 + 3（连音线已并成一个音、和弦算三声）',
          [t['notes'] for t in res['tracks']] == [7, 3], res['tracks'])

    print('--- ② 落到 MIDI 的时间轴 ---')
    mid, tracks = events_of(mid_path)
    check('三轨（第 0 轨放速度/拍号/调号）', len(mid.tracks) == 3, len(mid.tracks))
    meta = tracks[0]
    tempos = [(t, v) for (t, k, v, _k) in meta if k == 'set_tempo']
    check('速度事件在 tick 0 与 1920（第二小节）', [t for t, _ in tempos] == [0, 1920], tempos)
    check('拍号 4/4 在 tick 0', any(k == 'time_signature' and v == (4, 4) for (_t, k, v, _k) in meta), meta)
    ons, offs = on_off(tracks[1])
    # MIDI 音高：C4=60 / C5=72 / E5=76 / G5=79（写测试时把 C4 当成 C5 过一次，这里写清楚）
    check('右手：C5(72)@0 / E5(76)@480 / G5(79)@960（divisions=4 换算正确）',
          [x for x in ons if x[1] in (72, 76, 79)][:3] == [(0, 72), (480, 76), (960, 79)], ons)
    check('左手（第二声部）：C4(60)@0 全长 1920', (0, 60) in ons and (1920, 60) in offs, (ons[:3], offs[-4:]))
    check('★ 连音线并成一个音：C5@1920 到 2880（不是两个 480）',
          (1920, 72) in ons and (2880, 72) in offs, (ons, offs))
    # ★ <chord/> 的语义是「与**紧邻的前一个**音符同起点」。这里前一个是连音线的后半段
    #   （relative 480 → tick 2400），所以和弦在 2400 起、3360 止（半音符 960 tick）。
    check('和弦：E5/G5 同起同止（2400 → 3360，跟前一个音符对齐）',
          (2400, 76) in ons and (2400, 79) in ons and (3360, 76) in offs and (3360, 79) in offs, (ons, offs))
    ons2, offs2 = on_off(tracks[2])
    check('休止符不发音：长笛第一个音在 960', ons2[0] == (960, 74), ons2[:3])
    check('力度记号 88 → velocity 112',
          all(m.velocity == 112 for m in mid.tracks[1] if m.type == 'note_on'),
          [m.velocity for m in mid.tracks[1] if m.type == 'note_on'])

    print('--- ③ .mxl（zip 包）---')
    mxl = os.path.join(d, 't.mxl')
    with zipfile.ZipFile(mxl, 'w') as z:
        z.writestr('META-INF/container.xml',
                   '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>')
        z.writestr('score.xml', FIXTURE)
    res2 = run_engine(mxl, os.path.join(d, 't2.mid'))
    check('mxl 也能转（按 container.xml 找根文件）', bool(res2 and res2.get('ok')), res2)
    check('  内容与裸 xml 一致', (res2 or {}).get('noteCount') == res.get('noteCount'), res2)

    print('--- ④ 错误处理 ---')
    bad = os.path.join(d, 'bad.musicxml')
    with open(bad, 'w', encoding='utf-8') as f:
        f.write('<score-partwise></score-partwise>')
    res3 = run_engine(bad, os.path.join(d, 'bad.mid'))
    check('★ 没有 <part> 时返回 ok:false + 中文原因（不是抛栈）',
          res3 and res3.get('ok') is False and res3.get('error'), res3)
    notxml = os.path.join(d, 'x.musicxml')
    with open(notxml, 'w', encoding='utf-8') as f:
        f.write('not xml at all')
    res4 = run_engine(notxml, os.path.join(d, 'x.mid'))
    check('非 XML 文件也走 ok:false', bool(res4 and res4.get('ok') is False), res4)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


def test_score2midi():
    assert main() == 0


if __name__ == '__main__':
    sys.exit(main())
# -*- coding: utf-8 -*-
r"""乐谱 → MIDI（「变谱」功能的引擎侧）：MusicXML / MXL → 标准 MIDI 文件。

## 为什么自己写解析器，而不是 pip install music21

* music21 会拖进 numpy/scipy/matplotlib 一整串依赖（几十 MB），而这个功能只需要
  「把音符搬进 MIDI」；
* 随包 Python 已经有 `mido`（写 MIDI）与标准库的 `xml.etree`/`zipfile`（读 XML / 解 .mxl），
  零新增依赖，离线可用；
* 需要的语义其实是**有权威文档**的（MusicXML 4.0 规范 + musicxml.com 的教程）：
  一个游标 + `backup`/`forward` + `chord` + 连音线，就能把多声部/多声部钢琴正确串起来。

## 关键规则（踩错就会「时值全乱」）

1. `divisions` 是**每四分音符的 tick 数**，且可以在任意小节里改变 —— 每读到一个
   `<attributes><divisions>` 就要更新；
2. 一个小节内所有声部是**顺序**写下来的：游标 + `<backup><duration>` 回到分叉点，
   再写第二个声部。只按「前一个音符的结束」推时间就会把第二声部整体后移；
3. `<chord/>` 表示与**前一个**音符同时发声（起点相同、不推进游标）；
4. 连音线（`tie type=start/stop`）要把两段**并成一个长音**，否则会听到断音；
5. 速度来自 `<sound tempo>` / `<metronome><per-minute>`，可以有多次变化 → 写速度表；
6. 拍号/调号同理，按位置写成 MIDI meta 事件。

## CLI

`python engine_score2midi.py to-midi --in score.musicxml --out song.mid`
`python engine_score2midi.py to-midi --in score.mxl --out song.mid --json-only`（只解析报统计）
"""
import argparse
import io
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

#: 与其它引擎一致的输出协议（主进程解析这两行前缀）
def emit_result(obj):
    sys.stdout.write("###RESULT " + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_progress(percent, text=''):
    sys.stdout.write("###PROG " + json.dumps({"percent": int(percent), "text": text}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _warn(msg):
    sys.stderr.write("[score] " + str(msg) + "\n")
    sys.stderr.flush()


STEP_SEMITONES = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def _localname(tag):
    """去掉命名空间：MusicXML 的命名空间各家写法不一（有的还没声明）。"""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _text(el, name, default=''):
    for c in el:
        if _localname(c.tag) == name:
            return (c.text or default)
    return default


def _child(el, name):
    for c in el:
        if _localname(c.tag) == name:
            return c
    return None


def _children(el, name):
    return [c for c in el if _localname(c.tag) == name]


def _int(s, default=0):
    try:
        return int(str(s).strip())
    except Exception:
        try:
            return int(float(str(s).strip()))
        except Exception:
            return default


def read_score_bytes(path):
    """读乐谱文件 → (xml 文本, 说明)。支持 .mxl（zip 包）与裸 .xml/.musicxml。"""
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            names = z.namelist()
            target = ""
            root = ""
            if 'META-INF/container.xml' in names:
                try:
                    c = ET.fromstring(z.read('META-INF/container.xml'))
                    for rf in c.iter():
                        if _localname(rf.tag) == 'rootfile':
                            root = rf.get('full-path') or ''
                            if root:
                                break
                except Exception:
                    root = ''
            if root and root in names:
                target = root
            else:
                cand = [n for n in names if n.lower().endswith(('.xml', '.musicxml'))]
                target = cand[0] if cand else ''
            if not target:
                raise ValueError("mxl 包里找不到 MusicXML（container.xml 与 .xml 都没有）")
            data = z.read(target)
            return data.decode("utf-8", "replace"), ("mxl:" + target)
    return raw.decode("utf-8", "replace"), "xml"


def parse_musicxml(text):
    """MusicXML → 中间结构（每个 part 一串音符，带 tick 时间）。

    返回 `{parts: [{name, notes: [{start, end, midi, vel}], staves}], tempos, times, keys, tpb}`
    """
    root = ET.fromstring(text)
    # 根可能是 score-partwise（主流）或 score-timewise；timewise 先按小节拆再拼
    tag = _localname(root.tag)
    if tag == "score-timewise":
        parts = _timewise_to_partwise(root)
    else:
        parts = _children(root, 'part')
    if not parts:
        raise ValueError("这份 MusicXML 里没有 <part>（是不是只导出了样式/页面？）")

    # ---- 全局的 divisions（每小节的 <attributes> 里还可能改）
    divisions = 1
    for p in parts:
        for m in _children(p, 'measure'):
            att = _child(m, 'attributes')
            if att is not None:
                d = _int(_text(att, 'divisions'), 0)
                if d > 0:
                    divisions = d
                    break
        break
    #: MIDI 的每四分音符 tick 数取整到舒服的值（MusicXML 的 divisions 常见 480/1/2/8）
    tpb = 480

    # part-list 里的名字（MuseScore/Finale 都把 <part-name> 放在这里，而不是 <part> 里）
    part_names = {}
    for el in root.iter():
        if _localname(el.tag) == 'score-part':
            pid = el.get('id') or ''
            part_names[pid] = (_text(el, 'part-name') or '').strip()

    out_parts = []
    tempos, times, keys = [], [], []

    for pi, part in enumerate(parts):
        name = ((_text(part, 'part-name') or '').strip()
                or part_names.get(part.get('id') or '', '')
                or ('Part %d' % (pi + 1)))
        notes = []
        cursor = 0                       # 全局 tick 游标（跨小节连续）
        divisions = divisions
        open_ties = {}                   # (voice, midi) -> 正在延长的音符 dict
        cur_vel = 0                      # 最近的力度记号（<sound dynamics> / <dynamics>）
        measure_start = 0
        for m in _children(part, 'measure'):
            measure_start = cursor
            cur = 0                      # 小节内游标（backup/forward 作用在它上面）
            voice_max = {}               # 每个声部在本小节里走到哪（用于结尾对齐，可不用）
            last_note = None             # 供 <chord/> 用
            for el in m:
                t = _localname(el.tag)
                if t == 'attributes':
                    d = _int(_text(el, 'divisions'), 0)
                    if d > 0:
                        divisions = d
                    tm = _child(el, 'time')
                    if tm is not None:
                        beats = _int(_text(tm, 'beats'), 4) or 4
                        bt = _int(_text(tm, 'beat-type'), 4) or 4
                        times.append({'tick': measure_start + cur, 'beats': beats, 'beatType': bt})
                    ky = _child(el, 'key')
                    if ky is not None:
                        keys.append({'tick': measure_start + cur, 'fifths': _int(_text(ky, 'fifths'), 0)})
                    continue
                if t == 'backup':
                    cur = max(0, cur - _dur_ticks(el, divisions, tpb))
                    continue
                if t == 'forward':
                    cur += _dur_ticks(el, divisions, tpb)
                    continue
                if t == 'direction':
                    bpm = _direction_tempo(el)
                    if bpm:
                        tempos.append({'tick': measure_start + cur, 'bpm': bpm})
                    dv = _velocity_from_direction(el)
                    if dv:
                        cur_vel = dv
                    continue
                if t == 'sound':
                    bpm = _int(el.get('tempo'), 0)
                    if bpm:
                        tempos.append({'tick': measure_start + cur, 'bpm': bpm})
                    continue
                if t != 'note':
                    continue
                voice = _text(el, 'voice', '1') or '1'
                ticks = _dur_ticks(el, divisions, tpb)
                is_chord = _child(el, 'chord') is not None
                is_rest = _child(el, 'rest') is not None
                is_grace = _child(el, 'grace') is not None
                if is_grace:
                    ticks = max(15, ticks)
                start = cur if not is_chord else (last_note['start'] if last_note else cur)
                is_cue = _child(el, 'cue') is not None
                if is_rest or is_cue:
                    if not is_chord and not is_grace:
                        cur += ticks
                    continue
                pitch = _child(el, 'pitch')
                if pitch is None:
                    if not is_chord and not is_grace:
                        cur += ticks
                    continue
                step = (_text(pitch, 'step', 'C') or 'C').strip().upper()[:1]
                octv = _int(_text(pitch, 'octave'), 4)
                alter = _int(_text(pitch, 'alter'), 0)
                midi = max(0, min(127, 12 * (octv + 1) + STEP_SEMITONES.get(step, 0) + alter))
                vel = _int(el.get('velocity') or _text(el, 'velocity'), 0)
                if not vel:
                    vel = cur_vel or 80
                vel = max(1, min(127, vel))
                tie_start = _has_tie(el, 'start')
                tie_stop = _has_tie(el, 'stop')
                key = (voice, midi)
                if tie_stop and key in open_ties and not is_chord:
                    # 连音线的后半段：并进前一个音，不加新音
                    prev = open_ties[key]
                    prev['end'] = max(prev['end'], measure_start + start + ticks)
                    if not tie_start:
                        del open_ties[key]
                    if not is_grace:
                        cur += ticks
                    last_note = {'start': start, 'midi': midi}
                    continue
                note = {'start': measure_start + start, 'end': measure_start + start + ticks,
                        'midi': midi, 'vel': vel}
                notes.append(note)
                if tie_start:
                    open_ties[key] = note
                if not is_chord and not is_grace:
                    cur += ticks
                last_note = {'start': start, 'midi': midi}
            # 未闭合的连音线（谱面没写 stop）：就地收尾
            open_ties.clear()
            cursor = measure_start + cur
        notes.sort(key=lambda n: (n['start'], n['midi']))
        staves = 1
        first_m = _children(part, 'measure')
        if first_m:
            att0 = _child(first_m[0], 'attributes')
            if att0 is not None:
                staves = max(1, _int(_text(att0, 'staves'), 1) or 1)
        out_parts.append({'name': name, 'notes': notes, 'staves': staves})

    if not tempos:
        tempos = [{'tick': 0, 'bpm': 120}]
    if not times:
        times = [{'tick': 0, 'beats': 4, 'beatType': 4}]
    if not keys:
        keys = [{'tick': 0, 'fifths': 0}]
    temps = {}
    for t in tempos:
        temps[t['tick']] = t['bpm']
    tempos = [{'tick': k, 'bpm': temps[k]} for k in sorted(temps)]
    return {'parts': out_parts, 'tempos': tempos, 'times': _dedupe(times), 'keys': _dedupe(keys), 'tpb': tpb}


def _dedupe(seq):
    out, seen = [], set()
    for x in seq:
        k = x['tick']
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out


def _dur_ticks(el, divisions, tpb):
    """<duration> 是「divisions 单位」→ 换算成 tick（divisions 随时可能变，必须现算）。"""
    d = _int(_text(el, 'duration'), 0)
    return int(round(d * tpb / max(1, divisions)))


def _direction_tempo(el):
    """从 <direction> 里取速度：<sound tempo> 优先，其次 <metronome><per-minute>。"""
    for s in el.iter():
        if _localname(s.tag) == 'sound' and s.get('tempo'):
            return _int(s.get('tempo'), 0)
    for s in el.iter():
        if _localname(s.tag) == 'per-minute':
            return _int(s.text, 0)
    return 0


DYNAMICS = {'ppp': 20, 'pp': 33, 'p': 49, 'mp': 64, 'mf': 80, 'f': 96, 'ff': 112, 'fff': 126}


def _velocity_from_direction(el):
    """<direction> 里的力度（"'sound dynamics="80"'" 或 <dynamics><mf/>）→ 0..127。"""
    for s in el.iter():
        if _localname(s.tag) == 'sound' and s.get('dynamics'):
            try:
                v = int(round(float(s.get('dynamics')) * 1.27))
                return max(1, min(127, v))
            except Exception:  # noqa: BLE001
                pass
    for s in el.iter():
        nm = _localname(s.tag)
        if nm in DYNAMICS:
            return DYNAMICS[nm]
    return 0


def _has_tie(el, kind):
    for c in el:
        if _localname(c.tag) == 'tie' and (c.get('type') or '') == kind:
            return True
    for c in el.iter():
        if _localname(c.tag) == 'tied' and (c.get('type') or '') == kind:
            return True
    return False


def _timewise_to_partwise(root):
    """score-timewise → 按 part 归并（少见格式，做个兜底）。"""
    by_id = {}
    order = []
    for m in _children(root, 'measure'):
        for p in _children(m, 'part'):
            pid = p.get('id') or ('P%d' % (len(order) + 1))
            if pid not in by_id:
                by_id[pid] = ET.Element('part', {'id': pid})
                order.append(pid)
            by_id[pid].append(p)
    return [by_id[k] for k in order]


def write_midi(parsed, out_path):
    """中间结构 → MIDI 文件（type 1，每 part 一轨；第 0 轨放速度/拍号/调号）。"""
    import mido
    tpb = int(parsed.get('tpb') or 480)
    mid = mido.MidiFile(type=1, ticks_per_beat=tpb)
    # 第 0 轨：时间/速度/调号
    meta = mido.MidiTrack()
    mid.tracks.append(meta)
    events = []
    for t in parsed['tempos']:
        events.append((t['tick'], 0, mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(t['bpm']), time=0)))
    for t in parsed['times']:
        events.append((t['tick'], 1, mido.MetaMessage('time_signature', numerator=t['beats'],
                                                    denominator=t['beatType'], time=0)))
    for k in parsed['keys']:
        events.append((k['tick'], 2,
                       mido.MetaMessage('key_signature', key=_key_name(k['fifths']), time=0)))
    meta.append(mido.MetaMessage('track_name', name='Score', time=0))
    events.sort(key=lambda e: (e[0], e[1]))
    pos = 0
    for tick, _p, msg in events:
        msg.time = max(0, tick - pos)
        pos = tick
        meta.append(msg)
    meta.append(mido.MetaMessage('end_of_track', time=0))

    for part in parsed['parts']:
        trk = mido.MidiTrack()
        mid.tracks.append(trk)
        trk.append(mido.MetaMessage('track_name', name=part['name'] or 'Part', time=0))
        evs = []
        for n in part['notes']:
            evs.append((n['start'], 1, mido.Message('note_on', note=n['midi'], velocity=n['vel'], time=0)))
            evs.append((max(n['end'], n['start'] + 1), 0,
                        mido.Message('note_off', note=n['midi'], velocity=0, time=0)))
        evs.sort(key=lambda e: (e[0], e[1]))
        pos = 0
        for tick, _p, msg in evs:
            msg.time = max(0, tick - pos)
            pos = tick
            trk.append(msg)
        trk.append(mido.MetaMessage('end_of_track', time=0))
    d = os.path.dirname(os.path.abspath(out_path))
    if d:
        os.makedirs(d, exist_ok=True)
    mid.save(out_path)
    return out_path


KEYS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']


def _key_name(fifths):
    i = max(-7, min(7, int(fifths))) + 7
    return KEYS[i]


def _ticks_to_ms(parsed, tick):
    """按速度表把 tick 换算成毫秒（速度中途变过时不能只按第一个 bpm 乘）。"""
    tpb = float(parsed['tpb'] or 480)
    tempos = parsed['tempos'] or [{'tick': 0, 'bpm': 120}]
    total = 0.0
    for i, t in enumerate(tempos):
        seg_end = tempos[i + 1]['tick'] if i + 1 < len(tempos) else tick
        a = min(t['tick'], tick)
        b = min(seg_end, tick)
        if b > a:
            total += (b - a) / tpb * (60000.0 / max(1, t['bpm']))
        if seg_end >= tick:
            break
    return int(total)


def cmd_to_midi(args):
    try:
        emit_progress(10, '读取乐谱…')
        text, how = read_score_bytes(args.infile)
        emit_progress(35, '解析 MusicXML…')
        parsed = parse_musicxml(text)
        note_count = sum(len(p['notes']) for p in parsed['parts'])
        if note_count == 0:
            raise ValueError("这份乐谱里没有可转换的音符")
        emit_progress(65, '写 MIDI…')
        if args.out:
            write_midi(parsed, args.out)
        last = 0
        for p in parsed['parts']:
            for n in p['notes']:
                last = max(last, n['end'])
        dur_ms = _ticks_to_ms(parsed, last)
        emit_progress(100, '完成')
        emit_result({
            'ok': True,
            'out': args.out or '',
            'source': how,
            'tpb': parsed['tpb'],
            'bpm': parsed['tempos'][0]['bpm'],
            'timeSig': '%d/%d' % (parsed['times'][0]['beats'], parsed['times'][0]['beatType']),
            'key': _key_name(parsed['keys'][0]['fifths']),
            'tempoChanges': len(parsed['tempos']),
            'tracks': [{'name': p['name'], 'notes': len(p['notes']),
                        'range': ([min(n['midi'] for n in p['notes']), max(n['midi'] for n in p['notes'])] if p['notes'] else None)}
                       for p in parsed['parts']],
            'noteCount': note_count,
            'durationMs': dur_ms,
        })
    except Exception as e:  # noqa: BLE001 —— CLI 约定：失败也走 ###RESULT
        emit_result({'ok': False, 'error': str(e)})
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='乐谱（MusicXML/MXL）→ MIDI')
    sub = ap.add_subparsers(dest='cmd')
    p = sub.add_parser('to-midi', help='转成 MIDI 文件')
    p.add_argument('--in', dest='infile', required=True)
    p.add_argument('--out', default='')
    p.set_defaults(func=cmd_to_midi)
    args = ap.parse_args(argv)
    if not getattr(args, 'func', None):
        ap.print_help()
        return 2
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
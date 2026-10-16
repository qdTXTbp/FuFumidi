"""按轨名给 MIDI 回填 GM 音色（"变谱"输出用）。

★ 为什么需要（2026-10-17 用户实测）：
  变谱识别出的 MIDI 有 38 条轨、轨名都对（Flute 1,2 / Oboe / Clarinet in Bb / Horn in F /
  Trumpet in Bb / Timpani / Violin / Viola / Violoncello ...），但**一条 program_change 都没有**，
  而且所有音符都挤在 channel 0 —— 于是不论谱面写的是什么乐器，回放全是钢琴。
  Audiveris 的 MIDI 导出本身不带音色，内置后端更是只分左右手，两边都缺这一笔。

★ 做法：事后按 track_name 回填 —— 与后端无关，两种路径共用同一条修正，
  也不需要改 Audiveris 的导出。轨名用 score_instruments 的归一化逻辑匹配。

★ 通道：MIDI 只有 16 条通道（9 号是打击乐），38 条轨必然要复用通道。
  按轨轮转分配通道、每条轨写自己的 program_change —— 这是"多轨各自音色"能做到的上限；
  通道用尽后，同通道的轨会被后写的音色覆盖（这是 MIDI 格式本身的限制，不是实现取舍）。
"""
from __future__ import annotations

# GM 音色号（0 基）。关键字按**长的先匹配**，避免 "horn" 抢在 "english horn" 前面。
_GM = [
    ("english horn", 69), ("french horn", 60), ("horn in f", 60), ("horn", 60),
    ("flute", 73), ("piccolo", 72), ("oboe", 68), ("clarinet", 71), ("bass clarinet", 71),
    ("bassoon", 70), ("contrabassoon", 70), ("sax", 65), ("trumpet", 56), ("cornet", 56),
    ("trombone", 57), ("tuba", 58), ("euphonium", 58), ("timpani", 47), ("percussion", 47),
    ("harp", 46), ("glockenspiel", 9), ("xylophone", 11), ("vibraphone", 11), ("celesta", 8),
    ("organ", 19), ("harpsichord", 6), ("piano", 0), ("guitar", 24), ("banjo", 105),
    ("violin", 40), ("viola", 41), ("violoncello", 42), ("cello", 42), ("contrabass", 43),
    ("double bass", 43), ("string", 48), ("choir", 52), ("voice", 52), ("soprano", 52),
    ("alto", 52), ("tenor", 52), ("bass voice", 52), ("marimba", 12), ("accordion", 21),
]
# 这些按打击乐处理（归到 9 号通道，音色本身由鼓组决定）
_PERC = ("timpani", "percussion", "drum", "cymbal", "snare", "bass drum", "triangle", "tambourine", "glockenspiel")


def program_for(name: str) -> int:
    """轨名 → GM 音色号（0 基）。认不出来就退回 0（大钢琴）—— 与 Audiveris 的默认一致。"""
    s = (name or "").lower()
    for key, prog in _GM:
        if key in s:
            return prog
    return 0


def is_percussion(name: str) -> bool:
    s = (name or "").lower()
    return any(k in s for k in _PERC)


def apply_programs(midi_path: str, meta_track: bool = True) -> list:
    """就地给每条轨回填 program_change + 轮转通道。返回 [{'track','name','program','channel'}]。"""
    import mido
    mid = mido.MidiFile(midi_path)
    used = {}          # 轨名 → 分配结果，避免同名声部各占一条通道
    chan = 0
    out = []
    for ti, tr in enumerate(mid.tracks):
        name = ""
        for msg in tr:
            if msg.type == "track_name":
                name = str(msg.name or "")
                break
        if not name and ti == 0 and meta_track:
            out.append({"track": ti, "name": "", "program": None, "channel": None})
            continue                      # 0 号轨是速度/拍号，不动
        perc = is_percussion(name)
        if name in used:
            ch = used[name]
        else:
            if perc:
                ch = 9
            else:
                while chan == 9:
                    chan += 1
                ch = chan % 16
                chan += 1
            used[name] = ch
        prog = program_for(name)
        # 所有通道事件改到分配到的通道；已有 program_change 就替换成本轨音色
        new = []
        inserted = False
        for msg in tr:
            if msg.type in ("note_on", "note_off", "control_change", "pitchwheel", "aftertouch", "polytouch"):
                msg = msg.copy(channel=ch)
            elif msg.type == "program_change":
                msg = msg.copy(program=prog, channel=ch)
                inserted = True
            new.append(msg)
        if not inserted and midi_has_notes(tr):
            new.insert(0, mido.Message("program_change", program=prog, channel=ch, time=0))
        tr.clear()
        tr.extend(new)
        out.append({"track": ti, "name": name, "program": prog, "channel": ch, "percussion": perc})
    mid.save(midi_path)
    return out


def midi_has_notes(track) -> bool:
    return any(m.type == "note_on" and getattr(m, "velocity", 0) > 0 for m in track)

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

★ 2026-10-17 修（用户实测：「部分音色对不上」）：
  1. 旧表把 Timpani / Glockenspiel 也当"打击乐"扔进 9 号通道 —— 那是**鼓组通道**，
     定音鼓/钟琴的音高会被当成鼓组音（35~50 号是底鼓/军鼓…），整条声部完全是错的。
     定音鼓是**有音高**打击乐（GM 47）、钟琴 GM 9，必须留在旋律通道上。
  2. 真正无音高的打击乐（Crash Cymbal / Snare / Bass Drum / Triangle / Tambourine）才进
     9 号通道，而且要把音符号换成对应的**鼓音**（吊镲 49 / 军鼓 38 / 底鼓 36…），
     否则原始音高会被鼓组解释成随机的鼓。
  3. 认不出名字的轨（Audiveris 的 OCR 失败 → "Part 12"/"声部 23"）以前一律给大钢琴；
     现在按**音域**猜最接近的弦乐/木管音色 —— 总谱里这类轨基本是没读出名字的弦乐/木管声部。
  4. 补上漏掉的 GM 音色：Tubular Bells 14、Crash Cymbal（鼓）、Percussion 等。
"""
from __future__ import annotations

import statistics

# GM 音色号（0 基）。关键字按**长的先匹配**，避免 "horn" 抢在 "english horn" 前面。
_GM = [
    ("english horn", 69), ("french horn", 60), ("horn in f", 60), ("horn", 60),
    ("flute", 73), ("piccolo", 72), ("oboe", 68), ("clarinet", 71), ("bass clarinet", 71),
    ("bassoon", 70), ("contrabassoon", 70), ("sax", 65), ("trumpet", 56), ("cornet", 56),
    ("trombone", 57), ("tuba", 58), ("euphonium", 58),
    # 有音高的打击乐：必须有固定音高（旋律通道），不能进鼓组通道
    ("timpani", 47), ("glockenspiel", 9), ("xylophone", 11), ("vibraphone", 11),
    ("marimba", 12), ("celesta", 8), ("tubular bells", 14), ("tubul", 14), ("chimes", 14),
    ("harp", 46), ("organ", 19), ("harpsichord", 6), ("piano", 0), ("guitar", 24),
    ("banjo", 105), ("violin", 40), ("viola", 41), ("violoncello", 42), ("cello", 42),
    ("contrabass", 43), ("double bass", 43), ("string", 48), ("choir", 52), ("voice", 52),
    ("soprano", 52), ("alto", 52), ("tenor", 52), ("bass voice", 52), ("accordion", 21),
    ("percussion", 47),
]

#: 有音高的打击乐（留在旋律通道，program 由 _GM 决定）
_PITCHED_PERC = ("timpani", "glockenspiel", "xylophone", "vibraphone", "marimba",
                 "celesta", "tubular bells", "tubul", "chimes")

#: 无音高打击乐 → 9 号通道的鼓音号（General MIDI 打击乐谱）。长的先匹配。
_DRUM_NOTE = [
    ("crash", 49), ("cymbal", 52), ("suspend", 52),
    ("snare", 38), ("bass drum", 36), ("kick", 36),
    ("triangle", 81), ("tambourine", 54), ("cowbell", 56),
    ("woodblock", 76), ("drum", 38),
]

#: 认不出名字的轨按音域猜音色（中位音高 → GM 音色）。
#: 总谱里 OCR 失败的多是弦乐/木管：低音区给低音弦、中高音区给小提琴/长笛比给钢琴接近。
_PITCH_GUESS = [
    (43, 43),   # < 43（G2）      → Contrabass
    (50, 42),   # 43..50（D3）    → Cello
    (57, 41),   # 50..57（A3）    → Viola
    (67, 40),   # 57..67（G4）    → Violin
    (76, 73),   # 67..76（E5）    → Flute
    (200, 72),  # 更高            → Piccolo
]


def match_program(name: str):
    """轨名 → GM 音色号（0 基）；认不出返回 None（不再默默退成大钢琴）。"""
    s = (name or "").lower()
    for key, prog in _GM:
        if key in s:
            return prog
    return None


def program_for(name: str) -> int:
    """轨名 → GM 音色号（0 基）。认不出来就退回 0（大钢琴）—— 保留给老调用方。"""
    p = match_program(name)
    return 0 if p is None else p


def pitched_percussion(name: str) -> bool:
    s = (name or "").lower()
    return any(k in s for k in _PITCHED_PERC)


def is_percussion(name: str) -> bool:
    """无音高打击乐（要进 9 号通道）。有音高的打击乐**不算** —— 它们在旋律通道上。"""
    if pitched_percussion(name):
        return False
    s = (name or "").lower()
    return any(k in s for k, _n in _DRUM_NOTE)


def drum_note_for(name: str) -> int:
    s = (name or "").lower()
    for key, note in _DRUM_NOTE:
        if key in s:
            return note
    return 38                      # 认不出就按军鼓（比随机鼓组音好）


def pitch_guess_program(track) -> int:
    """认不出名字的轨：按中位音高猜一个 GM 音色（总谱里通常是没读出名字的弦乐/木管）。"""
    import mido  # noqa: F401  （调用方已依赖 mido；这里只为类型/一致性）
    pitches = [int(m.note) for m in track
               if m.type == "note_on" and getattr(m, "velocity", 0) > 0]
    if not pitches:
        return 0
    med = statistics.median(pitches)
    for lim, prog in _PITCH_GUESS:
        if med < lim:
            return prog
    return 72


def apply_programs(midi_path: str, meta_track: bool = True) -> list:
    """就地给每条轨回填 program_change + 轮转通道 + 打击乐鼓音重映射。

    返回 [{'track','name','program','channel','percussion','drum'}]。
    """
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
        drum = drum_note_for(name) if perc else None
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
        prog = match_program(name)
        if prog is None:
            prog = pitch_guess_program(tr)      # ★ 认不出名字：按音域猜，别一律钢琴
        # 所有通道事件改到分配到的通道；已有 program_change 就替换成本轨音色
        new = []
        inserted = False
        for msg in tr:
            if msg.type in ("note_on", "note_off", "control_change", "pitchwheel", "aftertouch", "polytouch"):
                if perc and drum is not None and msg.type in ("note_on", "note_off"):
                    msg = msg.copy(note=int(drum))   # 无音高打击乐 → 对应鼓音
                msg = msg.copy(channel=ch)
            elif msg.type == "program_change":
                msg = msg.copy(program=prog, channel=ch)
                inserted = True
            new.append(msg)
        if not inserted and midi_has_notes(tr):
            new.insert(0, mido.Message("program_change", program=prog, channel=ch, time=0))
        tr.clear()
        tr.extend(new)
        out.append({"track": ti, "name": name, "program": prog, "channel": ch,
                    "percussion": perc, "drum": drum})
    mid.save(midi_path)
    return out


def midi_has_notes(track) -> bool:
    return any(m.type == "note_on" and getattr(m, "velocity", 0) > 0 for m in track)

# -*- coding: utf-8 -*-
"""「变谱」的 GM 音色回填（engine/midi_programs.py）。

用户实测：「部分音色对不上」。三件事必须钉住：
1. 定音鼓/钟琴是**有音高**的打击乐，不能扔进 9 号鼓组通道（否则音高被当成鼓）；
2. 真正无音高的打击乐（吊镲等）要进 9 号通道，并且把音符号换成对应鼓音；
3. 认不出名字的轨（OCR 失败）不许一律给大钢琴 —— 按音域猜最接近的音色。
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import midi_programs as MP


def test_pitched_percussion_stays_on_melodic_channels():
    assert not MP.is_percussion("Timpani")
    assert not MP.is_percussion("Glockenspiel")
    assert not MP.is_percussion("Tubular Bells")
    assert MP.program_for("Timpani") == 47
    assert MP.program_for("Glockenspiel") == 9
    assert MP.program_for("Tubular Bells") == 14


def test_unpitched_percussion_maps_to_drum_notes():
    assert MP.is_percussion("Crash Cymbal")
    assert MP.drum_note_for("Crash Cymbal") == 49
    assert MP.is_percussion("Snare Drum") and MP.drum_note_for("Snare Drum") == 38
    assert MP.is_percussion("Bass Drum") and MP.drum_note_for("Bass Drum") == 36


def _mk_midi(path):
    import mido
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    mid.tracks.append(mido.MidiTrack())          # 0 号轨：速度/拍号
    for name, notes in [("Timpani", [55]), ("Crash Cymbal", [60]),
                        ("Part 12", [40, 41, 43]), ("Piccolo", [90])]:
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage("track_name", name=name, time=0))
        for n in notes:
            tr.append(mido.Message("note_on", note=n, velocity=90, time=0))
            tr.append(mido.Message("note_off", note=n, velocity=0, time=480))
        mid.tracks.append(tr)
    mid.save(path)


def test_apply_programs_routes_channels_and_remaps_drums():
    import mido
    d = tempfile.mkdtemp()
    p = os.path.join(d, "t.mid")
    _mk_midi(p)
    rows = MP.apply_programs(p)
    by = {r["name"]: r for r in rows if r["name"]}
    # 定音鼓：旋律通道 + GM 47（不许进 9 号鼓组通道）
    assert by["Timpani"]["channel"] != 9, by["Timpani"]
    assert by["Timpani"]["program"] == 47
    # 吊镲：9 号通道 + 鼓音 49
    assert by["Crash Cymbal"]["channel"] == 9 and by["Crash Cymbal"]["drum"] == 49
    # 认不出名字的轨：按音域猜（低音区 → 低音提琴 43），不再是大钢琴
    assert by["Part 12"]["program"] == 43, by["Part 12"]
    # 读回：定音鼓音高不动、吊镲被换成鼓音、短笛照常
    mid2 = mido.MidiFile(p)

    def notes_of(name):
        for tr in mid2.tracks:
            nm = next((str(m.name) for m in tr if m.type == "track_name"), "")
            if nm == name:
                return [m.note for m in tr if m.type == "note_on"]
        return []

    assert notes_of("Timpani") == [55]
    assert notes_of("Crash Cymbal") == [49]
    assert notes_of("Piccolo") == [90]

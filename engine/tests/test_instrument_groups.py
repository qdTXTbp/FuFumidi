# -*- coding: utf-8 -*-
"""旋律乐器组识别与归并的单测（engine/instrument_groups.py）。

背景：MuScriptor 是多乐器模型，会把同一条旋律在不同段落判成不同乐器，
于是同一段旋律每隔几小节换一次音色（实测《初音ミク-甩葱歌》）。
这里用合成 MIDI 固定住识别与归并的行为，并包含「不该动」的反例。
"""
import os
import sys

import pretty_midi

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import instrument_groups as ig  # noqa: E402


def _melody(inst, pitches, t0=0.0, step=0.5, dur=0.45):
    """往一条轨里放一串**不重叠**的音（单声部旋律线）。"""
    for k, p in enumerate(pitches):
        s = t0 + k * step
        inst.notes.append(pretty_midi.Note(velocity=90, pitch=p, start=s, end=s + dur))


def _chords(inst, t0, count, pitches=(60, 64, 67)):
    """和弦伴奏：同一时刻多个音一起响（自复调高）。"""
    for k in range(count):
        s = t0 + k * 0.5
        for p in pitches:
            inst.notes.append(pretty_midi.Note(velocity=80, pitch=p, start=s, end=s + 0.45))


def _write(tmp_path, tracks):
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    for name, program, drum, fill in tracks:
        inst = pretty_midi.Instrument(program=program, is_drum=drum, name=name)
        fill(inst)
        pm.instruments.append(inst)
    path = os.path.join(str(tmp_path), "t.mid")
    pm.write(path)
    return path


MEL_ORGAN = [64, 65, 67, 69, 67, 65, 64, 62]
MEL_LEAD = [69, 71, 72, 74, 72, 71, 69, 67]
MEL_VOICE = [67, 69, 71, 72, 74, 76, 74, 72, 71, 69]
MEL_BASS = [40, 41, 43, 45, 43, 41, 40, 38]


def test_same_melody_split_into_several_instruments_gets_merged(tmp_path):
    path = _write(tmp_path, [
        ("acoustic piano", 0, False, lambda i: _chords(i, 0.0, 40)),
        ("organ", 16, False, lambda i: _melody(i, MEL_ORGAN, 0.0)),
        ("synth lead", 80, False, lambda i: _melody(i, MEL_LEAD, 4.0)),
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 8.0)),
    ])
    info = ig.detect_melody_group(path)
    assert info["fragments"] == 3, info
    assert info["group"] == "voice", info            # 旋律音区里时长最长的一组获胜
    assert info["program"] == 52
    assert info["should_merge"] is True
    before = sum(r["notes"] for r in ig.analyze(path)[1])
    res = ig.merge_melody(path)
    assert res["merged"] is True
    assert res["moved_notes"] == len(MEL_ORGAN) + len(MEL_LEAD)
    after_rows = ig.analyze(path)[1]
    assert sum(r["notes"] for r in after_rows) == before, "音符一个都不能丢"
    names = [r["name"] for r in after_rows]
    assert "voice" in names and "organ" not in names and "synth lead" not in names
    assert "acoustic piano" in names, "伴奏轨不能被合并"
    assert ig.detect_melody_group(path)["fragments"] == 1


def test_single_melody_is_left_alone(tmp_path):
    path = _write(tmp_path, [
        ("acoustic piano", 0, False, lambda i: _chords(i, 0.0, 24)),
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
    ])
    info = ig.detect_melody_group(path)
    assert info["fragments"] == 1 and info["should_merge"] is False, info
    assert ig.merge_melody(path)["merged"] is False


def test_chordal_accompaniment_is_not_a_melody_candidate(tmp_path):
    path = _write(tmp_path, [
        ("acoustic piano", 0, False, lambda i: _chords(i, 0.0, 60)),
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
    ])
    rows = {r["name"]: r for r in ig.analyze(path)[1]}
    assert rows["acoustic piano"]["polyphony"] > ig.MAX_SELF_POLYPHONY
    assert rows["voice"]["polyphony"] <= ig.MAX_SELF_POLYPHONY
    info = ig.detect_melody_group(path)
    assert info["group"] == "voice" and [c["name"] for c in info["candidates"]] == ["voice"], info


def test_low_register_accompaniment_does_not_take_part(tmp_path):
    path = _write(tmp_path, [
        ("electric bass", 33, False, lambda i: _melody(i, MEL_BASS, 0.0)),
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
    ])
    info = ig.detect_melody_group(path)
    assert [c["name"] for c in info["candidates"]] == ["voice"], info


def test_short_decorative_tracks_are_ignored(tmp_path):
    path = _write(tmp_path, [
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
        ("flutes", 72, False, lambda i: _melody(i, [80, 81], 12.0)),   # 只有 2 个音
    ])
    info = ig.detect_melody_group(path)
    assert info["fragments"] == 1 and info["should_merge"] is False, info

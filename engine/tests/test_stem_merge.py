# -*- coding: utf-8 -*-
import json
import os

import mido

from stem_merge import merge_stem_midis, export_grouped_midi, sanitize_program_changes
from stem_roles import classify_role, role_default, select_tracks, resolve_target


def _write_midi(path, program_changes, channel=0, track_name="lead"):
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    mid.tracks.append(meta)
    tr = mido.MidiTrack()
    tr.append(mido.MetaMessage("track_name", name=track_name, time=0))
    for i, prog in enumerate(program_changes):
        tr.append(mido.Message("program_change", program=prog, channel=channel, time=0))
        tr.append(mido.Message("note_on", note=60 + i, velocity=100, channel=channel, time=0))
        tr.append(mido.Message("note_off", note=60 + i, velocity=0, channel=channel, time=480))
    tr.append(mido.MetaMessage("end_of_track", time=0))
    mid.tracks.append(tr)
    mid.save(path)


def test_classify_roles():
    assert classify_role("vocals") == "vocals"
    assert classify_role("electric bass") == "bass"
    assert classify_role("unknown synth") == "other"


def test_role_defaults_fixed():
    assert role_default("vocals")["program"] == 52
    assert role_default("drums")["channel"] == 9


def test_sanitize_removes_later_programs():
    tr = mido.MidiTrack([
        mido.Message("program_change", program=1, channel=0, time=0),
        mido.Message("note_on", note=60, velocity=1, channel=0, time=0),
        mido.Message("program_change", program=2, channel=0, time=0),
    ])
    sanitize_program_changes(tr)
    assert sum(1 for m in tr if m.type == "program_change") == 1


def test_merge_fixes_programs_channels_and_drums(tmp_path):
    a = tmp_path / "vocals.mid"
    b = tmp_path / "drums.mid"
    c = tmp_path / "piano.mid"
    _write_midi(str(a), [1, 2], channel=0, track_name="vocals")
    _write_midi(str(b), [0], channel=3, track_name="drums")
    _write_midi(str(c), [0], channel=1, track_name="piano")
    out = tmp_path / "merged.mid"
    man = tmp_path / "manifest.json"
    res = merge_stem_midis([
        {"role": "vocals", "midi": str(a), "name": "人声"},
        {"role": "drums", "midi": str(b), "name": "鼓"},
        {"role": "piano", "midi": str(c), "name": "钢琴"},
    ], str(out), str(man))
    assert res["ok"]
    mid = mido.MidiFile(str(out), charset='utf-8')
    assert len(mid.tracks) == 4
    for tr in mid.tracks[1:]:
        programs = [m for m in tr if m.type == "program_change"]
        assert len(programs) == 1
    drums = [tr for tr in mid.tracks if any(m.type == "track_name" and m.name == "鼓" for m in tr)][0]
    assert any(m.type == "program_change" and m.channel == 9 for m in drums)
    assert all(getattr(m, "channel", 9) == 9 for m in drums if hasattr(m, "channel"))
    assert json.loads(man.read_text(encoding="utf-8"))["tracks"]


def test_track_budget_auto_and_core():
    cs = [
        {"id": "v", "role": "vocals", "noteCount": 100, "confidence": 0.9},
        {"id": "d", "role": "drums", "noteCount": 200, "confidence": 0.9},
        {"id": "p", "role": "piano", "noteCount": 100, "confidence": 0.5},
        {"id": "x", "role": "other", "noteCount": 10, "confidence": 0.2},
    ]
    assert resolve_target("auto", 20) == 12
    picked = select_tracks(cs, 2)
    assert any(x["role"] == "drums" and x["action"] == "keep" for x in picked)
    assert any(x["role"] == "vocals" and x["action"] == "keep" for x in picked)


def test_export_grouped_more_than_16(tmp_path):
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    mid.tracks.append(mido.MidiTrack())
    for i in range(20):
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage("track_name", name="t%d" % i, time=0))
        tr.append(mido.Message("program_change", program=0, channel=0, time=0))
        tr.append(mido.Message("note_on", note=60, velocity=90, channel=0, time=0))
        tr.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
        mid.tracks.append(tr)
    p = tmp_path / "many.mid"
    mid.save(str(p))
    res = export_grouped_midi(str(p), str(tmp_path / "parts"))
    assert res["ok"] and len(res["files"]) >= 2

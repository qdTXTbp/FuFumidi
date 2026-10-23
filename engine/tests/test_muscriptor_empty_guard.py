# -*- coding: utf-8 -*-
"""0 音符保护：内存 MIDI 字节数音数（不写盘就能发现空结果）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine_muscriptor import _midi_note_count_bytes

try:
    import pretty_midi
except Exception:  # pragma: no cover
    pretty_midi = None


def _midi_bytes(with_note):
    import io
    import mido
    mf = mido.MidiFile()
    tr = mido.MidiTrack()
    mf.tracks.append(tr)
    tr.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(123), time=0))
    if with_note:
        tr.append(mido.Message('note_on', note=60, velocity=90, time=0))
        tr.append(mido.Message('note_off', note=60, velocity=0, time=100))
    buf = io.BytesIO()
    mf.save(file=buf)
    return buf.getvalue()


def test_empty_midi_reports_zero_notes():
    assert _midi_note_count_bytes(_midi_bytes(False)) == 0


def test_midi_with_note_reports_one():
    assert _midi_note_count_bytes(_midi_bytes(True)) == 1


def test_invalid_bytes_returns_negative():
    assert _midi_note_count_bytes(b'not a midi') == -1


def test_none_or_empty():
    assert _midi_note_count_bytes(None) == 0
    assert _midi_note_count_bytes(b'') == 0

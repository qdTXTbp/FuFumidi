# -*- coding: utf-8 -*-
"""音色稳定后处理：短命孤立乐器轨并轨（无 pretty_midi 时跳过）。"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pm = pytest.importorskip("pretty_midi")


def _midi_bytes():
    m = pm.PrettyMIDI()
    main = pm.Instrument(program=0, name="main")
    stray = pm.Instrument(program=40, name="stray")
    for i in range(12):
        t = i * 0.5
        main.notes.append(pm.Note(velocity=100, pitch=60, start=t, end=t + 0.4))
    # 两个孤立换音色音符，夹在主旋律中
    stray.notes.append(pm.Note(velocity=90, pitch=64, start=2.0, end=2.3))
    stray.notes.append(pm.Note(velocity=90, pitch=64, start=3.0, end=3.3))
    m.instruments.extend([main, stray])
    import tempfile
    fd, p = tempfile.mkstemp(suffix=".mid")
    os.close(fd)
    try:
        m.write(p)
        with open(p, "rb") as f:
            return f.read()
    finally:
        os.remove(p)


def test_stabilize_merges_minor_track_and_keeps_notes():
    import timbre_stabilize
    src = _midi_bytes()
    out, st = timbre_stabilize.stabilize_midi_bytes(src)
    assert st["moved"] == 2
    assert st["removed_tracks"] == 1
    assert st["after_tracks"] == st["before_tracks"] - 1
    # 总音符数不能丢
    import tempfile
    fd, p = tempfile.mkstemp(suffix=".mid"); os.close(fd)
    try:
        with open(p, "wb") as f:
            f.write(out)
        m2 = pm.PrettyMIDI(p)
        assert sum(len(i.notes) for i in m2.instruments) == 14
    finally:
        os.remove(p)


def test_stabilize_no_minor_tracks_noop():
    import timbre_stabilize
    m = pm.PrettyMIDI()
    a = pm.Instrument(program=0); b = pm.Instrument(program=1)
    for i in range(6):
        a.notes.append(pm.Note(velocity=100, pitch=60, start=i * 0.5, end=i * 0.5 + 0.4))
        b.notes.append(pm.Note(velocity=100, pitch=67, start=i * 0.5, end=i * 0.5 + 0.4))
    m.instruments.extend([a, b])
    import tempfile
    fd, p = tempfile.mkstemp(suffix=".mid"); os.close(fd)
    try:
        m.write(p)
        with open(p, "rb") as f:
            src = f.read()
    finally:
        os.remove(p)
    out, st = timbre_stabilize.stabilize_midi_bytes(src)
    assert st["moved"] == 0 and st["removed_tracks"] == 0

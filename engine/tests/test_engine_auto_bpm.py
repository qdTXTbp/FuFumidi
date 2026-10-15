# -*- coding: utf-8 -*-
"""auto-BPM 后处理：换速度标签时**必须**同时缩放音符 tick（2026-10-14 用户实测缺陷）。

旧实现只把 set_tempo 的数值改成测出来的 BPM，音符 tick 一个没动 →
「标签 152 BPM、位置还是 120 BPM」：文件播放快 152/120 = 1.27 倍，总长只剩音频的 79%。
实测：180 秒素材转出来只到 141.98 秒（0.789 = 120/152）；整曲 7231 秒转出来 6029 秒
（0.833 = 120/144）。用户在界面上看到的现象是「结尾拖长音」。
"""
import os
import sys

import mido
import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import audio_io  # noqa: E402
import engine as E  # noqa: E402
import preprocess  # noqa: E402

TPQ = 480


def _write_midi(path, bpm=120.0, notes=((0.0, 0.5, 60), (10.0, 10.6, 64))):
    """按子引擎的老约定写：tick = 秒 × TPQ × bpm / 60（速度标签与位置一致）。"""
    mid = mido.MidiFile(ticks_per_beat=TPQ, type=1)
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage("set_tempo", tempo=int(round(60_000_000 / bpm)), time=0))
    mid.tracks.append(meta)
    trk = mido.MidiTrack()
    events = []
    for on, off, pitch in notes:
        events.append((on, "note_on", pitch))
        events.append((off, "note_off", pitch))
    events.sort()
    last = 0
    for t, kind, pitch in events:
        tick = int(round(t * TPQ * bpm / 60.0))
        trk.append(mido.Message(kind, note=pitch,
                                velocity=100 if kind == "note_on" else 0,
                                time=tick - last))
        last = tick
    mid.tracks.append(trk)
    mid.save(str(path))
    return str(path)


def _read(path):
    """返回（起音秒数列表, tempo µs/拍）。秒数按文件自己的 tempo 换算。"""
    mid = mido.MidiFile(str(path))
    us = 500000
    for tr in mid.tracks:
        for msg in tr:
            if msg.type == "set_tempo":
                us = int(msg.tempo)
                break
        else:
            continue
        break
    onsets = []
    for tr in mid.tracks:
        tick = 0
        for msg in tr:
            tick += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                onsets.append(tick * us / 1e6 / TPQ)
    return sorted(onsets), us


@pytest.fixture
def fake_bpm(monkeypatch):
    def _set(bpm):
        monkeypatch.setattr(preprocess, "detect_bpm", lambda wav, sr: bpm)
        monkeypatch.setattr(audio_io, "load_audio_float32", lambda p, sr: [0.0])
    return _set


def test_tempo_label_and_note_positions_move_together(tmp_path, fake_bpm):
    """★ 核心回归：换速度标签之后，音符的**绝对秒数**必须不变。"""
    path = _write_midi(tmp_path / "a.mid", bpm=120.0)
    fake_bpm(152)
    E._apply_auto_bpm(path, "fake.wav")
    onsets, us = _read(path)
    assert us == int(round(60_000_000 / 152.0)), us
    assert len(onsets) == 2, onsets
    assert abs(onsets[0] - 0.0) < 0.01 and abs(onsets[1] - 10.0) < 0.01, onsets


def test_existing_tempo_is_the_scale_base(tmp_path, fake_bpm):
    """文件本来就不是 120 BPM 时（界面手填的导出速度），缩放基准要用它自己的速度。"""
    path = _write_midi(tmp_path / "b.mid", bpm=100.0)
    fake_bpm(150)
    E._apply_auto_bpm(path, "fake.wav")
    onsets, us = _read(path)
    assert us == int(round(60_000_000 / 150.0)), us
    assert abs(onsets[0] - 0.0) < 0.01 and abs(onsets[1] - 10.0) < 0.01, onsets


def test_same_bpm_is_a_noop(tmp_path, fake_bpm):
    path = _write_midi(tmp_path / "c.mid", bpm=120.0)
    fake_bpm(120)
    E._apply_auto_bpm(path, "fake.wav")
    onsets, us = _read(path)
    assert us == 500000 and abs(onsets[1] - 10.0) < 0.01, (us, onsets)


def test_detect_failure_keeps_file_untouched(tmp_path, fake_bpm):
    path = _write_midi(tmp_path / "d.mid", bpm=120.0)
    fake_bpm(None)
    E._apply_auto_bpm(path, "fake.wav")
    onsets, us = _read(path)
    assert us == 500000 and abs(onsets[1] - 10.0) < 0.01, (us, onsets)


def test_long_file_has_no_rounding_drift(tmp_path, fake_bpm):
    """100 分钟级素材：按绝对 tick 缩放 → 末尾不能有累积漂移。"""
    notes = tuple((i * 60.0, i * 60.0 + 0.5, 60) for i in range(100))   # 到 5940 秒
    path = _write_midi(tmp_path / "e.mid", bpm=120.0, notes=notes)
    fake_bpm(152)
    E._apply_auto_bpm(path, "fake.wav")
    onsets, _us = _read(path)
    assert len(onsets) == 100
    assert abs(onsets[-1] - 5940.0) < 0.02, onsets[-1]

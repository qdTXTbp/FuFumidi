# -*- coding: utf-8 -*-
"""midi_post.py 纯逻辑测试。

约束：不 import 任何重型 ML 库（torch / basic_pitch / demucs / piano_transcription）。
midi_post.py 顶层没有任何 import，可直接轻量导入；它只操作传入对象的属性
（.instruments / .notes / note.pitch/.start/.end/.velocity），因此测试用
轻量假对象模拟 pretty_midi 的 Note / Instrument / PrettyMIDI 接口，
保证离线、无需 pretty_midi 也能跑。

写测试前已读 midi_post.py 确认签名：
  - merge_overlap(midi, gap_ms=30.0) -> bool
  - remove_micro_notes(midi, min_ms=0.0) -> int
  - normalize_velocity(midi, lo=28, hi=112, contrast=1.0) -> True | None
  - apply_post(midi, params=None, log_cb=None) -> dict
  - count_notes(midi) -> int
"""

import pytest

import midi_post


# ---------- 轻量假对象（接口与 pretty_midi 一致） ----------

class _Note:
    def __init__(self, pitch, start, end, velocity=64):
        self.pitch = pitch
        self.start = start
        self.end = end
        self.velocity = velocity

    def __repr__(self):
        return f"_Note(pitch={self.pitch}, {self.start}-{self.end}, v={self.velocity})"


class _Instrument:
    def __init__(self, notes=None):
        self.notes = list(notes or [])


class _Midi:
    def __init__(self, instruments=None):
        self.instruments = list(instruments or [])


def _one_track_midi(notes):
    return _Midi([_Instrument(notes)])


# ---------- count_notes ----------

def test_count_notes_totals_all_tracks():
    midi = _Midi([
        _Instrument([_Note(60, 0.0, 1.0), _Note(62, 0.0, 1.0)]),
        _Instrument([_Note(40, 0.0, 1.0)]),
    ])
    assert midi_post.count_notes(midi) == 3


def test_count_notes_empty_midi():
    assert midi_post.count_notes(_Midi([])) == 0


# ---------- merge_overlap ----------

def test_merge_overlap_merges_same_pitch_within_gap():
    midi = _one_track_midi([
        _Note(60, 0.0, 1.0, velocity=40),
        _Note(60, 1.05, 2.0, velocity=100),
    ])
    changed = midi_post.merge_overlap(midi, gap_ms=100)  # gap=0.1s
    assert changed is True
    notes = midi.instruments[0].notes
    assert len(notes) == 1
    assert notes[0].start == 0.0
    assert notes[0].end == 2.0


def test_merge_overlap_takes_max_velocity():
    midi = _one_track_midi([
        _Note(60, 0.0, 1.0, velocity=40),
        _Note(60, 1.05, 2.0, velocity=100),
    ])
    midi_post.merge_overlap(midi, gap_ms=100)
    assert midi.instruments[0].notes[0].velocity == 100


def test_merge_overlap_no_merge_beyond_gap():
    midi = _one_track_midi([
        _Note(60, 0.0, 1.0),
        _Note(60, 1.2, 2.0),  # 1.2 > 1.0 + 0.1
    ])
    changed = midi_post.merge_overlap(midi, gap_ms=100)
    assert changed is False
    assert len(midi.instruments[0].notes) == 2


def test_merge_overlap_different_pitch_never_merges():
    midi = _one_track_midi([
        _Note(60, 0.0, 1.0),
        _Note(62, 1.01, 2.0),
    ])
    changed = midi_post.merge_overlap(midi, gap_ms=100)
    assert changed is False
    assert len(midi.instruments[0].notes) == 2


def test_merge_overlap_zero_gap_only_touching_notes():
    # gap_ms=0 → 仅当 n.start <= prev.end（完全重叠或首尾相接）才合并
    midi = _one_track_midi([
        _Note(60, 0.0, 1.0),
        _Note(60, 1.0, 2.0),
    ])
    assert midi_post.merge_overlap(midi, gap_ms=0) is True


# ---------- remove_micro_notes ----------

def test_remove_micro_notes_removes_short_only():
    midi = _one_track_midi([
        _Note(60, 0.0, 0.05),   # 50ms → 删
        _Note(62, 0.0, 0.2),    # 200ms → 留
    ])
    removed = midi_post.remove_micro_notes(midi, min_ms=100)
    assert removed == 1
    assert [n.pitch for n in midi.instruments[0].notes] == [62]


def test_remove_micro_notes_zero_min_ms_is_noop():
    midi = _one_track_midi([_Note(60, 0.0, 0.01)])
    assert midi_post.remove_micro_notes(midi, min_ms=0) == 0
    assert len(midi.instruments[0].notes) == 1


def test_remove_micro_notes_boundary_exactly_min_ms_kept():
    midi = _one_track_midi([_Note(60, 0.0, 0.1)])  # 恰好 100ms
    assert midi_post.remove_micro_notes(midi, min_ms=100) == 0


# ---------- normalize_velocity ----------

def test_normalize_velocity_scales_to_target_range():
    midi = _one_track_midi([_Note(60, 0.0, 1.0, velocity=40),
                            _Note(62, 0.0, 1.0, velocity=80)])
    assert midi_post.normalize_velocity(midi) is True
    vs = [n.velocity for n in midi.instruments[0].notes]
    assert min(vs) == 28   # lo
    assert max(vs) == 112  # hi


def test_normalize_velocity_all_same_velocity_maps_to_lo():
    midi = _one_track_midi([_Note(60, 0.0, 1.0, velocity=64),
                            _Note(62, 0.0, 1.0, velocity=64)])
    midi_post.normalize_velocity(midi)
    # 源码：span = (v_max - v_min) or 1.0；v_max == v_min 时 t = 0 → 全部落向 lo=28
    assert [n.velocity for n in midi.instruments[0].notes] == [28, 28]


def test_normalize_velocity_empty_midi_returns_none():
    assert midi_post.normalize_velocity(_Midi([])) is None


# ---------- apply_post ----------

def test_apply_post_default_merges_and_normalizes():
    # 默认 merge_gap_ms=30：两音符间隔 20ms（0.02s）可被合并
    midi = _one_track_midi([
        _Note(60, 0.0, 1.0, velocity=40),
        _Note(60, 1.02, 2.0, velocity=100),
    ])
    report = midi_post.apply_post(midi)
    assert report["merged"] is True
    assert report["vel_norm"] is True
    assert len(midi.instruments[0].notes) == 1
    assert midi.instruments[0].notes[0].end == 2.0


def test_apply_post_removes_short_notes():
    midi = _one_track_midi([
        _Note(60, 0.0, 0.05),
        _Note(62, 0.0, 0.2),
    ])
    report = midi_post.apply_post(
        midi,
        {"merge_overlap": False, "normalize_vel": False, "min_note_after_ms": 100},
    )
    assert report["removed_short"] == 1
    assert [n.pitch for n in midi.instruments[0].notes] == [62]


def test_apply_post_disabled_steps_produce_empty_report():
    midi = _one_track_midi([_Note(60, 0.0, 1.0)])
    report = midi_post.apply_post(
        midi, {"merge_overlap": False, "normalize_vel": False}
    )
    assert report == {}


def test_apply_post_calls_log_cb():
    logs = []
    midi = _one_track_midi([_Note(60, 0.0, 1.0)])
    midi_post.apply_post(midi, log_cb=logs.append)
    assert len(logs) >= 1


def test_apply_post_log_cb_never_raises():
    # log_cb 抛异常也应被吞掉
    def boom(_msg):
        raise RuntimeError("boom")

    midi = _one_track_midi([_Note(60, 0.0, 1.0)])
    report = midi_post.apply_post(midi, log_cb=boom)
    assert "vel_norm" in report


# ---------- 真实 pretty_midi 集成（若已安装） ----------

def test_real_pretty_midi_objects():
    """用真实 pretty_midi 对象跑一遍，验证假对象接口没有漂移。

    pretty_midi 不在重型 ML 库之列（只依赖 numpy/scipy），此处仅作集成验证；
    若未安装则跳过（离线环境其余用例仍全部可跑）。
    """
    pretty_midi = pytest.importorskip("pretty_midi")
    inst = pretty_midi.Instrument(program=0)
    inst.notes = [
        pretty_midi.Note(velocity=40, pitch=60, start=0.0, end=1.0),
        pretty_midi.Note(velocity=100, pitch=60, start=1.05, end=2.0),
    ]
    pm = pretty_midi.PrettyMIDI()
    pm.instruments.append(inst)

    assert midi_post.count_notes(pm) == 2
    assert midi_post.merge_overlap(pm, gap_ms=100) is True
    assert len(inst.notes) == 1
    assert inst.notes[0].velocity == 100
    assert midi_post.normalize_velocity(pm) is True

# -*- coding: utf-8 -*-
"""「跨块延音缝合」回归测试（engine_muscriptor._stitch_chunk_boundaries）。

背景（2026-10-18 用户）：「长音问题复发，一直响」。实测那首 154s 的歌：
  · prelude_forcing 开（模型强制 tie）→ 7115 个音符、时长中位数 20ms、最长 82.9s；
  · prelude_forcing 关（模型自己猜 tie）→ 788 个音符、中位数 0.54s、最长 12s，
    但块边界上的延音可能被切断/换乐器。
所以现在：**解码一律关掉强制 tie（不可能再有僵尸长音）+ 解码后缝合真实延音**。

这里锁死四件事：
  1) 边界两侧同轨同音高的延音必须缝成一个长音（连续性不丢）；
  2) 不同音高 / 间隔过大 / 不同轨（不同乐器）一律不缝（不许改音色、不许乱连）；
  3) 缝合后 MIDI 仍可正常解析，轨道名/音色等非音符事件不丢；
  4) 引擎路径：传 prelude_forcing=True 时**交给模型的是 False**，并打缝合日志；
     只有显式 FUFUMIDI_LEGACY_PRELUDE=1 才保留旧行为（调试对照用）。
"""
import io
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import mido  # noqa: E402
import engine_muscriptor as M  # noqa: E402

TPB = 480
TEMPO = 500000          # 500ms/拍 → 960 tick/s → 5s = 4800 tick
TICK = 960.0


def _build_midi(tracks):
    """tracks: [[(start_tick, end_tick, pitch, program), ...], ...]（每个 track 一个轨道）"""
    mid = mido.MidiFile(type=1, ticks_per_beat=TPB)
    meta = mido.MidiTrack()
    mid.tracks.append(meta)
    meta.append(mido.MetaMessage("set_tempo", tempo=TEMPO, time=0))
    for ti, notes in enumerate(tracks):
        tr = mido.MidiTrack()
        mid.tracks.append(tr)
        tr.append(mido.MetaMessage("track_name", name="track%d" % ti, time=0))
        if notes:
            tr.append(mido.Message("program_change", program=int(notes[0][3]), channel=0, time=0))
        evs = []
        for (s, e, p, _prog) in notes:
            evs.append((int(s), 1, mido.Message("note_on", note=int(p), velocity=100, channel=0)))
            evs.append((int(e), 0, mido.Message("note_off", note=int(p), velocity=0, channel=0)))
        evs.sort(key=lambda x: (x[0], x[1]))
        prev = 0
        for tick, _o, msg in evs:
            tr.append(msg.copy(time=tick - prev))
            prev = tick
        tr.append(mido.MetaMessage("end_of_track", time=0))
    buf = io.BytesIO()
    mid.save(file=buf)
    return buf.getvalue()


def _sec_of(mid, tick):
    """tick → 秒（按文件速度表）；缝合测试不锁死 resolution —— pretty_midi 默认 220。"""
    t = 0
    tempo = 500000
    tpb = mid.ticks_per_beat or 480
    for tr in mid.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "set_tempo":
                tempo = msg.tempo
                break
        break
    return tick / float(tpb) * (tempo / 1e6)


def _notes_of(midi_bytes):
    mid = mido.MidiFile(file=io.BytesIO(midi_bytes))
    out = []
    for tr in mid.tracks:
        t = 0
        on = {}
        for msg in tr:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                on.setdefault((msg.channel, msg.note), []).append(t)
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                k = (msg.channel, msg.note)
                if on.get(k):
                    out.append((msg.note, on[k].pop(0), t))
    return mid, out


def test_stitches_a_sustain_across_one_chunk_boundary():
    data = _build_midi([[(0, 4800, 60, 0), (4800, 6720, 60, 0)]])
    out, st = M._stitch_chunk_boundaries(data)
    assert st["merged"] == 1
    _mid, notes = _notes_of(out)
    assert len(notes) == 1, notes
    assert notes[0][0] == 60 and notes[0][1] == 0 and notes[0][2] == 6720


def test_stitches_a_chain_across_three_chunks():
    data = _build_midi([[(0, 4800, 64, 0), (4800, 9600, 64, 0), (9600, 11520, 64, 0)]])
    out, st = M._stitch_chunk_boundaries(data)
    assert st["merged"] == 2
    _mid, notes = _notes_of(out)
    assert len(notes) == 1, notes
    assert notes[0][2] == 11520


def test_does_not_stitch_different_pitches():
    data = _build_midi([[(0, 4800, 60, 0), (4800, 6720, 62, 0)]])
    out, st = M._stitch_chunk_boundaries(data)
    assert st["merged"] == 0
    assert out == data


def test_does_not_stitch_across_a_gap():
    # 前一个音在 4.7s 结束，后一个 5.2s 才开始：间隔 0.5s，不是同一颗持续音
    data = _build_midi([[(0, 4512, 60, 0), (4992, 6720, 60, 0)]])
    _out, st = M._stitch_chunk_boundaries(data)
    assert st["merged"] == 0


def test_does_not_stitch_across_tracks():
    # 不同轨 = 不同乐器身份，缝起来会改音色 —— 绝不缝
    data = _build_midi([[(0, 4800, 60, 0)], [(4800, 6720, 60, 25)]])
    _out, st = M._stitch_chunk_boundaries(data)
    assert st["merged"] == 0


def test_preserves_track_names_and_programs():
    data = _build_midi([[(0, 4800, 60, 24), (4800, 6720, 60, 24)]])
    out, st = M._stitch_chunk_boundaries(data)
    assert st["merged"] == 1
    mid, _notes = _notes_of(out)
    names = [m.name for tr in mid.tracks for m in tr if m.type == "track_name"]
    progs = [m.program for tr in mid.tracks for m in tr if m.type == "program_change"]
    assert names == ["track0"], names
    assert progs == [24], progs


# ---------------------------------------------------------------- 引擎路径接线

class _FakeModel:
    captured_kw = None

    def __init__(self):
        class _Dev:
            type = "cpu"
        self._device = _Dev()

    @classmethod
    def load_model(cls, arg, device=None, **kw):
        return cls()

    def transcribe(self, path, **kw):
        type(self).captured_kw = dict(kw)
        from muscriptor.events import NoteStartEvent, NoteEndEvent
        # 一粒跨边界的延音：0..5s + 5..7s（4800/6720 tick 对应 5.0/7.0s）
        yield NoteStartEvent(pitch=60, start_time=0.0, index=0, instrument="piano")
        yield NoteEndEvent(end_time=5.0, start_event=NoteStartEvent(pitch=60, start_time=0.0, index=0, instrument="piano"))
        yield NoteStartEvent(pitch=60, start_time=5.0, index=1, instrument="piano")
        yield NoteEndEvent(end_time=7.0, start_event=NoteStartEvent(pitch=60, start_time=5.0, index=1, instrument="piano"))

    def events_to_midi_bytes(self, events, beat_grid=None):
        import pretty_midi
        pm = pretty_midi.PrettyMIDI()
        inst = pretty_midi.Instrument(program=0)
        opens = {}
        for ev in events:
            if hasattr(ev, "start_time") and not hasattr(ev, "start_event"):
                opens[ev.index] = ev
            elif hasattr(ev, "start_event"):
                st = opens.pop(ev.start_event_index, None)
                if st is not None:
                    inst.notes.append(pretty_midi.Note(velocity=100, pitch=st.pitch,
                                                       start=st.start_time, end=ev.end_time))
        pm.instruments.append(inst)
        buf = io.BytesIO()
        pm.write(buf)
        return buf.getvalue()


@pytest.fixture
def run_transcribe(monkeypatch, tmp_path):
    import muscriptor
    import audio_io

    def _run(monkeypatch_env=None):
        monkeypatch.setattr(muscriptor, "TranscriptionModel", _FakeModel)
        monkeypatch.setattr(M, "_require_package", lambda: None)
        monkeypatch.setattr(M, "_find_local_model", lambda size: str(tmp_path / "model.safetensors"))
        monkeypatch.setattr(M, "_ensure_config", lambda *a, **k: None)
        wav = tmp_path / "in.wav"
        wav.write_bytes(b"RIFF")
        monkeypatch.setattr(audio_io, "decode_to_wav", lambda p, sr=16000: str(wav))
        monkeypatch.setattr(audio_io, "remove_temp", lambda p: None)
        logs = []
        out = str(tmp_path / "out.mid")
        M.transcribe_muscriptor(str(wav), out, params={"model_size": "medium", "prelude_forcing": True},
                                log_cb=logs.append)
        with open(out, "rb") as fh:
            return fh.read(), logs, _FakeModel.captured_kw

    return _run


def test_engine_disables_model_prelude_and_stitches(run_transcribe):
    data, logs, kw = run_transcribe()
    assert kw.get("prelude_forcing") is False, "模型层不许再开强制 tie：%r" % (kw,)
    assert any("跨块延音缝合：接合 1 处" in s for s in logs), logs
    mid, notes = _notes_of(data)
    assert len(notes) == 1, notes
    assert abs(_sec_of(mid, notes[0][2]) - 7.0) < 0.02, notes


def test_legacy_env_restores_old_model_behavior(run_transcribe, monkeypatch):
    monkeypatch.setenv("FUFUMIDI_LEGACY_PRELUDE", "1")
    _data, _logs, kw = run_transcribe()
    assert kw.get("prelude_forcing") is True, "LEGACY 环境变量应恢复旧行为（调试对照用）"

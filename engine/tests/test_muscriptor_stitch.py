# -*- coding: utf-8 -*-
"""「跨块延音」的回归测试（engine_muscriptor）。

★ 2026-11-01：全面回退 4.3.x 转录逻辑（用户报障「muscriptor 无法转录」）。
6.x 默认路径在模型调用前叠加了一整串补丁层（预处理/证据/探测/生成参数/事件流/
缝合），任何一层与用户机上旧版 muscriptor 包的 API 对不上就整次报废。所以：
  · **默认 = 4.3.x 兼容模式**：model.transcribe(wav) 裸调用（零 kwargs）、
    零后处理、不缝合 —— 引擎路径测试锁死 captured_kw == {}；
  · 调试才进新流水线：FUFUMIDI_MS_MODERN=1，此时沿用 10-31 的契约
    （默认 prelude_forcing=True 交给模型；显式 False → 模型收到 False + 解码后缝合）。

缝合函数本身的单测（下面 1-3 条）不变：
  1) 边界两侧同轨同音高的延音必须缝成一个长音（连续性不丢）；
  2) 不同音高 / 间隔过大 / 不同轨（不同乐器）一律不缝（不许改音色、不许乱连）；
  3) 缝合后 MIDI 仍可正常解析，轨道名/音色等非音符事件不丢。
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

    def _run(overrides=None):
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
        params = {"model_size": "medium"}
        params.update(overrides or {})
        M.transcribe_muscriptor(str(wav), out, params=params, log_cb=logs.append)
        with open(out, "rb") as fh:
            return fh.read(), logs, _FakeModel.captured_kw

    return _run


def test_engine_default_is_legacy_bare_call(run_transcribe):
    """★ 2026-11-01 默认 = 4.3.x 兼容模式：model.transcribe(wav) **零 kwargs**、零后处理。

    这是「muscriptor 无法转录」的根因修复：6.x 默认传 batch_size 等新 kwargs，
    用户机上旧版 muscriptor 包不认就 TypeError 整次报废。这里锁死裸调用。
    """
    data, logs, kw = run_transcribe()
    assert kw == {}, "默认必须是 4.3.x 裸调用（零 kwargs），实际传了：%r" % (kw,)
    assert not any("跨块延音缝合：接合" in s for s in logs), logs
    assert not any("音频证据式收尾" in s for s in logs), logs
    assert any("4.3.x 兼容模式" in s for s in logs), logs
    _mid, notes = _notes_of(data)
    assert len(notes) == 2, notes            # 模型给的两颗（0-5s / 5-7s）原样保留


def test_engine_legacy_ignores_prelude_param(run_transcribe):
    """4.3.x 模式下 prelude_forcing 参数被忽略 —— 模型收到的是上游默认（零 kwargs）。"""
    _data, _logs, kw = run_transcribe({"prelude_forcing": False})
    assert kw == {}, "兼容模式下不许把 prelude_forcing 传给模型：%r" % (kw,)


def test_engine_stitches_when_prelude_explicitly_off(run_transcribe, monkeypatch):
    """调试路径（FUFUMIDI_MS_MODERN=1）：显式取消跨块延音 → prelude 关 + 解码后缝合。"""
    monkeypatch.setenv("FUFUMIDI_MS_MODERN", "1")
    data, logs, kw = run_transcribe({"prelude_forcing": False})
    assert kw.get("prelude_forcing") is False, "显式关闭时不应该再交给模型开：%r" % (kw,)
    assert any("跨块延音缝合：接合 1 处" in s for s in logs), logs
    mid, notes = _notes_of(data)
    assert len(notes) == 1, notes
    assert abs(_sec_of(mid, notes[0][2]) - 7.0) < 0.02, notes

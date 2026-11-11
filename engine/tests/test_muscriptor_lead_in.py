# -*- coding: utf-8 -*-
"""边界对齐修正（lead-in）契约，2026-11-11。

参考 DamRsn/muscriptor.cpp（NeuralNote v2 的 C++/ggml 引擎）的 Transcriber：
官方 Python 版把「chunk 开头已经在响的声音」当成需要续的 tie prologue，
drum hit 不发出，于是块首的鼓被整段吞掉。补 0.2s 静音并把所有事件时间回移，
可让每个 5 秒块的开头落在静音上。

本机实测（NightTheater 前 30s，medium/CPU，只改输入音频）：
  原始·贪心        鼓 236  每 5s 32/53/0/0/84/67
  前补0.2s·贪心    鼓 331  每 5s 32/54/50/58/79/58   ← 空鼓块 2→0

锁四条：
  1) 主转录用带静音的输入，节拍网格与预分析仍用原音频
  2) NoteStart/NoteEnd 时间整体回移，ProgressEvent 与事件顺序原样
  3) add_lead_in 不改采样率/声道/样本，只在前面补静音
  4) 环境变量可关闭、生成失败可降级、结束后临时文件被清掉
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture()
def fake(monkeypatch, tmp_path):
    import numpy as np
    import soundfile as sf
    import muscriptor
    import engine_muscriptor as M
    import audio_io
    from muscriptor.events import ProgressEvent, NoteStartEvent, NoteEndEvent

    # 真实可解码的短音频（1 秒 16k mono），否则 sf.info 会失败退化成「不补静音」
    sr = 16000
    y = (0.1 * np.sin(2 * np.pi * 440 * np.arange(sr) / sr)).astype("float32")
    audio = tmp_path / "in.wav"
    sf.write(str(audio), y, sr, subtype="FLOAT")

    calls = {"grid": [], "transcribe": [], "midi": []}

    class Model:
        _device = type("D", (), {"type": "cpu"})()

        @classmethod
        def load_model(cls, arg, **kw):
            return cls()

        def detect_beat_grid_for(self, audio, mode="best-effort"):
            calls["grid"].append((audio, mode))
            return None

        def transcribe(self, audio, prelude_forcing=True, instruments=None, **kw):
            calls["transcribe"].append(audio)
            start = NoteStartEvent(pitch=60, start_time=0.5, index=1,
                                   instrument="acoustic_piano")
            yield ProgressEvent(completed=0, total=1)
            yield start
            yield ProgressEvent(completed=1, total=1)
            yield NoteEndEvent(end_time=1.0, start_event=start)

        def events_to_midi_bytes(self, events, beat_grid=None):
            calls["midi"].append((list(events), beat_grid))
            return b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x00\x60"

    monkeypatch.setattr(muscriptor, "TranscriptionModel", Model)
    monkeypatch.setattr(M, "_require_package", lambda: None)
    # 让 _detect_grid 真的走到 detect_beat_grid_for，才能断言网格用的是原音频
    monkeypatch.setattr(M, "_grid_checkpoint_available", lambda: True)
    monkeypatch.setattr(M, "_find_local_model", lambda size: str(tmp_path / "model.safetensors"))
    monkeypatch.setattr(M, "_ensure_config", lambda *a, **k: None)
    monkeypatch.setattr(M, "_count_notes", lambda p: 2)
    monkeypatch.setattr(M, "_midi_note_count_bytes", lambda data: 2)
    monkeypatch.setattr(audio_io, "prepare_for_muscriptor", lambda p: (str(p), False))
    monkeypatch.delenv("FUFUMIDI_MS_LEADIN", raising=False)

    return M, audio_io, Model, calls, str(audio), sr, (ProgressEvent, NoteStartEvent, NoteEndEvent)


def _run(M, audio, tmp_path, logs=None):
    return M.transcribe_muscriptor(audio, str(tmp_path / "out.mid"),
                                   params={"model_size": "medium",
                                           "muscriptor_instruments": "none"},
                                   log_cb=(logs.append if logs is not None else None))


def test_lead_in_is_default_and_shift_is_applied(fake, tmp_path):
    M, audio_io, _Model, calls, audio, sr, (ProgressEvent, NoteStartEvent, NoteEndEvent) = fake
    logs = []
    _run(M, audio, tmp_path, logs)

    lead = calls["transcribe"][0]
    assert lead != audio, "主转录必须用带前置静音的输入"
    assert os.path.isfile(lead) is False, "临时 lead-in wav 用完必须删掉"
    assert calls["grid"][0][0] == audio, "节拍网格仍以原音频为时间基准"
    assert any("边界对齐修正" in s for s in logs)

    events, _grid = calls["midi"][0]
    assert [type(e).__name__ for e in events] == [
        "ProgressEvent", "NoteStartEvent", "ProgressEvent", "NoteEndEvent"
    ], "事件数量/顺序不许变"
    assert abs(events[1].start_time - 0.3) < 1e-6
    assert abs(events[3].end_time - 0.8) < 1e-6
    assert events[3].start_event is events[1]
    assert events[0].completed == 0 and events[2].completed == 1


def test_add_lead_in_preserves_samples(fake, tmp_path):
    """只在前面补静音：采样率、声道数、原始样本都不许动。"""
    import numpy as np
    import soundfile as sf
    _M, audio_io, _Model, _calls, audio, sr, _ev = fake
    original, _ = sf.read(audio, dtype="float32", always_2d=True)
    out, sec = audio_io.add_lead_in(audio, 0.2)
    assert out and sec > 0
    try:
        info = sf.info(out)
        assert info.samplerate == sr
        assert info.channels == original.shape[1]
        got, _ = sf.read(out, dtype="float32", always_2d=True)
        pad = int(round(0.2 * sr))
        assert len(got) == len(original) + pad
        assert np.all(got[:pad] == 0), "前导必须是纯静音"
        assert np.allclose(got[pad:], original, atol=1e-6), "原始样本不许被重采样/改写"
    finally:
        audio_io.remove_temp(out)


def test_lead_in_can_be_disabled(fake, tmp_path, monkeypatch):
    M, _audio_io, _Model, calls, audio, _sr, _ev = fake
    monkeypatch.setenv("FUFUMIDI_MS_LEADIN", "0")
    _run(M, audio, tmp_path)
    assert calls["transcribe"][0] == audio
    events, _ = calls["midi"][0]
    assert abs(events[1].start_time - 0.5) < 1e-6
    assert abs(events[3].end_time - 1.0) < 1e-6


def test_lead_in_failure_degrades_to_original_audio(fake, tmp_path, monkeypatch):
    """读不了/生成失败时，绝不能拖垮转录。"""
    M, audio_io, _Model, calls, audio, _sr, _ev = fake
    monkeypatch.setattr(audio_io, "add_lead_in", lambda *a, **k: (None, 0.0))
    logs = []
    _run(M, audio, tmp_path, logs)
    assert calls["transcribe"][0] == audio
    assert not any("边界对齐修正" in s for s in logs)
    events, _ = calls["midi"][0]
    assert abs(events[1].start_time - 0.5) < 1e-6


def test_add_lead_in_returns_none_on_unreadable_file(tmp_path):
    import audio_io
    bad = tmp_path / "bad.flac"
    bad.write_bytes(b"fLaC")
    out, sec = audio_io.add_lead_in(str(bad))
    assert out is None and sec == 0.0

# -*- coding: utf-8 -*-
"""官方事件流的两个契约（2026-11-08，对照官方提交 302343e8 / 第三方 music-to-midi）：

1) `transcribe()` 的事件流会交织 ProgressEvent(completed, total)，
   `events_to_midi_bytes()` 会把它丢掉 —— 必须在流上拦截并转成 `###PROG`，
   否则转录页的真实分块进度与任务中心进度都永远停在「推理中」。
2) 跨块音色 / 鼓组稳定的官方杠杆是 prelude_forcing=True 与可选的
   instruments= 硬约束。本机 muscriptor 支持时才传（旧 wheel 必须退回零 kwargs，
   6.4.5 曾因无条件传新参数 TypeError 整次失败）。

注意：**不许改事件** —— 进度事件原样往下传，暂停闸门仍然有效。
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture()
def fake(monkeypatch, tmp_path):
    import muscriptor
    import engine_muscriptor as M
    from muscriptor.events import ProgressEvent

    calls = {"transcribe": [], "midi": [], "grid": []}

    class ModernModel:
        """显式签名 = 本机 0.3.0 那种支持官方参数的 wheel。"""
        _device = type("D", (), {"type": "cpu"})()

        @classmethod
        def load_model(cls, arg, **kw):
            return cls()

        def detect_beat_grid_for(self, audio, mode="best-effort"):
            calls["grid"].append((audio, mode))
            return None

        def transcribe(self, audio, prelude_forcing=True, instruments=None, **kw):
            calls["transcribe"].append((audio, dict(prelude_forcing=prelude_forcing,
                                                    instruments=instruments, **kw)))
            # 官方顺序：开头 0/N，之后每块一个
            yield ProgressEvent(completed=0, total=3)
            yield "note-1"
            yield ProgressEvent(completed=1, total=3)
            yield "note-2"
            yield ProgressEvent(completed=3, total=3)

        def events_to_midi_bytes(self, events, beat_grid=None):
            calls["midi"].append(list(events))
            return b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x00\x60"

    class LegacyModel(ModernModel):
        """旧 wheel：没有 prelude_forcing / instruments 参数。"""
        def transcribe(self, audio):
            calls["transcribe"].append((audio, {}))
            yield ProgressEvent(completed=0, total=1)
            yield "note-1"
            yield ProgressEvent(completed=1, total=1)

    monkeypatch.setattr(muscriptor, "TranscriptionModel", ModernModel)
    monkeypatch.setattr(M, "_require_package", lambda: None)
    monkeypatch.setattr(M, "_grid_checkpoint_available", lambda: False)
    monkeypatch.setattr(M, "_find_local_model", lambda size: str(tmp_path / "model.safetensors"))
    monkeypatch.setattr(M, "_ensure_config", lambda *a, **k: None)
    monkeypatch.setattr(M, "_count_notes", lambda p: 2)
    monkeypatch.setattr(M, "_midi_note_count_bytes", lambda data: 2)

    import audio_io
    monkeypatch.setattr(audio_io, "prepare_for_muscriptor", lambda p: (str(p), False))

    audio = tmp_path / "in.flac"
    audio.write_bytes(b"fLaC")
    return M, muscriptor, ModernModel, LegacyModel, calls, str(audio)


def _run(M, audio, tmp_path, params=None, logs=None):
    # 默认显式 'none'：这些用例只测事件流/参数形态，别真去跑预分析（要读音频、跑模型）
    p = dict(params or {})
    p.setdefault("model_size", "medium")
    p.setdefault("muscriptor_instruments", "none")
    return M.transcribe_muscriptor(audio, str(tmp_path / "out.mid"),
                                  params=p,
                                  log_cb=(logs.append if logs is not None else None))


def test_progress_events_become_prog_lines(fake, tmp_path):
    M, _ms, _Modern, _Legacy, calls, audio = fake
    logs = []
    _run(M, audio, tmp_path, logs=logs)
    prog = [s for s in logs if s.startswith("###PROG ")]
    assert len(prog) == 3, prog
    assert '"completed": 0' in prog[0] and '"total": 3' in prog[0]
    assert '"completed": 3' in prog[-1]
    # 转录页的 engine:log 监听也认这个前缀（ViewTranscribe.vue 的 realPct）
    assert any("[推理] 已转录 3/3" in s for s in logs)


def test_progress_events_are_not_swallowed_or_reordered(fake, tmp_path):
    """官方 events_to_midi_bytes 会忽略 ProgressEvent，但我们的包装器不能吃掉/改序。"""
    M, _ms, _Modern, _Legacy, calls, audio = fake
    _run(M, audio, tmp_path)
    seen = calls["midi"][0]
    assert [type(x).__name__ for x in seen] == [
        "ProgressEvent", "str", "ProgressEvent", "str", "ProgressEvent"
    ], seen


def test_official_prelude_forcing_is_explicit_on_supported_wheel(fake, tmp_path):
    M, _ms, _Modern, _Legacy, calls, audio = fake
    _run(M, audio, tmp_path)
    assert calls["transcribe"][0][1]["prelude_forcing"] is True
    assert calls["transcribe"][0][1]["instruments"] is None


def test_instrument_hard_constraint_is_forwarded(fake, tmp_path):
    M, _ms, _Modern, _Legacy, calls, audio = fake
    logs = []
    _run(M, audio, tmp_path,
         params={"model_size": "medium", "muscriptor_instruments": "drums,acoustic_piano"},
         logs=logs)
    assert calls["transcribe"][0][1]["instruments"] == ["drums", "acoustic_piano"]
    assert any("限定乐器组" in s for s in logs)


def test_probe_mode_locks_instruments_for_whole_song(fake, tmp_path, monkeypatch):
    """默认档：整曲预分析后把乐器组交给官方 instruments=，压住跨块换音色/鼓断续。"""
    M, _ms, _Modern, _Legacy, calls, audio = fake
    import instrument_probe
    seen = {}
    def fake_probe(model, wav_path, log=None, **kw):
        seen["wav"] = wav_path
        if log: log("[预分析] 锁定乐器组：drums / acoustic_piano")
        return {"groups": ["drums", "acoustic_piano"], "windows": [[0, 20]]}
    monkeypatch.setattr(instrument_probe, "probe", fake_probe)
    logs = []
    _run(M, audio, tmp_path, params={"muscriptor_instruments": "probe"}, logs=logs)
    assert seen["wav"] == audio
    assert calls["transcribe"][0][1]["instruments"] == ["drums", "acoustic_piano"]
    assert any("整曲锁定" in s for s in logs)


def test_probe_failure_degrades_to_official_auto(fake, tmp_path, monkeypatch):
    """预分析失败绝不能拖垮转录：退回官方自动识别。"""
    M, _ms, _Modern, _Legacy, calls, audio = fake
    import instrument_probe
    monkeypatch.setattr(instrument_probe, "probe",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("probe boom")))
    logs = []
    _run(M, audio, tmp_path, params={"muscriptor_instruments": "probe"}, logs=logs)
    assert calls["transcribe"][0][1]["instruments"] is None
    assert any("预分析" in s and "失败" in s for s in logs)


def test_legacy_wheel_falls_back_to_zero_kwargs(fake, tmp_path, monkeypatch):
    """旧 muscriptor 不认新参数：绝不能传，否则整次转录 TypeError。"""
    M, muscriptor, _Modern, Legacy, calls, audio = fake
    monkeypatch.setattr(muscriptor, "TranscriptionModel", Legacy)
    _run(M, audio, tmp_path,
         params={"model_size": "medium", "muscriptor_instruments": "drums"})
    assert calls["transcribe"][0][1] == {}

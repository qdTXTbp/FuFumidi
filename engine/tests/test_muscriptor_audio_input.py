# -*- coding: utf-8 -*-
"""MuScriptor 音频输入路径的回归测试（2026-11-07 根因修复）。

背景（bench3 隔离 A/B，同一段 30s 48k 音频，muscriptor 0.3.0 + small 权重，CPU）：
  原始 48k 交官方内部路径（julius sinc 重采样）   5 乐器组 / 1472 音符
  预解码 16k FLOAT（线性插值）                    3 组 / 1535
  预解码 16k PCM16（6.4.5 引擎现状，librosa）     2 组 / 425（吉他/贝斯整轨消失）
位深与声道已隔离排除，唯一变量是「谁来做重采样」。
官方训练分布输入 = 原始采样率 → float32 → julius sinc。引擎侧任何自作主张的
重采样/下混/位深转换都会把输入推离训练分布 —— 本文件锁死三件事：
  1) 官方能原生读的（PCM WAV / soundfile 可读）→ 原文件**原样透传**（零临时文件）；
  2) 官方读不了的 → ffmpeg 转码且**保留原始采样率与声道数**（不加 -ar/-ac）；
  3) 引擎默认路径把上述结果作为第一个参数交给 model.transcribe，且仍是零 kwargs。
"""
import os
import struct
import sys
import wave

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import audio_io  # noqa: E402


def _write_pcm_wav(path, sr=48000, channels=2, sec=0.3, amp=8000):
    """写一个真实可读的 PCM16 WAV（stdlib wave，无重型依赖）。"""
    n = int(sr * sec)
    frames = bytearray()
    for i in range(n):
        v = int(amp * (0.5 + 0.5 * ((i * 37) % 97) / 97.0))  # 伪音频，够探针用
        for _c in range(channels):
            frames += struct.pack("<h", v)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(bytes(frames))
    return str(path)


# ---------- ① 原样透传 ----------

def test_pcm_wav_passes_through_unchanged(tmp_path):
    """PCM WAV 是官方 wave 读取器的主场 —— 必须原样透传，不产生临时文件。"""
    src = _write_pcm_wav(tmp_path / "in48.wav", sr=48000, channels=2)
    path, is_temp = audio_io.prepare_for_muscriptor(src)
    assert (path, is_temp) == (src, False)


def test_float_wav_passes_through_via_soundfile(tmp_path):
    """IEEE float WAV：stdlib wave 读不了（format 3），但官方会回落 soundfile，
    所以照样原样透传。"""
    import numpy as np
    import soundfile as sf
    src = str(tmp_path / "float48.wav")
    sf.write(src, np.zeros(4800, dtype="float32"), 48000, subtype="FLOAT")
    path, is_temp = audio_io.prepare_for_muscriptor(src)
    assert (path, is_temp) == (src, False)


def test_unreadable_file_falls_back_to_ffmpeg(tmp_path, monkeypatch):
    """官方两个读取器都读不了 → 必须走 ffmpeg 兜底（3.2.6 热修场景）。"""
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"definitely not audio")
    seen = {}

    def fake_ffmpeg(src):
        seen["src"] = src
        return str(tmp_path / "converted.wav")

    monkeypatch.setattr(audio_io, "_ffmpeg_wav_keep_shape", fake_ffmpeg)
    path, is_temp = audio_io.prepare_for_muscriptor(str(bad))
    assert is_temp is True
    assert path == str(tmp_path / "converted.wav")
    assert seen["src"] == str(bad)


def test_missing_file_falls_back_to_ffmpeg_error(tmp_path, monkeypatch):
    """不存在的文件：探针直接判否（不抛 FileNotFoundError），交给 ffmpeg
    给出可读的解码错误。"""
    import pytest

    def fake_ffmpeg(src):
        raise RuntimeError("音频解码失败")

    monkeypatch.setattr(audio_io, "_ffmpeg_wav_keep_shape", fake_ffmpeg)
    with pytest.raises(RuntimeError):
        audio_io.prepare_for_muscriptor(str(tmp_path / "nope.wav"))


# ---------- ② ffmpeg 保形转码 ----------

def test_ffmpeg_keep_shape_never_resamples_or_downmixes(monkeypatch, tmp_path):
    """★★ 核心约束：转码命令绝不允许出现 -ar / -ac —— 采样率与声道数必须
    原样保留，重采样权在官方 julius sinc 手里。"""
    captured = {}

    class _R:
        returncode = 0
        stderr = b""
        stdout = b""

    def fake_run(cmd, capture_output=True, timeout=3600):
        captured["cmd"] = cmd
        with open(cmd[-1], "wb") as fh:
            fh.write(b"RIFF")
        return _R()

    monkeypatch.setattr(audio_io.subprocess, "run", fake_run)
    monkeypatch.setattr(audio_io, "find_ffmpeg", lambda: "ffmpeg")
    out = audio_io._ffmpeg_wav_keep_shape("input.mp3")
    cmd = captured["cmd"]
    assert "-ar" not in cmd, cmd
    assert "-ac" not in cmd, cmd
    assert "-vn" in cmd
    assert "pcm_s16le" in cmd
    assert os.path.isfile(out)


# ---------- ③ 引擎默认路径接线 ----------

class _FakeModel:
    captured = None   # (path, kwargs)

    def __init__(self):
        class _Dev:
            type = "cpu"
        self._device = _Dev()

    @classmethod
    def load_model(cls, arg, device=None, **kw):
        return cls()

    def transcribe(self, path, **kw):
        type(self).captured = (path, dict(kw))
        from muscriptor.events import NoteStartEvent, NoteEndEvent
        yield NoteStartEvent(pitch=60, start_time=0.0, index=0, instrument="piano")
        yield NoteEndEvent(end_time=0.3, start_event=NoteStartEvent(
            pitch=60, start_time=0.0, index=0, instrument="piano"))

    def events_to_midi_bytes(self, events, beat_grid=None):
        import io
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


def _wire(monkeypatch, tmp_path):
    import muscriptor
    import engine_muscriptor as M
    monkeypatch.setattr(muscriptor, "TranscriptionModel", _FakeModel)
    monkeypatch.setattr(M, "_require_package", lambda: None)
    monkeypatch.setattr(M, "_find_local_model", lambda size: str(tmp_path / "m.safetensors"))
    monkeypatch.setattr(M, "_ensure_config", lambda *a, **k: None)
    removed = []
    import audio_io
    monkeypatch.setattr(audio_io, "remove_temp", lambda p: removed.append(p))
    return M, removed


def test_engine_hands_original_file_to_model(monkeypatch, tmp_path):
    """48k 立体声原文件 → 引擎必须把**原始路径**交给官方 transcribe（零 kwargs），
    且绝不把用户原文件当临时文件删掉。"""
    M, removed = _wire(monkeypatch, tmp_path)
    src = _write_pcm_wav(tmp_path / "real48.wav", sr=48000, channels=2)
    logs = []
    out = str(tmp_path / "out.mid")
    M.transcribe_muscriptor(src, out, params={"model_size": "small"}, log_cb=logs.append)
    path, kw = _FakeModel.captured
    assert path == src, "必须把原始文件路径交给官方 transcribe，实际：%r" % (path,)
    assert kw == {}, "默认路径仍须零 kwargs，实际：%r" % (kw,)
    assert src not in removed, "原文件绝不允许被当临时文件删除"
    assert any("原始文件直读" in s for s in logs), logs


def test_engine_cleans_temp_only_for_converted_audio(monkeypatch, tmp_path):
    """ffmpeg 转码产物（is_temp=True）→ 推理完必须清掉临时文件。"""
    M, removed = _wire(monkeypatch, tmp_path)
    bad = tmp_path / "weird.bin"
    bad.write_bytes(b"junk")
    conv = _write_pcm_wav(tmp_path / "conv.wav", sr=44100, channels=1)
    import audio_io
    monkeypatch.setattr(audio_io, "_ffmpeg_wav_keep_shape", lambda src: conv)
    logs = []
    out = str(tmp_path / "out.mid")
    M.transcribe_muscriptor(str(bad), out, params={"model_size": "small"}, log_cb=logs.append)
    path, _kw = _FakeModel.captured
    assert path == conv
    assert conv in removed, "转码临时文件必须被清理"
    assert any("保留原始采样率" in s for s in logs), logs

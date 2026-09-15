# -*- coding: utf-8 -*-
"""audio_io.py 纯逻辑测试。

约束：不 import 任何重型 ML 库。audio_io.py 顶层只 import os/subprocess/tempfile。

写测试前已读 audio_io.py 确认：
  - AUDIO_EXTENSIONS: set[str]，全部小写、带前导点
  - MIDI_EXTENSIONS = {".mid", ".midi", ".kar", ".rmi"}
  - remove_temp(path): 幂等删除，绝不抛错（None 也安全）
  - find_ffmpeg(): 返回路径字符串或 None

不测 ffmpeg_to_wav / decode_to_wav / load_audio_float32：
它们需要 ffmpeg / soundfile / librosa 和真实音频文件，属离线环境的边界之外。
"""

import os
import time

import audio_io


# ---------- AUDIO_EXTENSIONS ----------

def test_audio_extensions_all_dotted_lowercase():
    assert isinstance(audio_io.AUDIO_EXTENSIONS, set)
    assert all(e.startswith(".") for e in audio_io.AUDIO_EXTENSIONS)
    assert all(e == e.lower() for e in audio_io.AUDIO_EXTENSIONS)


def test_audio_extensions_contains_common_formats():
    common = {".wav", ".wave", ".mp3", ".flac", ".ogg", ".oga", ".opus",
              ".m4a", ".aac", ".mp4", ".aiff", ".aif", ".mkv", ".mov", ".avi"}
    assert common <= audio_io.AUDIO_EXTENSIONS


def test_audio_extensions_no_midi_extensions():
    assert audio_io.AUDIO_EXTENSIONS.isdisjoint({".mid", ".midi", ".kar", ".rmi"})


def test_soundfile_fastpath_extensions_are_listed():
    # decode_to_wav 的 soundfile 快速通道格式必须全部收录在 AUDIO_EXTENSIONS，
    # 否则 GUI 展示“支持”但实际走了 ffmpeg 兜底，语义不一致。
    fast_path = {".wav", ".wave", ".flac", ".ogg", ".oga", ".aiff", ".aif", ".opus"}
    assert fast_path <= audio_io.AUDIO_EXTENSIONS


def test_extension_detection_pattern_case_insensitive():
    # 复现源码里的文件类型判定写法：os.path.splitext(src)[1].lower()
    def is_audio(filename):
        return os.path.splitext(filename)[1].lower() in audio_io.AUDIO_EXTENSIONS

    assert is_audio("song.MP3") is True
    assert is_audio("song.mp3") is True
    assert is_audio("video.MKV") is True
    assert is_audio("track.m4a") is True
    assert is_audio("notes.txt") is False
    assert is_audio("song.mid") is False


# ---------- MIDI_EXTENSIONS ----------

def test_midi_extensions_exact():
    assert audio_io.MIDI_EXTENSIONS == {".mid", ".midi", ".kar", ".rmi"}


# ---------- remove_temp ----------

def test_remove_temp_missing_file_ok(tmp_path):
    audio_io.remove_temp(str(tmp_path / "does_not_exist.wav"))  # 不应抛错


def test_remove_temp_deletes_existing_file(tmp_path):
    p = tmp_path / "temp.wav"
    p.write_bytes(b"RIFF")
    assert p.exists()
    audio_io.remove_temp(str(p))
    assert not p.exists()
    # 幂等：二次删除不抛错
    audio_io.remove_temp(str(p))


def test_remove_temp_none_ok():
    audio_io.remove_temp(None)  # 不应抛错


# ---------- find_ffmpeg ----------

def test_find_ffmpeg_returns_path_or_none():
    r = audio_io.find_ffmpeg()
    assert r is None or (isinstance(r, str) and r)


# ---------- sweep_stale_temp ----------
# 回归守卫：引擎进程被强杀时 finally 不执行，解码出的 WAV（单文件上百 MB）与
# demucs 声部目录会一直堆在 %TEMP%。实测曾遗留 12 个文件共 1.34 GB。

def _seed(root, name, age_hours, is_dir=False):
    p = root / name
    if is_dir:
        p.mkdir(parents=True, exist_ok=True)
        (p / "stem.wav").write_bytes(b"RIFF")
    else:
        p.write_bytes(b"RIFF")
    ts = time.time() - age_hours * 3600
    os.utime(p, (ts, ts))
    return p


def test_sweep_removes_stale_files_and_dirs(monkeypatch, tmp_path):
    monkeypatch.setattr(audio_io.tempfile, "gettempdir", lambda: str(tmp_path))
    old_file = _seed(tmp_path, "midi_tool_old.wav", 10)
    old_dir = _seed(tmp_path, "midi_tool_sep_old", 10, is_dir=True)
    fresh = _seed(tmp_path, "midi_tool_fresh.wav", 0)
    foreign = _seed(tmp_path, "other_app.wav", 10)

    n = audio_io.sweep_stale_temp(max_age_hours=6)

    assert n == 2
    assert not old_file.exists()
    assert not old_dir.exists()
    assert fresh.exists(), "刚生成的临时文件可能正被别的进程使用，不能删"
    assert foreign.exists(), "不是本应用前缀的文件不能碰"


def test_sweep_no_leftovers_returns_zero(monkeypatch, tmp_path):
    monkeypatch.setattr(audio_io.tempfile, "gettempdir", lambda: str(tmp_path))
    assert audio_io.sweep_stale_temp() == 0


def test_temp_prefix_is_what_engine_writes():
    # sweep 的匹配前缀必须与 audio_io 实际用的 mkstemp 前缀一致
    assert audio_io.TEMP_PREFIX == "midi_tool_"

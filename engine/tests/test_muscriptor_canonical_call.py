# -*- coding: utf-8 -*-
"""★ 契约测试：MuScriptor 必须按**官方用法**调用（2026-11-07 整体回退后锁死）。

官方 Quickstart（huggingface.co/MuScriptor/muscriptor-medium）：
    model = TranscriptionModel.load_model("medium")
    Path("out.mid").write_bytes(model.transcribe_to_midi("audio.wav"))

`transcribe_to_midi()` 的真实实现就是：
    beat_grid = model.detect_beat_grid_for(audio, "best-effort")
    events    = model.transcribe(audio)              # 零 kwargs = 上游默认
    return model.events_to_midi_bytes(events, beat_grid=beat_grid)

本项目历史上把这行拆开以后，陆续往中间塞了音频预处理、乐器组探测、生成参数、
证据式收尾、跨块缝合、token 回放……每一层都改变模型听到的东西或写出的 MIDI，
用户侧表现是「效果一直不稳」。本测试锁三条：
  1) `transcribe()` **不许带任何 kwargs**（prelude_forcing/batch_size/temperature… 全默认）
  2) 必须用官方节拍网格（`detect_beat_grid_for(..., "best-effort")`）并把网格交给写出函数
  3) 音频输入必须原样交给官方（不做重采样/预处理）
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture()
def fake(monkeypatch, tmp_path):
    """假 muscriptor：记录每一次调用的形态。"""
    muscriptor = pytest.importorskip("muscriptor")
    import engine_muscriptor as M

    calls = {"load": [], "grid": [], "transcribe": [], "midi": []}
    grid_token = object()

    class FakeModel:
        _device = type("D", (), {"type": "cpu"})()

        @classmethod
        def load_model(cls, arg, **kw):
            calls["load"].append((arg, kw))
            return cls()

        def detect_beat_grid_for(self, audio, mode="best-effort"):
            calls["grid"].append((audio, mode))
            return grid_token

        def transcribe(self, audio, **kw):
            calls["transcribe"].append((audio, kw))
            return iter(())

        def events_to_midi_bytes(self, events, beat_grid=None):
            calls["midi"].append((beat_grid, list(events)))
            return b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x00\x60"

    monkeypatch.setattr(muscriptor, "TranscriptionModel", FakeModel)
    monkeypatch.setattr(M, "_require_package", lambda: None)
    # 网格权重「已安装」→ 走官方 detect_beat_grid_for（真实机器上未安装时会直接跳过）
    monkeypatch.setattr(M, "_grid_checkpoint_available", lambda: True)
    monkeypatch.setattr(M, "_find_local_model", lambda size: str(tmp_path / "model.safetensors"))
    monkeypatch.setattr(M, "_ensure_config", lambda *a, **k: None)
    monkeypatch.setattr(M, "_count_notes", lambda p: 0)
    monkeypatch.setattr(M, "_midi_note_count_bytes", lambda data: 1)

    import audio_io
    monkeypatch.setattr(audio_io, "prepare_for_muscriptor",
                        lambda p: (str(p), False))     # 原样透传，不转码

    audio = tmp_path / "in.flac"
    audio.write_bytes(b"fLaC")
    return M, calls, grid_token, str(audio)


def test_transcribe_called_with_zero_kwargs(fake, tmp_path):
    """`transcribe()` 只能收音频路径 —— 任何 kwargs 都是「我们替模型做了决定」。"""
    M, calls, grid_token, audio = fake
    M.transcribe_muscriptor(audio, str(tmp_path / "out.mid"), params={"model_size": "medium"})
    assert len(calls["transcribe"]) == 1
    passed_audio, kwargs = calls["transcribe"][0]
    assert passed_audio == audio
    assert kwargs == {}, "不许传任何生成参数：%r" % (kwargs,)


def test_official_beat_grid_is_used(fake, tmp_path):
    """必须走官方节拍网格，且网格对象原样交给写出函数（否则音符起点不贴网格）。"""
    M, calls, grid_token, audio = fake
    M.transcribe_muscriptor(audio, str(tmp_path / "out.mid"), params={"model_size": "medium"})
    assert calls["grid"] == [(audio, "best-effort")]
    assert calls["midi"][0][0] is grid_token
    assert M.LAST_BEAT_GRID["used"] is True


def test_grid_is_skipped_without_local_weights(fake, tmp_path, monkeypatch):
    """没装 Beat This! 权重时**必须不碰网络**：上游会去 JKU 云盘下载，国内卡到超时
    （实测 60 秒素材 4 分钟还没出结果）。跳过要留一行日志，告诉用户怎么启用。"""
    M, calls, _grid, audio = fake
    monkeypatch.setattr(M, "_grid_checkpoint_available", lambda: False)
    logs = []
    M.transcribe_muscriptor(audio, str(tmp_path / "out.mid"),
                            params={"model_size": "medium"}, log_cb=logs.append)
    assert calls["grid"] == [], "权重没装就不许调用（会在网络上下载）"
    assert calls["midi"][0][0] is None
    assert M.LAST_BEAT_GRID["used"] is False
    assert any("节拍网格" in s for s in logs), logs


def test_grid_failure_degrades_instead_of_crashing(fake, tmp_path, monkeypatch):
    """Beat This! 权重没装时上游抛的是 ValueError（不是它自己的 BeatDetectionError），
    引擎必须退回占位速度继续转录，并把「没拿到网格」报给上层（engine.py 据此兜底测速）。"""
    M, calls, _grid, audio = fake

    class Broken:
        @classmethod
        def load_model(cls, arg, **kw):
            return cls()

        def detect_beat_grid_for(self, a, mode="best-effort"):
            raise ValueError("Could not load the checkpoint given the provided name", "final0")

        def transcribe(self, a, **kw):
            return iter(())

        def events_to_midi_bytes(self, events, beat_grid=None):
            assert beat_grid is None
            return b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x00\x60"

    import muscriptor
    monkeypatch.setattr(muscriptor, "TranscriptionModel", Broken)
    logs = []
    M.transcribe_muscriptor(audio, str(tmp_path / "out.mid"),
                            params={"model_size": "medium"}, log_cb=logs.append)
    assert M.LAST_BEAT_GRID["used"] is False
    assert any("节拍网格" in s for s in logs), logs
    assert os.path.exists(str(tmp_path / "out.mid"))


def test_audio_is_handed_over_untouched(fake, tmp_path, monkeypatch):
    """音频不能被我们重采样：官方 load_audio 内部统一转 16k，自己转会绕开它的 sinc 重采样。"""
    M, calls, _grid, audio = fake
    seen = []
    import audio_io
    monkeypatch.setattr(audio_io, "prepare_for_muscriptor",
                        lambda p: (seen.append(p) or (str(p), False)))
    M.transcribe_muscriptor(audio, str(tmp_path / "out.mid"), params={"model_size": "medium"})
    assert seen == [audio]
    assert calls["transcribe"][0][0] == audio

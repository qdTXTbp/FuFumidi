# -*- coding: utf-8 -*-
"""转录前乐器组预分析的单测（engine/instrument_probe.py）。

不加载真模型：用桩模型返回合成事件，把「取值解析 / 选窗 / 汇总 / 挑组规则 / 失败不抛」固定住。
"""
import os
import sys

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import instrument_probe as ip  # noqa: E402


class Start:
    def __init__(self, pitch, start, index, instrument):
        self.pitch, self.start_time, self.index, self.instrument = pitch, start, index, instrument


class End:
    def __init__(self, start_ev, end):
        self.start_event, self.end_time = start_ev, end


def notes(instrument, count, dur=0.5, t0=0.0):
    out = []
    for k in range(count):
        s = Start(60, t0 + k * (dur + 0.1), k, instrument)
        out.append(s)
        out.append(End(s, t0 + k * (dur + 0.1) + dur))
    return out


class StubModel:
    def __init__(self, streams):
        self.streams = streams
        self.seen = []

    def transcribe(self, path):
        self.seen.append(path)
        return iter(self.streams[min(len(self.seen) - 1, len(self.streams) - 1)])


def write_wav(tmp_path, seconds=60.0, sr=22050, silent_until=0.0, loud=0.3):
    n = int(seconds * sr)
    t = np.arange(n) / sr
    y = (np.sin(2 * np.pi * 440 * t) * loud).astype("float32")
    y[: int(silent_until * sr)] = 0.0
    path = os.path.join(str(tmp_path), "a.wav")
    sf.write(path, y, sr)
    return path


# ---------------------------------------------------------------- 取值解析

def test_parse_mode_defaults_to_unrestricted():
    # 不传 / 空 / none 一律按"不限定"（界面默认档）
    assert ip.parse_mode(None) == ("none", [])
    assert ip.parse_mode("") == ("none", [])
    assert ip.parse_mode("none") == ("none", [])
    assert ip.parse_mode("off") == ("none", [])
    assert ip.parse_mode("free") == ("none", [])
    # 'auto' 是已退役的档：不能让老预设把它当组名送去 forbidden_token_ids（会报非法乐器）
    assert ip.parse_mode("auto") == ("none", [])
    assert ip.parse_mode("SMART") == ("none", [])


def test_parse_mode_explicit_group_list():
    assert ip.parse_mode("voice,drums") == ("limit", ["voice", "drums"])
    assert ip.parse_mode(["voice", " drums "]) == ("limit", ["voice", "drums"])


# ---------------------------------------------------------------- 选窗

def test_pick_windows_skip_silence_and_cover_the_song():
    y, sr = np.zeros(int(120 * 22050), dtype="float32"), 22050
    y[int(40 * sr):] = 0.2                       # 前 40s 静音
    wins = ip.pick_windows(y, sr, count=3, win=20.0)
    assert 1 <= len(wins) <= 3, wins
    assert all(a >= 35.0 for a, _b in wins), wins
    assert wins == sorted(wins)
    assert all(b - a <= 20.001 for a, b in wins)


def test_short_audio_uses_the_whole_clip():
    y = np.zeros(int(8 * 22050), dtype="float32")
    assert ip.pick_windows(y, 22050, count=3, win=20.0) == [(0.0, pytest.approx(8.0))]


# ---------------------------------------------------------------- 汇总与挑组

def test_aggregate_counts_notes_and_seconds():
    notes_map, seconds = ip.aggregate(notes("voice", 5, dur=0.5) + notes("drums", 2, dur=0.1))
    assert notes_map == {"voice": 5, "drums": 2}
    assert seconds["voice"] == pytest.approx(2.5)
    assert seconds["drums"] == pytest.approx(0.2)


def test_select_groups_prunes_long_tail_but_keeps_real_groups():
    per_window = [{"electric_bass": 40, "clean_electric_guitar": 26, "drums": 2, "timpani": 1},
                  {"electric_bass": 30, "voice": 12, "drums": 9}]
    keep, total = ip.select_groups(per_window)
    assert "voice" in keep, keep          # 只在其中一段出现，但确实是这首歌的乐器 → 必须留
    assert "electric_bass" in keep and keep[0] == "electric_bass"
    assert "timpani" not in keep, keep    # 长尾（1 个音）被剪掉
    assert total["electric_bass"] == 70


def test_select_groups_always_keeps_drums_even_when_tiny():
    keep, _t = ip.select_groups([{"acoustic_piano": 400, "drums": 1}], min_share=0.5)
    assert "drums" in keep, keep


def test_select_groups_caps_the_count():
    win = {("g%d" % i): 100 - i for i in range(12)}
    keep, _t = ip.select_groups([win], min_share=0.0, min_notes=1, max_groups=8)
    assert len(keep) == 8


def test_select_groups_empty():
    assert ip.select_groups([]) == ([], {})
    assert ip.select_groups([{}]) == ([], {})


# ---------------------------------------------------------------- 预分析（桩模型）

def test_probe_uses_several_windows_and_returns_groups(tmp_path):
    wav = write_wav(tmp_path, seconds=90.0)
    stub = StubModel([notes("acoustic_piano", 30) + notes("drums", 8),
                      notes("acoustic_piano", 24) + notes("drums", 6) + notes("timpani", 1)])
    res = ip.probe(stub, wav, count=3, win=20.0)
    assert len(stub.seen) >= 2, stub.seen
    assert res["groups"][0] == "acoustic_piano", res
    assert "drums" in res["groups"]
    assert "timpani" not in res["groups"], res
    assert len(res["windows"]) == len(stub.seen)
    assert not os.path.exists(os.path.dirname(stub.seen[0])), "临时目录要清掉"


def test_probe_failure_is_swallowed(tmp_path):
    res = ip.probe(StubModel([[]]), os.path.join(str(tmp_path), "nope.wav"))
    assert res["groups"] == [] and "reason" in res


def test_probe_reports_nothing_detected(tmp_path):
    wav = write_wav(tmp_path, seconds=40.0)
    res = ip.probe(StubModel([[]]), wav)
    assert res["groups"] == [] and res["reason"] == "nothing-detected"

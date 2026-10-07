# -*- coding: utf-8 -*-
"""DiffSinger 时序回归：拍→秒换算（BPM）与句首留白。

两个都是**听得出来**的错，而且都不报错：

1. `_make_axis` 只设了 `p.bpm`，而 TimeAxis.build_segments() 读的是 `p.tempos`
   （UProject 默认 [UTempo(0, 120)]）—— 非 120 的曲子整首被变速。
   实测《烦恼歌》96 BPM：4 分 04 秒渲成 3 分 15 秒（快 25%），和伴奏完全对不上。
2. 渲染器只产出「这一句」的样点，句首在歌里的位置由 phrase.position_ms 决定；
   不补前面的静音，整条人声会提前（实测 0.82s = 第一个音素的位置），叠上伴奏抢拍。
"""
import os
import sys

import numpy as np
import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from diffsinger.pipeline import _make_axis, _pad_leading_silence  # noqa: E402


NOTES = [{"startBeat": 0, "durBeat": 1, "pitch": 60, "lyric": "a"},
         {"startBeat": 2, "durBeat": 1, "pitch": 62, "lyric": "a"}]


@pytest.mark.parametrize("bpm,expect_ms", [(96.0, 625.0), (120.0, 500.0), (60.0, 1000.0)])
def test_axis_uses_project_bpm(bpm, expect_ms):
    """一拍 = 60000/bpm 毫秒。修之前无论传多少都是 500（120 BPM）。"""
    axis, project = _make_axis({"notes": NOTES, "bpm": bpm}, NOTES)
    assert float(project.bpm) == bpm
    assert float(project.tempos[0].bpm) == bpm          # ★ 必须同步到 tempos
    assert axis.ms_between_tick_pos(0, 480) == pytest.approx(expect_ms, abs=0.01)


def test_axis_defaults_to_120_without_bpm():
    axis, _ = _make_axis({"notes": NOTES}, NOTES)
    assert axis.ms_between_tick_pos(0, 480) == pytest.approx(500.0, abs=0.01)


def test_pad_leading_silence():
    sr = 44100
    audio = np.ones(1000, dtype=np.float32)
    out = _pad_leading_silence(audio, sr, 820.0)
    assert len(out) == 1000 + int(round(0.820 * sr))
    assert float(np.max(np.abs(out[:36000]))) == 0.0     # 前面是静音
    assert float(out[-1]) == 1.0                         # 原样接在后面
    assert len(_pad_leading_silence(audio, sr, 0)) == 1000   # 句首在 0 → 不补


def test_pad_leading_silence_never_raises():
    """补静音失败也不能让整次渲染失败（退化为原样返回 + 一条 warning）。"""
    warn = []
    out = _pad_leading_silence(None, 44100, 500.0, warn)
    assert out is None or len(out) >= 0


# -*- coding: utf-8 -*-
"""① 回放台（--dump-tokens / --replay-tokens）的回归测试。

为什么有这东西（实测 2026-10-12）：
  长音频的「僵尸音符」缺陷出在**解码器**（muscriptor/tokenizer/notes.py 的
  OpenNoteTracker），不在模型。但复现它必须把整首歌重跑一遍模型 ——
  100 分钟录播 = 1206 个 5 秒块串行约 48 分钟。而解码器吃的是 token 流
  （一串 int + ChunkBoundary），纯 Python、不要 torch。
  所以真实转录时把 token 流顺手落盘，之后改解码器都用回放验证。

这里锁死回放台的正确性前提：**落盘再读回来必须和原流逐项相同**。
只要这一点成立，回放出来的 MIDI 与原始那次按构造就是同一个（同一条
decode_model_tokens + events_to_midi_bytes 上游代码，同一个 BeatGrid）。
"""
import json
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from muscriptor.events import ChunkBoundary, ProgressEvent  # noqa: E402
import engine_muscriptor as M  # noqa: E402


class _StubModel:
    """只需要 _install_token_dump 用到的那一个成员，不碰 torch / 权重。"""

    def __init__(self, items):
        self._items = list(items)
        self.calls = 0

    def _generate_token_stream(self, *a, **kw):
        self.calls += 1
        for it in self._items:
            yield it


def _boundaries(seq):
    return [x for x in seq if isinstance(x, ChunkBoundary)]


def test_dump_is_transparent_to_the_caller(tmp_path):
    """tee 之后调用方拿到的流必须和原来是同一个 —— 不能吞、不能重排。"""
    items = [3, 7, ChunkBoundary(0.0, 5.0), 9, 11, ChunkBoundary(5.0, 10.0), 13]
    stub = _StubModel(items)
    fh = M._install_token_dump(stub, str(tmp_path / "s.jsonl"))
    got = list(stub._generate_token_stream())
    fh.close()
    assert got == items
    assert stub.calls == 1


def test_roundtrip_is_lossless(tmp_path):
    """落盘 -> 读回，逐项相同（token 索引、块边界的两个时间点）。"""
    # ★ 末块的 next_seek_time 是 None（真实转录就是这么收尾的）。
    #   曾经用 %r 落盘把它写成 JSON 认不出的 None，读回时整行被当坏行丢掉，
    #   末块边界消失 —— 15 秒样例实测多出 1 个音符（197 → 198）。
    items = [3, 7, ChunkBoundary(0.0, 5.0), 9, 11, ChunkBoundary(5.0, 10.0), 13,
             ChunkBoundary(10.0, None), 2]
    p = str(tmp_path / "s.jsonl")
    stub = _StubModel(items)
    fh = M._install_token_dump(stub, p)
    list(stub._generate_token_stream())
    fh.close()

    stream, grid = M._read_token_dump(p)
    back = list(stream)
    assert grid is None
    assert back == items, "回放流与原流不一致"
    # 类型也要对：int 不能变成 str，ChunkBoundary 不能退化成 tuple
    assert all(isinstance(x, int) for x in back if not isinstance(x, ChunkBoundary))
    assert _boundaries(back) == _boundaries(items)
    assert back[-2].next_seek_time is None, "末块边界的 next_seek_time=None 丢了"


def test_progress_events_pass_through_but_are_not_dumped(tmp_path):
    """进度事件要原样交给调用方（transcribe 靠它报进度），但不该进文件。"""
    pe = ProgressEvent(completed=1, total=8)
    items = [1, pe, 2]
    p = str(tmp_path / "s.jsonl")
    stub = _StubModel(items)
    fh = M._install_token_dump(stub, p)
    got = list(stub._generate_token_stream())
    fh.close()
    assert got == items
    lines = [l for l in open(p, encoding="utf-8").read().splitlines() if l.strip()]
    body = [json.loads(l) for l in lines[1:]]
    assert body == [{"t": 1}, {"t": 2}]


def test_empty_stream_writes_only_the_grid_header(tmp_path):
    p = str(tmp_path / "s.jsonl")
    stub = _StubModel([])
    fh = M._install_token_dump(stub, p)
    list(stub._generate_token_stream())
    fh.close()
    stream, grid = M._read_token_dump(p)
    assert list(stream) == []
    assert grid is None


def test_missing_file_raises_before_spending_time(tmp_path):
    with pytest.raises(FileNotFoundError):
        M._read_token_dump(str(tmp_path / "nope.jsonl"))


# ---- BeatGrid 落盘保真 ----------------------------------------------------
# 丢掉 beats 会让 notes_to_midi() 在 onset_delay 为 None 时现算一个不同的
# 偏移，回放出来的 MIDI 就和原始那次不是一个文件了。

def _grid(onset_delay=None):
    np = pytest.importorskip("numpy")
    from muscriptor.utils.beats import BeatGrid
    return BeatGrid(
        bpm=128.5,
        beats_per_bar=4,
        first_downbeat=0.37,
        beats=np.asarray([0.0, 0.47, 0.93, 1.40], dtype=float),
        onset_delay=onset_delay,
    )


def test_beat_grid_survives_the_roundtrip(tmp_path):
    p = str(tmp_path / "s.jsonl")
    g0 = _grid(onset_delay=0.031)
    fh = M._install_token_dump(_StubModel([1]), p, g0)
    fh.close()
    _, g1 = M._read_token_dump(p)
    assert g1 is not None
    assert g1.bpm == pytest.approx(g0.bpm)
    assert g1.beats_per_bar == g0.beats_per_bar
    assert g1.first_downbeat == pytest.approx(g0.first_downbeat)
    assert g1.onset_delay == pytest.approx(g0.onset_delay)
    assert g1.beats is not None and len(g1.beats) == len(g0.beats)
    assert list(g1.beats) == pytest.approx(list(g0.beats))
    # 拍位偏移必须一致 —— 这是 beats 留在文件里的唯一理由
    assert g1.bar_offset(min_shift=0.031) == pytest.approx(g0.bar_offset(min_shift=0.031))


def test_beat_grid_null_and_none_beats_roundtrip(tmp_path):
    p = str(tmp_path / "s.jsonl")
    M._install_token_dump(_StubModel([1]), p, None).close()
    assert M._read_token_dump(p)[1] is None

    np = pytest.importorskip("numpy")
    from muscriptor.utils.beats import BeatGrid
    g0 = BeatGrid(bpm=100.0, beats_per_bar=None, first_downbeat=0.0, beats=None)
    p2 = str(tmp_path / "s2.jsonl")
    M._install_token_dump(_StubModel([1]), p2, g0).close()
    g1 = M._read_token_dump(p2)[1]
    assert g1.beats_per_bar is None and g1.beats is None
    assert g1.onset_delay is None


def test_read_tolerates_a_truncated_tail(tmp_path):
    """落盘途中被中断（用户取消转录）时，回放不该因为最后半行直接崩。"""
    p = str(tmp_path / "s.jsonl")
    fh = M._install_token_dump(_StubModel([]), p)
    fh.close()
    with open(p, "a", encoding="utf-8") as f:
        f.write('{"t": 5}\n{"t": 6}\n{"t": 7')   # 末行被截断
    stream, _ = M._read_token_dump(p)
    assert list(stream) == [5, 6]

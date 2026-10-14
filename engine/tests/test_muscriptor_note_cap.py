# -*- coding: utf-8 -*-
"""长音频转录「僵尸音符」上限的回归测试。

背景（实测 2026-10-12，100 分钟交响录播 / 6032 秒 / 1206 个 5 秒块）：
  muscriptor 跨块延音靠「tie 段」维持，块边界只关闭**不在 tie 段里**的音符；
  而 prelude_forcing 打开时 tie 段是从「当前还开着的音符」强制构造的 ——
  于是块边界几乎永远关不掉任何音符，一个音只能靠模型在块内显式吐 note-off 才结束。
  模型从某个内容节点起开始漏收尾，之后每个音高都被拉成几分钟的长音：
  星铁 LIVE 最长 4320.8 秒（全曲 72%）、原神交响 2023 最长 2691.7 秒，>30 秒的音符占 9~12%。

修复：在事件流上兜底，任何音持续超过 max_note_hold 就补一个收尾事件。
★ 2026-10-14 起该上限**默认关闭**（僵尸音符改由音频证据式收尾），这里只在显式传 cap 时生效。
离线模拟：cap=15s 对两个坏文件把最长音压到 15s，对 4 个正常文件（最长 12.3s）零改动。

这里锁死四件事：
  1) 永不收尾的音确实会在 start+cap 被关掉；
  2) ★ 补收尾之后，库随后为同一 index 发的真实 NoteEndEvent 必须被吞掉 ——
     events_to_midi_bytes 里是 open_notes.pop(ev.start_event_index)，重复收尾会 KeyError；
  3) 正常短音**逐个原样透传**（不新增、不重排、不改时间），否则正常文件会被误伤；
  4) cap=0 时行为与旧版完全一致（可关）。
"""
import io
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from muscriptor.events import NoteStartEvent, NoteEndEvent, ProgressEvent  # noqa: E402
import engine_muscriptor as M  # noqa: E402


CAP = 15.0


class _Dev:
    type = "cpu"


class _FakeModel:
    """替身模型：transcribe 吐给定事件流；events_to_midi_bytes 复刻库的 pop 语义。"""

    stream = []
    captured = None

    def __init__(self):
        self._device = _Dev()

    @classmethod
    def load_model(cls, arg, device=None, **kw):
        return cls()

    def transcribe(self, path, **kw):
        return iter(list(type(self).stream))

    def events_to_midi_bytes(self, events, beat_grid=None):
        got = []
        open_notes = {}
        pairs = []
        for ev in events:
            got.append(ev)
            if isinstance(ev, ProgressEvent):
                continue
            if isinstance(ev, NoteStartEvent):
                open_notes[ev.index] = ev
            else:
                # ★ 与库内实现逐字同构：重复收尾在这里抛 KeyError
                st = open_notes.pop(ev.start_event_index)
                pairs.append((st, ev))
        type(self).captured = got
        import pretty_midi
        pm = pretty_midi.PrettyMIDI()
        inst = pretty_midi.Instrument(program=0)
        for st, en in pairs:
            inst.notes.append(pretty_midi.Note(velocity=100, pitch=st.pitch,
                                               start=st.start_time, end=en.end_time))
        pm.instruments.append(inst)
        buf = io.BytesIO()
        pm.write(buf)
        return buf.getvalue()


@pytest.fixture
def run_transcribe(monkeypatch, tmp_path):
    def _run(stream, **params):
        import muscriptor
        import audio_io
        _FakeModel.stream = stream
        _FakeModel.captured = None
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
        p = {"model_size": "medium"}
        p.update(params)
        M.transcribe_muscriptor(str(wav), out, params=p, log_cb=logs.append)
        return logs, out, _FakeModel.captured
    return _run


def _start(i, t, pitch=60):
    return NoteStartEvent(pitch=pitch, start_time=t, index=i, instrument="piano")


def _end(i, t, pitch=60):
    return NoteEndEvent(end_time=t, start_event=_start(i, 0.0, pitch))


def test_never_closed_note_is_capped(run_transcribe):
    """模型从头到尾没给这个音收尾 —— 必须在上限处被强制关掉。"""
    stream = [
        _start(0, 0.0, 60),
        ProgressEvent(completed=1, total=10),
        _start(1, 100.0, 62),
        _end(1, 100.5, 62),
    ]
    logs, out, got = run_transcribe(stream, max_note_hold=CAP)
    ends = [e for e in got if isinstance(e, NoteEndEvent)]
    dur = ends[0].end_time - ends[0].start_event.start_time
    assert abs(dur - CAP) < 1e-6, dur
    assert any("强制收尾 1 个" in s for s in logs), logs


def test_duplicate_close_is_swallowed(run_transcribe):
    """★ 核心防崩：补了收尾之后，库随后发的真实收尾必须被吞掉，否则下游 pop 会 KeyError。"""
    stream = [
        _start(0, 0.0, 60),
        _start(1, 100.0, 62),
        _end(0, 500.0, 60),   # ← 库自己的真实收尾，晚于我们补的那次
        _end(1, 100.5, 62),
    ]
    logs, out, got = run_transcribe(stream, max_note_hold=CAP)
    ends0 = [e for e in got if isinstance(e, NoteEndEvent) and e.start_event_index == 0]
    assert len(ends0) == 1, "index 0 必须只有一个收尾事件，实际 %d 个" % len(ends0)
    assert abs(ends0[0].end_time - CAP) < 1e-6


def test_short_notes_pass_through_unchanged(run_transcribe):
    """正常短音必须逐个原样透传 —— 这是「不误伤正常文件」的保证。"""
    stream = []
    for i in range(5):
        stream.append(_start(i, i * 0.5, 60 + i))
        stream.append(_end(i, i * 0.5 + 0.3, 60 + i))
    logs, out, got = run_transcribe(stream, max_note_hold=CAP)
    assert got == stream, "事件流被改动了：%r" % (got,)
    cap_lines = [s for s in logs if "强制收尾" in s]
    assert cap_lines, logs                       # 上限要报出来（0 也说 0，便于确认它在工作）
    assert "强制收尾 0 个" in cap_lines[0], cap_lines[0]


def test_cap_zero_disables(run_transcribe):
    """cap=0 = 关闭：长音保持原样，行为与旧版一致。"""
    stream = [_start(0, 0.0, 60), _start(1, 900.0, 62), _end(1, 900.5, 62), _end(0, 1000.0, 60)]
    logs, out, got = run_transcribe(stream, max_note_hold=0)
    assert got == stream
    assert not any("强制收尾" in s for s in logs), logs


def test_progress_events_preserved(run_transcribe):
    """进度透传不能被上限逻辑吃掉（前端靠它显示真实进度）。"""
    stream = [ProgressEvent(completed=0, total=7), _start(0, 0.0, 60), _end(0, 0.2, 60),
              ProgressEvent(completed=7, total=7)]
    logs, out, got = run_transcribe(stream, max_note_hold=CAP)
    assert sum(1 for s in logs if s.startswith("###PROG")) == 2, logs
    assert got == stream


def test_selfcheck_log_reports_duration_distribution(run_transcribe):
    """自检日志必须给出中位数与 >2s 占比 —— 只看「最长」会漏判（实测被骗过一次）。"""
    stream = [_start(0, 0.0, 60), _end(0, 0.3, 60),
              _start(1, 1.0, 62), _end(1, 1.4, 62)]
    logs, out, got = run_transcribe(stream, max_note_hold=CAP)
    line = [s for s in logs if s.startswith("[自检]")]
    assert line, logs
    assert "时长中位数" in line[0] and ">2s 占" in line[0], line[0]
# -*- coding: utf-8 -*-
"""转录「暂停 / 继续」闸门（用户 2026-10-14 要求：正在转录的那一首也要能暂停，继续后接着跑）。

实现已统一到 `pause_gate` 模块：MuScriptor 把**官方惰性事件流**包进 gate_stream，
每吐出一项（5 秒块）之前，若暂停标记文件存在就原地等，直到文件被删掉。
★ 2026-11-07：引擎本地的 `_pause_gate` / 模型包装器已随整体回退删除 —— 现在只有
一份实现（pause_gate），模型侧不做任何 monkeypatch（调用形态保持官方）。
这里钉住四件事：
  1. 没有标记文件 → 原样透传（不影响正常转录）；
  2. 标记文件存在 → **卡住不产出**（而不是继续跑），删掉后从原处接着往下走；
  3. 暂停/继续各只打一行日志（别每 0.2 秒刷屏）；
  4. 每次 install 重绑日志回调（第二首的日志不许打到第一首上）。
"""
import os
import sys
import threading
import time

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)


def _drain(gate_gen, out, done):
    for x in gate_gen:
        out.append(x)
    done.set()


# ---------- 共享闸门（pause_gate 模块）：三类引擎共用一份实现 ----------

import pause_gate as PG  # noqa: E402


def test_install_rebinds_log_callback_each_time(tmp_path, monkeypatch):
    """★ 包装器只装一次，日志必须每次转录重绑（否则第二首的日志打到第一首的回调上）。"""
    flag = tmp_path / 'pause.flag'
    monkeypatch.setenv('FUFUMIDI_PAUSE_FILE', str(flag))
    first, second = [], []
    PG.install(first.append)
    gate = PG.install(second.append)
    assert gate is PG.current()
    flag.write_text('1', encoding='utf-8')
    done = threading.Event()
    t = threading.Thread(target=lambda: (gate.wait(), done.set()), daemon=True)
    t.start()
    time.sleep(0.6)
    assert first == [], '旧回调不许再收到日志：%r' % (first,)
    assert any(s.startswith('[暂停]') for s in second), second
    flag.unlink()
    assert done.wait(5.0)
    assert first == []
    assert sum(1 for s in second if s.startswith('[继续]')) == 1, second


def test_gate_stream_uses_current_gate(tmp_path, monkeypatch):
    flag = tmp_path / 'pause.flag'
    flag.write_text('1', encoding='utf-8')
    monkeypatch.setenv('FUFUMIDI_PAUSE_FILE', str(flag))
    logs = []
    PG.install(logs.append)
    produced = []
    done = threading.Event()
    t = threading.Thread(target=_drain, args=(PG.gate_stream(iter([1, 2])), produced, done), daemon=True)
    t.start()
    time.sleep(0.6)
    assert produced == [], '暂停期间不许产出：%r' % (produced,)
    flag.unlink()
    assert done.wait(5.0)
    assert produced == [1, 2]
    assert any(s.startswith('[暂停]') for s in logs), logs
    assert any(s.startswith('[继续]') for s in logs), logs


def test_install_without_env_is_inactive_and_says_so(monkeypatch):
    """没配 FUFUMIDI_PAUSE_FILE 时闸门不激活，并且**明确说一句**（否则就是哑故障）。"""
    monkeypatch.delenv('FUFUMIDI_PAUSE_FILE', raising=False)
    said = []
    gate = PG.install(said.append)
    assert gate.active is False
    assert any('未启用中途暂停' in s for s in said), said


def test_emit_survives_stdout_redirect(monkeypatch):
    """★ 引擎会临时把 sys.stdout 换成 StringIO 静音上游打印；闸门的日志必须还能出去。

    实测踩过：钢琴链路 `with _redirect_stdout(): engine.transcribe(...)` 把闸门的
    「引擎已停住」吞了 —— 引擎真的停住了（停了 100 秒），但界面上看不到任何回执。
    """
    import contextlib
    import io

    class _Cap(io.StringIO):
        pass

    cap = _Cap()
    monkeypatch.setattr(sys, 'stdout', cap)
    gate = PG.install(lambda s: print('LOG ' + s))
    with contextlib.redirect_stdout(io.StringIO()):
        gate.emit('引擎已停住')
        gate.emit('引擎继续推理')
    text = cap.getvalue()
    assert 'LOG 引擎已停住' in text, text
    assert 'LOG 引擎继续推理' in text, text


def test_log_line_uses_current_gate(tmp_path, monkeypatch):
    """包装器只装一次，诊断日志走 log_line —— 打到**本次**转录的回调上。"""
    flag = tmp_path / 'pause.flag'
    monkeypatch.setenv('FUFUMIDI_PAUSE_FILE', str(flag))
    logs = []
    PG.install(logs.append)
    PG.log_line('[钢琴] 分批前向：共 35 段')
    assert logs == ['[钢琴] 分批前向：共 35 段'], logs


def test_gate_stream_passthrough_without_pause_file(monkeypatch):
    monkeypatch.delenv('FUFUMIDI_PAUSE_FILE', raising=False)
    PG.install(lambda s: None)
    assert list(PG.gate_stream(iter([1, 2, 3]))) == [1, 2, 3]


def test_muscriptor_streams_through_gate(tmp_path, monkeypatch):
    """★ 引擎必须把官方 transcribe() 的惰性事件流交给 gate_stream ——
    这是「暂停在块与块之间生效」的唯一实现方式（不改事件、只延迟）。"""
    import engine_muscriptor as EM

    flag = tmp_path / 'pause.flag'
    monkeypatch.setenv('FUFUMIDI_PAUSE_FILE', str(flag))
    seen = []
    real = PG.gate_stream

    def _spy(stream, gate=None):
        seen.append(stream)
        return real(stream, gate)

    monkeypatch.setattr(PG, 'gate_stream', _spy)
    # 用假模型跑一遍最小转录（不碰模型权重）
    import muscriptor
    calls = {}

    class _Fake:
        _device = type('D', (), {'type': 'cpu'})()

        @classmethod
        def load_model(cls, arg, **kw):
            return cls()

        def detect_beat_grid_for(self, audio, mode='best-effort'):
            return None

        def transcribe(self, audio, **kw):
            calls['kw'] = kw
            return iter([object(), object()])

        def events_to_midi_bytes(self, events, beat_grid=None):
            calls['events'] = list(events)
            return b'MThd\x00\x00\x00\x06\x00\x01\x00\x01\x00\x60'

    monkeypatch.setattr(muscriptor, 'TranscriptionModel', _Fake)
    monkeypatch.setattr(EM, '_require_package', lambda: None)
    monkeypatch.setattr(EM, '_find_local_model', lambda size: str(tmp_path / 'm.safetensors'))
    monkeypatch.setattr(EM, '_ensure_config', lambda *a, **k: None)
    monkeypatch.setattr(EM, '_count_notes', lambda p: 0)
    monkeypatch.setattr(EM, '_midi_note_count_bytes', lambda d: 1)
    import audio_io
    monkeypatch.setattr(audio_io, 'prepare_for_muscriptor', lambda p: (str(p), False))
    audio = tmp_path / 'in.wav'
    audio.write_bytes(b'RIFF')

    EM.transcribe_muscriptor(str(audio), str(tmp_path / 'out.mid'))
    assert len(seen) == 1, '事件流必须经过 gate_stream'
    assert len(calls['events']) == 2, '过闸门后事件不许被吞'
    assert calls['kw'] == {}, '过闸门不许改变调用形态'

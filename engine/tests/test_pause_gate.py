# -*- coding: utf-8 -*-
"""转录「暂停 / 继续」闸门（用户 2026-10-14 要求：正在转录的那一首也要能暂停，继续后接着跑）。

引擎侧实现见 engine_muscriptor._pause_gate：每吐出一项（5 秒块）之前，若暂停标记文件存在就
原地等，直到文件被删掉。这里钉住三件事：
  1. 没有标记文件 → 原样透传（不影响正常转录）；
  2. 标记文件存在 → **卡住不产出**（而不是继续跑），删掉后从原处接着往下走；
  3. 暂停/继续各只打一行日志（别每 0.2 秒刷屏）。
"""
import os
import sys
import threading
import time

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import engine_muscriptor as EM  # noqa: E402


def _drain(gate_gen, out, done):
    for x in gate_gen:
        out.append(x)
    done.set()


def test_passes_through_without_flag(tmp_path):
    gate = tmp_path / 'pause.flag'          # 不创建 = 没暂停
    logs = []
    out = list(EM._pause_gate(iter([1, 2, 3]), str(gate), logs.append))
    assert out == [1, 2, 3]
    assert logs == []


def test_blocks_while_flag_exists_then_resumes(tmp_path):
    gate = tmp_path / 'pause.flag'
    gate.write_text('1', encoding='utf-8')
    logs = []
    produced = []
    done = threading.Event()
    t = threading.Thread(target=_drain, args=(EM._pause_gate(iter([1, 2, 3]), str(gate), logs.append), produced, done), daemon=True)
    t.start()
    time.sleep(0.8)
    assert produced == [], '暂停期间不许继续产出：%r' % (produced,)
    assert any('暂停' in s for s in logs), logs
    gate.unlink()                            # ← 「继续」
    assert done.wait(5.0), '删掉标记后应当接着跑完'
    assert produced == [1, 2, 3], produced
    assert sum(1 for s in logs if s.startswith('[暂停]')) == 1, logs
    assert sum(1 for s in logs if s.startswith('[继续]')) == 1, logs


def test_missing_log_callback_is_safe(tmp_path):
    """log_cb 允许为 None（引擎的若干内部调用就不传）。"""
    gate = tmp_path / 'pause.flag'
    gate.write_text('1', encoding='utf-8')
    produced = []
    done = threading.Event()
    t = threading.Thread(target=_drain, args=(EM._pause_gate(iter([9]), str(gate), None), produced, done), daemon=True)
    t.start()
    time.sleep(0.5)
    gate.unlink()
    assert done.wait(5.0)
    assert produced == [9]


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


def test_muscriptor_wrapper_skips_models_without_token_stream():
    """不走 token 流的模型（测试替身 / 别的引擎）不许因为"暂停"这个可选功能炸掉。"""
    class _Plain:
        pass

    m = _Plain()
    EM._install_pause_wrapper(m)          # 不抛异常
    assert not hasattr(m, '_fufumidi_pause_wrapped')


def test_muscriptor_wrapper_uses_current_gate(tmp_path, monkeypatch):
    """MuScriptor 的包装器只装一次，但拦的是**当前**闸门 —— 第二个文件照样能暂停。"""
    flag = tmp_path / 'pause.flag'
    monkeypatch.setenv('FUFUMIDI_PAUSE_FILE', str(flag))

    class _Model:
        def _generate_token_stream(self):
            yield 1
            yield 2

    model = _Model()
    EM._install_pause_wrapper(model)
    assert model._fufumidi_pause_wrapped is True
    EM._install_pause_wrapper(model)          # 只包一次，不叠加
    logs = []
    PG.install(logs.append)
    flag.write_text('1', encoding='utf-8')
    produced = []
    done = threading.Event()
    t = threading.Thread(target=_drain, args=(model._generate_token_stream(), produced, done), daemon=True)
    t.start()
    time.sleep(0.6)
    assert produced == [], '暂停期间不许产出：%r' % (produced,)
    flag.unlink()
    assert done.wait(5.0)
    assert produced == [1, 2]
    assert sum(1 for s in logs if s.startswith('[暂停]')) == 1, logs
    assert sum(1 for s in logs if s.startswith('[继续]')) == 1, logs

# -*- coding: utf-8 -*-
"""basic-pitch 引擎的暂停闸门（engine_basic 的取窗生成器包装）。

basic-pitch 的 predict() 是「一次调用跑完整首」，但它的取窗生成器
basic_pitch.inference.get_audio_input() 是模块级生成器 —— 引擎把闸门挂在那上面，
断点就落在「窗与窗之间」（约 1.6 秒音频）。这里钉住：
  1. 只挂一次（重复安装不叠加）；
  2. 标记文件出现时生成器卡住、删掉后从原处继续（已算的窗不重算）；
  3. 包装器**不捕获** log_cb —— 每次转录重绑，第二首的暂停日志打到第二首的回调上。

不 import basic_pitch：假装一个 inference 模块传进去。
"""
import os
import sys
import threading
import time

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import engine_basic as EB  # noqa: E402
import pause_gate as PG  # noqa: E402


class _FakeInference:
    """最小 inference 模块：只有一个取窗生成器。"""

    def __init__(self, n_windows=3):
        self.n = n_windows

    def get_audio_input(self, *a, **kw):
        for i in range(self.n):
            yield ('window', i)


def _drain(gen, out, done):
    for item in gen:
        out.append(item)
    done.set()


def test_install_is_idempotent():
    mod = _FakeInference()
    EB._install_audio_input_gate(mod)
    first = mod.get_audio_input
    EB._install_audio_input_gate(mod)
    assert mod.get_audio_input is first, '重复安装不许叠加包装'
    assert mod._fufumidi_pause_wrapped is True
    assert list(mod.get_audio_input()) == [('window', 0), ('window', 1), ('window', 2)]


def test_no_pause_file_passes_windows_through(monkeypatch):
    monkeypatch.delenv('FUFUMIDI_PAUSE_FILE', raising=False)
    PG.install(None)
    mod = _FakeInference()
    EB._install_audio_input_gate(mod)
    assert list(mod.get_audio_input()) == [('window', 0), ('window', 1), ('window', 2)]


def test_pause_blocks_between_windows_then_resumes(tmp_path, monkeypatch):
    flag = tmp_path / 'pause.flag'
    monkeypatch.setenv('FUFUMIDI_PAUSE_FILE', str(flag))
    flag.write_text('1', encoding='utf-8')
    logs = []
    PG.install(logs.append)
    mod = _FakeInference(3)
    EB._install_audio_input_gate(mod)
    produced = []
    done = threading.Event()
    t = threading.Thread(target=_drain, args=(mod.get_audio_input(), produced, done), daemon=True)
    t.start()
    time.sleep(0.6)
    assert produced == [], '暂停期间不许产出窗：%r' % (produced,)
    flag.unlink()                      # ← 「继续」
    assert done.wait(5.0), '删掉标记后应当接着跑完'
    assert produced == [('window', 0), ('window', 1), ('window', 2)]
    assert sum(1 for s in logs if s.startswith('[暂停]')) == 1, logs
    assert sum(1 for s in logs if s.startswith('[继续]')) == 1, logs


def test_wrapper_does_not_capture_log_callback(tmp_path, monkeypatch):
    """★ 包装器只装一次；日志必须跟着**本次**转录的 log_cb 走（第二首不许打到第一首）。"""
    flag = tmp_path / 'pause.flag'
    monkeypatch.setenv('FUFUMIDI_PAUSE_FILE', str(flag))
    mod = _FakeInference(1)
    EB._install_audio_input_gate(mod)
    first, second = [], []
    PG.install(first.append)
    list(mod.get_audio_input())        # 第一首（没暂停）
    flag.write_text('1', encoding='utf-8')
    PG.install(second.append)          # ← 第二首：重绑日志
    produced = []
    done = threading.Event()
    t = threading.Thread(target=_drain, args=(mod.get_audio_input(), produced, done), daemon=True)
    t.start()
    time.sleep(0.6)
    flag.unlink()
    assert done.wait(5.0)
    assert first == [], '第二首的暂停日志不许打到第一首的回调上：%r' % (first,)
    assert any(s.startswith('[暂停]') for s in second), second
    assert any(s.startswith('[继续]') for s in second), second

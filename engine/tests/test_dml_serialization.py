# -*- coding: utf-8 -*-
"""DirectML 串行区回归（上游 799ba8de / PR #2494 的移植）。

上游原话：Windows 的 DirectML 版 ONNX Runtime 在「会话创建 / Run / 释放」三者**重叠**时
会**原生杀进程**（0xC0000005，没有托管异常）。同一会话**并发 Run** 几秒内就死。

所以这组测试要证明三件事：
  1. DML 下并发 Run **确实被串行化**（不是「加了锁」就算，要量到并发度为 1）
  2. 纯 CPU **不该**被串行化（否则白白损失并行度 —— 这是回归而不是优化）
  3. 用过 DML 之后**一直**加锁（上游 review 的修正：偏好切回 CPU 也不放开）
另加一条：我自己引入过的那个 release 竞态的回归。
"""
import os
import sys
import threading
import time

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from diffsinger import session as S  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_dml_flag():
    old = S._DML_EVER_USED
    S._DML_EVER_USED = False
    yield
    S._DML_EVER_USED = old


class _Tracker:
    def __init__(self, hold=0.03):
        self.cur = 0
        self.peak = 0
        self.hold = hold
        self.lock = threading.Lock()


def _install_fake(monkeypatch, tracker):
    class FakeSession:
        def run(self, out, feeds):
            with tracker.lock:
                tracker.cur += 1
                tracker.peak = max(tracker.peak, tracker.cur)
            time.sleep(tracker.hold)
            with tracker.lock:
                tracker.cur -= 1
            return ['ok']

    monkeypatch.setattr(S, 'make_session', lambda m, p: FakeSession())
    monkeypatch.setattr(S, 'verify_input_names', lambda s, f: None)


def _burst(providers, n=6):
    ts = [threading.Thread(target=S.run_session, args=('m', {}, providers, 'lbl'))
          for _ in range(n)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()


DML = ['DmlExecutionProvider']
CPU = ['CPUExecutionProvider']


def test_dml_serializes_concurrent_runs(monkeypatch):
    tr = _Tracker()
    _install_fake(monkeypatch, tr)
    _burst(DML)
    assert tr.peak == 1, 'DML 下并发 Run 没被串行化，峰值并发=%d' % tr.peak


def test_cpu_only_is_not_serialized(monkeypatch):
    tr = _Tracker()
    _install_fake(monkeypatch, tr)
    _burst(CPU)
    assert tr.peak > 1, ('纯 CPU 不该被串行化（白白损失并行度），峰值并发=%d' % tr.peak)


def test_lock_stays_engaged_after_dml_used(monkeypatch):
    with S.dml_scope(DML):
        pass
    assert S.dml_serialization_engaged() is True
    tr = _Tracker()
    _install_fake(monkeypatch, tr)
    _burst(CPU)   # 已经用过 DML -> 即便现在只给 CPU 也必须串行
    assert tr.peak == 1, ('用过 DML 之后没保持加锁，峰值并发=%d' % tr.peak)


def test_never_used_dml_keeps_scope_a_noop(monkeypatch):
    assert S.dml_serialization_engaged() is False
    tr = _Tracker()
    _install_fake(monkeypatch, tr)
    _burst(CPU)
    assert tr.peak > 1, '没用过 DML 却加了锁 —— 纯 CPU 用户不该付这个代价'


def test_scope_does_not_release_unacquired_lock():
    """回归：__exit__ 曾经重读 _DML_EVER_USED，会 release 一把从未 acquire 的锁。"""
    sc = S.dml_scope()
    sc.__enter__()                 # 此刻 flag=False -> 没持锁
    S._DML_EVER_USED = True        # 模拟别的线程在退出前置位
    sc.__exit__(None, None, None)  # 修复前这里抛 RuntimeError


def test_unused_dml_scope_acquires_nothing():
    assert S._DML_LOCK.acquire(blocking=False) is True
    S._DML_LOCK.release()
    with S.dml_scope() as sc:
        assert sc._held is False

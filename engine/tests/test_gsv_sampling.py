# -*- coding: utf-8 -*-
"""GPT-SoVITS 采样三参数的转发测试。

★ 这三个参数的**默认值在 GPT-SoVITS 那边，不在我们手里** —— 实地读自本机那份 runtime：
  `GPT_SoVITS/TTS_infer_pack/TTS.py:1142-1144` → top_k=15 / top_p=1 / temperature=1。
  所以我们的正确行为是「**不传**」，而不是"抄一份默认值过来"（抄了就会与上游分叉）。

这条测试钉的正是这个"不传"：
  · None → inputs 里**不能出现**这三个键；
  · 显式给了 → 必须原样出现；
  · 只给一个 → 只发那一个；
  · CLI 两个子命令（say / sing）都要认这三个参数 —— 漏一跳就是"滑块拖了没反应"。
"""

import os
import subprocess
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE = os.path.dirname(_HERE)
if _ENGINE not in sys.path:
    sys.path.insert(0, _ENGINE)

import engine_gpt_sovits as GSV  # noqa: E402


class _FakeTTS:
    """只实现 synth 用到的那一点点：run(inputs) 产一段假音频。"""

    def __init__(self):
        self.seen = None

    def run(self, inputs):
        self.seen = dict(inputs)
        import numpy as np
        yield 32000, np.zeros(32, dtype='float32')


def _run(**kw):
    tts = _FakeTTS()
    y, sr = GSV.synth(tts, '测试文本', 'ref.wav', '参考文本', **kw)
    return tts.seen, y, sr


def test_default_sends_nothing():
    """★ 不传 = 一个都不发（"没替上游定默认"是结构上成立的，不靠文档承诺）。"""
    seen, y, sr = _run()
    for k in ('top_k', 'top_p', 'temperature'):
        assert k not in seen, k
    assert sr == 32000
    assert y is not None


def test_explicit_values_are_forwarded():
    seen, _, _ = _run(top_k=25, top_p=0.8, temperature=0.6)
    assert seen['top_k'] == 25
    assert abs(seen['top_p'] - 0.8) < 1e-9
    assert abs(seen['temperature'] - 0.6) < 1e-9


def test_partial_override_only_sends_that_one():
    seen, _, _ = _run(top_p=0.5)
    assert 'top_p' in seen
    assert 'top_k' not in seen and 'temperature' not in seen


def test_sampling_kwargs_skips_none():
    class A:
        top_k = None
        top_p = 0.9
        temperature = None

    assert GSV._sampling_kwargs(A()) == {'top_p': 0.9}
    assert GSV._sampling_kwargs(object()) == {}      # 老对象没有这些属性 → 一个都不发


@pytest.mark.parametrize('cmd', ['say', 'sing'])
def test_cli_accepts_sampling_flags(cmd):
    r = subprocess.run([sys.executable, os.path.join(_ENGINE, 'engine_gpt_sovits.py'), cmd, '--help'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    assert r.returncode == 0
    for flag in ('--top-k', '--top-p', '--temperature'):
        assert flag in r.stdout, (cmd, flag)

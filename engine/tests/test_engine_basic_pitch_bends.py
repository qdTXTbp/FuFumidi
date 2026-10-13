# -*- coding: utf-8 -*-
"""basic-pitch 的 multiple_pitch_bends 转发链路测试。

背景：它是 basic-pitch **唯一没被转发的用户可见参数** —— 改动前引擎里连这个标识符
都搜不到，所以一直按上游默认 False 跑。这条测试钉住两件事：

  1) transcribe_basic 会把它**转发**给 basic_pitch.inference.predict（真调一次，用假 predict 接住）；
  2) 不传时必须是 **False** —— 它一旦悄悄变 True，导出的 MIDI 会平白多出大量弯音事件。

为什么只测转发、不测端到端：端到端要真跑推理 + ffmpeg 解码，慢且脆。
而**参数转发正是这条链路唯一的易错点** —— 同一个目录里已经有三处同类注释
（muscriptor_instruments / beat_grid / max_note_hold 都曾漏在这一层，界面调了不生效）。
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE = os.path.dirname(_HERE)
if _ENGINE not in sys.path:
    sys.path.insert(0, _ENGINE)

import engine_basic  # noqa: E402


class _FakeMidi:
    def __init__(self):
        self.written = None

    def write(self, path):
        self.written = path
        with open(path, 'wb') as f:
            f.write(b'MThd')


def _run(monkeypatch, tmp_path, **kw):
    """跑一次 transcribe_basic，返回 predict 实际收到的 kwargs。"""
    seen = {}

    def fake_predict(audio, model, **kwargs):
        seen.update(kwargs)
        seen['_audio'] = audio
        return None, _FakeMidi(), []

    import audio_io
    import engine_perf
    from basic_pitch import inference as inf

    monkeypatch.setattr(inf, 'predict', fake_predict)
    monkeypatch.setattr(engine_perf, 'make_basic_model', lambda n=None: 'FAKE_MODEL')
    monkeypatch.setattr(audio_io, 'decode_to_wav', lambda p, sr: 'FAKE.wav', raising=False)
    monkeypatch.setattr(audio_io, 'remove_temp', lambda *a, **k: None, raising=False)

    out = str(tmp_path / 'out.mid')
    engine_basic.transcribe_basic('in.wav', out, **kw)
    assert os.path.isfile(out), '输出 MIDI 应该被写出来'
    return seen


def test_multiple_pitch_bends_forwarded_when_true(monkeypatch, tmp_path):
    seen = _run(monkeypatch, tmp_path, multiple_pitch_bends=True)
    assert seen.get('multiple_pitch_bends') is True, seen


def test_multiple_pitch_bends_defaults_to_false(monkeypatch, tmp_path):
    """★ 默认必须 False：悄悄变 True 会让导出 MIDI 多出大量无用弯音事件。"""
    seen = _run(monkeypatch, tmp_path)
    assert seen.get('multiple_pitch_bends') is False, seen


def test_neighbour_params_not_broken(monkeypatch, tmp_path):
    """顺带钉住邻居参数没被这次改动带歪。"""
    seen = _run(monkeypatch, tmp_path, onset_threshold=0.42, melodia_trick=False)
    assert abs(seen['onset_threshold'] - 0.42) < 1e-9
    assert seen['melodia_trick'] is False

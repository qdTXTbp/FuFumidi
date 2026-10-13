# -*- coding: utf-8 -*-
"""多说话人声库的**检测**测试（真正的说话人嵌入支持还没做）。

★ 先纠正一条容易被想当然的判断：多说话人声库**不是「静默用默认说话人」**。
  session.verify_input_names 是**双向严格比对、缺/多都抛**（对应上游 Onnx.VerifyInputNames），
  所以模型声明了 spk 而 feed 里没有时，会直接 RenderError「模型输入不匹配 —— 缺少 [spk]」
  —— 失败是**响的**，不是哑的。

这条测试钉住两件今天就该成立的事：
  1) 缺 spk 时的报错要**能行动**（点明"这是多说话人声库、当前不支持"），
     而不是让用户去翻 dsconfig 的 use*Embed 开关（那与 spk 无关）；
  2) 声库体检要**提前**把「多说话人」标出来 —— 别让用户点了渲染才撞上。
"""

import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE = os.path.dirname(_HERE)
if _ENGINE not in sys.path:
    sys.path.insert(0, _ENGINE)

from diffsinger.session import RenderError, verify_input_names  # noqa: E402
from engine_vbcheck import check_diffsinger  # noqa: E402


class _In:
    def __init__(self, name):
        self.name = name


class _Sess:
    def __init__(self, names):
        self._names = names

    def get_inputs(self):
        return [_In(n) for n in self._names]


def test_missing_spk_says_multispeaker():
    """缺 spk → 报错必须点明「多说话人声库、当前不支持」，而不是泛泛的输入不匹配。"""
    with pytest.raises(RenderError) as ei:
        verify_input_names(_Sess(['tokens', 'durations', 'spk']), {'tokens': 1, 'durations': 2})
    msg = str(ei.value)
    assert '多说话人' in msg, msg
    assert 'spk' in msg, msg


def test_other_missing_input_keeps_generic_message():
    """缺的不是 spk（例如 useVarianceEmbed 开关不对）→ 保留原来的通用提示。"""
    with pytest.raises(RenderError) as ei:
        verify_input_names(_Sess(['tokens', 'variance_embed']), {'tokens': 1})
    msg = str(ei.value)
    assert 'variance_embed' in msg
    assert '多说话人' not in msg


def test_matching_feeds_pass():
    verify_input_names(_Sess(['tokens', 'spk']), {'tokens': 1, 'spk': 2})


def _mkvb(tmp_path, dsconfig):
    vb = tmp_path / 'vb'
    (vb / 'dsdur').mkdir(parents=True)
    (vb / 'dsvocoder').mkdir(parents=True)
    (vb / 'dsconfig.yaml').write_text(dsconfig, encoding='utf-8')
    return str(vb)


def test_vbcheck_warns_on_multispeaker(tmp_path):
    vb = _mkvb(tmp_path, 'phonemes: []\nspeakers: [小明, 小红]\n')
    checks, _ = check_diffsinger(vb, [])
    hit = [c for c in checks if c['id'] == 'speakers']
    assert hit, checks
    assert hit[0]['level'] == 'warn'
    assert '多说话人' in hit[0]['text']


def test_vbcheck_ok_on_single_speaker(tmp_path):
    vb = _mkvb(tmp_path, 'phonemes: []\nspeakers: [小明]\n')
    checks, _ = check_diffsinger(vb, [])
    hit = [c for c in checks if c['id'] == 'speakers']
    assert hit and hit[0]['level'] == 'ok'


def test_vbcheck_quiet_when_undeclared(tmp_path):
    """没声明 speakers（绝大多数单说话人声库）→ 不加噪声条目。"""
    vb = _mkvb(tmp_path, 'phonemes: []\n')
    checks, _ = check_diffsinger(vb, [])
    assert not [c for c in checks if c['id'] == 'speakers']
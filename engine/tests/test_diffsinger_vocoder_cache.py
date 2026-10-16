# -*- coding: utf-8 -*-
"""声码器覆盖的**缓存键**测试。

背景：乐句 wav 缓存名 `ds-{hash}-depth-steps.wav` 以前**不含声码器** —— 换了声码器仍会命中
上一次的 wav，界面表现就是「换了没反应」（本仓库这类漏一跳的坑已经踩过三次）。
修法是把声码器加进缓存名，但**只在给了覆盖时才加**：不加这个限制，一次升级会把所有已有的
乐句缓存作废、全部重渲一遍。

这里钉三件事：
  1) 没给覆盖时文件名与旧版**逐字相同**（不许作废存量缓存）；
  2) 给了覆盖时带稳定标签，且同一路径的不同写法落到同一个名字；
  3) **渲染器与预览器取的是同一个名字** —— preview.py 的 docstring 明写「必须一致，
     对不上会让缓存永远 miss」，而这两处以前各写了一份格式串（正是对不上的根源）。
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE = os.path.dirname(_HERE)
if _ENGINE not in sys.path:
    sys.path.insert(0, _ENGINE)

from singing.openutau.diffsinger.cache_name import phrase_cache_name, vocoder_tag  # noqa: E402


class _Phrase:
    def __init__(self, h):
        self.hash = h


def test_no_override_keeps_legacy_name():
    """★ 没给覆盖 → 文件名必须与旧版逐字相同，否则升级会作废所有人的乐句缓存。"""
    legacy = 'ds-%016x-depth1.00-steps20.wav' % 0xDEADBEEF
    assert phrase_cache_name(0xDEADBEEF, 1.0, 20) == legacy
    assert phrase_cache_name(0xDEADBEEF, 1.0, 20, None) == legacy
    assert phrase_cache_name(0xDEADBEEF, 1.0, 20, '') == legacy
    assert vocoder_tag('') == ''
    assert vocoder_tag(None) == ''


def test_override_appends_stable_tag():
    a = phrase_cache_name(1, 1.0, 20, r'E:\vb\vocoder.onnx')
    assert a.endswith('.wav') and '-voc' in a
    assert len(a.split('-voc')[1].split('.')[0]) == 8
    # 同一路径的不同写法 → 同一标签（否则同一份缓存会被存两遍）
    assert vocoder_tag(r'E:\vb\vocoder.onnx') == vocoder_tag(r'e:\vb\vocoder.onnx')
    # 不同声码器 → 不同文件名
    assert phrase_cache_name(1, 1.0, 20, r'E:\a\v.onnx') != phrase_cache_name(1, 1.0, 20, r'E:\b\v.onnx')


def test_renderer_and_preview_agree_on_the_name():
    """★ 渲染器与预览器必须算出同一个名字 —— 这就是 preview.py 那句 docstring 的不变量。"""
    from singing.openutau.diffsinger.diffsinger_renderer import DiffsingerIRenderer

    cache = _HERE
    ph = _Phrase(0x1234ABCD)
    for voc in (None, r'E:\some\voc.onnx'):
        rd = DiffsingerIRenderer(cache_dir=cache, vocoder=voc)
        assert os.path.basename(rd._cache_path(ph, 1.0, 20)) == phrase_cache_name(ph.hash, 1.0, 20, voc)
    # 关掉缓存目录时不产文件名（原行为）
    assert DiffsingerIRenderer(cache_dir=None, vocoder=r'E:\x\v.onnx')._cache_path(ph, 1.0, 20) is None


def test_preview_cache_hit_sees_the_override_name(tmp_path):
    """预览命中判定也要按带声码器的名字找文件 —— 否则预览永远 miss、一直重渲。"""
    from singing.openutau.diffsinger import preview as PV

    voc = r'E:\x\v.onnx'
    name = phrase_cache_name(7, 1.0, 20, voc)
    with open(os.path.join(str(tmp_path), name), 'wb'):
        pass
    assert PV._cache_hit(_Phrase(7), str(tmp_path), 1.0, 20, voc) is True
    # 不带覆盖时是**另一个**文件名 → 不应被误判为命中
    assert PV._cache_hit(_Phrase(7), str(tmp_path), 1.0, 20, None) is False

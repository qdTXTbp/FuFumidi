# -*- coding: utf-8 -*-
"""resampler 清单里的额外元文件（上游 2026-10-07 功能 + 2026-10-09 NRE 修复的移植回归）。

上游 `5c3c83bb` 修的是一个 NullReferenceException：
`GetMetaFiles` 里写了 `resampler as ExeResampler`，**对内置 resampler 会得到 null**，
紧接着 `exeResampler.Manifest` 就炸。修法是 `resampler?.Manifest?.files`。

我们的移植里原本**整段都没有**（所以没有那个 bug，但也缺了这个功能）。
这个文件同时守住两件事：功能在、且三种「没有清单」的情形都不抛。
"""
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from singing.openutau.classic.resampler_manifest import ResamplerManifest  # noqa: E402
from singing.openutau.classic.voicebank_files import VoicebankFiles        # noqa: E402


SRC = '/vb/a.wav'
TEMP = '/c/s.wav'


class _Res:
    def __init__(self, manifest):
        self.manifest = manifest


def _vf():
    return VoicebankFiles()


def test_base_list_is_13_pairs_without_resampler():
    pairs = _vf().get_meta_files(SRC, TEMP)
    assert len(pairs) == 13
    assert os.path.basename(pairs[0][0]) == 'a_wav.frq'
    assert os.path.basename(pairs[-1][0]) == 'a.hifi.npz'


def test_manifest_files_are_appended():
    pairs = _vf().get_meta_files(SRC, TEMP, _Res(ResamplerManifest(files=['.myext', '_myside'])))
    assert len(pairs) == 15
    assert pairs[13] == ('/vb/a.myext', '/c/s.myext')
    assert pairs[14] == ('/vb/a_myside', '/c/s_myside')


def test_empty_files_leaves_base_unchanged():
    pairs = _vf().get_meta_files(SRC, TEMP, _Res(ResamplerManifest()))
    assert len(pairs) == 13


@pytest.mark.parametrize('resampler', [
    None,                       # 完全不传
    object(),                   # 内置 resampler：连 manifest 属性都没有 → 上游 NRE 的场景
    _Res(None),                 # manifest 显式为 None
])
def test_no_manifest_never_raises(resampler):
    pairs = _vf().get_meta_files(SRC, TEMP, resampler)
    assert len(pairs) == 13

# -*- coding: utf-8 -*-
"""Q3 回归：与内置同名的外部 resampler 不得顶掉内置（上游 2913eeb9）。

上游原话：
    An extensionless file such as `Resamplers/hifisampler` on macOS got the built-in's
    name and replaced it in the resampler map, so tracks set to the built-in hifisampler
    ran the external binary instead.

★ 平台注意（别把这测试读成「Windows 上会撞」）：
  上游与我们的 `ExeResampler` 名字都取 `GetRelativePath(base, file)`，**保留扩展名**；
  而 `WorldlineResampler.ToString()` 是 `worldline`（无扩展名）。
  于是 **Windows 上 `worldline.exe` 的名字是 `worldline.exe`，撞不上** ——
  碰撞只在 Linux/macOS 的**无扩展名**文件上发生（`load_resampler` 在那两个平台接受 ext==''）。
  所以这里用**替身**直接测守卫逻辑本身，不依赖平台的文件扩展名语义。
"""
import os
import sys
import tempfile

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from singing.openutau.classic import resampler_item            # noqa: E402
from singing.openutau.classic.tools_manager import ToolsManager  # noqa: E402
from singing.openutau.classic.worldline_resampler import WorldlineResampler  # noqa: E402


class _StubResampler:
    """冒充外部 resampler：名字可控，别的一概不参与。"""

    def __init__(self, name):
        self._name = name

    def __str__(self):
        return self._name


class _Host:
    def __init__(self, root):
        self.root_path = root
        self.resamplers_path = root
        self.wavtools_path = os.path.join(root, 'w')
        self.cache_path = os.path.join(root, 'c')


def _run(entries, monkeypatch):
    """entries: [(文件名, 替身命名 或 None=当成加载失败)]"""
    tmp = tempfile.mkdtemp(prefix='fufumidi-tm-')
    for fn, _n in entries:
        with open(os.path.join(tmp, fn), 'wb') as f:
            f.write(b'x')
    by_base = {fn: n for fn, n in entries}

    def fake_load(self, file_path, base_path):
        n = by_base.get(os.path.basename(file_path))
        return None if n is None else _StubResampler(n)

    old_host = resampler_item.host
    resampler_item.host = _Host(tmp)
    monkeypatch.setattr(ToolsManager, 'load_resampler', fake_load)
    try:
        tm = ToolsManager()
        tm.search_resamplers()
        return dict(tm._resamplers_map)
    finally:
        resampler_item.host = old_host
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_builtin_wins_over_same_named_external(monkeypatch):
    m = _run([('worldline', 'worldline'), ('other', 'other')], monkeypatch)
    assert isinstance(m['worldline'], WorldlineResampler), '内置被顶替了'
    assert 'other' in m, '正常外部 resampler 不该被误杀'
    assert sum(1 for k in m if k == 'worldline') == 1


def test_external_with_same_name_is_not_in_map(monkeypatch):
    m = _run([('a', 'worldline')], monkeypatch)
    # 内置那一项仍在，且**不是**替身
    assert isinstance(m['worldline'], WorldlineResampler)
    assert not isinstance(m['worldline'], _StubResampler)


def test_load_failure_does_not_add_anything(monkeypatch):
    m = _run([('bad', None)], monkeypatch)
    assert list(m.keys()) == ['worldline']


def test_only_builtin_when_no_external(monkeypatch):
    m = _run([], monkeypatch)
    assert list(m.keys()) == ['worldline']
    assert isinstance(m['worldline'], WorldlineResampler)

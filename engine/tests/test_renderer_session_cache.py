# -*- coding: utf-8 -*-
"""ONNX 会话缓存 —— 同一个模型在进程内**只解析一次**。

背景（实测）：建会话要把整个 onnx 重新解析计算图 + 分配权重（acoustic 200MB+，
一次 3~8 秒）。以前每句、每个模型都新建一次 —— 一首 600+ 音符的歌光建会话就几分钟，
表现为「整首一次渲染一直不出结果」，只好把歌切成 <=140 音符的小段。
上游 C# 也是把 `InferenceSession` memo 在歌手对象上（`Onnx.cs:170-186`）。

同时钉住 provider 解析的**按 device 缓存**：以前只存一个全局值，
第一次用 auto 解析出 CUDA 之后，后面所有 `--device cpu` 都被悄悄当成 CUDA。
"""
import os
import sys
import types

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from diffsinger import session as S                      # noqa: E402


class _FakeSession:
    """占位会话：只要能被当成对象缓存起来就够了。"""

    def __init__(self, tag):
        self.tag = tag


@pytest.fixture(autouse=True)
def _clean_cache():
    S.clear_session_cache()
    yield
    S.clear_session_cache()


@pytest.fixture
def fake_builder(monkeypatch):
    """替掉真正的 onnxruntime 建会话，改记调用次数。"""
    calls = []

    def build(model_path, providers):
        calls.append((model_path, tuple(providers)))
        return _FakeSession(len(calls))

    monkeypatch.setattr(S, '_make_session_uncached', build)
    return calls


def _model(tmp_path, name, size=1024):
    p = tmp_path / name
    p.write_bytes(b'x' * size)
    return str(p)


def test_make_session_reuses_same_object(tmp_path, fake_builder):
    """第二次 make_session 必须**复用同一个会话**，不再碰 onnxruntime。"""
    m = _model(tmp_path, 'acoustic.onnx')
    assert S.session_cache_info()['hit'] == 0, 'clear_session_cache() 必须把统计也归零'
    s1 = S.make_session(m, ['CPUExecutionProvider'])
    s2 = S.make_session(m, ['CPUExecutionProvider'])
    assert s1 is s2, '同一个模型 + 同一组 provider 必须返回同一个会话对象'
    assert len(fake_builder) == 1, '只允许建一次会话，实际 %d 次' % len(fake_builder)
    info = S.session_cache_info()
    assert info['miss'] == 1 and info['hit'] == 1, info


def test_providers_are_part_of_the_key(tmp_path, fake_builder):
    """换 provider 就是另一个会话（CUDA 会话与 CPU 会话不能混用）。"""
    m = _model(tmp_path, 'vocoder.onnx')
    a = S.make_session(m, ['CUDAExecutionProvider', 'CPUExecutionProvider'])
    b = S.make_session(m, ['CPUExecutionProvider'])
    assert a is not b
    assert len(fake_builder) == 2


def test_cache_invalidated_when_model_file_changes(tmp_path, fake_builder):
    """同一个路径换了模型文件（大小/时间戳变了）→ 必须重建，不能拿旧会话糊弄。"""
    m = _model(tmp_path, 'acoustic.onnx', size=1024)
    S.make_session(m, ['CPUExecutionProvider'])
    # 文件被覆盖（换声库/重下模型）
    with open(m, 'wb') as f:
        f.write(b'y' * 4096)
    future = 2 ** 31
    os.utime(m, (future, future))
    S.make_session(m, ['CPUExecutionProvider'])
    assert len(fake_builder) == 2, '模型文件变了必须重建会话'


def test_lru_bound(tmp_path, fake_builder, monkeypatch):
    """缓存有上限：超过 MAX_CACHED_SESSIONS 时淘汰最久未用的那条。"""
    monkeypatch.setattr(S, 'MAX_CACHED_SESSIONS', 2)
    paths = [_model(tmp_path, 'm%d.onnx' % i) for i in range(3)]
    for p in paths:
        S.make_session(p, ['CPUExecutionProvider'])
    info = S.session_cache_info()
    assert info['size'] == 2, '缓存必须被限制在 2 条，实际 %d' % info['size']
    assert info['evict'] == 1, info
    # 最旧的那条已被淘汰 → 再来一次是 miss（重建）
    S.make_session(paths[0], ['CPUExecutionProvider'])
    assert len(fake_builder) == 4, '被淘汰的模型必须重建'
    # 命中的那条不重建
    S.make_session(paths[2], ['CPUExecutionProvider'])
    assert len(fake_builder) == 4


def test_cache_can_be_disabled_by_env(tmp_path, fake_builder, monkeypatch):
    """FUFUMIDI_DS_SESSION_CACHE=0 → 每次都新建（排查「换了模型没生效」用）。"""
    monkeypatch.setenv('FUFUMIDI_DS_SESSION_CACHE', '0')
    m = _model(tmp_path, 'acoustic.onnx')
    S.make_session(m, ['CPUExecutionProvider'])
    S.make_session(m, ['CPUExecutionProvider'])
    assert len(fake_builder) == 2
    assert S.session_cache_info()['size'] == 0


def test_resolve_providers_cached_per_device(monkeypatch):
    """provider 列表按 device 分别缓存 —— cpu 请求不许被 auto/cuda 的首个结果污染。"""
    fake = types.SimpleNamespace(
        get_available_providers=lambda: ['CUDAExecutionProvider', 'CPUExecutionProvider'])
    monkeypatch.setitem(sys.modules, 'onnxruntime', fake)
    monkeypatch.setattr(S, '_PROVIDERS', {})
    assert S.resolve_providers('cpu') == ['CPUExecutionProvider']
    assert S.resolve_providers('auto') == ['CUDAExecutionProvider', 'CPUExecutionProvider']
    # 反过来也一样：先 auto 再 cpu 仍然各归各
    monkeypatch.setattr(S, '_PROVIDERS', {})
    assert S.resolve_providers('auto') == ['CUDAExecutionProvider', 'CPUExecutionProvider']
    assert S.resolve_providers('cpu') == ['CPUExecutionProvider']


def test_resolve_providers_falls_back_to_cpu(monkeypatch):
    """GPU provider 不可用时降到 CPU，且**不重复**列同一个 provider（实测会告警）。"""
    fake = types.SimpleNamespace(get_available_providers=lambda: ['CPUExecutionProvider'])
    monkeypatch.setitem(sys.modules, 'onnxruntime', fake)
    monkeypatch.setattr(S, '_PROVIDERS', {})
    assert S.resolve_providers('cuda') == ['CPUExecutionProvider']

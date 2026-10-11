# -*- coding: utf-8 -*-
"""声库加载缓存 —— 同一进程里重复 load_singer / model_hash 不许重复读全量模型字节。

背景（实测）：渲染器对**每个乐句**调一次 load_singer（diffsinger_renderer._work），
而 acoustic 有 200MB+，xxhash 又是纯 Python 实现（签名要求与 C# XXH64.DigestOf 同值），
一次全量哈希 20~30 秒。12 个乐句 = 12 次 = 5 分钟纯 CPU 空转，表现为「长曲渲染卡死」。
加载一次、进程内复用之后，同一首曲子实测从「十几分钟不动」变成 2 分钟内出结果。
"""
import os
import sys
import time

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from diffsinger import voicebank                      # noqa: E402
from singing.openutau import xxhash                   # noqa: E402


def _find_voicebank():
    """找一个**自带 dsvocoder** 的真声库来测缓存；没有就 skip（CI 上不装声库）。

    ★ 必须要求 dsvocoder：缺它的声库在 load_singer 阶段就会抛「无法定位声码器」，
      那是另一件事，不该让缓存用例误报失败（实测 Ria 就是这种声库）。
    """
    cands = []
    env = os.environ.get('FUFUMIDI_TEST_VOICEBANK')
    if env:
        cands.append(env)
    root = os.environ.get('FUFUMIDI_DIFFSINGER_VB_DIR')
    if root:
        try:
            cands.extend(os.path.join(root, d) for d in sorted(os.listdir(root)))
        except OSError:
            pass
    for c in cands:
        if (os.path.isfile(os.path.join(c, 'dsconfig.yaml'))
                and os.path.isdir(os.path.join(c, 'dsdur'))
                and os.path.isdir(os.path.join(c, 'dsvocoder'))):
            return c
    return None


def test_model_hash_cached(tmp_path, monkeypatch):
    """同一文件的 hash 只算一次；文件变了（大小/时间戳）才重算。"""
    p = tmp_path / 'm.onnx'
    p.write_bytes(b'a' * (3 << 20))                  # 3MB → 3 个 1MB 分块
    calls = {'n': 0}
    real = xxhash.xxh64

    def counted(data, seed=0):
        calls['n'] += 1
        return real(data, seed)

    monkeypatch.setattr(xxhash, 'xxh64', counted)
    voicebank._HASH_CACHE.clear()
    h1 = voicebank.model_hash(str(p))
    first = calls['n']
    assert first == 3, '3MB 应当分 3 次调用底层 xxh64，实际 %d' % first
    h2 = voicebank.model_hash(str(p))
    assert h1 == h2
    assert calls['n'] == first, '第二次必须命中缓存，不能再读文件'
    # 内容/时间戳变化 → 缓存失效
    p.write_bytes(b'b' * (2 << 20))
    future = time.time() + 5
    os.utime(str(p), (future, future))
    calls['n'] = 0
    h3 = voicebank.model_hash(str(p))
    assert calls['n'] > 0, '文件变了必须重新计算'
    assert h3 != h1


def test_load_singer_reuses_object():
    """重复 load_singer 必须复用同一个对象，且第二次接近零成本。"""
    vb = _find_voicebank()
    if not vb:
        pytest.skip('本机没有可用的 DiffSinger 声库（设置 FUFUMIDI_TEST_VOICEBANK 或 FUFUMIDI_DIFFSINGER_VB_DIR）')
    voicebank._SINGER_CACHE.clear()
    voicebank._HASH_CACHE.clear()
    t0 = time.time()
    s1 = voicebank.load_singer(vb)
    first = time.time() - t0
    t0 = time.time()
    s2 = voicebank.load_singer(vb)
    second = time.time() - t0
    assert s1 is s2, '同一进程里必须复用同一个声库对象'
    assert second < max(0.5, first / 5.0), '第二次加载必须显著更快（首次 %.2fs / 第二次 %.4fs）' % (first, second)
    assert s1.hashes and len(s1.hashes) >= 4, '模型 hash 表必须齐全'

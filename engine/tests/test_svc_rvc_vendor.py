# -*- coding: utf-8 -*-
"""照搬一致性：我们的适配层与**上游 RVC 源码**必须逐项对得上。

为什么钉这个：翻唱的变声是靠上游 RVC 代码跑的。上游一升级，合成器映射表、
config 的 pad 取值就可能变 —— 我们这边悄悄用旧值的话，同一个权重会从「能唱」
变成「电音 / 直接报维度错」，而错误信息里根本看不出是漂移。

- 能读到上游源码（D:/FuFuMIDI/_ref/RVC）就逐项比对；**读不到就 SKIP**（不假装通过）。
- vendor 目录必须是上游原样：LICENSE 与来源说明齐全。
"""
import os
import re
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

VENDOR = os.path.join(ENGINE, 'svc', 'vendor', 'rvc')
UPSTREAM = os.path.join(os.path.dirname(os.path.dirname(ENGINE)), '_ref', 'RVC')

import svc.rvc as RVC                                     # noqa: E402

needs_upstream = pytest.mark.skipif(
    not os.path.isfile(os.path.join(UPSTREAM, 'infer', 'vc', 'modules.py')),
    reason='上游源码不在 %s（一致性比对跳过）' % UPSTREAM)


# ---------------------------------------------------------------- vendor 完整性
def test_vendor_has_license_and_provenance():
    assert os.path.isdir(VENDOR), 'vendor 目录不存在：%s' % VENDOR
    lic = os.path.join(VENDOR, 'LICENSE.upstream')
    assert os.path.isfile(lic)
    assert 'MIT License' in open(lic, encoding='utf-8', errors='ignore').read()
    readme = os.path.join(VENDOR, 'README.md')
    assert os.path.isfile(readme)
    txt = open(readme, encoding='utf-8', errors='ignore').read()
    assert 'github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI' in txt
    assert re.search(r'\b[0-9a-f]{40}\b', txt), 'README 里必须写明取的上游 commit sha'


def test_vendor_files_are_the_upstream_ones():
    """推理链路需要的那几个文件都得在（少一个 → 变声直接起不来）。"""
    for rel in ('infer/module/models.py', 'infer/module/modules.py', 'infer/module/commons.py',
                'infer/module/attentions.py', 'infer/module/transforms.py',
                'infer/vc/pipeline.py', 'infer/vc/utils.py',
                'infer/hubert.py', 'infer/rmvpe.py', 'tools/cuda_graph.py'):
        assert os.path.isfile(os.path.join(VENDOR, rel)), '缺 vendor 文件：%s' % rel


def test_vendor_sources_are_unmodified():
    """vendor 必须是**原样**：与上游逐字节相同（改过就说明有人手改了推理代码）。"""
    if not os.path.isdir(UPSTREAM):
        pytest.skip('上游源码不在，跳过逐字节比对')
    pairs = [
        ('infer/module/models.py', 'infer/module/models.py'),
        ('infer/vc/pipeline.py', 'infer/vc/pipeline.py'),
        ('infer/hubert.py', 'infer/hubert.py'),
        ('infer/rmvpe.py', 'infer/rmvpe.py'),
        ('tools/cuda_graph.py', 'tools/cuda_graph.py'),
    ]
    for ours, theirs in pairs:
        a = os.path.join(VENDOR, ours)
        b = os.path.join(UPSTREAM, theirs)
        if not os.path.isfile(b):
            continue
        assert open(a, 'rb').read() == open(b, 'rb').read(), 'vendor 文件被改过：%s' % ours


# ---------------------------------------------------------------- 上游一致性
@needs_upstream
def test_synthesizer_table_matches_upstream():
    """(version, if_f0) → 合成器：与上游 `infer/vc/modules.py::get_vc` 里的表逐项相同。"""
    src = open(os.path.join(UPSTREAM, 'infer', 'vc', 'modules.py'), encoding='utf-8', errors='ignore').read()
    m = re.search(r'synthesizer_class\s*=\s*\{(.*?)\}', src, re.S)
    assert m, '上游里没找到 synthesizer_class 表（结构变了，需要人工核对）'
    up = {}
    for ver, f0, cls_name in re.findall(r'\(\s*"([^"]+)"\s*,\s*([01])\s*\)\s*:\s*(\w+)', m.group(1)):
        up[(ver, int(f0))] = cls_name
    assert up, '没解析出任何一项'
    ours = {k: c.__name__ for k, c in RVC.synth_table().items()}
    assert ours == {k: v for k, v in up.items()}, '合成器映射表与上游不一致：上游 %s / 我们 %s' % (up, ours)


@needs_upstream
def test_pad_table_matches_upstream():
    """x_pad / x_query / x_center / x_max：与上游 `configs/config.py::device_config` 的取值一致。"""
    src = open(os.path.join(UPSTREAM, 'configs', 'config.py'), encoding='utf-8', errors='ignore').read()
    body = src[src.index('def device_config'):] if 'def device_config' in src else src
    got = {}
    for name, val in re.findall(r'x_(pad|query|center|max)\s*=\s*(\d+)', body):
        got.setdefault('block', []).append((name, int(val)))
    blocks = re.findall(r'x_pad\s*=\s*(\d+)\s*\n\s*x_query\s*=\s*(\d+)\s*\n\s*x_center\s*=\s*(\d+)\s*\n\s*x_max\s*=\s*(\d+)', body)
    assert blocks, '没解析出上游的 pad 配置块'
    ups = {tuple(int(x) for x in b) for b in blocks}
    assert tuple(RVC._PAD_TABLE['half']) in ups, 'fp16 那套取值与上游不符：%s' % (ups,)
    assert tuple(RVC._PAD_TABLE['full']) in ups, 'fp32 那套取值与上游不符：%s' % (ups,)
    assert tuple(RVC._PAD_TABLE['small']) in ups, '≤4G 显存那套取值与上游不符：%s' % (ups,)


@needs_upstream
def test_upstream_has_no_filter_radius_so_we_dont_either():
    """上游当前版本已经没有 filter_radius —— 我们也不该暴露这个旋钮（点了没反应的参数比没有更糟）。"""
    src = ''
    for rel in ('infer/vc/pipeline.py', 'infer/vc/modules.py'):
        p = os.path.join(UPSTREAM, rel)
        if os.path.isfile(p):
            src += open(p, encoding='utf-8', errors='ignore').read()
    assert 'filter_radius' not in src, '上游又有 filter_radius 了 → 适配层该跟着补上'
    assert 'filter_radius' not in open(os.path.join(ENGINE, 'engine_svc.py'), encoding='utf-8').read()


# ---------------------------------------------------------------- 我们的切段逻辑
def test_split_points_no_split_when_short():
    import numpy as np
    a = np.zeros(16000 * 10, dtype='float32')           # 10 秒
    assert RVC.split_points(a, 16000, 60) == [0, len(a)]


def test_split_points_splits_at_quiet_place():
    """切点必须落在**低能量**处：前半段有声、后半段安静，切点应落在安静区。"""
    import numpy as np
    sr = 16000
    loud = (np.random.default_rng(0).standard_normal(sr * 30) * 0.5).astype('float32')
    quiet = np.zeros(sr * 30, dtype='float32')
    a = np.concatenate([loud, quiet])
    pts = RVC.split_points(a, sr, 30)
    assert len(pts) >= 3
    assert pts[0] == 0 and pts[-1] == len(a)
    # 唯一那个切点应当落在安静段里（30 秒之后）
    assert pts[1] > sr * 30, '切点落在有声段：接缝会听得出来（%s）' % (pts,)


def test_split_points_covers_everything():
    import numpy as np
    a = (np.random.default_rng(1).standard_normal(16000 * 150) * 0.2).astype('float32')
    pts = RVC.split_points(a, 16000, 30)
    assert pts[0] == 0 and pts[-1] == len(a)
    assert all(pts[i] < pts[i + 1] for i in range(len(pts) - 1)), '切点必须严格递增'


# ---------------------------------------------------------------- 缺权重要如实报
class _Args(object):
    def __init__(self, **kw):
        self.__dict__.update(kw)


def test_convert_without_weights_is_honest(monkeypatch, tmp_path):
    """vendor 就位但目录里没有权重 → 说「没有权重」，不许静默产出一个空 wav。"""
    import engine_svc as ES
    monkeypatch.setattr(ES, 'deps', lambda: {'torch': True, 'soundfile': True, 'faiss': True, 'vendor_rvc': True})
    import soundfile as sf
    import numpy as np
    src = tmp_path / 'in.wav'
    # 真写一份 1 秒 wav：假的 RIFF 字节会让 sf.info 直接抛格式错，测的就不是我们要的路径了
    sf.write(str(src), np.zeros(16000, dtype='float32'), 16000)
    rec = []
    monkeypatch.setattr(ES, 'emit_result', lambda o: rec.append(o))
    monkeypatch.setattr(ES, 'emit_prog', lambda *a, **k: None)
    ES.cmd_convert(_Args(input=str(src), out=str(tmp_path / 'o.wav'), model=str(tmp_path),
                         chunk_sec=60, transpose=0, f0_method='rmvpe', index_rate=0.3,
                         rms_mix_rate=0.25, protect=0.33, device='cpu'))
    assert rec and rec[-1]['ok'] is False
    assert '权重' in rec[-1]['error']
    assert not os.path.exists(str(tmp_path / 'o.wav'))

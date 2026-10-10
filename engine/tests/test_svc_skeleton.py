# -*- coding: utf-8 -*-
"""翻唱变声引擎（engine_svc.py）骨架 —— 先把「诚实」钉死。

钉这些不是为了凑数，是因为这类**环境未就绪**的路径最容易被人顺手写成「假装成功」：

  · 缺 torch / soundfile → 必须明确说「未就绪 + 去装 kind=svc 包」，不许静默返回空结果；
  · 没接 RVC 推理代码 → 必须说「未就位」，不许产出一个全静音的 wav 冒充成品；
  · probe 必须以**权重里真实写着的值**为准（version / f0 / 采样率），因为清单里的
    探测值只是候选 —— 采样率错了整首走调。

依赖用替身（torch / soundfile）：测试不该依赖本机装没装 torch。
"""
import os
import sys
import types

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import engine_svc as ES                                   # noqa: E402


class _Rec:
    """接住 emit_result / emit_prog 的输出（协议是往 stdout 写 ###RESULT）。"""
    def __init__(self):
        self.results = []
        self.progs = []

    def install(self, monkeypatch):
        monkeypatch.setattr(ES, 'emit_result', lambda obj: self.results.append(obj))
        monkeypatch.setattr(ES, 'emit_prog', lambda p, stage='', extra=None: self.progs.append((p, stage)))


def _fake_torch(monkeypatch, cpt=None, raises=None):
    """装一个假 torch：只能 load，够 probe 用。"""
    mod = types.ModuleType('torch')

    def load(path, map_location=None, weights_only=None):
        if raises:
            raise raises
        return cpt if cpt is not None else {}
    mod.load = load
    monkeypatch.setitem(sys.modules, 'torch', mod)
    return mod


def _fake_soundfile(monkeypatch, duration=125.0, samplerate=44100):
    mod = types.ModuleType('soundfile')

    class _Info:
        def __init__(self):
            self.duration = duration
            self.samplerate = samplerate
    mod.info = lambda p: _Info()
    monkeypatch.setitem(sys.modules, 'soundfile', mod)
    return mod


def _deps(monkeypatch, **kw):
    base = {'torch': False, 'faiss': False, 'soundfile': False, 'vendor_rvc': False}
    base.update(kw)
    monkeypatch.setattr(ES, 'deps', lambda: dict(base))
    return base


class _Args:
    def __init__(self, **kw):
        self.__dict__.update(kw)


# ---------------------------------------------------------------- 依赖自检的话术
def test_missing_hint_covers_fatal_only():
    """致命提示里只放「跑不了」的原因；faiss 那种能跑但会降级的，不许混进来当错误。"""
    assert 'kind=svc' in ES.missing_hint({'torch': False, 'soundfile': False, 'faiss': False, 'vendor_rvc': False})
    assert '未就绪' in ES.missing_hint({'torch': False, 'soundfile': True, 'faiss': True, 'vendor_rvc': True})
    # 依赖齐了但推理代码没就位
    assert '未就位' in ES.missing_hint({'torch': True, 'soundfile': True, 'faiss': True, 'vendor_rvc': False})
    # 全都齐 → 没有致命提示
    assert ES.missing_hint({'torch': True, 'soundfile': True, 'faiss': True, 'vendor_rvc': True}) == ''


def test_faiss_missing_is_a_warning_not_a_failure():
    """缺 faiss 只降级（关掉 index 检索），但必须**说出来**，不许静默。"""
    d = {'torch': True, 'soundfile': True, 'faiss': False, 'vendor_rvc': True}
    assert ES.missing_hint(d) == ''                      # 不阻断
    w = ES.dep_warnings(d)
    assert len(w) == 1 and 'faiss' in w[0] and 'index' in w[0]
    assert ES.dep_warnings({'torch': True, 'soundfile': True, 'faiss': True, 'vendor_rvc': True}) == []


# ---------------------------------------------------------------- probe
def test_probe_reads_real_values_from_weights(monkeypatch, tmp_path):
    """采样率 / version / f0 必须来自权重本身，不是清单里的猜测值。"""
    (tmp_path / 'nene_e100.pth').write_bytes(b'x')
    (tmp_path / 'added_IVF7.index').write_bytes(b'x')
    _deps(monkeypatch, torch=True)
    _fake_torch(monkeypatch, cpt={'config': [1, 2, 3, 40000], 'version': 'v2', 'f0': 1})
    rec = _Rec(); rec.install(monkeypatch)
    ES.cmd_probe(_Args(model=str(tmp_path)))
    r = rec.results[-1]
    assert r['ok'] is True
    assert r['sr'] == 40000          # config 末位
    assert r['version'] == 'v2'
    assert r['f0'] is True
    assert r['engine'] == 'rvc'
    assert r['index'].endswith('.index')


def test_probe_old_weights_without_version_key_are_v1(monkeypatch, tmp_path):
    (tmp_path / 'old.pth').write_bytes(b'x')
    _deps(monkeypatch, torch=True)
    _fake_torch(monkeypatch, cpt={'config': [1, 2, 48000], 'f0': 0})
    rec = _Rec(); rec.install(monkeypatch)
    ES.cmd_probe(_Args(model=str(tmp_path)))
    r = rec.results[-1]
    assert r['ok'] is True
    assert r['version'] == 'v1'      # 权重里没有 version 键 → 老版
    assert r['sr'] == 48000
    assert r['f0'] is False


def test_probe_without_torch_is_honest_failure(monkeypatch, tmp_path):
    _deps(monkeypatch, torch=False, soundfile=False)
    rec = _Rec(); rec.install(monkeypatch)
    ES.cmd_probe(_Args(model=str(tmp_path)))
    r = rec.results[-1]
    assert r['ok'] is False
    assert '未就绪' in r['error']


def test_probe_without_weights_says_so(monkeypatch, tmp_path):
    _deps(monkeypatch, torch=True)
    _fake_torch(monkeypatch, cpt={})
    rec = _Rec(); rec.install(monkeypatch)
    ES.cmd_probe(_Args(model=str(tmp_path)))
    r = rec.results[-1]
    assert r['ok'] is False and '.pth' in r['error']


def test_probe_unreadable_weights_reports_error(monkeypatch, tmp_path):
    (tmp_path / 'broken.pth').write_bytes(b'x')
    _deps(monkeypatch, torch=True)
    _fake_torch(monkeypatch, raises=RuntimeError('bad archive'))
    rec = _Rec(); rec.install(monkeypatch)
    ES.cmd_probe(_Args(model=str(tmp_path)))
    r = rec.results[-1]
    assert r['ok'] is False and '读不了权重' in r['error']


def test_probe_weights_without_config_list_is_not_rvc(monkeypatch, tmp_path):
    """权重不是 RVC 存档（没有 config 列表）但目录里有 config.yaml → 多半是 DDSP-SVC。"""
    (tmp_path / 'model.pt').write_bytes(b'x')
    (tmp_path / 'config.yaml').write_text('{}')
    _deps(monkeypatch, torch=True)
    _fake_torch(monkeypatch, cpt={'version': 'v3'})
    rec = _Rec(); rec.install(monkeypatch)
    ES.cmd_probe(_Args(model=str(tmp_path)))
    r = rec.results[-1]
    assert r['ok'] is True and r['engine'] == 'ddsp'


# ---------------------------------------------------------------- convert
def test_convert_without_runtime_is_honest_failure(monkeypatch):
    _deps(monkeypatch, torch=False, soundfile=False)
    rec = _Rec(); rec.install(monkeypatch)
    ES.cmd_convert(_Args(input='x.wav', model='m', out='o.wav', chunk_sec=60))
    r = rec.results[-1]
    assert r['ok'] is False and '未就绪' in r['error']


def test_convert_missing_input_says_so(monkeypatch):
    _deps(monkeypatch, torch=True, soundfile=True)
    _fake_soundfile(monkeypatch)
    rec = _Rec(); rec.install(monkeypatch)
    ES.cmd_convert(_Args(input='no-such-file.wav', model='m', out='o.wav', chunk_sec=60))
    r = rec.results[-1]
    assert r['ok'] is False and '输入音频不存在' in r['error']


def test_convert_plans_chunks_but_refuses_without_vendor(monkeypatch, tmp_path):
    """骨架阶段：分块与进度都跑通了，但推理没接 —— 必须说「未就位」，不许产出假 wav。"""
    src = tmp_path / 'voc.wav'
    src.write_bytes(b'RIFF')
    _deps(monkeypatch, torch=True, soundfile=True, vendor_rvc=False)
    _fake_soundfile(monkeypatch, duration=125.0)
    rec = _Rec(); rec.install(monkeypatch)
    ES.cmd_convert(_Args(input=str(src), model='m', out=str(tmp_path / 'o.wav'), chunk_sec=60))
    r = rec.results[-1]
    assert r['ok'] is False
    assert '未就位' in r['error']
    # 125 秒 / 60 秒 → 3 块
    assert r['planned']['parts'] == 3
    assert r['planned']['chunk_sec'] == 60.0
    assert not os.path.exists(str(tmp_path / 'o.wav'))     # 绝不留一个假成品
    # 进度确实发过（分块阶段）
    assert any(stage == '分块' for _p, stage in rec.progs)

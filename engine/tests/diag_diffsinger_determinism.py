# -*- coding: utf-8 -*-
"""诊断：DiffSinger 渲染在哪一个阶段开始"每次都不一样"。

## 为什么需要它
DiffSinger 的 v2 流水线由多段 ONNX 组成（linguistic → dur → variance → pitch → acoustic → vocoder），
**整条链逐位不可复现**。直接比 WAV 只会看到"结果不同"，无法判断是哪个模型的问题。
本工具给所有 `run_*` 阶段挂 spy，打印每阶段的「输入指纹 / 输出指纹」——
**跨进程跑两次、diff 输出，第一个 out= 不同的阶段就是分歧源头。**

已知结论（2026-10-01 实测）：源头是 `run_variance`（方差预测）。
同进程内两次渲染逐位一致，跨进程才不一致；已排除 PYTHONHASHSEED、模型内随机算子、
线程数（intra/inter=1 + ORT_SEQUENTIAL）、图优化（DISABLE_ALL / ENABLE_BASIC）、
以及**扩散步数**（`steps=1` 仍逐次不同）—— 所以不是"多步扩散放大"，
而是前向计算本身的浮点差异就足够大。判定为 ORT CPU EP 的浮点非确定性
（疑为 MLAS 按指针对齐选 kernel，ASLR 使每进程不同）。**在本层无法修复。**
换 GPU 也不解决：CUDA/cuDNN 默认用原子归约 + 算法自动选择，本就不保证可复现；
且内置 onnxruntime 只有 CPU EP，本机无从验证。

## 用法
    # 需要真实声库（含 dsdur/dspitch/dsvariance/dsvocoder 全套 onnx）
    python engine/tests/diag_diffsinger_determinism.py <voicebank_dir> > a.txt
    python engine/tests/diag_diffsinger_determinism.py <voicebank_dir> > b.txt
    diff a.txt b.txt        # 第一个 out= 不同的阶段就是源头

不传声库参数时，会自动在几个常见位置找一个（找不到就提示并退出）。
"""

import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)
os.chdir(ENGINE)

import engine_diffsinger as ed  # noqa: E402

NOTES = json.dumps([{"startBeat": 0, "durBeat": 1, "pitch": 60, "lyric": "la"},
                    {"startBeat": 1, "durBeat": 1, "pitch": 62, "lyric": "la"}])

_CANDIDATE_ROOTS = [
    os.environ.get('FUFUMIDI_E2E_VB_ROOT') or '',
    r'D:\FuFuMIDI\FuFumidi\release-unpacked\win-unpacked\FuFumidiData\diffsinger-voicebanks',
    r'D:\FuFuMIDI\FuFumidi\FuFumidiData\diffsinger-voicebanks',
]


def find_voicebank():
    for root in _CANDIDATE_ROOTS:
        if not root or not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            if os.path.isfile(os.path.join(d, 'dsconfig.yaml')):
                return d
    return None


def dig(x):
    """指纹只描述数值内容；不可识别对象（如 ORT session）返回类型名，避免内存地址噪声。"""
    if isinstance(x, np.ndarray):
        a = np.ascontiguousarray(x)
        return '%s|%s' % (a.shape, hashlib.sha1(a.tobytes()).hexdigest()[:12])
    if isinstance(x, (list, tuple)):
        return '[' + ','.join(dig(v) for v in x) + ']'
    if isinstance(x, dict):
        return '{' + ','.join('%s:%s' % (k, dig(v)) for k, v in sorted(x.items())) + '}'
    if isinstance(x, (int, str, bool, type(None))):
        return repr(x)
    if isinstance(x, float):
        return '%.9g' % x
    return '<%s>' % type(x).__name__


def snap(x):
    if isinstance(x, np.ndarray):
        return x.copy()
    if isinstance(x, (list, tuple)):
        return [snap(v) for v in x]
    if isinstance(x, dict):
        return {k: snap(v) for k, v in x.items()}
    return x


def main():
    vb = sys.argv[1] if len(sys.argv) > 1 else find_voicebank()
    if not vb or not os.path.isdir(vb):
        print('找不到真实 DiffSinger 声库。用法：')
        print('  python engine/tests/diag_diffsinger_determinism.py <voicebank_dir>')
        return 2

    trace = []
    names = sorted(n for n in dir(ed) if n.startswith('run_') and callable(getattr(ed, n)))
    for n in names:
        _orig = getattr(ed, n)

        def make(_o=_orig, _n=n):
            def wrapper(*a, **k):
                ia, ik = snap(a), snap(k)
                out = _o(*a, **k)
                trace.append((_n, dig(ia) + '|' + dig(ik), dig(snap(out))))
                return out
            return wrapper

        setattr(ed, n, make())

    print('VOICEBANK %s' % os.path.basename(vb))
    print('SPIED %s' % ','.join(names))
    ed.render_phrase({'voicebank': vb, 'notes': NOTES, 'bpm': 120.0, 'device': 'cpu', 'out': ''})
    for i, (n, di, do) in enumerate(trace):
        print('STAGE %02d %-18s in=%-64s out=%s' % (i, n, di[:64], do))
    return 0


if __name__ == '__main__':
    sys.exit(main())

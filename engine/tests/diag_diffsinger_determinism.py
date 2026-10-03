# -*- coding: utf-8 -*-
"""诊断：DiffSinger 渲染在哪一个阶段开始"每次都不一样"。

## 为什么需要它
DiffSinger 的 v2 流水线由多段 ONNX 组成（linguistic → dur → variance → pitch → acoustic → vocoder），
**整条链逐位不可复现**。直接比 WAV 只会看到"结果不同"，无法判断是哪个模型的问题。
本工具给所有 `run_*` 阶段挂 spy，打印每阶段的「输入指纹 / 输出指纹」——
**跨进程跑两次、diff 输出，第一个 out= 不同的阶段就是分歧源头。**

已知结论（2026-10-01 实测）：源头是**旧实现**的方差预测阶段。
★ 2026-10-03 起管线已重写为与上游 OpenUtau 对齐的版本（`diffsinger/` 包），
  旧的自造「v2 五段式」（含 run_variance / run_dur / run_pitch_stage）已删除；
  渲染不再经过任何时长/音高模型（f0 只来自谱面曲线）。本脚本仅用于检查
  **同一份音符两次渲染的确定性**，对声库/模型版本无假设。
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
    # ★ 2026-10-03：旧的 `run_dur` / `run_pitch_stage` / `run_variance` /
    #   `run_acoustic_v2` 已随自造五段式一起删除，`names` 会变成空列表。
    #   改为盯 `diffsinger.session.run_session` —— 它是**每一次 ONNX 调用**的唯一入口，
    #   因此与管线版本无关、粒度更细（dsdur linguistic / dsdur / dsvariance / acoustic /
    #   vocoder / dspitch 各一次），且同样能看出输入输出是否逐次一致。
    # ★ 猴补丁要打在**真正持有该函数**的模块上（`engine_diffsinger` 只是转发门面），
    #   但 `render_phrase` 仍要从门面调 —— 所以分成两个变量。
    import diffsinger.session as _sess
    target, names = _sess, ['run_session']
    for n in names:
        _orig = getattr(target, n)

        def make(_o=_orig, _n=n):
            def wrapper(*a, **k):
                ia, ik = snap(a), snap(k)
                out = _o(*a, **k)
                trace.append((_n, dig(ia) + '|' + dig(ik), dig(snap(out))))
                return out
            return wrapper

        setattr(target, n, make())

    print('VOICEBANK %s' % os.path.basename(vb))
    print('SPIED %s' % ','.join(names))
    ed.render_phrase({'voicebank': vb, 'notes': NOTES, 'bpm': 120.0, 'device': 'cpu', 'out': ''})
    for i, (n, di, do) in enumerate(trace):
        print('STAGE %02d %-18s in=%-64s out=%s' % (i, n, di[:64], do))
    same = sum(1 for _, di, do in trace if di == do)
    print()
    print('ONNX 调用 %d 次；其中输入摘要==输出摘要的 %d 次' % (len(trace), same))
    print('★ 判定：同一份音符**连续两次**渲染的每个模型输入摘要应完全一致；')
    print('  波形本身因声码器激励相位不同而不可逐样本比较（既有结论，见文件头）。')
    if len(trace) <= 2:
        print()
        print('⚠ 只追到 %d 次调用 —— 因为 `run_session` 只是 A 层（dsdur）的入口；' % len(trace))
        print('  B 层（dsvariance / acoustic / vocoder）在 renderer.py 里是直接')
        print('  `make_session` + `session.run`，不走这个包装。要覆盖全链路，')
        print('  需要在 `diffsinger.session.make_session` 上打补丁。')
    return 0


if __name__ == '__main__':
    sys.exit(main())

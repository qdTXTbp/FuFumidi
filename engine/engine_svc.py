# -*- coding: utf-8 -*-
"""翻唱音色引擎（SVC）：把一段人声换成目标音色。

    python engine_svc.py probe   --model <模型目录>
    python engine_svc.py convert <输入.wav> --model <模型目录> --out <输出.wav> [参数]

分工：
  probe    读权重，把**真实**的 version / f0 / 采样率说出来（回写 model.json）
  convert  整轨变声：分块 → 编码 → f0 → 检索 → 合成 → 拼接

★ 本文件是**骨架**：协议、参数、分块、断点与依赖自检都已就位；
  真正的 RVC 推理照搬上游（engine/svc/vendor/rvc/，MIT），没就位时**如实报错**，
  绝不为了「看起来能跑」而假装成功 —— 返回 ok:false + 退出码 0（与全引擎一致）。

★ 探测值只是候选：权重里真正写着什么只有加载才知道，所以 probe 永远以权重为准。
"""
import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

VENDOR_RVC = os.path.join(_HERE, 'svc', 'vendor', 'rvc')


def emit_prog(percent, stage='', extra=None):
    d = {'percent': round(float(percent), 1)}
    if stage:
        d['stage'] = stage
    if extra:
        d.update(extra)
    sys.stdout.write('###PROG ' + json.dumps(d, ensure_ascii=False) + chr(10))
    sys.stdout.flush()


def emit_result(obj):
    sys.stdout.write('###RESULT ' + json.dumps(obj, ensure_ascii=False) + chr(10))
    sys.stdout.flush()


def deps():
    """推理依赖自检：缺什么说清楚（不静默降级、不假装能用）。"""
    out = {'torch': False, 'faiss': False, 'soundfile': False, 'vendor_rvc': os.path.isdir(VENDOR_RVC)}
    try:
        import torch  # noqa: F401
        out['torch'] = True
    except Exception as e:      # noqa: BLE001
        out['torch_error'] = str(e)[:120]
    try:
        import faiss  # noqa: F401
        out['faiss'] = True
    except Exception as e:      # noqa: BLE001
        out['faiss_error'] = str(e)[:120]
    try:
        import soundfile  # noqa: F401
        out['soundfile'] = True
    except Exception as e:      # noqa: BLE001
        out['soundfile_error'] = str(e)[:120]
    return out


def missing_hint(d):
    """**致命**依赖缺什么 → 一句人话（界面直接显示）。不致命的一律不进这里。"""
    miss = []
    if not d.get('torch'):
        miss.append('torch')
    if not d.get('soundfile'):
        miss.append('soundfile')
    if miss:
        return 'SVC 推理环境未就绪：缺 %s。请在「加速包」里安装 SVC 推理包（kind=svc）。' % '、'.join(miss)
    if not d.get('vendor_rvc'):
        return 'RVC 推理代码未就位（engine/svc/vendor/rvc）：本轮先做骨架，尚未接入实际推理。'
    return ''


def dep_warnings(d):
    """**不致命**的降级：能跑，但必须如实说出来（不许静默）。"""
    w = []
    if d.get('torch') and not d.get('faiss'):
        w.append('faiss 不可用：index 检索会关闭（只按模型合成），音色相似度会差一些。')
    return w


def find_weights(model_dir):
    """在模型目录里找权重 / index（文件名不写死：社区命名五花八门）。

    ★ RVC 权是 `.pth`，DDSP-SVC 是 `.pt` —— 两种都得认（只认 .pth 会把 DDSP 判成「没有权重」）。
    """
    pth, pt, index, cfg = '', '', '', ''
    for root, _dirs, files in os.walk(model_dir):
        for f in sorted(files):
            low = f.lower()
            fp = os.path.join(root, f)
            if low.endswith('.pth') and not pth:
                pth = fp
            elif low.endswith('.pt') and not pt:
                pt = fp
            elif low.endswith('.index') and not index:
                index = fp
            elif low.endswith(('.yaml', '.yml')) and not cfg:
                cfg = fp
    return (pth or pt), index, cfg


def cmd_probe(a):
    """读权重，把真实的 version / f0 / 采样率说出来。

    RVC 权重（.pth）是一个 torch 存档：config 列表末位是目标采样率，
    'version' / 'f0' 两个键在新版权重里直接有（老版按 v1 + 有 f0 处理）。
    """
    d = deps()
    if not d.get('torch'):
        emit_result({'ok': False, 'error': missing_hint(d), 'deps': d})
        return 0
    import torch
    pth, index, cfg = find_weights(a.model)
    if not pth:
        emit_result({'ok': False, 'error': '模型目录里没有 .pth 权重：%s' % a.model})
        return 0
    try:
        cpt = torch.load(pth, map_location='cpu', weights_only=False)
    except TypeError:           # 老 torch 不认 weights_only
        cpt = torch.load(pth, map_location='cpu')
    except Exception as e:      # noqa: BLE001
        emit_result({'ok': False, 'error': '读不了权重（%s）：%s' % (os.path.basename(pth), str(e)[:200])})
        return 0
    cfg_list = cpt.get('config') or []
    # ★ 采样率在 config 末位；老版权重可能没有 version 键 → 按 v1
    sr = int(cfg_list[-1]) if cfg_list else 0
    version = str(cpt.get('version') or ('v1' if 'version' not in cpt else ''))
    f0 = int(cpt.get('f0', 1))
    engine = 'rvc'
    if not cfg_list and cfg:
        # 有 config.yaml 但权重不是 RVC 存档 → 多半是 DDSP-SVC（本轮不接）
        engine = 'ddsp'
    emit_result({'ok': True, 'engine': engine, 'version': version, 'f0': bool(f0), 'sr': sr,
                 'weights': os.path.relpath(pth, a.model), 'index': os.path.relpath(index, a.model) if index else '',
                 'deps': d, 'warnings': dep_warnings(d)})
    return 0


def cmd_convert(a):
    """整轨变声：读音频 → 加载模型/HuBERT → 分段合成 → 写出。

    推理全部走 `svc/rvc.py` → vendor 的上游代码；这里只负责协议、进度与**如实报错**。
    """
    d = deps()
    hint = missing_hint(d)
    if not d.get('torch') or not d.get('soundfile'):
        emit_result({'ok': False, 'error': hint, 'deps': d})
        return 0
    import soundfile as sf
    if not os.path.isfile(a.input):
        emit_result({'ok': False, 'error': '输入音频不存在：%s' % a.input})
        return 0
    info = sf.info(a.input)
    total = float(info.duration or 0)
    emit_prog(2, '准备', {'seconds': round(total, 1), 'sr': info.samplerate})
    chunk = max(5.0, float(a.chunk_sec or 60))
    n = max(1, int(total / chunk) + (1 if total % chunk else 0))
    emit_prog(5, '分块', {'parts': n, 'chunk_sec': chunk})
    if not d.get('vendor_rvc'):
        # 推理代码没就位 —— 说清楚，别装成功（不能拿 faiss 那类降级提示顶替）
        emit_result({'ok': False, 'error': 'RVC 推理代码未就位（engine/svc/vendor/rvc）：请先同步上游 vendor 代码。',
                     'deps': d, 'warnings': dep_warnings(d),
                     'planned': {'parts': n, 'chunk_sec': chunk, 'seconds': round(total, 1)}})
        return 0
    model_dir = a.model
    pth, index, _cfg = find_weights(model_dir)
    if not pth:
        emit_result({'ok': False, 'error': '模型目录里没有权重（.pth / .pt）：%s' % model_dir})
        return 0
    try:
        import svc.rvc as RVC
    except Exception as e:                               # noqa: BLE001
        emit_result({'ok': False, 'error': '加载 RVC 推理适配层失败：%s' % str(e)[:200], 'deps': d})
        return 0
    try:
        res = RVC.convert(a.input, a.out, pth, index_path=index,
                          transpose=int(a.transpose or 0), f0_method=str(a.f0_method or 'rmvpe'),
                          index_rate=float(a.index_rate), rms_mix_rate=float(a.rms_mix_rate),
                          protect=float(a.protect), chunk_sec=chunk, device=str(a.device or 'auto'),
                          log=lambda s: emit_prog(-1, '', {'log': str(s)}),
                          on_progress=lambda pct, stage: emit_prog(pct, stage))
    except Exception as e:                               # noqa: BLE001
        emit_result({'ok': False, 'error': '变声失败：%s' % str(e)[:400], 'deps': d})
        return 0
    if not os.path.isfile(a.out):
        emit_result({'ok': False, 'error': '变声没有产出文件（%s）' % a.out})
        return 0
    res.update({'warnings': dep_warnings(d), 'planned_parts': n})
    emit_prog(100, '完成')
    emit_result(res)
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('probe')
    p.add_argument('--model', required=True, help='模型目录')

    c = sub.add_parser('convert')
    c.add_argument('input')
    c.add_argument('--model', required=True)
    c.add_argument('--out', required=True)
    c.add_argument('--transpose', type=int, default=0)
    c.add_argument('--f0-method', default='rmvpe')
    c.add_argument('--index-rate', type=float, default=0.3)
    c.add_argument('--rms-mix-rate', type=float, default=0.25)
    c.add_argument('--protect', type=float, default=0.33)
    c.add_argument('--chunk-sec', type=float, default=60)
    c.add_argument('--auto-predict-f0', action='store_true')
    c.add_argument('--device', default='auto')
    a = ap.parse_args()

    try:
        if a.cmd == 'probe':
            return cmd_probe(a)
        return cmd_convert(a)
    except Exception as e:      # noqa: BLE001
        emit_result({'ok': False, 'error': str(e)})
        return 0


if __name__ == '__main__':
    sys.exit(main())

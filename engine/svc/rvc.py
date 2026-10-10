# -*- coding: utf-8 -*-
"""RVC 推理适配层（**薄胶水**）—— DSP 与模型全部走 vendor 的上游代码。

    vendor = engine/svc/vendor/rvc/（RVC-Project 上游，MIT，**一行未改**）

这个文件只做三件上游没做的事：
  1. 把界面/引擎的参数翻译成上游 `pipeline.pipeline(...)` 的入参；
  2. 长音频按**低能量点**切段（思路照搬上游 `Pipeline.pipeline` 里 opt_ts 的做法），避免整首一次性进出显存；
  3. 用 soundfile 做音频 IO（上游 infer/audio.py 依赖 ffmpeg + PyAV，不搬）。

★ 照搬原则：模型构造、版本判定、f0、检索、合成一律用上游实现，**不自研**。
  上游没有的参数（例如老版的 filter_radius）这里也不提供 —— 给一个点了没反应的旋钮更糟。
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_VENDOR = os.path.join(_HERE, 'vendor', 'rvc')
if _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)

#: 上游 Config.device_config() 的取值（configs/config.py）：fp16 一套、fp32 一套、≤4G 显存一套
_PAD_TABLE = {
    'half': (3, 10, 60, 65),
    'full': (1, 6, 38, 41),
    'small': (1, 5, 30, 32),
}


class Config(object):
    """上游 `configs.Config` 里**推理真正用到的那几个字段**（其余是 WebUI 的）。"""

    def __init__(self, device, is_half=False, gpu_mem=None):
        self.device = device
        self.is_half = is_half
        if gpu_mem is not None and gpu_mem <= 4:
            self.x_pad, self.x_query, self.x_center, self.x_max = _PAD_TABLE['small']
        else:
            self.x_pad, self.x_query, self.x_center, self.x_max = (
                _PAD_TABLE['half'] if is_half else _PAD_TABLE['full'])


def pick_device(prefer='auto'):
    """选设备：CUDA 可用就用（并按上游规则决定 fp16）；否则 CPU + fp32。"""
    import torch
    if prefer in ('cuda', 'auto'):
        if torch.cuda.is_available():
            mem_gb = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3) + 0.4
            major, minor = torch.cuda.get_device_capability(0)
            sm = major + minor / 10.0
            # 上游规则：<4G 或 SM<5.3 不用；SM 6.1（Pascal）与 GTX16 系列强制 fp32
            if mem_gb >= 4 and sm >= 5.3:
                is_half = not (sm == 6.1)
                return torch.device('cuda:0'), is_half, mem_gb
    return torch.device('cpu'), False, 0.0


def hubert_dir():
    """HuBERT/ContentVec 权重目录（随 kind=svc 包装，公共组件而不是角色权重）。"""
    return os.environ.get('FUFUMIDI_SVC_HUBERT') or os.path.join(_VENDOR, 'assets', 'hubert_base')


def rmvpe_dir():
    """rmvpe 权重所在目录（上游 `Pipeline.get_f0` 读的是环境变量 rmvpe_root）。"""
    return os.environ.get('FUFUMIDI_SVC_RMVPE') or os.environ.get('rmvpe_root') or os.path.join(_VENDOR, 'assets')


def load_hubert(device, is_half=False, log=print):
    """加载 HuBERT：走上游 `infer/hubert.py` 的加载器（transformers 版，不依赖 fairseq）。

    ★ 上游把路径写死成 `<vendor>/assets/hubert_base`；包的权重装在别处时用环境变量指过去
      —— 只改**指向**，不改上游一行代码。
    """
    import infer.hubert as H
    d = hubert_dir()
    if os.path.isdir(d):
        from pathlib import Path
        H.HUBERT_MODEL_PATH = Path(d).resolve()      # 仅指向，不改写上游逻辑
    if not os.path.isfile(os.path.join(str(H.HUBERT_MODEL_PATH), 'config.json')):
        raise RuntimeError(
            '缺少 HuBERT/ContentVec 权重：%s（请安装 SVC 推理包，或用 FUFUMIDI_SVC_HUBERT 指向它）'
            % H.HUBERT_MODEL_PATH)
    log('加载 HuBERT：%s' % H.HUBERT_MODEL_PATH)
    return H.load_hubert_model(device, is_half)


def synth_table():
    """(version, if_f0) → 合成器类 —— **照搬上游** `infer/vc/modules.py::get_vc` 里的映射。"""
    from infer.module.models import (
        SynthesizerTrnMs256NSFsid, SynthesizerTrnMs256NSFsid_nono,
        SynthesizerTrnMs768NSFsid, SynthesizerTrnMs768NSFsid_nono,
    )
    return {
        ('v1', 1): SynthesizerTrnMs256NSFsid,
        ('v1', 0): SynthesizerTrnMs256NSFsid_nono,
        ('v2', 1): SynthesizerTrnMs768NSFsid,
        ('v2', 0): SynthesizerTrnMs768NSFsid_nono,
    }


def load_net_g(model_path, device, is_half=False, log=print):
    """加载角色权重 —— 逻辑**逐行照搬**上游 `infer/vc/modules.py::get_vc`：

        tgt_sr = cpt["config"][-1]
        cpt["config"][-3] = cpt["weight"]["emb_g.weight"].shape[0]   # n_spk 以权重为准
        version = cpt.get("version", "v1")；if_f0 = cpt.get("f0", 1)
        (v1,1)→Ms256 (v1,0)→Ms256_nono (v2,1)→Ms768 (v2,0)→Ms768_nono
        del net_g.enc_q → load_state_dict(strict=False) → eval → half/float
    """
    import torch
    cpt = torch.load(model_path, map_location='cpu')
    tgt_sr = cpt['config'][-1]
    # ★ n_spk 以权重里 emb_g 的实际行数为准（上游就是这么回填 config[-3] 的）
    cpt['config'][-3] = cpt['weight']['emb_g.weight'].shape[0]
    if_f0 = cpt.get('f0', 1)
    version = cpt.get('version', 'v1')
    table = synth_table()
    cls = table.get((version, if_f0), table[('v1', 1)])
    net_g = cls(*cpt['config'], is_half=is_half)
    del net_g.enc_q
    net_g.load_state_dict(cpt['weight'], strict=False)
    net_g.eval().to(device)
    net_g = net_g.half() if is_half else net_g.float()
    log('模型：%s · %s · f0=%s · %s Hz（%s）'
        % (os.path.basename(model_path), version, if_f0, tgt_sr, 'fp16' if is_half else 'fp32'))
    return net_g, cpt, tgt_sr, version, if_f0


def split_points(audio, sr, chunk_sec):
    """长音频的切段点（样本下标）—— **思路照搬上游**：在目标点附近找**能量最低**的位置切，
    接缝落在安静处，听不出来（上游 `Pipeline.pipeline` 里 opt_ts 就是这么选的）。

    返回 [0, …, len(audio)]；不切时返回 [0, len(audio)]。
    """
    n = len(audio)
    target = int(float(chunk_sec) * sr)
    if target <= 0 or n <= target * 1.2:
        return [0, n]
    win = int(0.5 * sr)                     # 在目标点前后半秒内找最安静的一帧
    pts = [0]
    t = target
    while t < n - target * 0.5:
        lo, hi = max(0, t - win), min(n, t + win)
        seg = np.abs(audio[lo:hi])
        if len(seg):
            # 用短时能量而不是逐样本绝对值：躲开单个零交叉那种假平静
            step = max(1, len(seg) // 512)
            energy = np.convolve(seg, np.ones(step) / step, mode='same')
            t = lo + int(np.argmin(energy))
        pts.append(int(t))
        t += target
    pts.append(n)
    return sorted(set(pts))


def convert(in_wav, out_wav, model_path, index_path='', transpose=0, f0_method='rmvpe',
            index_rate=0.3, rms_mix_rate=0.25, protect=0.33, chunk_sec=60,
            device='auto', log=print, on_progress=None):
    """整轨变声：读音频 → 加载模型/HuBERT → 分段合成 → 写出。

    参数与上游 `pipeline.pipeline(...)` 一一对应；`chunk_sec<=0` 表示不切段（交给上游自己切片）。
    """
    import soundfile as sf
    import librosa
    from infer.vc.pipeline import Pipeline

    def prog(pct, stage):
        if on_progress:
            on_progress(pct, stage)

    dev, is_half, mem_gb = pick_device(device)
    log('设备：%s（fp16=%s%s）' % (dev, is_half, ('，显存 %.1fGB' % mem_gb) if mem_gb else ''))
    prog(5, '加载模型')
    net_g, cpt, tgt_sr, version, if_f0 = load_net_g(model_path, dev, is_half, log=log)
    hubert = load_hubert(dev, is_half, log=log)
    cfg = Config(dev, is_half, gpu_mem=mem_gb or None)
    pipeline = Pipeline(tgt_sr, cfg)
    # ★ 上游 `Pipeline.get_f0` 用环境变量 rmvpe_root 找 rmvpe.pt —— 这是它的契约，照做
    if f0_method == 'rmvpe':
        os.environ['rmvpe_root'] = rmvpe_dir()

    prog(12, '读取音频')
    y, sr = sf.read(in_wav, always_2d=True)
    audio = y.mean(axis=1).astype('float32')
    if sr != 16000:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000).astype('float32')

    pts = split_points(audio, 16000, chunk_sec)
    parts = []
    sid = 0
    for i in range(len(pts) - 1):
        seg = audio[pts[i]:pts[i + 1]]
        if len(seg) < 1600:                 # 短到不足 0.1 秒的尾巴，直接跳过
            continue
        times = [0, 0, 0]
        out = pipeline.pipeline(
            hubert, net_g, sid, seg, times, int(transpose), f0_method,
            index_path if index_path and os.path.exists(index_path) else '',
            float(index_rate), int(if_f0), int(tgt_sr), 0, float(rms_mix_rate),
            version, float(protect),
        )
        parts.append(np.asarray(out, dtype='float32'))
        prog(12 + 80.0 * (i + 1) / max(1, len(pts) - 1), '合成', )
    if not parts:
        raise RuntimeError('没有可合成的音频段')
    prog(94, '写出')
    merged = np.concatenate(parts)
    # 上游返回 int16 幅度（见 Pipeline.pipeline 末尾的 max_int16 缩放），写盘前归一回 float
    if np.issubdtype(merged.dtype, np.integer):
        merged = merged.astype('float32') / 32768.0
    sf.write(out_wav, merged, int(tgt_sr))
    return {'ok': True, 'out': out_wav, 'sr': int(tgt_sr), 'seconds': round(len(merged) / float(tgt_sr), 2),
            'version': version, 'if_f0': int(if_f0), 'parts': len(parts), 'device': str(dev), 'fp16': is_half}

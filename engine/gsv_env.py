# -*- coding: utf-8 -*-
"""GPT-SoVITS 运行环境 —— 定位、装配、就绪检查。

## 为什么需要这个文件

GPT-SoVITS **不是**一个 pip 包：它是一份代码 + 一组预训练基础模型
（chinese-roberta-wwm-ext-large 621MB / chinese-hubert-base 180MB / s1bert / s2G…），
而且 `TTS_Config` 的默认配置里全是**相对 CWD 的路径**：

.. code-block:: python

    configs_base_path = "GPT_SoVITS/configs/"        # 相对当前工作目录！
    self.configs = configs_.get("custom", configs_["v2"])

★ 两个实测踩过的坑（都在这里一次性解决）：

1. **传参必须包在 `"custom"` 里**。`TTS_Config({...})` 是把你的键 update 到
   `default_configs` 的**顶层**（那里只有 v1/v2/v3/v4… 几个版本段），随后取的是
   `configs_.get("custom", configs_["v2"])` —— 顶层没有 `custom` 就直接落到 **v2 默认段**，
   你传的权重路径**全部被丢掉**（日志里表现为一片 "fall back to default …"）。
2. 默认权重路径与 `GPT_SoVITS/configs/` 都是**相对路径** → 不 chdir 到仓库根就
   `FileNotFoundError: GPT_SoVITS/pretrained_models/…`。
   本文件两条都做：既 chdir，又把四个路径替换成**绝对路径**。

## 运行时从哪来

按优先级找（见 `find_runtime`）：

1. 环境变量 `FUFUMIDI_GSV_ROOT` / `FUFUMIDI_GSV_PYTHON`
2. `<数据根>/gpt-sovits/runtime/`（资源中心安装的运行时；`python/` 下可放自带解释器）
3. `<数据根>/gpt-sovits/runtime.json` —— `{"root": "...", "python": "..."}`

## 音色（声库）目录

一个音色 = GPT 权重 + SoVITS 权重 + 一段参考音：

.. code-block:: text

    <数据根>/gpt-sovits/voices/<id>/
        gpt.ckpt      语义/韵律权重
        sovits.pth    音色权重
        ref.wav       参考音（推理时决定语调/情感）

文件名不写死：`find_weights` 按 `.ckpt` / `.pth` 归类（社区包常见
`芙宁娜-e10.ckpt` / `芙宁娜_e25_s1625.pth` 这种命名）。
"""

import json
import os
import sys
from typing import Dict, List, Optional, Tuple

#: GPT-SoVITS 支持的版本段（对齐 `TTS_Config.default_configs`）
VERSIONS = ('v1', 'v2', 'v3', 'v4', 'v2Pro', 'v2ProPlus')

#: 基础模型（相对运行时根）—— 缺任何一个都跑不起来
BASE_MODELS = {
    'bert': os.path.join('GPT_SoVITS', 'pretrained_models', 'chinese-roberta-wwm-ext-large'),
    'hubert': os.path.join('GPT_SoVITS', 'pretrained_models', 'chinese-hubert-base'),
}


def data_root() -> str:
    """数据根（`…/FuFumidiData`）：优先 `FUFUMIDI_DATA_DIR`，否则由 `FUFUMIDI_MODELS_DIR` 推。"""
    env = os.environ.get('FUFUMIDI_DATA_DIR')
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    models = os.environ.get('FUFUMIDI_MODELS_DIR') or ''
    if models:
        return os.path.abspath(os.path.dirname(models.rstrip('\\/')))
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, '..'))


def voices_root() -> str:
    """音色根目录 —— 与 `main/gpt-sovits.js` 的 `voicesRoot(modelsRoot)` **同一处**：
    `dest = 'gpt-sovits/voices/<id>'` 是相对 **模型目录** 的，所以实际落点是
    `<模型目录>/gpt-sovits/voices/<id>`（实测：gsv_nene 在 `…/models/gpt-sovits/voices/`）。
    """
    models = os.environ.get('FUFUMIDI_MODELS_DIR') or ''
    cands = []
    if models:
        cands.append(os.path.join(models, 'gpt-sovits', 'voices'))
    cands.append(os.path.join(data_root(), 'models', 'gpt-sovits', 'voices'))
    cands.append(os.path.join(data_root(), 'gpt-sovits', 'voices'))
    for c in cands:
        if os.path.isdir(c):
            return os.path.abspath(c)
    return os.path.abspath(cands[0])


def _looks_like_runtime(path: str) -> bool:
    """运行时根：有 `GPT_SoVITS/TTS_infer_pack/TTS.py` 才算。"""
    return bool(path) and os.path.isfile(
        os.path.join(path, 'GPT_SoVITS', 'TTS_infer_pack', 'TTS.py'))


def find_runtime(explicit: str = '') -> str:
    """按优先级定位 GPT-SoVITS 运行时根；找不到返回 ''。"""
    cands: List[str] = []
    if explicit:
        cands.append(explicit)
    for key in ('FUFUMIDI_GSV_ROOT', 'GSV_ROOT'):
        v = os.environ.get(key)
        if v:
            cands.append(v)
    cands.append(os.path.join(data_root(), 'gpt-sovits', 'runtime'))
    for c in cands:
        if _looks_like_runtime(c):
            return os.path.abspath(c)
    # runtime.json（资源中心 / 用户手写）
    cfg = os.path.join(data_root(), 'gpt-sovits', 'runtime.json')
    try:
        with open(cfg, encoding='utf-8') as f:
            d = json.load(f)
        c = (d or {}).get('root') or ''
        if _looks_like_runtime(c):
            return os.path.abspath(c)
    except (OSError, ValueError):
        pass
    return ''


def find_python(explicit: str = '', root: str = '') -> str:
    """能跑 GPT-SoVITS 的解释器：显式 > 环境变量 > `<root>/python/python.exe` > 当前解释器。

    ★ 本机实测：应用自带的 `resources/python` 没有 torch/transformers，
      GPT-SoVITS 必须用它自己那套 conda 环境（`FUFUMIDI_GSV_PYTHON` 指过去）。
    """
    cands = [explicit, os.environ.get('FUFUMIDI_GSV_PYTHON') or '']
    if root:
        cands += [os.path.join(root, 'python', 'python.exe'),
                  os.path.join(root, 'python', 'python')]
        cfg = os.path.join(data_root(), 'gpt-sovits', 'runtime.json')
        try:
            with open(cfg, encoding='utf-8') as f:
                cands.append((json.load(f) or {}).get('python') or '')
        except (OSError, ValueError):
            pass
    for c in cands:
        if c and os.path.isfile(c):
            return os.path.abspath(c)
    return os.path.abspath(sys.executable)


def bootstrap(root: str = '', chdir: bool = True) -> str:
    """把当前进程装配成「能 import GPT-SoVITS」的状态，返回运行时根。

    · `sys.path` 加仓库根、`GPT_SoVITS`、`eres2net`、`tools`（实测缺一不可）
    · 补 `USERNAME`/`USERPROFILE` —— GPT-SoVITS 的 `getpass.getuser()` 在
      没有 `USERNAME` 的进程里会去 import `pwd`（Windows 上没有）→ AttributeError
    · chdir 到仓库根（默认配置里的相对路径按 CWD 解析）
    """
    root = find_runtime(root)
    if not root:
        raise RuntimeError(
            '找不到 GPT-SoVITS 运行时。请安装「GPT-SoVITS 运行时」资源包，'
            '或把已有的 GPT-SoVITS 目录写进 <数据根>/gpt-sovits/runtime.json，'
            '或设置环境变量 FUFUMIDI_GSV_ROOT。')
    for rel in ('', 'GPT_SoVITS', os.path.join('GPT_SoVITS', 'eres2net'),
                'tools', os.path.join('tools', 'asr')):
        p = os.path.join(root, rel) if rel else root
        if os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)
    os.environ.setdefault('USERNAME', os.environ.get('USER') or 'fufumidi')
    os.environ.setdefault('USER', os.environ.get('USERNAME') or 'fufumidi')
    if not os.environ.get('USERPROFILE'):
        home = os.path.expanduser('~')
        if home and home != '~':
            os.environ.setdefault('USERPROFILE', home)
    if chdir and os.path.isdir(root):
        try:
            os.chdir(root)
        except OSError:
            pass
    return root


def patch_audio_io() -> str:
    """把 torchaudio.load 换成 **soundfile** 实现 —— 返回用了哪条路（诊断用）。

    ★ 实测：torch 2.11 的 torchaudio 把解码交给 torchcodec，而 torchcodec 需要
      **FFmpeg 的共享库**（avcodec-*.dll 一整套）在 PATH 里；本机只有 ffmpeg.exe（静态），
      于是加载参考音直接抛
      「Failed to create AudioDecoder … Could not load libtorchcodec」（实测踩过）。
      soundfile 本来就是 GPT-SoVITS 的依赖，读 wav/flac/mp3 都稳，且不碰 FFmpeg。
    """
    try:
        import numpy as np
        import soundfile as sf
        import torch
        import torchaudio
    except Exception as e:                     # noqa: BLE001
        return 'unavailable: %s' % str(e)[:80]
    if getattr(torchaudio, '_fufumidi_sf_load', False):
        return 'soundfile（已装）'

    def load(filepath, frame_offset=0, num_frames=-1, normalize=True,
             channels_first=True, **_kw):
        data, sr = sf.read(str(filepath), always_2d=True, dtype='float32')
        t = torch.from_numpy(np.ascontiguousarray(data.T))
        if frame_offset:
            t = t[:, int(frame_offset):]
        if num_frames is not None and int(num_frames) > 0:
            t = t[:, :int(num_frames)]
        return (t if channels_first else t.t()), int(sr)

    torchaudio.load = load
    torchaudio._fufumidi_sf_load = True
    return 'soundfile'


# ---------------------------------------------------------------- 音色目录

def find_weights(voice_dir: str) -> Tuple[str, str]:
    """在音色目录里认出 `(gpt 权重, sovits 权重)`（文件名不写死，见模块说明）。"""
    ckpts, pths = [], []
    try:
        for name in sorted(os.listdir(voice_dir)):
            low = name.lower()
            full = os.path.join(voice_dir, name)
            if not os.path.isfile(full):
                continue
            if low.endswith('.ckpt'):
                ckpts.append(full)
            elif low.endswith('.pth'):
                pths.append(full)
    except OSError:
        pass
    if not ckpts or not pths:
        raise RuntimeError('音色目录不完整（需要 .ckpt + .pth）：%s' % voice_dir)

    def pick(items, keys):
        for k in keys:
            for it in items:
                if k in os.path.basename(it).lower():
                    return it
        return items[0]

    return pick(ckpts, ('gpt', 's1', '-e')), pick(pths, ('sovits', 'e25', 's2g', 's2d'))


def find_ref_audio(voice_dir: str, explicit: str = '') -> str:
    """参考音：显式 > `ref.wav` > 目录里第一个 wav。"""
    cands = [explicit] if explicit else []
    cands += [os.path.join(voice_dir, 'ref.wav'),
              os.path.join(voice_dir, 'reference.wav')]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    try:
        for name in sorted(os.listdir(voice_dir)):
            if name.lower().endswith(('.wav', '.mp3', '.flac')):
                return os.path.join(voice_dir, name)
    except OSError:
        pass
    return ''


def detect_version(voice_dir: str) -> str:
    """猜音色的版本段（v1/v2/v3/v4…）。

    顺序：`config.json` 里写明的 > 权重文件里带 `version` 键 > **v2**（社区包绝大多数）。
    猜错会直接抛「模型结构与权重不匹配」，所以允许调用方 `--version` 覆盖。
    """
    cfg = os.path.join(voice_dir, 'config.json')
    try:
        with open(cfg, encoding='utf-8') as f:
            d = json.load(f) or {}
        v = str(d.get('version') or (d.get('s2') or {}).get('version') or '').lower()
        if v in VERSIONS:
            return v
    except (OSError, ValueError):
        pass
    try:
        ckpt, _pth = find_weights(voice_dir)
        import torch
        d = torch.load(ckpt, map_location='cpu', weights_only=False)
        v = str((d or {}).get('version') or '').lower()
        if v in VERSIONS:
            return v
    except Exception:                       # noqa: BLE001 —— 探测失败就用默认
        pass
    return 'v2'


# ---------------------------------------------------------------- 配置

def build_config(root: str, voice_dir: str, device: str = 'auto', is_half: Optional[bool] = None,
                 version: str = '') -> Dict:
    """组装 `TTS_Config` 的入参 —— **必须包在 `custom` 里**（见模块说明的坑 1）。"""
    gpt, sovits = find_weights(voice_dir)
    ver = (version or detect_version(voice_dir)).lower()
    if ver not in VERSIONS:
        raise RuntimeError('不认识的 GPT-SoVITS 版本：%s（可选 %s）' % (ver, '/'.join(VERSIONS)))
    base = os.path.join(root, 'GPT_SoVITS', 'pretrained_models')
    bert = os.path.join(base, 'chinese-roberta-wwm-ext-large')
    hubert = os.path.join(base, 'chinese-hubert-base')
    for label, p in (('BERT（chinese-roberta-wwm-ext-large）', bert),
                     ('HuBERT（chinese-hubert-base）', hubert)):
        if not os.path.isdir(p):
            raise RuntimeError('运行时缺少基础模型 %s：%s —— 需要完整的 GPT-SoVITS 运行时包'
                               '（pretrained_models 约 900MB 起）' % (label, p))
    dev = str(device or 'auto').lower()
    if dev in ('auto', ''):
        try:
            import torch
            dev = 'cuda' if torch.cuda.is_available() else 'cpu'
        except Exception:                   # noqa: BLE001
            dev = 'cpu'
    half = (dev == 'cuda') if is_half is None else bool(is_half)
    return {'custom': {
        'device': dev,
        'is_half': half,
        'version': ver,
        't2s_weights_path': gpt,
        'vits_weights_path': sovits,
        'bert_base_path': bert,
        'cnhuhbert_base_path': hubert,
    }}


def list_voices(root: str = '') -> List[Dict]:
    """列出本地音色（给 UI / CLI 用）：id、目录、权重是否齐、参考音。"""
    vroot = voices_root()
    out: List[Dict] = []
    try:
        names = sorted(os.listdir(vroot))
    except OSError:
        return out
    for name in names:
        d = os.path.join(vroot, name)
        if not os.path.isdir(d):
            continue
        item = {'id': name, 'dir': d, 'ok': False, 'error': ''}
        try:
            gpt, sovits = find_weights(d)
            item.update({'gpt': os.path.basename(gpt), 'sovits': os.path.basename(sovits),
                         'gptSize': os.path.getsize(gpt), 'sovitsSize': os.path.getsize(sovits)})
            ref = find_ref_audio(d)
            item['ref'] = os.path.basename(ref) if ref else ''
            item['version'] = detect_version(d)
            item['ok'] = True
        except Exception as e:              # noqa: BLE001
            item['error'] = str(e)[:200]
        out.append(item)
    return out


def probe(root: str = '', voice_dir: str = '') -> Dict:
    """就绪检查（CLI `deps` / UI 的「能不能用」依据）。"""
    info: Dict = {'ok': False, 'dataRoot': data_root(), 'voicesRoot': voices_root(),
                  'missing': [], 'notes': []}
    rt = find_runtime(root)
    info['root'] = rt
    if not rt:
        info['missing'].append('runtime')
        info['notes'].append('未找到 GPT-SoVITS 运行时（FUFUMIDI_GSV_ROOT / runtime.json / 资源中心）')
    else:
        for label, rel in BASE_MODELS.items():
            p = os.path.join(rt, rel)
            if not os.path.isdir(p):
                info['missing'].append(label)
        try:
            import torch                                  # noqa: F401
            info['torch'] = getattr(sys.modules['torch'], '__version__', '')
        except Exception as e:                            # noqa: BLE001
            info['missing'].append('torch')
            info['notes'].append('当前解释器没有 torch：' + str(e)[:120])
    info['python'] = find_python(root=rt)
    info['voices'] = list_voices()
    info['ok'] = not info['missing'] and bool(info['voices'])
    return info

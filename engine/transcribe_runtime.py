# -*- coding: utf-8 -*-
"""可选转录引擎的**统一运行时封装**（2026-10-21）。
====================================================

三个「资源中心下载」的可选转录引擎 —— hFT-Transformer（钢琴）、YourMT3+（通用）、
MIROS（通用）—— 在接入时各自写了一份「找目录 / 塞 sys.path / 打 torchaudio 补丁 /
造 wandb 桩 / 选设备 / 限线程」的样板。那份样板有四处硬伤：

  1. **重复且会漂移**：torchaudio.load→soundfile 的补丁三处各写一遍，
     torchaudio 2.9 起 load 需要 torchcodec，漏打就是 `ImportError: torchcodec`；
  2. **路径写死**：MIROS 把实验目录名 `le2bzt53` 焊在 available() 里，
     换个训练批次就「下载完了还说没装」—— 这种不一致**不报错**，最难查；
  3. **能力不齐**：只有 YourMT3+ 处理了 num_threads，三个都没接暂停闸门
     （用户在界面上按暂停，这三个引擎没有任何反应）；
  4. **临时文件与音符计数**各写一遍。

本模块把这四件事收敛成一套函数，三个引擎都调它。**不改上游推理逻辑** ——
各引擎自己的模型加载与解码仍留在各自的 engine_*.py 里。

目录约定（三者一致，资源中心解包后就是这样）：
    <FUFUMIDI_MODELS_DIR>/<runtime>/
        site/     独立 Python 依赖（引擎自带，不动 App 运行时）
        repo/ 或 amt/   上游源码 + 权重
权重/运行时一律**不随安装包分发**，由 main/models.js 的统一安装通道下载。
"""
import os
import sys
import time

#: 运行时目录在 models 根下的名字 → 引擎标签（日志与报错用）
RUNTIME_LABELS = {
    "hft_transformer": "hFT-Transformer",
    "yourmt3": "YourMT3+",
    "miros": "MIROS",
    "muscriptor": "MuScriptor",
}

#: 单次推理的线程上限：转录是 CPU/GPU 混合负载，开到全部核心会让 UI 线程饿死
THREAD_CAP = 8


def models_dir():
    """模型根目录（主进程通过 env 传进来）。"""
    return os.environ.get("FUFUMIDI_MODELS_DIR", "") or ""


def find_runtime(runtime, env_var=None):
    """定位运行时目录。

    优先级：专用环境变量（部署/调试用）→ <models_dir>/<runtime>/。
    返回绝对路径或 None。**只判"目录在不在"**，装没装好由 available() 判。
    """
    override = os.environ.get(env_var or ("FUFUMIDI_%s_RUNTIME" % runtime.upper()), "") or ""
    if override and os.path.isdir(override):
        return override
    md = models_dir()
    if not md:
        return None
    p = os.path.join(md, runtime)
    return p if os.path.isdir(p) else None


def runtime_missing_message(runtime):
    """统一的"没装"报错文案（界面与日志同一套）。"""
    label = RUNTIME_LABELS.get(runtime, runtime)
    return ("未找到 %s 运行时。请到「资源中心 → 转录模型」下载 %s（运行时 + 权重）。"
            % (label, label))


def available(runtime, required=()):
    """运行时是否就绪：目录在、且 required 里的相对路径都存在。

    required 用**相对路径**而不是"目录大小 > N"—— 半截文件、错版解包都骗不过它，
    而体积阈值会把"下了一半但已经很大"的包误判成装好。
    """
    rt = find_runtime(runtime)
    if not rt:
        return False
    for rel in required:
        if not os.path.exists(os.path.join(rt, rel)):
            return False
    return True


def first_existing(rt, rels):
    """返回 rt 下第一个存在的相对路径（权重路径兜底用）。"""
    for rel in rels:
        p = os.path.join(rt, rel)
        if os.path.exists(p):
            return p
    return None


def glob_first(rt, pattern, depth=6):
    """在 rt 下按 glob 找第一个匹配（训练批次目录名会变，不能写死）。

    pattern 里可以用 `**`（跨任意层目录）—— 因此内部开 `recursive=True`。
    depth 只是**兜底**：真按 `**` 找不到时，逐层下钻再试一次普通 glob，
    避免某些 Python/平台组合对 `**` 的处理差异把路堵死。
    """
    import glob as _glob
    hits = sorted(_glob.glob(os.path.join(rt, pattern), recursive=True))
    if hits:
        return hits[0]
    base = rt
    for _ in range(depth):
        hits = sorted(_glob.glob(os.path.join(base, pattern.replace("**/", "")), recursive=True))
        if hits:
            return hits[0]
        nxt = os.path.join(base, "*")
        if not os.path.isdir(nxt):
            return None
        base = nxt
    return None


def prepare_paths(rt, extra_dirs=()):
    """把运行时的 site / 源码目录塞进 sys.path（幂等）。

    顺序：site 最前（运行时的依赖要压过 App 运行时），随后是各源码目录。
    """
    dirs = []
    site = os.path.join(rt, "site")
    if os.path.isdir(site):
        dirs.append(site)
    for d in extra_dirs:
        p = d if os.path.isabs(d) else os.path.join(rt, d)
        if os.path.isdir(p):
            dirs.append(p)
    dirs.append(rt)
    for p in reversed(dirs):        # insert(0) 会把后面的顶前面，反着插才保持顺序
        if p not in sys.path:
            sys.path.insert(0, p)
    return dirs


def stub_wandb():
    """给 wandb 打一个只含 Table 的轻量桩。

    YourMT3 系（含 MIROS）只在训练日志里用 wandb.Table，推理根本不需要它；
    但 import 链上会碰到，没有桩就真的去装 wandb（数百 MB）。
    """
    if "wandb" in sys.modules:
        return
    import types
    w = types.ModuleType("wandb")

    class _Table:
        def __init__(self, *a, **k):
            pass

    w.Table = _Table
    w.init = lambda *a, **k: None
    w.log = lambda *a, **k: None
    w.finish = lambda *a, **k: None
    sys.modules["wandb"] = w


def patch_torchaudio_soundfile():
    """把 torchaudio.load 换成 soundfile 实现（全进程一次）。

    torchaudio 2.9 起 `load` 依赖 torchcodec（要 FFmpeg 共享库），而 App 运行时
    不打包它。三个引擎原本各写一遍，漏一个就是 ImportError。
    """
    try:
        import torchaudio
    except Exception:
        return False
    if getattr(torchaudio, "_fu_soundfile_load", False):
        return True
    import torch
    import soundfile as sf

    def _sf_load(path=None, uri=None, **kwargs):
        p = path or uri
        data, sr = sf.read(p, dtype="float32", always_2d=True)
        return torch.from_numpy(data.T), sr

    torchaudio.load = _sf_load
    torchaudio._fu_soundfile_load = True
    return True


def select_device(precision=None):
    """(device, precision) —— 有 CUDA 用 CUDA（默认 fp16），否则 CPU（fp32）。"""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda", (precision or "16")
        return "cpu", (precision or "32")
    except Exception:
        return "cpu", "32"


def limit_threads(num_threads=None):
    """限制 torch 线程数（转录是后台任务，不能把 UI 线程饿死）。"""
    try:
        import torch
        n = int(num_threads or os.cpu_count() or 4)
        torch.set_num_threads(max(1, min(THREAD_CAP, n)))
        return max(1, min(THREAD_CAP, n))
    except Exception:
        return None


def install_pause(log_cb=None):
    """装暂停闸门（用户 2026-10-14 要求：转录中可暂停/继续）。

    三个可选引擎以前都没接，界面上按暂停它们照跑完。装在这里，
    各引擎在自己的推理循环里调 pause_gate.wait() 即可。
    """
    import pause_gate
    return pause_gate.install(log_cb)


def pause_points(iterable, every=1):
    """包一个可迭代对象：每产出 every 项过一次闸门（惰性，不预取）。"""
    import pause_gate
    gate = pause_gate.current()
    if gate is None or not gate.active:
        for item in iterable:
            yield item
        return
    n = 0
    for item in iterable:
        n += 1
        if n % max(1, every) == 0:
            gate.wait()
        yield item


def decode(audio_path, sr):
    """解码音频 → (临时 wav 路径, float32 ndarray, sr)。调用方负责 remove_temp。"""
    import audio_io
    wav = audio_io.decode_to_wav(audio_path, sr)
    return wav


def read_wav(wav_path):
    """读 wav → (单声道 float32 ndarray, sr)。"""
    import soundfile as sf
    import numpy as np
    x, sr = sf.read(wav_path, dtype="float32", always_2d=False)
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
    return np.asarray(x, dtype="float32"), int(sr)


def cleanup(wav_path):
    """删临时 wav（失败不影响结果）。"""
    if not wav_path:
        return
    try:
        import audio_io
        audio_io.remove_temp(wav_path)
    except Exception:
        try:
            os.remove(wav_path)
        except OSError:
            pass


def count_notes(midi_path):
    """数 MIDI 里的音符数（note_on 且 velocity>0）。读不了就返回 0。"""
    try:
        import mido
        m = mido.MidiFile(midi_path)
        return sum(1 for tr in m.tracks for msg in tr
                   if msg.type == "note_on" and msg.velocity > 0)
    except Exception:
        return 0


def log_timing(log_cb, label, t0, extra=""):
    """统一的一行计时日志。"""
    if not log_cb:
        return
    try:
        log_cb("%s：耗时 %.1fs%s" % (label, time.perf_counter() - t0, extra))
    except Exception:
        pass


def release_gpu():
    """推理结束后归还显存（torch 缓存分配器不会自动还）。"""
    try:
        import gc
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass

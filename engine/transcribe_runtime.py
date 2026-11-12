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
import ctypes
import json
import os
import sys
import time

try:                       # wintypes 只在 Windows 存在；非 Windows 下相关代码不会被走到
    from ctypes import wintypes
except Exception:          # noqa: BLE001
    wintypes = None

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


def _pack_dirs():
    """GPU 增强包在 PYTHONPATH 里的目录（主进程 engineEnv 注入，只放增强包）。

    ★ 2026-10-31：这不是"随便一个环境变量"。`main.js:engineEnv` 把与当前解释器
    ABI 匹配的 GPU 增强包 site 目录写进 PYTHONPATH，里面是 cu128 的 torch；
    而运行时的 `site/torch` 是 CPU 版（MIROS 实测 2.14.1+cpu）。谁在 sys.path
    前面，谁就赢 —— 所以这个列表必须能被 prepare_paths 看见。
    """
    out = []
    for p in (os.environ.get("PYTHONPATH") or "").split(os.pathsep):
        p = p.strip().strip('"')
        if p and os.path.isdir(p) and p not in out:
            out.append(p)
    return out


def _ver_tuple(v):
    """'2.14.1+cpu' → (2, 14, 1)；解析不动就返回 ()。"""
    try:
        core = str(v).split('+')[0]
        return tuple(int(x) for x in core.split('.')[:3])
    except (TypeError, ValueError):
        return ()


def torch_compat_warning(runtime, site):
    """增强包的 torch 与运行时自带版本不一致时给一句提醒（只提醒，不拦截）。

    PR #37 第二条建议：先校验再决定用谁。多数情况下 torch 次版本差一个能跑，
    但**运行时自己 pin 了 API 时**会以 `AttributeError / ImportError` 的形式炸在
    加载权重那一刻，那时用户根本想不到是 torch 版本问题 —— 所以这里提前说清，
    并给出退回自带 torch 的开关。
    """
    info = torch_info()
    if info.get("error"):
        return None
    bundled = dist_versions(site, ("torch",)).get("torch")
    if not bundled or not info.get("torch"):
        return None
    used = str(info["torch"]).split("+")[0]
    have = str(bundled).split("+")[0]
    if have == used:
        return None
    label = RUNTIME_LABELS.get(runtime, runtime or "运行时")
    older = _ver_tuple(used) < _ver_tuple(have)
    tip = ("增强包版本更低" if older else "增强包版本更高")
    return ("%s：正在用 torch %s（GPU 增强包），运行时自带的是 %s（%s）。"
            "若加载权重时报缺某个 API，设环境变量 FUFUMIDI_RUNTIME_BUNDLED_TORCH=1 "
            "退回自带 torch（会走 CPU，但调用面完全对得上）。" % (label, used, have, tip))


#: 最近一次 prepare_paths 跳过运行时 site 的原因（ABI 不匹配时）
_LAST_SITE_SKIP = {}
#: 最近一次 prepare_paths 实际插进 sys.path 的目录（供 restore_paths 清理）
_LAST_INSERTED = []


def _binary_abi(path):
    """读目录里二进制包的文件名，判断它要求的 CPython 次版本（'3.11'/'3.12'）。

    ★ 不 import：运行时包可能是另一种 CPython 构建的，import 会直接炸。
    """
    import glob
    import re
    for pat in ("numpy/core/_multiarray_umath.cp3*.pyd",
                "numpy/_core/_multiarray_umath.cp3*.pyd",
                "torch/_C.cp3*.pyd"):
        hits = glob.glob(os.path.join(path, pat))
        if hits:
            m = re.search(r"cp3(\d+)", os.path.basename(hits[0]))
            if m:
                return "3." + m.group(1)
    return ""


def site_abi(path):
    """目录里二进制包要求的 CPython 次版本；看不出来返回 ''。"""
    return _binary_abi(path)


def last_site_skip():
    """最近一次 prepare_paths 为什么跳过 site（没有跳过则为空 dict）。"""
    return dict(_LAST_SITE_SKIP)


def last_inserted():
    """最近一次 prepare_paths 插进 sys.path 的目录。"""
    return list(_LAST_INSERTED)


def restore_paths(dirs=None):
    """把 prepare_paths 插进去的目录移除，避免污染常驻引擎里的后续任务。"""
    for p in (dirs if dirs is not None else list(_LAST_INSERTED)):
        while p in sys.path:
            sys.path.remove(p)
    _LAST_INSERTED[:] = []


def sanitize_sys_path():
    """清掉 sys.path 里 ABI 不匹配的运行时 site。

    ★ 2026-11-12 修：常驻引擎复用同一进程。上一个 MIROS 任务把
      `models/miros/site`（Python 3.12 构建）插进 sys.path 后没有移除，
      下一次 MuScriptor 任务 import scipy 就会加载 cp312 的 numpy，
      报「The scipy install you are using seems to be broken」。
    """
    cur = "%d.%d" % sys.version_info[:2]
    removed = []
    for p in list(sys.path):
        if not p or os.path.basename(p.rstrip("\\/")) != "site":
            continue
        abi = _binary_abi(p)
        if abi and abi != cur and p in sys.path:
            sys.path.remove(p)
            removed.append({"site": p, "abi": abi, "python": cur})
    return removed


def prepare_paths(rt, extra_dirs=(), keep_env_packages=True):
    """把运行时的 site / 源码目录塞进 sys.path（幂等）。

    顺序：**GPU 增强包目录 → 运行时 site → 各源码目录 → 运行时根**。

    ★ 2026-10-31 修（GitHub PR #37）：原来 site 无脑插到 sys.path[0]，把
    PYTHONPATH 里 GPU 增强包的 cu128 torch 盖住了 —— 运行时自带的是 CPU 版
    torch，于是「有 CUDA 的机器上 GPU available: False」、整首走 CPU 慢十倍，
    而且日志里看不出来是谁遮的。现在 site 插在增强包目录**之后**：
    运行时的依赖照样压过 App 自带运行时，但压不过用户显式装的 GPU 包。

    ★ 2026-11-12 修：site 的二进制包（numpy/torch）可能是**另一种 CPython
    次版本**构建的（MIROS 的 site 实测是 cp312，而运行时是 3.11）。这种目录
    一旦进 sys.path，之后任何 import numpy/scipy 都会失败，且报错指向
    「scipy 坏了」，完全看不出真正原因。现在先读文件名判断 ABI，不匹配就
    跳过并记录到 last_site_skip()，由调用方给出明确提示。

    keep_env_packages=False 时退回旧行为（site 最前），留给排障对照用
    （环境变量 FUFUMIDI_RUNTIME_BUNDLED_TORCH=1 会走到这里）。
    """
    _LAST_SITE_SKIP.clear()
    dirs = []
    site = os.path.join(rt, "site")
    if os.path.isdir(site):
        abi = _binary_abi(site)
        cur = "%d.%d" % sys.version_info[:2]
        if abi and abi != cur:
            _LAST_SITE_SKIP.update({"site": site, "abi": abi, "python": cur})
        else:
            dirs.append(site)
    for d in extra_dirs:
        p = d if os.path.isabs(d) else os.path.join(rt, d)
        if os.path.isdir(p):
            dirs.append(p)
    dirs.append(rt)

    env_dirs = set(_pack_dirs()) if keep_env_packages else set()
    base = 0
    if env_dirs:
        for i, p in enumerate(sys.path):
            if p in env_dirs:
                base = i + 1
    inserted = []
    for p in reversed(dirs):        # insert(0) 会把后面的顶前面，反着插才保持顺序
        if p in sys.path:
            continue
        sys.path.insert(base, p)
        inserted.append(p)
    _LAST_INSERTED[:] = inserted
    return inserted


def dist_versions(site_dir, names=("torch", "torchaudio")):
    """从 site 目录的 *.dist-info 读包版本（**不 import**，避免把两套 torch 撞在一起）。"""
    out = {}
    try:
        entries = os.listdir(site_dir)
    except OSError:
        return out
    for name in names:
        pref = name + "-"
        for e in sorted(entries):
            if e.lower().startswith(pref) and e.endswith(".dist-info"):
                out[name] = e[len(pref):-len(".dist-info")]
                break
    return out


def torch_info():
    """实际用到的 torch 是谁、有没有 CUDA、从哪个目录加载的。

    PR #37 的第三条建议：别再让用户从"转得很慢"去反推设备路径。
    """
    info = {"torch": None, "cuda": None, "cuda_available": False,
            "file": None, "torchaudio": None, "error": None}
    try:
        import torch
        info["torch"] = str(getattr(torch, "__version__", "?"))
        info["cuda"] = getattr(getattr(torch, "version", None), "cuda", None)
        try:
            info["cuda_available"] = bool(torch.cuda.is_available())
        except Exception:
            info["cuda_available"] = False
        info["file"] = getattr(torch, "__file__", None)
    except Exception as e:      # 没装 / ABI 不匹配 / 依赖缺失
        info["error"] = "%s: %s" % (type(e).__name__, e)
    try:
        import torchaudio
        info["torchaudio"] = str(getattr(torchaudio, "__version__", "?"))
    except Exception:
        pass
    return info


def describe_torch(info, runtime=None):
    """把 torch_info() 写成一行能读懂的话（引擎日志直接用）。"""
    label = RUNTIME_LABELS.get(runtime, runtime or "运行时")
    if info.get("error"):
        return "%s：torch 不可用（%s）" % (label, info["error"])
    cuda = info.get("cuda") or "cpu"
    dev = "CUDA 可用" if info.get("cuda_available") else "仅 CPU"
    ta = ("／torchaudio %s" % info["torchaudio"]) if info.get("torchaudio") else ""
    where = os.path.dirname(info.get("file") or "") or "?"
    return "%s：torch %s（cuda=%s）%s · %s · %s" % (label, info["torch"], cuda, ta, dev, where)


def cpu_fallback_hint(runtime, info, pack_dirs=None, site=None):
    """走 CPU 时说清「为什么」和「怎么修」，不要只留一句慢。

    返回 None 表示不需要提示（已经在 GPU 上）。
    """
    if info.get("cuda_available"):
        return None
    label = RUNTIME_LABELS.get(runtime, runtime or "运行时")
    packs = _pack_dirs() if pack_dirs is None else pack_dirs
    # PYTHONPATH 也可能被子进程/测试塞进普通源码目录；只有真正的增强包目录
    # （site-packages / engine-view）才算「已挂载」，否则会误报「包已挂载但 CUDA 不可用」。
    packs = [p for p in packs
             if os.path.basename(str(p).rstrip("\\/")).lower() in ("site-packages", "engine-view")]
    if not packs:
        return ("%s：未检测到 GPU 增强包，本次走 CPU（fp32）。"
                "要提速请到「设置 → GPU 增强包」安装与当前 Python 版本匹配的 CUDA 包。" % label)
    if info.get("error"):
        return "%s：GPU 增强包已挂载但 torch 加载失败，本次走 CPU。原因：%s" % (label, info["error"])
    return ("%s：GPU 增强包已挂载（%s），但 torch 报告 CUDA 不可用，本次走 CPU。"
            "常见原因：显卡驱动过旧、包与解释器 ABI 不匹配、或运行时自带的 CPU torch 又把包遮住了。"
            % (label, info.get("torch")))


def stub_wandb():
    """给 wandb 打桩，并把 lightning 的 WandbLogger 换成不联网的 DummyLogger。

    YourMT3 系（含 MIROS）只在训练日志里用 wandb.Table，推理根本不需要它；
    但 import 链上会碰到，没有桩就真的去装 wandb（数百 MB）。

    ★ 2026-11-12：只塞一个 ModuleType 不够 —— lightning 的 WandbLogger 会
      `from wandb.sdk.lib import RunDisabled` / `from wandb.wandb_run import Run`，
      而 ModuleType 不是包，报 `No module named 'wandb.sdk'; 'wandb' is not a package`，
      MIROS 直接起不来。这里补齐子模块，并在导入上游之前把 WandbLogger 类整个
      换成 DummyLogger 子类 —— 它的 experiment 是 _DummyExperiment，
      `.config.update(...)` 之类调用全部安全地变成 no-op。
    """
    if "wandb" not in sys.modules:
        import types
        w = types.ModuleType("wandb")
        w.__path__ = []                     # 让它表现得像包，供 `import wandb.sdk` 使用

        class _Table:
            def __init__(self, *a, **k):
                self.data = []

            def add_data(self, *a, **k):
                return None

        class _Artifact:
            def __init__(self, *a, **k):
                pass

        class _Run:
            def __init__(self, *a, **k):
                self.config = types.SimpleNamespace(update=lambda *a, **k: None)

            def finish(self, *a, **k):
                return None

        w.Table = _Table
        w.Artifact = _Artifact
        w.Run = _Run
        w.init = lambda *a, **k: _Run()
        w.log = lambda *a, **k: None
        w.finish = lambda *a, **k: None
        w.run = None
        sdk = types.ModuleType("wandb.sdk")
        sdk.__path__ = []
        lib = types.ModuleType("wandb.sdk.lib")
        lib.__path__ = []
        lib.RunDisabled = _Run
        sdk.lib = lib
        runmod = types.ModuleType("wandb.wandb_run")
        runmod.Run = _Run
        w.sdk = sdk
        w.wandb_run = runmod
        sys.modules["wandb"] = w
        sys.modules["wandb.sdk"] = sdk
        sys.modules["wandb.sdk.lib"] = lib
        sys.modules["wandb.wandb_run"] = runmod

    try:
        import pytorch_lightning.loggers as _L
        if getattr(_L, "_fufumidi_null_wandb", False):
            return True
        from pytorch_lightning.loggers import DummyLogger

        class _NullWandbLogger(DummyLogger):
            def __init__(self, *a, **k):
                super().__init__()

        _L.WandbLogger = _NullWandbLogger
        _L._fufumidi_null_wandb = True
        try:
            import lightning.pytorch.loggers as _L2
            _L2.WandbLogger = _NullWandbLogger
            _L2._fufumidi_null_wandb = True
        except Exception:  # noqa: BLE001  没有 lightning 包时只改 pytorch_lightning 就够了
            pass
        return True
    except Exception:  # noqa: BLE001  没装 lightning（例如只用 MuScriptor）时不影响调用方
        return False


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


def emit_progress(log_cb=None, completed=None, total=None, percent=None, label=None):
    """发一条 `###PROG` 进度行 —— 转录进度的**唯一出口**。

    协议（main/engine.js + 前端 ViewTranscribe 都认）：
      · `{"completed":n,"total":m}` —— 分块引擎的分块进度（MuScriptor 原有形态）
      · `{"percent":p,"label":"…"}` —— 阶段百分比；与 completed/total 同时给时
        消费端 **percent 优先**（它是算好权重的总进度，不会被"阶段切换"拉回去）
    两个都不给（payload 为空）时不打行。

    log_cb 为空时回落到 `pause_gate.log_line`：那类包装器（模型 forward、
    token 流）只装一次、拿不到当次 log_cb，否则进度会打到上一次的窗口上。
    """
    payload = {}
    if completed is not None and total is not None:
        try:
            payload["completed"] = int(completed)
            payload["total"] = int(total)
        except (TypeError, ValueError):
            pass
    if percent is not None:
        try:
            payload["percent"] = round(float(percent), 1)
        except (TypeError, ValueError):
            pass
    if label:
        payload["label"] = str(label)
    if not payload:
        return False
    line = "###PROG " + json.dumps(payload, ensure_ascii=False)
    if log_cb:
        try:
            log_cb(line)
            return True
        except Exception:
            pass
    try:
        import pause_gate
        pause_gate.log_line(line)
        return True
    except Exception:
        return False


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


# ---------------------------------------------------------------------------
# 任务完成后释放内存 / 显存（用户 2026-11-12 要求）
#
# 为什么不能只调 gc.collect()：
#   1) 模型/推理会话只要还有一个引用（模块级缓存、闭包），gc 就收不到；
#   2) torch 的 CUDA 缓存分配器把释放的显存留在自己的池子里，别的进程照样申请不到；
#   3) Windows 上 Python 释放的内存只回到进程堆，**工作集（Working Set）不会自己降** ——
#      任务管理器里一直显示占着几个 G，系统可用内存也回不来。MIROS 长歌曲 OOM 的
#      现场就是这样：跑完一首之后进程还挂着几个 G，下一首更难跑。
# ---------------------------------------------------------------------------

if wintypes is not None:
    class _PMC(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]
else:                       # 非 Windows：结构体不需要存在，函数会走 /proc 分支
    _PMC = None


def _win_k32():
    """kernel32 + psapi 的句柄/函数声明。

    ★ 必须显式声明 restype/argtypes：64 位进程里句柄是 8 字节，ctypes 默认按
      C int（4 字节）返回——句柄被截断，GetProcessMemoryInfo 只会返回 0、
      EmptyWorkingSet 永远 False（实测就是这个坑，日志里读不到任何内存数字）。
    """
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    return k32, psapi, wintypes


def proc_mem_mb():
    """本进程当前工作集 / RSS（MB）。取不到返回 None（只用于打日志）。"""
    try:
        if os.name == "nt":
            import ctypes
            k32, psapi, wintypes = _win_k32()
            fn = getattr(psapi, "GetProcessMemoryInfo", None)
            if fn is None:
                fn = getattr(k32, "K32GetProcessMemoryInfo")
            fn.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PMC), wintypes.DWORD]
            fn.restype = wintypes.BOOL
            c = _PMC()
            c.cb = ctypes.sizeof(_PMC)
            if not fn(k32.GetCurrentProcess(), ctypes.byref(c), c.cb):
                return None
            return float(c.WorkingSetSize) / (1024.0 * 1024.0)
        with open("/proc/self/statm", "r") as f:
            pages = int(f.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE") / (1024.0 * 1024.0)
    except Exception:
        return None


def proc_vram_mb():
    """本进程（torch）已占用的显存 MB；没有 CUDA 返回 None。"""
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        free_b, total_b = torch.cuda.mem_get_info()
        return float(total_b - free_b) / (1024.0 * 1024.0)
    except Exception:
        return None


def empty_working_set():
    """Windows：把本进程已释放的页还给系统（等价任务管理器的「收缩工作集」）。

    非 Windows / 调用失败都返回 False，绝不抛 —— 这只是锦上添花的一步。
    """
    if os.name != "nt":
        return False
    try:
        k32, psapi, wintypes = _win_k32()
        fn = getattr(psapi, "EmptyWorkingSet", None)
        if fn is None:
            fn = getattr(k32, "K32EmptyWorkingSet", None)
        if fn is None:
            return False
        fn.argtypes = [wintypes.HANDLE]
        fn.restype = wintypes.BOOL
        return bool(fn(k32.GetCurrentProcess()))
    except Exception:
        return False


def _drop_model_caches():
    """丢掉引擎侧的模型/会话缓存（否则对象还被引用，gc 收不到）。

    只处理**已经导入过**的模块（用 sys.modules 判断），避免为了释放而把
    engine_pt / engine_perf 拉起来。
    """
    dropped = []
    ep = sys.modules.get("engine_perf")
    if ep is not None:
        cache = getattr(ep, "_basic_model_cache", None)
        if isinstance(cache, dict) and cache:
            try:
                cache.clear()
                dropped.append("basic-pitch")
            except Exception:
                pass
    pt = sys.modules.get("engine_pt")
    if pt is not None and getattr(pt, "_ENGINE", None) is not None:
        try:
            pt._release_pt_engine()      # 自己会 gc + empty_cache
            dropped.append("钢琴")
        except Exception:
            pass
    return dropped


def release_memory(log_cb=None, label="", drop_caches=True):
    """任务完成后释放内存与显存；返回 (mem_before, mem_after, vram_before, vram_after)。

    顺序不能反：先丢引用 → 再 gc → 再清 CUDA 池 → 最后收缩工作集。
    任何一步失败都不影响其它步骤，也绝不抛异常（释放失败不能把任务判成失败）。
    """
    before = proc_mem_mb()
    vram_before = proc_vram_mb() if drop_caches else None

    dropped = _drop_model_caches() if drop_caches else []

    try:
        import gc
        gc.collect()
        gc.collect()          # 两轮：第一轮析构，第二轮收循环引用
    except Exception:
        pass

    try:
        import torch
        if torch.cuda.is_available():
            try:
                torch.cuda.synchronize()
            except Exception:
                pass
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()     # 释放跨进程共享显存句柄
            except Exception:
                pass
    except Exception:
        pass

    empty_working_set()

    after = proc_mem_mb()
    vram_after = proc_vram_mb() if drop_caches else None
    if log_cb and before is not None and after is not None:
        try:
            txt = "[内存] %s释放：内存 %.0f → %.0f MB" % (label or "", before, after)
            if vram_before is not None and vram_after is not None:
                txt += "，显存 %.0f → %.0f MB" % (vram_before, vram_after)
            if dropped:
                txt += "（已清模型缓存：%s）" % "、".join(dropped)
            log_cb(txt)
        except Exception:
            pass
    return (before, after, vram_before, vram_after)

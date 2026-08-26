# -*- coding: utf-8 -*-
"""
性能模式：为不同配置的电脑控制引擎计算强度
==========================================
- 最高质量 默认：全部 CPU 核心，识别最完整
- 均衡      ：限制到 ≤4 核，降低内存占用与系统争用
- 高性能    ：限制到 2 核，适合低配 / 老机器（更省内存，不会拖垮整机）

实现方式：
- 设置 OpenMP / MKL / NumPy / Numba 线程数环境变量（在引擎导入前生效）
- torch.set_num_threads() 限制 torch 线程
- basic-pitch 的 onnxruntime 会话用自定义 SessionOptions 限制 intra-op 线程
（引擎均为懒加载，转码时才生效，不影响 GUI 启动速度。）

自动性能评估（detect_recommended）：根据 CPU 核数 / 内存 / GPU 自动推荐
档位并给出上限——高配置解锁全部档位，低配置锁定高性能档防止崩溃。
"""

import os
import sys
from pathlib import Path

# 每档限制的线程数；0 表示不限（用全部核心）
PERF_MODES = {"quality": 0, "balanced": 4, "fast": 2}
PERF_LABELS = {"quality": "最高质量", "balanced": "均衡", "fast": "高性能"}

_THREAD_ENV = ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS",
               "NUMBA_NUM_THREADS", "OPENBLAS_NUM_THREADS")


def resolve_threads(perf):
    """返回该性能模式应使用的线程数；None = 不限制（全部核心）。"""
    n = PERF_MODES.get(perf or "quality", 0)
    if n <= 0:
        return None
    cores = os.cpu_count() or 4
    return max(1, min(int(n), cores))


def apply_global(perf):
    """在导入重量级引擎前调用：限制 OpenMP/torch 等后端线程数。"""
    n = resolve_threads(perf)
    if n is None:
        return
    for var in _THREAD_ENV:
        os.environ[var] = str(n)
    try:
        import torch
        torch.set_num_threads(n)
    except Exception:
        pass


def _ram_gb():
    """跨平台物理内存（GB）。返回 None 表示探测失败。"""
    try:
        if os.name == "nt":
            import ctypes

            class _MS(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            ms = _MS()
            ms.dwLength = ctypes.sizeof(_MS)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
                return ms.ullTotalPhys / (1024.0 ** 3)
        elif sys.platform == "darwin":
            import subprocess
            r = subprocess.run(["sysctl", "-n", "hw.memsize"],
                               capture_output=True, text=True, timeout=5)
            return int(r.stdout.strip()) / (1024.0 ** 3)
        else:
            return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / (1024.0 ** 3)
    except Exception:
        return None


def detect_recommended():
    """根据本机硬件自动评估推荐性能档位（只推荐，不强制）。

    返回 dict:
        recommended  推荐档位（quality / balanced / fast）
        reasons      推荐说明（供 UI 展示）
        hardware     {cpu_cores, ram_gb, gpu}

    用途：启动时随 probe 返回，UI 据此默认选中推荐档位并给出提示；
    用户始终可手动切换任意档位（低配置也允许挑战最高质量）。
    """
    res = {"recommended": "balanced", "reasons": [], "hardware": {}}
    cores = os.cpu_count() or 4
    res["hardware"]["cpu_cores"] = cores
    ram = _ram_gb()
    if ram is not None:
        res["hardware"]["ram_gb"] = round(ram, 1)

    gpu_backend = None
    gpu_avail = False
    try:
        from engine_gpu import detect as _gpu_detect
        _g = _gpu_detect()
        gpu_backend = _g.get("backend")
        gpu_avail = bool(_g.get("available"))
    except Exception:
        pass
    res["hardware"]["gpu"] = gpu_backend
    if gpu_avail:
        res["hardware"]["gpu_available"] = True

    # 简单评分：核数 + 内存 + GPU
    score = 0
    if cores >= 12:
        score += 3
    elif cores >= 8:
        score += 2
    elif cores >= 6:
        score += 1
    if ram is not None:
        if ram >= 32:
            score += 2
        elif ram >= 16:
            score += 1
        elif ram < 6:
            score -= 2
    if gpu_avail:
        score += 2

    if score >= 5:
        # 高配置：默认直接用最好的模式/模型
        res["recommended"] = "quality"
        res["reasons"].append(
            "高配置（多核 CPU + 充足内存" + (" + GPU" if gpu_avail else "") +
            "）：默认使用最高质量模式与模型")
    elif score >= 2:
        res["recommended"] = "balanced"
        res["reasons"].append("中配置：推荐「均衡」档，可按需手动选择最高质量")
    else:
        res["recommended"] = "fast"
        res["reasons"].append("低配置：建议使用「高性能」档以保持流畅（可手动调整）")
    return res


def _basic_pitch_model_candidates():
    """Returns candidate basic-pitch ONNX model paths in preference order."""
    from basic_pitch import ICASSP_2022_MODEL_PATH
    p = Path(ICASSP_2022_MODEL_PATH)
    cands = []
    models_dir = os.environ.get("FUFUMIDI_MODELS_DIR")
    if models_dir:
        cands.append(Path(models_dir) / "basic_pitch_quant.onnx")
    if p.parent.is_dir():
        cands.append(p.parent / "nmp.quant.onnx")
    if not p.is_file():
        parent = p.parent
        for name in (p.name + ".onnx", "nmp.onnx"):
            cand = parent / name
            if cand.is_file():
                cands.append(cand)
        if parent.is_dir():
            for f in sorted(parent.glob("*.onnx")):
                if f not in cands:
                    cands.append(f)
    if p.is_file():
        cands.append(p)
    out = []
    for c in cands:
        try:
            if c.is_file() and str(c) not in out:
                out.append(str(c))
        except Exception:
            pass
    if not out and p.exists():
        return [str(p)]
    return out


def _resolve_basic_pitch_model():
    """Compatibility wrapper returning the first candidate path."""
    cands = _basic_pitch_model_candidates()
    return cands[0] if cands else ""


_basic_model_cache = {}

def make_basic_model(num_threads, force_cpu=False):
    """Construct a basic-pitch model with automatic ONNX fallback."""
    _key = (int(num_threads or 0), bool(force_cpu))
    if _key in _basic_model_cache:
        return _basic_model_cache[_key]
    try:
        import onnxruntime as ort
        from basic_pitch import inference as inf
        from engine_gpu import onnx_provider
        if force_cpu:
            providers = ["CPUExecutionProvider"]
        else:
            providers = [onnx_provider(), "CPUExecutionProvider"]
        candidates = _basic_pitch_model_candidates()
        for model_path in candidates:
            try:
                so = ort.SessionOptions()
                if num_threads:
                    so.intra_op_num_threads = int(num_threads)
                    so.inter_op_num_threads = 1
                sess = ort.InferenceSession(
                    model_path, sess_options=so,
                    providers=providers)
                m = inf.Model.__new__(inf.Model)
                m.model_type = inf.Model.MODEL_TYPES.ONNX
                m.model = sess
                _basic_model_cache[_key] = m
                return m
            except Exception:
                continue
        if candidates:
            return candidates[0]
        return _resolve_basic_pitch_model()
    except Exception:
        return _resolve_basic_pitch_model()


# -*- coding: utf-8 -*-
"""
GPU 加速检测与设备选择
======================
懒加载式探测（只在第一次调用时导入 torch / onnxruntime，不拖慢引擎启动）。
全程带超时与异常保护：任何探测失败都只影响 GPU 加速，绝不影响转录功能本身。

后端选择策略（按厂商自动匹配）：
- NVIDIA 显卡 → CUDA（torch.cuda；onnxruntime CUDAExecutionProvider）
- AMD / Intel 显卡 → DirectML（torch-directml 跑 torch 模型；onnxruntime DmlExecutionProvider 跑 basic-pitch）
- 无法识别 / 未安装对应运行时 → CPU（行为与之前完全一致）

用法:
    from engine_gpu import detect, torch_device, onnx_provider
    info = detect()              # {'available':True,'backend':'cuda','device':'cuda','vendor':'nvidia',...}
    dev   = torch_device()       # 'cuda' / 'privateuseone:0'(DirectML) / 'mps' / 'cpu'
    prov  = onnx_provider()      # 'CUDAExecutionProvider' / 'DmlExecutionProvider' / 'CPUExecutionProvider'
"""

import os
import subprocess
import sys

_cache = None


def _gpu_vendor():
    """尽力探测 GPU 厂商：nvidia / amd / intel / None。全程带超时，失败返回 None。"""
    names = []
    try:
        if os.name == "nt":
            # 优先 wmic（老版本 Windows）；Win11 24H2+ 已移除 wmic → 回退 PowerShell
            try:
                r = subprocess.run(
                    ["wmic", "path", "win32_VideoController", "get", "name"],
                    capture_output=True, text=True, timeout=3,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                names = [l.strip() for l in r.stdout.splitlines()
                         if l.strip() and "Name" not in l]
            except Exception:
                pass
            if not names:
                r = subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     "(Get-CimInstance win32_VideoController).Name"],
                    capture_output=True, text=True, timeout=6,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                names = [l.strip() for l in r.stdout.splitlines() if l.strip()]
        elif sys.platform == "darwin":
            r = subprocess.run(["system_profiler", "SPDisplaysDataType"],
                               capture_output=True, text=True, timeout=5)
            names = [l.split(":", 1)[1].strip() for l in r.stdout.splitlines()
                     if "Chipset" in l and ":" in l]
        else:
            if os.path.isdir("/proc/driver/nvidia/gpus"):
                names = ["NVIDIA"]
            if not names:
                r = subprocess.run(["lspci"], capture_output=True, text=True, timeout=3)
                names = [l for l in r.stdout.splitlines() if "VGA" in l or "3D" in l]
    except Exception:
        return None
    blob = " ".join(names).lower()
    if any(k in blob for k in ("nvidia", "geforce", "quadro", "rtx", "gtx", "tesla")):
        return "nvidia"
    if any(k in blob for k in ("amd", "radeon", "ati")):
        return "amd"
    if any(k in blob for k in ("intel", "arc", "iris", "uhd graphics", "hd graphics")):
        return "intel"
    return None


def _probe():
    gpu = {"available": False, "backend": None, "device": "cpu", "name": None,
           "vendor": None, "recommended_backend": "cpu",
           "cuda": False, "mps": False, "directml": False, "onnx_gpu": False,
           "onnx_provider": "CPUExecutionProvider"}
    if os.environ.get("FUFUMIDI_DISABLE_GPU") == "1":
        gpu["disabled"] = True
        gpu["note"] = "GPU 增强包未安装，已禁用 GPU 加速"
        return gpu
    # ---- torch 后端（钢琴 / 分离引擎）----
    try:
        import torch
        if torch.cuda.is_available():
            gpu["available"] = True
            gpu["backend"] = "cuda"
            gpu["device"] = "cuda"
            gpu["cuda"] = True
            gpu["vendor"] = "nvidia"
            try:
                gpu["name"] = torch.cuda.get_device_name(0)
            except Exception:
                gpu["name"] = "NVIDIA GPU"
        else:
            try:
                if torch.backends.mps.is_available():
                    gpu["available"] = True
                    gpu["backend"] = "mps"
                    gpu["device"] = "mps"
                    gpu["mps"] = True
                    gpu["name"] = "Apple Silicon (Metal)"
            except Exception:
                pass
    except Exception:
        pass
    # ---- torch-directml：AMD / Intel 显卡用 DirectML 跑 torch 模型 ----
    try:
        import torch_directml  # noqa: F401
        gpu["torch_directml"] = True
        if not gpu["available"]:
            gpu["available"] = True
            gpu["backend"] = "directml"
            gpu["directml"] = True
            gpu["name"] = "DirectML GPU"
            try:
                gpu["device"] = str(torch_directml.device(0))   # 形如 'privateuseone:0'
            except Exception:
                pass
    except Exception:
        pass
    # ---- ONNX Runtime 推理后端（通用转录 basic-pitch）----
    try:
        import onnxruntime as ort
        providers = ort.get_available_providers()
        if "DmlExecutionProvider" in providers:
            gpu["directml"] = True
            gpu["onnx_provider"] = "DmlExecutionProvider"
            if not gpu["available"]:
                gpu["available"] = True
                gpu["backend"] = "directml"
                gpu["device"] = "cpu"            # 非 torch 引擎，torch 仍走 CPU
        elif "CUDAExecutionProvider" in providers:
            gpu["onnx_gpu"] = True
            gpu["onnx_provider"] = "CUDAExecutionProvider"
    except Exception:
        pass

    # ---- 厂商识别 → 推荐后端：NVIDIA → CUDA；AMD/Intel → DirectML ----
    if gpu.get("vendor") is None and not gpu.get("cuda"):
        gpu["vendor"] = _gpu_vendor()
    if gpu["cuda"]:
        gpu["recommended_backend"] = "cuda"
    elif gpu.get("directml") or gpu.get("torch_directml"):
        gpu["recommended_backend"] = "directml"
    else:
        gpu["recommended_backend"] = "cpu"
    if gpu["vendor"] == "nvidia" and not gpu["cuda"]:
        gpu["note"] = "检测到 NVIDIA 显卡，但未安装 CUDA 版 torch；改用 CUDA 运行时可显著加速"
    elif gpu["vendor"] in ("amd", "intel") and not (gpu.get("directml") or gpu.get("torch_directml")):
        gpu["note"] = "检测到 " + gpu["vendor"].upper() + " 显卡，建议安装 DirectML 运行时以加速"
    return gpu


def detect():
    """返回 GPU 信息 dict（惰性探测一次并缓存）。"""
    global _cache
    if _cache is None:
        try:
            _cache = _probe()
        except Exception:
            _cache = {"available": False, "backend": None, "device": "cpu",
                      "name": None, "vendor": None, "recommended_backend": "cpu",
                      "cuda": False, "mps": False, "directml": False,
                      "onnx_gpu": False, "onnx_provider": "CPUExecutionProvider"}
    return _cache


def torch_device():
    """返回适合 torch 的设备字符串：'cuda' / 'privateuseone:0'(DirectML) / 'mps' / 'cpu'。"""
    return detect()["device"]


def onnx_provider():
    """返回 onnxruntime 应优先使用的 ExecutionProvider。"""
    return detect()["onnx_provider"]

# -*- coding: utf-8 -*-
"""
GPU 加速检测与设备选择
======================
懒加载式探测（只在第一次调用时导入 torch / onnxruntime，不拖慢引擎启动）。
全程带超时与异常保护：任何探测失败都只影响 GPU 加速，绝不影响转录功能本身。

后端选择策略（按厂商自动匹配）：
- NVIDIA 显卡 → CUDA（torch.cuda；onnxruntime CUDAExecutionProvider）
- AMD 显卡（较新 Radeon）→ ROCm 优先（torch.version.hip 非空；需 Python 3.12 运行时）
- AMD / Intel 显卡 → DirectML（torch-directml 跑 torch 模型；onnxruntime DmlExecutionProvider 跑 basic-pitch）
- 无法识别 / 未安装对应运行时 → CPU（行为与之前完全一致）

注意：ROCm 版 torch 会把 HIP 映射到 `cuda` 命名空间，`torch.cuda.is_available()` 同样为 True。
所以判定 ROCm 的唯一可靠依据是 `torch.version.hip` 非空，必须先于 CUDA 分支检查。

用法:
    from engine_gpu import detect, torch_device, onnx_provider
    info = detect()              # {'available':True,'backend':'cuda'|'rocm'|'directml',...}
    dev   = torch_device()       # 'cuda'（CUDA/ROCm 都是它）/ 'privateuseone:0'(DirectML) / 'mps' / 'cpu'
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


def _torch_is_cu128():
    """当前 torch 是否 CUDA 12.8（cu128）构建——Blackwell（sm_120）需要。"""
    try:
        import torch
        c = getattr(torch.version, "cuda", None)
        return bool(c) and float(c) >= 12.8
    except Exception:
        return False


# ---------------------------------------------------------------- 算力 vs 构建
# issue #20：`CUDA error: no kernel image is available for execution on the device`；
# torch 轮子里只有**编译时列进去的算力**（cu128 实测 arch_list = sm_70/75/80/86/90/100/120），
# 显卡比它老（Kepler / Maxwell / Pascal，即 GTX 10 系及更早）时：
#   * 驱动层能认出卡 → `torch.cuda.is_available()` 仍为 True（装完的自检照样通过）
#   * 一到真正跑 kernel 就炸，而且是在推理中途异步报出来，用户只看到一句 CUDA 报错
# 所以**必须**在选设备之前把两者比一遍。

def _parse_arch(entry):
    """'sm_86' / 'compute_90' → ('sm'|'compute', 8, 6)；解析不了返回 None。"""
    try:
        kind, num = str(entry).split('_', 1)
        if kind not in ('sm', 'compute') or not num.isdigit() or len(num) < 2:
            return None
        return kind, int(num[:-1]), int(num[-1])
    except Exception:
        return None


def arch_supported(capability, arch_list):
    """设备算力是否落在 torch 构建的 arch 列表里。

    CUDA 的兼容规则（这段逻辑的依据）：
      * `sm_XY` 是**已编译的 cubin**：只能在**同一大版本**、且设备小版本 >= X.Y 上运行
        （sm_86 的 cubin 能在 sm_89 上跑，但跑不了 sm_75 / sm_120）；
      * `compute_XY` 是 PTX：目标算力 >= X.Y 时可即时编译（含跨大版本）。
    两者都不命中 → 运行期才会炸 no kernel image，也就是 issue #20。
    信息不足（拿不到算力或列表为空）时返回 None：调用方按“未知”处理，不下结论。
    """
    if not capability or not arch_list:
        return None
    try:
        maj, mnr = int(capability[0]), int(capability[1])
    except Exception:
        return None
    for entry in arch_list:
        p = _parse_arch(entry)
        if not p:
            continue
        kind, amaj, amnr = p
        if kind == 'sm' and maj == amaj and mnr >= amnr:
            return True
        if kind == 'compute' and (maj, mnr) >= (amaj, amnr):
            return True
    return False


def min_supported_arch(arch_list):
    """arch 列表里最低的 sm 版本 → (major, minor)；没有可解析项时返回 None。"""
    got = []
    for entry in arch_list or []:
        p = _parse_arch(entry)
        if p and p[0] == 'sm':
            got.append((p[1], p[2]))
    return min(got) if got else None


def cuda_error_kind(exc):
    """把 CUDA 运行期报错归类，供「自动改用 CPU」与给用户看的说明使用。"""
    s = str(exc).lower()
    if 'no kernel image' in s or 'no_kernel_image' in s:
        return 'no_kernel_image'
    if 'device-side assert' in s:
        return 'device_assert'
    if 'illegal memory access' in s:
        return 'illegal_memory'
    if 'out of memory' in s:
        return 'oom'
    if 'cuda' in s and ('error' in s or 'failed' in s or 'unsupported' in s):
        return 'cuda_other'
    return ''


def cuda_error_hint(kind):
    """按错误类型给一句可操作的话（界面/日志共用）。"""
    return {
        'no_kernel_image': '显卡算力不在当前 CUDA 推理包支持范围内（已自动改用 CPU）。',
        'device_assert': 'GPU 推理触发设备断言（多为驱动/显存问题），已自动改用 CPU 重跑一次。',
        'illegal_memory': 'GPU 推理出现非法访存（多为驱动问题），已自动改用 CPU 重跑一次。',
        'cuda_other': 'GPU 推理出错，已自动改用 CPU 重跑一次。',
        'oom': '显存不足。',
    }.get(kind, '')


def _probe():
    gpu = {"available": False, "backend": None, "device": "cpu", "name": None,
           "vendor": None, "recommended_backend": "cpu",
           "cuda": False, "mps": False, "directml": False, "onnx_gpu": False,
           "onnx_provider": "CPUExecutionProvider",
           "rocm": False, "hip_version": None}
    disabled = os.environ.get("FUFUMIDI_DISABLE_GPU") == "1"
    if disabled:
        gpu["disabled"] = True
        gpu["note"] = "GPU 增强包未安装，已禁用 GPU 加速"
    # 即使未装增强包也检测显卡厂商：用于界面展示与「安装 GPU 加速」推荐
    vendor = _gpu_vendor()
    if vendor:
        gpu["vendor"] = vendor
        if vendor == "nvidia":
            gpu["name"] = gpu.get("name") or "NVIDIA GPU"
            gpu["recommended_backend"] = "cuda"
        elif vendor in ("amd", "intel"):
            gpu["name"] = gpu.get("name") or vendor.upper() + " GPU"
            gpu["recommended_backend"] = "directml"
    if disabled:
        if vendor:
            gpu["note"] = "检测到 " + (gpu["name"] or vendor.upper()) + "，但未安装 GPU 增强包，可在「设置 → GPU」中一键安装"
        return gpu
    # ---- torch 后端（钢琴 / 分离引擎）----
    try:
        import torch
        if torch.cuda.is_available():
            gpu["available"] = True
            gpu["device"] = "cuda"
            # ROCm 版 torch 把 HIP 映射进 cuda 命名空间（is_available() 也为 True），
            # 唯一可靠区分是 torch.version.hip 非空 —— 必须先判它，否则 AMD 会被当成 NVIDIA。
            hip = getattr(torch.version, "hip", None)
            if hip:
                gpu["backend"] = "rocm"
                gpu["rocm"] = True
                gpu["hip_version"] = str(hip)
                gpu["vendor"] = "amd"
                try:
                    gpu["name"] = torch.cuda.get_device_name(0)
                except Exception:
                    gpu["name"] = "AMD ROCm GPU"
                # ROCm 下 get_device_capability() 返回的是 gfx 版本（如 gfx1100 → 11.0），
                # 与 NVIDIA 的 sm 计算能力不是一回事，绝不能套用 Blackwell 判定。
                gpu["capability"] = None
                gpu["blackwell"] = False
                gpu["need_cu128"] = False
            else:
                gpu["backend"] = "cuda"
                gpu["cuda"] = True
                gpu["vendor"] = "nvidia"
                try:
                    gpu["name"] = torch.cuda.get_device_name(0)
                except Exception:
                    gpu["name"] = "NVIDIA GPU"
                # 计算能力 → 判断是否 Blackwell（RTX 50 系 sm_120 需 CUDA 12.8 / cu128 torch）
                try:
                    cap = tuple(torch.cuda.get_device_capability(0))
                    gpu["capability"] = "%d.%d" % cap
                    gpu["blackwell"] = cap[0] >= 9
                    gpu["need_cu128"] = gpu["blackwell"] and not _torch_is_cu128()
                    # ★ 反向不匹配（issue #20）：卡比轮子老 → 有卡也跑不了 kernel。
                    #   必须显式把 device 降到 cpu，否则引擎照样把活派给 GPU。
                    try:
                        _archs = [str(x) for x in torch.cuda.get_arch_list()]
                    except Exception:
                        _archs = []
                    gpu["torch_arch_list"] = _archs
                    _ok = arch_supported(cap, _archs)
                    gpu["arch_supported"] = _ok
                    if _ok is False:
                        gpu["cuda_usable"] = False
                        _low = min_supported_arch(_archs)
                        gpu["arch_reason"] = (
                            "显卡算力 sm_%d%d 不在当前 CUDA 推理包支持范围内（该包最低支持 %s）"
                            % (cap[0], cap[1],
                               ("sm_%d%d" % _low) if _low else "更新的算力"))
                        gpu["device"] = "cpu"
                except Exception:
                    gpu["capability"] = None
                    gpu["blackwell"] = False
                    gpu["need_cu128"] = False
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
            # onnxruntime-gpu 与 torch 一样是「编译期定算力」：算力不匹配时同样会失败，
            # 所以 arch 不匹配就显式退回 CPUExecutionProvider（basic-pitch 走这条）。
            if gpu.get("arch_supported") is False:
                gpu["onnx_provider"] = "CPUExecutionProvider"
                gpu["note"] = gpu.get("arch_reason") or gpu.get("note")
            else:
                gpu["onnx_gpu"] = True
                gpu["onnx_provider"] = "CUDAExecutionProvider"
    except Exception:
        pass

    # ---- 厂商识别 → 推荐后端：ROCm > CUDA > DirectML ----
    if gpu.get("vendor") is None and not (gpu.get("cuda") or gpu.get("rocm")):
        gpu["vendor"] = _gpu_vendor()
    if gpu.get("rocm"):
        gpu["recommended_backend"] = "rocm"
    elif gpu["cuda"]:
        gpu["recommended_backend"] = "cuda"
    elif gpu.get("directml") or gpu.get("torch_directml"):
        gpu["recommended_backend"] = "directml"
    else:
        gpu["recommended_backend"] = "cpu"
    if gpu.get("rocm"):
        gpu["note"] = "已启用 AMD ROCm 加速（HIP " + str(gpu.get("hip_version") or "") + "）"
    elif gpu["vendor"] == "nvidia" and not gpu["cuda"]:
        gpu["note"] = "检测到 NVIDIA 显卡，但未安装 CUDA 版 torch；改用 CUDA 运行时可显著加速"
    elif gpu["vendor"] == "amd" and not (gpu.get("directml") or gpu.get("torch_directml")):
        gpu["note"] = "检测到 AMD 显卡，建议安装 DirectML 运行时以加速（较新 Radeon 可选 ROCm，需 Python 3.12 运行时）"
    elif gpu["vendor"] == "intel" and not (gpu.get("directml") or gpu.get("torch_directml")):
        gpu["note"] = "检测到 INTEL 显卡，建议安装 DirectML 运行时以加速"
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
                      "onnx_gpu": False, "onnx_provider": "CPUExecutionProvider",
                      "rocm": False, "hip_version": None}
    return _cache


def torch_device():
    """返回适合 torch 的设备字符串：'cuda' / 'privateuseone:0'(DirectML) / 'mps' / 'cpu'。"""
    return detect()["device"]


def onnx_provider():
    """返回 onnxruntime 应优先使用的 ExecutionProvider。"""
    return detect()["onnx_provider"]

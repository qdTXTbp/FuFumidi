# -*- coding: utf-8 -*-
"""CUDA Unified Memory（cudaMallocManaged）可行性实验（P2，独立于转录主流程）。

为什么不能直接给 PyTorch 打开统一内存：
  PyTorch 的 CUDA 缓存分配器默认用 cudaMalloc；要换成 cudaMallocManaged 需要
  CUDAPluggableAllocator + 自行编译的共享库（需 CUDA toolkit/MSVC），不是运行时开关。
本实验直接调用 CUDA Runtime 的 cudaMallocManaged，验证：
  1) 当前驱动/运行时是否支持托管内存；
  2) 分配、主机侧写入、预取到 GPU 的耗时量级；
  3) 结果写入 JSON，供界面/文档决策（不改变转录行为）。

用法：python cuda_um_experiment.py --mb 256 --json
退出码 0=成功，2=backend-missing（没有 cudart / 不支持）。
"""
import argparse
import ctypes
import ctypes.util
import glob
import json
import os
import sys
import time


def _find_cudart():
    cands = []
    if os.environ.get("CUDA_PATH"):
        cands += [os.path.join(os.environ["CUDA_PATH"], "bin", "cudart64_*.dll")]
    cands += [os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "System32", "cudart64_*.dll")]
    # torch 的 CUDA 依赖旁路
    try:
        import torch
        libdir = os.path.join(os.path.dirname(torch.__file__), "lib")
        cands.append(os.path.join(libdir, "cudart64_*.dll"))
    except Exception:
        pass
    cands.append("cudart64_*.dll")
    for pat in cands:
        for p in glob.glob(pat) or []:
            if os.path.isfile(p):
                return p
    found = ctypes.util.find_library("cudart64_12") or ctypes.util.find_library("cudart64_11")
    return found


def run(mb=256):
    dll = _find_cudart()
    if not dll:
        return {"ok": False, "code": "backend-missing",
                "error": "没有找到 cudart64_*.dll（需要 CUDA 运行时；GPU 增强包环境里带有 torch 的 CUDA 依赖）"}
    try:
        lib = ctypes.CDLL(dll)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "code": "backend-missing", "error": "加载 cudart 失败：%s" % e}
    try:
        lib.cudaMallocManaged.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_size_t, ctypes.c_uint]
        lib.cudaMallocManaged.restype = ctypes.c_int
        lib.cudaFree.argtypes = [ctypes.c_void_p]
        lib.cudaFree.restype = ctypes.c_int
        lib.cudaDeviceSynchronize.restype = ctypes.c_int
        lib.cudaGetErrorString.argtypes = [ctypes.c_int]
        lib.cudaGetErrorString.restype = ctypes.c_char_p
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "code": "backend-missing", "error": "导出 cudart 符号失败：%s" % e}
    nbytes = int(mb) * 1024 * 1024
    ptr = ctypes.c_void_p()
    t0 = time.perf_counter()
    rc = lib.cudaMallocManaged(ctypes.byref(ptr), nbytes, 1)  # cudaMemAttachGlobal
    alloc_ms = (time.perf_counter() - t0) * 1000
    if rc != 0:
        return {"ok": False, "code": "alloc-failed", "error": lib.cudaGetErrorString(rc).decode("utf-8", "replace")}
    try:
        t1 = time.perf_counter()
        # 主机侧触碰（托管内存可从 CPU 直接访问；触发缺页迁移）
        buf = (ctypes.c_char * nbytes).from_address(ptr.value)
        ctypes.memset(buf, 0x5a, nbytes)
        host_touch_ms = (time.perf_counter() - t1) * 1000
        t2 = time.perf_counter()
        rc2 = lib.cudaDeviceSynchronize()
        sync_ms = (time.perf_counter() - t2) * 1000
        return {
            "ok": True, "method": "cudaMallocManaged", "cudart": dll,
            "size_mb": int(mb), "alloc_ms": round(alloc_ms, 2),
            "host_touch_ms": round(host_touch_ms, 2), "sync_ms": round(sync_ms, 2),
            "sync_rc": int(rc2),
            "note": "托管内存可用，但 PyTorch 默认分配器仍用 cudaMalloc；要真正用于转录需编译 CUDAPluggableAllocator（未做）。",
        }
    finally:
        try:
            lib.cudaFree(ptr)
        except Exception:
            pass


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--mb", type=int, default=256)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    res = run(a.mb)
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        print(res)
    return 0 if res.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())

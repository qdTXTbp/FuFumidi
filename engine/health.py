# -*- coding: utf-8 -*-
"""全局体检：采集环境 → 逐项判定 → 生成**脱敏**的可粘贴报告。

为什么不是又一个 diag.py：
  diag.py 是「把现成文件打成一个 zip」，用户得先存盘再上传，而且它**不下结论**。
  体检要回答的是「我这台机器哪里不对、下一步该做什么」——
  尤其是 AMD / Intel 用户最常见的「装了加速包但不生效」，
  那种情况 is_available() 为真、任何版本号都看不出来（见 issue #20）。

三条硬要求：
  1. 一键复制：报告是一段纯文本，用户直接粘进 issue
  2. 脱敏：用户名 / 机器名 / 家目录路径一律替换
  3. 每项都有结论：不报「torch 2.13.0+cpu」这种原始值，
     要报「装的是 CPU 版 torch，显卡完全没用上，可在设置 → GPU 安装加速包」

用法：
    python health.py            # 打印 JSON + 人类可读报告
    python health.py --json     # 只打印 JSON
"""
import argparse
import json
import os
import platform
import re
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- 脱敏
def make_redactor():
    """返回 redact(s)。公开 issue 里不该出现用户名/机器名/完整家目录。"""
    home = os.path.expanduser("~")
    user = os.path.basename(home) or ""
    host = ""
    try:
        host = socket.gethostname() or ""
    except Exception:
        pass
    # 需要替换的字面量，按长度从长到短（先换长的，避免短串把长串切碎）
    pairs = []
    for lit, rep in ((home, "<home>"),
                     (home.replace("\\", "/"), "<home>"),
                     (user, "<user>") if len(user) >= 3 else ("", ""),
                     (host, "<host>") if len(host) >= 3 else ("", "")):
        if lit:
            pairs.append((lit, rep))
    pairs.sort(key=lambda x: -len(x[0]))

    def redact(s):
        s = str(s)
        for lit, rep in pairs:
            s = s.replace(lit, rep)
        # 兜底：任何 Users\\xxx / home/xxx 形式
        s = re.sub(r"([A-Za-z]:[\\/]Users[\\/])([^\\/\s]+)", r"\1<user>", s)
        s = re.sub(r"(/home/)([^/\s]+)", r"\1<user>", s)
        return s

    return redact


# ---------------------------------------------------------------- 各分组
def sys_info():
    d = {"os": platform.platform(), "os_release": platform.release(),
         "arch": platform.machine(), "python": sys.version.split()[0],
         "cpu": platform.processor() or "unknown",
         "cpu_count": os.cpu_count()}
    try:
        if os.name == "nt":
            import ctypes

            class _MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            ms = _MS()
            ms.dwLength = ctypes.sizeof(_MS)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
                d["ram_total_gb"] = round(ms.ullTotalPhys / 2 ** 30, 1)
                d["ram_avail_gb"] = round(ms.ullAvailPhys / 2 ** 30, 1)
    except Exception:
        pass
    disks = {}
    for name, path in (("system", os.environ.get("SystemDrive", "C:") + "\\"),
                       ("data", os.environ.get("FUFUMIDI_MODELS_DIR") or "")):
        if not path:
            continue
        try:
            import shutil
            u = shutil.disk_usage(path)
            disks[name] = {"path": path, "free_gb": round(u.free / 2 ** 30, 1),
                           "total_gb": round(u.total / 2 ** 30, 1)}
        except Exception:
            pass
    d["disks"] = disks
    return d


def gpu_info():
    d = {}
    try:
        from engine_gpu import detect
        g = detect() or {}
        for k in ("available", "backend", "device", "name", "vendor", "recommended_backend",
                  "cuda", "rocm", "xpu", "directml", "mps", "cuda_usable",
                  "arch_supported", "arch_reason", "need_cu128", "blackwell",
                  "capability", "torch_arch_list", "onnx_provider", "onnx_gpu", "note"):
            if k in g:
                d[k] = g[k]
    except Exception as e:
        d["detect_error"] = str(e)
    # 加速包（隔离 site-packages 通过环境变量挂进来）
    try:
        d["installed_kinds"] = [x for x in (os.environ.get("FUFUMIDI_GPU_KINDS") or "").split(",") if x]
    except Exception:
        pass
    try:
        import torch
        d["torch"] = torch.__version__
        d["torch_cuda_build"] = getattr(torch.version, "cuda", None)
        d["torch_hip_build"] = getattr(torch.version, "hip", None)
        try:
            d["torch_arch_list"] = list(torch.cuda.get_arch_list()) if torch.cuda.is_available() else []
        except Exception:
            pass
        for mod, attr in (("torch.xpu", "xpu"),):
            try:
                m = __import__(mod, fromlist=["x"])
                d["xpu_available"] = bool(m.is_available())
                if d["xpu_available"]:
                    d["xpu_name"] = m.get_device_name(0)
            except Exception:
                pass
    except Exception as e:
        d["torch_error"] = str(e)
    try:
        import onnxruntime as ort
        d["onnx_providers"] = list(ort.get_available_providers())
    except Exception:
        pass
    return d


def compute_check():
    """在某设备上真跑一次矩阵乘并与 CPU 对拍。

    这是体检里最有说服力的一项：AMD / Intel 用户最常见的失败是
    「驱动认卡、is_available() 为真，但轮子里没有这颗卡的 kernel」（issue #20），
    版本号看不出来，只有真算一遍才暴露。
    """
    out = {"tested": False}
    try:
        import torch
    except Exception as e:
        out["error"] = "torch 不可用：" + str(e)
        return out
    try:
        from engine_gpu import detect
        dev = (detect() or {}).get("device") or "cpu"
    except Exception:
        dev = "cpu"
    if dev == "cpu":
        out["device"] = "cpu"
        out["note"] = "当前按 CPU 运行，无需算力校验"
        return out
    out["device"] = dev
    out["tested"] = True
    try:
        torch.manual_seed(0)
        a = torch.randn(256, 256)
        b = torch.randn(256, 256)
        ref = a @ b
        got = (a.to(dev) @ b.to(dev)).to("cpu")
        try:
            if dev == "cuda":
                torch.cuda.synchronize()
            elif dev == "xpu":
                torch.xpu.synchronize()
        except Exception:
            pass
        diff = float((got - ref).abs().max())
        out["max_diff"] = diff
        out["ok"] = bool(diff < 1e-2)
        if not out["ok"]:
            out["error"] = "设备上算出来的结果和 CPU 对不上（max diff %g）" % diff
    except Exception as e:
        out["ok"] = False
        out["error"] = str(e)[:300]
    return out


KEY_DEPS = ("torch", "torchaudio", "onnxruntime", "muscriptor", "piano_transcription_inference",
            "librosa", "soundfile", "numpy", "transformers")


def runtime_info():
    d = {"python": sys.version.split()[0], "deps": {}}
    for name in KEY_DEPS:
        try:
            m = __import__(name)
            d["deps"][name] = {"ok": True, "version": getattr(m, "__version__", "?"),
                               "path": getattr(m, "__file__", "")}
        except Exception as e:
            d["deps"][name] = {"ok": False, "error": str(e)[:120]}
    d["env"] = {k: v for k, v in os.environ.items()
                if k.startswith(("FUFUMIDI_", "PYTHON", "OMP_", "MKL_", "CUDA_", "ONEAPI_", "ZE_"))}
    return d


MODEL_SPECS = (
    ("muscriptor/small", "muscriptor/small/model.safetensors"),
    ("muscriptor/medium", "muscriptor/medium/model.safetensors"),
    ("muscriptor/large", "muscriptor/large/model.safetensors"),
    ("beat_this", "hub/checkpoints/beat_this-final0.ckpt"),
)


def model_info():
    base = os.environ.get("FUFUMIDI_MODELS_DIR") or ""
    d = {"models_dir_set": bool(base), "items": {}}
    if not base:
        return d
    for label, rel in MODEL_SPECS:
        p = os.path.join(base, rel.replace("/", os.sep))
        d["items"][label] = {"present": os.path.isfile(p) and os.path.getsize(p) > 0,
                             "mb": round(os.path.getsize(p) / 2 ** 20, 1) if os.path.isfile(p) else 0}
    # aria_amt 是目录里找 *.safetensors
    try:
        ad = os.path.join(base, "aria_amt")
        found = []
        for root, _dirs, files in os.walk(ad):
            for f in files:
                if f.endswith(".safetensors"):
                    found.append(f)
        d["items"]["aria_amt"] = {"present": bool(found), "files": found[:5]}
    except Exception:
        pass
    return d


ERR_PAT = re.compile(r"(Traceback \(most recent call last\)|\bERROR\b|CUDA error|no kernel image|OutOfMemory|RuntimeError)", re.I)


def recent_errors(limit=8):
    import glob
    import tempfile
    base = os.path.join(tempfile.gettempdir(), "fufumidi")
    hits = []
    files = glob.glob(os.path.join(base, "*.log")) + glob.glob(os.path.join(base, "*.txt"))
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for p in files[:5]:
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()[-400:]
        except Exception:
            continue
        for i, ln in enumerate(lines):
            if ERR_PAT.search(ln):
                ctx = "".join(lines[i:i + 3]).strip().replace("\n", " | ")
                hits.append({"file": os.path.basename(p), "line": ctx[:300]})
    return hits[-limit:]


# ---------------------------------------------------------------- 判定
def verdicts(rep):
    """把原始值翻译成「结论 + 下一步」。这是体检和 diag.py 的本质区别。"""
    v = []
    g = rep.get("gpu", {})
    vendor = g.get("vendor")
    name = g.get("name")
    if vendor is None and not g.get("available"):
        v.append(("info", "系统", "没有检测到独立显卡，按 CPU 运行（不影响功能，只是慢）"))
    elif not g.get("available") and vendor:
        want = {"nvidia": "CUDA", "amd": "DirectML 或 ROCm", "intel": "Intel XPU 或 DirectML"}.get(vendor, "DirectML")
        v.append(("warn", "显卡", "检测到 %s（%s），但显卡加速没启用 —— 可在「设置 → GPU」安装 %s 加速包"
                  % (name or vendor, vendor, want)))
    elif g.get("available"):
        v.append(("ok", "显卡", "加速已启用：%s（后端 %s，设备 %s）" % (name or "?", g.get("backend"), g.get("device"))))
    if g.get("arch_supported") is False:
        v.append(("warn", "显卡", "这张卡的算力不在当前加速包支持范围内：%s"
                  % (g.get("arch_reason") or "算力不匹配")))
    if g.get("need_cu128"):
        v.append(("warn", "显卡", "这是 Blackwell 显卡（RTX 50 系），需要 CUDA 12.8+ 的加速包"))
    cc = rep.get("compute_check", {})
    if cc.get("tested"):
        if cc.get("ok"):
            v.append(("ok", "算力校验", "在 %s 上真跑了一次矩阵乘，与 CPU 结果一致（max diff %.2g）"
                      % (cc.get("device"), cc.get("max_diff", 0))))
        else:
            v.append(("error", "算力校验", "在 %s 上跑不动或结果不对：%s —— 这通常意味着加速包里的 kernel "
                      "不支持这张卡，应用会自动改用 CPU" % (cc.get("device"), cc.get("error"))))
    tw = g.get("torch")
    if tw and tw.endswith("+cpu") and vendor == "nvidia":
        v.append(("warn", "运行时", "装的是 CPU 版 torch（%s），显卡完全没用上" % tw))
    rt = rep.get("runtime", {}).get("deps", {})
    bad = [k for k, x in rt.items() if not x.get("ok")]
    if bad:
        v.append(("warn", "运行时", "这些依赖导入失败：%s" % ", ".join(bad)))
    mi = rep.get("models", {})
    if not mi.get("models_dir_set"):
        v.append(("warn", "模型", "没有设置 FUFUMIDI_MODELS_DIR，无法检查模型权重"))
    else:
        miss = [k for k, x in mi.get("items", {}).items() if not x.get("present")]
        if miss:
            v.append(("info", "模型", "未下载的模型：%s（用到时再到资源中心下载即可）" % ", ".join(miss)))
        else:
            v.append(("ok", "模型", "内置转录模型权重齐全"))
    si = rep.get("system", {})
    for nm, dk in si.get("disks", {}).items():
        if dk.get("free_gb", 999) < 5:
            v.append(("warn", "磁盘", "%s 盘只剩 %.1f GB，模型下载/导出可能失败" % (nm, dk["free_gb"])))
    errs = rep.get("recent_errors", [])
    if errs:
        v.append(("info", "日志", "最近日志里有 %d 条可疑错误（见报告末尾）" % len(errs)))
    else:
        v.append(("ok", "日志", "最近日志里没有发现 Traceback / CUDA error"))
    return v


ICON = {"ok": "[OK]  ", "warn": "[注意]", "error": "[失败]", "info": "[信息]"}


def render_text(rep, redact):
    L = []
    L.append("FuFumidi 全局体检报告")
    L.append("生成时间：" + rep.get("time", ""))
    L.append("应用版本：" + (rep.get("app_version") or "(未知)"))
    L.append("")
    L.append("== 结论 ==")
    for level, group, msg in rep.get("verdicts", []):
        L.append("%s %s：%s" % (ICON.get(level, "[?]"), group, msg))
    L.append("")
    L.append("== 系统 ==")
    si = rep.get("system", {})
    L.append("系统：%s（%s）" % (si.get("os"), si.get("arch")))
    L.append("CPU：%s，%s 逻辑核" % (si.get("cpu"), si.get("cpu_count")))
    if si.get("ram_total_gb"):
        L.append("内存：%.1f GB（可用 %.1f GB）" % (si["ram_total_gb"], si.get("ram_avail_gb", 0)))
    for nm, dk in (si.get("disks") or {}).items():
        L.append("磁盘(%s)：剩余 %.1f / %.1f GB" % (nm, dk.get("free_gb", 0), dk.get("total_gb", 0)))
    L.append("")
    L.append("== 显卡与加速 ==")
    g = rep.get("gpu", {})
    for k in ("vendor", "name", "backend", "device", "available", "cuda_usable",
              "arch_supported", "arch_reason", "need_cu128", "capability",
              "installed_kinds", "torch", "torch_cuda_build", "torch_arch_list",
              "xpu_available", "xpu_name", "onnx_provider", "onnx_providers", "note"):
        if k in g and g[k] not in (None, "", [], {}):
            L.append("  %-18s %s" % (k, g[k]))
    L.append("")
    L.append("== 算力校验 ==")
    cc = rep.get("compute_check", {})
    L.append(json.dumps(cc, ensure_ascii=False))
    L.append("")
    L.append("== 运行时 ==")
    L.append("Python " + str(rep.get("runtime", {}).get("python", "?")))
    for k, x in (rep.get("runtime", {}).get("deps") or {}).items():
        L.append("  %-30s %s" % (k, (x.get("version") if x.get("ok") else "缺失: " + str(x.get("error", ""))[:60])))
    env = rep.get("runtime", {}).get("env") or {}
    if env:
        L.append("  环境变量：")
        for k in sorted(env):
            L.append("    %s=%s" % (k, env[k]))
    L.append("")
    L.append("== 模型资源 ==")
    for k, x in (rep.get("models", {}).get("items") or {}).items():
        L.append("  %-22s %s" % (k, ("%.1f MB" % x["mb"]) if x.get("present") and x.get("mb") else ("有" if x.get("present") else "未下载")))
    errs = rep.get("recent_errors") or []
    L.append("")
    L.append("== 最近错误（%d 条）==" % len(errs))
    for e in errs:
        L.append("  [%s] %s" % (e["file"], e["line"]))
    if not errs:
        L.append("  （无）")
    txt = "\n".join(L)
    return redact(txt)


def collect():
    redact = make_redactor()
    rep = {"time": time.strftime("%Y-%m-%d %H:%M:%S"),
           "app_version": os.environ.get("FUFUMIDI_APP_VERSION", ""),
           "system": sys_info(), "gpu": gpu_info(), "compute_check": compute_check(),
           "runtime": runtime_info(), "models": model_info(), "recent_errors": recent_errors()}
    rep["verdicts"] = verdicts(rep)
    # 落盘前统一过一遍脱敏（路径、环境变量里都可能带用户名）
    rep_json = redact(json.dumps(rep, ensure_ascii=False, default=str))
    rep = json.loads(rep_json)
    rep["report_text"] = render_text(rep, redact)
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    args = ap.parse_args()
    try:
        rep = collect()
    except Exception as e:
        print("###RESULT " + json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1
    if not args.json:
        print(rep["report_text"])
    print("###RESULT " + json.dumps({"ok": True, "report": rep}, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

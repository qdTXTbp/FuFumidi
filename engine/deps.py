# -*- coding: utf-8 -*-
"""FuFumidi 运行期依赖检测 / 自动补全。

- 不重写引擎：只检查并安装缺失的 Python 依赖。
- 国内直连友好：默认使用清华/阿里镜像，失败自动回退官方 PyPI。
- 完整包应已包含全部依赖；基础包缺失时可一键补全。
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys

def _patch_tqdm_compat():
    try:
        from tqdm.auto import tqdm as _tqdm_cls
        import threading
        if not hasattr(_tqdm_cls, "set_lock"):
            _tqdm_cls.set_lock = lambda lock: None
        if not hasattr(_tqdm_cls, "get_lock"):
            _tqdm_cls.get_lock = lambda: threading.RLock()
    except Exception:
        pass

_patch_tqdm_compat()

REQUIRED = {
    "universal": [
        "numpy", "scipy", "librosa", "soundfile", "pretty_midi", "tqdm",
        "onnxruntime", "basic_pitch", "mir_eval", "resampy",
    ],
    "piano": [
        "torch", "piano_transcription_inference",
    ],
    "separate": [
        "torch", "demucs",
    ],
    # 转录模型运行时：模型权重已下载，仍需对应推理包才能转录
    "muscriptor": [
        "muscriptor",
    ],
    "aria": [
        "ariautils",
    ],
    "transkun": [
        "transkun",
    ],
}

MIRRORS = [
    None,
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple",
    "https://pypi.org/simple",
]

# 特殊安装源：常规 pip 镜像装不了的组（不在 PyPI），从 git 源码安装整个包
GIT_SOURCES = {
    "aria": "git+https://github.com/EleutherAI/aria-amt.git",
}


def _find(name):
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


def _emit(obj):
    print("###RESULT " + json.dumps(obj, ensure_ascii=False), flush=True)


def check():
    result = {"python": sys.executable, "groups": {}}
    for group, pkgs in REQUIRED.items():
        missing = [p for p in pkgs if not _find(p)]
        result["groups"][group] = {"ok": len(missing) == 0, "missing": missing}
    _emit(result)
    return 0


def install(group=None):
    groups = REQUIRED if group in (None, "all") else {group: REQUIRED[group]}
    last_err = None
    for g, pkgs in groups.items():
        missing = [p for p in pkgs if not _find(p)]
        if not missing:
            continue
        # 组走 git 源码安装（包不在 PyPI）
        if g in GIT_SOURCES:
            cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-q", GIT_SOURCES[g]]
            ok = False
            for _ in range(2):
                try:
                    r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
                    if r.returncode == 0:
                        _emit({"ok": True, "installed": missing, "group": g, "source": "git"})
                        ok = True
                        break
                    last_err = (r.stderr or r.stdout or "").strip()[-500:]
                except Exception as e:
                    last_err = str(e)
            if not ok:
                _emit({"ok": False, "error": last_err or "安装失败（请确认系统已安装 git）", "group": g})
                return 1
            continue
        # 常规 pip 安装 + 镜像回退
        installed = False
        for mirror in MIRRORS:
            cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-q"]
            if mirror:
                cmd += ["-i", mirror]
            cmd += missing
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
                if r.returncode == 0:
                    _emit({"ok": True, "installed": missing, "group": g})
                    installed = True
                    break
                last_err = (r.stderr or r.stdout or "").strip()[-500:]
            except Exception as e:
                last_err = str(e)
        if not installed:
            _emit({"ok": False, "error": last_err or "安装失败", "group": g})
            return 1
    _emit({"ok": True, "installed": []})
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["check", "install"])
    ap.add_argument("--group", default=None, choices=["universal", "piano", "separate", "muscriptor", "aria", "transkun", "all"])
    args = ap.parse_args()
    if args.cmd == "check":
        sys.exit(check())
    sys.exit(install(args.group))

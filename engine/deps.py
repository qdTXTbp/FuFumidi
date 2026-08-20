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
}

MIRRORS = [
    None,
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple",
    "https://pypi.org/simple",
]


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
    pkgs = []
    groups = REQUIRED if group in (None, "all") else {group: REQUIRED[group]}
    for g, p in groups.items():
        for pkg in p:
            if not _find(pkg):
                pkgs.append(pkg)
    if not pkgs:
        _emit({"ok": True, "installed": []})
        return 0

    last_err = None
    for mirror in MIRRORS:
        cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-q"]
        if mirror:
            cmd += ["-i", mirror]
        cmd += pkgs
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
            if r.returncode == 0:
                _emit({"ok": True, "installed": pkgs})
                return 0
            last_err = (r.stderr or r.stdout or "").strip()[-500:]
        except Exception as e:
            last_err = str(e)

    _emit({"ok": False, "error": last_err or "安装失败"})
    return 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["check", "install"])
    ap.add_argument("--group", default=None, choices=["universal", "piano", "separate", "all"])
    args = ap.parse_args()
    if args.cmd == "check":
        sys.exit(check())
    sys.exit(install(args.group))

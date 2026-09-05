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
        "pymss", "pydub", "beartype", "ml_collections", "omegaconf", "einops",
    ],
    # 转录模型运行时：模型权重已下载，仍需对应推理包才能转录
    "muscriptor": [
        "muscriptor",
    ],
    # aria-amt 提供模块 amt；ariautils 是它的配套工具库；safetensors/orjson 为推理所需小依赖
    "aria": [
        "amt", "ariautils", "safetensors", "orjson",
    ],
    "transkun": [
        "transkun",
    ],
}

# 镜像顺序：国内快源优先（默认源/PyPI 在部分网络下超时缓慢，放最后兜底）
MIRRORS = [
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple",
    "https://pypi.org/simple",
    None,
]

# pip 公共参数：短超时+低重试，让不可用的源快速失败并切换到下一个镜像
PIP_BASE = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-q",
            "--timeout", "30", "--retries", "3"]

# 特殊安装源：不在 PyPI 的包，从 git 源码安装（按包名映射）
GIT_SOURCES = {
    "amt": "git+https://github.com/EleutherAI/aria-amt.git",
    "ariautils": "git+https://github.com/EleutherAI/aria-utils.git",
}
# aria-amt 声明的 torchaudio<=2.5 会强制降级现有 torch/torchaudio，
# 必须 --no-deps 装本体，再单独装缺失依赖（torch/torchaudio 已在环境内）
GIT_NO_DEPS = {"amt"}


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


def _pip_run(cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        return r.returncode == 0, (r.stderr or r.stdout or "").strip()[-500:]
    except Exception as e:
        return False, str(e)


def install(group=None):
    groups = REQUIRED if group in (None, "all") else {group: REQUIRED[group]}
    last_err = None
    for g, pkgs in groups.items():
        missing = [p for p in pkgs if not _find(p)]
        if not missing:
            continue
        # aria 组：git 包 + 普通 pip 小依赖混合安装
        if g == "aria":
            ok = True
            for m in missing:
                if m in GIT_SOURCES:
                    cmd = list(PIP_BASE)
                    if m in GIT_NO_DEPS:
                        cmd.append("--no-deps")
                    cmd.append(GIT_SOURCES[m])
                    ok, last_err = _pip_run(cmd)
                else:
                    ok = False
                    for mirror in MIRRORS:
                        cmd = list(PIP_BASE)
                        if mirror:
                            cmd += ["-i", mirror]
                        cmd.append(m)
                        ok, last_err = _pip_run(cmd)
                        if ok:
                            break
                if not ok:
                    _emit({"ok": False, "error": last_err or "安装失败（请确认系统已安装 git）", "group": g})
                    return 1
            _emit({"ok": True, "installed": missing, "group": g})
            continue
        # 常规 pip 安装 + 镜像回退
        installed = False
        for mirror in MIRRORS:
            cmd = list(PIP_BASE)
            if mirror:
                cmd += ["-i", mirror]
            cmd += missing
            ok, last_err = _pip_run(cmd)
            if ok:
                _emit({"ok": True, "installed": missing, "group": g})
                installed = True
                break
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

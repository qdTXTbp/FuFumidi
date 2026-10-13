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
import shutil
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

# 特殊安装源：不在 PyPI 的包，从 git 源码安装（按包名映射）。
# GitHub 直连在国内常长时间无进展/超时，故提供多个 GitHub 代理镜像前缀；
# GIT_SOURCES 只放仓库 path（author/repo），安装时依次尝试各镜像再回退官方。
GIT_SOURCES = {
    "amt": "EleutherAI/aria-amt",
    "ariautils": "EleutherAI/aria-utils",
}
# 镜像顺序：国内 GitHub 加速优先（gh.jasonzeng.dev 与应用内其它下载源一致）；最后为官方直连兜底
GIT_MIRROR_PREFIXES = [
    "https://gh.jasonzeng.dev/https://github.com/",
    "https://ghfast.top/https://github.com/",
    "https://gh-proxy.com/https://github.com/",
    "https://github.com/",
]
# aria-amt 声明的 torchaudio<=2.5 会强制降级现有 torch/torchaudio，
# 必须 --no-deps 装本体，再单独装缺失依赖（torch/torchaudio 已在环境内）
GIT_NO_DEPS = {"amt"}

# zip 兜底时仓库默认分支名不统一（main / master），两个都试
ARCHIVE_REFS = ["main", "master"]

# ★ MuScriptor 必须装「修复版」——不能从 PyPI 按包名装。
#   上游 0.3.0 的 OpenNoteTracker 在长音频上会产出「僵尸音符」：块边界只关闭不在
#   tie 段里的音，而 prelude_forcing 把 tie 段构造成「当前还开着的音」，于是块边界
#   永远关不掉任何音符，模型漏一次收尾就被无限延续 —— 实测 100 分钟交响录播出现
#   4320 秒（全曲 72%）的音符。修复版 wheel 托管在 monologue82/Models
#   （见该仓库 muscriptor-runtime/README.md），PyPI 上仍是未修复的 0.3.0。
#   注意 %2B = 文件名里的 + （PEP 440 本地版本号），别写成裸 +。
MUSCRIPTOR_WHEEL_PATH = ("monologue82/Models/main/muscriptor-runtime/"
                         "muscriptor-0.3.0%2Bfufumidi.1-py3-none-any.whl")
MUSCRIPTOR_SHA256 = "11828351ae24f22024f7a16f5f093a4192f3826165f459a4fcc134ac7224bae6"
# raw 文件的 GitHub 加速前缀（与 main/models.js 的 RAW 镜像同源）
RAW_MIRROR_PREFIXES = [
    "https://gh.jasonzeng.dev/https://raw.githubusercontent.com/",
    "https://ghfast.top/https://raw.githubusercontent.com/",
    "https://gh-proxy.com/https://raw.githubusercontent.com/",
    "https://raw.githubusercontent.com/",
]


def _aria_specs(pkg):
    """aria 组两个 GitHub 包的候选安装目标。

    用户机一般没装 git，而 pip 的 git+ 必须有 git 可执行文件才能用——
    这正是「一键补全 aria 组永远失败」的原因。所以优先试 git+，
    git 不可用时改用源码 zip：pip 支持直接从 archive 的 zip URL 安装，
    只需要 HTTPS，不需要 git。
    """
    repo = GIT_SOURCES[pkg]
    specs = []
    if shutil.which("git"):
        specs += ["git+" + p + repo + ".git" for p in GIT_MIRROR_PREFIXES]
    for p in GIT_MIRROR_PREFIXES:
        for ref in ARCHIVE_REFS:
            specs.append(p + repo + "/archive/refs/heads/" + ref + ".zip")
    return specs


# 需要「真实导入」才能确认健康的包：这些是公共基础依赖，最容易出现
# 「文件在、但版本混杂导致 import 崩溃」的情况（issue #18：NumPy 2.4.6 缺 numpy.exceptions）。
# 其余包用 find_spec 判断即可，避免每次都把 torch 等重包完整导入拖慢自检。
DEEP_PROBE = {
    "numpy", "scipy", "soundfile", "pretty_midi", "librosa",
    "onnxruntime", "torch", "muscriptor",
}


def _status(name):
    """返回 'ok' / 'missing' / 'broken'。

    'broken' 指包能定位到（find_spec 成功）但实际 import 抛异常——
    此时 find_spec 会误判为「已安装」，导致补全依赖跳过它、永远修不好。
    """
    try:
        if importlib.util.find_spec(name) is None:
            return "missing"
    except Exception:
        return "missing"
    if name in DEEP_PROBE:
        try:
            importlib.import_module(name)
        except Exception:
            return "broken"
    return "ok"


def _find(name):
    return _status(name) == "ok"


# ★ 身份校验（2026-10-13 加）：muscriptor 的「僵尸音符」修复是**上游级补丁**，
#   而 PyPI 上只有裸 0.3.0。只做 import 探测会把裸版判成 ok —— 3.12 运行时
#   因此静默少了这个修复（跨块 tie 段等不到 note-off，音符越滚越长）。
#   所以这里查的是**补丁在不在**，不是包在不在。
#   判据用补丁引入的符号而不是文件哈希：用户自己重装/升级后哈希会变，
#   但只要补丁语义还在就不该报错；反过来裸版一定没有这个符号。
MUSCRIPTOR_PATCH_MARKER = "DEFAULT_MAX_NOTE_HOLD_SEC"


def _muscriptor_patch_missing():
    """返回 True 表示 muscriptor 装了，但**没有** FuFumidi 补丁。"""
    try:
        import muscriptor.events as ev
    except Exception:
        return False        # 缺失/损坏已由 _status 报出，不重复报
    return not hasattr(ev, MUSCRIPTOR_PATCH_MARKER)


def _emit(obj):
    print("###RESULT " + json.dumps(obj, ensure_ascii=False), flush=True)


def check():
    result = {"python": sys.executable, "groups": {}}
    for group, pkgs in REQUIRED.items():
        missing, broken = [], []
        for p in pkgs:
            st = _status(p)
            if st == "missing":
                missing.append(p)
            elif st == "broken":
                broken.append(p)
        # 身份校验：包在 ≠ 是对的那个构建（muscriptor 的补丁版 vs 裸上游版）
        wrong_build = []
        if group == "muscriptor" and not missing and not broken:
            if _muscriptor_patch_missing():
                wrong_build.append("muscriptor(缺 FuFumidi 补丁: " + MUSCRIPTOR_PATCH_MARKER + ")")
        result["groups"][group] = {
            "ok": not missing and not broken and not wrong_build,
            "missing": missing,
            "broken": broken + wrong_build,   # 已安装但导入失败 / 或装错了构建
        }
    _emit(result)
    return 0


def _pip_run(cmd, timeout=600):
    # 每个镜像 600s 上限：单个源慢/挂起时快速切下一个，避免无限等待
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, (r.stderr or r.stdout or "").strip()[-500:]
    except subprocess.TimeoutExpired:
        return False, "安装超时（超过 %ss），已尝试切换下一个源" % timeout
    except Exception as e:
        return False, str(e)


def install(group=None):
    groups = REQUIRED if group in (None, "all") else {group: REQUIRED[group]}
    last_err = None
    for g, pkgs in groups.items():
        missing, broken = [], []
        for p in pkgs:
            st = _status(p)
            if st == "missing":
                missing.append(p)
            elif st == "broken":
                broken.append(p)
        # 损坏（能找到但导入失败，例如半更新过的 numpy）必须强制重装覆盖，
        # 否则 pip 认为「已满足要求」直接跳过，用户重装多少次都没用（issue #18）。
        if broken:
            ok = False
            for mirror in MIRRORS:
                cmd = list(PIP_BASE) + ["--force-reinstall", "--no-cache-dir"]
                if mirror:
                    cmd += ["-i", mirror]
                cmd += broken
                ok, last_err = _pip_run(cmd)
                if ok:
                    break
            if not ok:
                _emit({"ok": False, "error": last_err or "修复损坏依赖失败", "group": g})
                return 1
        if not missing:
            if broken:
                _emit({"ok": True, "repaired": broken, "group": g})
            continue
        # aria 组：git 包（走 GitHub 镜像回退）+ 普通 pip 小依赖混合安装
        if g == "aria":
            ok = True
            for m in missing:
                if m in GIT_SOURCES:
                    ok = False
                    for spec in _aria_specs(m):
                        cmd = list(PIP_BASE)
                        if m in GIT_NO_DEPS:
                            cmd.append("--no-deps")
                        cmd.append(spec)
                        ok, last_err = _pip_run(cmd)
                        if ok:
                            break
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
                    _emit({"ok": False, "error": last_err or "安装失败（GitHub 各镜像与官方源均不可达）", "group": g})
                    return 1
            _emit({"ok": True, "installed": missing, "group": g})
            continue
        # muscriptor：装我们托管的修复版 wheel（PyPI 上是未修复的 0.3.0）
        if g == "muscriptor" and missing:
            ok = False
            for pre in RAW_MIRROR_PREFIXES:
                cmd = list(PIP_BASE)
                if MIRRORS and MIRRORS[0]:
                    cmd += ["-i", MIRRORS[0]]
                cmd.append(pre + MUSCRIPTOR_WHEEL_PATH)
                ok, last_err = _pip_run(cmd)
                if ok:
                    break
            if ok:
                _emit({"ok": True, "installed": ["muscriptor 0.3.0+fufumidi.1（修复版）"], "group": g})
            else:
                _emit({"ok": False, "group": g,
                       "error": last_err or "下载修复版 muscriptor 失败（GitHub 各镜像均不可达）"})
                return 1
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

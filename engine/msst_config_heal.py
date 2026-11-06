# -*- coding: utf-8 -*-
"""MSST / MuScriptor 配置自愈（Tauri 壳的 engine 侧入口）。

查找顺序（严格按此顺序，失败就往下走；每一步都必须通过结构校验才返回，绝不假成功）
================================================================================
  1. 模型目录里自带的 .yaml
  2. <root>/models/_configs/ 里匹配的 .yaml
  3. engine/msst_configs/index.json 命中的内置 .yaml → 复制到 <root>/models/_configs/
  4. 上游 configs/（GitHub raw 的 monologue82/Models/configs/ 或 CNB 镜像）→ 缓存到 _configs
  5. engine/msst_autoconfig.py 用权重现场生成（model_path + arch）

stdout 只输出一行 JSON：
    {"ok": true,  "config": "<yaml 绝对路径>", "from": "model|cache|builtin|upstream|generated"}
    {"ok": false, "error": "..."}

CLI：
    python msst_config_heal.py --root <dataRoot> --model <权重路径> [--arch <架构名>]

校验口径
========
配置文件必须存在、非空、且含顶层 model 段（PyYAML 未安装时用文本匹配），
否则视为不可用 —— 宁可报错也不把坏 yaml 交给分离引擎。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "FuFumidi"
HTTP_TIMEOUT = 20
HTTP_MAX_BYTES = 2 * 1024 * 1024
AUTOCONFIG_TIMEOUT = 1800
MAX_HTTP_ATTEMPTS = 2

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
#: 内置元数据目录（index.json + 旧安装兜底 yaml）；测试里可替换
BUNDLED_DIR = os.path.join(SCRIPT_DIR, "msst_configs")
AUTOCONFIG = os.path.join(SCRIPT_DIR, "msst_autoconfig.py")

#: 上游 configs/ 目录的两个镜像前缀
UPSTREAM_PREFIXES = [
    "https://raw.githubusercontent.com/monologue82/Models/main/configs/",
    "https://cnb.cool/FuFuCloud-mirror/Models/-/git/raw/main/configs/",
]

_MODEL_KEY_RE = re.compile(r"(?m)^\s*[\"']?model[\"']?\s*:")


def _sleep(seconds):
    """退避用的 sleep；测试里替换成 no-op。"""
    time.sleep(max(0.0, float(seconds)))


def _setup_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _log(msg):
    try:
        sys.stderr.write("[msst_config_heal] %s\n" % msg)
        sys.stderr.flush()
    except Exception:
        pass


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# YAML 选择 / 校验
# ---------------------------------------------------------------------------
def _norm_cfg(name):
    """与 main/models.js 的 normCfg 同口径：去扩展名、去 config 前缀、只留字母数字。"""
    s = str(name or "").strip().lower()
    s = re.sub(r"\.ya?ml$", "", s)
    s = re.sub(r"^config[_-]?", "", s)
    return re.sub(r"[^a-z0-9]+", "", s)


def _list_yml(directory):
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    return [n for n in names if n.lower().endswith((".yaml", ".yml")) and os.path.isfile(os.path.join(directory, n))]


def _pick_yml(directory, want):
    """在一个目录里挑配置：精确 → 宽松包含 → 只有一个就用它（对齐 pickYml）。"""
    files = _list_yml(directory)
    if not files:
        return None
    w = _norm_cfg(want)
    if w:
        for f in files:
            if _norm_cfg(f) == w:
                return os.path.join(directory, f)
        for f in files:
            n = _norm_cfg(f)
            if n and (n in w or w in n):
                return os.path.join(directory, f)
    if len(files) == 1:
        return os.path.join(directory, files[0])
    return None


def _validate_text(text):
    """返回 (ok, 原因)。只认「非空 + 有顶层 model 段」。"""
    if not text or len(text.strip()) < 32:
        return False, "内容过小"
    if not _MODEL_KEY_RE.search(text):
        return False, "缺少 model 段"
    return True, ""


def _validate_config(path):
    try:
        if not os.path.isfile(path):
            return False, "文件不存在"
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(HTTP_MAX_BYTES + 1)
    except OSError as e:
        return False, "读取失败：%s" % e
    if len(text) > HTTP_MAX_BYTES:
        return False, "文件过大"
    return _validate_text(text)


def _load_index():
    try:
        with open(os.path.join(BUNDLED_DIR, "index.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _entry_for(model_path, index):
    """按权重文件名在 index.json 里找条目（接受文件名/去扩展名/大小写差异）。"""
    base = os.path.basename(str(model_path or ""))
    if base in index and isinstance(index[base], dict):
        return index[base]
    low = base.lower()
    for k, v in index.items():
        if isinstance(v, dict) and str(k).lower() == low:
            return v
    stem = os.path.splitext(low)[0]
    for k, v in index.items():
        if isinstance(v, dict) and os.path.splitext(str(k).lower())[0] == stem:
            return v
    return {}


def _configs_dir(root):
    return os.path.join(root, "models", "_configs")


def _write_bytes(path, data):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _copy_file(src, dst):
    if os.path.abspath(src) == os.path.abspath(dst):
        return dst
    directory = os.path.dirname(dst)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = dst + ".tmp"
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)
    return dst


# ---------------------------------------------------------------------------
# 传输层（只用于上游 configs/）
# ---------------------------------------------------------------------------
def _opener_for(url):
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if host in ("127.0.0.1", "localhost", "::1"):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


def _http_get(url):
    last = None
    for attempt in range(MAX_HTTP_ATTEMPTS):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with _opener_for(url).open(req, timeout=HTTP_TIMEOUT) as r:
                data = r.read(HTTP_MAX_BYTES + 1)
            if len(data) > HTTP_MAX_BYTES:
                raise RuntimeError("配置过大：%s" % url)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429 or 500 <= e.code < 600:
                last = e
                if attempt < MAX_HTTP_ATTEMPTS - 1:
                    _sleep(0.5)
                continue
            raise
        except Exception as e:
            last = e
            if attempt < MAX_HTTP_ATTEMPTS - 1:
                _sleep(0.5)
            continue
    raise RuntimeError("请求失败：%s（%s）" % (url, last))


def _try_upstream(cache_dir, want):
    """从上游 configs/ 取 <want>，校验后缓存到 _configs；失败返回 None。"""
    if not want:
        return None
    name = os.path.basename(want)
    for pre in UPSTREAM_PREFIXES:
        url = pre + urllib.parse.quote(name)
        try:
            data = _http_get(url)
            text = data.decode("utf-8", "replace")
            ok, why = _validate_text(text)
            if not ok:
                _log("上游配置不可用 %s：%s" % (url, why))
                continue
            dst = os.path.join(cache_dir, name)
            _write_bytes(dst, data)
            _log("已缓存上游配置：%s" % dst)
            return dst
        except Exception as e:
            _log("上游配置获取失败 %s：%s" % (url, e))
    return None


# ---------------------------------------------------------------------------
# autoconfig（现场生成）
# ---------------------------------------------------------------------------
def _run_autoconfig(root, model_path, arch):
    """调用 msst_autoconfig.py；成功返回生成的 yaml 路径，失败返回 None。"""
    if not os.path.isfile(model_path):
        _log("autoconfig 跳过：权重不存在 %s" % model_path)
        return None
    if not os.path.isfile(AUTOCONFIG):
        _log("autoconfig 跳过：脚本不存在 %s" % AUTOCONFIG)
        return None
    cache_root = os.path.join(root, "cache")
    try:
        os.makedirs(os.path.join(cache_root, "msst_autocfg"), exist_ok=True)
    except OSError:
        pass
    env = os.environ.copy()
    env.update(
        {
            "FUFUMIDI_DATA_ROOT": root,
            "FUFUMIDI_CACHE_DIR": cache_root,
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
        }
    )
    cmd = [sys.executable, AUTOCONFIG, model_path, str(arch or "")]
    _log("调用 autoconfig：%s" % " ".join(cmd))
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=AUTOCONFIG_TIMEOUT,
            env=env,
            cwd=SCRIPT_DIR,
        )
    except Exception as e:
        _log("autoconfig 调用失败：%s" % e)
        return None
    out = (proc.stdout or "") + "\n" + (proc.stderr or "")
    m = re.search(r"(?m)^RESULT\s+(.+?)\s*$", out)
    if not m:
        _log("autoconfig 未输出 RESULT（退出码 %s）" % getattr(proc, "returncode", "?"))
        return None
    cand = m.group(1).strip()
    if cand in ("None", "null", ""):
        _log("autoconfig 判定无法生成配置")
        return None
    if not os.path.isfile(cand):
        _log("autoconfig 返回的路径不存在：%s" % cand)
        return None
    return cand


# ---------------------------------------------------------------------------
# 自愈主流程
# ---------------------------------------------------------------------------
def _ok(path, source):
    return {"ok": True, "config": os.path.abspath(path), "from": source}


def heal(root, model_path, arch=None):
    """按顺序自愈配置；成功返回 {"ok": True, "config", "from"}，失败返回 {"ok": False, "error"}。"""
    root = os.path.abspath(str(root or ""))
    model_path = os.path.abspath(str(model_path or ""))
    model_dir = os.path.dirname(model_path)
    index = _load_index()
    entry = _entry_for(model_path, index) or {}
    want = str(entry.get("config") or "")
    arch = str(arch or entry.get("arch") or "")
    cache_dir = _configs_dir(root)
    tried = []

    # 1) 模型目录自带的 yaml
    hit = _pick_yml(model_dir, want)
    if hit:
        good, why = _validate_config(hit)
        if good:
            _log("命中模型目录配置：%s" % hit)
            return _ok(hit, "model")
        tried.append("模型目录 %s：%s" % (os.path.basename(hit), why))

    # 2) 数据根共享缓存 <root>/models/_configs
    hit = _pick_yml(cache_dir, want)
    if hit:
        good, why = _validate_config(hit)
        if good:
            _log("命中共享缓存配置：%s" % hit)
            return _ok(hit, "cache")
        tried.append("缓存 %s：%s" % (os.path.basename(hit), why))

    # 3) 内置 index.json + 同目录 yaml → 复制到 _configs
    src = None
    if want:
        cand = os.path.join(BUNDLED_DIR, os.path.basename(want))
        if os.path.isfile(cand):
            src = cand
    if not src:
        stem = os.path.splitext(os.path.basename(model_path))[0]
        if stem:
            for f in _list_yml(BUNDLED_DIR):
                if _norm_cfg(f) == _norm_cfg(stem):
                    src = os.path.join(BUNDLED_DIR, f)
                    break
    if src:
        good, why = _validate_config(src)
        if good:
            try:
                dst = _copy_file(src, os.path.join(cache_dir, os.path.basename(src)))
                _log("复制内置配置到缓存：%s" % dst)
                return _ok(dst, "builtin")
            except OSError as e:
                tried.append("复制内置配置失败：%s" % e)
        else:
            tried.append("内置 %s：%s" % (os.path.basename(src), why))

    # 4) 上游 configs/（GitHub raw / CNB 镜像，取到即缓存）
    up = _try_upstream(cache_dir, want)
    if up:
        good, why = _validate_config(up)
        if good:
            return _ok(up, "upstream")
        tried.append("上游 %s：%s" % (os.path.basename(up), why))
    elif want:
        tried.append("上游未取到 %s" % want)

    # 5) msst_autoconfig.py 现场生成
    gen = _run_autoconfig(root, model_path, arch)
    if gen:
        good, why = _validate_config(gen)
        if good:
            dst = os.path.join(model_dir, os.path.basename(want) if want else os.path.basename(gen))
            try:
                _copy_file(gen, dst)
                _log("autoconfig 产物已放入模型目录：%s" % dst)
                return _ok(dst, "generated")
            except OSError as e:
                _log("autoconfig 产物复制失败（改用缓存路径）：%s" % e)
                return _ok(gen, "generated")
        tried.append("autoconfig 产物不可用：%s" % why)

    detail = "；".join(tried) if tried else "没有匹配的内置 / 上游 / 生成的配置"
    return {"ok": False, "error": "找不到可用配置：%s" % detail}


def _build_parser():
    ap = argparse.ArgumentParser(description="MSST 配置自愈（stdout 为单行 JSON）")
    ap.add_argument("--root", required=True, help="数据根目录")
    ap.add_argument("--model", required=True, help="权重文件路径")
    ap.add_argument("--arch", default="", help="架构名（可省略，从 index.json 推断）")
    return ap


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        result = heal(args.root, args.model, args.arch)
    except Exception as e:
        _log("失败：%s" % e)
        result = {"ok": False, "error": str(e)}
    _emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    _setup_stdio()
    sys.exit(main())

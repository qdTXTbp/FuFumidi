# -*- coding: utf-8 -*-
"""MSST / MuScriptor 分卷下载器（Tauri 壳的 engine 侧入口）。

stdout 协议（只输出 JSON 行，日志一律走 stderr）
================================================
    进度  {"event":"progress","received":N,"total":T,"percent":P,"text":"...","speed":Bps}
    成功  {"ok":true,"id":"...","path":"...","size":N}
    失败  {"ok":false,"error":"..."}        # 取消时额外带 "cancelled": true

分卷期望大小
============
与 main/fast-download.js 的 expectedPartSize / partsLayoutOk **完全一致**：
仓库按固定 25 MiB 切片，第 i 卷 = min(PART_CHUNK, size - (i-1)*PART_CHUNK)；
清单不自洽（partsLayoutOk 为假）时不按推导值校验。
长度不符的已存在分卷一律删除重下，只复用长度精确匹配的。

安全闸门（顺序固定）
====================
磁盘预检 → 缺失分卷并发下载（默认 4 路，429/5xx 退避 + 镜像轮换）→
合并前校验总大小 → 合并到 .tmp → 原子改名 → SHA-256（失败连 .parts 一起丢弃）。

manifest 缓存
=============
成功拉到 manifest 后原子写入 <root>/models/msst-manifest.json（.tmp + os.replace，UTF-8），
资源中心据此显示每个 MSST 条目的 size/parts/sha256。

CLI
===
    python msst_fetch.py --id msst:vocal:big_beta5e --root <dataRoot>
        [--concurrency N] [--prefix URL ...] [--cancel-file PATH] [--pause-file PATH]

--concurrency 默认 4（下限 1），是缺失分卷的并发下载路数。
--prefix 可重复，用于镜像或本地测试；默认 GitHub raw + CNB 两个前缀。
--cancel-file / --pause-file 是给外壳做取消/暂停用的控制文件（存在即生效，可选）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

#: 分卷仓库的固定切片，必须与 main/fast-download.js 的 PART_CHUNK 一致（实测 25 MiB）
PART_CHUNK = 25 * 1024 * 1024
USER_AGENT = "FuFumidi"
CHUNK = 1024 * 1024
NET_CHUNK = 256 * 1024
READ_TIMEOUT = 60
PROGRESS_INTERVAL = 0.2
MAX_ROUNDS = 4
MAX_RETRY_SLEEP = 8.0
HTTP_BACKOFF_BASE = 0.5
MIN_FREE_MARGIN = 64 * 1024 * 1024
DEFAULT_CONCURRENCY = 4

MANIFEST_CACHE_REL = os.path.join("models", "msst-manifest.json")

#: 候选镜像前缀（分卷仓库根）。manifest.json 与 <tag>/<key>/<part> 都拼在这后面。
PREFIXES = [
    "https://raw.githubusercontent.com/monologue82/Models/main/",
    "https://cnb.cool/FuFuCloud-mirror/Models/-/git/raw/main/",
]

MUSCRIPTOR_IDS = ("muscriptor_small", "muscriptor_medium", "muscriptor_large")
MUSCRIPTOR_CONFIGS = {
    "small": {"dim": 768, "num_heads": 12, "num_layers": 14, "card": 1393},
    "medium": {"dim": 1024, "num_heads": 16, "num_layers": 24, "card": 1395},
    "large": {"dim": 1536, "num_heads": 24, "num_layers": 48, "card": 1395},
}

_STDOUT_LOCK = threading.Lock()
_STDERR_LOCK = threading.Lock()


class _Cancelled(Exception):
    """用户取消（--cancel-file 出现）。"""


class _Aborted(Exception):
    """其它分卷失败 / 取消后，其它在途分卷尽快退出。"""


class _PartLengthError(Exception):
    """分卷长度与期望不符（镜像截断 / 清单不自洽）。"""


def _sleep(seconds):
    """退避用的 sleep；测试里替换成 no-op 以便离线瞬时跑完。"""
    time.sleep(max(0.0, float(seconds)))


def _backoff(attempt):
    return min(MAX_RETRY_SLEEP, HTTP_BACKOFF_BASE * (2 ** max(0, int(attempt))))


def _normalise_concurrency(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = DEFAULT_CONCURRENCY
    return max(1, n)


def _setup_stdio():
    """stdout/stderr 固定 UTF-8：外壳按 UTF-8 解析 JSON，中文进度文本不能走 GBK。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _log(msg):
    try:
        with _STDERR_LOCK:
            sys.stderr.write("[msst_fetch] %s\n" % msg)
            sys.stderr.flush()
    except Exception:
        pass


def _emit(obj):
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    with _STDOUT_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


# ---------------------------------------------------------------------------
# 纯函数：分卷期望字节数（逐字对齐 main/fast-download.js:96-108）
# ---------------------------------------------------------------------------
def expected_part_size(total, parts, index):
    """第 index 卷（1 起）的期望字节数；推不出来返回 0 表示「不校验」。"""
    if not total or not parts or index < 1 or index > parts:
        return 0
    remaining = total - (index - 1) * PART_CHUNK
    if remaining <= 0:
        return 0
    return min(PART_CHUNK, remaining)


def parts_layout_ok(total, parts):
    """manifest 的 size/parts 是否自洽（自洽才敢用推导值当校验依据）。"""
    if not total or not parts or parts < 1:
        return False
    last = expected_part_size(total, parts, parts)
    return last > 0 and last <= PART_CHUNK


# ---------------------------------------------------------------------------
# 传输层
# ---------------------------------------------------------------------------
def _opener_for(url):
    """本机地址绕开系统代理（离线测试用），其余地址保留系统代理。"""
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if host in ("127.0.0.1", "localhost", "::1"):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


def _read_url(url, max_bytes=8 * 1024 * 1024):
    """取一个 URL 的全部字节；429/5xx 与网络错误做有限退避重试。"""
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with _opener_for(url).open(req, timeout=READ_TIMEOUT) as r:
                data = r.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise RuntimeError("响应过大：%s" % url)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429 or 500 <= e.code < 600:
                last = e
                if attempt < 2:
                    _sleep(_backoff(attempt))
                continue
            raise
        except Exception as e:  # 网络中断 / DNS / TLS 都按可重试处理
            last = e
            if attempt < 2:
                _sleep(_backoff(attempt))
            continue
    raise RuntimeError("请求失败：%s（%s）" % (url, last))


def _fetch_manifest(prefixes):
    errors = []
    for pre in prefixes:
        try:
            raw = _read_url(pre + "manifest.json")
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict):
                raise RuntimeError("清单格式不对（顶层不是对象）")
            return data
        except Exception as e:
            errors.append("%s: %s" % (pre, e))
            _log("清单通道失败 %s：%s" % (pre, e))
    raise RuntimeError("分卷清单获取失败：%s" % "；".join(errors[-2:]))


def _cache_manifest(root, manifest):
    """原子写 <root>/models/msst-manifest.json（.tmp + os.replace，UTF-8）。"""
    path = os.path.join(root, MANIFEST_CACHE_REL)
    tmp = path + ".tmp"
    try:
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        data = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        return path
    except BaseException:
        _unlink(tmp)
        raise


def _stream_to_file(url, dest, expect, progress, token, text, gate):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with _opener_for(url).open(req, timeout=READ_TIMEOUT) as r:
        declared = 0
        clen = r.headers.get("Content-Length")
        try:
            declared = int(clen) if clen else 0
        except (TypeError, ValueError):
            declared = 0
        if expect and declared and declared != expect:
            raise _PartLengthError("长度声明不符：%d/%d" % (declared, expect))
        with open(dest, "wb") as f:
            while True:
                gate()
                block = r.read(NET_CHUNK)
                if not block:
                    break
                f.write(block)
                progress.add(token, len(block), text)
    size = os.path.getsize(dest)
    if expect and size != expect:
        raise _PartLengthError("长度不符：%d/%d" % (size, expect))
    return size


def _download_part(prefixes, rel, dest, expect, progress, token, label, gate, abort):
    """按镜像顺序下载一卷；429/5xx 退避后轮换，全部失败才抛错。"""
    errors = []
    for rnd in range(MAX_ROUNDS):
        retryable = False
        for pre in prefixes:
            gate()
            url = pre + rel
            try:
                _log("下载 %s" % url)
                _stream_to_file(url, dest, expect, progress, token, label, gate)
                return
            except (_Cancelled, _Aborted):
                _unlink(dest)
                raise
            except urllib.error.HTTPError as e:
                _unlink(dest)
                if abort.is_set():
                    raise _Aborted()
                errors.append("%s -> HTTP %s" % (url, e.code))
                retryable = retryable or e.code == 429 or 500 <= e.code < 600
                _log("镜像失败（HTTP %s）：%s" % (e.code, url))
            except Exception as e:
                _unlink(dest)
                if abort.is_set():
                    raise _Aborted()
                errors.append("%s -> %s" % (url, e))
                retryable = True
                _log("镜像失败：%s（%s）" % (url, e))
        if not retryable:
            break
        if rnd < MAX_ROUNDS - 1:
            _sleep(_backoff(rnd))
    raise RuntimeError("分卷下载失败：%s（%s）" % (label, "；".join(errors[-3:])))


def _download_missing(prefixes, parts_dir, model, rel_dir, parts, missing, progress, gate, abort, concurrency):
    """并发下载缺失分卷；任何一卷失败/取消 → abort 其余在途卷并抛原异常。"""
    if not missing:
        return

    def one(i, want):
        out = _part_path(parts_dir, model, i)
        rel = "%s/%s" % (rel_dir, os.path.basename(out))
        progress.begin(i)
        _download_part(prefixes, rel, out, want, progress, i, "分卷 %d/%d" % (i, parts), gate, abort)
        progress.finish(i, text="分卷 %d/%d 完成" % (i, parts))

    workers = max(1, min(int(concurrency or 1), len(missing)))
    if workers <= 1 or len(missing) == 1:
        for i, want in missing:
            one(i, want)
        return

    ex = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="msst-part")
    futures = {}
    try:
        for i, want in missing:
            futures[ex.submit(one, i, want)] = i
        for fut in as_completed(futures):
            fut.result()
    except BaseException:
        abort.set()
        for fut in futures:
            fut.cancel()
        for fut in futures:
            try:
                fut.result()
            except BaseException:
                pass
        raise
    finally:
        ex.shutdown(wait=True)


# ---------------------------------------------------------------------------
# 文件工具
# ---------------------------------------------------------------------------
def _unlink(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(CHUNK)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _fmt_bytes(n):
    try:
        n = float(n)
    except (TypeError, ValueError):
        return str(n)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024.0 or unit == "TiB":
            return ("%.0f %s" if unit == "B" else "%.1f %s") % (n, unit)
        n /= 1024.0
    return "%.1f TiB" % n


def _check_disk(path, need_bytes):
    try:
        usage = shutil.disk_usage(path)
    except OSError as e:
        raise RuntimeError("磁盘预检失败：%s" % e)
    if usage.free < need_bytes:
        raise RuntimeError(
            "磁盘空间不足：需要 %s，可用 %s（目录：%s）" % (_fmt_bytes(need_bytes), _fmt_bytes(usage.free), path)
        )


def _file_matches(path, total, sha256):
    try:
        size = os.path.getsize(path)
    except OSError:
        return False
    if total:
        return size == total
    if sha256:
        return _sha256_file(path) == sha256
    return size > 0


def _part_path(parts_dir, model, index):
    return os.path.join(parts_dir, "%s.part%02d" % (model, index))


# ---------------------------------------------------------------------------
# 进度（线程安全：已完成卷字节 + 各在途卷字节，加锁汇总）
# ---------------------------------------------------------------------------
class _Progress:
    def __init__(self, total):
        self.total = int(total or 0)
        self.speed = 0.0
        self._lock = threading.Lock()
        self._done = 0
        self._inflight = {}
        self._last_emit = 0.0
        self._speed_t = time.monotonic()
        self._speed_b = 0

    def _received_locked(self):
        return self._done + sum(self._inflight.values())

    def set_done(self, n):
        with self._lock:
            self._done = int(n)
            self._speed_b = self._received_locked()
            self._speed_t = time.monotonic()

    def begin(self, token):
        with self._lock:
            self._inflight[token] = 0

    def add(self, token, n, text=None, force=False):
        # 事件在持锁时写出：保证 stdout 里的 received 顺序与状态快照一致（单调）
        with self._lock:
            self._inflight[token] = self._inflight.get(token, 0) + int(n)
            received = self._received_locked()
            now = time.monotonic()
            dt = now - self._speed_t
            if dt >= 0.2:
                self.speed = (received - self._speed_b) / dt
                self._speed_t = now
                self._speed_b = received
            if force or (now - self._last_emit) >= PROGRESS_INTERVAL:
                self._last_emit = now
                self._emit_value(received, text, self.speed)

    def finish(self, token, text=None):
        with self._lock:
            self._done += self._inflight.pop(token, 0)
            received = self._received_locked()
            self._last_emit = time.monotonic()
            self._emit_value(received, text, self.speed)

    def emit(self, text=None, percent=None, force=False):
        with self._lock:
            received = self._received_locked()
            self._last_emit = time.monotonic()
            self._emit_value(received, text, self.speed, percent)

    def _emit_value(self, received, text, speed, percent=None):
        if percent is None:
            if self.total:
                percent = min(99, int(received * 100.0 / self.total))
            else:
                percent = 0
        _emit(
            {
                "event": "progress",
                "received": int(received),
                "total": int(self.total),
                "percent": int(percent),
                "text": text or "",
                "speed": round(float(speed), 1),
            }
        )


class _Control:
    """可选的取消/暂停控制文件（存在即生效）。"""

    def __init__(self, cancel_file=None, pause_file=None):
        self.cancel_file = cancel_file
        self.pause_file = pause_file

    def check(self):
        if self.cancel_file and os.path.exists(self.cancel_file):
            raise _Cancelled()

    def paused(self):
        return bool(self.pause_file) and os.path.exists(self.pause_file)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def _normalise_prefixes(prefixes):
    out = []
    for p in prefixes or PREFIXES:
        p = str(p or "").strip()
        if not p:
            continue
        if not p.endswith("/"):
            p += "/"
        out.append(p)
    if not out:
        raise RuntimeError("没有可用的下载前缀")
    return out


def _parse_id(raw):
    raw = str(raw or "")
    if raw in MUSCRIPTOR_IDS:
        return "muscriptor", raw.split("_", 1)[1]
    parts = raw.split(":")
    if len(parts) != 3 or parts[0] != "msst":
        raise ValueError("bad id（应为 msst:<tag>:<key> 或 muscriptor_<size>）：%s" % raw)
    return parts[1], parts[2]


def _lookup_meta(manifest, tag, key):
    entries = manifest.get(tag) or {}
    if not isinstance(entries, dict):
        return None, key
    meta = entries.get(key)
    if isinstance(meta, dict) and meta:
        return meta, key
    norm = key.lower().replace("-", "_")
    for k, v in entries.items():
        if not isinstance(v, dict):
            continue
        stem = os.path.splitext(str(v.get("model") or ""))[0].lower().replace("-", "_")
        if stem and stem == norm:
            return v, k
    return None, key


def _run(args):
    tag, key = _parse_id(args.id)
    prefixes = _normalise_prefixes(args.prefix)
    manifest = _fetch_manifest(prefixes)
    try:
        cache_path = _cache_manifest(args.root, manifest)
        _log("manifest 已缓存：%s" % cache_path)
    except OSError as e:
        _log("manifest 缓存写入失败（不影响下载）：%s" % e)

    meta, key = _lookup_meta(manifest, tag, key)
    if not meta:
        raise RuntimeError("manifest 条目不存在：%s/%s" % (tag, key))

    model = str(meta.get("model") or "model.safetensors")
    try:
        parts = int(meta.get("parts") or 0)
        total = int(meta.get("size") or 0)
    except (TypeError, ValueError):
        raise RuntimeError("manifest 的 parts/size 不是整数：%r" % meta)
    if parts < 1:
        raise RuntimeError("manifest 缺少 parts：%s/%s" % (tag, key))
    sha = str(meta.get("sha256") or "").lower()
    concurrency = _normalise_concurrency(getattr(args, "concurrency", DEFAULT_CONCURRENCY))

    dest = os.path.join(args.root, "models", tag, key)
    final = os.path.join(dest, model)
    parts_dir = os.path.join(dest, ".parts")
    tmp = final + ".tmp"
    progress = _Progress(total)
    progress.emit(text="准备下载：%d 个分卷" % parts)
    os.makedirs(dest, exist_ok=True)

    # 0) 成品已存在且完整 → 直接复用
    if os.path.isfile(final):
        if _file_matches(final, total, sha):
            _log("成品已存在且完整：%s" % final)
            progress.set_done(os.path.getsize(final))
            progress.emit(percent=100, text="已存在")
            return {"ok": True, "id": args.id, "path": dest, "size": os.path.getsize(final), "existed": True}
        _log("成品长度/哈希不符，丢弃重下：%s" % final)
        _unlink(final)
    _unlink(tmp)

    ctrl = _Control(args.cancel_file, args.pause_file)
    abort = threading.Event()
    pause_lock = threading.Lock()

    def gate():
        if abort.is_set():
            raise _Aborted()
        ctrl.check()
        if ctrl.paused():
            with pause_lock:
                if abort.is_set():
                    raise _Aborted()
                ctrl.check()
                if ctrl.paused():
                    _log("检测到暂停文件：%s" % ctrl.pause_file)
                    progress.emit(text="已暂停（等待继续）")
                    while ctrl.paused():
                        ctrl.check()
                        if abort.is_set():
                            raise _Aborted()
                        _sleep(0.25)
                    progress.emit(text="继续下载")
                    _log("暂停结束，继续下载")

    os.makedirs(parts_dir, exist_ok=True)

    # 1) 期望字节数与复用判定（长度不符的一律删掉重下）
    layout_ok = parts_layout_ok(total, parts)

    def expect_of(i):
        return expected_part_size(total, parts, i) if layout_ok else 0

    missing = []
    reuse_bytes = 0
    for i in range(1, parts + 1):
        out = _part_path(parts_dir, model, i)
        want = expect_of(i)
        have = 0
        if os.path.isfile(out):
            try:
                have = os.path.getsize(out)
            except OSError:
                have = 0
        if have > 0 and (not want or have == want):
            reuse_bytes += have
            _log("复用分卷 %d/%d（%d 字节）" % (i, parts, have))
            continue
        if have > 0:
            _log("分卷 %d/%d 长度不符（%d/%s），删除重下" % (i, parts, have, want or "?"))
            _unlink(out)
        missing.append((i, want))

    need_bytes = 0
    for _, want in missing:
        need_bytes += want if want else (int((total + parts - 1) / parts) if total else 0)

    # 2) 磁盘预检（动手前；与 fast-download.js 的 checkDiskSpace 同口径）
    _check_disk(dest, (need_bytes or total) * 2 + MIN_FREE_MARGIN)

    workers = max(1, min(concurrency, len(missing))) if missing else 0
    progress.set_done(reuse_bytes)
    progress.emit(
        text="共 %d 个分卷（已就绪 %d 个，需下载 %d 个 · 并行 %d 路）"
        % (parts, parts - len(missing), len(missing), workers)
    )

    try:
        # 3) 并发下载缺失分卷（默认 4 路）
        _download_missing(
            prefixes, parts_dir, model, "%s/%s" % (tag, key), parts, missing, progress, gate, abort, concurrency
        )

        # 4) 合并前校验：每卷长度 + 总大小 == manifest.size
        merged_size = 0
        for i in range(1, parts + 1):
            p = _part_path(parts_dir, model, i)
            if not os.path.isfile(p):
                raise RuntimeError("分卷缺失：%s" % os.path.basename(p))
            size = os.path.getsize(p)
            want = expect_of(i)
            if want and size != want:
                raise RuntimeError("分卷长度不符：%s（%d/%d）" % (os.path.basename(p), size, want))
            merged_size += size
        if total and merged_size != total:
            raise RuntimeError("分卷总大小不符：%d/%d（清单 size 与 parts 不自洽）" % (merged_size, total))

        # 5) 合并到 .tmp
        progress.emit(percent=99, text="合并分卷…")
        with open(tmp, "wb") as w:
            for i in range(1, parts + 1):
                with open(_part_path(parts_dir, model, i), "rb") as r:
                    while True:
                        block = r.read(CHUNK)
                        if not block:
                            break
                        w.write(block)
        size = os.path.getsize(tmp)
        if total and size != total:
            raise RuntimeError("合并后大小不符：%d/%d" % (size, total))

        # 6) SHA-256：失败 = 分卷整体不可信 → 连 .parts 一起丢弃
        if sha:
            progress.emit(percent=99, text="校验 SHA256…")
            got = _sha256_file(tmp)
            if got != sha:
                _unlink(tmp)
                shutil.rmtree(parts_dir, ignore_errors=True)
                _unlink(final)
                raise RuntimeError(
                    "SHA256 校验失败：%s…（已丢弃全部分卷，重试会重新下载；反复失败请换下载源）" % got[:12]
                )

        # 7) 原子改名
        _unlink(final)
        os.replace(tmp, final)
    except BaseException:
        _unlink(tmp)
        raise

    shutil.rmtree(parts_dir, ignore_errors=True)
    _write_muscriptor_config(args.id, key, dest)
    final_size = os.path.getsize(final)
    progress.set_done(final_size)
    progress.emit(percent=100, text="完成")
    return {"ok": True, "id": args.id, "path": dest, "size": final_size, "existed": False}


def _write_muscriptor_config(raw_id, key, dest):
    """MuScriptor 规格：权重旁的 config.json 决定架构，缺了会按 large 构建而尺寸不匹配。"""
    if raw_id not in MUSCRIPTOR_IDS:
        return
    cfg = MUSCRIPTOR_CONFIGS.get(key)
    if not cfg:
        return
    try:
        with open(os.path.join(dest, "config.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except OSError as e:
        _log("写 muscriptor config.json 失败：%s" % e)


def _build_parser():
    ap = argparse.ArgumentParser(description="MSST / MuScriptor 分卷下载器（stdout 为 JSON 行协议）")
    ap.add_argument("--id", required=True, help="msst:<tag>:<key> 或 muscriptor_small/medium/large")
    ap.add_argument("--root", required=True, help="数据根目录（模型落到 <root>/models/<tag>/<key>）")
    ap.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help="缺失分卷并发下载路数（默认 %d，下限 1）" % DEFAULT_CONCURRENCY,
    )
    ap.add_argument("--prefix", action="append", default=None, help="下载前缀，可重复；默认 GitHub raw + CNB")
    ap.add_argument("--cancel-file", default=None, help="该文件出现即取消（可选）")
    ap.add_argument("--pause-file", default=None, help="该文件存在期间暂停（可选）")
    return ap


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        result = _run(args)
    except _Cancelled:
        _log("已取消")
        _emit({"ok": False, "error": "已取消", "cancelled": True})
    except _Aborted:
        _log("已中止")
        _emit({"ok": False, "error": "已中止"})
    except Exception as e:
        _log("失败：%s" % e)
        _emit({"ok": False, "error": str(e)})
    else:
        _emit(result)
    return 0


if __name__ == "__main__":
    _setup_stdio()
    sys.exit(main())

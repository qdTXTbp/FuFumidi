# -*- coding: utf-8 -*-
"""msst_fetch 的离线回归：JSON 行协议、期望大小、断点复用、坏卷重下、SHA 清理、
镜像退避、manifest 缓存、分卷并发与总进度。

全部走本机 http.server + tmp_path，不访问外网。
"""

import hashlib
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import types
import urllib.parse

import pytest

_ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ENGINE not in sys.path:
    sys.path.insert(0, _ENGINE)

import msst_fetch as F  # noqa: E402

_ID = "msst:vocal:testmodel"
_TAG = "vocal"
_KEY = "testmodel"
_MODEL = "model.safetensors"


class _InlineServer:
    """可编程的本机下载源：payloads + overrides + 请求记录。"""

    def __init__(self):
        self.payloads = {}
        self.overrides = {}
        self.requests = []
        self.counts = {}
        self.delay = {}
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()
        srv = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *_a):
                pass

            def do_GET(self):
                srv._handle(self)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        return "http://127.0.0.1:%d/" % self.httpd.server_address[1]

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(2)

    def _handle(self, h):
        path = urllib.parse.urlsplit(h.path).path
        with self._lock:
            self.requests.append(path)
            self.counts[path] = self.counts.get(path, 0) + 1
            n = self.counts[path]
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            delay = self.delay.get(path, 0)
            if delay:
                time.sleep(delay)
            override = self.overrides.get(path)
            if callable(override):
                status, body = override(n)
            elif override is not None:
                status, body = override
            elif path in self.payloads:
                status, body = 200, self.payloads[path]
            else:
                status, body = 404, b"not found"
            if isinstance(body, str):
                body = body.encode("utf-8")
            h.send_response(status)
            h.send_header("Content-Type", "application/octet-stream")
            h.send_header("Content-Length", str(len(body)))
            h.end_headers()
            if body:
                h.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with self._lock:
                self.active -= 1


@pytest.fixture
def server():
    srv = _InlineServer()
    try:
        yield srv
    finally:
        srv.close()


@pytest.fixture(autouse=True)
def _fast_retry(monkeypatch):
    monkeypatch.setattr(F, "_sleep", lambda *_a, **_k: None)


def _patch_chunk(monkeypatch, value=1024):
    """功能测试用 1 KiB 切片跑多卷；真实 25 MiB 的对照由纯函数用例锁。"""
    monkeypatch.setattr(F, "PART_CHUNK", value)


def _layout(server, total, parts, tag=_TAG, key=_KEY, model=_MODEL):
    """按当前 PART_CHUNK 生成自洽（或故意不自洽）的分卷与 manifest。"""
    content = b""
    part_sizes = []
    for i in range(1, parts + 1):
        size = F.expected_part_size(total, parts, i)
        piece = bytes([i]) * size
        content += piece
        part_sizes.append(size)
        server.payloads["/%s/%s/%s.part%02d" % (tag, key, model, i)] = piece
    meta = {
        "model": model,
        "parts": parts,
        "size": total,
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    manifest = {tag: {key: meta}}
    server.payloads["/manifest.json"] = json.dumps(manifest).encode("utf-8")
    return {"manifest": manifest, "meta": meta, "content": content, "part_sizes": part_sizes}


def _expected_part_path(i, tag=_TAG, key=_KEY, model=_MODEL):
    return "/%s/%s/%s.part%02d" % (tag, key, model, i)


def _run_fetch(tmp_path, prefixes, raw_id=_ID, extra=None):
    if isinstance(prefixes, str):
        prefixes = [prefixes]
    argv = ["--id", raw_id, "--root", str(tmp_path)]
    for p in prefixes:
        argv += ["--prefix", p]
    if extra:
        argv += list(extra)
    return F.main(argv)


def _events(capsys):
    out = capsys.readouterr().out
    lines = [line for line in out.splitlines() if line.strip()]
    return lines, [json.loads(line) for line in lines]


def _final_path(tmp_path, tag=_TAG, key=_KEY):
    return os.path.join(str(tmp_path), "models", tag, key)


# ---------------------------------------------------------------------------
# 纯函数：与 main/fast-download.js 的 expectedPartSize / partsLayoutOk 对齐
# ---------------------------------------------------------------------------
def test_expected_part_size_exactly_matches_fast_download_js():
    chunk = 25 * 1024 * 1024
    assert F.PART_CHUNK == chunk

    total = 3 * chunk + 7
    assert [F.expected_part_size(total, 4, i) for i in (1, 2, 3, 4)] == [chunk, chunk, chunk, 7]
    assert F.parts_layout_ok(total, 4)

    assert F.expected_part_size(11, 3, 1) == 11
    assert F.expected_part_size(total, 4, 0) == 0
    assert F.expected_part_size(total, 4, 5) == 0
    assert F.expected_part_size(0, 3, 1) == 0
    assert F.expected_part_size(total, 0, 1) == 0
    assert not F.parts_layout_ok(0, 3)
    assert not F.parts_layout_ok(10, 0)

    # JS 的 partsLayoutOk 只看末卷：2*CHUNK+1 / 2 会被判自洽（两卷都是 CHUNK，
    # 和却是 2*CHUNK != total），真正的口径差异由「合并前总大小校验」兜底。
    assert F.parts_layout_ok(2 * chunk + 1, 2)
    assert F.expected_part_size(2 * chunk + 1, 2, 2) == chunk


# ---------------------------------------------------------------------------
# 下载主流程
# ---------------------------------------------------------------------------
def test_download_emits_json_progress_and_final_result(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    _layout(server, total=3000, parts=3)

    rc = _run_fetch(tmp_path, server.base)
    lines, events = _events(capsys)

    assert rc == 0
    assert lines, "stdout 不能为空"
    for line in lines:
        assert isinstance(json.loads(line), dict)  # 每一行都必须是 JSON

    progress = [e for e in events if e.get("event") == "progress"]
    assert len(progress) >= 2
    first = progress[0]
    assert {"event", "received", "total", "percent", "text", "speed"} <= set(first)
    assert first["received"] == 0 and first["total"] == 3000
    assert all(isinstance(e["received"], int) and isinstance(e["percent"], int) for e in progress)
    assert all(isinstance(e["speed"], (int, float)) and e["speed"] >= 0 for e in progress)
    received = [e["received"] for e in progress]
    assert received == sorted(received)
    assert progress[-1]["percent"] == 100 and progress[-1]["received"] == 3000

    final = events[-1]
    assert final["ok"] is True and final["id"] == _ID and final["size"] == 3000
    final_path = _final_path(tmp_path)
    assert final["path"] == final_path
    assert os.path.isfile(os.path.join(final_path, _MODEL))
    assert not os.path.isdir(os.path.join(final_path, ".parts")), "成功后 .parts 必须清理"


def test_resume_reuses_exact_parts_and_only_downloads_missing(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    built = _layout(server, total=3072, parts=3)
    dest = _final_path(tmp_path)
    parts_dir = os.path.join(dest, ".parts")
    os.makedirs(parts_dir)
    for i in (1, 2):
        size = built["part_sizes"][i - 1]
        with open(os.path.join(parts_dir, "%s.part%02d" % (_MODEL, i)), "wb") as f:
            f.write(bytes([i]) * size)

    rc = _run_fetch(tmp_path, server.base)
    _, events = _events(capsys)

    assert rc == 0 and events[-1]["ok"] is True
    assert _expected_part_path(1) not in server.requests
    assert _expected_part_path(2) not in server.requests
    assert server.counts.get(_expected_part_path(3)) == 1
    with open(os.path.join(dest, _MODEL), "rb") as f:
        assert f.read() == built["content"]


def test_wrong_length_part_is_deleted_and_redownloaded(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    built = _layout(server, total=3072, parts=3)
    dest = _final_path(tmp_path)
    parts_dir = os.path.join(dest, ".parts")
    os.makedirs(parts_dir)
    bad = os.path.join(parts_dir, "%s.part01" % _MODEL)
    with open(bad, "wb") as f:
        f.write(b"truncated")

    rc = _run_fetch(tmp_path, server.base)
    _, events = _events(capsys)

    assert rc == 0 and events[-1]["ok"] is True
    assert server.counts.get(_expected_part_path(1)) == 1, "坏卷必须重新下载"
    with open(os.path.join(dest, _MODEL), "rb") as f:
        assert f.read() == built["content"]


def test_existing_complete_file_is_reused_without_downloading_parts(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    built = _layout(server, total=2048, parts=2)
    dest = _final_path(tmp_path)
    os.makedirs(dest)
    with open(os.path.join(dest, _MODEL), "wb") as f:
        f.write(built["content"])

    rc = _run_fetch(tmp_path, server.base)
    _, events = _events(capsys)

    assert rc == 0
    final = events[-1]
    assert final["ok"] is True and final["existed"] is True and final["size"] == 2048
    assert server.requests == ["/manifest.json"], "成品完整时不应再请求任何分卷"


def test_sha256_failure_discards_final_and_parts(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    built = _layout(server, total=3072, parts=3)
    built["meta"]["sha256"] = "0" * 64
    server.payloads["/manifest.json"] = json.dumps(built["manifest"]).encode("utf-8")

    rc = _run_fetch(tmp_path, server.base)
    _, events = _events(capsys)

    assert rc == 0
    final = events[-1]
    assert final["ok"] is False and "SHA256" in final["error"]
    dest = _final_path(tmp_path)
    assert not os.path.exists(os.path.join(dest, _MODEL))
    assert not os.path.exists(os.path.join(dest, _MODEL + ".tmp"))
    assert not os.path.isdir(os.path.join(dest, ".parts")), "SHA 失败必须连 .parts 一起丢弃"
    # manifest 缓存是"拉到清单就写"，失败下载不应抹掉它
    assert os.path.isfile(os.path.join(str(tmp_path), "models", "msst-manifest.json"))


def test_merge_size_mismatch_is_rejected_before_rename(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch, 100)
    # 250 字节 / 2 卷：每卷推导 100 字节（sum 200 != 250），JS 也会判 layoutOk；
    # 差异由「合并前总大小校验」兜底，绝不允许改名成成品。
    _layout(server, total=250, parts=2)

    rc = _run_fetch(tmp_path, server.base)
    _, events = _events(capsys)

    assert rc == 0
    final = events[-1]
    assert final["ok"] is False and "总大小不符" in final["error"]
    dest = _final_path(tmp_path)
    assert not os.path.exists(os.path.join(dest, _MODEL))
    assert not os.path.exists(os.path.join(dest, _MODEL + ".tmp"))


def test_disk_precheck_fails_before_any_part_request(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    _layout(server, total=3072, parts=3)
    monkeypatch.setattr(
        F.shutil, "disk_usage", lambda _p: types.SimpleNamespace(total=10**12, used=10**12 - 1024, free=1024)
    )

    rc = _run_fetch(tmp_path, server.base)
    _, events = _events(capsys)

    assert rc == 0
    final = events[-1]
    assert final["ok"] is False and "磁盘空间不足" in final["error"]
    assert server.requests == ["/manifest.json"], "磁盘预检失败时不能开始下载"
    assert not os.path.exists(os.path.join(_final_path(tmp_path), _MODEL))


def test_429_backs_off_and_retries_same_mirror(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    built = _layout(server, total=1024, parts=1)
    path = _expected_part_path(1)
    payload = built["content"]
    server.overrides[path] = lambda n: (429, b"slow down") if n == 1 else (200, payload)
    sleeps = []
    monkeypatch.setattr(F, "_sleep", lambda s: sleeps.append(s))

    rc = _run_fetch(tmp_path, server.base)
    _, events = _events(capsys)

    assert rc == 0 and events[-1]["ok"] is True
    assert server.counts.get(path) == 2, "429 后应重试同一镜像"
    assert sleeps, "429 必须退避（测试里用记录代替真睡）"


def test_dead_mirror_rotates_to_next_prefix(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    built = _layout(server, total=3072, parts=3)
    bad = _InlineServer()
    try:
        bad.payloads["/manifest.json"] = server.payloads["/manifest.json"]
        for i in (1, 2, 3):
            bad.overrides[_expected_part_path(i)] = (500, b"boom")

        rc = _run_fetch(tmp_path, [bad.base, server.base])
        _, events = _events(capsys)

        assert rc == 0 and events[-1]["ok"] is True
        assert bad.counts.get(_expected_part_path(1)) == 1
        assert server.counts.get(_expected_part_path(1)) == 1
    finally:
        bad.close()


def test_bad_id_reports_json_error(tmp_path, capsys):
    rc = _run_fetch(tmp_path, "http://127.0.0.1:9/", raw_id="bogus-id")
    _, events = _events(capsys)
    assert rc == 0
    assert events[-1]["ok"] is False and "bad id" in events[-1]["error"]


def test_cancel_file_aborts_cleanly(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    _layout(server, total=3072, parts=3)
    cancel = os.path.join(str(tmp_path), "cancel.flag")
    path = _expected_part_path(1)

    def first_request(_n):
        with open(cancel, "w", encoding="utf-8") as f:
            f.write("1")
        return (200, server.payloads[path])

    server.overrides[path] = first_request

    rc = _run_fetch(tmp_path, server.base, extra=["--cancel-file", cancel])
    _, events = _events(capsys)

    assert rc == 0
    final = events[-1]
    assert final["ok"] is False and final.get("cancelled") is True
    assert not os.path.exists(os.path.join(_final_path(tmp_path), _MODEL))


def test_manifest_cache_written_atomically(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    _layout(server, total=1024, parts=1)

    rc = _run_fetch(tmp_path, server.base)
    _, events = _events(capsys)

    assert rc == 0 and events[-1]["ok"] is True
    cache = os.path.join(str(tmp_path), "models", "msst-manifest.json")
    assert os.path.isfile(cache)
    with open(cache, "r", encoding="utf-8") as f:
        cached = json.load(f)
    assert cached == json.loads(server.payloads["/manifest.json"])
    assert not os.path.exists(cache + ".tmp"), "原子写不能留下 .tmp"


def test_default_concurrency_is_four():
    args = F._build_parser().parse_args(["--id", _ID, "--root", "r"])
    assert args.concurrency == 4
    assert F._normalise_concurrency(None) == 4
    assert F._normalise_concurrency("bad") == 4
    assert F._normalise_concurrency(0) == 1
    assert F._normalise_concurrency(7) == 7


def test_concurrent_parts_run_in_parallel(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    _layout(server, total=2048, parts=2)
    for i in (1, 2):
        server.delay[_expected_part_path(i)] = 0.3

    rc = _run_fetch(tmp_path, server.base, extra=["--concurrency", "2"])
    _, events = _events(capsys)

    assert rc == 0 and events[-1]["ok"] is True
    assert server.max_active >= 2, "两卷应同时在途（实测最大并发 %d）" % server.max_active


def test_concurrency_one_is_sequential(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    _layout(server, total=2048, parts=2)
    for i in (1, 2):
        server.delay[_expected_part_path(i)] = 0.2

    rc = _run_fetch(tmp_path, server.base, extra=["--concurrency", "1"])
    _, events = _events(capsys)

    assert rc == 0 and events[-1]["ok"] is True
    assert server.max_active == 1


def test_aggregate_progress_with_concurrency(tmp_path, server, capsys, monkeypatch):
    _patch_chunk(monkeypatch)
    _layout(server, total=3 * 1024, parts=3)
    for i in (1, 2, 3):
        server.delay[_expected_part_path(i)] = 0.05

    rc = _run_fetch(tmp_path, server.base, extra=["--concurrency", "3"])
    _, events = _events(capsys)

    assert rc == 0 and events[-1]["ok"] is True
    progress = [e for e in events if e.get("event") == "progress"]
    received = [e["received"] for e in progress]
    assert received == sorted(received), "并发下总 received 仍必须单调递增"
    assert progress[-1]["received"] == 3 * 1024
    assert progress[-1]["percent"] == 100


def test_cli_subprocess_stdout_contains_only_json_lines(tmp_path, server):
    _layout(server, total=2048, parts=1)  # 真实 25 MiB 切片下单卷即可
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    proc = subprocess.run(
        [
            sys.executable,
            os.path.join(_ENGINE, "msst_fetch.py"),
            "--id",
            _ID,
            "--root",
            str(tmp_path),
            "--prefix",
            server.base,
        ],
        capture_output=True,
        env=env,
        timeout=120,
    )
    assert proc.returncode == 0
    stdout = proc.stdout.decode("utf-8")
    lines = [line for line in stdout.splitlines() if line.strip()]
    assert lines
    parsed = [json.loads(line) for line in lines]  # 非 JSON 行会直接抛错
    final = parsed[-1]
    assert final["ok"] is True and final["size"] == 2048
    assert os.path.isfile(os.path.join(final["path"], _MODEL))
    assert proc.stderr.strip(), "日志必须走 stderr"

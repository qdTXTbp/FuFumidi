# -*- coding: utf-8 -*-
"""运行时 site 的 ABI 闸门与 sys.path 清理（2026-11-12）。

背景：常驻引擎复用同一进程。MIROS 的 site 是 cp312 构建，插进 sys.path 后
不移除，下一次 MuScriptor 任务 import scipy 就会撞上 cp312 的 numpy，
报「The scipy install you are using seems to be broken」。
本测试锁四件事：ABI 探测、不匹配不挂载、插了就还原、脏路径能被清掉。
"""
import os
import sys

import transcribe_runtime as TR

CUR = "%d.%d" % sys.version_info[:2]
OTHER = "3.12" if CUR != "3.12" else "3.11"


def _fake_site(root, abi):
    site = root / "site"
    d = site / "numpy" / "core"
    d.mkdir(parents=True, exist_ok=True)
    (d / ("_multiarray_umath.cp%s-win_amd64.pyd" % abi.replace(".", ""))).write_bytes(b"x")
    return str(site)


def _clean(*dirs):
    for p in dirs:
        while p in sys.path:
            sys.path.remove(p)
    TR.restore_paths()


def test_binary_abi_reads_filename(tmp_path):
    assert TR.site_abi(_fake_site(tmp_path / "a", "3.12")) == "3.12"
    assert TR.site_abi(str(tmp_path / "empty")) == ""


def test_prepare_paths_skips_mismatched_site(tmp_path):
    rt = tmp_path / "miros"
    site = _fake_site(rt, OTHER)
    before = list(sys.path)
    try:
        inserted = TR.prepare_paths(str(rt), extra_dirs=[], keep_env_packages=False)
        assert site not in sys.path, "ABI 不匹配的 site 绝不能进 sys.path"
        skip = TR.last_site_skip()
        assert skip["site"] == site and skip["abi"] == OTHER and skip["python"] == CUR
        assert str(rt) in sys.path and str(rt) in inserted, "运行时根仍应可用"
    finally:
        _clean(*inserted)
        sys.path[:] = before


def test_prepare_paths_inserts_matching_site(tmp_path):
    rt = tmp_path / "miros"
    site = _fake_site(rt, CUR)
    before = list(sys.path)
    try:
        inserted = TR.prepare_paths(str(rt), extra_dirs=[], keep_env_packages=False)
        assert site in sys.path
        assert TR.last_site_skip() == {}
        assert site in inserted
    finally:
        _clean(*inserted)
        sys.path[:] = before


def test_restore_paths_keeps_preexisting_entries(tmp_path):
    rt = tmp_path / "miros"
    _fake_site(rt, CUR)
    keep = str(tmp_path / "keep")
    os.makedirs(keep)
    sys.path.append(keep)
    before = list(sys.path)
    try:
        inserted = TR.prepare_paths(str(rt), extra_dirs=[], keep_env_packages=False)
        TR.restore_paths(inserted)
        assert keep in sys.path
        assert all(p not in sys.path for p in inserted)
    finally:
        sys.path[:] = before


def test_sanitize_sys_path_removes_only_mismatched(tmp_path):
    bad = _fake_site(tmp_path / "bad", OTHER)
    good = _fake_site(tmp_path / "good", CUR)
    sys.path.insert(0, bad)
    sys.path.insert(0, good)
    try:
        removed = TR.sanitize_sys_path()
        assert bad not in sys.path, "cp312 的 site 必须被清掉"
        assert good in sys.path, "ABI 匹配的 site 不能误伤"
        assert [r["site"] for r in removed] == [bad]
    finally:
        for p in (bad, good):
            while p in sys.path:
                sys.path.remove(p)

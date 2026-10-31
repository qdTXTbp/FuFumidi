# -*- coding: utf-8 -*-
"""sys.path 优先级（GPU 增强包 vs 运行时自带 torch）。

背景（GitHub PR #37，2026-10-31）：MIROS 运行时自带 `site/torch` 是 CPU 版
（实测 2.14.1+cpu），而 `prepare_paths` 把整个 `site` 插到 `sys.path[0]`，
正好压在 PYTHONPATH 里 GPU 增强包的 cu128 torch 前面 —— 机器有卡也报
`GPU available: False`，整首走 CPU。

这里锁死三件事：
  1) 装了 GPU 增强包时，运行时的 site 必须排在增强包**之后**；
  2) 没装增强包时，site 仍然最前（运行时的依赖要压过 App 自带运行时）；
  3) 排障开关（keep_env_packages=False / FUFUMIDI_RUNTIME_BUNDLED_TORCH）能退回旧行为。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import transcribe_runtime as TR


def _mk_rt(tmp_path):
    rt = tmp_path / "miros"
    (rt / "site" / "transformers").mkdir(parents=True)
    (rt / "repo").mkdir(parents=True)
    return rt


def test_site_goes_after_gpu_pack(monkeypatch, tmp_path):
    pack = tmp_path / "gpu-pack"
    pack.mkdir()
    rt = _mk_rt(tmp_path)
    monkeypatch.setenv("PYTHONPATH", str(pack))
    monkeypatch.setattr(sys, "path", [str(pack), str(tmp_path / "app-site")])

    TR.prepare_paths(str(rt), extra_dirs=["repo"])

    pack_i = sys.path.index(str(pack))
    site_i = sys.path.index(str(rt / "site"))
    repo_i = sys.path.index(str(rt / "repo"))
    assert pack_i < site_i, "GPU 增强包必须排在运行时 site 之前（否则 CUDA torch 被 CPU 版遮住）"
    assert site_i < repo_i
    assert repo_i < sys.path.index(str(rt))


def test_site_first_when_no_gpu_pack(monkeypatch, tmp_path):
    rt = _mk_rt(tmp_path)
    monkeypatch.delenv("PYTHONPATH", raising=False)
    monkeypatch.setattr(sys, "path", [str(tmp_path / "app-site")])

    TR.prepare_paths(str(rt))

    assert sys.path[0] == str(rt / "site")
    assert sys.path.index(str(rt / "site")) < sys.path.index(str(tmp_path / "app-site"))


def test_opt_out_restores_old_order(monkeypatch, tmp_path):
    pack = tmp_path / "gpu-pack"
    pack.mkdir()
    rt = _mk_rt(tmp_path)
    monkeypatch.setenv("PYTHONPATH", str(pack))
    monkeypatch.setattr(sys, "path", [str(pack)])

    TR.prepare_paths(str(rt), keep_env_packages=False)

    assert sys.path[0] == str(rt / "site"), "排障开关应退回「site 最前」的旧行为"


def test_prepare_paths_is_idempotent(monkeypatch, tmp_path):
    pack = tmp_path / "gpu-pack"
    pack.mkdir()
    rt = _mk_rt(tmp_path)
    monkeypatch.setenv("PYTHONPATH", str(pack))
    monkeypatch.setattr(sys, "path", [str(pack)])

    TR.prepare_paths(str(rt))
    first = list(sys.path)
    TR.prepare_paths(str(rt))
    assert sys.path == first, "重复调用不能把目录插两遍"


def test_pack_dirs_ignores_missing_paths(monkeypatch, tmp_path):
    real = tmp_path / "pack"
    real.mkdir()
    monkeypatch.setenv("PYTHONPATH", os.pathsep.join([str(real), str(tmp_path / "gone"), ""]))
    assert TR._pack_dirs() == [str(real)]


def test_dist_versions_reads_dist_info(tmp_path):
    site = tmp_path / "site"
    (site / "torch-2.14.1+cpu.dist-info").mkdir(parents=True)
    (site / "torchaudio-2.14.1+cpu.dist-info").mkdir()
    v = TR.dist_versions(str(site))
    assert v["torch"] == "2.14.1+cpu"
    assert v["torchaudio"] == "2.14.1+cpu"
    assert TR.dist_versions(str(tmp_path / "nope")) == {}


def test_describe_torch_mentions_version_and_device():
    msg = TR.describe_torch({"torch": "2.9.1+cu128", "cuda": "12.8", "cuda_available": True,
                             "file": "C:/pack/torch/__init__.py", "torchaudio": "2.9.1+cu128"})
    assert "2.9.1+cu128" in msg and "CUDA 可用" in msg

    msg_cpu = TR.describe_torch({"torch": "2.14.1+cpu", "cuda": None, "cuda_available": False,
                                 "file": "C:/miros/site/torch/__init__.py"})
    assert "仅 CPU" in msg_cpu

    err = TR.describe_torch({"error": "ImportError: dll load failed"})
    assert "torch 不可用" in err


def test_cpu_fallback_hint_three_cases(monkeypatch):
    monkeypatch.delenv("PYTHONPATH", raising=False)
    no_pack = TR.cpu_fallback_hint("miros", {"torch": "2.14.1+cpu", "cuda_available": False})
    assert "未检测到 GPU 增强包" in no_pack and "GPU 增强包" in no_pack

    monkeypatch.setenv("PYTHONPATH", os.path.dirname(os.path.abspath(__file__)))
    with_pack = TR.cpu_fallback_hint("miros", {"torch": "2.9.1+cu128", "cuda_available": False})
    assert "CUDA 不可用" in with_pack

    assert TR.cpu_fallback_hint("miros", {"torch": "2.9.1+cu128", "cuda_available": True}) is None


def test_torch_compat_warning_points_out_version_gap(tmp_path):
    site = tmp_path / "site"
    (site / "torch-2.14.1+cpu.dist-info").mkdir(parents=True)
    warn = TR.torch_compat_warning("miros", str(site))
    # 本机真实导入的 torch 与 2.14.1 不同才会给提醒；相同则无需提醒
    info = TR.torch_info()
    if info.get("torch") and str(info["torch"]).split("+")[0] != "2.14.1":
        assert warn and "FUFUMIDI_RUNTIME_BUNDLED_TORCH=1" in warn
    else:
        assert warn is None

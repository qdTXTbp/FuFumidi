# -*- coding: utf-8 -*-
"""transcribe_runtime（可选引擎统一运行时层）测试。

★ 2026-10-21 新增。这三个引擎（hFT / YourMT3+ / MIROS）接入时各写了一遍
「找目录 / 塞 sys.path / 打 torchaudio 补丁 / 造 wandb 桩 / 选设备 / 限线程」，
现在收敛到 transcribe_runtime.py。本文件锁住它的契约，防止又散开。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import transcribe_runtime as TR


def test_runtime_labels_cover_all_optional_engines():
    """三个可选引擎都要有日志/报错标签（漏一个，用户看到的就是裸 id）。"""
    for k in ("hft_transformer", "yourmt3", "miros"):
        assert k in TR.RUNTIME_LABELS and TR.RUNTIME_LABELS[k]


def test_find_runtime_env_override_wins(monkeypatch, tmp_path):
    d = tmp_path / "rt"
    d.mkdir()
    monkeypatch.setenv("FUFUMIDI_MIROS_RUNTIME", str(d))
    monkeypatch.setenv("FUFUMIDI_MODELS_DIR", str(tmp_path / "models"))
    assert TR.find_runtime("miros") == str(d)


def test_find_runtime_falls_back_to_models_dir(monkeypatch, tmp_path):
    models = tmp_path / "models"
    (models / "yourmt3").mkdir(parents=True)
    monkeypatch.delenv("FUFUMIDI_YOURMT3_RUNTIME", raising=False)
    monkeypatch.setenv("FUFUMIDI_MODELS_DIR", str(models))
    assert TR.find_runtime("yourmt3") == str(models / "yourmt3")


def test_find_runtime_none_when_absent(monkeypatch, tmp_path):
    monkeypatch.delenv("FUFUMIDI_MIROS_RUNTIME", raising=False)
    monkeypatch.setenv("FUFUMIDI_MODELS_DIR", str(tmp_path / "nope"))
    assert TR.find_runtime("miros") is None
    monkeypatch.delenv("FUFUMIDI_MODELS_DIR", raising=False)
    assert TR.find_runtime("miros") is None


def test_available_requires_all_relative_paths(monkeypatch, tmp_path):
    """required 里少任何一个 → False（"目录在"不等于"装好了"）。"""
    models = tmp_path / "models"
    rt = models / "miros"
    (rt / "site" / "transformers").mkdir(parents=True)
    (rt / "site" / "transformers" / "__init__.py").write_text("", encoding="utf-8")
    monkeypatch.setenv("FUFUMIDI_MODELS_DIR", str(models))
    monkeypatch.delenv("FUFUMIDI_MIROS_RUNTIME", raising=False)
    assert TR.available("miros", required=["site/transformers/__init__.py"]) is True
    # 缺 repo/transcribe.py → False
    assert TR.available("miros", required=["site/transformers/__init__.py", "repo/transcribe.py"]) is False
    # 换个没有运行时的名字 → False
    assert TR.available("yourmt3", required=["site"]) is False


def test_first_existing_and_glob_first(tmp_path):
    rt = tmp_path / "rt"
    (rt / "amt" / "logs" / "2024" / "exp" / "checkpoints").mkdir(parents=True)
    ck = rt / "amt" / "logs" / "2024" / "exp" / "checkpoints" / "model.ckpt"
    ck.write_text("x", encoding="utf-8")
    assert TR.first_existing(str(rt), ["nope", os.path.join("amt", "logs", "2024", "exp", "checkpoints", "model.ckpt")]) == str(ck)
    assert TR.first_existing(str(rt), ["nope"]) is None
    hit = TR.glob_first(str(rt), os.path.join("**", "checkpoints", "model.ckpt"))
    assert hit and hit.endswith("model.ckpt")
    assert TR.glob_first(str(rt), os.path.join("**", "nope.bin")) is None


def test_runtime_missing_message_names_the_engine():
    m = TR.runtime_missing_message("miros")
    assert "MIROS" in m and "资源中心" in m


def test_limit_threads_respects_cap():
    """线程上限封顶：转录是后台任务，不能把 UI 线程饿死。"""
    assert TR.THREAD_CAP == 8
    n = TR.limit_threads(64)
    assert n is None or n <= TR.THREAD_CAP


def test_count_notes_reads_note_on_only(tmp_path):
    """只数 note_on 且 velocity>0 —— note_off 与 vel=0 的 note_on 都不算。"""
    mid = tmp_path / "a.mid"
    # 最小 SMF：一个轨，两个 note_on(vel>0) + 一个 note_off + 一个 note_on(vel=0)
    data = bytes([
        0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 0x60,
        0x4D, 0x54, 0x72, 0x6B, 0, 0, 0, 0x14,
        0x00, 0x90, 60, 100,
        0x10, 0x80, 60, 0,
        0x00, 0x90, 62, 90,
        0x10, 0x90, 64, 0,          # velocity=0 等价 note_off，不算
        0x00, 0xFF, 0x2F, 0x00,
    ])
    mid.write_bytes(data)
    assert TR.count_notes(str(mid)) == 2
    assert TR.count_notes(str(tmp_path / "missing.mid")) == 0


def test_release_gpu_is_safe_without_torch():
    """没装 torch / 没 GPU 时也必须安静返回（它是 finally 里的收尾）。"""
    TR.release_gpu()

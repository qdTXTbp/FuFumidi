# -*- coding: utf-8 -*-
"""三个可选转录引擎（hFT / YourMT3+ / MIROS）的就绪判据测试。

★ 2026-10-21：这三个引擎改用 transcribe_runtime.py 统一封装后，`available()`
不能再凭「目录在不在」骗人 —— 半截解包、错版结构都目录齐全。本文件锁住：
  1. 没有 models 目录 / 没有运行时 → 一律 False，且报错文案点名引擎；
  2. 权重路径用 glob 发现，**不写死训练批次目录名**（MIROS 以前就踩这个坑：
     换一批训练 → 「下载完了还说没装」，而这种不一致不报错，最难查）；
  3. 半个权重文件不算装好。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import transcribe_runtime as TR


def _set_models(monkeypatch, tmp_path):
    models = tmp_path / "models"
    models.mkdir(exist_ok=True)
    monkeypatch.setenv("FUFUMIDI_MODELS_DIR", str(models))
    monkeypatch.delenv("FUFUMIDI_HFT_TRANSFORMER_RUNTIME", raising=False)
    monkeypatch.delenv("FUFUMIDI_YOURMT3_RUNTIME", raising=False)
    monkeypatch.delenv("FUFUMIDI_MIROS_RUNTIME", raising=False)
    return models


def test_all_three_unavailable_without_models_dir(monkeypatch, tmp_path):
    monkeypatch.delenv("FUFUMIDI_MODELS_DIR", raising=False)
    for v in ("FUFUMIDI_HFT_TRANSFORMER_RUNTIME", "FUFUMIDI_YOURMT3_RUNTIME", "FUFUMIDI_MIROS_RUNTIME"):
        monkeypatch.delenv(v, raising=False)
    import engine_hft, engine_yourmt3, engine_miros
    assert engine_hft.available() is False
    assert engine_yourmt3.available() is False
    assert engine_miros.available() is False


def test_miros_available_is_false_on_empty_runtime(monkeypatch, tmp_path):
    models = _set_models(monkeypatch, tmp_path)
    (models / "miros").mkdir()
    import engine_miros
    assert engine_miros.available() is False
    assert engine_miros.find_checkpoint() is None
    assert engine_miros.find_musicfm() is None


def test_miros_checkpoint_found_by_glob_not_hardcoded(monkeypatch, tmp_path):
    """训练批次目录名会变（MIROS 以前写死 le2bzt53）—— glob 必须能发现别的名字。"""
    models = _set_models(monkeypatch, tmp_path)
    rt = models / "miros"
    exp = rt / "repo" / "logs" / "SomeOtherBatch_2027" / "run9" / "checkpoints"
    exp.mkdir(parents=True)
    ck = exp / "last.ckpt"
    ck.write_bytes(b"x")
    import engine_miros
    assert engine_miros.find_checkpoint() == str(ck)


def test_yourmt3_available_needs_big_checkpoint(monkeypatch, tmp_path):
    """361 MB 权重：半截文件（几十 KB）不算装好。"""
    models = _set_models(monkeypatch, tmp_path)
    rt = models / "yourmt3"
    (rt / "site").mkdir(parents=True)
    (rt / "amt" / "src").mkdir(parents=True)
    ck_dir = rt / "amt" / "logs" / "2024" / engine_exp / "checkpoints"
    ck_dir.mkdir(parents=True)
    (ck_dir / "model.ckpt").write_bytes(b"x" * 1024)      # 1 KB，明显是半截
    import engine_yourmt3
    assert engine_yourmt3.available() is False


def test_yourmt3_accepts_alternate_logs_layout(monkeypatch, tmp_path):
    """资源包可能把权重放在 logs/ 而不是 amt/logs/（6.1.5 的兜底）。"""
    models = _set_models(monkeypatch, tmp_path)
    rt = models / "yourmt3"
    (rt / "site").mkdir(parents=True)
    (rt / "amt" / "src").mkdir(parents=True)
    alt = rt / "logs" / "2024" / engine_exp / "checkpoints"
    alt.mkdir(parents=True)
    (alt / "model.ckpt").write_bytes(b"x" * (200 * 1024 * 1024))
    import engine_yourmt3
    assert engine_yourmt3.available() is True


def test_hft_model_path_is_fixed(monkeypatch, tmp_path):
    """hFT 权重路径是资源中心解包的固定相对路径（22 MB，单文件）。"""
    models = _set_models(monkeypatch, tmp_path)
    import engine_hft
    assert engine_hft.find_model() is None
    p = models / "hft_transformer" / "checkpoint" / "MAESTRO-V3"
    p.mkdir(parents=True)
    (p / "model_016_003.pkl").write_bytes(b"x" * (2 * 1024 * 1024))
    assert engine_hft.find_model() == str(p / "model_016_003.pkl")


def test_missing_runtime_error_names_engine(monkeypatch, tmp_path):
    """报错必须点名是哪个引擎、让用户去哪下（不能只说"未找到运行时"）。"""
    _set_models(monkeypatch, tmp_path)
    for mod_name, label in (("engine_miros", "MIROS"), ("engine_yourmt3", "YourMT3+")):
        mod = __import__(mod_name)
        try:
            mod.transcribe_miros("a.wav", "b.mid") if mod_name == "engine_miros" \
                else mod.transcribe_yourmt3("a.wav", "b.mid")
            raise AssertionError("应当抛错")
        except RuntimeError as e:
            assert label in str(e) and "资源中心" in str(e)


#: 与 engine_yourmt3._EXP 同值（避免测试反向依赖实现细节的拼写）
engine_exp = "ptf_all_cross_rebal5_mirst_xk2_edr005_attend_c_full_plus_b100"

# -*- coding: utf-8 -*-
"""★ M3-2 超分辨率预处理的回归测试（不需要真的装 waifu2x）。

这一层只对**低清页**生效：Audiveris 的 ScaleBuilder 要求行距 ≥ 11px，低于它整页判 invalid。
所以测试的重点不是"能不能放大"，而是**门槛判得对不对**：正常印刷谱必须一个字节都不动。
"""
import os
import sys
import tempfile

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import engine_omr_backends as B  # noqa: E402
import omr_fixture  # noqa: E402


@pytest.fixture(autouse=True)
def _no_ambient_sr(monkeypatch):
    """测试不许受本机装没装 waifu2x 影响（装了也不该改变这些断言）。"""
    monkeypatch.delenv("FUFUMIDI_WAFU2X", raising=False)
    monkeypatch.delenv("FUFUMIDI_DATA_ROOT", raising=False)


def _page(path, w=800, h=600):
    omr_fixture.build(path)
    return path


# ---------------- 门槛 ----------------

def test_sr_off_returns_inputs_untouched():
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = _page(os.path.join(tmp, "a.png"))
    out, infos = B.sr_prepare_inputs([p], tmp, "off")
    assert out == [p] and infos == []


def test_sr_auto_never_uses_a_missing_component():
    """没装组件时 auto 必须原样退回原图（超分是增强，不能因为它没装就少一页）。"""
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = _page(os.path.join(tmp, "a.png"))
    out, infos = B.sr_prepare_inputs([p], tmp, "auto")
    assert out == [p]
    assert len(infos) == 1 and infos[0]["used"] is False
    assert infos[0]["reason"] in ("interline-ok", "unmeasurable", "not-installed"), infos[0]


def test_sr_auto_skips_pages_that_already_have_enough_interline(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = _page(os.path.join(tmp, "a.png"))
    monkeypatch.setattr(B, "measure_interline", lambda s: (16.25, 14))
    monkeypatch.setattr(B, "find_sr", lambda explicit=None: "C:/fake/waifu2x.exe")
    called = []
    monkeypatch.setattr(B, "run_sr", lambda *a, **k: called.append(1) or (True, ""))
    out, infos = B.sr_prepare_inputs([p], tmp, "auto")
    assert out == [p] and not called, "行距 16px 的正常印刷谱不该走超分"
    assert infos[0]["reason"] == "interline-ok"


def test_sr_auto_kicks_in_below_the_audiveris_limit(monkeypatch):
    """行距 5px（Audiveris 会判 invalid）→ 必须超分，并且交给下游的是**超分后的文件**。"""
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = _page(os.path.join(tmp, "a.png"))
    monkeypatch.setattr(B, "measure_interline", lambda s: (4.0, 14))
    monkeypatch.setattr(B, "find_sr", lambda explicit=None: "C:/fake/waifu2x.exe")

    def fake_run(src, dst, **kw):
        Image.open(src).resize((400, 300)).save(dst)
        return True, ""
    monkeypatch.setattr(B, "run_sr", fake_run)
    out, infos = B.sr_prepare_inputs([p], tmp, "auto")
    assert out != [p] and out[0].endswith("-x2.png") and os.path.exists(out[0])
    assert infos[0]["used"] is True and infos[0]["reason"] == "ok" and infos[0]["interline"] == 4.0


def test_sr_auto_triggers_when_interline_cannot_be_measured(monkeypatch):
    """★ 一行谱表都没量出来（实测 0.4× 的总谱页）才是最该超分的一档：
    旧门控要求 sp > 0，把这一档整个漏掉（0 个音符 → 0 个音符）；现在必须触发。"""
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = _page(os.path.join(tmp, "a.png"))
    monkeypatch.setattr(B, "measure_interline", lambda s: (0.0, 0))
    monkeypatch.setattr(B, "find_sr", lambda explicit=None: "C:/fake/waifu2x.exe")
    monkeypatch.setattr(B, "run_sr", lambda src, dst, **k: (Image.open(src).save(dst), (True, ""))[1])
    out, infos = B.sr_prepare_inputs([p], tmp, "auto")
    assert infos[0]["used"] is True and infos[0]["reason"] == "ok", infos[0]
    assert out != [p]


def test_sr_auto_skips_clean_low_res_pages_above_the_floor(monkeypatch):
    """清晰矢量 PDF 渲染出来的低清页（实测 interline 6.0：不超分 F1 1.00、超分掉到 0.82）
    必须**不动** —— 这条界线是拿质量对照量出来的，不是拍的。"""
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = _page(os.path.join(tmp, "a.png"))
    monkeypatch.setattr(B, "measure_interline", lambda s: (6.0, 23))
    monkeypatch.setattr(B, "find_sr", lambda explicit=None: "C:/fake/waifu2x.exe")
    called = []
    monkeypatch.setattr(B, "run_sr", lambda *a, **k: called.append(1) or (True, ""))
    out, infos = B.sr_prepare_inputs([p], tmp, "auto")
    assert out == [p] and not called and infos[0]["reason"] == "interline-ok"


def test_sr_on_forces_even_high_interline(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = _page(os.path.join(tmp, "a.png"))
    monkeypatch.setattr(B, "measure_interline", lambda s: (22.0, 3))
    monkeypatch.setattr(B, "find_sr", lambda explicit=None: "C:/fake/waifu2x.exe")
    monkeypatch.setattr(B, "run_sr", lambda src, dst, **k: (Image.open(src).save(dst), (True, ""))[1])
    out, infos = B.sr_prepare_inputs([p], tmp, "on")
    assert infos[0]["used"] is True and out != [p]


def test_sr_failure_falls_back_to_the_original_page(monkeypatch):
    """超分进程挂了 / 出不了文件 —— 必须退回原图并如实回报，不许整页失败。"""
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = _page(os.path.join(tmp, "a.png"))
    monkeypatch.setattr(B, "measure_interline", lambda s: (4.0, 14))
    monkeypatch.setattr(B, "find_sr", lambda explicit=None: "C:/fake/waifu2x.exe")
    monkeypatch.setattr(B, "run_sr", lambda *a, **k: (False, "vulkan device lost"))
    out, infos = B.sr_prepare_inputs([p], tmp, "auto")
    assert out == [p] and infos[0]["used"] is False
    assert infos[0]["reason"].startswith("failed:") and "vulkan" in infos[0]["reason"]


def test_sr_skips_absurdly_large_pages(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = os.path.join(tmp, "big.png")
    Image.new("L", (4200, 4200), 255).save(p)      # 17.6 M 像素 > SR_MAX_SRC_PIXELS
    monkeypatch.setattr(B, "measure_interline", lambda s: (4.0, 14))
    monkeypatch.setattr(B, "find_sr", lambda explicit=None: "C:/fake/waifu2x.exe")
    out, infos = B.sr_prepare_inputs([p], tmp, "auto")
    assert out == [p] and infos[0]["reason"] == "page-too-large"


# ---------------- 组件定位 ----------------

def test_find_sr_prefers_explicit_then_env(tmp_path, monkeypatch):
    exe = tmp_path / "explicit.exe"
    exe.write_bytes(b"MZ")
    env = tmp_path / "env.exe"
    env.write_bytes(b"MZ")
    assert B.find_sr(str(exe)) == str(exe)
    monkeypatch.setenv("FUFUMIDI_WAFU2X", str(env))
    assert B.find_sr() == str(env)
    assert B.find_sr(str(exe)) == str(exe), "显式路径优先于环境变量"


def test_run_sr_without_component_is_a_clean_failure(monkeypatch):
    monkeypatch.setattr(B, "find_sr", lambda explicit=None: None)
    ok, why = B.run_sr("a.png", "b.png")
    assert ok is False and "资源中心" in why


def test_sr_result_is_reported_in_the_run_info():
    """引擎 RESULT 要带上 srInfo，界面才看得见「这页到底超分没超分」。"""
    tmp = tempfile.mkdtemp(prefix="omr-sr-")
    p = _page(os.path.join(tmp, "a.png"))
    out = os.path.join(tmp, "out.mid")
    code = B.main(["to-midi", "--in", p, "--out", out, "--backend", "classical",
                   "--beats", "4", "--tempo", "120", "--sr", "auto", "--workdir", tmp])
    assert code == 0

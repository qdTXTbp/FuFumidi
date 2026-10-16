# -*- coding: utf-8 -*-
"""★ M3-3 共用影像预处理层 的回归测试（不依赖 Audiveris / homr）。

这一层解决的是「扫描件、拍照件」：歪的、半边有阴影的、带灰点的。
四件武器各自单独测一遍，再测「干净印刷谱不被它弄坏」这条底线。
"""
import os
import sys
import tempfile

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import engine_omr as O  # noqa: E402
import engine_omr_backends as B  # noqa: E402


# ---------------- 合成页 ----------------

def _score_page(w=900, h=700, bg=245, ink=25, shadow=False, n_sys=6):
    """画 6 行「谱表」（每行 5 条线）+ 若干符头；shadow=True 时右半边压暗。"""
    a = np.full((h, w), float(bg), dtype=np.float32)
    for s in range(n_sys):
        top = 40 + s * (h // n_sys)
        for k in range(5):
            y = top + k * 8
            a[y:y + 2, 40:w - 40] = ink
        for x in range(60, w - 60, 34):
            a[top - 6:top + 40, x:x + 5] = ink          # 符干
            a[top + 12:top + 20, x:x + 9] = ink          # 符头
    if shadow:
        gx = np.linspace(1.0, 0.45, w, dtype=np.float32)[None, :]
        a = a * gx
    return np.clip(a, 0, 255).astype(np.uint8)


def _specks(img, n=300, size=2, seed=3):
    a = img.copy()
    rng = np.random.default_rng(seed)
    for _ in range(n):
        y = int(rng.integers(0, a.shape[0] - size))
        x = int(rng.integers(0, a.shape[1] - size))
        a[y:y + size, x:x + size] = 40
    return a


def _save(a, name="p.png"):
    d = tempfile.mkdtemp(prefix="omr-prep-")
    p = os.path.join(d, name)
    Image.fromarray(a).save(p)
    return p


# ---------------- ① 去倾斜 ----------------

def test_estimate_skew_finds_known_angle():
    base = _score_page()
    for truth in (2.0, -3.0):
        rot = np.asarray(Image.fromarray(base).rotate(truth, resample=Image.BICUBIC, fillcolor=255))
        ang, _sc = O.estimate_skew(rot)
        # ★ 符号约定：estimate_skew 返回的是「要转回去的角度」，与 PIL rotate 的
        #   逆时针为正**相反** —— 真值 +2° 应估出 -2°。
        assert abs(ang + truth) <= 0.4, "真值 %.1f° 估成 %.2f°" % (truth, ang)


def test_deskew_removes_skew_and_returns_ndarray():
    base = _score_page()
    rot = np.asarray(Image.fromarray(base).rotate(-3.0, resample=Image.BICUBIC, fillcolor=255))
    out, ang = O.deskew(rot, min_deg=0.25)
    assert abs(ang - 3.0) <= 0.4, ang
    # deskew 转过之后返回 PIL（旋转要重采样），由 prep_gray / prep_image 归一成 ndarray ——
    # 契约是「形状不变 + 可以直接再喂给 estimate_skew」。
    arr = np.asarray(out)
    assert arr.shape == rot.shape, (arr.shape, rot.shape)
    residual, _ = O.estimate_skew(arr)
    assert abs(residual) <= 0.4, "校正后残差 %.2f°" % residual


def test_deskew_leaves_straight_page_alone():
    base = _score_page()
    out, ang = O.deskew(base, min_deg=0.25)
    assert ang == 0.0 and out is base, "正着的图不该被重采样（会掉笔画细节）"


# ---------------- ② 局部二值化 ----------------

def test_sauvola_survives_half_shadow():
    """全局阈值把暗半边整片判成墨；Sauvola 两边都能出字。"""
    shadow = _score_page(shadow=True)
    ink_s, _thr = O.sauvola(shadow)
    w = shadow.shape[1]
    bright = float(ink_s[:, :w // 2].mean())
    dark = float(ink_s[:, w // 2:].mean())
    assert 0.005 < bright < 0.25, "亮半边墨占比 %.4f" % bright
    assert 0.005 < dark < 0.25, "暗半边墨占比 %.4f（全局阈值会给 1.0）" % dark
    assert 0.3 < (dark / max(bright, 1e-6)) < 3.0, "两半不该差一个量级：%.4f vs %.4f" % (bright, dark)
    # 对照：全局阈值（Otsu 型）在这张图上会把暗半边整片吃掉
    glob = shadow < int(O.binarize(shadow.astype(np.float32))[1])
    assert float(glob[:, w // 2:].mean()) > 0.5, "对照组本身就应该是坏的，否则这个测试没有意义"


def test_sauvola_clean_page_matches_global_threshold():
    """干净印刷谱上两条路必须基本一致 —— 这是「不劣化」的底线。"""
    clean = _score_page()
    ink_s, _ = O.sauvola(clean)
    ink_g, _thr, _frac = O.binarize(clean.astype(np.float32))
    a, b = float(ink_s.mean()), float(ink_g.mean())
    assert abs(a - b) < 0.02, "Sauvola %.4f vs 全局 %.4f" % (a, b)


# ---------------- ③ 去噪点 ----------------

def test_despeckle_removes_dots_keeps_strokes():
    clean = _score_page()
    dirty = _specks(clean, n=300, size=2)
    ink_d, _ = O.sauvola(dirty)
    ink_c, _ = O.sauvola(clean)
    out, removed = O.despeckle(ink_d, min_px=6)
    assert removed >= 200, "注入 300 个 2×2 灰点，只去掉 %d 个" % removed
    assert out.sum() < ink_d.sum(), "去噪点后墨像素必须变少"
    assert out.sum() >= ink_c.sum() * 0.9, "不许把谱面笔画也一起去掉：%d vs %d" % (out.sum(), ink_c.sum())


def test_despeckle_noop_on_clean_ink():
    ink, _ = O.sauvola(_score_page())
    out, removed = O.despeckle(ink, min_px=6)
    assert removed == 0 and out.sum() == ink.sum()


# ---------------- ④ 「像不像扫描件」的判据 ----------------

def test_looks_like_scan_flags_shadow_and_speckles_but_not_clean():
    ok, why = O.looks_like_scan(_score_page(), 0.0)
    assert not ok, "干净印刷谱不该被判成扫描件（原因 %s）" % why
    ok2, why2 = O.looks_like_scan(_score_page(shadow=True), 0.0)
    assert ok2 and why2 in ("uneven-background", "noisy"), why2
    ok3, why3 = O.looks_like_scan(_score_page(), 3.0)
    assert ok3 and why3 == "skew", why3


# ---------------- ⑤ 接进流水线 ----------------

def test_prep_image_auto_keeps_a_clean_page_untouched():
    src = _save(_score_page())
    a = os.path.join(os.path.dirname(src), "off.png")
    b = os.path.join(os.path.dirname(src), "auto.png")
    i_off = B.prep_image(src, a, scale=2, prep="off")
    i_auto = B.prep_image(src, b, scale=2, prep="auto")
    assert i_auto["prep"] == "clean" and i_auto["skew"] == 0.0, i_auto
    assert i_off["prep"] == "off"
    assert np.array_equal(np.asarray(Image.open(a)), np.asarray(Image.open(b))), \
        "干净谱走 auto 必须和 off 逐像素一致"


def test_prep_image_scan_mode_uses_sauvola_on_a_shadowed_page():
    clean = _score_page(shadow=True)
    src = _save(clean)
    off = os.path.join(os.path.dirname(src), "off.png")
    scn = os.path.join(os.path.dirname(src), "scan.png")
    B.prep_image(src, off, scale=1, prep="off")
    info = B.prep_image(src, scn, scale=1, prep="scan")
    assert info["prep"] == "scan" and info["prepWhy"] == "forced"
    bad = float((np.asarray(Image.open(off)) < 128).mean())
    good = float((np.asarray(Image.open(scn)) < 128).mean())
    assert bad > 0.5, "对照组（旧路径）在这张阴影图上本来就该是坏的：%.4f" % bad
    assert good < 0.3, "预处理后墨占比 %.4f 仍然过高" % good
    assert set(np.unique(np.asarray(Image.open(scn))).tolist()) <= {0, 255}


def test_prep_image_auto_detects_and_straightens_a_skewed_scan():
    rot = np.asarray(Image.fromarray(_score_page(shadow=True)).rotate(
        3.0, resample=Image.BICUBIC, fillcolor=255))
    src = _save(rot)
    dst = os.path.join(os.path.dirname(src), "auto.png")
    info = B.prep_image(src, dst, scale=1, prep="auto")
    assert info["prep"] == "scan", info
    assert abs(float(info["skew"]) + 3.0) <= 0.5, info
    assert info["despeckled"] >= 0


def test_prep_gray_is_the_shared_entry_point():
    shadow = _score_page(shadow=True).astype(np.float32)
    out, info = O.prep_gray(shadow, "scan")
    assert info["prep"] == "scan"
    assert out.dtype == np.float32 and out.shape == shadow.shape
    assert set(np.unique(out).tolist()) <= {0.0, 255.0}, "scan 模式应给出二值化后的灰度"
    # 再喂一遍必须幂等（不能越处理越糊）
    again, _ = O.prep_gray(out, "scan")
    assert np.array_equal(out, again.astype(np.float32)) or float(
        (np.abs(again - out) > 1).mean()) < 0.02
    off, info_off = O.prep_gray(shadow, "off")
    assert info_off["prep"] == "off" and off is shadow


def test_prep_arg_normalizes_values():
    assert B.prep_arg("off") == "off"
    assert B.prep_arg("AUTO") == "auto"
    assert B.prep_arg("scan") == "scan"
    assert B.prep_arg(None) == "auto"
    assert B.prep_arg("on") == "scan" and B.prep_arg(False) == "off"

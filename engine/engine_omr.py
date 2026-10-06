# -*- coding: utf-8 -*-
"""
engine_omr.py —— 「变谱」的光学识谱（OMR）：图片 / PDF 页面 → MIDI

设计约束（为什么这么写）：
  * 只依赖 numpy / scipy / Pillow —— 这三样安装版 resources/python 里本来就有，
    不引入 opencv、不下载模型权重，离线可用（模型版 OMR 以后可作为可选增强包挂进来，
    接口就在 run_omr() 这一层）。
  * 参数一律以「谱线间距 spacing」为单位。同一个算法要能同时吃 6px 间距的
    低清 GIF 和 20px 间距的 300dpi 扫描件，写死像素值必然只对一种输入有效。
  * 符头检测用「匹配滤波 + 局部极大值」而不是「先去谱线再连通域」：去线一定会
    把压在谱线上的符头一起抹掉，这是经典 OMR 的第一大坑。
  * 一份乐谱的版面几何（谱表/小节线/符头）先全部量出来，再谈音高与节奏；
    音高只由「符头中心到谱表下线的音级步数」决定，是整条链里最可靠的一环。

CLI:
  python engine_omr.py to-midi --in page1.gif [--in page2.png ...] --out out.mid
      [--beats 4] [--beat-type 4] [--tempo 120] [--overlay out.png]
      [--debug] [--max-notes N]
输出:
  ###PROG {"percent": n, "text": "..."}
  ###RESULT {...}
"""
import argparse
import json
import math
import os
import sys
import traceback

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

LETTER_SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
LETTERS = ["C", "D", "E", "F", "G", "A", "B"]
# 谱表下线对应的自然音级（C0 = 0 起算：C4 = 28, E4 = 30, G2 = 18, F3 = 24）
CLEF_BASE_STEP = {"treble": 30, "bass": 18, "alto": 28, "tenor": 25}
KEY_SIGS = {  # 升号数为正、降号数为负 -> 各音级上的变化音
    0: {}, 1: {"F": 1}, 2: {"F": 1, "C": 1}, 3: {"F": 1, "C": 1, "G": 1},
    4: {"F": 1, "C": 1, "G": 1, "D": 1}, 5: {"F": 1, "C": 1, "G": 1, "D": 1, "A": 1},
    6: {"F": 1, "C": 1, "G": 1, "D": 1, "A": 1, "E": 1},
    7: {"F": 1, "C": 1, "G": 1, "D": 1, "A": 1, "E": 1, "B": 1},
    -1: {"B": -1}, -2: {"B": -1, "E": -1}, -3: {"B": -1, "E": -1, "A": -1},
    -4: {"B": -1, "E": -1, "A": -1, "D": -1},
    -5: {"B": -1, "E": -1, "A": -1, "D": -1, "G": -1},
    -6: {"B": -1, "E": -1, "A": -1, "D": -1, "G": -1, "C": -1},
    -7: {"B": -1, "E": -1, "A": -1, "D": -1, "G": -1, "C": -1, "F": -1},
}


def emit(kind, payload):
    sys.stdout.write("###" + kind + " " + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def prog(pct, text):
    emit("PROG", {"percent": int(pct), "text": text})


# ----------------------------------------------------------------------------
# 1. 读图 / 二值化
# ----------------------------------------------------------------------------

def load_frames(path):
    """返回 [(name, gray ndarray), ...]。多帧 GIF / TIFF 的每一帧当作一页。"""
    im = Image.open(path)
    frames = []
    n = getattr(im, "n_frames", 1)
    for i in range(n):
        try:
            im.seek(i)
        except EOFError:
            break
        fr = im.convert("L")
        name = os.path.basename(path) + ("" if n == 1 else "#%d" % (i + 1))
        frames.append((name, np.asarray(fr).astype(np.float32)))
    if not frames:
        frames = [(os.path.basename(path), np.asarray(im.convert("L")).astype(np.float32))]
    return frames


def binarize(gray):
    """自适应阈值：乐谱里「灰」往往是细谱线被缩放/JPEG 后的结果，按 Otsu 卡在
    128 会把整条谱线判成背景（实测 630x924 的曲谱网 GIF 就是这样）。"""
    g = gray.astype(np.float32)
    p98 = float(np.percentile(g, 98))
    p1 = float(np.percentile(g, 1))
    frac_target = (0.004, 0.30)
    best = None
    for k in (0.20, 0.28, 0.34, 0.14, 0.10):
        thr = p98 - k * (p98 - p1)
        ink = g < thr
        f = float(ink.mean())
        if best is None:
            best = (ink, thr, f)
        if frac_target[0] <= f <= frac_target[1]:
            return ink, thr, f
    return best


# ----------------------------------------------------------------------------
# 2. 谱表（5 线）与小节线
# ----------------------------------------------------------------------------

def _row_runs(ink):
    """每行最长连续墨迹长度（列方向已经向量化）。"""
    h, w = ink.shape
    z = np.zeros((h, w + 2), dtype=bool)
    z[:, 1:-1] = ink
    idx = np.where(~z, np.arange(w + 2)[None, :], 0)
    np.maximum.accumulate(idx, axis=1, out=idx)
    runs = np.arange(w + 2)[None, :] - idx
    return runs.max(axis=1) - 1


def remove_staff_lines(ink, staff, factor=3.0):
    """把谱线抹掉（只抹「长横游程」的像素）。
    变化音记号、休止符、符干都压在谱线上，不去线它们会跟整条谱线连成一个连通域。
    只抹长游程，是为了不把压在谱线上的符头一起抹掉。"""
    sp = staff["spacing"]
    h, w = ink.shape
    out = ink.copy()
    thr = max(6, int(round(factor * sp)))
    y0 = max(0, int(math.floor(staff["top"] - 0.6 * sp)))
    y1 = min(h, int(math.ceil(staff["bottom"] + 0.6 * sp)))
    for y in range(y0, y1):
        row = ink[y]
        idx = np.flatnonzero(np.diff(np.concatenate(([0], row.view(np.int8), [0]))))
        starts, ends = idx[0::2], idx[1::2]
        for s, e in zip(starts, ends):
            if e - s >= thr:
                out[y, s:e] = False
    return out


def repair_vertical(mask, r=2):
    """去掉谱线后，压在线上的记号（变化音、符干、休止符）会被切成碎片；
    一次纵向闭运算把它们重新接起来 —— 谱线本身是横的，不会被接回来。"""
    return ndi.binary_closing(mask, structure=np.ones((2 * r + 1, 1), dtype=bool))


def detect_staves(ink):
    h, w = ink.shape
    row_ink = ink.sum(axis=1)
    row_run = _row_runs(ink)
    is_line = (row_ink > 0.42 * w) & (row_run > 0.25 * w)
    ys = np.flatnonzero(is_line)
    if ys.size == 0:
        return []
    # 相邻行合并成一条谱线
    groups = []
    for y in ys:
        if groups and y - groups[-1][-1] <= 2:
            groups[-1].append(int(y))
        else:
            groups.append([int(y)])
    lines = [(float(np.mean(gr)), len(gr)) for gr in groups]
    # 5 条一组聚类
    staves = []
    cur = [lines[0]]
    for y, th in lines[1:]:
        gaps = [cur[i + 1][0] - cur[i][0] for i in range(len(cur) - 1)]
        sp = float(np.median(gaps)) if gaps else None
        ok = sp is None or (abs((y - cur[-1][0]) - sp) <= max(1.4, 0.30 * sp))
        if ok and len(cur) < 5:
            cur.append((y, th))
        else:
            staves.append(cur)
            cur = [(y, th)]
    staves.append(cur)
    out = []
    for grp in staves:
        if len(grp) < 4:
            continue
        ys_ = [g[0] for g in grp]
        sp = (ys_[-1] - ys_[0]) / (len(ys_) - 1)
        out.append({"lines": ys_, "spacing": float(sp), "top": float(ys_[0]), "bottom": float(ys_[-1])})
    # 谱表左右边界：取中间那条线的长游程
    for st in out:
        y = int(round(st["lines"][len(st["lines"]) // 2]))
        band = ink[max(0, y - 1):y + 2, :].any(axis=0)
        cols = np.flatnonzero(band)
        if cols.size:
            st["x0"] = float(cols.min())
            st["x1"] = float(cols.max())
        else:
            st["x0"], st["x1"] = 0.0, float(w - 1)
    out.sort(key=lambda s: s["top"])
    return out


def detect_barlines(ink, staff):
    """小节线：一列里存在「从上线到下线」的连续墨迹，且纵向不越界太多。
    符干也会跨过整个谱表，但符干会明显伸出谱表之外，用这一点区分。"""
    top, bottom, sp = staff["top"], staff["bottom"], staff["spacing"]
    h, w = ink.shape
    y0 = max(0, int(round(top)))
    y1 = min(h, int(round(bottom)) + 1)
    band = ink[y0:y1, :]
    span = (y1 - y0)
    counts = band.sum(axis=0)
    cand = counts >= span * 0.90
    cols = np.flatnonzero(cand)
    barlines = []
    if cols.size == 0:
        return barlines
    grp = [int(cols[0])]
    for x in cols[1:]:
        if x - grp[-1] <= 2:
            grp.append(int(x))
        else:
            barlines.append(int(np.mean(grp)))
            grp = [int(x)]
    barlines.append(int(np.mean(grp)))
    # 去掉符干误判：符干在谱表外还有很长一段墨迹
    keep = []
    for x in barlines:
        # 符干会明显伸出谱表之外；小节线不会（上下各留 2 个间距的观察窗）
        above = ink[max(0, y0 - int(round(2.0 * sp))):y0, max(0, x - 1):x + 2].sum()
        below = ink[y1:min(h, y1 + int(round(2.0 * sp))), max(0, x - 1):x + 2].sum()
        if above <= 1.6 * sp and below <= 1.6 * sp:
            keep.append(x)
    return keep


def detect_system_barlines(ink, system):
    """整组谱表一起找小节线：钢琴谱的上下两行往往由同一条竖线连起来，
    按单行谱表找会因为它「伸出谱表之外」而全部被否掉（实测就是这么丢掉小节线的）。"""
    top = system[0]["top"]
    bottom = system[-1]["bottom"]
    sp = system[0]["spacing"]
    h, w = ink.shape
    y0 = max(0, int(round(top)))
    y1 = min(h, int(round(bottom)) + 1)
    span = max(1, y1 - y0)
    cov = ink[y0:y1, :].mean(axis=0)
    cand = np.flatnonzero(cov >= 0.90)
    if cand.size == 0:
        return []
    groups = [[int(cand[0])]]
    for x in cand[1:]:
        if x - groups[-1][-1] <= 2:
            groups[-1].append(int(x))
        else:
            groups.append([int(x)])
    out = []
    for grp in groups:
        x = int(np.mean(grp))
        above = ink[max(0, y0 - int(round(2.0 * sp))):y0, max(0, x - 1):x + 2].sum()
        below = ink[y1:min(h, y1 + int(round(2.0 * sp))), max(0, x - 1):x + 2].sum()
        if above <= 1.6 * sp and below <= 1.6 * sp:
            out.append(x)
    return out


def group_systems(staves):
    """把小节线横向对齐的相邻谱表归为同一系统（钢琴大谱表就是两行一组）。"""
    systems = []
    i = 0
    while i < len(staves):
        cur = [staves[i]]
        j = i + 1
        while j < len(staves) and len(cur) < 3:
            a, b = cur[-1], staves[j]
            gap = b["top"] - a["bottom"]
            dx = abs(a.get("x0", 0) - b.get("x0", 0))
            ca, cb = a.get("clef"), b.get("clef")
            # 高音谱表下面紧跟低音谱表 = 同一系统（钢琴大谱表）；
            # 「低音 -> 高音」一定是换系统了。同谱号的继续用间距判断。
            if ca == "treble" and cb == "bass":
                same = gap < 9.0 * a["spacing"] and dx < 6 * a["spacing"] + 8
            elif ca == "bass" and cb == "treble":
                same = False
            else:
                same = gap < 4.2 * a["spacing"] and dx < 6 * a["spacing"] + 8
            if same:
                cur.append(b)
                j += 1
            else:
                break
        systems.append(cur)
        i = j
    return systems


# ----------------------------------------------------------------------------
# 3. 符头（匹配滤波 + 局部极大值）
# ----------------------------------------------------------------------------

def _long_runs(mask, thr, axis):
    """标记「沿 axis 方向的游程 >= thr」的像素。"""
    out = np.zeros_like(mask)
    m = mask if axis == 1 else mask.T
    o = out if axis == 1 else out.T
    n = m.shape[0]
    for i in range(n):
        row = m[i]
        idx = np.flatnonzero(np.diff(np.concatenate(([0], row.view(np.int8), [0]))))
        starts, ends = idx[0::2], idx[1::2]
        for s, e in zip(starts, ends):
            if e - s >= thr:
                o[i, s:e] = True
    return out


def horizontal_structures(ink, sp):
    """谱线与符杠都是「又长又薄」的横向结构。
    ★ 不去掉它们，匹配滤波会在符杠上打出一串假符头 —— 实测一页多认了 60% 的音，
      而且全是同一个音高堆在同一拍上（看起来像和弦，其实是符杠）。
    只抹「横向够长 且 纵向够薄」的像素：压在谱线上的符头（纵向有 0.8 个间距）不会被误伤。"""
    # 只按「横向够长」判定：低清谱里符杠厚度和符头高度是同一个量级（都约 5 像素），
    # 再加「纵向够薄」会把符头一起抹掉（实测抹掉 85% 的墨）。
    # 压在谱线上的符头只会损失那一行像素，剩下的部分照样够匹配滤波打分。
    return _long_runs(ink, max(6, int(round(2.5 * sp))), axis=1)


def detect_noteheads(ink, staff, thr=0.45, skip_head=1.2, ink_det=None):
    """匹配滤波找符头中心。候选在「去掉谱线/符杠」的图上找（否则符杠上会打出一串假符头），
    但**判定用原图的局部形态**（core / vr / hr）—— 去掉谱线会把压在谱线上的符头削掉中间几行，
    只靠掩膜图打分会让这类符头全部落选（实测整条四分音符序列消失）。

    核大小要贴着符头实际尺寸（约 0.9x0.6 个间距）：核开大了，密集成串的十六分音符
    会把分数压到阈值以下（实测 5x9 的核把真符头压到 0.67）。"""
    sp = staff["spacing"]
    src = ink if ink_det is None else ink_det
    rh = max(1, int(round(0.28 * sp)))
    rw = max(2, int(round(0.44 * sp)))
    kh, kw = 2 * rh + 1, 2 * rw + 1
    score = ndi.uniform_filter(src.astype(np.float32), size=(kh, kw))
    local_max = score == ndi.maximum_filter(score, size=(kh, kw))
    top, bottom = staff["top"], staff["bottom"]
    y0 = max(0, int(math.floor(staff.get("y_lo", top - 3.4 * sp))))
    y1 = min(ink.shape[0], int(math.ceil(staff.get("y_hi", bottom + 3.4 * sp))))
    # 谱号 / 调号 / 拍号区：整块跳过，否则拍号数字会被当成符头
    x0 = int(max(0, staff.get("x0", 0) + skip_head * sp))
    box = staff.get("clef_box")
    if box:                                   # 谱号 + 拍号区不参与符头检测
        x0 = max(x0, int(box[1]))
    x1 = int(min(ink.shape[1], staff.get("x1", ink.shape[1]) - 0.5 * sp))
    mask = np.zeros_like(ink)
    mask[y0:y1, x0:x1] = True
    cand = local_max & mask & (score >= thr)
    ys, xs = np.nonzero(cand)
    # 空心符头（二分 / 全音符）：外环有墨、内心是白的。
    # 实心核的匹配滤波对空心符头分数很低，实测会把整条低音声部的二分音符全丢掉。
    rsm = max(1, int(round(0.24 * sp)))
    small = ndi.uniform_filter(src.astype(np.float32), size=(2 * rsm + 1, 2 * rsm + 1))
    omax = score == ndi.maximum_filter(score, size=(kh, kw))
    ocand = omax & mask & (score >= 0.46) & (small <= 0.42)
    oys, oxs = np.nonzero(ocand)
    cand_extra = []
    for y, x in zip(oys.tolist(), oxs.tolist()):
        cand_extra.append((y, x, float(score[y, x])))
    if ys.size == 0 and not cand_extra:
        return [], score
    vals = score[ys, xs]
    order = np.argsort(-vals)
    picked = []
    for k in order:
        y, x, v = int(ys[k]), int(xs[k]), float(vals[k])
        # 去重：同一个符头会打出两个峰（差半个音级）。
        # 刻版里同一个 x 上不会有两个音（和弦的相邻音级会左右错开），所以按 x 归并。
        if all(abs(x - px) > 0.45 * sp for py, px, _ in picked):
            picked.append((y, x, v))
    for (y, x, v) in sorted(cand_extra, key=lambda p: -p[2]):
        if all(abs(x - px) > 0.45 * sp or abs(y - py) > 1.2 * sp for py, px, _ in picked):
            picked.append((y, x, v))
    picked.sort(key=lambda p: (p[1], p[0]))
    return picked, score


def local_features(ink, y, x, sp, barlines=None):
    """量局部形态。**必须在带谱线的原图上量**：去谱线会把压在谱线上的符头像素
    一起抹掉，那样量出来的「竖向游程」是残废的（一版就栽在这里：只剩 10 个音符）。
    谱线本身靠「竖向游程」区分 —— 符头竖着有 0.7~1.1 个间距，谱线只有 0.1~0.2。"""
    h, w = ink.shape

    def run(axis):
        i = y if axis == 0 else x
        n = h if axis == 0 else w
        c = 0
        gap = 0
        while 0 <= i < n:
            v = ink[i, x] if axis == 0 else ink[y, i]
            if v:
                c += 1
                gap = 0
            else:
                gap += 1
                if gap > 1:
                    break
            i += 1
        i = (y if axis == 0 else x) - 1
        gap = 0
        while 0 <= i < n:
            v = ink[i, x] if axis == 0 else ink[y, i]
            if v:
                c += 1
                gap = 0
            else:
                gap += 1
                if gap > 1:
                    break
            i -= 1
        return c

    ry, rx = max(1, int(round(0.22 * sp))), max(2, int(round(0.34 * sp)))
    core = ink[max(0, y - ry):y + ry + 1, max(0, x - rx):x + rx + 1]
    core_fill = float(core.mean()) if core.size else 0.0
    oy, ox = max(1, int(round(0.62 * sp))), max(2, int(round(0.85 * sp)))
    outer = ink[max(0, y - oy):y + oy + 1, max(0, x - ox):x + ox + 1]
    outer_fill = float(outer.mean()) if outer.size else 0.0
    patch = ink[max(0, y - 1):y + 2, max(0, x - 2):x + 3]
    center = float(patch.mean()) if patch.size else 0.0
    # 局部横向尺度：只在 ±0.9 间距的窗口里数，免得把整条谱线算进来
    hw = max(2, int(round(0.9 * sp)))
    band = ink[max(0, y - max(1, int(round(0.35 * sp)))):y + max(1, int(round(0.35 * sp))) + 1,
               max(0, x - hw):x + hw + 1]
    widest = 0
    for row in band.astype(np.int8):
        z = np.concatenate(([0], row, [0]))
        idx = np.flatnonzero(np.diff(z))
        if idx.size:
            widest = max(widest, int((idx[1::2] - idx[0::2]).max()))
    # 整小节休止符 = 挂在谱线下的一块「等宽矩形」；符头是椭圆（首尾行明显更窄）。
    # 低清页上符头和休止符的竖向尺寸几乎一样，只能靠这个形状差别分。
    rw2 = max(1, int(round(0.55 * sp)))
    hw2 = max(3, int(round(0.85 * sp)))
    y_a, y_b = max(0, y - rw2), min(h, y + rw2 + 1)
    widths = []
    for yy in range(y_a, y_b):
        row = ink[yy, max(0, x - hw2):x + hw2 + 1]
        z = np.concatenate(([0], row.astype(np.int8), [0]))
        idx = np.flatnonzero(np.diff(z))
        wid = int((idx[1::2] - idx[0::2]).max()) if idx.size else 0
        widths.append(wid if 0 < wid <= 1.6 * sp else 0)
    # 「平顶」判据：从中心行往上下取连续有墨的一块，看首行宽度占最大宽度的比例。
    # 符头是椭圆（首行只有最大宽度的 ~0.7），整小节休止是矩形（≈1.0）。
    # 用「首行/最大」而不是「最小/最大」：休止符底部有轻微收边，最小/最大只有 0.76，
    # 会和真符头混在一起（实测就是这么漏掉三个休止符的）。
    flat_rows = 0.0
    if widths:
        c0 = min(max(0, y - y_a), len(widths) - 1)
        i0 = c0
        while i0 - 1 >= 0 and widths[i0 - 1] > 0:
            i0 -= 1
        i1 = c0
        while i1 + 1 < len(widths) and widths[i1 + 1] > 0:
            i1 += 1
        block = widths[i0:i1 + 1]
        m = max(block) if block else 0
        if m > 0:
            flat_rows = block[0] / float(m)
    near_bar = False
    if barlines:
        near_bar = any(abs(x - b) <= max(2.0, 0.45 * sp) for b in barlines)
    return {"vr": run(0) / sp, "hr": widest / sp, "core": core_fill,
            "outer": outer_fill, "center": center, "near_bar": near_bar,
            "flat_rows": flat_rows, "n_widths": len(widths)}


def accept_local(feat, step_res):
    """接受判据（全部以 spacing 为单位）。"""
    if abs(step_res) > 0.34:
        return False, "off-lattice"      # 不在谱线/间的格点上 -> 多半是文字或力度记号
    vr, hr, core = feat["vr"], feat["hr"], feat["core"]
    if hr > 2.15 or hr < 0.42:
        return False, "hrun"
    near_bar = feat.get("near_bar", False)
    # 空心符头（二分 / 全音符）：中心是白的，竖游程在「洞」处断开，所以 vr 很小。
    # 这类音必须走单独的通路，否则会被 vr 下限挡掉（实测整条低音二分音符全丢）。
    # 空心符头的竖游程在「洞」处断成 0~1 个像素，所以这里**不能**要求 vr 下限；
    # 谱线/符杠靠在 outer（外环窗口）上排除：它们中心有墨但外环很空。
    open_pat = feat["center"] <= 0.78 and feat["outer"] >= 0.28
    if not (near_bar or 0.42 <= vr <= 1.95 or open_pat):
        return False, "vrun"             # 谱线(0.1) / 符干(2.5+) 都不在这个区间
    if core >= 0.60:
        if feat.get("flat_rows", 0.0) >= 0.85 and feat.get("n_widths", 0) >= 2 and vr <= 1.05:
            return False, "rest-like"    # 整小节休止：实心 + 等宽矩形
        return True, "filled"
    if open_pat:
        return True, "open"
    return False, "no-core"


def notehead_kind(ink, y, x, sp):
    """实心 / 空心：看中心一小块是否整块有墨；顺带量符头宽度。"""
    r = max(1, int(round(0.30 * sp)))
    patch = ink[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1]
    fill = float(patch.mean()) if patch.size else 0.0
    return ("filled" if fill > 0.62 else "open"), fill


def stem_length(ink, y, x, sp, up=True):
    """"从符头边缘往外数连续墨迹（允许 1px 断裂）。"""
    h, _ = ink.shape
    edge = y - max(1, int(round(0.45 * sp))) if up else y + max(1, int(round(0.45 * sp)))
    col = x
    run = 0
    gap = 0
    step = -1 if up else 1
    yy = edge
    best = 0
    while 0 <= yy < h:
        seg = ink[yy, max(0, col - 1):col + 2].any()
        if seg:
            run += 1
            gap = 0
        else:
            gap += 1
            if gap > 1:
                break
        best = max(best, run)
        yy += step
    return best


# ----------------------------------------------------------------------------
# 4. 变化音记号
# ----------------------------------------------------------------------------

def detect_accidental_glyphs(ink, staff, noteheads, ink_nolines=None):
    """在符头左侧找小块记号；staff 区域内的连通域只保留「孤立、够高、够窄」的。
    ★ 一定要在「去过谱线」的图上做连通域 —— 否则记号会和谱线粘成一整块。"""
    sp = staff["spacing"]
    top, bottom = staff["top"], staff["bottom"]
    y0 = max(0, int(math.floor(top - 1.8 * sp)))
    y1 = min(ink.shape[0], int(math.ceil(bottom + 1.8 * sp)))
    band = np.zeros_like(ink)
    band[y0:y1, :] = True
    work = (ink_nolines if ink_nolines is not None else ink) & band
    lab, n = ndi.label(work)
    if n == 0:
        return []
    objs = ndi.find_objects(lab)
    glyphs = []
    for i, sl in enumerate(objs, start=1):
        if sl is None:
            continue
        ys, xs = sl
        hh = ys.stop - ys.start
        ww = xs.stop - xs.start
        if not (1.15 * sp <= hh <= 2.9 * sp and 0.35 * sp <= ww <= 1.9 * sp):
            continue
        area = int((lab[sl] == i).sum())
        if area < 0.28 * hh * ww:
            continue
        cx, cy = (xs.start + xs.stop) / 2.0, (ys.start + ys.stop) / 2.0
        # 必须紧贴某个符头左侧
        near = None
        for (ny, nx, nv) in noteheads:
            dx = nx - cx
            if 0.35 * sp <= dx <= 3.4 * sp and abs(ny - cy) <= 1.35 * sp:
                if near is None or dx < near:
                    near = dx
        if near is None:
            continue
        m = (lab[sl] == i)
        # 纵向笔画数：列方向连续墨迹 >= 0.55 高度的列有几段
        col_runs = []
        for c in range(m.shape[1]):
            colm = m[:, c]
            if colm.sum() >= 0.55 * hh:
                col_runs.append(c)
        vstrokes = 0
        for c in col_runs:
            if c - 1 not in col_runs:
                vstrokes += 1
        # 每根竖笔的纵向范围（用来区分 ♯ 与 ♮）
        vspans = []
        cur = []
        for c in col_runs + [None]:
            if c is not None and (not cur or c - cur[-1] == 1):
                cur.append(c)
            else:
                if cur:
                    sub = m[:, cur[0]:cur[-1] + 1].any(axis=1)
                    idxs = np.flatnonzero(sub)
                    vspans.append((float(idxs.min()) / hh, float(idxs.max()) / hh))
                cur = [] if c is None else [c]
        # 洞（空心）数
        inv = ~m
        lab2, n2 = ndi.label(inv)
        border = set(lab2[0, :].tolist()) | set(lab2[-1, :].tolist()) | set(lab2[:, 0].tolist()) | set(lab2[:, -1].tolist())
        holes = len([k for k in range(1, n2 + 1) if k not in border])
        upper = float(m[: hh // 2, :].mean())
        lower = float(m[hh // 2:, :].mean())
        glyphs.append({
            "cx": cx, "cy": cy, "h": hh, "w": ww, "area": area,
            "vstrokes": vstrokes, "holes": holes, "vspans": vspans,
            "upper": upper, "lower": lower,
            "aspect": ww / max(1.0, hh), "fill": area / float(hh * ww),
            "box": (int(xs.start), int(ys.start), int(xs.stop), int(ys.stop)),
        })
    for gi, gl in enumerate(glyphs):
        gl["kind"] = classify_glyph(gl)
    return glyphs


def classify_glyph(gl):
    """♯ / ♭ / ♮ / 𝄪 的判别。低清下笔画会糊在一起，所以用「竖笔画数 + 洞 + 上下墨量」组合。
    ♯ 与 ♮ 的差别在**两根竖笔的纵向范围**：♯ 两根都贯穿全高，
    ♮ 是「左竖在下、右竖在上」错开的 —— 只看竖笔数量是分不开的（实测会把还原号判成升号）。"""
    v, holes = gl["vstrokes"], gl["holes"]
    spans = gl.get("vspans") or []
    if v >= 2 and len(spans) >= 2:
        tops = [s[0] for s in spans]
        bots = [s[1] for s in spans]
        offset = max(abs(tops[0] - tops[1]), abs(bots[0] - bots[1]))   # vspans 是 0..1 的比例
        if offset >= 0.30:
            return "natural"
        return "sharp"
    if v == 1 and holes >= 1:
        return "flat"
    if v == 1:
        return "flat" if gl["lower"] > gl["upper"] * 1.25 else "sharp"
    if holes == 0 and gl["aspect"] > 0.62 and gl["fill"] > 0.42:
        return "double"
    return "sharp"


ACC_OFFSET = {"sharp": 1, "flat": -1, "natural": 0, "double": 2}


# ----------------------------------------------------------------------------
# 5. 音高
# ----------------------------------------------------------------------------

def step_of(y, staff, clef):
    sp = staff["spacing"]
    steps = (staff["bottom"] - y) / (sp / 2.0)
    return int(round(steps))


def step_to_midi(step, acc, key_sig):
    d = step  # 相对下线（treble: E4）的自然音级
    letter = LETTERS[d % 7]
    octave = d // 7
    midi = 12 * (octave + 1) + LETTER_SEMI[letter]
    midi += key_sig.get(letter, 0)
    midi += acc
    return midi, letter


# ----------------------------------------------------------------------------
# 6. 主流程
# ----------------------------------------------------------------------------

def analyze_page(gray, opts, page_index):
    ink, thr, frac = binarize(gray)
    h, w = ink.shape
    staves = detect_staves(ink)
    sp_page = float(np.median([s["spacing"] for s in staves])) if staves else 10.0
    ink_det = ink & ~horizontal_structures(ink, sp_page)
    for st in staves:
        st["ink_nolines"] = remove_staff_lines(ink, st)
        st["ink_clean"] = repair_vertical(st["ink_nolines"], max(1, int(round(st["spacing"] * 0.30))))
        st["barlines"] = detect_barlines(ink, st)
    # ★ 先认谱号再分组：分系统靠的就是「高音谱表下跟低音谱表」这条规则，
    #   顺序反了（先分组后认谱号）每组都会退化成单行谱表 —— 实测小节线因此全丢。
    for st in staves:
        st["clef"], st["clef_box"] = guess_clef_box(ink, st, st["ink_clean"])
    systems = group_systems(staves)
    # 系统级小节线（钢琴谱上下两行共用一条竖线）；找不到就保留单行结果
    for sys_ in systems:
        sb = detect_system_barlines(ink, sys_)
        if len(sb) >= 2:
            for st in sys_:
                st["barlines"] = sb
    notes = []
    glyphs = []
    for si, st in enumerate(staves):
        st["_notes"] = []
        sp_ = st["spacing"]
        y_lo = st["top"] - 3.4 * sp_
        y_hi = st["bottom"] + 3.4 * sp_
        if si > 0:                       # 别越到上一行谱表去（实测低音谱表会认到高音谱表的符头）
            y_lo = max(y_lo, (staves[si - 1]["bottom"] + st["top"]) / 2.0)
        if si + 1 < len(staves):
            y_hi = min(y_hi, (st["bottom"] + staves[si + 1]["top"]) / 2.0)
        st["y_lo"], st["y_hi"] = y_lo, y_hi
        nh, score = detect_noteheads(ink, st, ink_det=ink_det)
        kept = []
        rejected = []
        for (y, x, v) in nh:
            feat = local_features(ink, y, x, st["spacing"], st.get("barlines"))
            step = (st["bottom"] - y) / (st["spacing"] / 2.0)
            ok, why = accept_local(feat, step - round(step))
            if ok:
                kept.append((y, x, v, feat))
            else:
                rejected.append((y, x, why))
        st["rejected"] = rejected
        nh = kept
        gl = detect_accidental_glyphs(ink, st, [(a, b, c) for (a, b, c, _) in nh], st["ink_clean"])
        # 变化音记号本身（♯/♭/♮）也会被匹配滤波看成一个「实心块」，
        # 于是同一个位置既有一个记号又有一个假符头 —— 把这类符头去掉。
        if gl:
            kept2 = []
            for (y, x, v, feat) in nh:
                on_glyph = any(abs(x - g["cx"]) <= 0.8 * st["spacing"] and abs(y - g["cy"]) <= 0.55 * st["spacing"]
                               for g in gl)
                if not on_glyph:
                    kept2.append((y, x, v, feat))
            nh = kept2
        st["noteheads"] = nh
        st["glyphs"] = gl
        glyphs.extend(gl)
        for (y, x, v, feat) in nh:
            kind, fill = notehead_kind(ink, y, x, st["spacing"])
            up = stem_length(ink, y, x, st["spacing"], True)
            dn = stem_length(ink, y, x, st["spacing"], False)
            stem = max(up, dn)
            st.setdefault("_notes", []).append({
                "y": y, "x": x, "score": v, "kind": kind, "fill": fill,
                "stem": stem, "stem_up": up >= dn, "feat": feat,
                "staff": st,
            })
        notes.extend(st["_notes"])
    return {"ink": ink, "thr": thr, "ink_frac": frac, "staves": staves,
            "systems": systems, "notes": notes, "glyphs": glyphs,
            "size": (w, h), "page": page_index}


def guess_clef_box(ink, staff, ink_nl=None):
    """返回 (谱号, 谱号+拍号所占的横向区间)。拍号区不参与符头检测 ——
    实测拍号数字和谱号尾巴都会被匹配滤波当成符头。"""
    """谱号：取谱表最左端最高的连通域，比谱表高得多的是高音谱号。
    ★ 必须在「去过谱线」的图上做 —— 否则谱号会和整条谱线连成一块（宽度超限被跳过，
      于是所有谱表都被判成默认的高音谱号）。"""
    sp = staff["spacing"]
    x0 = int(max(0, staff.get("x0", 0)))
    # 跳过左端的大括号 / 括线区，再看后面 6 个间距
    xs_ = int(x0 + 1.6 * sp)
    xe = int(min(ink.shape[1], x0 + 5.0 * sp))   # 再往右就是拍号，会把拍号当谱号
    y0 = int(max(0, staff["top"] - 3.2 * sp))
    y1 = int(min(ink.shape[0], staff["bottom"] + 3.2 * sp))
    src = ink_nl if ink_nl is not None else ink
    win = np.zeros_like(src)
    win[y0:y1, xs_:xe] = True
    lab, n = ndi.label(src & win)
    best = None
    for i, sl in enumerate(ndi.find_objects(lab), start=1):
        if sl is None:
            continue
        ys, xs = sl
        hh = (ys.stop - ys.start) / sp
        ww = (xs.stop - xs.start) / sp
        if ww > 3.4:          # 连到音符上的大块，不是谱号
            continue
        if ww < 0.5:          # 细长条是小节线 / 括线，不是谱号（实测低音谱号全被判成高音就是栽在这）
            continue
        if best is None or hh > best[0]:
            best = (hh, xs.start, xs.stop)
    if best is None:
        return "treble", (xs_, min(xe, xs_ + int(1.0 * sp)))
    hh, gx0, gx1 = best
    # 高音谱号在真实排版里连头带尾能到 5~7 个间距高；低音谱号只有 2~3 个
    clef = "bass" if hh <= 3.6 else "treble"
    return clef, (int(gx0) - int(0.4 * sp), int(gx1) + int(3.4 * sp))


def guess_clef(ink, staff, ink_nl=None):
    return guess_clef_box(ink, staff, ink_nl)[0]



# ----------------------------------------------------------------------------
# 7. 音高 / 时值 / 小节网格
# ----------------------------------------------------------------------------

def staff_measures(ink, staff, min_width_sp=4.0):
    """按小节线把谱表切成若干小节（返回 [(x_left, x_right), ...]）。"""
    sp = staff["spacing"]
    xs = sorted(x for x in staff["barlines"] if staff.get("x0", 0) - 2 <= x <= staff.get("x1", ink.shape[1]) + 2)
    if len(xs) < 2:
        return [(staff.get("x0", 0.0), staff.get("x1", float(ink.shape[1] - 1)))]
    out = []
    for a, b in zip(xs, xs[1:]):
        if (b - a) >= min_width_sp * sp:
            out.append((float(a), float(b)))
    return out or [(float(xs[0]), float(xs[-1]))]


def beam_count(ink, y, x, sp, up, max_beams=4):
    """数符尾/符杠：从符干末端往外找「横向长条」的层数。
    一层 = 八分音符，两层 = 十六分，三层 = 三十二分。"""
    h, w = ink.shape
    r = max(1, int(round(0.5 * sp)))
    tip = y - int(round(3.4 * sp)) if up else y + int(round(3.4 * sp))
    y0 = max(0, tip - (1 if up else 0))
    y1 = min(h, tip + (int(round(1.4 * sp)) if up else 0) + 1)
    if up:
        y0 = max(0, tip - int(round(0.5 * sp)))
        y1 = min(h, tip + int(round(1.8 * sp)))
    else:
        y0 = max(0, tip - int(round(1.8 * sp)))
        y1 = min(h, tip + int(round(0.5 * sp)))
    bands = []
    for yy in range(y0, y1):
        row = ink[yy, max(0, x - r):min(w, x + r + 1)]
        z = np.concatenate(([0], row.astype(np.int8), [0]))
        idx = np.flatnonzero(np.diff(z))
        longest = int((idx[1::2] - idx[0::2]).max()) if idx.size else 0
        if longest >= max(3, int(round(0.55 * sp))):
            bands.append(yy)
    # 相邻行并成一层
    layers = 0
    prev = None
    for yy in bands:
        if prev is None or yy - prev > 1:
            layers += 1
        prev = yy
    return min(layers, max_beams)


def assign_pitch_time(page, opts):
    """把版面几何变成音符事件：音高（含变化音）+ 起始拍 + 时值。"""
    ink = page["ink"]
    notes = []
    warnings = []
    for st in page["staves"]:
        sp = st["spacing"]
        clef = st["clef"]
        base = CLEF_BASE_STEP[clef]
        measures = staff_measures(ink, st)
        st["measures"] = measures
        glyphs = sorted(st.get("glyphs", []), key=lambda g: g["cx"])
        heads = list(st["noteheads"])
        # 变化音归属：每个记号归给**它右边最近**的符头。
        # ★ 不能按符头顺序「先到先得」：万一有个假符头正好落在记号上，
        #   它会把记号抢走，真正的音反而丢了变化音（实测还原号就是这么丢的）。
        acc_of = {}
        for g in glyphs:
            best = None
            for hi, (hy, hx, _hv, _hf) in enumerate(heads):
                dx = hx - g["cx"]
                if 0.3 * sp <= dx <= 3.6 * sp and abs(g["cy"] - hy) <= 1.5 * sp:
                    if best is None or dx < best[0]:
                        best = (dx, hi)
            if best is not None:
                acc_of[best[1]] = g["kind"]
        raw = []
        for hi, (y, x, v, feat) in enumerate(heads):
            step = step_of(y, st, clef)
            acc_kind = acc_of.get(hi)
            acc = ACC_OFFSET.get(acc_kind, 0)
            midi, letter = step_to_midi(base + step, acc, KEY_SIGS.get(0, {}))
            # 时值：空心 + 有符干 = 二分，空心无符干 = 全音符
            kind, _fill = notehead_kind(ink, y, x, sp)
            stem = feat.get("stem")
            if stem is None:
                up = stem_length(ink, y, x, sp, True)
                dn = stem_length(ink, y, x, sp, False)
                stem, up_first = max(up, dn), up >= dn
            else:
                up_first = True
            if kind == "open":
                dur = 2.0 if stem >= 1.6 * sp else 4.0
                beams = 0
            else:
                beams = beam_count(ink, y, x, sp, up_first) if stem >= 1.6 * sp else 0
                dur = 1.0 / (2 ** beams) if beams > 0 else 1.0
            raw.append({"x": x, "y": y, "step": step, "midi": midi, "acc": acc_kind,
                        "dur": dur, "beams": beams, "kind": kind, "staff": st})
        raw.sort(key=lambda n: (n["x"], -n["y"]))
        beats = float(opts.beats) * 4.0 / float(opts.beat_type)
        for n in raw:
            n["measure"] = None
            for i, (a, b) in enumerate(measures):
                if a - 0.5 * sp <= n["x"] <= b + 0.5 * sp:
                    n["measure"] = i
                    break
            if n["measure"] is None:
                n["measure"] = 0 if n["x"] < measures[0][0] else len(measures) - 1
        # 起始拍：先按「小节线 -> 拍」线性映射，再迭代拟合。
        # ★ 刻版会在小节两端留白，直接线性映射会让越靠后的音偏得越多
        #   （实测最后一拍会落到 3.33 拍上，量化后全错位），所以要估出每小节的
        #   「内容原点」A_m 和全谱表统一的「每拍像素数」s，两者交替最小二乘。
        widths = [max(1.0, b - a) for (a, b) in measures]
        base_s = float(np.median(widths)) / max(0.25, beats)
        # ★ 小节线到小节线包含了刻版留白，直接当「每拍像素数」会偏大，
        #   量化会锁死在一个错的不动点上（实测整小节后移半拍）。
        #   所以多起点求解，用「像素残差」挑最自洽的那个解。
        best = None
        for factor in (1.0, 0.92, 0.84, 0.76, 0.68, 0.60):
            s = base_s * factor
            first_x = []
            for i in range(len(measures)):
                xs = [n["x"] for n in raw if n["measure"] == i]
                first_x.append(float(min(xs)) if xs else measures[i][0])
            offs = list(first_x)
            q = [0.0] * len(raw)
            for _ in range(6):
                for k, n in enumerate(raw):
                    b = (n["x"] - offs[n["measure"]]) / s
                    q[k] = max(0.0, min(beats - 0.25, round(b * 4.0) / 4.0))
                num = den = 0.0
                for n, qq in zip(raw, q):
                    if qq > 0:
                        num += (n["x"] - offs[n["measure"]]) * qq
                        den += qq * qq
                if den > 0:
                    s = max(0.25, num / den)
                for i in range(len(measures)):
                    idx = [k for k, n in enumerate(raw) if n["measure"] == i]
                    if not idx:
                        continue
                    k0 = min(idx, key=lambda k: raw[k]["x"])
                    if q[k0] <= 0.35:
                        offs[i] = raw[k0]["x"] - q[k0] * s
            err = 0.0
            for k, n in enumerate(raw):
                err += abs((n["x"] - offs[n["measure"]]) - q[k] * s)
            norm = err / max(1, len(raw))
            # 每拍像素数不能比「小节宽/拍数」还大太多（那就是把留白也算进拍了）
            if s > base_s * 1.02:
                norm += 50.0
            if best is None or norm < best[0]:
                best = (norm, list(q))
        q = best[1]
        for n, qq in zip(raw, q):
            n["q"] = qq
            if n["q"] >= beats:
                n["q"] = beats - 0.25
        # 和弦：同一小节同一格点 -> 同一时刻
        groups = {}
        for n in raw:
            groups.setdefault((n["measure"], round(n["q"], 3)), []).append(n)
        ordered = sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1]))
        prev_key = None
        for (mi, q), members in ordered:
            onset = mi * beats + q
            members.sort(key=lambda n: -n["midi"])
            for n in members:
                n["onset"] = onset
            if prev_key is not None:
                gap = onset - prev_key[1]
                for n in prev_key[2]:
                    n["dur"] = min(n["dur"], max(0.25, gap))
            prev_key = (mi, q, members)
        if prev_key is not None:
            for n in prev_key[2]:
                n["dur"] = min(n["dur"], beats * 0.5 if n["dur"] > beats else n["dur"])
        for n in raw:
            n["dur"] = max(0.125, min(n["dur"], 8.0))
            notes.append(n)
    return notes, warnings


def write_midi(notes, out_path, opts):
    """写类型 1 MIDI：0 号轨速度，之后按谱表（高音/低音）分轨。"""
    import mido
    tpb = 480
    mid = mido.MidiFile(type=1, ticks_per_beat=tpb)
    meta = mido.MidiTrack()
    mid.tracks.append(meta)
    meta.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(opts.tempo), time=0))
    meta.append(mido.MetaMessage("time_signature", numerator=opts.beats,
                                 denominator=opts.beat_type, time=0))
    per_track = {}
    for n in notes:
        clef = n["staff"]["clef"]
        key = "Right Hand" if clef == "treble" else "Left Hand"   # MIDI meta 文本是 latin-1
        per_track.setdefault(key, []).append(n)
    for key in sorted(per_track):
        tr = mido.MidiTrack()
        mid.tracks.append(tr)
        tr.append(mido.MetaMessage("track_name", name=key, time=0))
        events = []
        for n in per_track[key]:
            on = int(round(n["onset"] * tpb))
            off = int(round((n["onset"] + n["dur"]) * tpb))
            events.append((on, 1, n["midi"]))
            events.append((max(on + 1, off), 0, n["midi"]))
        events.sort(key=lambda e: (e[0], e[1]))
        last = 0
        for tick, kind, pitch in events:
            tr.append(mido.Message("note_on" if kind else "note_off", note=int(pitch),
                                   velocity=96 if kind else 0, time=tick - last))
            last = tick
    mid.save(out_path)
    return out_path


def render_overlay(page, path):
    w, h = page["size"]
    base = np.zeros((h, w, 3), dtype=np.uint8)
    base[..., :] = 255
    base[page["ink"]] = (200, 200, 200)
    img = Image.fromarray(base).resize((w * 2, h * 2), Image.NEAREST)
    dr = ImageDraw.Draw(img)

    def S(v):
        return v * 2

    for st in page["staves"]:
        for y in st["lines"]:
            dr.line([(S(st["x0"]), S(y)), (S(st["x1"]), S(y))], fill=(120, 190, 255), width=1)
        for x in st["barlines"]:
            dr.line([(S(x), S(st["top"] - 2)), (S(x), S(st["bottom"] + 2))], fill=(255, 0, 255), width=2)
        for (y, x, v, feat) in st["noteheads"]:
            sp = st["spacing"]
            dr.ellipse([S(x - 0.62 * sp), S(y - 0.5 * sp), S(x + 0.62 * sp), S(y + 0.5 * sp)], outline=(230, 40, 40), width=2)
        for gl in st["glyphs"]:
            x0, y0, x1, y1 = gl["box"]
            col = {"sharp": (0, 150, 0), "flat": (0, 110, 220), "natural": (200, 120, 0), "double": (160, 0, 160)}[gl["kind"]]
            dr.rectangle([S(x0) - 1, S(y0) - 1, S(x1) + 1, S(y1) + 1], outline=col, width=2)
            dr.text((S(x0), S(y1) + 2), gl["kind"][0], fill=col)
    img.save(path)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default="to-midi")
    ap.add_argument("--in", dest="inputs", action="append", default=[])
    ap.add_argument("--out", default="")
    ap.add_argument("--overlay", default="")
    ap.add_argument("--report", default="")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--beats", type=int, default=4)
    ap.add_argument("--beat-type", type=int, default=4)
    ap.add_argument("--tempo", type=float, default=120.0)
    args = ap.parse_args(argv)

    if not args.inputs:
        emit("RESULT", {"ok": False, "error": "没有输入文件"})
        return 2
    pages = []
    total = len(args.inputs)
    for k, p in enumerate(args.inputs):
        if not os.path.exists(p):
            emit("RESULT", {"ok": False, "error": "找不到文件：" + p})
            return 2
        for name, gray in load_frames(p):
            pages.append((name, gray))
        prog(10 + 40 * (k + 1) / total, "读取 %s" % os.path.basename(p))

    results = []
    warnings = []
    for i, (name, gray) in enumerate(pages):
        prog(35 + 40 * (i + 1) / len(pages), "识别第 %d/%d 页" % (i + 1, len(pages)))
        results.append(analyze_page(gray, args, i))

    # 跨页接小节号：每页的音符整体后移「前面各页该谱号累计的小节数」
    beats = float(args.beats) * 4.0 / float(args.beat_type)
    offsets = {"treble": 0.0, "bass": 0.0}
    all_notes = []
    per_page = []
    for pg in results:
        notes, warn = assign_pitch_time(pg, args)
        warnings.extend(warn)
        # 每页要往后挪的是「本页该谱号所有系统的小节数之和」（不是最大值）——
        # 写成 max 会让整页只前进一个小节，六页挤在 18 秒里。
        span = {"treble": 0.0, "bass": 0.0}
        for st in pg["staves"]:
            span[st["clef"]] = span.get(st["clef"], 0.0) + float(len(st.get("measures") or []))
        for n in notes:
            clef = n["staff"]["clef"]
            n["onset"] += offsets.get(clef, 0.0) * beats
            for k in ("measure",):
                pass
        all_notes.extend(notes)
        per_page.append(len(notes))
        for k in span:
            offsets[k] = offsets.get(k, 0.0) + span[k]
    prog(80, "写入 MIDI")
    if not all_notes:
        emit("RESULT", {"ok": False, "error": "没有识别到音符。可能是扫描质量过低，或页面里没有五线谱。"})
        return 1
    if args.out:
        write_midi(all_notes, args.out, args)

    overlays = []
    if args.overlay:
        if args.overlay.lower().endswith(".png") and len(results) == 1:
            render_overlay(results[0], args.overlay)
            overlays.append(args.overlay)
        else:
            os.makedirs(args.overlay, exist_ok=True)
            for i, pg in enumerate(results):
                p = os.path.join(args.overlay, "overlay-%02d.png" % (i + 1))
                render_overlay(pg, p)
                overlays.append(p)

    sp_list = [st["spacing"] for pg in results for st in pg["staves"]]
    sp = float(np.median(sp_list)) if sp_list else 0.0
    # 警告用「代码」而不是中文句子：渲染层按语言翻译（全语言适配）。
    if sp and sp < 9.0:
        warnings.append({"code": "lowres", "spacing": round(sp, 2)})
    if not any(st.get("barlines") for pg in results for st in pg["staves"]):
        warnings.append({"code": "no-barlines"})
    if 0 < len(all_notes) and not any(n["acc"] for n in all_notes):
        warnings.append({"code": "no-accidentals"})
    dur_ms = 0
    if all_notes:
        dur_ms = int(round(max(n["onset"] + n["dur"] for n in all_notes) * 60000.0 / args.tempo))
    stats = {
        "ok": True,
        "pages": len(results),
        "staves": sum(len(p["staves"]) for p in results),
        "systems": sum(len(p["systems"]) for p in results),
        "clefs": [st["clef"] for pg in results for st in pg["staves"]],
        "notes": len(all_notes),
        "notesPerPage": per_page,
        "accidentals": sum(1 for n in all_notes if n["acc"]),
        "spacing": round(sp, 2),
        "beats": args.beats,
        "beatType": args.beat_type,
        "tempo": args.tempo,
        "measures": sum(len(st.get("measures") or []) for pg in results for st in pg["staves"][::2]),
        "durationMs": dur_ms,
        "tracks": sorted(set(("Right Hand" if n["staff"]["clef"] == "treble" else "Left Hand") for n in all_notes)),
        "pitchRange": [int(min(n["midi"] for n in all_notes)), int(max(n["midi"] for n in all_notes))],
        "overlays": overlays,
        "warnings": warnings,
        "engine": "omr-classic",
    }
    emit("RESULT", stats)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(stats, fh, ensure_ascii=False, indent=1)
    if args.debug:
        for i, pg in enumerate(results):
            print("page", i, "size", pg["size"], "ink", round(pg["ink_frac"], 3), "thr", round(pg["thr"], 1))
            for st in pg["staves"]:
                print("  staff top=%.1f bottom=%.1f sp=%.2f clef=%s barlines=%d notes=%d glyphs=%d" % (
                    st["top"], st["bottom"], st["spacing"], st["clef"], len(st["barlines"]),
                    len(st["noteheads"]), len(st["glyphs"])))
        for n in all_notes[:24]:
            print("   midi=%3d onset=%.2f dur=%.2f %s acc=%s" % (n["midi"], n["onset"], n["dur"],
                                                                 n["staff"]["clef"], n["acc"]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        emit("RESULT", {"ok": False, "error": traceback.format_exc()[-800:]})
        sys.exit(1)

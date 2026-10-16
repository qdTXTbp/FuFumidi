#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从品牌母图生成整套 logo 资产（Windows 图标 / 应用内 logo / 文档配图）。

为什么要这个脚本：logo 有 5 个消费点（exe+安装器图标、托盘/窗口图标、侧边栏、
docs 页面，以及由 scripts/gen-installer-art.py 再派生的安装器/更新器图），
手改必然漂移。**母图只此一份**：docs/assets/logo-master.png。

    python scripts/gen-logo.py

产出：
    build/icon.png                     512x512 透明（托盘 / 窗口 / electron-builder 图标源）
    build/icon.ico                     16/32/48/64/128/256 多尺寸
    frontend/src/assets/logo.png       460x460 透明（侧边栏）
    docs/assets/logo.png               460x460 透明（文档页）
    dist/logo-full-preview.png         全身方图（备选方案，仅本地看）
    dist/logo-preview.png              深底/浅底/实尺小图接触印相（仅本地看）

★ 预览图写进 dist/ 而不是 build/：build/ 会被打进安装版 asar（实测过），预览图没必要随包分发。

设计约定（沿用改版前的语言，别自创）：
    · 图标是**头部特写**而不是全身 —— 全身缩到 16px 只剩一根牙签，任务栏上认不出来。
    · 背景一律**透明**：白底图标在深色任务栏上是一块白板。

★ 两个踩过的坑（2026-10-16 实测，都真实发生过）：
    1. **母图本身可能已经是透明背景**（发过来的图看着是白底，其实是查看器把透明合成到白上）。
       这时候再去"去白底"会把 alpha 覆盖成 255，图标变成**黑底不透明** —— 第一版就是这么错的。
       所以：**先用母图自己的 alpha；只有它确实不透明（透明像素 < 5%）时才走泛洪去背**。
    2. 泛洪必须**从画框四边**做起，不能"白变透明"：后者会把角色的白头发、白短裤一起打洞。
       而且这张图里有伸出去的魔杖，直接拿 alpha 边界框取景会把构图带偏 —— 头部中心要用
       **行带内 x 的中位数**（中位数对细杆稳健）而不是边界框中心。
"""
import os
import sys

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, 'docs', 'assets', 'logo-master.png')
BUILD = os.path.join(ROOT, 'build')
LOGO_FE = os.path.join(ROOT, 'frontend', 'src', 'assets', 'logo.png')
LOGO_DOCS = os.path.join(ROOT, 'docs', 'assets', 'logo.png')

# 泛洪判定"背景色"的门限：够亮 + 几乎无彩度（白底与浅灰投影都在内）
BG_MIN = 228
BG_SAT = 14
# 头部特写的方框边长 = 全身高度的这个比例
HEAD_SIDE = 0.62


def has_alpha(im, min_transparent=0.05):
    """母图是否已经带了有意义的透明背景"""
    if im.mode not in ('RGBA', 'LA'):
        return False
    hist = im.convert('RGBA').getchannel('A').histogram()
    return hist[0] / float(sum(hist)) >= min_transparent


def flood_remove_white(im):
    """从四边泛洪去掉白底（只用于母图确实不透明的情况）。"""
    im = im.convert('RGB')
    w, h = im.size
    px = im.load()
    is_bg = bytearray(w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            r, g, b = px[x, y]
            if min(r, g, b) >= BG_MIN and (max(r, g, b) - min(r, g, b)) <= BG_SAT:
                is_bg[row + x] = 1

    from collections import deque
    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            i = y * w + x
            if is_bg[i] and not seen[i]:
                seen[i] = 1
                q.append(i)
    for y in range(h):
        for x in (0, w - 1):
            i = y * w + x
            if is_bg[i] and not seen[i]:
                seen[i] = 1
                q.append(i)
    while q:
        i = q.popleft()
        x, y = i % w, i // w
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if is_bg[j] and not seen[j]:
                    seen[j] = 1
                    q.append(j)

    alpha = Image.frombytes('L', (w, h), bytes(0 if seen[i] else 255 for i in range(w * h)))
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))
    alpha = alpha.point(lambda v: 0 if v < 24 else (255 if v > 232 else v))
    out = im.convert('RGBA')
    out.putalpha(alpha)
    return out


def prepare(im):
    if has_alpha(im):
        print('母图自带透明背景，原样使用 alpha')
        return im.convert('RGBA')
    print('母图不透明，按白底泛洪去背')
    return flood_remove_white(im)


def alpha_bbox(im):
    return im.getchannel('A').point(lambda v: 255 if v > 32 else 0).getbbox()


def face_center_x(im, y0, hgt):
    """脸的水平中心。

    ★ 不能用 alpha 边界框的中心：这张图右边有帽子的蕾丝飘带、左边伸出魔杖，
      两者的横向极值差得很远，拿 bbox 中心取景会把脸推偏（第一版就是这么偏的）。
      改用**肤色像素在全身上半段 x 的中位数** —— 中位数对细杆/飘带这种长条形稳健。
      取不到肤色就退回 alpha 行带的中位数。"""
    import numpy as np
    a = np.asarray(im)
    rgb, alpha = a[:, :, :3].astype(int), a[:, :, 3]
    skin = (alpha > 128) & (rgb[:, :, 0] > 205) & (rgb[:, :, 0] - rgb[:, :, 2] > 20) & (rgb[:, :, 1] > 140)
    ys, xs = np.nonzero(skin)
    if xs.size:
        upper = ys <= y0 + hgt * 0.55
        if upper.any():
            return int(np.median(xs[upper]))
        return int(np.median(xs))
    band = (alpha[y0:y0 + int(hgt * 0.55)] > 32).sum(axis=0)
    xs2 = np.repeat(np.arange(a.shape[1]), band)
    return int(np.median(xs2)) if xs2.size else im.size[0] // 2


def head_box(im):
    """头部特写框：边长 0.62×全身高、**从头顶起**，横向以脸为中心。"""
    x0, y0, x1, y1 = alpha_bbox(im)
    hgt = y1 - y0
    side = min(int(hgt * HEAD_SIDE), im.size[0], im.size[1])
    cx = face_center_x(im, y0, hgt)
    top = max(0, min(y0, im.size[1] - side))
    left = max(0, min(cx - side // 2, im.size[0] - side))
    return (left, top, left + side, top + side)


def fit_square(im, box, size, pad_ratio=0.035):
    crop = im.crop(box)
    inner = int(size * (1 - pad_ratio * 2))
    cw, ch = crop.size
    scale = inner / float(max(cw, ch))
    nw, nh = max(1, int(round(cw * scale))), max(1, int(round(ch * scale)))
    crop = crop.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(crop, ((size - nw) // 2, (size - nh) // 2), crop)
    return canvas


def contact_sheet(icon, out_path):
    """深底 / 浅底 200px + 32/24/16 实尺与 2x 放大 —— 只在本地看，不入库。"""
    W, H = 820, 300
    sheet = Image.new('RGB', (W, H), (24, 26, 32))
    for x, bg in ((20, (18, 20, 26)), (280, (244, 246, 250))):
        tile = Image.new('RGB', (240, 240), bg)
        small = icon.resize((200, 200), Image.LANCZOS)
        tile.paste(small, (20, 20), small)
        sheet.paste(tile, (x, 30))
    y = 30
    for s in (32, 24, 16):
        tiny = icon.resize((s, s), Image.LANCZOS)
        sheet.paste(tiny, (560, y), tiny)
        big = tiny.resize((s * 2, s * 2), Image.NEAREST)
        sheet.paste(big, (620, y), big)
        y += s * 2 + 14
    sheet.save(out_path)
    return out_path


def main():
    if not os.path.exists(MASTER):
        print('母图不存在：' + MASTER)
        return 1
    cut = prepare(Image.open(MASTER))
    box = head_box(cut)
    print('alpha 边界框 =', alpha_bbox(cut), ' 头部特写框 =', box)

    icon = fit_square(cut, box, 512)
    icon.save(os.path.join(BUILD, 'icon.png'))
    icon.save(os.path.join(BUILD, 'icon.ico'),
              sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    logo = fit_square(cut, box, 460)
    logo.save(LOGO_FE)
    logo.save(LOGO_DOCS)

    prev = os.path.join(ROOT, 'dist')
    os.makedirs(prev, exist_ok=True)
    fit_square(cut, alpha_bbox(cut), 512, pad_ratio=0.03).save(
        os.path.join(prev, 'logo-full-preview.png'))
    contact_sheet(icon, os.path.join(prev, 'logo-preview.png'))

    for p in (os.path.join(BUILD, 'icon.png'), os.path.join(BUILD, 'icon.ico'), LOGO_FE, LOGO_DOCS):
        print('%-44s %8d B' % (os.path.relpath(p, ROOT), os.path.getsize(p)))
    return 0


if __name__ == '__main__':
    sys.exit(main())

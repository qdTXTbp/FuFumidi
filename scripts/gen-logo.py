#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从品牌母图生成两套东西：**图标 = 头像特写**，**立绘 = 放进工具里**。

    python scripts/gen-logo.py

母图只此一份：docs/assets/brand/立绘-定稿-带描边.png（1092x1550，自带透明底）。
它是用户拍板的那张（带贴纸描边的定稿），上游流水线在
E:\Midi\_attic\styles\（logo3.py 出立绘 → mkicon.py 出全套图标尺寸）。

★ 两条用户明确的要求，别再弄反（2026-08 定）：

1. **图标要抠白底。** 图标（exe / 安装器 / 窗口 / 托盘）用**头像特写 + 透明底**，
   不要做成"白底圆角卡"——白底卡在深色任务栏上是一块白板，也会盖掉任务栏主题。
   母图本身已经是透明底（51% 透明），所以这里不需要"抠"；万一换成白底图，
   flood_remove_white() 会从四边泛洪把白底去掉（**不能**简单"白变透明"，
   角色的白头发、白短裤会被一起打洞）。
2. **立绘放到工具里。** 全身立绘（透明底）进应用内：侧边栏品牌位 + 首页工作区吉祥物
   + 文档页 nav。所以立绘是**竖构图整幅**输出，不裁成方形。

产出：
    build/icon.png                     512x512 头像特写（透明）
    build/icon.ico                     16/32/48/64/128/256
    frontend/src/assets/logo.png       460x460 头像特写（透明，侧边栏徽标）
    frontend/src/assets/mascot.png     高 1000 立绘（透明，首页吉祥物）
    docs/assets/logo.png               460x460 头像特写（透明，文档页 nav）

尺寸分工（别搞反）：**方形小位（38px 侧栏 / 36px 文档 nav）用头像特写**——立绘缩到这个
尺寸只剩一个竖条，认不出人；**首页那种大位才用整幅立绘**。
    dist/logo-preview.png              预览接触印相（仅本地看，不进安装包）

★ 头像取景不能用 alpha 边界框中心：这张图右边有帽子的蕾丝飘带、左边伸出魔杖，
  两者横向极值差得远，拿 bbox 中心取景会把脸推偏。改用**肤色像素在全身上半段 x 的中位数**。
"""
import os
import sys

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.path.join(ROOT, 'docs', 'assets', 'brand')
MASTER = os.path.join(BRAND, '立绘-定稿-带描边.png')
BUILD = os.path.join(ROOT, 'build')
LOGO_FE = os.path.join(ROOT, 'frontend', 'src', 'assets', 'logo.png')
MASCOT_FE = os.path.join(ROOT, 'frontend', 'src', 'assets', 'mascot.png')
LOGO_DOCS = os.path.join(ROOT, 'docs', 'assets', 'logo.png')

BG_MIN = 228          # 泛洪时"够亮"的门限
BG_SAT = 14           # 泛洪时"几乎无彩度"的门限
HEAD_SIDE = 0.62      # 头像方框边长 = 全身高度的比例


def flood_remove_white(im):
    """从四边泛洪去白底（只在母图确实不透明时才会被调用）。"""
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
    hist = im.convert('RGBA').getchannel('A').histogram()
    if hist[0] / float(sum(hist)) >= 0.05:
        print('母图自带透明底（透明像素 %.1f%%），直接用' % (100.0 * hist[0] / sum(hist)))
        return im.convert('RGBA')
    print('母图不透明，按白底泛洪去背')
    return flood_remove_white(im)


def alpha_bbox(im):
    return im.getchannel('A').point(lambda v: 255 if v > 32 else 0).getbbox()


def face_center_x(im, y0, hgt):
    import numpy as np
    a = np.asarray(im)
    rgb, alpha = a[:, :, :3].astype(int), a[:, :, 3]
    skin = (alpha > 128) & (rgb[:, :, 0] > 205) & (rgb[:, :, 0] - rgb[:, :, 2] > 20) & (rgb[:, :, 1] > 140)
    ys, xs = np.nonzero(skin)
    if xs.size:
        upper = ys <= y0 + hgt * 0.55
        return int(np.median(xs[upper])) if upper.any() else int(np.median(xs))
    band = (alpha[y0:y0 + int(hgt * 0.55)] > 32).sum(axis=0)
    xs2 = np.repeat(np.arange(a.shape[1]), band)
    return int(np.median(xs2)) if xs2.size else im.size[0] // 2


def head_box(im):
    """头像特写：边长 0.62×全身高、从头顶起，横向以脸为中心。"""
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


def fit_height(im, box, height, pad_ratio=0.03):
    """竖构图整幅输出：按高度缩放，**不裁成方形**（立绘要放进界面里，方形会把人物切掉）。"""
    crop = im.crop(box)
    inner = int(height * (1 - pad_ratio * 2))
    cw, ch = crop.size
    scale = inner / float(ch)
    nw, nh = max(1, int(round(cw * scale))), max(1, int(round(ch * scale)))
    crop = crop.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGBA', (nw, height), (0, 0, 0, 0))
    canvas.paste(crop, (0, (height - nh) // 2), crop)
    return canvas


def contact_sheet(icon, mascot, out_path):
    from PIL import ImageDraw
    W, H = 860, 420
    sheet = Image.new('RGB', (W, H), (24, 26, 32))
    d = ImageDraw.Draw(sheet)
    d.text((20, 10), '图标（头像特写 · 透明底）', fill=(200, 210, 225))
    x = 20
    for i, bg in enumerate([(18, 20, 26), (244, 246, 250), (222, 228, 236)]):
        tile = Image.new('RGB', (150, 150), bg)
        im = icon.resize((130, 130), Image.LANCZOS)
        tile.paste(im, (10, 10), im)
        sheet.paste(tile, (x, 34))
        x += 160
    y = 200
    d.text((20, y - 18), '实尺小图', fill=(200, 210, 225))
    x = 20
    for s in (48, 32, 16):
        tiny = icon.resize((s, s), Image.LANCZOS)
        sheet.paste(tiny, (x, y), tiny)
        big = tiny.resize((s * 2, s * 2), Image.NEAREST)
        sheet.paste(big, (x + 60, y), big)
        x += s + 120
    d.text((560, 10), '立绘（放进工具里的那张）', fill=(200, 210, 225))
    m = mascot.resize((int(mascot.width * 260.0 / mascot.height), 260), Image.LANCZOS)
    tile2 = Image.new('RGB', (300, 330), (247, 248, 250))
    tile2.paste(m, ((300 - m.width) // 2, 20), m)
    sheet.paste(tile2, (540, 44))
    sheet.save(out_path)
    return out_path


def main():
    if not os.path.exists(MASTER):
        print('母图不存在：' + MASTER)
        return 1
    cut = prepare(Image.open(MASTER))
    hb, fb = head_box(cut), alpha_bbox(cut)
    print('alpha 边界框 = %s  头像框 = %s' % (fb, hb))

    # ---- 图标：头像特写 + 透明底
    icon = fit_square(cut, hb, 512)
    icon.save(os.path.join(BUILD, 'icon.png'))
    icon.save(os.path.join(BUILD, 'icon.ico'),
              sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # ---- 侧栏 / 文档 nav：方形小位，用头像特写（立绘缩到 38px 认不出）
    logo = fit_square(cut, hb, 460)
    logo.save(LOGO_FE)
    logo.save(LOGO_DOCS)

    # ---- 首页吉祥物：整幅立绘（工具里能看清全身）
    mascot = fit_height(cut, fb, 1000)
    mascot.save(MASCOT_FE)

    # ---- 断言
    for p in (os.path.join(BUILD, 'icon.png'), LOGO_FE, MASCOT_FE):
        im = Image.open(p)
        assert im.mode == 'RGBA', p + ' 必须是 RGBA'
        assert im.getchannel('A').getpixel((0, 0)) == 0, p + ' 角落不透明 → 白底没抠掉'
    assert Image.open(os.path.join(BUILD, 'icon.png')).size == (512, 512)
    assert Image.open(MASCOT_FE).height == 1000

    prev = os.path.join(ROOT, 'dist')
    os.makedirs(prev, exist_ok=True)
    contact_sheet(icon, mascot, os.path.join(prev, 'logo-preview.png'))
    for p in (os.path.join(BUILD, 'icon.png'), os.path.join(BUILD, 'icon.ico'), LOGO_FE, MASCOT_FE, LOGO_DOCS):
        print('%-44s %8d B' % (os.path.relpath(p, ROOT), os.path.getsize(p)))
    print('预览：' + os.path.join(prev, 'logo-preview.png'))
    return 0


if __name__ == '__main__':
    sys.exit(main())

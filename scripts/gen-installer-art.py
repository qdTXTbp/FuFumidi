# -*- coding: utf-8 -*-
"""生成 NSIS 安装器的两张位图（MUI2 侧栏 + 页眉）——**代码绘制，不用贴图/截图**。

  build/installerSidebar.bmp   164x314  欢迎页 / 完成页的左侧竖图
  build/installerHeader.bmp    150x57   内页（目录 / 安装中）的右上小图

为什么要自己画：NSIS 默认是一块白板，与软件本身（深色 + 青蓝品牌色）完全不搭；
而 NSIS 只吃 BMP，不能在线下载素材，所以用脚本画、把产物提交进仓库。

重新生成：
  E:\Midi\_attic\_sing_tmp\venv\Scripts\python.exe scripts\gen-installer-art.py
（需要 Pillow；产物已提交，正常构建不需要跑这个脚本。）
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(os.path.dirname(HERE), 'build')

# 品牌色（与 frontend/src/core/theme.js 的深色主题同源）
BG_TOP = (12, 16, 28)
BG_BOT = (24, 34, 58)
ACCENT = (86, 200, 255)
ACCENT_DIM = (44, 116, 168)
INK = (232, 240, 252)
SOFT = (140, 160, 190)


def font(size, bold=False):
    for name in (('msyhbd.ttc', 'msyh.ttc') if bold else ('msyh.ttc', 'msyhbd.ttc')):
        p = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'Fonts', name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def vgrad(w, h, top, bot):
    img = Image.new('RGB', (w, h), top)
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(top, bot, y / max(1, h - 1)))
    return img


def starfield(d, w, h, n=90, seed=7, y0=0, y1=None):
    """极淡的点阵：给暗场纵深（不是装饰，是让纯渐变更贵）"""
    import random
    rnd = random.Random(seed)
    y1 = h if y1 is None else y1
    for _ in range(n):
        x = rnd.randrange(0, w)
        y = rnd.randrange(y0, max(y0 + 1, y1))
        a = rnd.random()
        c = lerp(BG_BOT, ACCENT, 0.20 + 0.55 * a)
        d.point((x, y), fill=c)


def grid(d, x0, y0, x1, y1, step=12, color=(30, 44, 72)):
    for x in range(x0, x1, step):
        d.line([(x, y0), (x, y1)], fill=color)
    for y in range(y0, y1, step):
        d.line([(x0, y), (x1, y)], fill=color)


def sidebar():
    w, h = 164, 314
    img = vgrad(w, h, BG_TOP, BG_BOT)
    d = ImageDraw.Draw(img, 'RGBA')
    grid(d, 0, h - 150, w, h, 14, (26, 38, 64))          # 下半部透视格
    starfield(d, w, h, 130, 11, 0, h - 120)
    # 品牌弧：同心弧 + 扫描线（与软件里的加载动效同语言）
    cx, cy = w // 2, 104
    for i, r in enumerate((46, 34, 22)):
        d.arc([cx - r, cy - r, cx + r, cy + r], start=205, end=335,
              fill=lerp(ACCENT_DIM, ACCENT, 0.35 + 0.3 * i), width=2)
    d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=ACCENT)
    d.line([(cx - 60, cy), (cx + 60, cy)], fill=(ACCENT_DIM[0], ACCENT_DIM[1], ACCENT_DIM[2], 90))
    # 文字
    f1, f2, f3 = font(21, True), font(12), font(10)
    d.text((w // 2, 168), 'FuFumidi', font=f1, fill=INK, anchor='mm')
    d.text((w // 2, 188), '离线 MIDI 工作站', font=f2, fill=SOFT, anchor='mm')
    # 分隔发丝线 + 三行能力（真实功能，不吹）
    d.line([(22, 210), (w - 22, 210)], fill=(48, 66, 98))
    for i, line in enumerate(('播放 · 编辑', '转录 · 乐谱', '歌声合成')):
        d.text((w // 2, 228 + i * 18), line, font=f3, fill=SOFT, anchor='mm')
    d.text((w // 2, h - 16), 'LOCAL · OFFLINE', font=f3, fill=(70, 96, 132), anchor='mm')
    img.save(os.path.join(BUILD, 'installerSidebar.bmp'), 'BMP')
    return w, h


def header():
    w, h = 150, 57
    img = vgrad(w, h, BG_TOP, BG_BOT)
    d = ImageDraw.Draw(img, 'RGBA')
    starfield(d, w, h, 40, 5)
    cx, cy = 30, h // 2
    for r in (15, 10):
        d.arc([cx - r, cy - r, cx + r, cy + r], start=205, end=335, fill=ACCENT_DIM, width=2)
    d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=ACCENT)
    d.text((52, cy - 7), 'FuFumidi', font=font(15, True), fill=INK, anchor='lm')
    d.text((52, cy + 11), '安装 / 更新', font=font(9), fill=SOFT, anchor='lm')
    img.save(os.path.join(BUILD, 'installerHeader.bmp'), 'BMP')
    return w, h


def updater_left():
    """kachina 安装/更新器左侧品牌图（180x400，构建脚本用 -t 传进去）。

    与侧栏同一套语言：暗场 + 同心弧 + 星点 + 中文说明，只是竖长一点、字大一点。
    """
    w, h = 180, 400
    img = vgrad(w, h, BG_TOP, (18, 26, 46))
    d = ImageDraw.Draw(img, 'RGBA')
    starfield(d, w, h, 150, 23, 0, h - 150)
    grid(d, 0, h - 128, w, h, 16, (24, 36, 60))
    cx, cy = w // 2, 118
    for i, r in enumerate((58, 43, 28)):
        d.arc([cx - r, cy - r, cx + r, cy + r], start=205, end=335,
              fill=lerp(ACCENT_DIM, ACCENT, 0.35 + 0.3 * i), width=3)
    d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=ACCENT)
    d.line([(cx - 66, cy), (cx + 66, cy)], fill=(ACCENT_DIM[0], ACCENT_DIM[1], ACCENT_DIM[2], 80))
    d.text((w // 2, 210), 'FuFumidi', font=font(26, True), fill=INK, anchor='mm')
    d.text((w // 2, 236), '离线 MIDI 工作站', font=font(13), fill=SOFT, anchor='mm')
    d.line([(26, 262), (w - 26, 262)], fill=(48, 66, 98))
    for i, line in enumerate(('安装 / 更新 程序', '本地推理 · 无需联网', '数据留在你自己的目录')):
        d.text((w // 2, 282 + i * 20), line, font=font(11), fill=SOFT, anchor='mm')
    d.text((w // 2, h - 18), 'FUFUMIDI UPDATE', font=font(10), fill=(70, 96, 132), anchor='mm')
    img.save(os.path.join(BUILD, 'updater-left.webp'), 'WEBP', quality=92, method=6)
    return w, h


if __name__ == '__main__':
    print('updater', updater_left(), os.path.getsize(os.path.join(BUILD, 'updater-left.webp')), 'B')
    print('sidebar', sidebar(), os.path.getsize(os.path.join(BUILD, 'installerSidebar.bmp')), 'B')
    print('header ', header(), os.path.getsize(os.path.join(BUILD, 'installerHeader.bmp')), 'B')

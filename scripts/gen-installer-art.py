# -*- coding: utf-8 -*-
"""生成 NSIS 安装器的两张位图 + kachina 更新器左图 —— **代码绘制**，logo 用工具自己的图标。

  build/installerSidebar.bmp   164x314  欢迎页 / 完成页左侧竖图
  build/installerHeader.bmp    150x57   内页（目录 / 安装中）右上小图
  build/updater-left.webp      180x400  kachina 更新器左侧品牌图

2026-10-14：原先画的「同心弧 + 圆点」被用户认为像无线网图标，改为**工具自身的 logo**
（build/icon.png）做成圆角方块卡：暗场 + 柔光 + 倒影，不再自己发明图形。

重新生成：
  E:\Midi\_attic\_sing_tmp\venv\Scripts\python.exe scripts\gen-installer-art.py
（产物已提交，正常构建不需要跑这个脚本。）
"""
import os
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, "build")
ICON = os.path.join(BUILD, "icon.png")                       # 白底立绘（小尺寸可读）
EMBLEM = os.path.join(ROOT, "docs", "assets", "brand", "徽记-512.png")   # 完整徽记（大卡片用）

BG_TOP = (12, 16, 28)
BG_BOT = (24, 34, 58)
ACCENT = (86, 200, 255)
ACCENT_DIM = (44, 116, 168)
INK = (232, 240, 252)
SOFT = (140, 160, 190)


def font(size, bold=False):
    for name in (("msyhbd.ttc", "msyh.ttc") if bold else ("msyh.ttc", "msyhbd.ttc")):
        p = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "Fonts", name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def vgrad(w, h, top, bot):
    img = Image.new("RGB", (w, h), top)
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(top, bot, y / max(1, h - 1)))
    return img


def starfield(d, w, h, n=90, seed=7, y0=0, y1=None):
    import random
    rnd = random.Random(seed)
    y1 = h if y1 is None else y1
    for _ in range(n):
        x = rnd.randrange(0, w)
        y = rnd.randrange(y0, max(y0 + 1, y1))
        a = rnd.random()
        d.point((x, y), fill=lerp(BG_BOT, ACCENT, 0.20 + 0.55 * a))


def grid(d, x0, y0, x1, y1, step=12, color=(30, 44, 72)):
    for x in range(x0, x1, step):
        d.line([(x, y0), (x, y1)], fill=color)
    for y in range(y0, y1, step):
        d.line([(x0, y), (x1, y)], fill=color)


def rounded(im, radius):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius, fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask)
    return out


def logo_tile(size, radius_ratio=0.22, ring=True, src_path=None):
    """把品牌图做成圆角方块卡（带细边），返回 RGBA 图。

    ★ 徽记是**整幅不透明**的（自带深靛方底 + 金框），所以对它要 ring=False 且半径极小 ——
      多套一圈圆角会把金框四角切掉，再叠一圈蓝细边就成了「金框外面套蓝框」。
      立绘系列是圆角透明的，才需要这里补圆角。"""
    src = Image.open(src_path or ICON).convert("RGBA").resize((size, size), Image.LANCZOS)
    tile = rounded(src, max(2, int(size * radius_ratio)))
    if ring:
        d = ImageDraw.Draw(tile)
        d.rounded_rectangle([0, 0, size - 1, size - 1], max(2, int(size * radius_ratio)),
                            outline=(120, 170, 220, 200), width=1)
    return tile


def paste_logo(img, cx, cy, size, glow=True, reflect=True, src_path=None,
               radius_ratio=0.22, ring=True):
    """把 logo 卡贴到 (cx, cy)：先柔光、后倒影、再卡片本身。"""
    tile = logo_tile(size, radius_ratio, ring, src_path)
    if glow:
        g = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(g).ellipse([cx - int(size * 0.85), cy - int(size * 0.85),
                                   cx + int(size * 0.85), cy + int(size * 0.85)],
                                  fill=(60, 150, 220, 78))
        img.alpha_composite(g.filter(ImageFilter.GaussianBlur(size // 4)))
    if reflect:
        # 倒影只取底部一小条，再纵向压缩 + 渐隐。
        # 整块镜像会一直铺到文字区，把下面的字"透"出来（实测缺陷）。
        r = tile.transpose(Image.FLIP_TOP_BOTTOM)
        rh = max(8, int(size * 0.20))
        r = r.crop((0, 0, size, rh)).resize((size, max(4, int(rh * 0.60))), Image.LANCZOS)
        a = r.getchannel("A").point(lambda v: int(v * 0.18))
        fade = Image.new("L", r.size, 0)
        fd = ImageDraw.Draw(fade)
        for y in range(r.size[1]):
            fd.line([(0, y), (r.size[0], y)], fill=int(255 * (1.0 - y / max(1, r.size[1] - 1))))
        r.putalpha(ImageChops.multiply(a, fade))
        img.alpha_composite(r, (int(cx - size / 2), int(cy + size / 2 + max(4, size // 12))))
    img.alpha_composite(tile, (int(cx - size / 2), int(cy - size / 2)))


def sidebar():
    w, h = 164, 314
    img = vgrad(w, h, BG_TOP, BG_BOT).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    grid(d, 0, h - 140, w, h, 14, (26, 38, 64))
    starfield(d, w, h, 120, 11, 0, h - 110)
    paste_logo(img, w // 2, 92, 112, src_path=EMBLEM, radius_ratio=0.05, ring=False)
    d = ImageDraw.Draw(img, "RGBA")
    d.text((w // 2, 176), "FuFumidi", font=font(21, True), fill=INK, anchor="mm")
    d.text((w // 2, 196), "离线 MIDI 工作站", font=font(12), fill=SOFT, anchor="mm")
    d.line([(22, 216), (w - 22, 216)], fill=(48, 66, 98))
    for i, line in enumerate(("播放 · 编辑", "转录 · 乐谱", "歌声合成")):
        d.text((w // 2, 234 + i * 18), line, font=font(10), fill=SOFT, anchor="mm")
    d.text((w // 2, h - 16), "LOCAL · OFFLINE", font=font(10), fill=(70, 96, 132), anchor="mm")
    img.convert("RGB").save(os.path.join(BUILD, "installerSidebar.bmp"), "BMP")
    return w, h


def header():
    w, h = 150, 57
    img = vgrad(w, h, BG_TOP, BG_BOT).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    starfield(d, w, h, 36, 5)
    paste_logo(img, 30, h // 2, 38, glow=True, reflect=False)
    d = ImageDraw.Draw(img, "RGBA")
    d.text((54, h // 2 - 7), "FuFumidi", font=font(15, True), fill=INK, anchor="lm")
    d.text((54, h // 2 + 11), "安装 / 更新", font=font(9), fill=SOFT, anchor="lm")
    img.convert("RGB").save(os.path.join(BUILD, "installerHeader.bmp"), "BMP")
    return w, h


def updater_left():
    w, h = 180, 400
    img = vgrad(w, h, BG_TOP, (18, 26, 46)).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    starfield(d, w, h, 150, 23, 0, h - 150)
    grid(d, 0, h - 128, w, h, 16, (24, 36, 60))
    paste_logo(img, w // 2, 104, 124, src_path=EMBLEM, radius_ratio=0.05, ring=False)
    d = ImageDraw.Draw(img, "RGBA")
    d.text((w // 2, 196), "FuFumidi", font=font(26, True), fill=INK, anchor="mm")
    d.text((w // 2, 222), "离线 MIDI 工作站", font=font(13), fill=SOFT, anchor="mm")
    d.line([(26, 248), (w - 26, 248)], fill=(48, 66, 98))
    for i, line in enumerate(("安装 / 更新 程序", "本地推理 · 无需联网", "数据留在你自己的目录")):
        d.text((w // 2, 268 + i * 20), line, font=font(11), fill=SOFT, anchor="mm")
    d.text((w // 2, h - 18), "FUFUMIDI UPDATE", font=font(10), fill=(70, 96, 132), anchor="mm")
    img.convert("RGB").save(os.path.join(BUILD, "updater-left.webp"), "WEBP", quality=92, method=6)
    return w, h


if __name__ == "__main__":
    print("sidebar", sidebar(), os.path.getsize(os.path.join(BUILD, "installerSidebar.bmp")), "B")
    print("header ", header(), os.path.getsize(os.path.join(BUILD, "installerHeader.bmp")), "B")
    print("updater", updater_left(), os.path.getsize(os.path.join(BUILD, "updater-left.webp")), "B")

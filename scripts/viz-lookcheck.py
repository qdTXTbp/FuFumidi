# -*- coding: utf-8 -*-
# 观感量测：把"够不够高级"拆成可测的量。用于 (a) 从参考截图取靶子 (b) 验收新渲染器。
import os, sys, glob
from PIL import Image
import numpy as np

def stats(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32) / 255.0
    lum = 0.2126*a[:,:,0] + 0.7152*a[:,:,1] + 0.0722*a[:,:,2]
    h, w = lum.shape
    top = lum[:int(h*0.30)]                      # 上半区≈舞台背景与音符
    band = lum[int(h*0.30):int(h*0.85)]          # 中间带≈音符下落区
    bot = lum[int(h*0.85):]                      # 底部≈键盘
    mx = a.max(axis=2); mn = a.min(axis=2)
    sat = np.where(mx > 1e-6, (mx-mn)/np.maximum(mx,1e-6), 0)
    fg = (sat > 0.25) & (mx > 0.35)              # "有颜色的亮元素"≈音符/光效
    fgl = float(lum[fg].mean()) if fg.any() else 0.0
    bgl = float(np.median(lum[~fg])) if (~fg).any() else 0.0
    q = (np.asarray(im)//32)
    colors = len(np.unique(q.reshape(-1,3), axis=0))
    return dict(
        name=os.path.basename(path),
        lum=round(float(lum.mean()),3),
        dark=round(float((lum<0.20).mean()),3),
        bright=round(float((lum>0.70).mean()),3),
        top=round(float(top.mean()),3),
        band=round(float(band.mean()),3),
        keys=round(float(bot.mean()),3),
        fg_frac=round(float(fg.mean()),3),
        fg_lum=round(fgl,3),
        bg_lum=round(bgl,3),
        contrast=round(fgl/max(bgl,0.02),2),
        colors=colors,
    )

def table(paths, title):
    print("== " + title)
    print("   %-26s %5s %5s %6s %6s %6s %6s %6s %7s %8s %6s" % ("file","lum","dark","bright","top","band","keys","fg%","fgLum","bgLum/c","colors"))
    for p in paths:
        try: s = stats(p)
        except Exception as e: print("   ERR " + p + " " + str(e)); continue
        print("   %-26s %5.2f %5.2f %6.2f %6.2f %6.2f %6.2f %6.3f %7.2f %5.2f/%-5.2f %5d" % (
            s["name"][:26], s["lum"], s["dark"], s["bright"], s["top"], s["band"], s["keys"],
            s["fg_frac"], s["fg_lum"], s["bg_lum"], s["contrast"], s["colors"]))

REF = r"E:\Midi\_attic\vizref"
OURS = r"E:\Midi\_attic\vizrender"
refs = sorted(glob.glob(os.path.join(REF, "seemusic_*.jpg")))[:2] + sorted(glob.glob(os.path.join(REF, "particles_*.jpg")))[:2] + sorted(glob.glob(os.path.join(REF, "synthesia_*.jpg")))[:1] + sorted(glob.glob(os.path.join(REF, "dorapiano_*.jpg")))[:1]
table(refs, "参考实现（截图，取靶子）")
# 用法：python scripts/viz-lookcheck.py [图片...]  —— 不给参数就看固定对照。
# ★ 这张表是**自查工具**，不是验收门槛：验收由用户肉眼判定。
argv = [a for a in sys.argv[1:] if os.path.exists(a)]
if argv:
    table(argv, "指定图片")
else:
    ours = [os.path.join(OURS, n) for n in ("t-studio.png", "t-neon.png", "t-aurora.png", "t-retro.png", "t-minimal.png", "v2-default.png")]
    table([q for q in ours if os.path.exists(q)], "我们的渲染（v3 新引擎 / 末行是 v2 旧引擎对照）")
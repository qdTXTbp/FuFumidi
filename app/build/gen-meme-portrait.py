# -*- coding: utf-8 -*-
"""
把 3 张 192x192 白底贴纸 meme 合成为 164x314 竖版位图：
  - 画布 164x314，背景 #0c1320（与 MUI_BGCOLOR 一致，融入页面）
  - meme 等比缩放到 160x160 居中（贴纸卡片观感，零变形）
  - 24-bit BMP 输出（NSIS LoadImage 要求无透明通道）
产出 build/uninstall-1.bmp .. uninstall-3.bmp，由 extraResources 分发。
"""
from PIL import Image
import os

CANVAS_W, CANVAS_H = 164, 314
BG = (0x0C, 0x13, 0x20)
MEME_W = 160  # 缩放后贴纸边长，保持方形

def build(src, dst):
    m = Image.open(src).convert('RGB').resize((MEME_W, MEME_W), Image.LANCZOS)
    canvas = Image.new('RGB', (CANVAS_W, CANVAS_H), BG)
    x = (CANVAS_W - MEME_W) // 2
    y = (CANVAS_H - MEME_W) // 2
    canvas.paste(m, (x, y))
    # 贴纸外缘 2px 浅色描边，让卡片在深底上更清晰
    # （BMP 无圆角，四角直角；描边仅作视觉分隔）
    canvas.save(dst, 'BMP')
    print(f'{os.path.basename(src)} -> {os.path.basename(dst)}  {canvas.size}')

for i in (1, 2, 3):
    build(f'uninstall-{i}.bmp', f'uninstall-{i}.bmp')

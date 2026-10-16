#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把品牌资产（docs/assets/brand/）同步到 5 个消费点。

    python scripts/gen-logo.py

为什么是「同步」而不是「现场生成」：品牌资产由 E:\Midi\_attic\styles\ 那套流水线
（logo3.py 出立绘 → mkicon.py 出全套尺寸）**已经生成好了**，并且对每个尺寸做过
尺寸自适应（≥128 用全身、≤64 换半身）。这里再自己缩放一遍只会引入重采样损失，
所以只做「选择 + 拷贝 + 断言」。要换立绘请改母图后重跑那套流水线，再重跑本脚本。

消费点与选型（依据 = 新图标\读我.md 的用途表 + 各位置的实际底色）：

| 位置 | 用什么 | 为什么 |
|---|---|---|
| build/icon.ico（exe / 安装器 / 卸载器） | 立绘-白底（.ico 多尺寸） | 官方结论：**白底版当主图标**；深靛底 + 细金线的徽记在小尺寸下糊成一团 |
| build/icon.png（窗口 / 托盘 / extraResources） | 立绘-白底-512 | 同上，与 .ico 保持同一张脸 |
| frontend/src/assets/logo.png（侧边栏 38px） | **立绘-深靛-512** | 侧边栏是**浅色**面板：白底图标会糊进白里；深靛圆角卡在浅色/深色主题下都立得住 |
| docs/assets/logo.png（文档页 nav 36px） | 立绘-深靛-512 | 文档页同为浅色底 |
| 安装器侧栏 / 更新器左图 | **徽记-512** | 徽记是「启动画面 / 关于页」用的完整方形图（金框 + 刻度环 + 钢琴卷帘 + 五星），底色本来就是深靛，压在深色安装器上正好 |
| 安装器页眉 150x57 | 立绘-白底（38px） | 页眉太小，徽记在这个尺寸不可读（读我实测：48 以下 ✗） |

★ 一个必须记住的差别：**徽记是整幅不透明的**（自带深靛方底），
  而立绘系列是**圆角透明**的。所以安装器脚本里徽记**不能再套一次圆角**（会切掉金框），
  立绘则要套。
"""
import hashlib
import os
import shutil
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.path.join(ROOT, 'docs', 'assets', 'brand')
BUILD = os.path.join(ROOT, 'build')

SYNC = [
    ('FuFumidi.ico', os.path.join(BUILD, 'icon.ico'), 'exe / 安装器 / 卸载器图标（白底主图标，含 256..16）'),
    ('立绘-白底-512.png', os.path.join(BUILD, 'icon.png'), '窗口 / 托盘图标'),
    ('立绘-深靛-512.png', os.path.join(ROOT, 'frontend', 'src', 'assets', 'logo.png'), '侧边栏（浅色面板）'),
    ('立绘-深靛-512.png', os.path.join(ROOT, 'docs', 'assets', 'logo.png'), '文档页 nav'),
]

EXPECT_ICO_SIZES = {(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)}


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()[:12]


def main():
    if not os.path.isdir(BRAND):
        print('品牌目录不存在：' + BRAND)
        return 1
    missing = [s for s, _, _ in SYNC if not os.path.exists(os.path.join(BRAND, s))]
    if missing:
        print('品牌资产缺失：' + ', '.join(missing))
        return 1

    for src_name, dst, why in SYNC:
        src = os.path.join(BRAND, src_name)
        shutil.copy2(src, dst)
        print('%-42s <- %-18s %8d B  sha=%s  %s' % (
            os.path.relpath(dst, ROOT), src_name, os.path.getsize(dst), sha(dst), why))

    # ---- 断言：尺寸 / 透明度 / ICO 内含尺寸不对就别往下走（图标坏了要发布前就发现）
    icon = Image.open(os.path.join(BUILD, 'icon.png'))
    assert icon.size == (512, 512), 'icon.png 必须是 512x512，实际 ' + str(icon.size)
    assert icon.mode == 'RGBA' and icon.getchannel('A').getpixel((0, 0)) == 0, \
        'icon.png 必须有透明圆角（角落不透明说明选错了变体）'

    ico = Image.open(os.path.join(BUILD, 'icon.ico'))
    have = set(ico.info.get('sizes', set()))
    if not EXPECT_ICO_SIZES.issubset(have):
        print('✗ icon.ico 缺少尺寸：' + str(sorted(EXPECT_ICO_SIZES - have)))
        return 1

    # ---- 预览：深底 / 浅底 各变体（写 dist/，不进安装包）
    prev = os.path.join(ROOT, 'dist')
    os.makedirs(prev, exist_ok=True)
    from PIL import ImageDraw
    white = os.path.join(BRAND, '立绘-白底-512.png')
    indigo = os.path.join(BRAND, '立绘-深靛-512.png')
    sheet = Image.new('RGB', (760, 250), (24, 26, 32))
    d = ImageDraw.Draw(sheet)
    tiles = [
        ('白底 @ 深底', white, (18, 20, 26)),
        ('白底 @ 浅底', white, (244, 246, 250)),
        ('深靛 @ 浅底（侧栏用）', indigo, (247, 248, 250)),
        ('深靛 @ 深底', indigo, (24, 26, 32)),
    ]
    for i, (label, path, bg) in enumerate(tiles):
        tile = Image.new('RGB', (170, 170), bg)
        im = Image.open(path).convert('RGBA')
        small = im.resize((130, 130), Image.LANCZOS)
        tile.paste(small, (20, 20), small)
        sheet.paste(tile, (20 + i * 185, 50))
        d.text((20 + i * 185, 28), label, fill=(200, 210, 225))
    sheet.save(os.path.join(prev, 'logo-preview.png'))
    print('预览：' + os.path.join(prev, 'logo-preview.png'))
    print('（安装器三张图由 scripts/gen-installer-art.py 从品牌资产派生）')
    return 0


if __name__ == '__main__':
    sys.exit(main())

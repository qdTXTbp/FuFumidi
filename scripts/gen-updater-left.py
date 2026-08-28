# 生成 kachina 更新器左侧品牌图（180x400 webp，FuFumidi 品牌色渐变 + 居中 icon）
from PIL import Image, ImageDraw, ImageFilter

SRC = r'd:\FuFuMIDI\FuFumidi\build\icon.png'
OUT = r'd:\FuFuMIDI\FuFumidi\Build\updater-left.webp'
W, H = 180, 400

# 品牌渐变：深蓝紫 → 珊瑚
top = (30, 38, 92)      # #1e265c
mid = (90, 60, 160)     # 紫
bot = (255, 110, 90)    # 珊瑚

img = Image.new('RGBA', (W, H))
d = ImageDraw.Draw(img)
for y in range(H):
    t = y / max(1, H - 1)
    if t < 0.5:
        t2 = t * 2
        c = tuple(int(top[i] + (mid[i] - top[i]) * t2) for i in range(3))
    else:
        t2 = (t - 0.5) * 2
        c = tuple(int(mid[i] + (bot[i] - mid[i]) * t2) for i in range(3))
    d.line([(0, y), (W, y)], fill=c + (255,))

# 把 icon 柔和地贴在中间偏上
try:
    icon = Image.open(SRC).convert('RGBA')
    icon = icon.resize((int(W * 0.55), int(W * 0.55)), Image.LANCZOS)
    # 加白底圆角背景（可读性）
    bg = Image.new('RGBA', (icon.width + 24, icon.height + 24), (255, 255, 255, 0))
    bgd = ImageDraw.Draw(bg)
    bgd.rounded_rectangle([0, 0, bg.width - 1, bg.height - 1], radius=28, fill=(255, 255, 255, 235))
    bg.paste(icon, (12, 12), icon)
    img.paste(bg, ((W - bg.width) // 2, int(H * 0.16)), bg)
except Exception as e:
    print('icon paste skip:', e)

# 底部文字条
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, H - 34, W, H], radius=0, fill=(0, 0, 0, 60))
try:
    from PIL import ImageFont
    font = ImageFont.truetype('msyh.ttc', 16)
    tw = d.textlength('FuFumidi', font=font)
    d.text(((W - tw) / 2, H - 30), 'FuFumidi', fill=(255, 255, 255, 235), font=font)
except Exception as e:
    print('text skip:', e)

img.save(OUT, 'WEBP', quality=90)
print('saved:', OUT, img.size)

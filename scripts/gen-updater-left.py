# 生成 kachina 更新器左侧品牌图（180x400 webp，透明背景 + 居中 icon）
# 说明：kachina 前端硬编码 data:image/webp 前缀，必须用 webp；但 webp 支持透明，
#       因此生成无背景图，只显示 logo 本体（左侧区域底色由 kachina 品牌色提供）。
from PIL import Image, ImageDraw

SRC = r'd:\FuFuMIDI\FuFumidi\build\icon.png'
OUT = r'd:\FuFuMIDI\FuFumidi\Build\updater-left.webp'
W, H = 180, 400

# 透明背景
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))

# icon 本体（icon.png 自带透明背景，直接等比缩放，不加任何底板/底色）
try:
    icon = Image.open(SRC).convert('RGBA')
    icon = icon.resize((int(W * 0.62), int(W * 0.62)), Image.LANCZOS)
    img.paste(icon, ((W - icon.width) // 2, int(H * 0.22)), icon)
except Exception as e:
    print('icon paste skip:', e)

# 底部文字（透明底白字，跟随深色品牌区域显示）
d = ImageDraw.Draw(img)
try:
    from PIL import ImageFont
    font = ImageFont.truetype('msyh.ttc', 16)
    tw = d.textlength('FuFumidi', font=font)
    # 文字用半透明白，可叠加在 kachina 深色品牌底上
    d.text(((W - tw) / 2, H - 34), 'FuFumidi', fill=(255, 255, 255, 220), font=font)
except Exception as e:
    print('text skip:', e)

img.save(OUT, 'WEBP', quality=95, lossless=True)
print('saved:', OUT, img.size, 'mode:', img.mode)

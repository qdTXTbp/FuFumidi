# -*- coding: utf-8 -*-
"""合成乐谱图：给 OMR 一个「标准答案」。
用 PIL 画一张已知音高/时值/变化音的钢琴谱（两行谱表 x 两个系统），
让 engine_omr 离线可测 —— 真实扫描件没法进单元测试，合成图可以。

版面按真实刻版的规矩来：小节线左端留白、谱号+拍号占位、音符按每拍像素数均匀分布
（这一条很关键：音符位置必须和「小节宽 / 拍数」自洽，否则节拍拟合的测试没有意义）。
"""
import numpy as np
from PIL import Image, ImageDraw

SP = 12                     # 谱线间距（像素）
LINE_W = 2
NOTE_W, NOTE_H = int(SP * 1.15), int(SP * 0.78)


def _staff(dr, x0, x1, top):
    for i in range(5):
        y = top + i * SP
        dr.rectangle([x0, y, x1, y + LINE_W - 1], fill=0)


def _note(dr, x, y, filled=True, stem=True, stem_up=True):
    dr.ellipse([x - NOTE_W // 2, y - NOTE_H // 2, x + NOTE_W // 2, y + NOTE_H // 2], fill=0)
    if not filled:
        dr.ellipse([x - NOTE_W // 2 + 3, y - NOTE_H // 2 + 2, x + NOTE_W // 2 - 3, y + NOTE_H // 2 - 2], fill=255)
    if stem:
        sx = x + NOTE_W // 2 - 1 if stem_up else x - NOTE_W // 2
        sy0, sy1 = (y - int(3.4 * SP), y) if stem_up else (y, y + int(3.4 * SP))
        dr.rectangle([sx, sy0, sx + LINE_W - 1, sy1], fill=0)


def _beam(dr, x0, x1, y, n=1):
    for k in range(n):
        yy = y + k * 5
        dr.rectangle([x0, yy, x1, yy + 2], fill=0)


def _sharp(dr, x, y):
    h = int(1.9 * SP)
    dr.rectangle([x, y - h // 2, x + 1, y + h // 2], fill=0)
    dr.rectangle([x + int(0.5 * SP), y - h // 2 - 1, x + int(0.5 * SP) + 1, y + h // 2 - 1], fill=0)
    dr.rectangle([x - 1, y - 2, x + int(0.5 * SP) + 2, y], fill=0)
    dr.rectangle([x - 1, y + 3, x + int(0.5 * SP) + 2, y + 5], fill=0)


def _flat(dr, x, y):
    h = int(1.8 * SP)
    dr.rectangle([x, y - h // 2, x + 1, y + h // 2], fill=0)
    dr.ellipse([x, y + 1, x + int(0.75 * SP), y + int(0.62 * SP)], fill=0)


def _natural(dr, x, y):
    """还原号：左竖在下、右竖在上（错开），这是它和升号唯一的形状差别。"""
    h = int(2.0 * SP)
    xr = x + int(0.55 * SP)
    dr.rectangle([x, y - h // 2 + int(0.45 * h), x + 1, y + h // 2], fill=0)
    dr.rectangle([xr, y - h // 2, xr + 1, y + h // 2 - int(0.45 * h)], fill=0)
    dr.rectangle([x - 1, y - 2, xr + 2, y], fill=0)
    dr.rectangle([x - 1, y + 3, xr + 2, y + 5], fill=0)


def _clef_treble(dr, x, top):
    """高音谱号：从谱表下方绕上来的一条长竖 + 两个圆，总高 ~3.4 个间距以上。"""
    bottom = top + 4 * SP
    dr.rectangle([x + int(0.5 * SP), top - int(1.1 * SP), x + int(0.5 * SP) + 2, bottom + int(0.6 * SP)], fill=0)
    dr.ellipse([x - int(0.4 * SP), top + SP, x + SP, top + 3 * SP], outline=0, width=2)
    dr.ellipse([x, bottom - SP, x + int(0.9 * SP), bottom], fill=0)


def _clef_bass(dr, x, top):
    """低音谱号：一个实心大点 + 右侧两个小点，总高 ~2 个间距。"""
    dr.ellipse([x, top + SP, x + int(0.7 * SP), top + int(2.2 * SP)], fill=0)
    dr.ellipse([x + int(0.9 * SP), top + SP - 2, x + int(1.2 * SP), top + SP + 1], fill=0)
    dr.ellipse([x + int(0.9 * SP), top + int(2.4 * SP), x + int(1.2 * SP), top + int(2.7 * SP)], fill=0)


def build(path):
    """返回 (图片路径, 元信息)。expect 项 = (midi, 起始拍, 时值拍数, 谱表序号)。"""
    W, H = 1000, 820
    X0, X1 = 70, W - 40
    CLEF_X = X0 + int(2.0 * SP)            # 谱号
    TSIG_X = X0 + int(4.3 * SP)            # 拍号
    FIRST_BAR = X0 + int(7.0 * SP)         # 第一小节线
    MW = (X1 - FIRST_BAR) / 4.0            # 小节宽
    NOTE_PAD = int(0.7 * SP)               # 小节线后的刻版留白
    PER_BEAT = (MW - 2 * NOTE_PAD) / 4.0   # 每拍像素数

    def nx(bt):
        return FIRST_BAR + NOTE_PAD + int(bt * PER_BEAT)

    def step_y(top, step):
        return top + 4 * SP - step * (SP // 2)

    def midi_of(step, acc, clef):
        base = 30 if clef == "treble" else 18
        d = base + step
        letter = ["C", "D", "E", "F", "G", "A", "B"][d % 7]
        octv = d // 7
        semi = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[letter]
        return 12 * (octv + 1) + semi + acc

    img = Image.new("L", (W, H), 255)
    dr = ImageDraw.Draw(img)
    expect = []
    bar_x = [FIRST_BAR + int(n * MW) for n in range(4)]

    # ---- 系统 1
    t_top, b_top = 90, 90 + int(7.4 * SP)
    _staff(dr, X0, X1, t_top)
    _staff(dr, X0, X1, b_top)
    _clef_treble(dr, CLEF_X, t_top)
    _clef_bass(dr, CLEF_X - 1, b_top)
    dr.rectangle([TSIG_X, t_top, TSIG_X + 6, t_top + 2 * SP], fill=0)
    dr.rectangle([TSIG_X, t_top + 2 * SP + 3, TSIG_X + 6, t_top + 4 * SP], fill=0)
    beats = [0.0, 1.0, 2.0, 2.5, 2.75, 3.0, 3.25, 3.5]
    steps = [0, 2, 4, 5, 6, 7, 8, 9]          # E4 G4 A4 B4 C5 D5 E5 F5
    for k, (bt, stp) in enumerate(zip(beats, steps)):
        x, y = nx(bt), step_y(t_top, stp)
        _note(dr, x, y, filled=True, stem=True, stem_up=(stp < 5))
        expect.append((midi_of(stp, 0, "treble"), bt, 1.0 if k < 3 else 0.25, 0))
    _beam(dr, nx(2.0) - int(0.6 * SP), nx(3.5) + int(0.6 * SP), t_top - int(3.4 * SP), n=2)
    for bt, stp in ((0.0, -2), (2.0, -4)):     # 低音：两个二分音符（空心）
        _note(dr, nx(bt), step_y(b_top, stp), filled=False, stem=True, stem_up=False)
        expect.append((midi_of(stp, 0, "bass"), bt, 2.0, 1))
    for x in bar_x + [X1]:
        dr.rectangle([x, t_top, x + 1, b_top + 4 * SP], fill=0)

    # ---- 系统 2：带变化音（升 / 降 / 还原）
    t2 = t_top + int(16.5 * SP)
    b2 = t2 + int(7.4 * SP)
    _staff(dr, X0, X1, t2)
    _staff(dr, X0, X1, b2)
    _clef_treble(dr, CLEF_X, t2)
    _clef_bass(dr, CLEF_X - 1, b2)
    for x in bar_x + [X1]:
        dr.rectangle([x, t2, x + 1, b2 + 4 * SP], fill=0)
    for k, (stp, acc, kind) in enumerate([(1, 1, "sharp"), (3, -1, "flat"), (5, 0, "natural")]):
        bt = k * 1.0
        x, y = nx(bt), step_y(t2, stp)
        if kind == "sharp":
            _sharp(dr, x - int(1.7 * SP), y)
        elif kind == "flat":
            _flat(dr, x - int(1.7 * SP), y)
        else:
            _natural(dr, x - int(1.7 * SP), y)
        _note(dr, x, y, filled=True, stem=True, stem_up=True)
        expect.append((midi_of(stp, acc, "treble"), bt, 1.0, 2))
    for bt, stp in ((0.0, 2), (2.0, 0)):
        _note(dr, nx(bt), step_y(b2, stp), filled=True, stem=True, stem_up=False)
        expect.append((midi_of(stp, 0, "bass"), bt, 1.0, 3))

    img.save(path)
    meta = {"spacing": SP, "x0": X0, "x1": X1, "systems": [[t_top, b_top], [t2, b2]],
            "barlines": bar_x, "expect": expect, "perBeat": PER_BEAT, "firstBar": FIRST_BAR}
    return path, meta


if __name__ == "__main__":
    p, m = build(r"E:\Midi\_sing_tmp\omr\synthetic.png")
    print(p, len(m["expect"]), "notes")

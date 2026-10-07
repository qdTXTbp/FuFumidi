# -*- coding: utf-8 -*-
"""多后端识谱调度层的回归测试（不依赖真的装 Audiveris）。"""
import os
import sys
import tempfile

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import engine_omr_backends as B  # noqa: E402
import omr_fixture  # noqa: E402


def _tiny_image(path, w=200, h=120):
    """画几条横线 + 一个方块，用来验证预处理（不需要是乐谱）。"""
    img = Image.new("L", (w, h), 245)
    px = img.load()
    for y in range(20, h - 20, 10):
        for x in range(10, w - 10):
            px[x, y] = 30
    for y in range(60, 80):
        for x in range(60, 90):
            px[x, y] = 10
    img.save(path)
    return path


def test_prep_image_upscales_and_binarizes():
    tmp = tempfile.mkdtemp(prefix="omr-be-")
    src = _tiny_image(os.path.join(tmp, "in.png"))
    dst = os.path.join(tmp, "out.png")
    info = B.prep_image(src, dst, scale=3)
    assert info["size"] == (600, 360), "应放大 3 倍"
    arr = np.asarray(Image.open(dst))
    vals = set(np.unique(arr).tolist())
    assert vals <= {0, 255}, "预处理后必须是纯二值图，实际 %s" % sorted(vals)[:5]
    assert 0.02 < float((arr < 128).mean()) < 0.6


def test_prep_image_respects_size_cap():
    tmp = tempfile.mkdtemp(prefix="omr-be-")
    src = _tiny_image(os.path.join(tmp, "in.png"), 2600, 600)
    dst = os.path.join(tmp, "out.png")
    info = B.prep_image(src, dst, scale=4)
    assert max(info["size"]) <= 6000, "放大后不应超过 6000px（否则内存会炸）"


def test_merge_midis_offsets_pages():
    mido = pytest.importorskip("mido")
    tmp = tempfile.mkdtemp(prefix="omr-be-")

    def write(path, notes, dur=480):
        mid = mido.MidiFile(type=1, ticks_per_beat=480)
        meta = mido.MidiTrack(); mid.tracks.append(meta)
        meta.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120), time=0))
        tr = mido.MidiTrack(); mid.tracks.append(tr)
        tr.append(mido.MetaMessage("track_name", name="Piano", time=0))
        last = 0
        for i, n in enumerate(notes):
            tr.append(mido.Message("note_on", note=n, velocity=90, time=0))
            tr.append(mido.Message("note_off", note=n, velocity=0, time=dur))
            last += dur
        assert last == dur * len(notes)
        mid.save(path)
        return path

    p1 = write(os.path.join(tmp, "p1.mid"), [60, 62, 64])
    p2 = write(os.path.join(tmp, "p2.mid"), [65, 67])
    out = os.path.join(tmp, "merged.mid")
    r = B.merge_midis([p1, p2], out)
    assert r["ok"] and len(r["pages"]) == 2
    mid = mido.MidiFile(out)
    onsets = []
    t = 0
    for msg in mid.tracks[1]:
        t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            onsets.append(t)
    assert onsets == [0, 480, 960, 1440, 1920], "第二页应紧接第一页（1440 = 3 拍后），实际 %s" % onsets


def test_find_audiveris_explicit_missing():
    assert B.find_audiveris(explicit=os.path.join(tempfile.gettempdir(), "nope", "Audiveris.exe")) is None


def test_run_audiveris_reports_backend_missing():
    tmp = tempfile.mkdtemp(prefix="omr-be-")
    src = _tiny_image(os.path.join(tmp, "in.png"))
    r = B.run_audiveris([src], tmp, explicit=os.path.join(tmp, "nope.exe"))
    assert r["ok"] is False
    assert r.get("code") == "backend-missing", "应回报「引擎没装」这个可翻译的代码"


def test_classical_backend_still_reachable():
    """auto 模式下没有 Audiveris 时必须能降级到自带经典识谱（离线兜底）。"""
    tmp = tempfile.mkdtemp(prefix="omr-be-")
    png = os.path.join(tmp, "score.png")
    omr_fixture.build(png)
    out = os.path.join(tmp, "out.mid")
    code = B.main(["to-midi", "--in", png, "--out", out, "--backend", "classical",
                   "--beats", "4", "--tempo", "120"])
    assert code == 0
    assert os.path.exists(out) and os.path.getsize(out) > 200

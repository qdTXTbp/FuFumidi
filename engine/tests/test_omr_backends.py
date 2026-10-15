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


# ---------------- M2-2 跨页声部对齐 ----------------

def _pg(parts):
    return {"parsed": {"parts": parts}}


def _part(name, notes, staves=1):
    return {"name": name, "staves": staves,
            "notes": [{"start": s, "end": e, "midi": m, "staff": st} for (s, e, m, st) in notes]}


def test_merge_pages_voice_parts_fill_the_gaps_in_order():
    """第 2 页前两个声部被 OCR 读成 Voice —— 要按顺序填回第 1 页的 Flute / Oboe 槽。

    填错位置的话，第 2 页的长笛音符会跑到双簧管那条轨上（音域一眼看得出）。
    """
    p1 = _pg([_part("Flute 1,2", [(0, 480, 72, 1)]), _part("Oboe1,2", [(0, 480, 69, 1)]),
              _part("Clarinet (135) 1,2", [(0, 480, 60, 1)])])
    p2 = _pg([_part("Voice", [(0, 480, 74, 1)]), _part("Voice", [(0, 480, 71, 1)]),
              _part("Cl. (Bb) 1,2", [(0, 480, 62, 1)])])
    out = B.merge_pages([p1, p2], None, {"sounding": False})
    assert [t["label"] for t in out["tracks"]] == ["Flute 1,2", "Oboe 1,2", "Clarinet in Bb 1,2"]
    flute = out["parsed"]["parts"][0]["notes"]
    assert sorted(n["midi"] for n in flute) == [72, 74], "第 2 页那个 Voice 的 74 要落在长笛轨"


def test_merge_pages_handles_a_page_with_two_systems():
    """★ 实测逼出来的：Audiveris 按**系统**出 part，一页两个系统就把声部表整个重复一遍。

    第 5 页 23 个 part = 10（系统 1）+ 13（系统 2），两次都从长笛开始。
    按页内序号对齐时第二个系统会整片错位、再新建一整套槽位（实测轨数 21 → 41）。
    """
    p1 = _pg([_part("FL1,2", [(0, 480, 72, 1)]), _part("Ob. 1,2", [(0, 480, 69, 1)])])
    p2 = _pg([_part("FL1,2", [(0, 480, 72, 1)]), _part("Ob. 1,2", [(0, 480, 69, 1)]),
              _part("Hn. (F) 1,2 '", [(0, 480, 60, 1)])])
    p3 = _pg([_part("FL1,2", [(0, 480, 74, 1)]), _part("Ob. 1,2", [(0, 480, 71, 1)]),
              _part("Hn. (F) 1,2 '", [(0, 480, 62, 1)])])
    out = B.merge_pages([p1, p2, p3], None, {"sounding": False})
    assert [t["label"] for t in out["tracks"]] == ["Flute 1,2", "Oboe 1,2", "Horn in F 1,2"]
    assert [t["notes"] for t in out["tracks"]] == [3, 3, 2]


def test_merge_pages_part_number_disambiguates():
    """同乐器多声部（两支号 1,2 / 3,4，两把小提琴 I / II）靠编号分，不靠出现顺序。"""
    p1 = _pg([_part("Hn. (F) 1,2", [(0, 480, 60, 1)]), _part("Hn. (F) 3,4", [(0, 480, 55, 1)])])
    # 第 2 页先出现 3,4 再出现 1,2（顺序反着），且 II 被 OCR 读成 ll
    p2 = _pg([_part("Hn. (F) 3,4", [(0, 480, 57, 1)]), _part("Hn. (F) 1,2", [(0, 480, 62, 1)])])
    p3 = _pg([_part("Vln. I", [(0, 480, 72, 1)]), _part("V1n.ll", [(0, 480, 67, 1)])])
    out = B.merge_pages([p1, p2, p3], None, {"sounding": False})
    labels = [t["label"] for t in out["tracks"]]
    assert labels == ["Horn in F 1,2", "Horn in F 3,4", "Violin I", "Violin II"]
    assert [t["notes"] for t in out["tracks"]] == [2, 2, 1, 1]
    parts = {t["label"]: p["notes"] for t, p in zip(out["tracks"], out["parsed"]["parts"])}
    assert sorted(n["midi"] for n in parts["Horn in F 3,4"]) == [55, 57], "3,4 那条不许混进 1,2 的音"
    assert [n["midi"] for n in parts["Violin II"]] == [67]


def test_merge_pages_first_page_keeps_score_order():
    """第 1 页全是新建槽位 —— 顺序必须就是总谱从上到下的顺序（插入位置别插反）。"""
    page = _pg([_part("Alto Flute", [(0, 480, 72, 1)]),
                _part("Bass Clarinet", [(0, 480, 60, 1)]),
                _part("Contrabassoon", [(0, 480, 36, 1)])])
    out = B.merge_pages([page], None, {"sounding": False})
    assert [t["label"] for t in out["tracks"]] == ["Alto Flute", "Bass Clarinet", "Contrabassoon"]


def test_merge_pages_keeps_one_track_per_instrument_across_pages():
    """M2-2 的核心：两页露出的声部表不同，同一个乐器仍要落在**同一条**轨上。

    旧规则按「页内第几个 part」合并 —— 第 2 页少了长笛、又多出两个 Voice，
    三页下来长笛会被拆成三条轨，轨名只剩「声部 N」。
    """
    page1 = _pg([
        _part("Flute 1,2", [(0, 480, 72, 1)]),
        _part("Oboe1,2", [(0, 480, 69, 1)]),
        _part("Horn (F) 3,4", [(0, 480, 60, 1)]),
    ])
    page2 = _pg([
        _part("Voice", [(0, 480, 74, 1)]),        # 其实是长笛，OCR 没读出来
        _part("Voice", [(0, 480, 71, 1)]),        # 其实是双簧管
        _part("Horn (F) 3,4", [(0, 480, 60, 1)]),
    ])
    out = B.merge_pages([page1, page2], None, {"sounding": False})
    assert [t["label"] for t in out["tracks"]] == ["Flute 1,2", "Oboe 1,2", "Horn in F 3,4"]
    assert [t["notes"] for t in out["tracks"]] == [2, 2, 2]
    assert out["noteCount"] == 6
    assert out["keyConflicts"] == []


def test_merge_pages_applies_transpose_to_every_page():
    """移调要按**声部**（槽位）统一施加，不能只看某一页的原始 part 名。"""
    p1 = _pg([_part("Ham (F) 1,2 '", [(0, 480, 60, 1)])])       # Ham = Horn in F
    p2 = _pg([_part("Voice", [(0, 480, 62, 1)])])               # 同一支号，第 2 页没读出名字
    out = B.merge_pages([p1, p2], None, {"sounding": True})
    assert len(out["tracks"]) == 1
    assert out["tracks"][0]["instrument"] == "Horn"
    assert out["tracks"][0]["transpose"] == -7
    parsed = out["parsed"]["parts"][0]["notes"]
    assert sorted(n["midi"] for n in parsed) == [53, 55]        # 两页都降了纯五度
    assert out["transposedTracks"] == 1


def test_merge_pages_splits_grand_staff_and_merges_pages():
    """钢琴：同一个 <part> 的两行谱表要分成两条轨，跨页仍各归各位。"""
    p1 = _pg([_part("Piano", [(0, 480, 60, 1), (0, 480, 48, 2)], staves=2)])
    p2 = _pg([_part("Piano", [(0, 480, 62, 1), (0, 480, 50, 2)], staves=2)])
    out = B.merge_pages([p1, p2], None, {"sounding": False})
    assert len(out["tracks"]) == 2
    assert [t["notes"] for t in out["tracks"]] == [2, 2]
    lo = out["parsed"]["parts"][1]["notes"]
    assert sorted(n["midi"] for n in lo) == [48, 50]            # 左手那条只有低音


# ---------------- M1-2 拍号推断 + 统一小节网格 ----------------

def _page_with_measures(lens, name="Flute 1,2", tpb=480):
    """造一页：每个小节一个四分音符（够用就行），小节长度按 lens 给。"""
    notes, t = [], 0
    for mi, L in enumerate(lens):
        notes.append({"start": t, "end": t + min(L, tpb), "midi": 72, "vel": 80,
                      "staff": 1, "m": mi, "off": 0})
        t += L
    return {"parsed": {"parts": [{"name": name, "staves": 1, "notes": notes,
                                  "measureLens": list(lens)}]}}


def test_infer_meter_from_measure_lengths():
    """6/8：一小节 3 个四分音符（1440 tick）—— 实测那份总谱每一页的众数都是它。"""
    pages = [_page_with_measures([1440] * 8 + [960, 1920]),
             _page_with_measures([1440] * 10)]
    m = B.infer_meter(pages, 480)
    assert m and (m["beats"], m["beatType"]) == (6, 8), m
    assert m["ticks"] == 1440
    # 4 个四分 → 4/4
    m4 = B.infer_meter([_page_with_measures([1920] * 12)], 480)
    assert (m4["beats"], m4["beatType"]) == (4, 4)


def test_infer_meter_refuses_when_ambiguous():
    """众数不明显就不猜 —— 猜错会把整首曲子的拍号写错。"""
    assert B.infer_meter([_page_with_measures([1440, 960, 1440, 960, 1920, 1920])], 480) is None
    assert B.infer_meter([], 480) is None
    assert B.infer_meter([_page_with_measures([20000] * 6)], 480) is None    # 明显是识别碎片


def test_regrid_puts_every_part_on_one_bar_grid():
    """不同声部的小节长度不一样时，按 m/off 重新摆到统一网格上。"""
    a = _page_with_measures([960, 1440, 1440], name="Flute 1,2")     # 第 1 小节被算短了
    b = _page_with_measures([1440, 1440, 1440], name="Oboe1,2")
    out = B.merge_pages([a, b], None, {"sounding": False})
    assert out["timeSig"] == "6/8" and out["meterInferred"] is True
    assert out["regridded"] >= 1
    for part in out["parsed"]["parts"]:
        for n in part["notes"]:
            assert n["start"] % 1440 == 0, "统一网格后每个音都应落在小节线上"


def test_page_length_is_whole_bars_not_last_note():
    """页长按「这一页有多少小节」算：末小节是空的也不能让下一页提前。"""
    p1 = _page_with_measures([1440, 1440, 1440, 1440])               # 4 小节，最后一个音符在第 1 小节
    p1["parsed"]["parts"][0]["notes"] = p1["parsed"]["parts"][0]["notes"][:1]
    p2 = _page_with_measures([1440, 1440])
    out = B.merge_pages([p1, p2], None, {"sounding": False})
    assert out["pageBeats"] == [12.0, 6.0], out["pageBeats"]          # 4 小节 × 3 拍
    starts = sorted(n["start"] for n in out["parsed"]["parts"][0]["notes"])
    assert starts[1] == 4 * 1440, "第 2 页的音符要落在第 5 小节，不能提前"


# ---------------- M2-1 分带 ----------------

def _page_with_two_systems(path, w=900, h=700, sp=8):
    """画两「系统」：上面 3 行谱表、下面 2 行，各自有一条贯穿的竖线（组括号），
    两个系统之间没有 —— 这正是实测出来的系统交界判据。"""
    img = Image.new("L", (w, h), 245)
    px = img.load()
    sys1 = [120, 120 + 60, 120 + 120]
    sys2 = [420, 480]

    def staff(top):
        for i in range(5):
            y = top + i * sp
            for x in range(120, w - 120):
                px[x, y] = 20

    for top in sys1 + sys2:
        staff(top)
    for top in [sys1[0], sys2[0]]:                         # 每个系统自己的左括号
        last = sys1[-1] if top == sys1[0] else sys2[-1]
        for y in range(top, last + 4 * sp + 1):
            for x in range(112, 117):
                px[x, y] = 20
    img.save(path)
    return path


def test_plan_page_bands_splits_systems_by_the_connector_rule():
    tmp = tempfile.mkdtemp(prefix="omr-bands-")
    src = _page_with_two_systems(os.path.join(tmp, "page.png"))
    plan = B.plan_page_bands(src, tmp, 1, max_staves=12)
    assert plan, "至少要切出一带"
    by_sys = {}
    for b in plan:
        by_sys.setdefault(b["sys"], []).append(b)
    assert sorted(by_sys) == [0, 1], "应该判出两个系统，实际 %s" % sorted(by_sys)
    assert sum(x["staves"] for x in by_sys[0]) == 3
    assert sum(x["staves"] for x in by_sys[1]) == 2
    assert all(os.path.exists(b["png"]) for b in plan), "每带都要真的写出图"
    arr = np.asarray(Image.open(plan[0]["png"]))
    assert set(np.unique(arr).tolist()) <= {0, 255}, "带图也要是纯二值"


def test_plan_page_bands_respects_max_staves():
    """一带最多 max_staves 行 —— 超了就再切，但只在「组交界」切（这里每组一条括号）。"""
    tmp = tempfile.mkdtemp(prefix="omr-bands2-")
    src = _page_with_two_systems(os.path.join(tmp, "page.png"))
    plan = B.plan_page_bands(src, tmp, 1, max_staves=2)
    assert plan[0]["staves"] <= 2, plan
    assert all(b["staves"] <= 2 for b in plan)


# ---------------- 速度记号（Audiveris 不导出 <sound tempo>，但 OCR 留在 .omr 里）----------------

def _fake_omr(path, words, role="Metronome", box=(2552, 680, 36, 16)):
    """造一个最小的 Audiveris 书文件：<metronome> + 紧跟的 <word>（实测就是这个结构）。"""
    import zipfile
    inner = ''.join('<word value="%s" font="S-24" shape="TEXT" staff="1" id="%d">'
                    '<bounds x="%d" y="%d" w="%d" h="%d"/></word>'
                    % (w, 100 + i, box[0], box[1], box[2], box[3]) for i, w in enumerate(words))
    xml = ('<?xml version="1.0" encoding="UTF-8"?><sheet>'
           '<metronome font="S-24" role="%s" shape="METRONOME" staff="1" id="14456">'
           '<bounds x="%d" y="%d" w="%d" h="%d"/></metronome>%s</sheet>'
           % (role, box[0], box[1], box[2], box[3], inner))
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("book.xml", "<book/>")
        z.writestr("sheet#1/sheet#1.xml", xml)
    return path


def test_metronome_read_when_ocr_is_clean():
    """OCR 读准了就采用（谱面「♩ = 120」→ word '=120'）。"""
    tmp = tempfile.mkdtemp(prefix="omr-metro-")
    _fake_omr(os.path.join(tmp, "prep-001.omr"), ["=120"])
    m = B.read_metronome_from_omr(tmp, 1)
    assert m and m["found"] and m["bpm"] == 120, m
    assert m["box"] == [2552, 680, 36, 16]


def test_metronome_refuses_a_garbled_number():
    """★ 读不准就不采用：这份总谱真值 60，被 OCR 读成 12 —— 猜错整首曲子的速度都是错的。"""
    tmp = tempfile.mkdtemp(prefix="omr-metro2-")
    _fake_omr(os.path.join(tmp, "prep-001.omr"), ["=12"])
    m = B.read_metronome_from_omr(tmp, 1)
    assert m and m["found"] and m["bpm"] is None and m.get("unreadable") is True, m


def test_metronome_absent_is_not_an_error():
    tmp = tempfile.mkdtemp(prefix="omr-metro3-")
    import zipfile
    with zipfile.ZipFile(os.path.join(tmp, "prep-001.omr"), "w") as z:
        z.writestr("sheet#1/sheet#1.xml", "<sheet></sheet>")
    m = B.read_metronome_from_omr(tmp, 1)
    assert m and m["found"] is False and m["bpm"] is None, m
    assert B.read_metronome_from_omr(os.path.join(tmp, "nope"), 1) is None


# ---------------- M2-4 逐页体检 ----------------

def test_page_checks_flags_structural_problems():
    """体检要能看出「这一页结构不对」：小节数不一致 / 空页 / 非正时值 / 超长音 / 同刻同音重复。"""
    good = {"measureLens": [1440] * 9,
            "notes": [{"start": 0, "end": 480, "midi": 60, "m": 0, "off": 0}]}
    c = B._page_checks(1, [good], 1440, 480)
    assert c["bars"] == 9 and c["notes"] == 1 and c["issues"] == []

    # 两个声部看到的小节数不同 → bar-count-mismatch
    a = {"measureLens": [1440] * 9, "notes": good["notes"]}
    b = {"measureLens": [1440] * 7, "notes": good["notes"]}
    c2 = B._page_checks(2, [a, b], 1440, 480)
    assert c2["bars"] == 9
    assert any(x["code"] == "bar-count-mismatch" and x["min"] == 7 and x["max"] == 9 for x in c2["issues"])

    # 空页
    assert any(x["code"] == "empty-page" for x in B._page_checks(3, [{"measureLens": [], "notes": []}], 1440, 480)["issues"])

    # 超长音（> 8 小节）、非正时值、同刻同音重复
    bad = {"measureLens": [1440] * 4,
           "notes": [{"start": 0, "end": 1440 * 9, "midi": 60},
                     {"start": 100, "end": 100, "midi": 62},
                     {"start": 200, "end": 600, "midi": 64},
                     {"start": 200, "end": 600, "midi": 64}]}
    c3 = B._page_checks(4, [bad], 1440, 480)
    codes = {x["code"] for x in c3["issues"]}
    assert {"long-hold", "neg-duration", "same-pitch-dup"} <= codes, c3


def test_merge_pages_reports_page_checks():
    page = {"parsed": {"parts": [{"name": "Piano", "staves": 1, "measureLens": [1440, 1440],
                                  "notes": [{"start": 0, "end": 480, "midi": 60, "staff": 1,
                                             "m": 0, "off": 0}]}]}}
    out = B.merge_pages([page], None, {"sounding": False})
    assert out["pageChecks"] and out["pageChecks"][0]["bars"] == 2, out.get("pageChecks")


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


def _parsed_page(parts, tpb=480):
    """造一页「已解析」的谱：parts 是 [(名字, [(start, end, midi), ...]), ...]。"""
    return {"parts": [{"name": nm, "staves": 1,
                       "notes": [{"start": s, "end": e, "midi": m, "vel": 80} for (s, e, m) in ns]}
                      for (nm, ns) in parts]}


def test_merge_pages_keeps_one_track_per_part_index():
    """★ 这是「整部总谱塌成一轨」那个 bug 的回归钉。

    Audiveris 导出的声部名全是 Voice/Piano；旧实现按**名字**分组，
    15 个声部会全并成同一条轨（实测 1430 个音符只剩 Voice + Piano 两条）。
    现在按「页内声部序号」合并，页与页之间第 k 个声部接第 k 个。
    """
    p1 = _parsed_page([("Voice", [(0, 480, 60)]), ("Piano", [(0, 480, 48)]), ("Voice", [(0, 480, 55)])])
    p2 = _parsed_page([("Voice", [(0, 480, 62)]), ("Piano", [(0, 480, 50)]), ("Voice", [(0, 480, 57)])])
    r = B.merge_pages([{"page": 1, "parsed": p1}, {"page": 2, "parsed": p2}], None, {"bpm": 120})
    assert len(r["tracks"]) == 3, "三个声部就该是三条轨，实际 %d" % len(r["tracks"])
    assert [t["notes"] for t in r["tracks"]] == [2, 2, 2]
    assert r["noteCount"] == 6
    assert r["tracks"][0]["name"] == "Part 1"
    assert r["tracks"][0]["label"] == "声部 1"
    assert r["pageBeats"] == [1.0, 1.0], "每页长度按最后一个音的结束点推进"


def test_merge_pages_postprocess_quantize_dedupe_short():
    """量化 / 去重 / 丢短音三个后处理开关都要真的改到音符。"""
    page = _parsed_page([("Voice", [(7, 130, 60), (7, 130, 60), (200, 210, 64)])])
    raw = B.merge_pages([{"page": 1, "parsed": page}], None, {"bpm": 120, "dedupe": False})
    assert raw["noteCount"] == 3, "不去重时三个音符都在"
    fixed = B.merge_pages([{"page": 1, "parsed": page}], None,
                          {"bpm": 120, "dedupe": True, "quantize": B._quantize_ticks("1/8")})
    assert fixed["noteCount"] == 2, "重复的那个应被去掉"
    assert fixed["stats"]["dup"] == 1
    assert fixed["stats"]["quantized"] >= 1
    for p in [fixed]:
        for n in p["parsed"]["parts"][0]["notes"]:
            if n["midi"] == 60:
                assert n["start"] % 240 == 0, "量化到 1/8（240 tick）后起点应落在网格上"
    short = B.merge_pages([{"page": 1, "parsed": page}], None,
                          {"bpm": 120, "dedupe": True, "min_ms": 200})
    assert short["stats"]["short"] >= 1, "10 tick ≈ 10ms，200ms 阈值下应被滤掉"


def test_safe_midi_name_is_ascii():
    """MIDI 的 track_name 是 latin-1：中文轨名会让 mido 直接抛 UnicodeEncodeError。"""
    assert B._safe_midi_name("声部 1", 0) == "Part 1"
    assert B._safe_midi_name("Voice", 1) == "Part 2"
    assert B._safe_midi_name("Flute", 2) == "Flute"
    assert B._safe_midi_name("", 3) == "Part 4"


def test_quantize_ticks_maps_note_values():
    assert B._quantize_ticks("off") == 0
    assert B._quantize_ticks("1/4") == 480
    assert B._quantize_ticks("1/8") == 240
    assert B._quantize_ticks("1/16") == 120
    assert B._quantize_ticks("1/32") == 60


def test_meta_override_auto_keeps_score_values():
    """auto = 谱面自己写的优先；显式填了才覆盖（界面上那三个控件必须真有用）。"""
    parsed = {"tpb": 480, "tempos": [{"tick": 0, "bpm": 63}],
              "times": [{"tick": 0, "beats": 6, "beatType": 8}], "keys": [{"tick": 0, "fifths": 3}],
              "timesFromScore": True}

    class A:
        tempo = "auto"
        beats = "auto"
        beat_type = 4
        quantize = "off"
        min_note_ms = 0.0
        dedupe = "on"

    ov = B._meta_override(A(), parsed)
    assert ov["bpm"] == 63 and ov["times"][0]["beats"] == 6
    A.tempo, A.beats, A.beat_type = "120", "4", 4
    ov2 = B._meta_override(A(), parsed)
    assert ov2["bpm"] == 120 and ov2["times"][0]["beats"] == 4

    # ★ 谱面**没写**拍号时不能把解析器的默认 4/4 当成"谱面自带"传下去 ——
    #   那样 merge_pages 会以为是用户指定的拍号，infer_meter 根本没机会跑（实测白跑一轮）。
    A.tempo, A.beats, A.beat_type = "auto", "auto", 4
    parsed2 = {"tpb": 480, "times": [{"tick": 0, "beats": 4, "beatType": 4}],
               "timesFromScore": False}
    assert B._meta_override(A(), parsed2)["times"] == [], "要留空交给拍号推断"


def test_prep_image_thicken_optional():
    """加粗默认必须是关的：3×3 加粗会把密集总谱整页判 invalid（实测第 1 页导出 0 个 mxl）。"""
    tmp = tempfile.mkdtemp(prefix="omr-be-")
    src = _tiny_image(os.path.join(tmp, "in.png"))
    a = os.path.join(tmp, "plain.png")
    b = os.path.join(tmp, "thick.png")
    info = B.prep_image(src, a, scale=2)
    B.prep_image(src, b, scale=2, thicken=True)
    assert info["scale"] == 2.0
    ink_plain = float((np.asarray(Image.open(a)) < 128).mean())
    ink_thick = float((np.asarray(Image.open(b)) < 128).mean())
    assert ink_thick > ink_plain, "加粗就是让墨迹变多"


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

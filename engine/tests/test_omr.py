# -*- coding: utf-8 -*-
"""OMR 回归测试：用合成乐谱图（标准答案已知）钉住整条识别链。
真实扫描件没法进单测，所以 engine/tests/omr_fixture.py 用 PIL 画一张确定的谱子：
4 行谱表 / 2 个系统 / 15 个音符（含 #F、bB、还原 C）。
"""
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import engine_omr as E  # noqa: E402
import omr_fixture  # noqa: E402


class Opts:
    beats = 4
    beat_type = 4
    tempo = 120.0


@pytest.fixture(scope="module")
def recognized():
    tmp = tempfile.mkdtemp(prefix="omr-test-")
    png = os.path.join(tmp, "score.png")
    path, meta = omr_fixture.build(png)
    frames = E.load_frames(path)
    name, gray = frames[0]
    page = E.analyze_page(gray, Opts(), 0)
    notes, _warn = E.assign_pitch_time(page, Opts())
    return {"page": page, "notes": notes, "meta": meta, "tmp": tmp}


def test_staves_and_systems(recognized):
    page = recognized["page"]
    assert len(page["staves"]) == 4, "应识别出 4 行谱表"
    assert len(page["systems"]) == 2, "应识别出 2 个系统"
    assert all(len(s) == 2 for s in page["systems"]), "每个系统应有两行谱表"


def test_clefs(recognized):
    staves = recognized["page"]["staves"]
    assert [s["clef"] for s in staves] == ["treble", "bass", "treble", "bass"], \
        "钢琴谱的上下两行应分别是高音/低音谱号"


def test_barlines(recognized):
    page = recognized["page"]
    meta = recognized["meta"]
    for st in page["staves"]:
        assert len(st["barlines"]) >= 3, "每行谱表至少该找到 3 条小节线，实际 %d" % len(st["barlines"])


def test_note_count(recognized):
    page = recognized["page"]
    expected = len(recognized["meta"]["expect"])
    got = len(page["notes"])
    assert 0.75 * expected <= got <= 1.35 * expected, \
        "识别音符数 %d 与期望 %d 相差过大" % (got, expected)


def test_pitches_and_onsets(recognized):
    notes = recognized["notes"]
    expect = recognized["meta"]["expect"]
    beats = 4.0
    hit = 0
    misses = []
    for (midi, onset, dur, staff_idx) in expect:
        found = None
        for n in notes:
            if n["midi"] != midi:
                continue
            if abs(n["onset"] - onset) <= 0.26:
                found = n
                break
        if found:
            hit += 1
        else:
            misses.append((midi, onset, staff_idx))
    acc = hit / float(len(expect))
    assert acc >= 0.85, "音高/起拍命中率 %.2f 太低，未命中：%s" % (acc, misses)


def test_accidentals(recognized):
    """系统 2 高音谱表的三个音依次带升号 / 降号 / 还原号 —— 分类器必须对得上。"""
    notes = recognized["notes"]
    expect = recognized["meta"]["expect"]
    want_kinds = ["sharp", "flat", "natural"]
    exp = [e for e in expect if e[3] == 2]
    assert len(exp) == 3, "合成谱里系统 2 应有 3 个带变化音的音"
    got = []
    for (midi, onset, _dur, _si), kind in zip(exp, want_kinds):
        hit = [n for n in notes if n["midi"] == midi and abs(n["onset"] - onset) <= 0.26]
        got.append(hit[0]["acc"] if hit else None)
    assert got == want_kinds, "变化音识别结果 %s，期望 %s" % (got, want_kinds)


def test_midi_output(recognized):
    mido = pytest.importorskip("mido")
    out = os.path.join(recognized["tmp"], "out.mid")
    E.write_midi(recognized["notes"], out, Opts())
    mid = mido.MidiFile(out)
    n_on = sum(1 for tr in mid.tracks for m in tr if m.type == "note_on" and m.velocity > 0)
    assert n_on == len(recognized["notes"]), "写出的 MIDI 音符数应与识别结果一致"
    assert mid.ticks_per_beat == 480

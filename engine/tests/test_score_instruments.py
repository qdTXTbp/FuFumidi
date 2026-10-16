# -*- coding: utf-8 -*-
"""乐器名归一 + 移调表的回归测试。

用例全部来自**实测**：Audiveris 装上完整版 OCR 语言包后，对用户那份管弦乐总谱
（桌面\test\1.png）读出来的 part-name 原文，含 OCR 误识。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import score_instruments as S  # noqa: E402


def test_real_ocr_names_match():
    """实测读出来的 19 个乐器名（含误识）都要认对。"""
    cases = {
        "Flute 1,2": ("Flute", 0),
        "Oboe1,2": ("Oboe", 0),
        "Clarinet (135) 1,2": ("Clarinet", -2),      # OCR 把 (Bb) 读成 (135)
        "Bassoon 1,2": ("Bassoon", 0),
        "Ham (F) 1,2 '": ("Horn", -7),               # Ham = Horn
        "Horn (F) 3,4": ("Horn", -7),
        "Trumpet (Bb) 1,2": ("Trumpet", -2),
        "Trumpet (BB) 3": ("Trumpet", -2),
        "Trombone 1.2,3": ("Trombone", 0),
        "Tuba": ("Tuba", 0),
        "Tubular Bells": ("Tubular Bells", 0),
        "Glockenspiel": ("Glockenspiel", 12),        # 实音高八度
        "Piano": ("Piano", 0),
        "SoloViola": ("Viola", 0),
        "Violin I I": ("Violin", 0),
        "Violon Cello": ("Violoncello", 0),
        "Double Bum": ("Double Bass", -12),          # Bum = Bass
    }
    for raw, (name, tr) in cases.items():
        m = S.match(raw)
        assert m, raw + " 应该认得出"
        assert m["name"] == name, "%s → %s（期望 %s）" % (raw, m["name"], name)
        assert m["transpose"] == tr, "%s 移调 %d（期望 %d）" % (raw, m["transpose"], tr)


def test_abbreviations_from_page2():
    """第 2/3 页用的是缩写：Cl. / Bsn. / Hn. / Tpt. / V1n. / Thu. / Timp. / Cr.Cym"""
    cases = {
        "Cl. (Bb) 1,2": ("Clarinet", -2),
        "Bsn. 1,2": ("Bassoon", 0),
        "Hn. (F) 1,2 I": ("Horn", -7),
        "Tpt. (Bb)": ("Trumpet", -2),
        "Tpt. (BB) 3": ("Trumpet", -2),
        "V1n.ll": ("Violin", 0),
        "Thu. 1,2,3": ("Trombone", 0),
        "Timp.": ("Timpani", 0),
        "Cr.Cym": ("Crash Cymbal", 0),
        "Tub. Bells": ("Tubular Bells", 0),
        "Pno.": ("Piano", 0),
        "Hp.": ("Harp", 0),
    }
    for raw, (name, tr) in cases.items():
        m = S.match(raw)
        assert m, raw
        assert (m["name"], m["transpose"]) == (name, tr), "%s → %s" % (raw, m)


def test_violin_not_swallowing_violoncello():
    """长的乐器名要先匹配，否则 violoncello 会被 violin 抢走。"""
    assert S.match("Violoncello")["name"] == "Violoncello"
    assert S.match("Violon Cello")["name"] == "Violoncello"
    assert S.match("Violin I")["name"] == "Violin"


def test_unknown_stays_unknown():
    """认不出就不猜 —— 猜错会把整条声部移调错。"""
    for raw in ["Voice", "Part 12", "声部 7", "", None, "Piano 2"]:
        if raw == "Piano 2":
            assert S.match(raw)["name"] == "Piano"
        else:
            assert S.match(raw) is None, raw


def test_key_tag_only_taken_from_the_tail():
    """调号只能从乐器名片段**后面**取 —— 老实现拿 "flute12" 里的 "e" 当调号。"""
    assert S.match("Flute 1,2")["key"] == ""
    assert S.match("Oboe1,2")["key"] == ""
    assert S.match("Bassoon 1,2")["key"] == ""
    assert S.match("Trombone 1.2,3")["key"] == ""
    assert S.match("Horn (F) 3,4")["key"] == "f"
    assert S.match("Trumpet (BB) 3")["key"] == "bb"
    assert S.match("Clarinet (135) 1,2")["key"] == "135"


def test_variants_do_not_fire_inside_words():
    """"cor" 是 horn 的缩写，但 coranglais / cornet 里的 cor 是词的一部分。

    老实现按子串替换，会把英国管、短号都读成圆号（移调差 5 个半音）。
    """
    assert S.match("Cor anglais")["name"] == "English Horn"
    assert S.match("Coranglais")["name"] == "English Horn"
    assert S.match("Cornet")["name"] == "Cornet"
    assert S.match("Banjo")["name"] == "Banjo"
    assert S.match("Trombone")["name"] == "Trombone"
    assert S.match("Clarinet")["name"] == "Clarinet"


def test_key_fallback_when_ocr_drops_the_key():
    """名字里没写调号时按常见编制补 —— 不补就是「不移调」，对移调乐器必然是错的。"""
    m = S.match("Clarinet 1,2")
    assert (m["name"], m["transpose"], m["key"], m["keyDefault"]) == \
        ("Clarinet", -2, "bb", True)
    assert S.match("Horn")["transpose"] == -7
    assert S.match("Trombone")["transpose"] == 0          # 非移调族不受影响
    assert S.match("Horn (F) 3,4")["keyDefault"] is False  # 谱面写了就用谱面的


def test_display_name_lowercases_the_key():
    """OCR 把 (Bb) 读成 (BB) / (135)，显示名要回到 Bb。"""
    assert S.display_name("Trumpet (BB) 3") == "Trumpet in Bb 3"
    assert S.display_name("Clarinet (135) 1,2") == "Clarinet in Bb 1,2"
    assert S.display_name("Ham (F) 1,2 '") == "Horn in F 1,2"
    assert S.display_name("Voice", "声部 3") == "Voice"


def test_display_name_keeps_the_part_number():
    """两把小提琴都叫 Violin 没法看 —— 编号要留在显示名里。"""
    assert S.display_name("Violin I I") == "Violin I"
    assert S.display_name("Violin II .") == "Violin II"
    assert S.display_name("V1n.ll") == "Violin II"        # OCR 把 II 读成 ll
    assert S.display_name("Vln.ll") == "Violin II"
    assert S.display_name("Hn. (F) 3,4") == "Horn in F 3,4"
    assert S.display_name("Oboe1,2") == "Oboe 1,2"          # 名字和数字连写
    assert S.display_name("SoloViola") == "Solo Viola"
    assert S.display_name("Solo Vla.") == "Solo Viola"
    assert S.display_name("Trombone 1.2,3") == "Trombone 1.2,3"
    assert S.display_name("Pno.") == "Piano"              # 没有编号就别硬加
    assert S.display_name("Glockenspiel") == "Glockenspiel"


def test_all_real_page1_to_page5_names_are_stable():
    """把实测 6 页读出来的全部 part-name（含 Voice 垃圾）跑一遍，认得出的不许变。"""
    expect = {
        "FL1,2": ("Flute", 0), "Ob. 1,2": ("Oboe", 0), "Cl. (BB) 1,2": ("Clarinet", -2),
        "Hn. (F) 1,2 '": ("Horn", -7), "Hn. (F) 3,4": ("Horn", -7),
        "Tub. Bells": ("Tubular Bells", 0), "Glock.": ("Glockenspiel", 12),
        "V1n.II": ("Violin", 0), "Vln.ll": ("Violin", 0), "Vc.": ("Violoncello", 0),
        "D. B.": ("Double Bass", -12), "Pno.": ("Piano", 0), "Hp.": ("Harp", 0),
        "Solo Vla.": ("Viola", 0), "Timp.": ("Timpani", 0), "Tuba": ("Tuba", 0),
    }
    for raw, (name, tr) in expect.items():
        m = S.match(raw)
        assert m, raw
        assert (m["name"], m["transpose"]) == (name, tr), "%s → %s" % (raw, m)
    for junk in ["Voice", "Van]", "vmn", "135", "-", ""]:
        assert S.match(junk) is None, junk + " 不该认出来"


def test_display_and_ascii_name():
    assert S.display_name("Ham (F) 1,2") == "Horn in F 1,2"
    assert S.display_name("Clarinet (135) 1,2") == "Clarinet in Bb 1,2"
    assert S.display_name("Trumpet (BB) 3") == "Trumpet in Bb 3"
    assert S.display_name("Flute 1,2") == "Flute 1,2"
    assert S.display_name("Voice", "声部 1") == "Voice"
    assert S.ascii_name("Ham (F) 1,2") == "Horn in F 1,2"
    assert S.ascii_name("") == "Part"

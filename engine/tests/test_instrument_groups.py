# -*- coding: utf-8 -*-
"""旋律乐器组识别与归并的单测（engine/instrument_groups.py）。

背景：MuScriptor 是多乐器模型，会把同一条旋律在不同段落判成不同乐器，
于是同一段旋律每隔几小节换一次音色（实测《初音ミク-甩葱歌》）。
这里用合成 MIDI 固定住识别与归并的行为，并包含「不该动」的反例。
"""
import os
import sys

import pretty_midi

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import instrument_groups as ig  # noqa: E402


def _melody(inst, pitches, t0=0.0, step=0.5, dur=0.45):
    """往一条轨里放一串**不重叠**的音（单声部旋律线）。"""
    for k, p in enumerate(pitches):
        s = t0 + k * step
        inst.notes.append(pretty_midi.Note(velocity=90, pitch=p, start=s, end=s + dur))


def _chords(inst, t0, count, pitches=(60, 64, 67)):
    """和弦伴奏：同一时刻多个音一起响（自复调高）。"""
    for k in range(count):
        s = t0 + k * 0.5
        for p in pitches:
            inst.notes.append(pretty_midi.Note(velocity=80, pitch=p, start=s, end=s + 0.45))


def _write(tmp_path, tracks):
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    for name, program, drum, fill in tracks:
        inst = pretty_midi.Instrument(program=program, is_drum=drum, name=name)
        fill(inst)
        pm.instruments.append(inst)
    path = os.path.join(str(tmp_path), "t.mid")
    pm.write(path)
    return path


MEL_ORGAN = [64, 65, 67, 69, 67, 65, 64, 62]
MEL_LEAD = [69, 71, 72, 74, 72, 71, 69, 67]
MEL_VOICE = [67, 69, 71, 72, 74, 76, 74, 72, 71, 69]
MEL_BASS = [40, 41, 43, 45, 43, 41, 40, 38]


def test_same_melody_split_into_several_instruments_gets_merged(tmp_path):
    path = _write(tmp_path, [
        ("acoustic piano", 0, False, lambda i: _chords(i, 0.0, 40)),
        ("organ", 16, False, lambda i: _melody(i, MEL_ORGAN, 0.0)),
        ("synth lead", 80, False, lambda i: _melody(i, MEL_LEAD, 4.0)),
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 8.0)),
    ])
    info = ig.detect_melody_group(path)
    assert info["fragments"] == 3, info
    assert info["group"] == "voice", info            # 旋律音区里时长最长的一组获胜
    assert info["program"] == 52
    assert info["should_merge"] is True
    before = sum(r["notes"] for r in ig.analyze(path)[1])
    res = ig.merge_melody(path)
    assert res["merged"] is True
    assert res["moved_notes"] == len(MEL_ORGAN) + len(MEL_LEAD)
    after_rows = ig.analyze(path)[1]
    assert sum(r["notes"] for r in after_rows) == before, "音符一个都不能丢"
    names = [r["name"] for r in after_rows]
    assert "voice" in names and "organ" not in names and "synth lead" not in names
    assert "acoustic piano" in names, "伴奏轨不能被合并"
    assert ig.detect_melody_group(path)["fragments"] == 1


def test_single_melody_is_left_alone(tmp_path):
    path = _write(tmp_path, [
        ("acoustic piano", 0, False, lambda i: _chords(i, 0.0, 24)),
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
    ])
    info = ig.detect_melody_group(path)
    assert info["fragments"] == 1 and info["should_merge"] is False, info
    assert ig.merge_melody(path)["merged"] is False


def test_chordal_accompaniment_is_not_a_melody_candidate(tmp_path):
    path = _write(tmp_path, [
        ("acoustic piano", 0, False, lambda i: _chords(i, 0.0, 60)),
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
    ])
    rows = {r["name"]: r for r in ig.analyze(path)[1]}
    assert rows["acoustic piano"]["polyphony"] > ig.MAX_SELF_POLYPHONY
    assert rows["voice"]["polyphony"] <= ig.MAX_SELF_POLYPHONY
    info = ig.detect_melody_group(path)
    assert info["group"] == "voice" and [c["name"] for c in info["candidates"]] == ["voice"], info


def test_low_register_accompaniment_does_not_take_part(tmp_path):
    path = _write(tmp_path, [
        ("electric bass", 33, False, lambda i: _melody(i, MEL_BASS, 0.0)),
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
    ])
    info = ig.detect_melody_group(path)
    assert [c["name"] for c in info["candidates"]] == ["voice"], info


def test_short_decorative_tracks_are_ignored(tmp_path):
    path = _write(tmp_path, [
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
        ("flutes", 72, False, lambda i: _melody(i, [80, 81], 12.0)),   # 只有 2 个音
    ])
    info = ig.detect_melody_group(path)
    assert info["fragments"] == 1 and info["should_merge"] is False, info

# ---------------------------------------------------------------- 第二遍：主旋律线统一
# 背景：复调轨（吉他/钢琴）既弹伴奏又弹旋律时，第一遍整轨归并盖不住，
# 主旋律仍在两条轨之间每 0.25s 跳一次（实测《甩葱歌》）。这一遍按「音」收口。


def _two_voice_melody(inst, pitches, t0, step=0.5, low=40):
    """「高音旋律 + 低音」两音一簇（同起音），模拟《甩葱歌》吉他轨的写法。"""
    for k, p in enumerate(pitches):
        s = t0 + k * step
        inst.notes.append(pretty_midi.Note(velocity=90, pitch=p, start=s, end=s + 0.45))
        inst.notes.append(pretty_midi.Note(velocity=70, pitch=low, start=s, end=s + 0.45))


def test_unify_lead_moves_skyline_out_of_a_two_voice_track(tmp_path):
    """吉他轨里的旋律音（两音一簇的高音）要收进主导组，低音留在原轨。"""
    path = _write(tmp_path, [
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0, step=0.5, dur=0.45)),
        ("clean electric guitar", 26, False,
         lambda i: _two_voice_melody(i, [79, 81, 83, 79], 1.0)),
    ])
    info = ig.detect_melody_group(path)
    assert info["group"] == "voice", info
    res = ig.unify_lead(path, info=info)
    assert res["unified"] is True, res
    assert res["moved_notes"] == 4 and res["moved_by"] == {"clean electric guitar": 4}, res
    rows = {r["name"]: r for r in ig.analyze(path)[1]}
    assert rows["voice"]["notes"] == len(MEL_VOICE) + 4
    assert rows["clean electric guitar"]["notes"] == 4, "低音伴奏不能跟着搬走"


def test_unify_lead_keeps_chords_intact(tmp_path):
    """同簇 3 个以上音高的和弦织体一律不拆（伴奏不能被搬到旋律轨）。"""
    path = _write(tmp_path, [
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
        ("acoustic piano", 0, False, lambda i: _chords(i, 1.0, 6, pitches=(79, 83, 86))),
    ])
    info = ig.detect_melody_group(path)
    assert info["group"] == "voice", info
    res = ig.unify_lead(path, info=info)
    assert res["unified"] is False and res["reason"] == "single-lead-already", res
    rows = {r["name"]: r for r in ig.analyze(path)[1]}
    assert rows["acoustic piano"]["notes"] == 18, "和弦一个音都不能少"


def test_unify_lead_ignores_notes_outside_the_lead_span(tmp_path):
    """主导组跨度之外（前奏/尾奏）的音色不动 —— 那是另一段音乐，不是「同一条旋律」。"""
    path = _write(tmp_path, [
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0, step=0.5, dur=0.45)),
        ("clean electric guitar", 26, False,
         lambda i: _two_voice_melody(i, [79, 81, 83, 79], 30.0)),
    ])
    info = ig.detect_melody_group(path)
    res = ig.unify_lead(path, info=info)
    assert res["unified"] is False, res
    rows = {r["name"]: r for r in ig.analyze(path)[1]}
    assert rows["clean electric guitar"]["notes"] == 8


def test_unify_lead_drops_duplicate_instead_of_doubling(tmp_path):
    """目标轨已有同音（±30ms、±1 半音）时判为重复音丢掉，不制造齐奏双音。"""
    path = _write(tmp_path, [
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 0.0)),
        ("clean electric guitar", 26, False, lambda i: _two_voice_melody(i, MEL_VOICE[:3], 0.0)),
    ])
    before = sum(r["notes"] for r in ig.analyze(path)[1])
    info = ig.detect_melody_group(path)
    res = ig.unify_lead(path, info=info)
    after = sum(r["notes"] for r in ig.analyze(path)[1])
    assert res.get("dropped_dups") == 3, res
    assert after == before - 3, (before, after)
    rows = {r["name"]: r for r in ig.analyze(path)[1]}
    assert rows["clean electric guitar"]["notes"] == 3, "只留下低音声部"


def test_smart_finish_runs_both_passes(tmp_path):
    """收尾入口：整轨归并 + 主旋律线统一都跑到，并且失败也不抛。"""
    path = _write(tmp_path, [
        ("acoustic piano", 0, False, lambda i: _chords(i, 0.0, 40)),
        ("organ", 16, False, lambda i: _melody(i, MEL_ORGAN, 0.0)),
        ("synth lead", 80, False, lambda i: _melody(i, MEL_LEAD, 4.0)),
        ("voice", 52, False, lambda i: _melody(i, MEL_VOICE, 8.0)),
        ("clean electric guitar", 26, False,
         lambda i: _two_voice_melody(i, [79, 81, 83, 79], 9.0)),
    ])
    logs = []
    res = ig.smart_finish(path, mode="auto", log=lambda m: logs.append(m))
    assert res["merged"] is True, res
    assert res["unified"]["unified"] is True, res
    assert res["unified"]["moved_by"] == {"clean electric guitar": 4}, res
    assert any("主旋律线统一" in m for m in logs), logs
    # 手动锁定乐器组时不干预（模型已经只输出该组）
    assert ig.smart_finish(path, mode="voice") == {"merged": False, "reason": "manual-instruments"}

def test_unify_lead_never_drops_out_of_region_notes(tmp_path):
    """不变量：搬移只改「音符属于哪条轨」，总数只会因为去重而减少。

    实测踩过的坑：区域外的主旋律音曾经被直接丢掉（一次丢了 55 个音），
    单测因为「什么都没搬 → 提前返回、没写文件」而看不出来。这里两者都要发生。
    """
    path = _write(tmp_path, [
        # 主导组唱两句（间隔 8s > PHRASE_GAP，是两个乐句）
        ("voice", 52, False, lambda i: (_melody(i, [72, 74, 76], 0.0), _melody(i, [72, 74, 76], 10.0))),
        # 吉他：一句在主导组的乐句里（该搬），一句离得很远（必须原样留着）
        ("clean electric guitar", 26, False,
         lambda i: (_two_voice_melody(i, [79, 81], 10.5), _two_voice_melody(i, [79, 81], 30.0))),
    ])
    before = sum(r["notes"] for r in ig.analyze(path)[1])
    info = ig.detect_melody_group(path)
    res = ig.unify_lead(path, info=info)
    after = sum(r["notes"] for r in ig.analyze(path)[1])
    assert res["unified"] is True, res
    assert res["moved_notes"] == 2, res                      # 10.5s 那句搬走
    assert res["skipped"]["out_of_region"] == 2, res         # 30s 那句原样留着
    assert after == before - res.get("dropped_dups", 0), (before, after, res)
    rows = {r["name"]: r for r in ig.analyze(path)[1]}
    # 吉他：8 个音 - 被搬走的 2 个高音 = 6（两句的低音声部都留着，30s 那句的高音也留着）
    assert rows["clean electric guitar"]["notes"] == 6, rows["clean electric guitar"]

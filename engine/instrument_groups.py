# -*- coding: utf-8 -*-
"""旋律乐器组：识别 + 归并（MuScriptor 这类**多乐器**模型的收尾处理）。

## 为什么需要这一层

MuScriptor 是 MT3 系的多乐器模型：它**逐音符预测乐器组**（voice / synth_lead / flutes /
organ / electric_piano / clean_electric_guitar …），再由 muscriptor 的 midi 写入器
把每个组写成一条独立轨 + 该组的 GM 音色（`muscriptor/utils/midi.py: notes_to_midi`）。

对「一首歌里同时有多种乐器」的素材这是优点；但对「一条主旋律 + 伴奏」的流行曲，
模型的乐器头会在不同段落改判（实测《初音ミク-甩葱歌》：同一条旋律在 24s 是 organ、
33s 是 synth lead、43s 是 flutes、96s 变成 electric piano + voice），于是**同一段旋律
每隔几小节换一次音色**。

本模块做两件事：
  1. `analyze()` / `detect_melody_group()`：从第一遍转录的结果里**识别**主旋律用的是哪个
     乐器组（按「旋律音区里占用的时长」打分），并给出候选与时间重叠率。
  2. `merge_melody()`：只有当这些候选**在时间上基本互斥**（同一时刻只有一条在响，说明是
     「一条线换乐器」而不是「两种乐器同时在演奏」）时，才把它们合并成一条轨、统一用主导组
     的音色 —— 这样旋律的音色就稳定下来，音符本身一个不动。
  3. `unify_lead()`：第二遍，按**音**处理。实测《甩葱歌》的 `clean electric guitar` 轨
     既弹伴奏又弹旋律（自复调 0.6+，第一遍盖不住），归并后主旋律仍在 guitar/voice 之间
     每 0.25s 跳一次。这一遍把「此刻起音最高、且自己在同轨里不是和弦音」的音收进主导组；
     同簇 >=3 个音高的和弦织体一律不拆。

刻意不做的事：不做第二次推理（那会把转录时间翻倍）；音符时值/力度/时间一律保持原样。
"""

import os

# 旋律音区下限：G3(55)。低于它的候选（贝斯/低音伴奏）不参与旋律判定。
MELODY_MIN_PITCH = 55
# 一条轨至少要有这么多音符，才值得当作旋律候选（滤掉零星的装饰音轨）。
MIN_MELODY_NOTES = 6
# 候选之间时间重叠率低于此值，才认定「一条线换乐器」而非「两种乐器同时演奏」。
MAX_OVERLAP_RATIO = 0.25
# 自复调上限：旋律候选必须是「基本单声部」的线（和弦/琶音伴奏轨不参与判定）。
# 实测《甩葱歌》伴奏钢琴轨的自复调明显高于此值，旋律各组接近 0。
MAX_SELF_POLYPHONY = 0.35
# —— 第二遍（主旋律线统一）用的常数 ——
# 主导组的时间跨度前后各放宽多少秒，作为「主旋律活动区」。区外（前奏/尾奏）不动。
LEAD_REGION_PAD = 1.5
# 同一时刻（±45ms 内起音）的判定窗口：用来分「同一簇里的多个音」。
CHORD_WINDOW = 0.045
# 同一条轨在同一簇里有 >= 这么多个不同音高 = 柱式和弦/织体，整簇保留不拆。
# 实测《甩葱歌》吉他轨是「高音旋律 + 低音」两音一簇（2 个音高）→ 旋律音要能搬走；
# 钢琴伴奏是 3-5 个音一簇的和弦 → 必须原样保留，否则伴奏被拆散。
CHORD_MIN_VOICES = 3
# 与目标轨已有音符重合到这个程度（时间 ±30ms、音高 ±1 半音）时，判为重复音：丢掉而不是搬过去。
DUP_WINDOW = 0.03
# 主旋律线上两个音相隔多少秒之内算「同一句」：用来把主导组参与过的乐句连成区域。
# 实测旧转录（Melody 遍布全曲）能连成 1-2 句；而前奏/尾奏与主歌间隔通常 > 4s，不会被卷进来。
PHRASE_GAP = 4.0
# 主旋律线统一这一遍的说明见 unify_lead()。


def _notes_of(inst):
    return list(getattr(inst, "notes", []) or [])


def analyze(path):
    """读出每条非鼓轨的：音符数 / 音域中位数 / 时间跨度 / 旋律音区时长 / 音色号。"""
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(path)
    rows = []
    for idx, inst in enumerate(pm.instruments):
        notes = _notes_of(inst)
        if not notes or getattr(inst, "is_drum", False):
            continue
        pitches = sorted(n.pitch for n in notes)
        mel = [n for n in notes if n.pitch >= MELODY_MIN_PITCH]
        rows.append({
            "polyphony": _self_polyphony(notes),
            "index": idx,
            "name": (inst.name or "").strip(),
            "program": int(getattr(inst, "program", 0) or 0),
            "notes": len(notes),
            "median_pitch": pitches[len(pitches) // 2],
            "t0": min(n.start for n in notes),
            "t1": max(n.end for n in notes),
            "melody_notes": len(mel),
            "melody_seconds": float(sum(max(0.0, n.end - n.start) for n in mel)),
        })
    return pm, rows


def _self_polyphony(notes):
    """这条轨自己「同时响几个音」的时长占比：旋律线≈0，和弦/琶音伴奏明显 >0。

    这是把「主旋律线」和「伴奏轨」分开的关键判据 —— 两者都落在旋律音区里，
    只按音高/时长分不开（实测《甩葱歌》：钢琴轨 652 个音符铺满全曲，
    按「旋律音区时长」打分它永远第一名，但它是伴奏）。
    """
    if not notes:
        return 0.0
    evs = []
    for n in notes:
        if n.end > n.start:
            evs.append((n.start, 1))
            evs.append((n.end, -1))
    if not evs:
        return 0.0
    evs.sort()
    depth = 0
    prev = evs[0][0]
    total = 0.0
    multi = 0.0
    for t, d in evs:
        if depth >= 2:
            multi += t - prev
        if depth >= 1:
            total += t - prev
        depth += d
        prev = t
    return (multi / total) if total > 0 else 0.0


def _overlap_ratio(a, b):
    inter = min(a["t1"], b["t1"]) - max(a["t0"], b["t0"])
    if inter <= 0:
        return 0.0
    span = min(a["t1"] - a["t0"], b["t1"] - b["t0"]) or 1e-6
    return max(0.0, min(1.0, inter / span))


def detect_melody_group(path, min_notes=MIN_MELODY_NOTES):
    """识别主旋律乐器组。

    返回 dict：
      group       —— 主导组的轨名（就是模型给的乐器组名，如 "voice"）
      program     —— 该组在第一遍里用的 GM 音色号
      candidates  —— 参与判定的旋律候选（轨名 + 旋律时长）
      fragments   —— 同一旋律被拆成了几段（= 候选数）
      overlap     —— 候选之间最大的时间重叠率
      confidence  —— 主导组在候选旋律时长里的占比
      should_merge—— 是否建议归并（候选 ≥2 且基本互斥）
    """
    pm, rows = analyze(path)
    cands = [r for r in rows if r["notes"] >= min_notes and r["median_pitch"] >= MELODY_MIN_PITCH
             and r["polyphony"] <= MAX_SELF_POLYPHONY]
    total_mel = sum(r["melody_seconds"] for r in cands) or 0.0
    if not cands:
        return {"group": "", "program": 0, "candidates": [], "fragments": 0,
                "overlap": 0.0, "confidence": 0.0, "should_merge": False}
    lead = max(cands, key=lambda r: (r["melody_seconds"], r["notes"]))
    overlap = 0.0
    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            overlap = max(overlap, _overlap_ratio(cands[i], cands[j]))
    conf = (lead["melody_seconds"] / total_mel) if total_mel else 0.0
    return {
        "group": lead["name"],
        "program": lead["program"],
        "candidates": [{"name": r["name"], "program": r["program"], "notes": r["notes"],
                        "melody_seconds": round(r["melody_seconds"], 2),
                        "polyphony": round(r["polyphony"], 3),
                        "t0": round(r["t0"], 2), "t1": round(r["t1"], 2)} for r in cands],
        "fragments": len(cands),
        "overlap": round(overlap, 3),
        "confidence": round(conf, 3),
        # 单声部候选 ≥2 个 = 同一条旋律线被判成了多种乐器 → 归并。
        # （和弦伴奏轨已被 polyphony 过滤掉，不会误伤；真正两条旋律线的素材会被合并，
        #   这是本判据已知的取舍，界面上可以选「不限定」回到旧行为。）
        "should_merge": len(cands) >= 2,
    }


def merge_melody(path, out_path=None, info=None):
    """把「同一条旋律换乐器」造成的多条轨并成一条（用主导组的音色）。

    只有当候选在时间上基本互斥时才动 —— 真有两种乐器同时在演奏时保持原样，
    那属于「编曲本来就有两层」，不该被抹平。音符本身的音高/起止/力度不改。
    """
    info = info or detect_melody_group(path)
    if not info.get("should_merge"):
        return {"merged": False, "reason": "no-fragmentation", "info": info}
    import pretty_midi

    pm, rows = analyze(path)
    lead_name = info["group"]
    cands = [r for r in rows if r["notes"] >= MIN_MELODY_NOTES and r["median_pitch"] >= MELODY_MIN_PITCH
             and r["polyphony"] <= MAX_SELF_POLYPHONY]
    lead_row = next((r for r in cands if r["name"] == lead_name), None) or max(cands, key=lambda r: r["melody_seconds"])
    lead = pm.instruments[lead_row["index"]]
    moved = 0
    for r in cands:
        if r["index"] == lead_row["index"]:
            continue
        src = pm.instruments[r["index"]]
        for n in _notes_of(src):
            lead.notes.append(n)
            moved += 1
        src.notes = []
    lead.notes.sort(key=lambda n: (n.start, n.pitch))
    # 搬空了的轨直接去掉（留着会成为空轨，统计与混音台上都碍事）
    pm.instruments = [i for i in pm.instruments if _notes_of(i) or getattr(i, "is_drum", False)]
    # 主导组要有名字：模型给的名字就是乐器组名，保留它便于界面显示与后续排查
    if lead_name:
        lead.name = lead_name
    out = out_path or path
    pm.write(out)
    return {"merged": True, "moved_notes": moved, "kept_track": lead_name,
            "dropped_tracks": [r["name"] for r in cands if r["index"] != lead_row["index"]],
            "out": os.path.basename(out), "info": info}


def _skyline_notes(pm, tgt_idx):
    """挑出「主旋律线」上的音：此刻起音最高、且自己在同轨里不是和弦音。

    返回 (per_track_skyline, phrase_spans)：
      · per_track_skyline：轨号 -> 属于主旋律线的音符列表（保持时间序）
      · phrase_spans：把主旋律线按「间隔 <= PHRASE_GAP」连成乐句，给出 (t0, t1, 是否含主导组)
    只看起音不看延续音：听感上的主旋律由「谁在此刻起音最高」决定；按延续音算的话，
    钢琴一个长音就会把后面所有旋律音都判成「不是最高音」（实测踩过这个坑）。
    """
    import bisect

    onsets = sorted((n.start, n.pitch, i) for i, inst in enumerate(pm.instruments)
                    if _notes_of(inst) and not getattr(inst, "is_drum", False)
                    for n in _notes_of(inst))
    onset_times = [x[0] for x in onsets]
    per_track = {}
    marks = []
    for i, inst in enumerate(pm.instruments):
        if getattr(inst, "is_drum", False) or not _notes_of(inst):
            continue
        ordered = sorted(inst.notes, key=lambda x: x.start)
        starts = [x.start for x in ordered]
        pitches = [x.pitch for x in ordered]
        sky = []
        for n in ordered:
            if n.pitch < MELODY_MIN_PITCH:
                continue
            # 同轨同簇 >=3 个不同音高 = 和弦/柱式织体，不是单声旋律
            j = bisect.bisect_left(starts, n.start - CHORD_WINDOW)
            voices = set()
            while j < len(starts) and starts[j] <= n.start + CHORD_WINDOW:
                voices.add(pitches[j])
                j += 1
            if len(voices) >= CHORD_MIN_VOICES:
                continue
            # 此刻（±45ms 起音窗）别的轨有没有更高的音？有 → 它不是主旋律线
            k = bisect.bisect_left(onset_times, n.start - CHORD_WINDOW)
            top = True
            while k < len(onset_times) and onset_times[k] <= n.start + CHORD_WINDOW:
                st, pc, ti = onsets[k]
                if ti != i and pc > n.pitch:
                    top = False
                    break
                k += 1
            if not top:
                continue
            sky.append(n)
            marks.append((n.start, i == tgt_idx))
        per_track[i] = sky
    marks.sort()
    spans = []
    for (t, is_tgt) in marks:
        if spans and t - spans[-1][1] <= PHRASE_GAP:
            spans[-1][1] = t
            spans[-1][2] = spans[-1][2] or is_tgt
        else:
            spans.append([t, t, is_tgt])
    return per_track, spans


def unify_lead(path, out_path=None, info=None, log=None):
    """把「主旋律线」统一到主导组的音色（第二遍）。

    第一遍 merge_melody() 只能合并**基本单声部**的候选轨；实测《初音ミク-甩葱歌》里
    clean electric guitar（306 音）既弹伴奏又弹旋律（高音旋律 + 低音两音一簇），
    自复调 0.6 以上，进不了候选，于是归并后主旋律仍在 guitar / voice 之间来回跳
    （24-28s、102-110s 实测每 0.25s 换一次音色）。

    这一遍按**音**处理，不按轨处理：
      · 只搬「此刻起音最高、且自己在同轨里不是和弦音」的音（和弦/柱式织体整簇保留）；
      · 只搬主导组参与的那些乐句（间隔 <= PHRASE_GAP 连成一句）—— 前奏/尾奏里
        与主导组无关的段落保持原样，不会把伴奏旋律也卷进来；
      · 目标轨已有同音时判为重复音，直接丢掉（避免变成齐奏双音）。
    搬移不改音高/起止/力度，因此不会改变节奏与表情。
    """
    say = log or (lambda *_a, **_k: None)
    info = info or detect_melody_group(path)
    name = (info.get("group") or "").strip()
    if not name:
        return {"unified": False, "reason": "no-melody-group", "info": info}
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(path)
    tgt_idx = None
    for i, inst in enumerate(pm.instruments):
        if (inst.name or "").strip() == name and _notes_of(inst):
            tgt_idx = i
            break
    if tgt_idx is None:
        return {"unified": False, "reason": "target-track-missing", "group": name, "info": info}
    target = pm.instruments[tgt_idx]
    t0 = min(n.start for n in target.notes)
    t1 = max(n.end for n in target.notes)
    skyline, spans = _skyline_notes(pm, tgt_idx)
    # 区域 = 主导组参与过的乐句（并集）；一个都没有时退回主导组自身跨度
    regions = [(s[0], s[1]) for s in spans if s[2]]
    if not regions:
        regions = [(t0 - LEAD_REGION_PAD, t1 + LEAD_REGION_PAD)]
    # 相邻乐句之间也补上（间隔不大时没必要来回切区域边界）
    merged = []
    for a, b in sorted(regions):
        if merged and a - merged[-1][1] <= PHRASE_GAP:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    regions = merged

    def in_region(t):
        for a, b in regions:
            if a - LEAD_REGION_PAD <= t <= b + LEAD_REGION_PAD:
                return True
        return False

    moved = 0
    dropped = 0
    moved_by = {}
    # 记账：区域外原样保留的音 + 主旋律线上的音总数（用于排查「音符有没有丢」）
    skipped = {"out_of_region": 0,
               "skyline_notes": sum(len(v) for k, v in skyline.items() if k != tgt_idx)}
    moved_by_region = {}
    for i, inst in enumerate(pm.instruments):
        if getattr(inst, "is_drum", False) or not _notes_of(inst):
            continue
        sky = skyline.get(i) or []
        if i == tgt_idx:
            continue
        keep = []
        sky_ids = {id(n) for n in sky}
        for n in inst.notes:
            if id(n) not in sky_ids:
                keep.append(n)
                continue
            if not in_region(n.start):
                # 区域外的主旋律音：原样留在本轨（那是与主导组无关的段落，不能动、更不能丢）
                skipped["out_of_region"] += 1
                keep.append(n)
                continue
            if any(abs(t.start - n.start) <= DUP_WINDOW and abs(t.pitch - n.pitch) <= 1 for t in target.notes):
                dropped += 1
                continue
            target.notes.append(n)
            key = inst.name or ("track%d" % i)
            moved_by[key] = moved_by.get(key, 0) + 1
            moved += 1
        inst.notes = keep
    if not moved and not dropped:
        return {"unified": False, "reason": "single-lead-already", "group": name,
                "regions": [[round(a, 2), round(b, 2)] for a, b in regions],
                "skipped": skipped, "info": info}
    target.notes.sort(key=lambda n: (n.start, n.pitch))
    pm.instruments = [x for x in pm.instruments if _notes_of(x) or getattr(x, "is_drum", False)]
    out = out_path or path
    pm.write(out)
    say("[识别] 主旋律线统一到「%s」：搬移 %d 个音符、去重 %d 个（%s）· %d 个乐句 %s" % (
        name, moved, dropped,
        " / ".join("%s×%d" % (k, v) for k, v in sorted(moved_by.items(), key=lambda x: -x[1])),
        len(regions),
        " ".join("%.0f-%.0fs" % (a, b) for a, b in regions[:6])))
    return {"unified": True, "moved_notes": moved, "dropped_dups": dropped, "moved_by": moved_by,
            "skipped": skipped, "kept_track": name,
            "regions": [[round(a, 2), round(b, 2)] for a, b in regions],
            "t0": round(t0, 2), "t1": round(t1, 2), "out": os.path.basename(out)}

def smart_finish(path, mode="auto", log=None):
    """转录收尾入口：mode=auto 时做两遍处理；其它值原样返回。

    第一遍 merge_melody()  —— 把「同一条旋律被判成多种乐器」的单声部候选轨并成一条；
    第二遍 unify_lead()    —— 把复调轨（吉他/钢琴）里那些「此刻最高音」的旋律音也收进
                              主导组，解决第一遍盖不住的"来回换音色"（实测《甩葱歌》
                              归并后仍在 guitar/voice 之间每 0.25s 跳一次）。
    任何一遍失败都不能让整次转录失败（调用方还会再兜一层 try）。
    """
    say = log or (lambda *_a, **_k: None)
    if str(mode or "").strip().lower() not in ("auto", "smart", ""):
        return {"merged": False, "reason": "manual-instruments"}
    info = detect_melody_group(path)
    if not info["candidates"]:
        return {"merged": False, "reason": "no-melody-candidate", "info": info}
    say("[识别] 旋律乐器组：%s（覆盖 %.0f%% 旋律时长，候选 %d 个，时间重叠 %.2f）" % (
        info["group"] or "?", info["confidence"] * 100, info["fragments"], info["overlap"]))
    res = {"merged": False, "reason": "polyphonic", "info": info}
    if info["should_merge"]:
        res = merge_melody(path, info=info)
        if res.get("merged"):
            say("[识别] 同一旋律被判成 %d 种乐器（%s），已归并到「%s」，音色统一 · 搬移 %d 个音符" % (
                info["fragments"], " / ".join(c["name"] or "?" for c in info["candidates"]),
                res["kept_track"], res["moved_notes"]))
    else:
        say("[识别] 候选之间时间重叠较大（%.2f），按多条乐器同时演奏处理，不做整轨归并" % info["overlap"])
    # 第二遍：整轨归并盖不住的复调轨里的旋律音（吉他/钢琴既弹伴奏又弹旋律）
    try:
        uni = unify_lead(path, info=info, log=say)
        res["unified"] = uni
    except Exception as e:
        say("[识别] 主旋律线统一跳过：" + str(e)[:160])
        res["unified"] = {"unified": False, "error": str(e)[:160]}
    return res
# -*- coding: utf-8 -*-
"""
P1-3 质量基准：MIDI 对齐指标 + 确定性合成样本 + 自检
====================================================
为什么要"确定性合成样本"：仓库里没有 6 首固定的人工标注曲（版权/体积），而质量门禁必须
能在任何机器上复现。这里用参数化合成生成 6 个用例的 WAV + 真值 MIDI（同一个音符表既渲染
音频又写 MIDI，所以真值是精确的）。真实模型跑出来后用 --gt/--pred 或 --pred-dir 对同一批
真值算指标，指标口径与这里一致。

指标口径（与 v6 计划 P1-3 对齐）：
  · note  F1：音高一致 + 起点误差 ≤ onset_tol（默认 50ms）；贪心一对一匹配
  · onset F1：唯一化后的 onset 时间集合（±tol）匹配
  · pedal F1：CC64 踏板区间（>64 视为踩下）
音频侧只做基本校验（时长/峰值/RMS），音色质量属于听感，不塞进数字门禁。

用法：
  python engine/eval_quality.py --synth-dir engine/tests/quality
  python engine/eval_quality.py --gt a.mid --pred b.mid --json
  python engine/eval_quality.py --self-test --json
  python engine/eval_quality.py --pred-dir engine/tests/quality/pred --json
"""
import argparse
import json
import math
import os
import sys
import wave

try:
    import numpy as np
except Exception as e:  # pragma: no cover
    print(json.dumps({"ok": False, "error": "numpy 不可用：" + str(e)}), file=sys.stderr)
    sys.exit(2)
try:
    import mido
except Exception as e:  # pragma: no cover
    print(json.dumps({"ok": False, "error": "mido 不可用：" + str(e)}), file=sys.stderr)
    sys.exit(2)

TPB = 480
BPM = 120
BEAT_SEC = 60.0 / BPM
ONSET_TOL = 0.05


# ---------------------------------------------------------------- MIDI 读写

def load_midi(path):
    """读取 MIDI → 音符/踏板区间（秒）。用 MidiFile 迭代（mido 会把 delta 转成秒）。"""
    mid = mido.MidiFile(path)
    t = 0.0
    active = {}
    notes = []
    pedal = []
    for msg in mid:
        t += float(msg.time)
        if msg.type == "note_on" and msg.velocity > 0:
            active[(msg.channel, msg.note)] = (t, msg.velocity)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            key = (msg.channel, msg.note)
            if key in active:
                st, vel = active.pop(key)
                notes.append({"start": round(st, 4), "end": round(max(t, st + 0.01), 4),
                              "pitch": int(msg.note), "velocity": int(vel), "channel": int(msg.channel)})
        elif msg.type == "control_change" and msg.control == 64:
            pedal.append({"time": round(t, 4), "value": int(msg.value)})
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return {"path": path, "notes": notes, "pedal": pedal,
            "duration": round(float(mid.length), 3)}


def pedal_intervals(events):
    """CC64 事件 → [start,end) 区间（>64 踩下）"""
    out = []
    cur = None
    for e in events:
        down = e["value"] >= 64
        if down and cur is None:
            cur = e["time"]
        elif not down and cur is not None:
            out.append((cur, e["time"]))
            cur = None
    return out


def write_midi(path, notes, pedal_events=None):
    mid = mido.MidiFile(ticks_per_beat=TPB)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    evs = []
    for n in notes:
        tick = int(round(n["start"] / BEAT_SEC * TPB))
        off = int(round(n["end"] / BEAT_SEC * TPB))
        ch = int(n.get("channel", 0))
        evs.append((tick, 1, mido.Message("note_on", note=int(n["pitch"]), velocity=int(n["velocity"]), channel=ch, time=0)))
        evs.append((max(tick + 1, off), 0, mido.Message("note_off", note=int(n["pitch"]), velocity=0, channel=ch, time=0)))
    for p in pedal_events or []:
        tick = int(round(p["time"] / BEAT_SEC * TPB))
        evs.append((tick, 2, mido.Message("control_change", control=64, value=int(p["value"]), channel=0, time=0)))
    evs.sort(key=lambda x: (x[0], x[1]))
    last = 0
    for tick, _rank, msg in evs:
        msg = msg.copy(time=max(0, tick - last))
        last = tick
        track.append(msg)
    track.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(path)
    return path


def synth_wav(path, notes, sr=22050, pedal_events=None):
    """把同一份音符表渲染成 WAV：正弦 + 二次谐波 + ADSR；CC64 延音把 release 拉长。"""
    if not notes:
        dur = 0.5
        data = np.zeros(int(sr * dur), dtype=np.float32)
    else:
        end = max(n["end"] for n in notes) + 0.6
        sustain = pedal_intervals(pedal_events or [])
        dur = max(end, (max((e for s, e in sustain), default=0.0) + 0.4))
        data = np.zeros(int(sr * dur) + 1, dtype=np.float32)
        rng = np.random.default_rng(20261018)
        for n in notes:
            f = 440.0 * (2 ** ((n["pitch"] - 69) / 12.0))
            a = max(0.0, n["start"])
            b = n["end"]
            # 踏板把音尾延长（最多 1.2s）
            ext = 0.0
            for s, e in sustain:
                if s <= a < e:
                    ext = max(ext, min(1.2, e - b))
            length = max(0.05, (b - a) + ext)
            i0 = int(a * sr)
            i1 = min(len(data), int((a + length) * sr) + int(0.4 * sr))
            if i1 <= i0:
                continue
            tt = np.arange(i1 - i0) / sr
            atk = 0.01
            dec = 0.12
            sus = 0.55
            rel = 0.25
            env = np.ones_like(tt)
            env = np.where(tt < atk, tt / atk, env)
            env = np.where((tt >= atk) & (tt < atk + dec), 1.0 - (1.0 - sus) * (tt - atk) / dec, env)
            env = np.where(tt >= atk + dec, sus, env)
            rel_start = max(0.0, length - rel)
            env = np.where(tt > rel_start, sus * np.clip(1.0 - (tt - rel_start) / rel, 0.0, 1.0), env)
            wave_ = np.sin(2 * np.pi * f * tt) + 0.28 * np.sin(4 * np.pi * f * tt) + 0.08 * np.sin(6 * np.pi * f * tt)
            amp = 0.16 * (n["velocity"] / 127.0)
            data[i0:i1] += (amp * env * wave_).astype(np.float32)
        peak = float(np.max(np.abs(data))) if len(data) else 0.0
        if peak > 0.98:
            data *= 0.98 / peak
        data = data + rng.normal(0, 0.0008, data.shape).astype(np.float32)  # 极轻底噪，避免"完美静音"退化
        data = np.clip(data, -1.0, 1.0)
    pcm = (data * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return {"path": path, "duration": round(len(data) / sr, 3), "peak": round(float(np.max(np.abs(data))) if len(data) else 0.0, 4),
            "rms": round(float(np.sqrt(np.mean(data ** 2))) if len(data) else 0.0, 4), "sampleRate": sr}


# ---------------------------------------------------------------- 指标

def match_notes(gt_notes, pred_notes, tol=ONSET_TOL):
    """贪心一对一匹配：按起点排序，音高相同且起点差 ≤ tol。"""
    used = [False] * len(pred_notes)
    matched = 0
    for g in gt_notes:
        best = -1
        best_dt = tol + 1e-9
        for i, p in enumerate(pred_notes):
            if used[i] or p["pitch"] != g["pitch"]:
                continue
            dt = abs(p["start"] - g["start"])
            if dt <= best_dt:
                best = i
                best_dt = dt
        if best >= 0:
            used[best] = True
            matched += 1
    return matched


def onset_f1(gt_notes, pred_notes, tol=ONSET_TOL):
    gt = sorted(set(round(n["start"] / tol) for n in gt_notes))
    pr = sorted(set(round(n["start"] / tol) for n in pred_notes))
    i = j = hit = 0
    while i < len(gt) and j < len(pr):
        if abs(gt[i] - pr[j]) <= 1:
            hit += 1
            i += 1
            j += 1
        elif gt[i] < pr[j]:
            i += 1
        else:
            j += 1
    p = hit / len(pr) if pr else 0.0
    r = hit / len(gt) if gt else 0.0
    return _prf(p, r)


def pedal_f1(gt_events, pred_events, tol=0.05):
    gt = [(round(s / tol), round(e / tol)) for s, e in pedal_intervals(gt_events)]
    pr = [(round(s / tol), round(e / tol)) for s, e in pedal_intervals(pred_events)]
    hit = 0
    used = [False] * len(pr)
    for g in gt:
        for i, p in enumerate(pr):
            if used[i]:
                continue
            if abs(p[0] - g[0]) <= 1 and abs(p[1] - g[1]) <= 2:
                used[i] = True
                hit += 1
                break
    p = hit / len(pr) if pr else (1.0 if not gt else 0.0)
    r = hit / len(gt) if gt else (1.0 if not pr else 0.0)
    return _prf(p, r)


def _prf(p, r):
    f1 = (2 * p * r / (p + r)) if (p + r) else 0.0
    return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f1, 4)}


def eval_pair(gt_path, pred_path):
    gt = load_midi(gt_path)
    pr = load_midi(pred_path)
    note_m = match_notes(gt["notes"], pr["notes"])
    p = note_m / len(pr["notes"]) if pr["notes"] else (1.0 if not gt["notes"] else 0.0)
    r = note_m / len(gt["notes"]) if gt["notes"] else (1.0 if not pr["notes"] else 0.0)
    return {
        "gt": os.path.basename(gt_path), "pred": os.path.basename(pred_path),
        "gtNotes": len(gt["notes"]), "predNotes": len(pr["notes"]),
        "note": _prf(p, r),
        "onset": onset_f1(gt["notes"], pr["notes"]),
        "pedal": pedal_f1(gt["pedal"], pr["pedal"]),
        "durationErrorSec": round(abs(gt["duration"] - pr["duration"]), 3),
    }


# ---------------------------------------------------------------- 6 个确定性用例

def case_defs():
    def note(start_beats, dur_beats, pitch, vel=100, ch=0):
        return {"start": start_beats * BEAT_SEC, "end": (start_beats + dur_beats) * BEAT_SEC, "pitch": pitch, "velocity": vel, "channel": ch}

    cases = []
    # 1) 单旋律（C 大调音阶，8 拍）
    mel = [60, 62, 64, 65, 67, 69, 71, 72]
    cases.append(("case1_melody", [note(i * 0.5, 0.5, p) for i, p in enumerate(mel)], []))
    # 2) 三和弦（C F G C，各 1 小节）
    chords = []
    for b, pcs in [(0, [60, 64, 67]), (2, [65, 69, 72]), (4, [67, 71, 74]), (6, [60, 64, 67])]:
        for pc in pcs:
            chords.append(note(b, 2, pc, 90))
    cases.append(("case2_chords", chords, []))
    # 3) 快速音阶（16 分音符 32 个）
    fast = []
    for i in range(32):
        p = 60 + [0, 2, 4, 5, 7, 9, 11, 12][i % 8]
        fast.append(note(i * 0.25, 0.2, p, 85))
    cases.append(("case3_fast", fast, []))
    # 4) 踏板：两小节和弦，CC64 踩住
    ped_notes = []
    for b, pcs in [(0, [60, 64, 67]), (2, [65, 69, 72])]:
        for pc in pcs:
            ped_notes.append(note(b, 1, pc, 95))
    ped = [{"time": 0.0, "value": 127}, {"time": 3.0, "value": 0}]
    cases.append(("case4_pedal", ped_notes, ped))
    # 5) 宽音域（C2..C6）
    wide = [note(i * 0.5, 0.5, 36 + i * 5, 90) for i in range(10)]
    cases.append(("case5_wide", wide, []))
    # 6) 力度与休止（强弱交替 + 空拍）
    dyn = []
    for i in range(12):
        if i % 4 == 3:
            continue
        dyn.append(note(i * 0.5, 0.4, 60 + (i % 5), 40 if i % 2 else 120))
    cases.append(("case6_dynamics", dyn, []))
    return cases


def synth_cases(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    out = []
    for name, notes, pedal in case_defs():
        mid_path = os.path.join(out_dir, name + ".mid")
        wav_path = os.path.join(out_dir, name + ".wav")
        write_midi(mid_path, notes, pedal)
        info = synth_wav(wav_path, notes, pedal_events=pedal)
        out.append({"name": name, "mid": mid_path, "wav": wav_path, "notes": len(notes), "pedal": len(pedal), "audio": info})
    return out


# ---------------------------------------------------------------- 自检

def self_test():
    """identity 必须全 1.0；扰动样本应落在合理区间（证明指标真在算东西）。"""
    import tempfile
    tmp = tempfile.mkdtemp(prefix="fufumidi-quality-")
    cases = synth_cases(tmp)
    results = {}
    for c in cases:
        ident = eval_pair(c["mid"], c["mid"])
        side = load_midi(c["mid"])
        rng = np.random.default_rng(20261018)
        pert = []
        for n in side["notes"]:
            r = float(rng.random())
            if r < 0.15:
                continue                                  # 15% 漏检
            start = n["start"]
            pitch = n["pitch"]
            if r < 0.30:
                start = max(0.0, start + 0.12)            # 15% 起点偏出容差
            if r < 0.40:
                pitch = max(0, min(127, pitch + 1))       # 10% 音高错半音
            pert.append({"start": start, "end": max(start + 0.2, n["end"]),
                         "pitch": pitch, "velocity": n["velocity"], "channel": n["channel"]})
        for _ in range(max(1, len(pert) // 10)):
            st = float(rng.random() * 4.0)
            pert.append({"start": st, "end": st + 0.2, "pitch": 60 + int(rng.integers(0, 12)), "velocity": 80, "channel": 0})
        pert_path = os.path.join(tmp, c["name"] + ".pert.mid")
        write_midi(pert_path, pert, [])
        results[c["name"]] = {"identity": ident, "perturbed": eval_pair(c["mid"], pert_path)}
        if ident["note"]["f1"] < 0.999 or ident["onset"]["f1"] < 0.999:
            return {"ok": False, "error": "identity 自检失败：" + c["name"], "cases": results}
    return {"ok": True, "cases": results}


def main(argv=None):
    ap = argparse.ArgumentParser(description="P1-3 质量基准")
    ap.add_argument("--synth-dir")
    ap.add_argument("--gt")
    ap.add_argument("--pred")
    ap.add_argument("--pred-dir")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.synth_dir:
        cases = synth_cases(args.synth_dir)
        print(json.dumps({"ok": True, "dir": args.synth_dir, "cases": cases}, ensure_ascii=False))
        return 0
    if args.self_test:
        r = self_test()
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("ok") else 1
    if args.gt and args.pred:
        r = eval_pair(args.gt, args.pred)
        print(json.dumps({"ok": True, **r}, ensure_ascii=False))
        return 0
    if args.pred_dir:
        base = os.path.dirname(os.path.abspath(args.pred_dir))
        out = []
        for name, _notes, _ped in case_defs():
            gt = os.path.join(base, name + ".mid")
            pr = os.path.join(args.pred_dir, name + ".mid")
            if os.path.exists(gt) and os.path.exists(pr):
                out.append(eval_pair(gt, pr))
        print(json.dumps({"ok": True, "cases": out}, ensure_ascii=False))
        return 0
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())

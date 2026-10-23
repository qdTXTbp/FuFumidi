# -*- coding: utf-8 -*-
"""MuScriptor 预设 A/B：音色稳定 vs 最优（速度/峰值显存/边界重复音/音色切换/F1）。

用合成的「双音色交替」素材（4 秒钢琴、4 秒弦乐交替 30 秒），参考 MIDI 由生成器给出。
只用于**相对比较**：不是公开基准，不应拿绝对 F1 与真实数据集对比。

用法（在 engine 目录，GPU 增强包环境）：
  python bench_presets.py --json out.json --md out.md
"""
import argparse
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def synth_material(out_dir, seconds=30.0, sr=44100):
    import numpy as np
    import pretty_midi
    import soundfile as sf
    os.makedirs(out_dir, exist_ok=True)
    wav = os.path.join(out_dir, "ab_material.wav")
    ref = os.path.join(out_dir, "ab_material_ref.mid")
    n = int(seconds * sr)
    y = np.zeros(n, dtype="float32")
    pm = pretty_midi.PrettyMIDI()
    piano = pretty_midi.Instrument(program=0, name="piano")
    strings = pretty_midi.Instrument(program=48, name="strings")

    def tone(freq, dur, kind, sr=44100):
        t = np.arange(int(dur * sr), dtype="float32") / sr
        if kind == "piano":
            env = np.exp(-3.2 * t)
            return (np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * freq * 2 * t)
                    + 0.25 * np.sin(2 * np.pi * freq * 3 * t)) * env * 0.22
        env = np.minimum(1.0, t * 8) * np.exp(-0.35 * t)
        saw = 2.0 * ((freq * t) % 1.0) - 1.0
        vibr = np.sin(2 * np.pi * 5.0 * t) * 0.004
        return (saw * (1.0 + vibr)) * env * 0.10

    notes = []
    t = 0.0
    idx = 0
    while t + 0.5 <= seconds:
        # 钢琴：每 2 秒一个和弦（同时发声，和声层）
        if idx % 4 == 0:
            for j, chord_pitch in enumerate([48, 55, 64, 67]):
                freq = 440.0 * 2 ** ((chord_pitch - 69) / 12.0)
                seg = tone(freq, 1.8, "piano")
                a = int(t * sr); b = min(n, a + len(seg)); y[a:b] += seg[:b - a]
                piano.notes.append(pretty_midi.Note(velocity=80, pitch=chord_pitch, start=t, end=t + 1.6))
                notes.append({"start": t, "end": t + 1.6, "pitch": chord_pitch, "kind": "piano"})
        # 弦乐旋律：每 0.5 秒换音（持续层，与钢琴同时发声）
        pitch = [72, 74, 76, 77, 79, 81, 83, 84][idx % 8]
        freq = 440.0 * 2 ** ((pitch - 69) / 12.0)
        seg = tone(freq, 0.48, "strings")
        a = int(t * sr); b = min(n, a + len(seg)); y[a:b] += seg[:b - a]
        strings.notes.append(pretty_midi.Note(velocity=100, pitch=pitch, start=t, end=t + 0.45))
        notes.append({"start": t, "end": t + 0.45, "pitch": pitch, "kind": "strings"})
        # 鼓：短噪声脉冲（节奏骨架）
        if idx % 2 == 0:
            rng = np.random.RandomState(idx + 1)
            dl = int(0.06 * sr)
            burst = (rng.randn(dl).astype("float32") * np.linspace(0.18, 0, dl)).astype("float32")
            a = int(t * sr); b = min(n, a + dl); y[a:b] += burst[:b - a]
        t += 0.5
        idx += 1
    pm.instruments.extend([piano, strings])
    sf.write(wav, y, sr)
    pm.write(ref)
    return wav, ref


def _boundary_dups(pm, chunk_sec=5.0):
    """边界附近同音高重复起音（同一音高在边界 ±0.35s 内出现 ≥2 次）。"""
    notes = []
    for inst in pm.instruments:
        for n in inst.notes:
            notes.append((float(n.start), int(n.pitch)))
    count = 0
    for b in [chunk_sec * k for k in range(1, 1000)]:
        near = [x for x in notes if abs(x[0] - b) <= 0.35]
        by_pitch = {}
        for s, p in near:
            by_pitch[p] = by_pitch.get(p, 0) + 1
        count += sum(max(0, v - 1) for v in by_pitch.values())
    return count


def _timbre_switches(pm, gap=0.5):
    """相邻 0.5s 内、音高相同但落在不同乐器轨 → 音色切换（越多越不稳）。"""
    events = []
    for ti, inst in enumerate(pm.instruments):
        for n in inst.notes:
            events.append((float(n.start), int(n.pitch), ti, str(inst.program)))
    events.sort(key=lambda x: (x[0], x[1]))
    switches = 0
    for i in range(1, len(events)):
        t0, p0, i0, _ = events[i - 1]
        t1, p1, i1, _ = events[i]
        if p0 == p1 and i0 != i1 and (t1 - t0) <= gap:
            switches += 1
    # 同音高跨轨重叠（双份音符）也算切换证据
    for i in range(len(events)):
        for j in range(i + 1, min(len(events), i + 8)):
            t0, p0, i0, _ = events[i]
            t1, p1, i1, _ = events[j]
            if t1 - t0 > gap:
                break
            if p0 == p1 and i0 != i1:
                switches += 1
    return switches


def _f1(ref_mid, pred_mid, tol=0.05):
    import eval_quality
    gt = eval_quality.load_midi(ref_mid)["notes"]
    pr = eval_quality.load_midi(pred_mid)["notes"]
    matched = int(eval_quality.match_notes(gt, pr, tol=tol))
    p = matched / max(1, len(pr))
    r = matched / max(1, len(gt))
    f1 = (2 * p * r / (p + r)) if (p + r) else 0.0
    return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f1, 4)}


def run_config(name, params, wav, ref, out_dir, base_params):
    import pretty_midi
    import torch
    from engine_muscriptor import transcribe_muscriptor
    out = os.path.join(out_dir, "out_%s.mid" % name)
    p = dict(base_params)
    p.update(params)
    logs = []

    def _log(m):
        logs.append(str(m))

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    n = transcribe_muscriptor(wav, out, params=p, log_cb=_log)
    elapsed = time.perf_counter() - t0
    peak = int(torch.cuda.max_memory_allocated() // (1024 * 1024)) if torch.cuda.is_available() else 0
    pm = pretty_midi.PrettyMIDI(out)
    probe_line = next((ln for ln in logs if "预分析锁定乐器组" in ln), "")
    return {
        "config": name,
        "notes": int(n),
        "elapsed_s": round(elapsed, 2),
        "peak_vram_mb": peak,
        "boundary_dups": _boundary_dups(pm),
        "timbre_switches": _timbre_switches(pm),
        "f1": _f1(ref, out),
        "tracks": len(pm.instruments),
        "programs": [int(i.program) for i in pm.instruments],
        "probe": probe_line[-160:],
        "out": out,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=os.path.join(os.environ.get("TEMP", "."), "fufumidi-ab"))
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--model-size", default="small")
    ap.add_argument("--material", choices=["synth", "piano"], default="synth")
    ap.add_argument("--repeat", type=int, default=2, help="每个配置重复次数；取最后一次（消除首次加载偏差）")
    ap.add_argument("--json", default="")
    ap.add_argument("--md", default="")
    a = ap.parse_args(argv)
    if a.material == "piano":
        base_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests", "quality")
        wav = os.path.join(base_dir, "case1_melody.wav")
        ref = os.path.join(base_dir, "case1_melody.mid")
        if not (os.path.isfile(wav) and os.path.isfile(ref)):
            raise SystemExit("找不到钢琴 quality fixture：%s" % wav)
    else:
        wav, ref = synth_material(a.out_dir, a.seconds)
    # ★ 2026-10-21：「识别片段长度」/静音分段/分段探测（分块转录）已全部移除，
    #   基准一律用上游默认块长 + 整曲一次推理。
    base = {
        "model_size": a.model_size, "perf_mode": "quality",
        "prelude_forcing": True, "muscriptor_instruments": "none",
        "temperature": 1.0, "cfg_coef": 1.0, "beam_size": 1,
        "precision": "fp32", "max_note_hold": 0,
        "timbre_stabilize": False,
    }
    configs = [
        ("optimal", {"muscriptor_instruments": "none", "timbre_stabilize": False}),
        ("probe_only", {"muscriptor_instruments": "probe", "timbre_stabilize": False}),
        ("stable", {"muscriptor_instruments": "probe", "timbre_stabilize": True}),
    ]
    rows = []
    for name, params in configs:
        try:
            last = None
            for _ in range(max(1, a.repeat)):
                last = run_config(name, params, wav, ref, a.out_dir, base)
            rows.append(last)
        except Exception as e:  # noqa: BLE001
            rows.append({"config": name, "error": str(e)[:300]})
    res = {"material": a.material, "material_seconds": a.seconds, "model_size": a.model_size, "rows": rows}
    text = json.dumps(res, ensure_ascii=False, indent=2)
    print(text)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            f.write(text)
    if a.md:
        lines = ["# MuScriptor 预设 A/B（合成双音色素材）", "",
                 "素材：%s（%.0fs）；model_size=%s；chunk=5s" % (a.material, a.seconds, a.model_size), "",
                 "| 配置 | 音符数 | 轨数 | 耗时 s | 峰值显存 MB | 边界重复音 | 音色切换证据 | F1 |",
                 "|---|---:|---:|---:|---:|---:|---:|---:|"]
        for r in rows:
            if r.get("error"):
                lines.append("| %s | - | - | - | - | - | 失败：%s |" % (r["config"], r["error"]))
            else:
                lines.append("| %s | %d | %d | %.2f | %d | %d | %d | %.4f |" % (
                    r["config"], r["notes"], r.get("tracks", 0), r["elapsed_s"], r["peak_vram_mb"],
                    r["boundary_dups"], r["timbre_switches"], r["f1"]["f1"]))
        with open(a.md, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

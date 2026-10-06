# -*- coding: utf-8 -*-
"""乐器组探测：让模型先粗听几段，看它会把这首歌判成哪些乐器 —— **独立分析工具**。

## 它做什么

挑几段有代表性的音频各做一次短推理（默认 3 段 × 20s），按**音符数**统计模型实际用到的乐器组，
给出"这首歌主要有哪些乐器 + 各占多少"的结论。用法：

    python instrument_probe.py 歌曲.flac --json

用途是**排查与调参**：转录结果里出现了奇怪乐器时，先用它看看模型到底听到了什么；
也用来对照「限定乐器组」该勾哪几组。

## 它不做什么（重要）

它**不再**参与转录流水线。曾经有一档「自动识别」= 转录前跑这个探测、把结果作为整曲硬约束；
实测收益只有"剪掉长尾杂音"（长笛/圆号/萨克斯那种为几个音冒出来的轨），
而"同一段旋律隔几秒换一次音色"的真正原因是分块边界的 prelude_forcing
（批量推理会关掉它，详见 engine_muscriptor.py 的说明）—— 预分析救不了那个问题，
所以那一档已从界面移除，本模块改成独立工具保留。
"""

import json
import os

PROBE_WINDOW = 20.0        # 每段探测时长（秒）
PROBE_COUNT = 3            # 探测段数（前 / 中 / 后各一段）
MIN_SHARE = 0.05           # 组时长占比低于此值 → 视为长尾丢掉
MAX_GROUPS = 8             # 最多锁定几组
ALWAYS_KEEP = ("drums",)   # 探测到就保留：鼓是节奏骨架，丢了整首歌会散


def _frame_rms(y, sr, win=1.0, hop=0.5):
    """逐帧 RMS（只用 numpy，不引 librosa —— 这段代码在打包环境里也要稳）。"""
    import numpy as np

    w = max(1, int(win * sr))
    h = max(1, int(hop * sr))
    if len(y) <= w:
        return np.array([float(np.sqrt(np.mean(np.square(y))) if len(y) else 0.0)]), 0.0
    frames = 1 + (len(y) - w) // h
    out = np.empty(frames, dtype="float32")
    for i in range(frames):
        seg = y[i * h: i * h + w]
        out[i] = float(np.sqrt(np.mean(np.square(seg)))) if len(seg) else 0.0
    return out, hop


def pick_windows(y, sr, count=PROBE_COUNT, win=PROBE_WINDOW):
    """挑 count 段"最有内容"的窗：把整曲按时长均分成 count 段，各取 RMS 最高的一窗。

    这样前奏/主歌/副歌都会被覆盖到，又不会三段全落在同一处；纯静音段自然被跳过。
    返回 [(start_sec, end_sec), ...]（按时间排序，互不重叠）。
    """
    import numpy as np

    dur = len(y) / float(sr)
    if dur <= win * 1.2:
        return [(0.0, dur)]
    rms, hop = _frame_rms(y, sr)
    win_frames = max(1, int(round(win / hop)))
    if len(rms) <= win_frames:
        return [(0.0, min(dur, win))]
    # 积分图 → O(1) 求任意窗的平均能量
    csum = np.concatenate([[0.0], np.cumsum(rms.astype("float64"))])
    # 太安静的窗不选：低于整体 95 分位能量的 10% 直接跳过
    # （否则前奏留白、纯静音段也会被当成"代表段"，白花推理时间还误导乐器组判定）
    thr = 0.1 * float(np.percentile(rms, 95) or 0.0)
    seg_len = dur / float(count)
    picks = []
    for k in range(count):
        t0 = k * seg_len
        t1 = min(dur, (k + 1) * seg_len)
        i0 = max(0, int(t0 / hop))
        i1 = min(len(rms) - win_frames, int(t1 / hop) - win_frames)
        if i1 < i0:
            continue
        best, best_score = i0, -1.0
        for i in range(i0, i1 + 1):
            score = (csum[i + win_frames] - csum[i]) / win_frames
            if score > best_score:
                best, best_score = i, score
        if best_score < thr:
            continue
        s = best * hop
        picks.append((float(s), float(min(dur, s + win))))
    if picks:
        return picks
    # 全曲都很安静（或阈值定得太高）→ 退回整段，别把自己选空
    return [(0.0, min(dur, win))]


def parse_mode(raw):
    """把界面/CLI 的取值解析成 (mode, groups)：

      None / '' / 'none' / 'off' / 'free' / '-' → ('none', [])   不限定：不预分析、不约束（默认）
      "voice,drums"                             → ('limit', ['voice', 'drums'])  手动硬约束

    'auto'/'smart' 是**已退役**的取值（曾经是"转录前预分析再锁定"那一档，界面已去掉）：
    这里按"不限定"处理，免得老预设或脚本拿它当组名，被 forbidden_token_ids 当成非法乐器报错。
    """
    if isinstance(raw, (list, tuple)):
        groups = [str(x).strip() for x in raw if str(x).strip()]
    else:
        groups = [s.strip() for s in str(raw or "").split(",") if s.strip()]
    if not groups:
        return ("none", [])
    if len(groups) == 1 and groups[0].lower() in ("auto", "smart", "none", "off", "free", "-"):
        return ("none", [])
    return ("limit", groups)


def aggregate(events):
    """把一段事件流按乐器组汇总。返回 (notes, seconds)：音符数 与 发声总时长。

    音符数才是"这个组参与了多少"的稳健度量；只用发声时长会让长音贝斯/铺底压过旋律
    （实测《甩葱歌》：按时长算出 electric_bass 44% 而人声为 0%，明显不对）。
    """
    open_notes = {}
    notes = {}
    seconds = {}
    for ev in events:
        inst = getattr(ev, "instrument", None)
        if inst is not None and hasattr(ev, "index"):        # NoteStartEvent
            open_notes[ev.index] = (inst, float(ev.start_time))
            notes[inst] = notes.get(inst, 0) + 1
        elif hasattr(ev, "start_event"):                     # NoteEndEvent
            se = ev.start_event
            inst = getattr(se, "instrument", None) or open_notes.get(se.index, (None, 0))[0]
            t0 = open_notes.get(se.index, (None, float(se.start_time)))[1]
            if inst:
                seconds[inst] = seconds.get(inst, 0.0) + max(0.0, float(ev.end_time) - t0)
            open_notes.pop(se.index, None)
    return notes, {k: round(v, 2) for k, v in seconds.items()}


def select_groups(per_window, min_notes=4, min_share=0.03, max_groups=MAX_GROUPS):
    """从"每段的组→音符数"里挑出该锁定的组。

    规则（偏保守：宁可多留一组，也不要把这首歌真的有的乐器挡在门外）：
      · 跨段累计音符数 >= max(min_notes, min_share × 总音符数) → 留下；
      · 鼓只要出现过就留下（节奏骨架）；
      · 最多 max_groups 组，按累计音符数排序。
    """
    total = {}
    for win in per_window:
        for k, v in (win or {}).items():
            total[k] = total.get(k, 0) + v
    all_notes = sum(total.values()) or 0
    if not all_notes:
        return [], {}
    thr = max(min_notes, min_share * all_notes)
    keep = [k for k, v in sorted(total.items(), key=lambda x: -x[1]) if v >= thr]
    for k in ALWAYS_KEEP:
        if k in total and k not in keep:
            keep.append(k)
    keep = sorted(keep, key=lambda k: -total[k])[:max_groups]
    return keep, {k: total[k] for k in sorted(total, key=lambda x: -total[x])}

def probe(model, wav_path, log=None, count=PROBE_COUNT, win=PROBE_WINDOW,
          min_notes=4, min_share=0.03, max_groups=MAX_GROUPS):
    """对 wav_path 的 count 段代表性子样本跑短推理，返回该锁定的乐器组。

    model 只需实现 transcribe(音频路径) → 事件流（MuScriptor 的 TranscriptionModel 就是）。
    每段写成临时 wav 再交给模型，避免自己碰 torch 的采样率/张量约定。
    失败一律返回 {"groups": [], "reason": ...} —— 预分析绝不能拖垮整次转录。
    """
    say = log or (lambda *_a, **_k: None)
    import shutil
    import tempfile

    tmpdir = None
    try:
        import soundfile as sf

        y, sr = sf.read(wav_path, always_2d=True)
        mono = y.mean(axis=1).astype("float32")
        if mono.size == 0:
            return {"groups": [], "reason": "empty-audio"}
        wins = pick_windows(mono, sr, count=count, win=win)
        tmpdir = tempfile.mkdtemp(prefix="fuprobe_")
        per_window, used = [], []
        for i, (a, b) in enumerate(wins):
            seg = mono[int(a * sr): int(b * sr)]
            if seg.size < sr // 2:
                continue
            seg_path = os.path.join(tmpdir, "probe%02d.wav" % i)
            sf.write(seg_path, seg, sr)
            notes, _seconds = aggregate(list(model.transcribe(seg_path)))
            per_window.append(notes)
            used.append([round(a, 1), round(b, 1)])
            say("[预分析] 第 %d 段 %.0f-%.0fs：%s" % (
                i + 1, a, b,
                " / ".join("%s %d音" % (k, v) for k, v in sorted(notes.items(), key=lambda x: -x[1])[:6]) or "（无）"))
        keep, total = select_groups(per_window, min_notes=min_notes, min_share=min_share, max_groups=max_groups)
        if not keep:
            return {"groups": [], "reason": "nothing-detected", "windows": used}
        all_notes = sum(total.values()) or 1
        out = {"groups": keep,
               "share_by_notes": {k: round(total[k] / all_notes, 4) for k in keep},
               "notes": total,
               "windows": used}
        say("[预分析] 3 段合计 %d 音：" % all_notes
            + " / ".join("%s %d音(%.0f%%)" % (k, total[k], total[k] / all_notes * 100) for k in keep))
        say("[预分析] 锁定乐器组：" + " / ".join(keep))
        return out
    except Exception as e:
        return {"groups": [], "reason": str(e)[:200]}
    finally:
        if tmpdir:
            try:
                shutil.rmtree(tmpdir, ignore_errors=True)
            except Exception:
                pass

def _cli():
    """独立运行：python instrument_probe.py 歌曲.flac [--model muscriptor --model-size medium]

    给"先看看这首歌会被判成什么乐器"用，也方便调规则（不必跑整曲转录）。
    """
    import argparse

    ap = argparse.ArgumentParser(description="转录前的乐器组预分析（独立运行）")
    ap.add_argument("audio")
    ap.add_argument("--model", default="muscriptor")
    ap.add_argument("--model-size", default="medium")
    ap.add_argument("--count", type=int, default=PROBE_COUNT)
    ap.add_argument("--window", type=float, default=PROBE_WINDOW)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    from audio_io import decode_to_wav, remove_temp
    from muscriptor.transcription_model import TranscriptionModel

    wav = decode_to_wav(a.audio)
    try:
        load_arg = a.model_size if str(a.model).lower() == "muscriptor" else a.model
        model = TranscriptionModel.load_model(load_arg)
        res = probe(model, wav, log=lambda m: print(m, flush=True), count=a.count, win=a.window)
        if a.json:
            print(json.dumps(res, ensure_ascii=False))
    finally:
        remove_temp(wav)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
# -*- coding: utf-8 -*-
"""转录前的**乐器组预分析**：让模型先粗听几段，再决定整曲锁定哪些乐器组。

## 为什么需要它

MuScriptor 是 MT3 系的多乐器模型，逐音符判定乐器组。整曲自由判定时，它的乐器头会在同一首歌里
改判（实测《初音ミク-甩葱歌》：同一条旋律 24s→organ、33s→synth lead、43s→flutes、96s→voice），
于是同一段旋律每隔几小节换一次音色；而"完全不限定"和"自动识别"如果都不约束模型，结果自然一样。

手工用 DSP 特征猜"这首歌有哪些乐器"既不准也难维护（音色分类器与模型的 35 个组并不对齐）。
这里换成**两段式推理**：先挑几段有代表性的音频各做一次短推理（默认 3 段 × 20s），
统计模型**自己**实际用到的乐器组和时长占比，再把占比够大的那几组作为**硬约束**喂给整曲转录。

代价约等于 K 段 × 20s 的推理（整曲的 20~30%）；收益是整曲只在"这首歌真的有的乐器"里选，
长尾组（竖琴/大管/定音鼓/管弦齐奏…）被排除，不会为了一两个音换一次音色。
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
    """把界面的取值解析成 (mode, groups)：

      None / '' / 'auto' / 'smart' → ('auto', [])   先预分析再锁定（默认）
      'none' / 'off' / 'free' / '-' → ('none', [])  完全不干预：不预分析、不约束（模型自由判定）
      "voice,drums"               → ('limit', ['voice', 'drums'])  手动硬约束

    历史坑：界面「不限定」以前是**不发这个字段**，引擎又把"没给"当成 auto，
    于是"不限定"和"自动识别"跑出来一模一样。现在不限定用显式哨兵值 none。
    """
    if isinstance(raw, (list, tuple)):
        groups = [str(x).strip() for x in raw if str(x).strip()]
    else:
        groups = [s.strip() for s in str(raw or "").split(",") if s.strip()]
    if not groups:
        return ("auto", [])
    if len(groups) == 1 and groups[0].lower() in ("auto", "smart"):
        return ("auto", [])
    if len(groups) == 1 and groups[0].lower() in ("none", "off", "free", "-"):
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
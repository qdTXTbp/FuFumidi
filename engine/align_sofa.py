# -*- coding: utf-8 -*-
"""字级对齐（P1-5 咬字与歌词对齐）

背景：翻唱路线 A+ 是「原唱这句当参考音 → GPT-SoVITS 重合成」，合成出来的是**整句**音频。
要判断"每个字唱到了没有、有没有丢字/糊字"，需要把句子切成字级时间片。

## 为什么默认走"能量谷底 + 比例先验"，而不是 MFA/FunASR

* MFA / FunASR 需要额外模型（数百 MB~GB）与对齐词典，**不适合随包分发**，也不该让
  普通用户为了"看看有没有丢字"去装一套强制对齐器；
* 中文流行唱法每个字通常有明显的起音/能量谷，配合"字数比例先验"已经能得到
  足够用的字边界（验收口径是**中位误差 <30ms**，不是做音素级标注）；
* 以后接 FunASR/MFA：只要实现 align_funasr()/align_mfa() 并返回同一结构，上层无需改。

## 输出结构

    {
      "text": "你好世界",
      "units": ["你","好","世","界"],
      "chars": [{"text":"你","start":0.0,"end":0.23}, ...],
      "retention": 1.0,          # 0~1，<0.95 视为有丢字
      "medianMs": 230.0,         # 每字时长中位数（毫秒）
      "absorbed": 0,             # 被相邻字吞掉的字数（估算）
      "hopMs": 10.0
    }

用法（库）::

    import align_sofa
    r = align_sofa.align_signal(y, sr, "你好，世界！")

CLI::

    python engine/align_sofa.py --in line_001.wav --text "你好，世界" --out align.json
"""
import argparse
import json
import os
import sys

import numpy as np

#: 单字最短时长（秒）：短于它基本是"没唱出来/被吞了"
MIN_CHAR_SEC = 0.055
#: 一个字时长超过中位数的这个倍数，视为吞字（相邻字被并进来）
ABSORB_FACTOR = 2.2
#: 能量分析帧移（毫秒）
HOP_MS = 10.0
#: 边界在"按比例位置"附近搜索的范围（占整句比例）
SEARCH_RATIO = 0.18
#: 标点与空白不算字
_PUNCT = set("，。！？、；：…—·,.!?;:\"'()（）[]【】<>《》「」『』~～ \t\r\n-—_/\\|")

def clean_units(text: str):
    """把文本切成"字级单元"：中文按字，连续拉丁字母/数字按整词算一个单元。"""
    out, buf = [], []
    for ch in str(text or ""):
        if ch in _PUNCT:
            if buf:
                out.append("".join(buf))
                buf = []
            continue
        if ch.isascii() and (ch.isalnum() or ch in "_'"):
            buf.append(ch)
        else:
            if buf:
                out.append("".join(buf))
                buf = []
            out.append(ch)
    if buf:
        out.append("".join(buf))
    return [u for u in out if u]

def rms_envelope(y, sr: int, hop_ms: float = HOP_MS):
    """按 hop_ms 分帧的 RMS 能量（float32，长度 = ceil(len/hop)）。"""
    hop = max(1, int(round(sr * hop_ms / 1000.0)))
    n = int(len(y) // hop)
    if n <= 0:
        return np.zeros(1, dtype=np.float32), hop
    frames = np.asarray(y[: n * hop], dtype=np.float32).reshape(n, hop)
    env = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    return env, hop

def _valley_near(env, nominal: int, lo: int, hi: int, used) -> int:
    """在 [lo,hi) 里找"静音谷"的**右沿**（=下一个字的起点）。避开已用边界附近 1 帧。

    只取最低帧会在长静音里落到谷中间，字边界平均偏早约半个静音长度（实测 80~100ms）；
    取静音段的最后一帧再 +1，边界正好落在下一个起音处。
    """
    lo = max(1, int(lo))
    hi = min(len(env) - 1, int(hi))
    if hi <= lo:
        return max(1, min(len(env) - 1, int(nominal)))
    cutoff = max(float(env.max()) * 0.15, 1e-4)
    cand = None
    for i in range(lo, hi):
        if any(abs(i - u) <= 1 for u in used):
            continue
        if cand is None or env[i] < env[cand]:
            cand = i
    if cand is None:
        return max(1, min(len(env) - 1, int(nominal)))
    # 静音谷右沿：在 cand 之后连续低于阈值的最远帧 +1
    j = cand
    while j + 1 < len(env) - 1 and env[j + 1] < cutoff:
        j += 1
    return min(len(env) - 1, j + 1)

def _count_onsets(env, hop_ms: float, min_gap_ms: float = 70.0):
    """能量起音计数（用于丢字检测）：平滑 → 阈值上升沿 → 最小间隔去抖。

    注意：这是**启发式**，连音/气声可能低估；所以它只作为 retention 的另一个上限
    （min(时长保留率, 起音覆盖率)），并在结果里单独给出 onsetRatio 供 UI 解释。
    """
    e = np.asarray(env, dtype=np.float32)
    if e.size < 3:
        return 0
    k = np.array([0.25, 0.5, 0.25], dtype=np.float32)
    sm = np.convolve(e, k, mode="same")
    thr = max(float(sm.max()) * 0.22, 1e-4)
    min_gap = max(1, int(round(min_gap_ms / max(1.0, hop_ms))))
    count, last = 0, -10 ** 9
    # 句首即起音：第一帧就在阈值上要计入（否则每句都少一个 onset）
    if float(sm[0]) >= thr:
        count = 1
        last = 0
    for i in range(1, len(sm)):
        if sm[i] >= thr and sm[i - 1] < thr and (i - last) >= min_gap:
            count += 1
            last = i
    return count

def align_signal(y, sr: int, text: str, hop_ms: float = HOP_MS):
    """把整句音频按字数切分（能量谷底 + 比例先验）。返回字级时间片与保留率。"""
    units = clean_units(text)
    y = np.asarray(y, dtype=np.float32)
    dur = float(len(y)) / float(sr or 1)
    if not units or dur <= 0:
        return {"text": str(text or ""), "units": units, "chars": [], "retention": 0.0,
                "medianMs": 0.0, "absorbed": 0, "hopMs": float(hop_ms)}
    env, hop = rms_envelope(y, sr, hop_ms)
    n = int(round(dur * 1000.0 / hop_ms))
    n = max(len(units), n)
    # 边界先验：按字数均分；最后一个字到句末
    used = set()
    bounds = [0]
    for k in range(1, len(units)):
        nominal = int(round(k * n / float(len(units))))
        span = max(1, int(round(n * SEARCH_RATIO / max(1, len(units) - 1))))
        i = _valley_near(env, nominal, nominal - span, nominal + span + 1, used)
        # 保证严格递增
        if i <= bounds[-1]:
            i = bounds[-1] + 1
        bounds.append(i)
        used.add(i)
    bounds.append(n)
    chars = []
    for k, u in enumerate(units):
        a = bounds[k] * hop_ms / 1000.0
        b = min(dur, bounds[k + 1] * hop_ms / 1000.0)
        if b <= a:
            b = min(dur, a + hop_ms / 1000.0)
        chars.append({"text": u, "start": round(max(0.0, a), 3), "end": round(max(a, b), 3)})
    durs = [max(0.0, c["end"] - c["start"]) for c in chars]
    med = float(np.median(durs)) if durs else 0.0
    absorbed = 0
    for d in durs:
        if med > 0 and d > med * ABSORB_FACTOR:
            absorbed += max(1, int(round(d / med)) - 1)
    kept = sum(1 for d in durs if d >= MIN_CHAR_SEC)
    total = max(len(units), kept + absorbed)
    kept_ratio = max(0.0, min(1.0, float(kept) / float(total))) if total else 0.0
    onsets = _count_onsets(env, hop_ms)
    onset_ratio = max(0.0, min(1.0, float(min(onsets, len(units))) / float(len(units)))) if units else 0.0
    retention = min(kept_ratio, onset_ratio)
    return {
        "text": str(text or ""),
        "units": units,
        "chars": chars,
        "retention": round(retention, 3),
        "keptRatio": round(kept_ratio, 3),
        "onsetCount": onsets,
        "onsetRatio": round(onset_ratio, 3),
        "medianMs": round(med * 1000.0, 1),
        "absorbed": absorbed,
        "hopMs": float(hop_ms),
    }

def boundary_error_ms(est_chars, expected_times):
    """中位边界误差（毫秒）：expected_times 是每个字边界的期望时间（秒）。"""
    est = [c["start"] for c in (est_chars or [])]
    exp = list(expected_times or [])
    if not est or not exp:
        return None
    m = min(len(est), len(exp))
    errs = sorted(abs(est[i] - exp[i]) * 1000.0 for i in range(m))
    return round(float(median(errs)), 1)

def median(xs):
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return 0.0
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])

def align_file(wav_path: str, text: str, **kw):
    """读 WAV（soundfile，延迟导入）→ align_signal()。"""
    import soundfile as sf
    y, sr = sf.read(wav_path, always_2d=True)
    mono = np.ascontiguousarray(y.mean(axis=1).astype(np.float32))
    return align_signal(mono, int(sr), text, **kw)

def align_lines(lines, outdir: str, hop_ms: float = HOP_MS):
    """对一批已合成句做字级对齐（lines: [{index,text,out}]）。返回 {index: result}。"""
    out = {}
    for ln in lines or []:
        p = ln.get("out")
        if not p or not os.path.isfile(p):
            continue
        try:
            out[str(ln.get("index"))] = align_file(p, ln.get("text") or "", hop_ms=hop_ms)
        except Exception as e:  # noqa: BLE001
            out[str(ln.get("index"))] = {"error": str(e)[:200]}
    return out

def _write_summary(out, payload):
    d = os.path.dirname(out)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    return out

def main(argv=None):
    ap = argparse.ArgumentParser(description="字级对齐（能量谷底 + 字数先验）")
    ap.add_argument("--in", dest="wav", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--hop-ms", type=float, default=HOP_MS)
    args = ap.parse_args(argv)
    r = align_file(args.wav, args.text, hop_ms=args.hop_ms)
    if args.out:
        _write_summary(args.out, r)
        print("已写入：" + args.out)
    else:
        print(json.dumps(r, ensure_ascii=False))
    if r.get("retention", 0) < 0.95:
        print("警告：字保留率 %.1f%% < 95%%，可能有丢字/糊字" % (r["retention"] * 100), file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())

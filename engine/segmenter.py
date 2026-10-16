# -*- coding: utf-8 -*-
"""静音分段：把长音频按「完全空白静音」切成若干段，供分段转录（提速）用。

**为什么要有它**（实测，不是拍脑袋）：MuScriptor 逐 5 秒块推理，静音块同样要走一遍完整前向。
对"曲目之间有掌声/静场"的整场录播、多曲目专辑、讲座录音，这部分是纯烧时间。
实测《原神》线上音乐会 2021（104 分钟）：
  · −60 dBFS 下静音 439.5 s / **7.0%**，≥2 s 的静音段 50 个（最长 19.5 s，开头 0~19 s 就是一段）
  · −50 dBFS 下静音 509.5 s / 8.2%
→ 可省约 7%，留白更多的素材按比例更大。

**设计要点（每条都有理由，别顺手改）**
  1. **只在"完全空白静音"上切**（默认 −60 dBFS = RMS 0.001），不按"比较安静"切 ——
     音乐里的弱奏段落被切开会在接缝处丢音。
  2. **切在静音段中点**：两段各自都留得住混响尾巴与起音的预备量。
  3. 首尾的静音只留 `edge_keep` 秒当pre-roll，其余跳过（不然开头 19 秒静音白跑）。
  4. 段太短（< `min_segment`）并进邻段：段越碎，每段重复升温/上下文开销占比越高。
  5. 段太长（> `max_segment`）时在该段内**最安静的那一帧**切，而不是按时间硬切。
  6. 全程纯函数、不碰文件：解码一次 PCM 交给它，结果可断言、可回归（见 tests/test_segmenter.py）。

**实测 A/B（2026-10-14，95 秒素材 = 40 s 音乐 + 15 s 静音 + 40 s 音乐，medium 模型）**
  · 时间轴：分段产物与整段产物按 (音高, 起音) 对齐，**最佳位移 0.00 s**（不是 1 秒也不偏）——
    偏移与接缝去重是对的，这是这套东西的底线。
  · 接缝处不会出现双份音符（起音落在 padding 里的音被归给邻段）。
  · 耗时 36 s → 32 s（静音占 21.6%）；长音频上收益接近静音占比，短素材里模型加载占大头。
  · **代价（必须知道）**：第二段单独转录时上下文变少，音符数与整段结果不同 ——
    整段 934 个 / 分段 781 个 / 把第二段单独整段转 725 个。也就是说分段结果落在"整段"与
    "完全孤立"之间，是**上下文效应**，不是拼接 bug。要严格一致就别开分段。
"""

import numpy as np

DEFAULT_THRESHOLD = 0.001      # −60 dBFS：用户说的"完全空白静音"
DEFAULT_MIN_SILENCE = 2.0      # 连续静音 ≥ 2 s 才值得切
DEFAULT_MIN_SEGMENT = 20.0     # 段短于 20 s 就并进邻段
DEFAULT_MAX_SEGMENT = 600.0    # 段长于 10 分钟就在最安静处再切
DEFAULT_EDGE_KEEP = 2.0        # 首尾静音各留 2 s 当 pre-roll


def frame_rms(x, sr, frame_ms=20.0):
    """逐帧 RMS（不重叠）。返回 (rms 数组, 每帧秒数)。"""
    frame = max(1, int(round(frame_ms / 1000.0 * sr)))
    n = len(x) // frame
    if n <= 0:
        return np.zeros(0, dtype="float32"), frame / float(sr)
    seg = np.asarray(x[:n * frame], dtype="float32").reshape(n, frame)
    return np.sqrt((seg * seg).mean(axis=1)).astype("float32"), frame / float(sr)


def silence_spans(rms, hop_sec, threshold=DEFAULT_THRESHOLD, min_len=DEFAULT_MIN_SILENCE):
    """连续静音（帧 RMS ≤ threshold）且长度 ≥ min_len 的区间，返回 [(t0, t1)]（秒）。"""
    out = []
    start = None
    for i, v in enumerate(rms):
        if v <= threshold:
            if start is None:
                start = i
        elif start is not None:
            t0, t1 = start * hop_sec, i * hop_sec
            if t1 - t0 >= min_len:
                out.append((t0, t1))
            start = None
    if start is not None:
        t0, t1 = start * hop_sec, len(rms) * hop_sec
        if t1 - t0 >= min_len:
            out.append((t0, t1))
    return out


def _quietest_split(rms, hop_sec, lo, hi, min_segment):
    """段超长时在哪切：取"最安静那段连续帧"的**中点**（避开两端 min_segment 的保护区）。

    ★ 为什么不是直接 argmin：最安静的那一帧往往紧贴响段边缘（响段一结束就是最低点），
      在那里切会把响段的混响尾巴切掉。取"接近最安静"的连续帧的中点，离两边都远。
    """
    i0 = max(0, int(round((lo + min_segment) / hop_sec)))
    i1 = min(len(rms), int(round((hi - min_segment) / hop_sec)))
    if i1 <= i0:
        return None
    seg = rms[i0:i1]
    thr = float(seg.min()) * 1.5 + 1e-9          # "接近最安静"的容差
    near = seg <= thr
    # 最长连续 near 段
    best_s = 0
    best_len = 0
    cur_s = 0
    cur_len = 0
    for i, v in enumerate(near):
        if v:
            if cur_len == 0:
                cur_s = i
            cur_len += 1
            if cur_len > best_len:
                best_len, best_s = cur_len, cur_s
        else:
            cur_len = 0
    if not best_len:
        k = int(np.argmin(seg))
    else:
        k = best_s + best_len // 2
    return (i0 + k) * hop_sec + hop_sec / 2.0


def plan_segments(rms, hop_sec,
                  threshold=DEFAULT_THRESHOLD,
                  min_silence=DEFAULT_MIN_SILENCE,
                  min_segment=DEFAULT_MIN_SEGMENT,
                  max_segment=DEFAULT_MAX_SEGMENT,
                  edge_keep=DEFAULT_EDGE_KEEP):
    """给出分段方案。返回 dict：

      segments      [(start, end)] 秒 —— 要真正送去转录的核心区间（不含首尾多余静音）
      skipped       [(a, b)] 秒 —— 被跳过的静音区间（用于日志/进度）
      skipped_sec   跳过总秒数
      duration      总时长
    """
    duration = len(rms) * hop_sec
    if duration <= 0:
        return {"segments": [], "skipped": [], "skipped_sec": 0.0, "duration": 0.0}
    spans = silence_spans(rms, hop_sec, threshold, min_silence)

    # ★ head/tail 是"段的边界"，不是"段的起点"：被跳过的首尾静音**不能**变成一段
    #   （第一版把它们当成切点，于是开头 17 秒静音被当成一段，还要靠 min_segment 合并回去）。
    head = 0.0
    tail = duration
    interior = []
    skipped = []
    for (a, b) in spans:
        if a <= 1e-9 and b >= duration - 1e-9:      # 整首都是静音：没有可转录的东西
            skipped.append((0.0, duration))
            head, tail = duration, duration
            continue
        if a <= 1e-9:                               # 开头静音：只留 edge_keep 当 pre-roll
            head = max(0.0, b - edge_keep)
            skipped.append((0.0, head))
        elif b >= duration - 1e-9:                  # 结尾静音：同样只留 edge_keep
            tail = min(duration, a + edge_keep)
            skipped.append((tail, duration))
        else:                                       # 中间静音：切在中点，两边各留一半
            interior.append((a + b) / 2.0)
            skipped.append((a, b))

    bounds = [head] + sorted(c for c in interior if head < c < tail) + [tail]
    cores = []
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        if b - a > 1e-6:
            cores.append([a, b])

    # 段太短 → 并进邻段（与前一个合并；第一个则与后面合并）
    merged = []
    for core in cores:
        if merged and (core[1] - core[0]) < min_segment:
            merged[-1][1] = core[1]
        else:
            merged.append(core)
    if len(merged) >= 2 and (merged[0][1] - merged[0][0]) < min_segment:
        merged[1][0] = merged[0][0]
        merged.pop(0)

    # 段太长 → 在该段内最安静处再切（递归）；**即使一个静音段都没有**也要走这一步
    final = []
    for a, b in merged:
        final.extend(_split_long(rms, hop_sec, a, b, min_segment, max_segment))

    return {"segments": [(round(a, 3), round(b, 3)) for a, b in final],
            "skipped": [(round(a, 3), round(b, 3)) for a, b in skipped],
            "skipped_sec": round(sum(b - a for a, b in skipped), 3),
            "duration": round(duration, 3)}


def _split_long(rms, hop_sec, a, b, min_segment, max_segment):
    """段超过 max_segment 就在最安静处切，直到每段都不超（切不动就保留原样）。"""
    if b - a <= max_segment:
        return [(a, b)]
    cut = _quietest_split(rms, hop_sec, a, b, min_segment)
    if cut is None:
        return [(a, b)]
    return _split_long(rms, hop_sec, a, cut, min_segment, max_segment) + \
        _split_long(rms, hop_sec, cut, b, min_segment, max_segment)


def analyze(x, sr, **kw):
    """一次算完：PCM → 分段方案（转录侧调用这个）。"""
    rms, hop_sec = frame_rms(x, sr, kw.pop("frame_ms", 20.0))
    return plan_segments(rms, hop_sec, **kw)


def auto_enabled(duration, skipped_sec, mode="auto",
                 min_duration=300.0, min_gain=0.03):
    """要不要启用分段转录。返回 (bool, 原因字符串) —— 原因要能写进日志。"""
    mode = str(mode or "auto").lower()
    if mode in ("off", "false", "0", "no"):
        return False, "已关闭（segment_silence=off）"
    if mode in ("on", "true", "1", "yes"):
        return True, "强制开启（segment_silence=on）"
    if duration < min_duration:
        return False, "音频只有 %.0f 秒（< %.0f 秒），分段收益不足" % (duration, min_duration)
    gain = (skipped_sec / duration) if duration > 0 else 0.0
    if gain < min_gain:
        return False, "静音只占 %.1f%%（< %.0f%%），不值得分段" % (gain * 100, min_gain * 100)
    return True, "静音占 %.1f%%，分段可省约 %.0f 秒" % (gain * 100, skipped_sec)

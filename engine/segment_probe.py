# -*- coding: utf-8 -*-
"""分段乐器组探测的纯逻辑：固定窗口切分 + 每段约束并集。

只做数学，不加载模型/音频；模型探测在 engine_muscriptor 里调用 instrument_probe。
"""
import math


def fixed_segments(duration, segment_sec=60.0, min_seg=8.0):
    """把 duration 秒切成等长固定段；最后一段太短时并入前一段。

    返回 [(start, end), ...]。duration <= 0 返回 []。
    """
    try:
        dur = float(duration)
        seg = float(segment_sec)
    except (TypeError, ValueError):
        return []
    if dur <= 0:
        return []
    seg = max(20.0, min(120.0, seg))
    n = max(1, int(math.ceil(dur / seg - 1e-9)))
    out = []
    for i in range(n):
        a = i * seg
        b = min(dur, (i + 1) * seg)
        if b - a <= 1e-6:
            continue
        out.append((round(a, 3), round(b, 3)))
    if len(out) >= 2 and (out[-1][1] - out[-1][0]) < float(min_seg):
        a = out[-2][0]
        b = out[-1][1]
        out = out[:-2] + [(round(a, 3), round(b, 3))]
    return out


def build_constraints(per_segment, max_groups=12, stable_min_hits=2,
                      always_keep=("drums",), neighbor=True):
    """由「每段探测到的组」生成「每段允许的组」。

    目标：既让本段只出现它自己的乐器，又不要把相邻段才进场的乐器关掉。
      · global_keep：在 >= stable_min_hits 段里都出现的组（以及 always_keep 中出现过的鼓）；
      · allowed[i] = global_keep ∪ 本段组 ∪ 相邻段组，最多 max_groups 个；
      · 返回 (allowed, global_keep)。
    """
    per = [list(dict.fromkeys([str(x) for x in (g or [])])) for g in (per_segment or [])]
    n = len(per)
    if not n:
        return [], []
    hits = {}
    for gs in per:
        for g in gs:
            hits[g] = hits.get(g, 0) + 1
    keep = [g for g, c in sorted(hits.items(), key=lambda kv: (-kv[1], kv[0]))
            if c >= max(1, int(stable_min_hits))]
    for g in always_keep:
        if hits.get(g, 0) > 0 and g not in keep:
            keep.append(g)
    allowed = []
    for i, gs in enumerate(per):
        cand = list(keep)
        cand += gs
        if neighbor:
            if i > 0:
                cand += per[i - 1]
            if i + 1 < n:
                cand += per[i + 1]
        # 稳定排序：先全局组，再本段顺序，去重后截断
        uniq = list(dict.fromkeys(cand))
        allowed.append(uniq[:max(1, int(max_groups))])
    return allowed, keep

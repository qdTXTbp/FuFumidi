# -*- coding: utf-8 -*-
"""
MIDI 后处理：让转录结果更干净、更自然
=====================================
basic-pitch 等引擎输出的音符常带有：
- 同音高的重叠 / 紧邻碎片（颤音、长音、重复起音处尤其常见）→ 合并为连续长音
- 力度分布过于“平均” → 归一化到自然演奏范围
- 个别极短杂音 → 按时长过滤

本模块只操作 pretty_midi 对象，可独立导入测试；
engine_basic / engine_separate 在写盘前调用 apply_post()。
"""


def merge_overlap(midi, gap_ms=30.0):
    """把每个音轨内 间隔<=gap_ms 的同音高音符合并为连续音符。

    返回 True 表示发生了合并。
    """
    changed = False
    gap = max(0.0, float(gap_ms)) / 1000.0
    for inst in midi.instruments:
        notes = sorted(inst.notes, key=lambda n: (n.pitch, n.start))
        merged = []
        for n in notes:
            if (merged and merged[-1].pitch == n.pitch
                    and n.start <= merged[-1].end + gap):
                prev = merged[-1]
                prev.start = min(prev.start, n.start)
                prev.end = max(prev.end, n.end)
                prev.velocity = max(prev.velocity, n.velocity)
                changed = True
            else:
                merged.append(n)
        inst.notes = merged
    return changed


def remove_micro_notes(midi, min_ms=0.0):
    """删除短于 min_ms 的音符；min_ms<=0 时不做。返回删除数量。"""
    if min_ms <= 0:
        return 0
    removed = 0
    for inst in midi.instruments:
        keep = []
        for n in inst.notes:
            if (n.end - n.start) * 1000.0 >= min_ms:
                keep.append(n)
            else:
                removed += 1
        inst.notes = keep
    return removed


def normalize_velocity(midi, lo=28, hi=112, contrast=1.0):
    """把全部音符力度线性缩放到 [lo, hi]，对比度可选（>1 拉大强弱差）。"""
    allv = [n.velocity for inst in midi.instruments for n in inst.notes]
    if not allv:
        return
    v_min, v_max = min(allv), max(allv)
    span = (v_max - v_min) or 1.0
    for inst in midi.instruments:
        for n in inst.notes:
            t = (n.velocity - v_min) / span
            if contrast != 1.0:
                t = max(0.0, min(1.0, 0.5 + (t - 0.5) * contrast))
            n.velocity = int(round(lo + t * (hi - lo)))
    return True


def apply_post(midi, params=None, log_cb=None):
    """按参数字典依次应用后处理，返回报告 dict。

    支持的参数（都可在界面里勾选/调节）：
        merge_overlap   bool  合并同音高重叠/近邻音符（默认 True）
        merge_gap_ms    float 合并间隔 ms（默认 30）
        normalize_vel   bool  力度归一化（默认 True）
        min_note_after_ms float 写盘前再删掉短于此(ms)的音符（默认 0=不删）
    """
    params = params or {}
    report = {}

    def _log(msg):
        if log_cb:
            try:
                log_cb(msg)
            except Exception:
                pass

    if params.get("merge_overlap", True):
        gap = float(params.get("merge_gap_ms", 30) or 0)
        if merge_overlap(midi, gap):
            _log(f"后处理 · 合并同音高音符（间隔 ≤ {int(gap)}ms）")
        report["merged"] = True

    if params.get("normalize_vel", True):
        normalize_velocity(midi)
        _log("后处理 · 力度归一化")
        report["vel_norm"] = True

    min_ms = float(params.get("min_note_after_ms", 0) or 0)
    if min_ms > 0:
        removed = remove_micro_notes(midi, min_ms)
        report["removed_short"] = removed
        if removed:
            _log(f"后处理 · 过滤极短杂音 {removed} 个")

    return report


def count_notes(midi):
    """统计 MIDI 中的音符总数（含鼓轨）。"""
    return sum(len(inst.notes) for inst in midi.instruments)

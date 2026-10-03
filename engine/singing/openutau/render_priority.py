# -*- coding: utf-8 -*-
"""渲染优先级分桶 —— **照搬** `OpenUtau.Core/Render/RenderPriority.cs`（48 行）。

播放与预渲染都要按"离当前播放头/优先段有多近"给任务排序，所以这里把
"排序键"抽成纯函数：**桶（bucket）为主、距离为辅**。

## ★ 照搬时必须保留的语义
1. ★ **区间是半开半闭的**：`sourceStartMs <= playbackStartMs && sourceEndMs > playbackStartMs`
   —— 右端是**严格大于**。所以"恰好结束在播放头"的那个源**不算命中**（归到桶 1/2）。
   改成 `<=` 会让边界上的音素被多算一次。
2. 桶号越小越优先：`0` = 正在播放，`1` = 还没开始，`2` = 已经过去了。
3. `PreRenderBucket` 的三元：既是优先段且与优先段重叠 → 0；是优先段但不重叠 → 1；
   不���优先段但在优先段开始之后 → 2；否则 → 3。
4. `PreRenderDistance` 同样用**严格大于**判重叠（`phraseEndTick > priorityStartTick`）。
5. `PlaybackDistance` 命中时是 `max(0, 播放头 - 起点)`（因为起点 ≤ 播放头，
   实际恒 ≥ 0，`max` 只是防御）。

## ★ 载体差异
C# 是 `internal static class`；Python 用模块级函数（无状态、无需类）。
判定全部保留 `<=` / `>` 的原样，不做"化简"。
"""


def playback_bucket(source_start_ms: float, source_end_ms: float,
                    playback_start_ms: float) -> int:
    """对应 `PlaybackBucket`：播放排序的桶号（0 最小 = 最优先）。"""
    if source_start_ms <= playback_start_ms and source_end_ms > playback_start_ms:
        return 0
    return 1 if source_start_ms >= playback_start_ms else 2


def playback_distance(source_start_ms: float, source_end_ms: float,
                      playback_start_ms: float) -> float:
    """对应 `PlaybackDistance`：同桶内的细排序（越小越优先）。"""
    if source_start_ms <= playback_start_ms and source_end_ms > playback_start_ms:
        return max(0.0, playback_start_ms - source_start_ms)
    if source_start_ms >= playback_start_ms:
        return source_start_ms - playback_start_ms
    return playback_start_ms - source_end_ms


def pre_render_bucket(is_priority_part: bool, overlaps_priority: bool,
                      is_after_priority_start: bool) -> int:
    """对应 `PreRenderBucket`：预渲染排序的桶号。"""
    if is_priority_part and overlaps_priority:
        return 0
    if is_priority_part:
        return 1
    if is_after_priority_start:
        return 2
    return 3


def pre_render_distance(phrase_start_tick: int, phrase_end_tick: int,
                        priority_start_tick: int) -> int:
    """对应 `PreRenderDistance`：预渲染同桶内的细排序。"""
    if phrase_start_tick <= priority_start_tick and phrase_end_tick > priority_start_tick:
        return 0
    if phrase_start_tick >= priority_start_tick:
        return phrase_start_tick - priority_start_tick
    return priority_start_tick - phrase_end_tick

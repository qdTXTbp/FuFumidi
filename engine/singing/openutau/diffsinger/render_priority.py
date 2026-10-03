# -*- coding: utf-8 -*-
r"""渲染优先级 —— **照搬** `OpenUtau.Core/Render/RenderPriority.cs`。

## 为什么需要它

「实时预览」不是"整曲渲得快"，而是**从不整曲渲**：

* 播放中 → 先渲**播放头附近**的句（`OrderForPlayback`）
* 编辑中 → 先渲**你正在改的地方**附近（`OrderForPreRender`）
* 已渲过的句按 `phrase.hash` **命中 wav 缓存**（0 成本）

少了这层排序，后台渲染会从头开始渲整曲 —— 播放头在第 3 分钟时，
前两分钟全是没人听的浪费。

## `PlaybackBucket`（:5-10）—— 三个桶
```
0: 播放头**落在该句内部**（start <= playhead < end）   ← 最优先（正在响的那句）
1: 该句在播放头**之后**（start >= playhead）          ← 次优先（接下来要响的）
2: 该句在播放头**之前**                                ← 最后（已经响过的）
```
★ 注意 `1` 与 `2` 的顺序：**"之后" 优先于 "之前"** —— 播放时人关心的是接下来，
  不是刚才。照抄这个顺序，别按直觉改成"就近优先"。

## `PreRenderBucket`（:22-37）—— 四个桶
```
0: 是焦点 part **且**与焦点位置重叠
1: 是焦点 part
2: 不在焦点 part，但在焦点位置之后
3: 其它
```
"""

from typing import List, Sequence, Tuple

# ---------------------------------------------------------------- 播放

def playback_bucket(source_start_ms: float, source_end_ms: float,
                    playback_start_ms: float) -> int:
    """照搬 `:5-10`。返回值越小越优先。"""
    if source_start_ms <= playback_start_ms < source_end_ms:
        return 0                       # 播放头在句内
    return 1 if source_start_ms >= playback_start_ms else 2


def playback_distance(source_start_ms: float, source_end_ms: float,
                      playback_start_ms: float) -> float:
    """照搬 `:12-20`。桶内再按距离排。"""
    if source_start_ms <= playback_start_ms < source_end_ms:
        return max(0.0, playback_start_ms - source_start_ms)
    if source_start_ms >= playback_start_ms:
        return source_start_ms - playback_start_ms
    return playback_start_ms - source_end_ms


# ---------------------------------------------------------------- 预渲染

def pre_render_bucket(is_priority_part: bool, overlaps_priority: bool,
                      is_after_priority_start: bool) -> int:
    """照搬 `:22-37`。"""
    if is_priority_part and overlaps_priority:
        return 0
    if is_priority_part:
        return 1
    if is_after_priority_start:
        return 2
    return 3


def pre_render_distance(phrase_start_tick: int, phrase_end_tick: int,
                        priority_start_tick: int) -> int:
    """照搬 `:39-48`。返回 **tick**（不是 ms）—— 与上游一致。"""
    if phrase_start_tick <= priority_start_tick < phrase_end_tick:
        return 0
    if phrase_start_tick >= priority_start_tick:
        return phrase_start_tick - priority_start_tick
    return priority_start_tick - phrase_end_tick


# ---------------------------------------------------------------- 排序

def order_for_playback(tuples: Sequence[Tuple], playback_start_ms: float) -> List[Tuple]:
    """照搬 `OrderForPlayback`（`RenderEngine.cs:494-506`）。

    `tuples` 的每项是 `(phrase, offset_ms, estimated_length_ms, request)`。
    ★ `ThenBy(index)` 是关键：**排序必须稳定**（同桶同距离时保持原序），
      否则每轮渲染顺序都在抖，缓存利用率会掉。
    """
    idx = list(enumerate(tuples))
    idx.sort(key=lambda it: (
        playback_bucket(it[1][1], it[1][1] + it[1][2], playback_start_ms),
        playback_distance(it[1][1], it[1][1] + it[1][2], playback_start_ms),
        it[0],
    ))
    return [it[1] for it in idx]


def order_for_pre_render(tuples: Sequence[Tuple], focus_part=None,
                         focus_tick: int = -1) -> List[Tuple]:
    """照搬 `OrderForPreRender`（`RenderEngine.cs:508-516`）与
    `PreRenderAttentionBucket/_Distance`（:519-536）。

    `focus_part` / `focus_tick` 就是"用户正在改的地方"。
    """
    def bucket(t) -> int:
        phrase, _off, _est, req = t
        is_pri = focus_part is not None and _same_part(req.part, focus_part)
        overlaps = (focus_tick >= 0
                    and phrase.position <= focus_tick < phrase.end)
        after = focus_tick >= 0 and phrase.position >= focus_tick
        return pre_render_bucket(is_pri, overlaps, after)

    def distance(t) -> int:
        phrase, _off, _est, _req = t
        if focus_tick < 0:
            return 0
        return pre_render_distance(phrase.position, phrase.end,
                                   focus_tick)

    idx = list(enumerate(tuples))
    idx.sort(key=lambda it: (bucket(it[1]), distance(it[1]), it[0]))
    return [it[1] for it in idx]


def _same_part(a, b) -> bool:
    """`ReferenceEquals` 的等价 —— 没有 `id()` 就用对象自身比较。"""
    return a is b or id(a) == id(b)

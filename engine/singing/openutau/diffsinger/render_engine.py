# -*- coding: utf-8 -*-
r"""多句编排：布局 → 逐句渲染 → 按 `phraseOffsetMs` 拼回整轨。

**照搬** `OpenUtau.Core/Render/RenderEngine.cs`：

| 上游 | 本文件 |
|---|---|
| `RenderPartRequest`（:75-89） | `RenderPartRequest` |
| `BuildRenderRequests` 的布局循环（:300-321） | `build_render_requests` |
| `RenderRequests` 的 tuple 展开 + 排序（:325-345） | `render_requests` |
| `planner.RegisterPcm(part, hash, offsetMs, estimatedLengthMs, gain, samples)`（:374） | `MixPlanner.register_pcm` |

## ★ 三个关键点

1. **`phraseOffsetMs[i] = layout.positionMs - layout.leadingMs`**（:318）
   —— `leadingMs` 是首音素前的 padding，**要往回挪**，否则整轨会右移一个 head。
2. **`phraseEstimatedLengthMs[i] = layout.estimatedLengthMs`**（:319）
   —— DiffSinger 的 `estimatedLengthMs` **含**首尾 padding（`Layout` :70-82），
   所以这句会比 `durationMs` 长 `head+tail`。
3. **每句各自加自己的 8+8 帧 padding** —— 这是多句的**全部意义**：
   整首当一句时，句与句之间的空隙会变成「音素间隙 SP」，模型看到的是一段
   长得离谱的静音；切成多句后每句都是紧凑的音乐单元。

## 本文件**不做**的事（编辑器交互层，不阻塞离线渲染）
* `xsy` 双渲染 + `CrossSynthDSP.StftBlend`（:376-419）—— 需要 `oto2` 替换与 STFT 混合
* `OrderForPlayback` / `OrderForPreRender` 的排序（:341-345）
* `RealCurveUpdate` 发布 / 覆盖率不变量 / `PartRenderedNotification`（:421-441）
* `MixPlanner` 的完整实现（并发混音、渐出、`GetResult`）—— 本文件给的是**串行**等价物
"""

import asyncio
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence

SAMPLE_RATE = 44100


@dataclass
class RenderPartRequest:
    """对应 `RenderPartRequest`（:75-89）。`phrase_*Ms` 与 `phrases` **平行**。"""

    part: object
    track_no: int = 0
    phrases: List = field(default_factory=list)
    #: 与 `phrases` 平行的 44.1kHz 传输域定位（:82）
    phrase_offset_ms: List[float] = field(default_factory=list)
    phrase_estimated_length_ms: List[float] = field(default_factory=list)
    #: 本轮渲染里已完成的句数（每轮新建，所以普通字段就够，:85）
    completed_phrases: int = 0


def build_render_requests(parts: Sequence, start_tick: int = 0, end_tick: int = -1,
                          get_phrases: Optional[Callable] = None) -> List[RenderPartRequest]:
    """照搬 `BuildRenderRequests`（:300-321）。

    `get_phrases(part) -> List[RenderPhrase]` 由调用方提供（对应
    `part.GetRenderRequest()`；`PhraseSource.from_part` 已在做切句）。

    ★ 布局循环（:314-319）是整个多句拼接的核心：
      `phraseOffsetMs[i] = layout.positionMs - layout.leadingMs`
    """
    out: List[RenderPartRequest] = []
    for part in parts:
        phrases = list(get_phrases(part) if get_phrases else [])
        if not phrases:
            continue
        # ★ :308-312 选区过滤（`phrase.end > startTick && phrase.position < endTick`）
        if end_tick != -1 or start_tick != 0:
            phrases = [p for p in phrases
                       if p.end > start_tick and (end_tick == -1 or p.position < end_tick)]
        if not phrases:
            continue
        req = RenderPartRequest(part=part, phrases=phrases)
        req.phrase_offset_ms = [0.0] * len(phrases)
        req.phrase_estimated_length_ms = [0.0] * len(phrases)
        for i, phrase in enumerate(phrases):
            layout = phrase.renderer.layout(phrase)          # :316 renderer.Layout(phrase)
            req.phrase_offset_ms[i] = layout.position_ms - layout.leading_ms
            req.phrase_estimated_length_ms[i] = layout.estimated_length_ms
        out.append(req)
    return out


async def render_requests(requests: Sequence[RenderPartRequest],
                          on_phrase_done: Optional[Callable] = None,
                          should_cancel: Optional[Callable[[], bool]] = None,
                          playing: bool = False,
                          playback_start_ms: float = 0.0,
                          focus_part=None,
                          focus_tick: int = -1) -> List[Dict]:
    """照搬 `RenderRequests`（:325-441）的**串行**核心。

    上游是"每句一个 `Task` + `task.Wait()` + `planner.RegisterPcm`"（:369-374）。
    这里逐句 await 并把结果连同定位一起返回，由 `MixPlanner` 或调用方混音。

    返回每句的 `{'part', 'phrase', 'hash', 'offset_ms', 'estimated_length_ms',
    'samples', 'completed', 'total'}`。
    """
    from .render_priority import order_for_playback, order_for_pre_render

    results: List[Dict] = []
    # ★ :330-337 展平成 (phrase, offsetMs, estimatedLengthMs, request) 的列表
    tuples = [(p, r.phrase_offset_ms[i], r.phrase_estimated_length_ms[i], r)
              for r in requests for i, p in enumerate(r.phrases)]

    # ★ :341-347 **排序即"实时预览"的关键**：渲染顺序决定第一声要等多久。
    #   播放中 → 先渲播放头附近；编辑中 → 先渲焦点附近；
    #   两者都不给 → 保持原序（整曲导出场景）。
    if playing:
        tuples = order_for_playback(tuples, playback_start_ms)
    elif focus_part is not None or focus_tick >= 0:
        tuples = order_for_pre_render(tuples, focus_part, focus_tick)
    for phrase, offset_ms, est_ms, req in tuples:
        if should_cancel and should_cancel():
            break
        result = await phrase.renderer.render(phrase)      # :369
        if result is None or result.samples is None:
            continue
        req.completed_phrases += 1
        results.append({
            'part': req.part,
            'phrase': phrase,
            'hash': getattr(phrase, 'hash', 0),
            'offset_ms': offset_ms,
            'estimated_length_ms': est_ms,
            'samples': result.samples,
            'completed': req.completed_phrases,
            'total': len(req.phrases),
        })
        if on_phrase_done:
            on_phrase_done(len(results), sum(len(r.phrases) for r in requests))
    return results


class MixPlanner:
    """串行版的 `RegisterPcm` / `GetResult`（对应 `MixPlanner`，上游是并发的）。

    ★ 拼接规则照搬 `MixPlanner.RegisterPcm` + `MixResult`：
      目标长度 = `max(offsetMs + estimatedLengthMs)`；
      每句按 `offsetMs` 落位；**末尾按 `estimatedLengthMs` 预留**，
      所以 DiffSinger 的 head+tail padding 不会被截掉。
    """

    def __init__(self, sample_rate: int = SAMPLE_RATE, end_ms: float = 0.0):
        self.sample_rate = sample_rate
        self.end_ms = end_ms
        self._tracks: Dict[int, List[Dict]] = {}
        self._track_lengths: Dict[int, float] = {}
        #: part → 已完成的 hash 集合（对应 `MarkPartComplete` :434）
        self.completed: Dict[int, List[int]] = {}

    def register_pcm(self, part, phrase_hash: int, offset_ms: float,
                     estimated_length_ms: float, gain: float, samples) -> None:
        key = id(part)
        self._tracks.setdefault(key, []).append({
            'hash': phrase_hash, 'offset_ms': offset_ms,
            'estimated_length_ms': estimated_length_ms,
            'gain': float(gain), 'samples': samples,
        })
        end = offset_ms + estimated_length_ms
        if end > self._track_lengths.get(key, 0.0):
            self._track_lengths[key] = end

    def mark_part_complete(self, part, hashes: Sequence[int]) -> None:
        self.completed[id(part)] = list(hashes)

    def track_count(self) -> int:
        return len(self._tracks)

    def get_result(self) -> Optional[Dict]:
        """把各 part 叠成整轨。返回 `{'samples': ndarray, 'estimated_length_ms': float}`。"""
        import numpy as np

        if not self._tracks:
            return None
        end_ms = max(list(self._track_lengths.values())
                     + ([self.end_ms] if self.end_ms else []))
        n = int(end_ms / 1000.0 * self.sample_rate)
        total = np.zeros(n, dtype=np.float32)
        for key, clips in self._tracks.items():
            acc = None
            length = int(self._track_lengths[key] / 1000.0 * self.sample_rate)
            if acc is None:
                acc = np.zeros(length, dtype=np.float32)
            for c in clips:
                start = int(c['offset_ms'] / 1000.0 * self.sample_rate)
                seg = np.asarray(c['samples'], dtype=np.float32) * c['gain']
                # ★ `offsetMs` **可以是负的**：布局是 `positionMs - leadingMs`
                #   （见 `build_render_requests`），位于曲首的乐句
                #   `positionMs=0 < leadingMs≈92.88` → offset 为负。
                #   不处理的话 `acc[负:end]` 在 Python 里会被当成"从末尾数"，
                #   切片长度完全错乱（实测 `acc[start:end]` 只有 9700 而 seg 有 58368），
                #   报 `operands could not be broadcast together`。
                #   正确做法：把越出左边界的那一段从 seg 上裁掉。
                if start < 0:
                    cut = min(len(seg), -start)
                    seg = seg[cut:]
                    start = 0
                if not len(seg):
                    continue
                end = start + len(seg)
                if end > len(acc):
                    acc = np.pad(acc, (0, end - len(acc)))
                acc[start:end] += seg
            # 各 part 对齐到整轨起点（part 自身的 position 已在 offset 里体现）
            if len(acc) > len(total):
                total = np.pad(total, (0, len(acc) - len(total)))
            total[:len(acc)] += acc
        return {'samples': total, 'estimated_length_ms': end_ms}

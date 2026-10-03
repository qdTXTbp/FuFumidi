# -*- coding: utf-8 -*-
r"""增量预览调度 —— 「实时预览」的核心。

## 上游是怎么做的

不是"整曲渲得快"，而是**从不整曲渲**：

1. **乐句级缓存** —— `RenderPhrase.hash`（含 notes/phones/pitches/曲线）决定 wav 文件名
   `ds-{hash:x16}-depth{}-steps{}.wav`。**hash 没变就直接读盘**。
2. **编辑即失效** —— 改一个音符只会让**它所在那一句**的 hash 变，
   其余句全部命中缓存。
3. **去抖** —— 上游 `DiffSingerRealCurveScheduler` 用 200ms：
   连续拖动时不要每次 mousemove 都开一轮渲染。
4. **按优先级排序** —— `OrderForPlayback`（播放头附近优先）/
   `OrderForPreRender`（焦点附近优先），见 `render_priority.py`。
5. **可取消** —— 新一轮编辑到来时，上一轮没渲完的直接取消。

## 本模块负责 2/3/5（1 在 `diffsinger_renderer.py`，4 在 `render_engine.py`）

★ 关键设计：**不要**维护一份"已渲染集合"，而是**直接查盘**——
   缓存文件名由 hash 唯一决定，`os.path.isfile` 就是最权威的"已渲过"判据。
   维护内存集合会与磁盘状态漂移（尤其多层缓存/换 depth 之后）。
"""

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Set

#: 上游 `DiffSingerRealCurveScheduler` 的去抖时长
DEBOUNCE_MS = 200


@dataclass
class PreviewPlan:
    """一轮预览渲染的计划。"""

    #: 需要真正渲染的句（hash 变了 / 缓存文件不在）
    pending: List = field(default_factory=list)
    #: 命中缓存、直接用现成 wav 的句
    cached: List = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.pending) + len(self.cached)


def plan_preview(phrases: Sequence, cache_dir: Optional[str],
                 depth: float = 1.0, steps: int = 20) -> PreviewPlan:
    """把一批句分成「要渲的」与「命缓存的」。

    缓存文件名与 `DiffsingerIRenderer._cache_path` **必须一致** ——
    这里只做判定，不重复实现渲染；文件名对不上会让缓存永远 miss。
    """
    plan = PreviewPlan()
    for ph in phrases:
        if cache_dir and _cache_hit(ph, cache_dir, depth, steps):
            plan.cached.append(ph)
        else:
            plan.pending.append(ph)
    return plan


def _cache_hit(phrase, cache_dir: str, depth: float, steps: int) -> bool:
    name = 'ds-%016x-depth%.2f-steps%d.wav' % (phrase.hash, depth, steps)
    return os.path.isfile(os.path.join(cache_dir, name))


@dataclass
class PreviewScheduler:
    """去抖 + 取消的预览调度器。

    用法（前端每改一次就 `touch()` 一次）：
    ```python
    sched = PreviewScheduler(render_one=..., cache_dir=...)
    sched.touch(phrases)          # 编辑发生 —— 内部等去抖窗口结束后才开跑
    await sched.drain()           # 等当前这轮跑完（测试/退出时用）
    ```

    ★ `touch()` **不是** async：它只记下"有新编辑"，由后台协程在静默
      `DEBOUNCE_MS` 之后才真正开跑。这样拖动音符（几十次 mousemove）
      只会触发**一轮**渲染。
    """

    #: 渲染单句的协程：`async (phrase) -> samples | None`
    render_one: Callable
    cache_dir: Optional[str] = None
    depth: float = 1.0
    steps: int = 20
    on_phrase_ready: Optional[Callable] = None
    on_round_done: Optional[Callable] = None
    debounce_ms: int = DEBOUNCE_MS
    #: 是否已开始（调用 `start()` 后为真）
    started: bool = False

    _latest: Optional[Sequence] = None
    _last_touch: float = 0.0
    _task: Optional[asyncio.Task] = None
    _cancel: Optional[asyncio.Event] = None
    #: ★ 退出闸 —— `_run` 是长驻循环，没有它 `stop()` 会永远 await 下去
    _stopped: bool = False
    #: 是否正在渲一轮（`drain()` 靠它判断"空闲"）
    _busy: bool = False
    #: 统计（测试与自检用）
    stats: Dict[str, int] = field(default_factory=lambda: {
        'rounds': 0, 'rendered': 0, 'cached': 0, 'canceled': 0,
    })

    # ---------------------------------------------------------------- 接口

    def start(self, loop: Optional[asyncio.AbstractEventLoop] = None) -> None:
        if self._task is not None:
            return
        self._stopped = False
        self.started = True
        self._task = (loop or asyncio.get_event_loop()).create_task(self._run())

    def touch(self, phrases: Sequence) -> None:
        """记下最新一批句并重置去抖计时。"""
        self._latest = list(phrases)
        self._last_touch = time.monotonic()
        # ★ 新编辑到来 → 取消上一轮还没渲完的
        if self._cancel is not None and not self._cancel.is_set():
            self._cancel.set()

    async def stop(self) -> None:
        # ★ 先立退出闸，再取消当前轮 —— 顺序反了的话 `_run` 会再起一轮，
        #   `await self._task` 就永远等不到结束。
        self._stopped = True
        self._latest = None
        if self._cancel is not None:
            self._cancel.set()
        if self._task is not None:
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.started = False

    async def drain(self) -> None:
        """等调度器**空闲**（当前轮跑完且没有攒着的新编辑）。

        ★ 不能等 `self._task.done()` —— `_run` 是**长驻**循环，
          它在 `stop()` 之前永远不会结束，`await` 它就是死等。
          这里等的是"没在渲、也没攒着待办"这个状态。
        """
        while self._busy or self._latest is not None:
            await asyncio.sleep(0.01)

    # ---------------------------------------------------------------- 内部

    async def _run(self) -> None:
        while not self._stopped:
            await asyncio.sleep(self.debounce_ms / 1000.0)
            if self._stopped:
                return
            # 距上次 touch 还不满一个去抖窗口 → 继续等（连续编辑被合并成一轮）
            if (time.monotonic() - self._last_touch) * 1000.0 < self.debounce_ms:
                continue
            phrases = self._latest
            self._latest = None
            if not phrases:
                continue
            await self._render_round(phrases)

    async def _render_round(self, phrases: Sequence) -> None:
        self._busy = True
        self._cancel = asyncio.Event()
        cancel = self._cancel
        self.stats['rounds'] += 1

        plan = plan_preview(phrases, self.cache_dir, self.depth, self.steps)
        self.stats['cached'] += len(plan.cached)
        # 命中缓存的先通知（它们**立刻可用**，不用等）
        for ph in plan.cached:
            if cancel.is_set():
                self.stats['canceled'] += 1
                self._busy = False
                return
            if self.on_phrase_ready:
                self.on_phrase_ready(ph, None, True)

        for ph in plan.pending:
            if cancel.is_set():
                # ★ 新一轮编辑来了 —— 剩下的不渲了（下一轮会带着最新数据重算）
                self.stats['canceled'] += 1
                self._busy = False
                return
            try:
                samples = await self.render_one(ph)
            except asyncio.CancelledError:
                self.stats['canceled'] += 1
                self._busy = False
                return
            self.stats['rendered'] += 1
            if self.on_phrase_ready:
                self.on_phrase_ready(ph, samples, False)

        self._busy = False
        if self.on_round_done:
            self.on_round_done(plan)

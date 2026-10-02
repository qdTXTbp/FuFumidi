# -*- coding: utf-8 -*-
"""乐句快照的后台构建 —— **照搬** `OpenUtau.Core/Pipeline/PhraseSourceBuilder.cs`（162 行）。

两个东西：
- `PhraseBuildGate`：一次构建的"落地"信号量。渲染线程要等某个代际的快照落到
  part 上，就在不持有工程锁的前提下 `wait_for`。
- `PhraseSourceBuilder`：单线程 worker，**按 part 合并到最新快照**再构建，
  结果回投主线程，迟到的（代际不够新的）由 `UVoicePart.apply_phrase_source_result`
  丢掉。

## 为什么 worker 故意只用一个线程
C# 的注释写得很清楚：声库资源**没有做过线程隔离验证**，而 MOD+ 路径里
`UOto.Frq` 的惰性加载会改共享的 oto 状态。所以这里也必须串行 ——
"多开几个线程更快"是**行为变更**，不是优化。

## 与 C# 的载体差异（不是行为差异）
- **`TaskScheduler mainScheduler`** → 可注入的可调用对象
  （`DocHost.main_scheduler`，接收 `() -> None` 并安排到主线程）。为 `None` 时
  直接就地应用 —— 对应 C# 里"没有 worker 的测试宿主"那条路径。
- **`BlockingCollection<Request>`** → `queue.Queue`。C# 用
  `Take(shutdown.Token)` 取消阻塞；Python 的 `Queue.get()` 无法被 Event 打断，
  所以用**哨兵对象**唤醒（语义相同：dispose 后 worker 立刻退出）。
- **`Dictionary<UVoicePart, Request>`**（引用相等）→ `{id(part): request}`。
  我们的 `UVoicePart` 是 dataclass，`__eq__` 被生成出来了、`__hash__` 被抹掉了：
  既不能当字典键，就算当上键也会**按字段值比较**（两个内容相同的 part 会被合并成
  一个请求）。`id()` 才是 C# 的引用语义。
- **`DocManager.Inst.Project?.parts.Contains(part)`** → `any(p is part ...)`。
  同理：C# 的 `Contains` 是引用相等，Python 的 `in` 会走 `__eq__` 逐字段比较。
- 日志用标准库 `logging`（C# 用 Serilog）。
"""

import logging
import queue
import threading
from typing import Any, List, Optional, Tuple

from . import pipeline_source

logger = logging.getLogger(__name__)


class PhraseBuildGate:
    """对应 C# 的 `PhraseBuildGate`：跟踪"某个代际的快照是否已落地"。"""

    def __init__(self):
        self._lock = threading.Lock()
        # C# `new ManualResetEventSlim(true)` —— 初始就是"已就绪"
        self._done = threading.Event()
        self._done.set()
        self._pending = 0
        self._completed = 0

    def mark_pending(self, generation: int) -> None:
        with self._lock:
            if generation > self._pending:
                self._pending = generation
                self._done.clear()

    def mark_completed(self, generation: int) -> None:
        with self._lock:
            if generation > self._completed:
                self._completed = generation
                if self._completed >= self._pending:
                    self._done.set()

    def wait_for(self, generation: int, timeout: float) -> bool:
        """等待到 `generation` 落地；超时返回"是否已就绪"。

        ★ 先 `is_current` 快查、再等、**等完再查一次** —— 时序是 C# 原样：
        只依赖 Event 会被"等之前就已经 Set"这种情况漏掉，二次检查才是正确判据。
        """
        if self.is_current(generation):
            return True
        self._done.wait(timeout)
        return self.is_current(generation)

    def is_current(self, generation: int) -> bool:
        with self._lock:
            return self._completed >= generation


class _Request:
    """对应 C# 的私有 `Request { PhraseSource Source; UVoicePart Part; }`。"""

    __slots__ = ('source', 'part')

    def __init__(self, source, part):
        self.source = source
        self.part = part


#: `queue.Queue` 没有 `CompleteAdding`，用一个哨兵唤醒阻塞中的 worker
_SHUTDOWN = object()


class PhraseSourceBuilder:
    """对应 C# 的 `PhraseSourceBuilder`。

    使用：
        builder = PhraseSourceBuilder(main_scheduler)   # 构造即启动 worker
        builder.push(source, part)
        ...
        builder.dispose()
    """

    #: 活动中的 worker，未启用时为 None（此时调用方就地构建 —— 测试宿主）
    current: Optional['PhraseSourceBuilder'] = None

    def __init__(self, main_scheduler=None):
        self._main_scheduler = main_scheduler
        self._shutdown = threading.Event()
        self._requests = queue.Queue()
        self._busy_lock = threading.Lock()
        PhraseSourceBuilder.current = self
        self._thread = threading.Thread(target=self._builder_loop, daemon=True,
                                        name='PhraseSourceBuilder')
        self._thread.start()

    def push(self, source, part) -> bool:
        """投递一份快照。返回 False 表示 worker 已在关闭（请求被丢弃）。"""
        if self._shutdown.is_set():
            return False
        self._requests.put(_Request(source, part))
        return True

    # ------------------------------------------------------------------ worker

    def _builder_loop(self) -> None:
        latest = {}
        while not self._shutdown.is_set():
            with self._busy_lock:
                # 先清空队列：同一个 part 只留**最新**那份快照，
                # 旧的在开始构建之前就被取代了（不必白算一遍）
                while True:
                    try:
                        request = self._requests.get_nowait()
                    except queue.Empty:
                        break
                    if request is _SHUTDOWN:
                        return
                    latest[id(request.part)] = request
                if latest:
                    batch = list(latest.values())
                    latest.clear()
                    for request in batch:
                        self._send_result(self._build(request))
                # 阻塞等下一个请求（dispose 会塞哨兵唤醒）
                request = self._requests.get()
            if request is _SHUTDOWN:
                return
            latest[id(request.part)] = request

    def _build(self, request: _Request):
        """对应 C# 的 `Build(Request)`：构建失败只记日志、不重复抛。"""
        try:
            phrases = request.source.build_phrases()
            return (request.source, request.part, phrases)
        except Exception:
            # C#: Log.Error(e, "Failed to build phrase source {part}", request.Source.PartId)
            logger.exception('Failed to build phrase source %s', request.source.part_id)
            return None

    def _send_result(self, result: Optional[Tuple[Any, Any, List[Any]]]) -> None:
        """对应 C# 的 `SendResult(...)`：投回主线程后落地到 part 的回指槽。"""
        if self._main_scheduler is not None:
            self._main_scheduler(lambda: self._apply(result))
        else:
            self._apply(result)

    @staticmethod
    def _apply(result: Optional[Tuple[Any, Any, List[Any]]]) -> None:
        if result is None:
            return
        source, part, phrases = result
        project = pipeline_source.host.project
        # C#: `DocManager.Inst.Project?.parts.Contains(part) != true` → 丢弃。
        # 引用相等，不能写成 `part in project.parts`（dataclass 的 __eq__ 会逐字段比）
        if project is None or not any(p is part for p in project.parts):
            return
        part.apply_phrase_source_result(source, phrases)

    # ------------------------------------------------------------------ 关闭

    def dispose(self) -> None:
        """对应 C# 的 `Dispose`：停掉 worker 并让出 `Current`。

        C# 还会 `requests.CompleteAdding()`（之后 `Add` 抛异常 → `Push` 返回 false）；
        这里由 `push` 里的 `_shutdown.is_set()` 判断达成同一效果。
        """
        self._shutdown.set()
        self._requests.put(_SHUTDOWN)
        if PhraseSourceBuilder.current is self:
            PhraseSourceBuilder.current = None

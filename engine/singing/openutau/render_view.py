# -*- coding: utf-8 -*-
r"""渲染视图（UI 侧读缝）—— **照搬** `OpenUtau.Core/Render/RenderView.cs`（185 行）。

每个 part 一份 `RenderProjection` 不可变快照，**缓存到失效为止**；失效通知
**合并**成至多 60Hz 投递给观察者，而不是一句一次。

## ★ 照搬时保留的语义
1. ★ `MinIntervalMs = 16`（至多 60Hz），且 `lastDeliver` 初始为 **-16** ——
   **首次投递是立即的**，不被窗口推迟。
2. ★ pump 与 `WaveformRefresh` 同构：**窗口内没有新的失效就把 pump 引用清掉并退出**，
   空闲时不残留线程；窗口内到达的多次失效**合并成一次**投递。
3. ★ `deliver()` 读文档，所以**必须在 UI 线程**。上游用
   `DocManager.Inst.MainScheduler` 把工作调度回 UI 线程；没有 scheduler 的测试宿主
   就**内联执行**。这里用注入的 `deliver_inline` / `deliver_on_ui_thread` 二选一。
4. ★ `do_deliver()` 里"投递期间又来的一次失效"只是把 `dirty` 置位，
   **由 pump 循环的下一轮**接手 —— 不在本次里递归处理（避免重入）。
5. `forget_all()`：加载工程会**整体替换 part 对象**，旧快照必须丢掉否则泄漏。
6. `revision` 在每次 `build()` 自增，UI 靠它丢弃过期结果。

## ★ 载体差异
| C# | Python | 说明 |
|---|---|---|
| `SingletonBase<RenderView>.Inst` | 模块级 `get_instance()` | 进程级单例 |
| `ThreadGuard.AssertUi()` | **不设防**（`guard=None` 时直接过） | Python 没有线程亲和性检查；保留可注入的断言钩子 |
| `PlaybackManager.Inst.MixPlanner` | **注入的 planner**（`set_planner`） | 播放侧尚未照搬，见下 |
| `Task` + `Monitor.Wait` | `threading.Thread` + `time.sleep(0.01)` | 同 `WaveformRefresh` |
| `Action<RenderProjection>` 观察者 | 同（可调用对象） | |
| `IDisposable` 退订 | `Unsubscriber` 类 + `with` 可用 | |

★ **`MixPlanner` 为什么注入**：`TryGetPhrasePcm(part, hash, out pcm)` 属于**播放/混音**
  管线（另一大块，尚未照搬）。这里只依赖它的一个方法签名，所以做成注入点：
  没注入时 `build()` 视作"全部未渲染"（`rendered=False`、`ready=False`），
  不会崩 —— 这与 C# 里 planner 一定有值不同，但比抛异常好，且便于单测。
"""

import threading
import time
from typing import Callable, Dict, List, Optional

from .phrase_layout import PhraseLayout
from .render_projection import PhraseView, RenderProjection
from ..ustx.model import UWavePart

#: 对应 `const int MinIntervalMs = 16`（至多 60Hz 投递）
MIN_INTERVAL_SEC = 0.016


class _Unsubscriber:
    """对应 `private sealed class Unsubscriber : IDisposable`（退订句柄）。"""

    def __init__(self, view: 'RenderView', on_change):
        self._view = view
        self._on_change = on_change

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.dispose()
        return False

    def dispose(self) -> None:
        self._view.remove_observer(self._on_change)


class RenderView:
    """对应 `sealed class RenderView`。用 `RenderView.get_instance()` 取进程级实例。"""

    _instance: Optional['RenderView'] = None

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # ★ 用 `id(part)` 作键，复刻 C# `Dictionary<UPart, RenderProjection>` 的
        #   **引用键**语义 —— `UPart` 是 dataclass（eq=True 会把 __hash__ 抹掉）不可哈希，
        #   而且"值相等"也不是我们要的：两个内容相同但对象不同的 part 必须是两个缓存项
        #   （换工程时 part 被整体替换，旧投影要能各自独立失效）。
        #   与本仓库 `id(note)` / `id(descriptor)` 的做法一致。
        self._projections: Dict[int, RenderProjection] = {}
        self._observers: List[Callable[[RenderProjection], None]] = []
        self._planner = None
        self._pump: Optional[threading.Thread] = None
        # ★ 显式的"有 pump 待启动或在跑"标志（与 WaveformRefresh 同一个坑）：
        #   新建的 Thread 在 start() 之前 is_alive() 就是 False，用它判断会让
        #   密集 invalidate_all() 各建一个线程 → 退化成"一句一次投递"。
        self._pump_active = False
        self._dirty = False
        self._last_deliver = -MIN_INTERVAL_SEC     # ★ 负数 → 首次立即投递
        self._revision = 0
        #: UI 线程调度钩子：给一个函数，由它负责把 callable 放到 UI 线程跑。
        #: None = 内联执行（对应上游"没有 scheduler 的测试宿主"）。
        self._ui_scheduler: Optional[Callable[[Callable[[], None]], None]] = None

    @classmethod
    def get_instance(cls) -> 'RenderView':
        """对应 `SingletonBase<RenderView>.Inst`。"""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """丢掉单例（**仅供测试**；C# 的单例活到进程结束）。"""
        cls._instance = None

    # ---------------------------------------------------------------- 注入点

    def set_planner_for_test(self, planner) -> None:
        """对应 `internal void SetPlannerForTest(MixPlanner)`：注入 planner
        （需有 `try_get_phrase_pcm(part, hash) -> Optional`）。

        ★ 名字照搬上游（带 `ForTest`）—— 它本来就是个测试钩子，别洗掉。
        """
        self._planner = planner

    def set_ui_scheduler(self, scheduler: Optional[Callable[[Callable[[], None]], None]]) -> None:
        """注入 UI 线程调度器；None = 内联执行。"""
        self._ui_scheduler = scheduler

    # ---------------------------------------------------------------- 对外

    def current(self, part) -> RenderProjection:
        """对应 `Current(part)`：取该 part 的当前快照（没有就构建并缓存）。"""
        key = id(part)
        hit = self._projections.get(key)
        if hit is None:
            hit = self._build(part)
            self._projections[key] = hit
        return hit

    def observe(self, on_change: Callable[[RenderProjection], None]) -> _Unsubscriber:
        """对应 `Observe(onChange)`：订阅投影更新，返回退订句柄。"""
        with self._lock:
            self._observers.append(on_change)
        return _Unsubscriber(self, on_change)

    def remove_observer(self, on_change) -> None:
        """退订（C# 里是 `Unsubscriber.Dispose`，这里也供外部直接调）。"""
        with self._lock:
            if on_change in self._observers:
                self._observers.remove(on_change)

    def forget_all(self) -> None:
        """对应 `ForgetAll()`：丢掉全部缓存快照（换工程时 part 对象被整体替换）。"""
        self._projections.clear()

    def invalidate_all(self) -> None:
        """对应 `InvalidateAll()`：标记全部失效并调度一次**合并后**的投递。"""
        with self._lock:
            self._dirty = True
            if not self._pump_active:
                self._pump_active = True
                self._pump = threading.Thread(target=self._pump_loop,
                                              name='render-view-pump', daemon=True)
                # ★ 在锁内 start，保证"置位 + 启动"原子
                self._pump.start()

    # ---------------------------------------------------------------- 内部

    def _try_get_phrase_pcm(self, part, phrase_hash: int):
        """调 planner 的 `try_get_phrase_pcm`；**没注入 planner 时一律当作"没渲染"**。"""
        if self._planner is None:
            return None
        return self._planner.try_get_phrase_pcm(part, phrase_hash)

    def _build(self, part) -> RenderProjection:
        """对应 `Build(part)`。"""
        self._revision += 1
        if isinstance(part, UWavePart):
            # 伴奏 part 没有乐句：整个文件就是 hash 0 下的一个"放置"
            wave = self._try_get_phrase_pcm(part, 0)
            if wave is not None:
                layout = PhraseLayout(start_ms=wave.pos_ms,
                                      end_ms=wave.pos_ms + wave.dur_ms,
                                      leading_ms=0, estimated_ms=wave.dur_ms)
                return RenderProjection(part, self._revision,
                                        [PhraseView(0, layout, True)], True)
            return RenderProjection(part, self._revision, [], False)

        phrases = list(getattr(part, 'render_phrases', []) or [])
        views: List[PhraseView] = []
        # ★ 空 part 的 ready 是 False（"没有乐句"不等于"渲染好了"）
        ready = bool(phrases)
        for phrase in phrases:
            rendered = self._try_get_phrase_pcm(part, phrase.hash) is not None
            if not rendered:
                ready = False
            views.append(PhraseView(phrase.hash, phrase.layout, rendered))
        return RenderProjection(part, self._revision, views, ready)

    def _pump_loop(self) -> None:
        """对应 `private void Pump()`。"""
        while True:
            with self._lock:
                deadline = max(self._last_deliver + MIN_INTERVAL_SEC, time.monotonic())
                while time.monotonic() < deadline:
                    time.sleep(0.01)       # 对应 Monitor.Wait(lockObj, 10)
                if not self._dirty:
                    self._pump = None       # ★ 窗口内没失效 → 退休
                    self._pump_active = False
                    return
                self._dirty = False
                self._last_deliver = time.monotonic()
            self._deliver()

    def _deliver(self) -> None:
        """对应 `Deliver()`：有 UI scheduler 就调度过去，否则内联。"""
        if self._ui_scheduler is not None:
            self._ui_scheduler(self._do_deliver)
        else:
            self._do_deliver()

    def _do_deliver(self) -> None:
        """对应 `DoDeliver()`：重建全部快照并通知观察者。"""
        changed = []
        for key, projection in list(self._projections.items()):
            fresh = self._build(projection.part)      # ★ 用快照里存的 part 引用
            self._projections[key] = fresh
            changed.append(fresh)
        with self._lock:
            snapshot = list(self._observers)
        for projection in changed:
            for observer in snapshot:
                observer(projection)
        # ★ 投递期间落地的失效只是把 dirty 置位（上面已加锁），
        #   由 pump 循环的下一轮接手 —— 不在这里递归，避免重入。

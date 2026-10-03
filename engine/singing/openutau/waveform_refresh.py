# -*- coding: utf-8 -*-
r"""波形重绘的节流合并 —— **照搬** `OpenUtau.Core/Render/WaveformRefresh.cs`（55 行）。

渲染线程每完成一句就调一次 `request()`；这里把它们**合并**成至多 10Hz 的重绘通知。
上游注释举的例子：一轮 200 句的渲染，若一句一次通知就是 200 次重绘；合并后 ~10 次。

## ★ 照搬时保留的语义
1. **节流窗口 100ms**，且 ★ `last_post` 初始为 **-ThrottleMs** —— 让**第一次投递是立即的**，
   不被窗口推迟。照搬（很多人会漏掉这个负数初始化）。
2. ★ **"pump 自行退休"**：窗口内若**没有新的请求**（`dirty` 为假），pump 把自己的
   引用清掉并退出；下次 `request()` 再起一个新的。所以空闲时**不残留线程**。
3. ★ 请求在窗口内到达会**合并进当前这次**（`dirty` 置位后被同一轮消费），
   不排队 —— 也就是"至多一个通知/窗口"，不是"每个请求都对应一次通知"。
4. `request()` 本身**不阻塞**：置 `dirty` 后在锁外启动 pump。

## ★ 载体差异（都写在这里，便于对照）
| C# | Python | 说明 |
|---|---|---|
| `Environment.TickCount` | `time.monotonic()` | TickCount 是开机毫秒数、会回绕；monotonic 是单调秒。角色相同（只做"过了多久"的差） |
| `Task` + `TaskScheduler.Default` | `threading.Thread(daemon=True)` | 后台执行 |
| `Monitor.Wait(lock, 10)` | `threading.Event().wait(0.01)` | 10ms 轮询等窗口 |
| `DocManager.Inst.ExecuteCmd(new WaveformReadyNotification())` | **注入的回调** `on_ready` | 引擎侧没有 UI 命令通道 |

★ 回调在**锁外**调用（与上游一致：`ExecuteCmd` 绝不能在自己的锁里跑）。
★ `on_ready` 抛异常会被吞掉 —— 一个重绘失败不该让 pump 线程死掉。
"""

import threading
import time
from typing import Callable, Optional

#: 对应 `const int ThrottleMs = 100`
THROTTLE_SEC = 0.1


class WaveformRefresh:
    """对应 `static class WaveformRefresh`（进程级单例语义）。"""

    #: 对应 `static readonly object Lock`
    _lock = threading.Lock()
    #: 对应 `static Task pump`（None = 当前没有 pump 在跑）
    _pump: Optional[threading.Thread] = None
    #: ★ 显式的"有 pump 待启动或在跑"标志。
    #:   不用 `thread.is_alive()` 判 —— 新建的 Thread 在 `start()` **之前**
    #:   `is_alive()` 就是 False，密集 `request()` 会因此各建一个线程、
    #:   退化成"一句一次投递"（上游注释里明确要避免的那个 200 次重绘）。
    _pump_active = False
    #: 对应 `static bool dirty`
    _dirty = False
    #: 对应 `static int lastPost = -ThrottleMs`（★ 负数 → 首次立即投递）
    _last_post = -THROTTLE_SEC
    #: 对应 `DocManager.Inst.ExecuteCmd(new WaveformReadyNotification())` 的替身
    _on_ready: Optional[Callable[[], None]] = None
    #: 供测试观测：累计投递次数
    _post_count = 0

    # ---------------------------------------------------------------- 对外

    @classmethod
    def set_on_ready(cls, callback: Optional[Callable[[], None]]) -> None:
        """注入"波形已就绪、该重绘了"的回调（宿主在启动时调）。"""
        with cls._lock:
            cls._on_ready = callback

    @classmethod
    def request(cls) -> None:
        """对应 `Request()`：渲染线程在**某句 pcm 发布后**调用。"""
        with cls._lock:
            cls._dirty = True
            if not cls._pump_active:
                cls._pump_active = True
                cls._pump = threading.Thread(target=cls._pump_loop,
                                            name='waveform-refresh', daemon=True)
                # ★ 在锁内 start：保证"置位 + 启动"是原子的，
                #   否则另一个线程可能在我们 start 之前又置一次位、建第二个 pump。
                cls._pump.start()

    @classmethod
    def post_count(cls) -> int:
        """已投递次数（**仅供测试**；C# 无对应物）。"""
        return cls._post_count

    @classmethod
    def reset(cls) -> None:
        """复位所有静态状态（**仅供测试**；C# 的静态字段活到进程结束）。"""
        with cls._lock:
            cls._pump = None
            cls._pump_active = False
            cls._dirty = False
            cls._last_post = -THROTTLE_SEC
            cls._on_ready = None
            cls._post_count = 0

    # ---------------------------------------------------------------- 内部

    @classmethod
    def _pump_loop(cls) -> None:
        """对应 `static void Pump()`。"""
        while True:
            with cls._lock:
                deadline = max(cls._last_post + THROTTLE_SEC, time.monotonic())
                # 对应 `Monitor.Wait(Lock, 10)`：等窗口，每 10ms 醒一次重看条件。
                # （上游醒来后还要重新抢锁；这里还在 with 块里，等价。）
                while time.monotonic() < deadline:
                    time.sleep(0.01)
                if not cls._dirty:
                    cls._pump = None          # ★ 窗口内没请求 → pump 退休
                    cls._pump_active = False
                    return
                cls._dirty = False
                cls._last_post = time.monotonic()
                on_ready = cls._on_ready
            # ★ 回调在锁外（上游的 ExecuteCmd 同样不在自己的锁里调）
            cls._post_count += 1
            if on_ready is not None:
                try:
                    on_ready()
                except Exception:            # noqa: BLE001
                    pass                    # 一个重绘失败不该让 pump 线程死掉

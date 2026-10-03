# -*- coding: utf-8 -*-
"""`OpenUtau.Core/PresampWatcher.cs`（44 行）。

监听声库根目录下的 `presamp.ini`，变了就回调重载（编辑器用它做"改配置即时生效"）。

## ★ 载体差异
.NET 用 `FileSystemWatcher`（内核事件通知）。Python 标准库没有等价物，
所以这里用**后台线程轮询 mtime+size** 实现：

| 上游事件 | 本实现 |
|---|---|
| `Changed` / `Created` | 签名（mtime, size）变化 → `reload_callback()` |
| `Deleted` | 文件消失 → `reload_callback()` |
| `Renamed` | 等价于"旧名消失 + 新名出现"，同样落到上面两条 |
| `Error` | 轮询本身不会失败；目录被删时**安静停掉**（上游是记日志） |

★ `IncludeSubdirectories = false`（presamp.ini 永远在声库根目录）、`Filter = "presamp.ini"`
两条都保留 —— 轮询实现里体现为"只看那一个文件、只看根目录"。
`Paused` 开关的行为（**在回调之前**判断，所以暂停期间的变化被直接丢弃、不排队）也保留。
"""

import os
import threading
import time
from typing import Callable, Optional, Tuple

#: 对应 `watcher.Filter = "presamp.ini"`
WATCHED_FILENAME = 'presamp.ini'

#: 轮询间隔（秒）。.NET 是事件驱动的（几乎零延迟），这里取 0.5s 作为折中。
POLL_INTERVAL = 0.5


class PresampWatcher:
    """对应 `PresampWatcher : IDisposable`。"""

    def __init__(self, path: str, reload_callback: Optional[Callable[[], None]] = None):
        self.path = path
        self.reload_callback = reload_callback
        self.paused = False                 # 对应 `Paused { get; set; }`
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ---------------------------------------------------------------- 生命周期

    def start(self) -> None:
        """开始监听（对应构造函数里 `EnableRaisingEvents = true`）。"""
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name='presamp-watcher',
                                        daemon=True)
        self._thread.start()

    def dispose(self) -> None:
        """对应 `Dispose()`：停线程（等价于 `watcher.Dispose()`）。"""
        self._stop.set()
        t, self._thread = self._thread, None
        if t is not None and t.is_alive():
            t.join(timeout=POLL_INTERVAL * 4)

    # 兼容 with 语句
    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.dispose()
        return False

    # ---------------------------------------------------------------- 内部

    def _target(self) -> str:
        """★ `IncludeSubdirectories = false` → 只看根目录下的那一个文件。"""
        return os.path.join(self.path, WATCHED_FILENAME)

    @staticmethod
    def _signature(file_path: str) -> Optional[Tuple[float, int]]:
        """文件的 (mtime, size)；不存在返回 None。"""
        try:
            st = os.stat(file_path)
            return (st.st_mtime, st.st_size)
        except OSError:
            return None

    def _loop(self) -> None:
        target = self._target()
        last = self._signature(target)
        while not self._stop.is_set():
            if self._stop.wait(POLL_INTERVAL):
                break
            try:
                cur = self._signature(target)
            except Exception:            # noqa: BLE001 —— 轮询不该炸线程
                continue
            if cur == last:
                continue
            # Changed / Created / Deleted / Renamed 全落到这一条
            if self.paused:             # ★ 判断在**回调之前**：暂停期间的变化被丢弃
                last = cur
                continue
            last = cur
            if self.reload_callback is not None:
                try:
                    self.reload_callback()
                except Exception:        # noqa: BLE001
                    pass


def watch_presamp(path: str, reload_callback: Callable[[], None]) -> PresampWatcher:
    """便捷入口：建好并启动一个 watcher（调用方负责 `dispose()` 或用 `with`）。"""
    w = PresampWatcher(path, reload_callback)
    w.start()
    return w


_ = time   # 保留给将来做"节流"用；当前实现只用 Event.wait

# -*- coding: utf-8 -*-
"""`oto.ini` 变更监视 —— **照搬** `OpenUtau.Core/Classic/OtoWatcher.cs`（42 行）。

C# 用 `System.IO.FileSystemWatcher` 监视声库目录下所有 `oto.ini` 的
增/删/改/改名，触发 `SingerManager.Inst.ScheduleReload(singer)`；
`Save()` 期间把它 `Paused` 起来（否则自己写盘会触发自己重载）。

## 照搬时保留的语义
- `Paused` 时**只跳过调度**，不停止监视（`EnableRaisingEvents` 一直为 true）。
- `Dispose()` 只停后端，不重置 `Paused`。
- 监视是**递归**的（`IncludeSubdirectories = true`）、只看 `oto.ini`。
- 回调里**不判断文件内容**，任何变更都触发重载（所以外部编辑器"先删后建"
  会产生两次调度 —— C# 就是这样）。

## 与 C# 的载体差异（两处，都是"Python 没有对应物"）
1. **文件监视后端**：Python 标准库没有 `FileSystemWatcher`。这里把后端做成
   **可注入**的（`backend` 参数），不注入时用 `_NoopBackend`（**不监视**）。
   要真监视得由宿主接一个实现（例如 `watchdog`）—— 这是宿主能力，不是引擎逻辑，
   所以没在这里"自研一个轮询器"。
2. **`SingerManager.Inst.ScheduleReload`**：也是全局单例，同样做成可注入的
   `scheduler`（模块级）。默认实现**直接调 `singer.reload()`**（等价于"立即重载"）；
   C# 是丢到主调度器排队。差别只在时机，不在结果 —— 宿主可注入排队版本。

   ★ 注意默认实现是"立即"，而 watcher 回调可能来自**别的线程**；
   真在多线程里用，宿主应当注入一个排队到 UI 线程的版本（C# 的 `ScheduleReload`
   正是这么做的）。
"""

import logging
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

#: 监视的文件名（对应 `watcher.Filter = "oto.ini"`）
WATCH_FILTER = 'oto.ini'


class ReloadScheduler:
    """`SingerManager.Inst` 里"排队重载歌手"那一项的替身。

    C# 是 `SingerManager.Inst.ScheduleReload(singer)`；Python 侧没有这个单例，
    用一个可替换的对象顶替。默认实现立即重载（见模块 docstring 第 2 条）。
    """

    def schedule_reload(self, singer: Any) -> None:
        singer.reload()


#: 当前调度器（对应 C# 的全局单例）。宿主可在启动时替换。
scheduler = ReloadScheduler()


class _NoopBackend:
    """不监视任何东西的后端（默认）。

    C# 一定有 `FileSystemWatcher`；Python 侧没有等价物，所以默认"不监视"。
    这不是功能回退成错误结果 —— 只是失去了"外部改动 oto.ini 后自动重载"，
    需要时显式 `singer.reload()` 即可。
    """

    def start(self, path: str, on_change: Callable[[str, str], None],
              on_error: Callable[[BaseException], None], file_filter: str,
              recursive: bool) -> None:
        return None

    def stop(self) -> None:
        return None


class OtoWatcher:
    """对应 `OtoWatcher`。

    后端需实现：
        start(path, on_change, on_error, file_filter, recursive) -> None
        stop() -> None

    `on_change(full_path, change_type)` 由后端在文件变动时调用
    （`change_type` 对应 C# 的 `WatcherChangeTypes`，取值随意，只用于日志）。
    """

    def __init__(self, singer, path: str, backend: Optional[Any] = None):
        #: 对应 `Paused { get; set; }`（默认 false）
        self.paused = False
        self.singer = singer
        self.backend = backend if backend is not None else _NoopBackend()
        self.backend.start(path, self.on_file_changed, self.on_error,
                           WATCH_FILTER, True)

    # ---- 后端回调

    def on_file_changed(self, full_path: str, change_type: str = '') -> None:
        """对应 `OnFileChanged`：暂停中直接返回，否则排一次重载。"""
        if self.paused:
            return
        logger.info('File "%s" %s', full_path, change_type)
        scheduler.schedule_reload(self.singer)

    def on_error(self, err: BaseException) -> None:
        """对应 `OnError`：只记日志，不抛。"""
        logger.error('Watcher error %s', err)

    # ---- IDisposable

    def dispose(self) -> None:
        """对应 `Dispose()`：只停后端（**不**把 `paused` 复位）。"""
        self.backend.stop()

    # Python 侧的上下文管理器用法（C# 是 using / IDisposable）
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.dispose()
        return False

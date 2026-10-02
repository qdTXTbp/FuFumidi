# -*- coding: utf-8 -*-
"""YAML 变更监视 —— **照搬** `OpenUtau.Core/Classic/YamlWatcher.cs`（47 行）。

与 `Classic/OtoWatcher.cs` 是**兄弟**（同一个作者、同样的 `FileSystemWatcher` 包装），
区别只在「过滤什么文件」与「回调做什么」。`SyllableBasedPhonemizer` 用它来在
声库目录 / 插件目录里出现 `.yaml` 改动时，把 YAML 缓存清掉并让音素化器重载配置。

## 照搬时保留的语义
- `Paused` 时**只跳过回调**，不停止监视（`EnableRaisingEvents` 一直为 true）。
- `Dispose()` 只停后端，**不**复位 `Paused`。
- 监视是**递归**的（`IncludeSubdirectories = true`）、只看 `*.yaml`。
- `Changed` / `Created` / `Deleted` / `Renamed` 四个事件**都**走同一个回调 ——
  所以外部编辑器"先删后写"会触发两次（C# 就是这样，不做去重）。

## 与 C# 的载体差异（与 `oto_watcher.py` 同一决策）
1. **文件监视后端**：Python 标准库没有 `FileSystemWatcher`。后端做成**可注入**的
   （`backend` 参数），不注入时用 `YamlNoopBackend`（**不监视**）。
   要真监视得由宿主接一个实现（例如 `watchdog`）—— 这属于宿主能力，不是引擎逻辑。
2. 回调**来自后端线程**，所以 `SyllableBasedPhonemizer` 传给它的 lambda 里
   才需要 `Thread.Sleep(200)` 那种"等写盘落定"的粗糙处理 —— 照搬。
"""

import logging
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

#: 监视的扩展名（对应 `watcher.Filter = "*.yaml"`）
WATCH_FILTER = '*.yaml'


class YamlNoopBackend:
    """不监视任何东西的后端（默认）。语义同 `oto_watcher._NoopBackend`。"""

    def start(self, path: str, on_change: Callable[[str, str], None],
              on_error: Callable[[BaseException], None], file_filter: str,
              recursive: bool) -> None:
        return None

    def stop(self) -> None:
        return None


class YamlWatcher:
    """对应 `YamlWatcher`。

    后端需实现：
        start(path, on_change, on_error, file_filter, recursive) -> None
        stop() -> None

    `on_change(full_path, change_type)` 由后端在文件变动时调用
    （`change_type` 对应 C# 的 `WatcherChangeTypes`，取值随意，只用于日志）。
    """

    def __init__(self, path: str, reload_callback: Optional[Callable[[], None]] = None,
                 backend: Optional[Any] = None):
        #: 对应 `public bool Paused { get; set; }`（默认 false）
        self.paused = False
        self.reload_callback = reload_callback
        self.backend = backend if backend is not None else YamlNoopBackend()
        self.backend.start(path, self.on_file_changed, self.on_error,
                           WATCH_FILTER, True)

    # ---- 后端回调

    def on_file_changed(self, full_path: str, change_type: str = '') -> None:
        """对应 `OnFileChanged`：暂停中直接返回，否则调回调。"""
        if self.paused:
            return
        logger.info('YAML File "%s" %s', full_path, change_type)
        if self.reload_callback is not None:
            self.reload_callback()

    def on_error(self, err: BaseException) -> None:
        """对应 `OnError`：只记日志，不抛。"""
        logger.error('YAML Watcher error %s', err)

    # ---- IDisposable

    def dispose(self) -> None:
        """对应 `Dispose()`：只停后端（**不**把 `paused` 复位）。"""
        self.backend.stop()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.dispose()
        return False

# -*- coding: utf-8 -*-
"""渲染引擎 —— **照搬** `OpenUtau.Core/Render/RenderEngine.cs`（542 行）里
**渲染器接口需要的那一小块**：`Progress`。

`RenderEngine` 本体（乐句调度、`RenderPartRequest`、混音、Xsy 混合缓存…）属于
编辑器侧（M3），后面的渲染器只要 `IRenderer.Render(phrase, progress, ...)` 能拿到
一个"计数 + 上报"的对象就够了。所以这里先只搬 `Progress`，
文件边界与 C# 一致，内容随 P4 补齐。

## 与 C# 的载体差异（不是行为差异）
- **合并派发（coalescing）交给宿主**。C# 的 `Progress.Dispatch()` 里那套
  "最多一个 UI 投递在飞、期间到来的更新只改 pending 值"是为了**不要刷爆 UI**，
  而它调用的是 `DocManager.Inst.ExecuteCmd(new ProgressBarNotification(...))`
  与 `DocManager.Inst.MainScheduler` —— 两者都是编辑器层的（M3）。
  这里只保留 `total / completed / complete / clear` 与一次**通知回调**，
  合并策略由宿主在回调里自己决定。
- `ProgressBarNotification`（UI 通知对象）不产生；`notify(progress, info)` 直接
 给百分比与文案。
"""

import threading
from typing import Callable, Optional

#: 收到 `(progress_percent, info)` 的回调；默认丢弃（无 UI 的宿主）
NotifyCallback = Callable[[float, str], None]


class Progress:
    """对应 C# 的 `Progress`：累加已完成数，并把百分比 + 文案报给宿主。

    ★ `total = 0` 时两边不一样：C# 的 `completed * 100.0 / 0` 得 **NaN** 继续走，
    Python 会抛 `ZeroDivisionError`。这里选择**让它抛** —— `total = 0` 是调用方
    没算好总步数，静默给个 NaN 只会让"进度条不动"更难查。
    """

    def __init__(self, total: int, notify: Optional[NotifyCallback] = None):
        self.total = total
        self.completed = 0
        self._notify = notify
        self._lock = threading.Lock()

    def complete(self, n: int, info: str) -> None:
        """对应 `Complete(int n, string info)`：累加并上报 `completed * 100 / total`。"""
        with self._lock:
            self.completed += n
            progress = self.completed * 100.0 / self.total
        self._report(progress, info)

    def clear(self) -> None:
        """对应 `Clear()`：报一次 0 与空文案（**不动** completed 计数）。"""
        self._report(0.0, '')

    def _report(self, progress: float, info: str) -> None:
        if self._notify is not None:
            self._notify(progress, info)

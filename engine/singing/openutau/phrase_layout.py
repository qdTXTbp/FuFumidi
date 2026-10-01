# -*- coding: utf-8 -*-
"""乐句渲染结果的时域排布 —— **照搬** `OpenUtau.Core/Render/PhraseLayout.cs`（全文件）。

语义（C# 注释原文的要点）：`[StartMs, EndMs)` 是该乐句渲染音频在**绝对毫秒**上的
区间，**含**引导段（leading pre-utter）与释放尾（release tail），与混音用的槽位
布局一致。乐句不可变，`Layout` 只取决于乐句与它的渲染器，因此构建时算一次即可。

构造入参顺序为 `(start_ms, end_ms, leading_ms, estimated_ms)` —— 注意第 4 个是
**估算长度**而不是结束时刻（C# 里字段名就是 `EstimatedMs`）。
"""

from dataclasses import dataclass


@dataclass
class PhraseLayout:
    """对应 C# 的 `readonly struct PhraseLayout`。"""

    start_ms: float = 0.0
    end_ms: float = 0.0
    leading_ms: float = 0.0
    estimated_ms: float = 0.0

    @property
    def range(self):
        """对应 C# 的 `Range => (StartMs, EndMs)`。"""
        return (self.start_ms, self.end_ms)

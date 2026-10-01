# -*- coding: utf-8 -*-
"""渲染器接口 —— 照搬 `OpenUtau.Core/Render/IRenderer.cs`（146 行）。

这是 OpenUTAU「编辑器与引擎解耦」的一半：渲染器只管"给定乐句 → 出波形/音高曲线"，
音素怎么切、界面怎么画都与它无关。所以我们移植引擎时，接口照搬这一份即可。

## 照搬时保留的语义（不要"优化"掉）
- `supports_*` 三个能力开关都**有默认值**，且默认是「不支持 render pitch、
  不支持 real curve、支持音素包络」—— 与 C# 一致。
- `phrase_padding()` 默认 `(0, 0)`；`should_merge_phrases()` 的默认实现就是调
  `gap_overlaps_padding()`（**共享测试**，不是两套逻辑）。
- `load_rendered_pitch` 有两个重载；`selected_note_positions` 版默认忽略选区、
  退化成无参版 —— 这个默认行为要保留，否则子类不实现就会报错。
- `load_rendered_real_curves` 默认返回**空列表**（不是 None）。
- `expression_graph_slot` 默认是自己（`ToString()`）—— 渲染同一批表达式的渲染器可共享一个槽位。

## 依赖尚未照搬的类型（M2-a 剩余）
`RenderPhrase` / `UPhoneme` / `USinger` / `UProject` / `UTrack` / `URenderSettings`
这里只作类型标注用（`Any`），对应 C# 的完整移植是下一步。
"""

from abc import ABC, abstractmethod

# USingerType 与 SingerTypeUtils 的正主在 singer.py（对应 USinger.cs），这里转发以便
# 沿用 `from singing.openutau.renderer import USingerType` 的写法。
from .singer import SINGER_TYPE_FROM_NAME, SINGER_TYPE_NAMES, USingerType  # noqa: F401
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional, Sequence, Tuple


@dataclass
class RenderResult:
    """一个乐句的渲染结果（对应 C# `RenderResult`）。"""

    samples: Any = None                 # float32 单声道
    leading_ms: float = 0.0             # 音符起点前的引导段长度
    position_ms: float = 0.0            # 非引导样本相对乐句起点的位置
    estimated_length_ms: float = 0.0    # 渲染前估算长度（供 UI 先占位）


@dataclass
class RenderPitchResult:
    """帧级音高结果（对应 C# `RenderPitchResult`）。

    注意 `voiced` 的语义：Padding 与音素间空隙即使模型给了正值，也**不是**有意义音高，
    调用方不得据此生成曲线点；`voiced is None` 表示渲染器不报休止，认为每帧都有声。
    """

    ticks: List[float] = field(default_factory=list)       # 相对乐句起点
    tones: List[float] = field(default_factory=list)       # MIDI 半音
    retake_mask: Optional[List[bool]] = None               # None = 整段重录
    voiced: Optional[List[bool]] = None


@dataclass
class RenderRealCurveResult:
    """一条"真实曲线"（对应 C# `RenderRealCurveResult`）。"""

    abbr: str = ''
    ticks: List[float] = field(default_factory=list)
    values: List[float] = field(default_factory=list)      # 归一化到 0..1


class RenderPhraseEvents:
    """渲染过程事件（对应 C# `RenderPhraseEvents`）：把真实曲线回报给宿主。"""

    def __init__(self, real_curves_callback: Optional[Callable[[Sequence[RenderRealCurveResult]], None]] = None):
        self._cb = real_curves_callback

    def report_real_curves(self, real_curves: Sequence[RenderRealCurveResult]) -> None:
        if real_curves and len(real_curves) > 0 and self._cb is not None:
            self._cb(real_curves)


class IRenderer(ABC):
    """乐句渲染器接口（对应 C# `IRenderer`）。"""

    #: 该渲染器服务的歌手类型
    singer_type: str = USingerType.CLASSIC

    def __str__(self) -> str:
        """对应 C# 的默认 `Object.ToString()` —— 返回**类型全名**，不是对象地址。

        ★ 别删这个覆盖：`RenderPhrase.Hash()` 里有一项就是 `renderer?.ToString()`。
        Python 默认的 `str(obj)` 会把内存地址拼进去，于是"每次重建渲染器实例"
        都会得到不同的哈希 —— 缓存会静默失效（每次都当成新输入重算），
        排查起来极难。C# 的默认 ToString() 只给类型名，这里对齐它。
        子类若要区分同一类型的不同配置，应**自己**覆盖 `__str__`（C# 里也是这么做的）。
        """
        return '%s.%s' % (type(self).__module__, type(self).__name__)

    @property
    def supports_render_pitch(self) -> bool:
        return False

    @property
    def supports_real_curve(self) -> bool:
        return False

    @property
    def supports_phoneme_envelope(self) -> bool:
        return True

    @abstractmethod
    def supports_expression(self, descriptor) -> bool:
        """该渲染器是否支持某个表达式描述符。"""

    @abstractmethod
    def layout(self, phrase) -> RenderResult:
        """在不合成的情况下给出时长/位置等布局信息。"""

    def phrase_padding(self, singer, phonemes) -> Tuple[float, float]:
        """渲染器在首音素前 / 末音素后各留多少 ms 的余量（默认 0）。"""
        return (0.0, 0.0)

    def should_merge_phrases(self, project, track, prev, next_) -> bool:
        return self.gap_overlaps_padding(self, track, prev, next_)

    @staticmethod
    def gap_overlaps_padding(renderer: 'IRenderer', track, prev, next_) -> bool:
        """`should_merge_phrases()` 背后的共享测试：间隙小于余量之和 → 应合并成一个乐句。"""
        if prev is None or next_ is None:
            return False
        gap_ms = next_.position_ms - prev.end_ms
        _, tail_ms = renderer.phrase_padding(track.singer, [prev])
        head_ms, _ = renderer.phrase_padding(track.singer, [next_])
        return gap_ms < head_ms + tail_ms

    @abstractmethod
    async def render(self, phrase, progress=None, track_no: int = 0, cancellation=None,
                     is_pre_render: bool = False,
                     render_events: Optional[RenderPhraseEvents] = None) -> RenderResult:
        """异步渲染乐句。"""

    @abstractmethod
    def load_rendered_pitch(self, phrase, selected_note_positions=None) -> RenderPitchResult:
        """读取已渲染的音高。带选区版本默认忽略选区、退化为全量。"""

    def load_rendered_real_curves(self, phrase) -> List[RenderRealCurveResult]:
        return []

    def schedule_real_curve_refresh(self, project, part, command) -> None:
        pass

    @abstractmethod
    def get_suggested_expressions(self, singer, render_settings) -> list:
        """该渲染器建议暴露的表达式描述符列表。"""

    @property
    def expression_graph_slot(self) -> str:
        """本渲染器使用哪个表达式图槽位：默认就是自己。"""
        return str(self)

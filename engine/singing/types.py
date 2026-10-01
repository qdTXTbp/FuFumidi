# -*- coding: utf-8 -*-
"""singing 抽象层的公共数据类型。

命名与字段**刻意对齐 OpenUTAU**（见 `OpenUtau.Core/Render/IRenderer.cs` 的
`RenderResult` / `RenderPitchResult`，以及 `OpenUtau.Core/Ustx/UPhoneme.cs`），
这样 M2 起移植渲染器/音素化器时，两边的语义可以直接对照，不用二次翻译。

单位约定（与 OpenUTAU 一致）：
- 时间：毫秒（ms）；音高：Hz；音高偏差：音分（cent）。
- 音素位置 `position_ms` 相对**音符起点**。
"""

from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple


# ---------------------------------------------------------------- 渲染结果

@dataclass
class RenderResult:
    """一个乐句的渲染结果（对齐 OpenUTAU RenderResult）。"""

    samples: Any                      # np.ndarray, float32, 单声道
    sample_rate: int = 44100
    # 前导样本长度：拼接式合成里音符起点前的那段（如 UTAU 的 preutterance/overlap）
    leading_ms: float = 0.0
    # 非前导样本的起始位置（相对乐句起点）
    position_ms: float = 0.0
    # 渲染前估算的时长（供 UI 先占位，避免等渲染完成才知道长度）
    estimated_length_ms: float = 0.0


@dataclass
class RenderPitchResult:
    """帧级音高结果（对齐 OpenUTAU RenderPitchResult）。"""

    ticks: List[float] = field(default_factory=list)   # 相对乐句起点的帧位置
    f0: List[float] = field(default_factory=list)      # Hz，0 表示无声


# ---------------------------------------------------------------- 音素

@dataclass
class Phoneme:
    """一个音素（对齐 OpenUTAU UPhoneme 的关键字段）。"""

    phoneme: str = ''
    position_ms: float = 0.0                       # 相对音符起点
    preutter_ms: float = 0.0
    overlap_ms: float = 0.0
    # 5 点包络（对齐 OpenUTAU envelope.data[0..4]）：
    #   (p, a, b, c, d) = 前段 / 线性起点 / 加速起点 / 加速终点(100) / 释放
    env: Tuple[float, float, float, float, float] = (0.0, 0.0, 100.0, 100.0, 0.0)
    muted: bool = False
    error: str = ''
    # 引擎私有附加信息（如 oto 的 filename/offset/blank），不参与跨引擎比较
    meta: dict = field(default_factory=dict)


@dataclass
class PhonemizedNote:
    """一个音符音素化后的结果。"""

    index: int = 0
    lyric: str = ''
    phonemes: List[Phoneme] = field(default_factory=list)


# ---------------------------------------------------------------- 请求/上下文

@dataclass
class RenderRequest:
    """渲染请求。notes 沿用现有 IPC 里的音符结构（beat 单位），不另造一套。"""

    notes: List[dict] = field(default_factory=list)
    bpm: float = 120.0
    sample_rate: int = 44100
    device: str = 'auto'
    # 引擎私有参数（UTAU 的 flags/gender/breath…、DiffSinger 的 depth/steps…）
    params: dict = field(default_factory=dict)
    # 选区渲染时的音符时间轴平移量（秒）；与 engine_diffsinger 现有语义一致
    origin_sec: float = 0.0


@dataclass
class RenderContext:
    """渲染上下文：声库位置、告警收集、跨音符缓存。"""

    voicebank_dir: str = ''
    sample_rate: int = 44100
    device: str = 'auto'
    warnings: List[str] = field(default_factory=list)
    cache: dict = field(default_factory=dict)
    # 已加载的引擎侧对象（如 engine_utau.Voicebank），避免一个乐句里重复解析
    loaded: dict = field(default_factory=dict)

    def warn(self, msg: str) -> None:
        if msg and msg not in self.warnings:
            self.warnings.append(msg)


def envelope_default() -> Tuple[float, float, float, float, float]:
    """OpenUTAU 的默认包络（直线起止、满幅）。"""
    return (0.0, 0.0, 100.0, 100.0, 0.0)

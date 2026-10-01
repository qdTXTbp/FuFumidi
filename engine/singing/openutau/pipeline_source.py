# -*- coding: utf-8 -*-
"""渲染流水线的输入契约 —— 照搬 `OpenUtau.Core/Pipeline/PhraseSource.cs`（548 行）里的
`NoteSource` / `VibratoSource` / `CurveSource` / `PhonemeSource` / `PhraseSource`。

这一层是「渲染器的输入」：`RenderPhrase` / `RenderNote` / `RenderPhone` 的构造函数
都只吃这几个结构的字段。把它们先照搬到位，渲染器那三个类才能按原文转写。
（C# 里这些字段多为 `{ get; private set; }`，由 `PhraseSource` 的构造函数填充；
Python 侧作为纯数据类，字段名与 C# 逐一对齐。）

## 与 C# 的等价性差异
- 少数字段的类型来自我们尚未照搬的模块（`PartId` / `DocRevision` / 表达式图程序 /
  `PhonemeAnchors`），这里用 `Any` 占位并注明 —— 属于"类型未搬"，不是行为差异。
- `VibratoSource.In` / `.Out` 在 C# 里是 `In`/`Out`（`in`/`out` 在 Python 是关键字），
  这里写作 `vib_in` / `vib_out`。
- `VibratoSource.Evaluate` / `EvaluateVolume` 与 `CurveSource.Sample` / `Empty` 是
  **行为**（不只是数据），必须逐位复刻实时版：`RenderPhrase` 的音高/动态全靠它们。
- MOD+ 段落依赖 `ClassicSinger`/`OtoFrq`（尚未照搬）：`PhraseSource.classic_singer`
  当前恒为 None，故 `RenderPhrase` 里那条分支不会走到。
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import bisect
import math

# C# 里这几处用的都是 System.Numerics.Vector2；ustx 包已为同一用途照搬了它。
from ..ustx.model import PitchPoint, Vector2
from .music_math import MusicMath, fdiv


@dataclass
class VibratoSource:
    """对应 PhraseSource.cs 的 VibratoSource。

    ★ `evaluate` / `evaluate_volume` 的算式必须与实时版（`UVibrato.Evaluate` /
    `EvaluateVolume`）**逐位一致** —— C# 注释里就是这么要求的：乐句快照一旦与
    实时值有偏差，渲染出来的颤音就会与编辑器里画的不一样。
    """

    length: float = 0
    period: float = 0
    depth: float = 0
    vib_in: float = 0
    vib_out: float = 0
    shift: float = 0
    drift: float = 0
    vol_link: float = 0

    @property
    def normalized_start(self) -> float:
        """`1 - Length / 100`（对应 C# 的 NormalizedStart）。"""
        return 1.0 - self.length / 100.0

    def evaluate(self, n_pos: float, n_period: float, note: 'NoteSource') -> Vector2:
        """在归一化位置 `n_pos` 上求颤音，返回 `Vector2(tick, noteNum)`。

        注意返回值第二个分量是**音高号**（`AdjustedTone + y / 100`），
        不是"音分" —— 调用方（RenderPhrase）会再乘 100 转成音分。
        """
        n_start = self.normalized_start
        n_in = self.length / 100.0 * self.vib_in / 100.0
        n_in_pos = n_start + n_in
        n_out = self.length / 100.0 * self.vib_out / 100.0
        n_out_pos = 1.0 - n_out
        t = fdiv(n_pos - n_start, n_period) + self.shift / 100.0
        y = math.sin(2 * math.pi * t) * self.depth + (self.depth / 100 * self.drift)
        if n_pos < n_start:
            y = 0
        elif n_pos < n_in_pos:
            y *= fdiv(n_pos - n_start, n_in)
        elif n_pos > n_out_pos:
            y *= fdiv(1.0 - n_pos, n_out)
        return Vector2(note.position + note.duration * n_pos, note.adjusted_tone + y / 100.0)

    def evaluate_volume(self, n_pos: float, n_period: float) -> float:
        """在归一化位置 `n_pos` 上求颤音联动的音量倍率。

        ⚠ **OpenUTAU 自身在这里有个不一致，我们跟的是"快照版"**：

        | | 实时版 `UVibrato.EvaluateVolume`（UNote.cs:389） | 快照版 `VibratoSource.EvaluateVolume`（PhraseSource.cs:114） |
        |---|---|---|
        | 相位项 | `shift / 100f` —— 用的是**局部变量** `shift` | `Shift / 100f` —— 用的是**属性** `Shift` |

        两版都有 `float shift = Shift; if (volLink < 0) { shift += 50; ... }` 这段，
        但在**快照版里那个局部 `shift` 算完就没人用了**（死代码），于是"反相颤音"
        （`volLink < 0`）在实时版会整体平移 50% 相位，在快照版**不会**。
        也就是说：编辑器画的音量颤音与渲染出来的音量颤音对不上。

        `RenderPhrase` 读的是**快照版**，所以渲染结果以快照版为准 —— 这里照搬快照版
        （即上面 `t` 用 `self.shift`）。这是**照搬来的既有行为**，不是笔误；
        将来若要"修好"，应当作为一处显式的行为变更记录，而不是顺手改掉。
        """
        n_start = self.normalized_start
        n_in = self.length / 100.0 * self.vib_in / 100.0
        n_in_pos = n_start + n_in
        n_out = self.length / 100.0 * self.vib_out / 100.0
        n_out_pos = 1.0 - n_out
        shift = self.shift
        vol_link = self.vol_link
        if vol_link < 0:
            shift += 50
            if shift > 100:
                shift -= 100
            vol_link *= -1
        # ↑ 局部 `shift` 到此为止 —— 快照版随后用的是属性 Shift（见上文说明）
        t = fdiv(n_pos - n_start, n_period) + self.shift / 100.0
        reduction = (-math.sin(2 * math.pi * t) / 2 + 0.3) * vol_link / 100
        if n_pos < n_start:
            reduction = 0
        elif n_pos < n_in_pos:
            reduction *= fdiv(n_pos - n_start, n_in)
        elif n_pos > n_out_pos:
            reduction *= fdiv(1.0 - n_pos, n_out)
        return 1 - reduction


@dataclass
class CurveSource:
    """对应 PhraseSource.cs 的 CurveSource。"""

    abbr: str = ''
    xs: List[int] = field(default_factory=list)
    ys: List[int] = field(default_factory=list)
    default_y: int = 0
    min: float = 0

    @property
    def is_empty(self) -> bool:
        return not self.xs or not self.ys

    @classmethod
    def empty(cls, abbr: str, default_y: int, min_: float) -> 'CurveSource':
        """对应 C# 的 `CurveSource.Empty`：一条**缺失**的曲线，采样恒返回默认值。"""
        return cls(abbr=abbr, xs=[], ys=[], default_y=default_y, min=min_)

    def sample(self, x: int) -> int:
        """按 `UCurve.Sample` 的同一套规则采样（必须逐位一致）。

        C# 原文用 `Array.BinarySearch`：命中直接取 Ys；未命中时用**插入点**
        `~idx`，仅当插入点在 `(0, len)` 之间才在两邻点间线性插值，否则回落默认值。
        Python 用 `bisect_left` 复刻这一语义。
        """
        xs = self.xs
        i = bisect.bisect_left(xs, x)
        if i < len(xs) and xs[i] == x:
            return self.ys[i]
        if 0 < i < len(xs):
            # 注意 C# 的 Math.Round 默认是「四舍六入五成双」，Python 的 round() 同语义。
            return int(round(MusicMath.linear(xs[i - 1], xs[i], self.ys[i - 1], self.ys[i], x)))
        return self.default_y



@dataclass
class NoteSource:
    """对应 PhraseSource.cs 的 NoteSource。"""

    index: int = 0
    position: int = 0
    duration: int = 0
    end: int = 0
    extended_duration: int = 0
    lyric: str = ''
    tone: int = 0
    tuning: int = 0
    adjusted_tone: float = 0
    duration_ms: float = 0
    # 邻接关系用**下标**表示（-1 表示无），不是引用 —— 与 C# 一致
    prev: int = -1
    next: int = -1
    extends: int = -1
    vibrato: Optional[VibratoSource] = None
    pitch_points: List[PitchPoint] = field(default_factory=list)


@dataclass
class PhonemeSource:
    """对应 PhraseSource.cs 的 PhonemeSource。"""

    position: int = 0
    duration: int = 0
    end: int = 0
    position_ms: float = 0
    duration_ms: float = 0
    end_ms: float = 0
    preutter: float = 0
    overlap: float = 0
    tail_intrude: float = 0
    tail_overlap: float = 0
    leading: int = 0
    prev_adjacent: bool = False
    next_adjacent: bool = False
    phoneme: str = ''
    tone: int = 0
    note_index: int = 0
    tempos: List[Any] = field(default_factory=list)           # UTempo[]
    note_tempos: List[Any] = field(default_factory=list)      # UTempo[]
    tempo: float = 0
    adjusted_tempo: float = 0
    resampler: str = ''
    # (flag, 值或 None, 表达式缩写)
    flags: List[Tuple[str, Optional[int], str]] = field(default_factory=list)
    suffix: str = ''
    suffix2: Optional[str] = None
    volume: float = 0
    velocity: float = 0
    modulation: float = 0
    direct: bool = False
    tone_shift: int = 0
    envelope: List[Vector2] = field(default_factory=list)
    vel_raw: float = 0
    modp_raw: float = 0
    driven: Optional[Dict[str, float]] = None
    values: Optional[Dict[str, float]] = None
    oto: Any = None
    oto2: Any = None


@dataclass
class PhraseSource:
    """对应 PhraseSource.cs 的 PhraseSource（一个乐句的全部输入）。"""

    part_id: Any = None                        # PartId（未照搬，占位）
    revision: Any = None                       # DocRevision（未照搬，占位）
    generation: int = 0
    part_position: int = 0
    axis: Any = None                           # TimeAxis
    default_bpm: float = 0
    singer: Any = None                         # USinger
    renderer: Any = None                       # IRenderer
    resampler: str = ''
    wavtool: str = ''
    classic_singer: Any = None                 # ClassicSinger（未照搬，占位）
    modp_supported: bool = False
    notes: List[NoteSource] = field(default_factory=list)
    curves: List[CurveSource] = field(default_factory=list)
    curve_descriptors: List[Any] = field(default_factory=list)
    xsy_available: bool = False
    resolution: int = 0
    curve_defaults: Dict[str, int] = field(default_factory=dict)
    expression_graph: Any = None               # ExpressionGraphProgram（未照搬，占位）
    masked_curves: Optional[Dict[str, Any]] = None
    phoneme_anchors: Any = None                # PhonemeAnchors（未照搬，占位）
    flag_expressions: List[Any] = field(default_factory=list)
    drivable_phoneme_expressions: Dict[str, Any] = field(default_factory=dict)
    phonemes: List[PhonemeSource] = field(default_factory=list)

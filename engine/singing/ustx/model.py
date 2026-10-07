# -*- coding: utf-8 -*-
"""`.ustx` 数据模型 —— **照搬** OpenUTAU（`OpenUtau.Core/Ustx/*.cs`）。

## 照搬约定（务必遵守，别自作主张）
- **字段名 = YAML 键**：OpenUTAU 用 `UnderscoredNamingConvention`，
  即 C# 的 `ustxVersion` / `fileDurationMs` / `TrackName` 序列化成
  `ustx_version` / `file_duration_ms` / `track_name`。
  所以这里 Python 属性名**直接写成下划线形式**，YAML 键天然一致，不需要映射表。
- `[YamlIgnore]` 的成员在这里用 `metadata={'yaml': False}` 标记，写盘时跳过。
- `null` 一律不写（对应 `DefaultValuesHandling.OmitNull`）。
- 枚举按**名字**存（YamlDotNet 默认行为）：如 `shape: io`、`type: Numerical`。
- 字段顺序 = 声明顺序 = 写盘顺序。

对应关系（便于逐项对照）：
    UProject→UProject.cs · UTrack→UTrack.cs · UPart/UVoicePart/UWavePart→UPart.cs
    UNote/UPitch/UVibrato/PitchPoint→UNote.cs · UExpression*→UExpression.cs
    UCurve→UCurve.cs · UMaskedCurve→UMaskedCurve.cs · UMixFx→UMixFx.cs
    UPhonemeOverride→UPhoneme.cs · UTempo/UTimeSignature→UProject.cs
"""

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# --- 标记：对应 C# 的 [YamlIgnore] ---
NO_YAML = {'yaml': False}


class PitchPointShape:
    """对应 UNote.cs 的 `enum PitchPointShape`（序列化为名字）。

    五个值都要在：`io/l/i/o/sp`。`i`（SineIn）/`sp`（Spline）在 `RenderPhrase`
    构建音高时会被显式判断，漏掉它们会让弯音形状静默退化成 io。
    """

    IO = 'io'   # SineInOut
    L = 'l'     # Linear
    I = 'i'     # SineIn
    O = 'o'     # SineOut
    SP = 'sp'   # Spline


class UExpressionType:
    """对应 UExpression.cs 的 `enum UExpressionType : int`（序列化为名字）。"""

    NUMERICAL = 'Numerical'
    OPTIONS = 'Options'
    CURVE = 'Curve'
    MASKED_CURVE = 'MaskedCurve'


# 默认表达式选择器（UProject.expSelectors 的默认值，取自 Format.Ustx 常量）
DEFAULT_EXP_SELECTORS = ['dyn', 'pitd', 'clr', 'eng', 'vel', 'vol', 'atk', 'dec', 'gen', 'bre']


@dataclass
class UTempo:
    position: int = 0
    bpm: float = 120


@dataclass
class UTimeSignature:
    bar_position: int = 0
    beat_per_bar: int = 4
    beat_unit: int = 4


@dataclass
class UMixFx:
    """对应 UMixFx.cs。空值(null)表示未配置 FX。"""

    enabled: bool = False
    eq_enabled: bool = True
    comp_enabled: bool = True
    reverb_enabled: bool = True
    eq_preset: str = 'vocal_air'
    comp_preset: str = 'gentle'
    reverb_preset: str = 'small_room'
    eq_low_db: float = 0.0
    eq_mid_freq: float = 3000.0
    eq_mid_db: float = 1.5
    eq_high_db: float = 3.0
    comp_threshold_db: float = -18.0
    comp_ratio: float = 2.0
    comp_makeup_db: float = 2.5
    reverb_size: float = 0.30
    reverb_damp: float = 0.7
    reverb_wet: float = 1.0
    reverb_pre_delay_ms: float = 0.0


@dataclass
class UExpressionDescriptor:
    """对应 UExpression.cs 的 UExpressionDescriptor。"""

    name: str = ''
    abbr: str = ''
    type: str = UExpressionType.NUMERICAL
    min: float = 0
    max: float = 100
    default_value: float = 0
    # C# 里是 `public float? _customDefaultValue = null; // made public for inclusion in YAML`
    # —— 它**会**进 YAML（键名 `_custom_default_value`，前导下划线保留），别当成私有字段漏掉。
    _custom_default_value: Optional[float] = None
    is_flag: bool = False
    flag: str = ''
    options: Optional[List[str]] = None
    skip_output_if_default: bool = False

    @property
    def custom_default_value(self) -> float:
        """对应 UExpression.cs 的 `CustomDefaultValue => _customDefaultValue ?? defaultValue`。"""
        return self._custom_default_value if self._custom_default_value is not None else self.default_value

    @custom_default_value.setter
    def custom_default_value(self, value: float) -> None:
        # 等于 defaultValue 时归一为 None（与 C# setter 一致，写盘时就不多带一个键）
        self._custom_default_value = None if value == self.default_value else value

    # ---------------------------------------------------------------- UExpression.cs 的成员

    def clone(self) -> 'UExpressionDescriptor':
        """对应 `UExpressionDescriptor.Clone()`：逐字段复制（**含** `CustomDefaultValue`）。"""
        return UExpressionDescriptor(
            name=self.name, abbr=self.abbr, type=self.type, min=self.min, max=self.max,
            default_value=self.default_value, _custom_default_value=self._custom_default_value,
            is_flag=self.is_flag, flag=self.flag,
            options=list(self.options) if self.options is not None else None,
            skip_output_if_default=self.skip_output_if_default)

    def create(self) -> 'UExpression':
        """对应 `UExpressionDescriptor.Create()`：造一个**取值等于默认值**的表达式实例。

        上游有个同名的静态 `UExpression.Create(descriptor)`，作用一样；
        这里放在 descriptor 上作为实例方法，调用点用 `desc.create()`。
        """
        return UExpression(index=None, abbr=self.abbr, descriptor=self,
                           _value=self.default_value)

    def __str__(self) -> str:
        """对应 `ToString() => $"{abbr.ToUpper()}: {name}"`。"""
        return '%s: %s' % (self.abbr.upper(), self.name)

    def equals(self, other) -> bool:
        """对应 `Equals(UExpressionDescriptor other)`。

        ★ **没有 options 与空 options 视为相同**（上游注释原话：
          "No options and an empty list of them mean the same"）。
          这直接影响 `dataclass` 生成的 `__eq__` —— 那个不做这个归一，
          所以这里手写而不是用 `__eq__`。
        """
        if other is None:
            return False
        this_opts = self.options or []
        other_opts = other.options or []
        return (self.name == other.name and self.abbr == other.abbr
                and self.type == other.type and self.min == other.min
                and self.max == other.max and self.default_value == other.default_value
                and self.flag == other.flag and self.is_flag == other.is_flag
                and list(this_opts) == list(other_opts))


@dataclass
class UExpression:
    """对应 UExpression.cs 的 UExpression（音符上的表达式取值）。

    ★ `value` 的 setter 有**条件夹紧**（照搬自 C#，容易漏）：
      - `descriptor is None` → 原样存（还没绑描述符）
      - `abbr == 'clr'`      → 原样存 —— 语音色存的是**选项下标**，不按 min/max 夹
      - 其余                 → 夹到 `[descriptor.min, descriptor.max]`
    Python 里 `value` 是属性（走 property 夹紧），序列化字段用 `_value` + yaml_name 别名。
    """

    index: Optional[int] = None
    abbr: str = ''
    # [YamlIgnore]：绑定的描述符（提供 min/max）
    descriptor: Any = field(default=None, metadata=NO_YAML)
    _value: float = field(default=0, metadata={'yaml_name': 'value'})

    def __post_init__(self):
        # C# 反序列化走的是 setter，所以载入时同样要夹
        self._value = self._clamp(self._value)

    def _clamp(self, v: float) -> float:
        d = self.descriptor
        if d is None:
            return v
        if self.abbr == 'clr':
            return v
        return min(d.max, max(d.min, v))

    @property
    def value(self) -> float:
        return self._value

    @value.setter
    def value(self, v: float):
        self._value = self._clamp(v)

    def clone(self) -> 'UExpression':
        """对应 `UExpression.Clone()`：复制 `index` 与 `value`（**沿用同一个 descriptor**）。

        ★ 注意 `descriptor` 是**共享引用**（C# `new UExpression(descriptor)` 同样传原引用），
          所以改克隆体的 descriptor 会影响原件 —— 照搬。
        """
        return UExpression(index=self.index, abbr=self.abbr,
                           descriptor=self.descriptor, _value=self._value)


@dataclass
class UPhonemeOverride:
    """对应 UPhoneme.cs 的 UPhonemeOverride。"""

    index: int = 0
    phoneme: Optional[str] = None
    offset: Optional[int] = None
    preutter_delta: Optional[float] = None
    overlap_delta: Optional[float] = None
    attack_time_delta: Optional[float] = None
    release_time_delta: Optional[float] = None

    def clone(self) -> 'UPhonemeOverride':
        """对应 `UPhonemeOverride.Clone()`（逐字段复制，字段全是标量/可空）。"""
        return UPhonemeOverride(
            index=self.index, phoneme=self.phoneme, offset=self.offset,
            preutter_delta=self.preutter_delta, overlap_delta=self.overlap_delta,
            attack_time_delta=self.attack_time_delta,
            release_time_delta=self.release_time_delta)


@dataclass
class Vector2:
    """对应 System.Numerics.Vector2 的用法（包络点用 (x, y)，单位 ms）。

    两个运算符是按 C# 的用法补的（`SharpWavtool` 里 `(envelope[0] + envelope[1]) * 0.5`
    就是 `System.Numerics` 的向量加与**标量**乘），不做组件对组件的乘。
    """

    x: float = 0
    y: float = 0

    def __add__(self, other: 'Vector2') -> 'Vector2':
        return Vector2(self.x + other.x, self.y + other.y)

    def __mul__(self, scalar: float) -> 'Vector2':
        return Vector2(self.x * scalar, self.y * scalar)

    __rmul__ = __mul__


@dataclass
class UEnvelope:
    """对应 UPhoneme.cs 的 UEnvelope：音素包络。

    构造函数默认 5 个点：`(0,0) (0,100) (0,100) (0,100) (0,0)`
    —— 与 OpenUTAU 一致（直线起、满幅、直线落），照搬时不要改成"更合理"的形状。
    """

    data: List[Vector2] = field(default_factory=lambda: [
        Vector2(0, 0), Vector2(0, 100), Vector2(0, 100), Vector2(0, 100), Vector2(0, 0),
    ])


@dataclass
class PitchPoint:
    """对应 UNote.cs 的 PitchPoint。

    `auto_completed` 是 C# 里的 `[YamlIgnore] public bool autoCompleted` ——
    由"自动补全的端点"标记（RenderPhrase 会插入这样的点），不写盘，
    但**渲染时读**：spline 段只在**非**自动补全的点上生效。
    """

    x: float = 0
    y: float = 0
    shape: str = PitchPointShape.IO
    auto_completed: bool = field(default=False, metadata=NO_YAML)

    def clone(self) -> 'PitchPoint':
        """对应 `PitchPoint.Clone()`（含 `autoCompleted` 这个不写盘的运行时标记）。"""
        return PitchPoint(x=self.x, y=self.y, shape=self.shape,
                          auto_completed=self.auto_completed)


@dataclass
class UPitch:
    """对应 UNote.cs 的 UPitch。"""

    data: List[PitchPoint] = field(default_factory=list)
    snap_first: bool = True

    def clone(self) -> 'UPitch':
        """对应 `UPitch.Clone()`：`data` 逐点 Clone，`snapFirst` 一并带走。"""
        return UPitch(data=[p.clone() for p in self.data], snap_first=self.snap_first)


@dataclass
class UVibrato:
    """对应 UNote.cs 的 UVibrato。

    ★ 两个照搬要点（都容易漏）：
    1. **每个量的 setter 都有夹紧**：length∈[0,100] / period∈[5,500] / depth∈[5,200] /
       in,out∈[0,100] / shift∈[0,100] / drift,volLink∈[-100,100]。
    2. **in 与 out 互相约束**：设 in 会把 out 压到 `min(out, 100-in)`，反之亦然。
    3. C# 里这两个属性写作 `@in` / `@out`（关键字转义），YAML 键就是 `in` / `out`；
       Python 的 `in` 是关键字，故字段名用 `vib_in`/`vib_out` + `yaml_name` 别名。
    """

    length: float = 0
    period: float = 175
    depth: float = 25
    vib_in: float = field(default=10, metadata={'yaml_name': 'in'})
    vib_out: float = field(default=10, metadata={'yaml_name': 'out'})
    shift: float = 0
    drift: float = 0
    vol_link: float = 0

    #: 各量的夹紧范围（照搬 C# setter 里的 Math.Max/Min）
    _CLAMP = {
        'length': (0, 100), 'period': (5, 500), 'depth': (5, 200),
        'vib_in': (0, 100), 'vib_out': (0, 100),
        'shift': (0, 100), 'drift': (-100, 100), 'vol_link': (-100, 100),
    }

    def __setattr__(self, name, value):
        rng = UVibrato._CLAMP.get(name)
        if rng and isinstance(value, (int, float)):
            value = max(rng[0], min(rng[1], value))
        object.__setattr__(self, name, value)
        # in/out 的相互约束 —— C# setter 里就写着 `_out = Math.Min(_out, 100 - _in)`
        if name == 'vib_in':
            o = object.__getattribute__(self, 'vib_out')
            object.__setattr__(self, 'vib_out', min(o, 100 - value))
        elif name == 'vib_out':
            i = object.__getattribute__(self, 'vib_in')
            object.__setattr__(self, 'vib_in', min(i, 100 - value))

    def clone(self) -> 'UVibrato':
        """对应 `UVibrato.Clone()`（C# 是 `MemberwiseClone()` —— 逐字段浅拷贝）。

        所有字段都是标量，所以 dataclass 的逐字段构造与之等价。
        ★ 赋值仍走 `__setattr__` 的钳制 —— 值本来就在范围内，不影响结果。
        """
        return UVibrato(
            length=self.length, period=self.period, depth=self.depth,
            vib_in=self.vib_in, vib_out=self.vib_out,
            shift=self.shift, drift=self.drift, vol_link=self.vol_link)


@dataclass
class UNote:
    """对应 UNote.cs 的 UNote。"""

    position: int = 0
    duration: int = 0
    tone: int = 0
    lyric: str = 'a'
    pitch: Optional[UPitch] = None
    vibrato: Optional[UVibrato] = None
    tuning: int = 0
    phoneme_expressions: List[UExpression] = field(default_factory=list)
    phoneme_overrides: List[UPhonemeOverride] = field(default_factory=list)
    # C# 里是 `public string? PhonemizerOverride { get; set; } = null;`（会被序列化）
    # ★ YAML 键是 `phonemizer` 而不是 `phonemizer_override`：C# 标了
    #   `[YamlMember(Alias = "phonemizer", ApplyNamingConventions = false)]`，
    #   YamlDotNet 的 Alias 对读和写**都生效**（YamlAttributesTypeInspector 把
    #   Alias 当属性名用）。照 `phonemizer_override` 读键会把 OpenUTAU 工程
    #   里的音符级音素化器覆写**静默丢掉**。
    #   `legacy_keys` 兼容本仓库旧版误写出的 `phonemizer_override:` 键（只读）。
    phonemizer_override: Optional[str] = field(
        default=None, metadata={'yaml_name': 'phonemizer',
                                'legacy_keys': ('phonemizer_override',)})

    # ---- 以下均为 C# 里 [YamlIgnore] 的运行时成员，照搬其语义（不参与读写）----
    position_ms: float = field(default=0.0, metadata=NO_YAML)
    end_ms: float = field(default=0.0, metadata=NO_YAML)
    extended_duration: int = field(default=0, metadata=NO_YAML)
    prev: Any = field(default=None, metadata=NO_YAML)
    next: Any = field(default=None, metadata=NO_YAML)
    extends: Any = field(default=None, metadata=NO_YAML)
    phonemizer_expressions: List['UExpression'] = field(default_factory=list, metadata=NO_YAML)
    # 所属 part 里该音符的音素下标集合（UPhoneme.SetExpression 用它清理失效项）。
    # C# 里由 part 推出；这里作为运行时属性，由调用方设置，未设置按空集合处理。
    phoneme_indexes: List[int] = field(default_factory=list, metadata=NO_YAML)

    @property
    def end(self) -> int:
        return self.position + self.duration

    @property
    def adjusted_tone(self) -> float:
        """`tone + tuning / 100f` —— 调音以百分之一音为单位叠加在音高上。"""
        return self.tone + self.tuning / 100.0

    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.position_ms

    @property
    def extended_end(self) -> int:
        return self.position + self.extended_duration

    @property
    def left_bound(self) -> int:
        return self.position

    @property
    def right_bound(self) -> int:
        return self.position + self.duration

    # ---------------------------------------------------------------- UNote.cs 的方法

    @staticmethod
    def create() -> 'UNote':
        """对应 `static UNote Create()`：新建一个**已初始化** pitch/vibrato 的音符。

        ★ 必须有默认 pitch/vibrato —— `Clone()` 里是 `pitch.Clone()`（不带 `?.`），
          为 null 会直接 NRE。
        """
        return UNote(pitch=UPitch(), vibrato=UVibrato())

    def clone(self) -> 'UNote':
        """对应 `Clone()`：逐字段复制（`pitch`/`vibrato` **深拷贝**）。

        ★ `phonemeExpressions` / `phonemeOverrides` 里的元素也逐个 Clone；
          `prev`/`next` **不**复制（C# 也没复制）。
        """
        return UNote(
            position=self.position, duration=self.duration, tone=self.tone, lyric=self.lyric,
            pitch=self.pitch.clone() if self.pitch is not None else None,
            vibrato=self.vibrato.clone() if self.vibrato is not None else None,
            tuning=self.tuning,
            phonemizer_override=self.phonemizer_override,
            phoneme_expressions=[e.clone() for e in self.phoneme_expressions],
            phoneme_overrides=[o.clone() for o in self.phoneme_overrides],
            phoneme_indexes=list(self.phoneme_indexes))

    def after_load(self, project, track, part) -> None:
        """对应 `AfterLoad(project, track, part)`：给表达式补 descriptor，并**丢掉补不上的**。

        ★ 读 .ust 时表达式只带 abbr，`descriptor` 要在这里回填；
          轨道上找不到该 abbr 的表达式就地丢弃（不报错）。
        """
        kept = []
        for exp in self.phoneme_expressions:
            descriptor = track.try_get_exp_descriptor(project, exp.abbr)
            if descriptor is not None:
                exp.descriptor = descriptor
                kept.append(exp)
        self.phoneme_expressions = kept

    def before_save(self, project, track, part) -> None:
        """对应 `BeforeSave(project, track, part)`：按 `(index, abbr)` 排序。"""
        self.phoneme_expressions.sort(key=lambda e: (e.index or 0, e.abbr))

    def set_expression(self, project, track, abbr: str, values) -> None:
        """对应 `SetExpression(project, track, abbr, float?[] values)`。

        语义：
          · 轨道上找不到该 abbr 的描述符 → **直接返回**（什么都不做）
          · `values` 为空 → 返回
          · 先**清掉**同 abbr 的旧表达式
          · 循环上界是 `phoneme_indexes` 的末值 + 1；**只处理 `i == 0` 或已在
            phoneme_indexes 里的 i**
          · `values` 不够长时**沿用最后一个值**（`values.Last()`），为 null 则跳过
        """
        descriptor = track.try_get_exp_descriptor(project, abbr)
        if descriptor is None:
            return
        if not values:
            return
        self.phoneme_expressions = [e for e in self.phoneme_expressions
                                    if getattr(e.descriptor, 'abbr', None) != abbr]
        last = (self.phoneme_indexes[-1] + 1) if self.phoneme_indexes else 1
        for i in range(last):
            if not (i == 0 or i in self.phoneme_indexes):
                continue
            value = values[i] if i < len(values) else values[-1]
            if value is None:
                continue
            self.phoneme_expressions.append(
                UExpression(index=i, abbr=abbr, descriptor=descriptor, _value=value))


@dataclass
class UCurve:
    """对应 UCurve.cs 的 UCurve（x 为 tick，y 为取值）。

    `descriptor` 是 C# 里 `[YamlIgnore] public UExpressionDescriptor descriptor;`
    —— 不写盘，但渲染侧要读它（`CurveSource` 从它取 `min` 与 `defaultValue`，
    `Sample` 的回落值也是 `descriptor.defaultValue`）。

    方法区（`Clone` / `IsEmpty` / `IsEmptyBetween` / `Sample` / `Set` / `Simplify` /
    `MergeCurves` / `ReplaceRange`）是后补的 —— 见各自 docstring 的语义说明。
    """

    #: 对应 `public const int interval = 5;`（C# 里是小写 `interval`）
    INTERVAL = 5

    xs: List[int] = field(default_factory=list)
    ys: List[int] = field(default_factory=list)
    abbr: str = ''
    descriptor: Any = field(default=None, metadata=NO_YAML)
    # [YamlIgnore]：Set 之前/之后的原始横坐标（编辑器拖动时用）
    real_xs: List[int] = field(default_factory=list, metadata=NO_YAML)
    real_ys: List[int] = field(default_factory=list, metadata=NO_YAML)

    # ---------------------------------------------------------------- 查找

    @staticmethod
    def _search(xs: List[int], x: int):
        """复刻 C# `List<int>.BinarySearch` 的两段返回。

        C#：命中返回**某个**匹配下标；未命中返回 `~插入点`（按位取反的负数）。
        这里用 `bisect_left` 拿插入点，命中时返回该下标 —— `Insert` 保证 xs 无重复，
        所以两者等价。
        """
        lo, hi = 0, len(xs)
        while lo < hi:
            mid = (lo + hi) // 2
            if xs[mid] < x:
                lo = mid + 1
            else:
                hi = mid
        if lo < len(xs) and xs[lo] == x:
            return True, lo
        return False, lo

    # ---------------------------------------------------------------- 属性

    @property
    def is_empty(self) -> bool:
        """对应 `IsEmpty => xs.Count == 0 || ys.All(y => y == 0)`。"""
        return len(self.xs) == 0 or all(y == 0 for y in self.ys)

    def clone(self) -> 'UCurve':
        """对应 `Clone()`：复制 xs/ys（**不**复制 realXs/realYs，C# 也没复制）。"""
        return UCurve(xs=list(self.xs), ys=list(self.ys), abbr=self.abbr,
                      descriptor=self.descriptor)

    # ---------------------------------------------------------------- 采样

    def sample(self, x: int) -> int:
        """对应 `Sample(x)`：命中取点、之间线性插值、**两边之外回落到 `descriptor.defaultValue`**。"""
        from ..openutau.music_math import MusicMath
        found, idx = self._search(self.xs, x)
        if found:
            return self.ys[idx]
        if idx > 0 and idx < len(self.xs):
            v = MusicMath.linear(self.xs[idx - 1], self.xs[idx],
                                 self.ys[idx - 1], self.ys[idx], x)
            return _round_even(v)
        # ★ 上游直接 `descriptor.defaultValue`（descriptor 为 null 会 NRE）
        if self.descriptor is None:
            return 0
        return self.descriptor.default_value

    def is_empty_between(self, x0: int, x1: int, default_value: int) -> bool:
        """对应 `IsEmptyBetween(x0, x1, defaultValue)`：区间内（含端点）全是默认值。"""
        if self.sample(x0) != default_value or self.sample(x1) != default_value:
            return False
        _found, idx = self._search(self.xs, x0)
        while idx < len(self.xs) and self.xs[idx] <= x1:
            if self.ys[idx] != default_value:
                return False
            idx += 1
        return True

    # ---------------------------------------------------------------- 编辑

    def _insert(self, x: int, y: int) -> None:
        """对应私有 `Insert(x, y)`：同 x 覆盖，否则按序插入。"""
        found, idx = self._search(self.xs, x)
        if found:
            self.ys[idx] = y
            return
        self.xs.insert(idx, x)
        self.ys.insert(idx, y)

    def _delete_between_exclusive(self, x1: int, x2: int) -> None:
        """对应私有 `DeleteBetweenExclusive(x1, x2)`：删掉**开区间** (x1, x2)。"""
        found_l, li = self._search(self.xs, x1)
        li = li + 1 if found_l else li
        found_r, ri = self._search(self.xs, x2)
        ri = ri - 1 if found_r else ri - 1
        if ri >= li:
            del self.xs[li:ri + 1]
            del self.ys[li:ri + 1]

    def set(self, x: int, y: int, last_x: int, last_y: int) -> None:
        """对应 `Set(x, y, lastX, lastY)`：把一段横坐标区间刷成同一个值。

        ★ 三个分支的顺序与"先 `Sample` 再删"不能改：
          · `x == lastX`：在两侧各留一个原值锚点，中间写 y；
          · `x < lastX`：删 (x, lastX)，留左锚点；
          · `x > lastX`：删 (lastX, x)，留右锚点。
        ★ `x` / `lastX` 先**对齐到 interval 的整数倍**（编辑器只能按 5 tick 拖）。
        """
        x = _round_even(x / UCurve.INTERVAL) * UCurve.INTERVAL
        last_x = _round_even(last_x / UCurve.INTERVAL) * UCurve.INTERVAL
        if x == last_x:
            left_y = self.sample(x - UCurve.INTERVAL)
            right_y = self.sample(x + UCurve.INTERVAL)
            self._insert(x - UCurve.INTERVAL, left_y)
            self._insert(x, y)
            self._insert(x + UCurve.INTERVAL, right_y)
        elif x < last_x:
            left_y = self.sample(x - UCurve.INTERVAL)
            self._delete_between_exclusive(x, last_x)
            self._insert(x - UCurve.INTERVAL, left_y)
            self._insert(x, y)
        else:
            right_y = self.sample(x + UCurve.INTERVAL)
            self._delete_between_exclusive(last_x, x)
            self._insert(x, y)
            self._insert(x + UCurve.INTERVAL, right_y)

    # ---------------------------------------------------------------- 抽稀

    def simplify(self) -> None:
        """对应无参 `Simplify()`：整条曲线抽稀，容差 `min(5, (max-min)*0.005)`。"""
        if not self.xs or len(self.xs) < 3:
            return
        first, last = 0, len(self.xs) - 1
        to_keep = [first, last]
        desc = self.descriptor
        tolerance = min(5, (desc.max - desc.min) * 0.005) if desc is not None else 5.0
        self._simplify_range(first, last, tolerance, to_keep)
        to_keep.sort()
        self.xs = [self.xs[i] for i in to_keep]
        self.ys = [self.ys[i] for i in to_keep]

    def _simplify_range(self, first: int, last: int, tolerance: float, to_keep: List[int]) -> None:
        """对应 `Simplify(first, last, tolerance, toKeep)`：找**垂直距离最大**的点递归二分。"""
        max_height, max_height_idx = 0.0, 0
        for index in range(first, last):
            h = _perpendicular_distance(self.xs[first], self.ys[first],
                                       self.xs[last], self.ys[last],
                                       self.xs[index], self.ys[index])
            if h > max_height:
                max_height, max_height_idx = h, index
        if max_height > tolerance and max_height_idx != 0:
            to_keep.append(max_height_idx)
            self._simplify_range(first, max_height_idx, tolerance, to_keep)
            self._simplify_range(max_height_idx, last, tolerance, to_keep)

    # ---------------------------------------------------------------- 合并 / 替换

    @staticmethod
    def merge_curves(*merging) -> List['UCurve']:
        """对应 `static MergeCurves(params List<UCurve>[] merging)`：按 descriptor 合并多组曲线。

        ★ C# 用 `Dictionary<UExpressionDescriptor, UCurve>` —— 键是**对象引用**。
          我们的 `UExpressionDescriptor` 是 dataclass（`eq=True` 会把 `__hash__` 抹掉，
          不可哈希），所以这里用 `id()` 复刻引用语义（与本仓库 `id(note)` 同一套做法）。
        ★ `descriptor` 为 null 的曲线**跳过**（照搬）。
        """
        merged = {}
        for curves in merging:
            for curve in (curves or []):
                if curve.descriptor is None:
                    continue
                key = id(curve.descriptor)
                if key not in merged:
                    merged[key] = curve.clone()
                else:
                    existing = merged[key]
                    zipped = sorted(zip(list(existing.xs) + list(curve.xs),
                                        list(existing.ys) + list(curve.ys)),
                                    key=lambda p: p[0])
                    existing.xs = [x for x, _ in zipped]
                    existing.ys = [y for _, y in zipped]
        return list(merged.values())

    @staticmethod
    def replace_range(xs, ys, clear_min_x: int, clear_max_x: int, points, descriptor):
        """对应 `static (int[] xs, int[] ys) ReplaceRange(...)`。

        返回"把 `[clearMinX, clearMaxX]` 内的点全删掉、再插入 `points`"之后的
        `(xs, ys)`。区间**两侧各补一个锚点**（`±interval`），让区间外的曲线保持原值。
        输入列表**不被修改**。
        """
        from ..openutau.music_math import MusicMath
        xs = list(xs)
        ys = list(ys)
        base = UCurve(xs=list(xs), ys=list(ys), descriptor=descriptor,
                      abbr=(descriptor.abbr if descriptor is not None else ''))
        new_xs, new_ys = [], []
        left_idx, right_idx = -1, len(xs)
        for i in range(len(xs)):
            if clear_min_x <= xs[i] <= clear_max_x:
                continue
            if xs[i] < clear_min_x:
                left_idx = i
            elif right_idx == len(xs):
                right_idx = i
            new_xs.append(xs[i])
            new_ys.append(ys[i])

        anchors = []
        left_anchor = clear_min_x - UCurve.INTERVAL
        if left_idx < 0 or xs[left_idx] < left_anchor:
            if 0 <= left_idx == len(xs) - 1:
                anchors.append(xs[left_idx] + 1)      # 末点之后本就是默认值，保持平
            anchors.append(left_anchor)
        right_anchor = clear_max_x + UCurve.INTERVAL
        if right_idx == len(xs) or right_anchor < xs[right_idx]:
            anchors.append(right_anchor)
            if right_idx == 0 and len(xs) > 0:
                anchors.append(xs[right_idx] - 1)     # 首点之前本就是默认值，保持平
        for x in anchors:
            _insert_sorted(new_xs, new_ys, x, base.sample(x))
        lo = descriptor.min if descriptor is not None else -2 ** 31
        hi = descriptor.max if descriptor is not None else 2 ** 31 - 1
        for x, y in points:
            _insert_sorted(new_xs, new_ys, x, int(min(max(y, lo), hi)))
        return new_xs, new_ys


def _insert_sorted(xs: List[int], ys: List[int], x: int, y: int) -> None:
    """对应 `UCurve` 的私有静态 `InsertSorted`。"""
    found, idx = UCurve._search(xs, x)
    if found:
        ys[idx] = y
    else:
        xs.insert(idx, x)
        ys.insert(idx, y)


def _perpendicular_distance(x: float, y: float, x1: float, y1: float,
                            x2: float, y2: float) -> float:
    """对应私有 `PerpendicularDistance`：点到线段的垂直距离 ×2。

    ★ C# 里 `bottom == 0` 会得到 `Infinity`（double 除零不抛）；Python 会 `ZeroDivisionError`。
      这里显式返回 `inf`（`area` 为 0 时返回 `nan`），与 C# 的浮点语义对齐。
    """
    area = 0.5 * abs(x1 * (y2 - y) + x2 * (y - y1) + x * (y1 - y2))
    bottom = ((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5
    if bottom == 0:
        return float('inf') if area else float('nan')
    return area / bottom * 2


@dataclass
class CurveSelection:
    """对应 `UCurve.cs` 里的 `CurveSelection`（编辑器里框选一段曲线）。

    `xs` / `ys` 是选区内的点（**相对 part 起点**的 tick）。
    """

    abbr: Optional[str] = None
    start_point: Any = (0, 0)
    end_point: Any = (0, 0)
    xs: List[int] = field(default_factory=list)
    ys: List[int] = field(default_factory=list)

    def has_value(self, abbr: Optional[str] = None) -> bool:
        """对应 `HasValue(abbr = null)`：`Abbr != null && (abbr == null || Abbr == abbr)`。"""
        return self.abbr is not None and (abbr is None or self.abbr == abbr)

    def clear(self) -> None:
        """对应 `Clear()`。"""
        self.abbr = None
        self.start_point = (0, 0)
        self.end_point = (0, 0)
        self.xs.clear()
        self.ys.clear()

    def add(self, abbr: str, start_point, end_point, xs, ys) -> None:
        """对应 `Add(abbr, startPoint, endPoint, xs, ys)`。"""
        self.abbr = abbr
        self.start_point = start_point
        self.end_point = end_point
        self.xs.extend(xs)
        self.ys.extend(ys)

    def get_whole_curve_and_selection(self, abbr: str, curve):
        """对应 `GetWholeCurveAndSelection(...)` → `(wholeXs, wholeYs)`。

        先取整条曲线，再把选区**起点**插进对应位置；**仅当 `start.x != end.x`** 时
        才再插终点（起止同 x 只能插一个，否则会出现两个同 x 的点）。
        """
        whole_xs = list(curve.xs) if curve is not None else []
        whole_ys = list(curve.ys) if curve is not None else []
        if not self.has_value(abbr):
            return whole_xs, whole_ys

        def _insert_point(point):
            for i in range(len(whole_xs)):
                if point[0] < whole_xs[i]:
                    whole_xs.insert(i, point[0])
                    whole_ys.insert(i, point[1])
                    return
            whole_xs.append(point[0])
            whole_ys.append(point[1])

        _insert_point(self.start_point)
        if self.start_point[0] != self.end_point[0]:
            _insert_point(self.end_point)
        return whole_xs, whole_ys

    def get_selected_range(self, abbr: Optional[str] = None):
        """对应 `GetSelectedRange(...)` → `(xs, ys)`：起锚点 + 选区内点 + 止锚点。"""
        xs, ys = [], []
        if not self.has_value(abbr):
            return xs, ys
        xs.append(self.start_point[0])
        ys.append(self.start_point[1])
        xs.extend(self.xs)
        ys.extend(self.ys)
        xs.append(self.end_point[0])
        ys.append(self.end_point[1])
        return xs, ys

    def clone(self) -> 'CurveSelection':
        """对应 `Clone()`。"""
        return CurveSelection(abbr=self.abbr, start_point=self.start_point,
                             end_point=self.end_point,
                             xs=list(self.xs), ys=list(self.ys))


def _round_even(v: float) -> int:
    """对应 C# 的 `(int)Math.Round(...)`：默认 **MidpointRounding.ToEven**（银行家舍入）。

    Python 内置 `round()` 对 float 同样采用「就近、遇半取偶」，语义一致。
    """
    return int(round(v))


@dataclass
class UMaskedRun:
    """对应 UMaskedCurve.cs 的 UMaskedRun（一段连续的、按 grid 步进的取值）。"""

    x: int = 0
    ys: List[float] = field(default_factory=list)

    @property
    def end(self) -> int:
        """对应 `End => x + (ys.Length - 1) * UMaskedCurve.interval`。"""
        return self.x + (len(self.ys) - 1) * UMaskedCurve.INTERVAL

    def clone(self) -> 'UMaskedRun':
        """对应 `Clone()`（`ys` 逐元素复制）。"""
        return UMaskedRun(x=self.x, ys=list(self.ys))


@dataclass
class UMaskedCurve:
    """对应 UMaskedCurve.cs 的 UMaskedCurve（有些区段**没有**取值 —— "masked"）。

    与 `UCurve` 的区别：UCurve 每个 x 都有值；UMaskedCurve 只有部分 x 有值，
    用 `runs`（连续段）表达稀疏区段，因此多一套 `to_steps`/`set_steps` 转换。
    """

    #: 对应 `public const int interval = UCurve.interval;`
    INTERVAL = UCurve.INTERVAL

    abbr: str = ''
    runs: List[UMaskedRun] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        """对应 `IsEmpty => runs.All(r => r.ys.Length == 0)`。

        ★ 判据与 `UCurve.IsEmpty` **不同**（那边是"全为 0"）。
        """
        return all(len(r.ys) == 0 for r in self.runs)

    def clone(self) -> 'UMaskedCurve':
        """对应 `Clone()`（`runs` 逐个 Clone）。"""
        return UMaskedCurve(abbr=self.abbr, runs=[r.clone() for r in self.runs])

    @staticmethod
    def snap(tick: float) -> int:
        """对应 `static int Snap(double tick)`：把 tick 对齐到 grid。"""
        return _round_even(tick / UMaskedCurve.INTERVAL) * UMaskedCurve.INTERVAL

    def try_sample(self, tick: float):
        """对应 `TrySample(tick, out value)` → `(bool, float)`：命中返回 `(True, v)`。

        ★ 与 `UCurve.Sample` 不同：**没有覆盖就返回 False**，不回落到默认值 ——
          上层据此判断"这一段是不是被 mask 掉了"。
        """
        return UMaskedCurve._try_sample(self.runs, tick)

    @staticmethod
    def _try_sample(runs, tick: float):
        """对应 `internal static TrySample(IReadOnlyList<UMaskedRun>, double, out float)`。

        二分找"最后一个起点 ≤ tick 的 run"（`runs` 有序且不重叠），段内按 grid 线性插值。
        """
        lo, hi, found = 0, len(runs) - 1, -1
        while lo <= hi:
            mid = (lo + hi) // 2
            if runs[mid].x <= tick:
                found = mid
                lo = mid + 1
            else:
                hi = mid - 1
        if found < 0 or len(runs[found].ys) == 0 or tick > runs[found].end:
            return False, 0.0
        run = runs[found]
        position = (tick - run.x) / UMaskedCurve.INTERVAL
        i = min(int(math.floor(position)), len(run.ys) - 1)
        if i == len(run.ys) - 1:
            return True, run.ys[i]
        return True, run.ys[i] + (position - i) * (run.ys[i + 1] - run.ys[i])

    def to_steps(self) -> Dict[int, float]:
        """对应 `ToSteps()` → `SortedDictionary<int, float>`：按 grid tick 摊平。

        C# 用 `SortedDictionary`（有序）；这里用普通 `dict`（3.7+ 保插入序），
        而写入顺序本就按 x 递增（`runs` 有序），所以等价。
        """
        steps: Dict[int, float] = {}
        for run in self.runs:
            for i, y in enumerate(run.ys):
                steps[run.x + i * UMaskedCurve.INTERVAL] = y
        return steps

    def set_steps(self, steps) -> None:
        """对应 `SetSteps(steps)`：从"按 tick 的字典"**重建** runs（连续步进合成一段）。"""
        self.runs = []
        run = None
        values: List[float] = []
        for x, y in steps.items():
            if run is None or x != run.x + len(values) * UMaskedCurve.INTERVAL:
                if run is not None:
                    run.ys = list(values)
                    self.runs.append(run)
                run = UMaskedRun(x=x)
                values = []
            values.append(y)
        if run is not None:
            run.ys = list(values)
            self.runs.append(run)

    def set(self, x0: int, y0: float, x1: int, y1: float) -> None:
        """对应 `Set(x0, y0, x1, y1)`：从一个 tick 到另一个 tick 画直线，覆盖原值。

        ★ 端点先 `Snap`；`x1 < x0` 时**连同 y 一起交换**；
          `x1 == x0` 时整段取 `y1`（不除零）。
        """
        x0, x1 = UMaskedCurve.snap(x0), UMaskedCurve.snap(x1)
        if x1 < x0:
            x0, y0, x1, y1 = x1, y1, x0, y0
        steps = self.to_steps()
        x = x0
        while x <= x1:
            steps[x] = y1 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / float(x1 - x0)
            x += UMaskedCurve.INTERVAL
        self.set_steps(steps)

    def set_values(self, values) -> None:
        """对应 `SetValues(values)`：按给定 tick 写值（覆盖原值），tick 会 `Snap`。"""
        steps = self.to_steps()
        for x, y in values:
            steps[UMaskedCurve.snap(x)] = y
        self.set_steps(steps)

    def clear(self, x0: int, x1: int) -> None:
        """对应 `Clear(x0, x1)`：删掉 `[x0, x1]` **含两端**的值。"""
        x0, x1 = UMaskedCurve.snap(x0), UMaskedCurve.snap(x1)
        if x1 < x0:
            x0, x1 = x1, x0
        steps = self.to_steps()
        for x in [k for k in steps if x0 <= k <= x1]:
            del steps[x]
        self.set_steps(steps)


def _new_part_id():
    """`Pipeline.PartId.New()` —— 延迟导入。

    `PartId` 属于 `openutau.pipeline_identities`；在顶层 import 它会触发
    `singing.openutau` 的 `__init__`（那里又 import 了 ustx），与 `build_time_axis`
    同一个理由，只能延迟到实例化时再取。
    """
    from ..openutau.pipeline_identities import PartId
    return PartId.new()


@dataclass
class UPart:
    """对应 UPart.cs 的 UPart（基类）。"""

    name: str = 'New Part'
    comment: str = ''
    track_no: int = 0
    position: int = 0
    #: `[YamlIgnore] public Pipeline.PartId Id { get; internal set; } = PartId.New();`
    #: —— 能扛住克隆/剪切粘贴/重新载入的稳定身份，不写盘。
    id: Any = field(default=None, metadata=NO_YAML)

    def __post_init__(self):
        if self.id is None:
            self.id = _new_part_id()


@dataclass
class UVoicePart(UPart):
    """对应 UPart.cs 的 UVoicePart。"""

    duration: int = 0
    notes: List[UNote] = field(default_factory=list)
    curves: List[UCurve] = field(default_factory=list)
    masked_curves: List[UMaskedCurve] = field(default_factory=list)
    # [YamlIgnore] 的运行时成员（渲染产物），不参与读写
    phonemes: List[Any] = field(default_factory=list, metadata=NO_YAML)
    phonemes_revision: int = field(default=0, metadata=NO_YAML)
    render_phrases: List[Any] = field(default_factory=list, metadata=NO_YAML)
    #: 乐句快照的代际：每次取快照 +1，用来丢弃迟到的旧结果
    phrase_generation: int = field(default=0, metadata=NO_YAML)
    phrase_applied_generation: int = field(default=0, metadata=NO_YAML)
    #: `Pipeline.PhraseBuildGate`（在 `__post_init__` 里延迟创建）
    phrase_gate: Any = field(default=None, metadata=NO_YAML)
    #: C# 的 `lock (this)` —— 构建线程与主线程都会碰 render_phrases
    _phrase_lock: Any = field(default=None, metadata=NO_YAML, compare=False, repr=False)

    def __post_init__(self):
        super().__post_init__()
        import threading

        from ..openutau.pipeline_builder import PhraseBuildGate
        self.phrase_gate = PhraseBuildGate()
        self._phrase_lock = threading.Lock()

    def apply_phrase_source_result(self, source, phrases) -> None:
        """对应 UPart.cs 的 `ApplyPhraseSourceResult(PhraseSource, RenderPhrase[])`。

        ★ **代际比较是唯一的防串写手段**：后台可能还在跑更旧的快照，迟到的结果
        必须被丢掉（`applied = source.Generation > phraseAppliedGeneration`），
        否则"改了音符又改回来"会偶尔渲染出中间态。

        C# 末尾还有一句 `if (DocManager.Inst.MainScheduler != null)
        RenderView.Inst.InvalidateAll();` —— 那是编辑器重绘通知（M3，`RenderView`
        未照搬），不属于管线这一层。
        """
        with self._phrase_lock:
            applied = source.generation > self.phrase_applied_generation
            if applied:
                self.phrase_applied_generation = source.generation
                self.render_phrases = list(phrases)
        if not applied:
            return
        self.phrase_gate.mark_completed(source.generation)


@dataclass
class UWavePart(UPart):
    """对应 UPart.cs 的 UWavePart（伴奏/音频片段）。

    注意：**没有 `duration` 字段** —— 我第一版照搬时自作主张加了一个，
    被 test_ustx_schema_matches_source.py 抓出来。C# 那边长度由
    fileDurationMs / skip / trim 推算（计算属性），不参与序列化。
    """

    relative_path: str = ''
    file_duration_ms: float = 0
    skip: int = 0
    trim: int = 0
    fadein: int = 0
    fadeout: int = 0


@dataclass
class URenderSettings:
    """对应 UTrack.cs 里的 `URenderSettings`。

    注意：`renderer/resampler/wavtool` 属于**这个类**，不是 UTrack 的扁平字段
    —— 这是我第一版照搬时的真实错误，被 test_ustx_schema_matches_source.py 抓出来了。
    """

    renderer: str = ''
    resampler: str = ''
    wavtool: str = ''
    # [YamlIgnore]：运行时解析出来的实体
    renderer_obj: Any = field(default=None, metadata=NO_YAML)
    resampler_obj: Any = field(default=None, metadata=NO_YAML)
    wavtool_obj: Any = field(default=None, metadata=NO_YAML)


@dataclass
class UTrack:
    """对应 UTrack.cs 的 UTrack（字段顺序照 C# 声明）。"""

    singer: str = ''
    phonemizer: str = ''
    renderer_settings: URenderSettings = field(default_factory=URenderSettings)
    track_name: str = 'New Track'
    track_color: str = 'Blue'
    mute: bool = False
    solo: bool = False
    mix_fx: Optional[UMixFx] = None
    volume: float = 0
    pan: float = 0
    track_expressions: List[UExpressionDescriptor] = field(default_factory=list)
    expression_graph: Optional[str] = None
    voice_color_names: List[str] = field(default_factory=lambda: [''])
    #: ★ **不参与 ustx 序列化**（`NO_YAML`）：上游 UTrack **没有** Language 字段
    #:   （已对照参考源码与上游 master 确认；早先注释里说的 "USingerTrack.Language"
    #:   并不存在，属于照搬时的错误来源标注，2026-10-07 修正）。
    #:   这是本项目的运行时轨道语言：DiffSinger 会话（session.py）在内存里
    #:   设置它来选语言词典/音素表，前端用 song_project.js 自己的格式持久化。
    #:   之前让它进 YAML 会在保存时多写一个 `language:` 键，破坏与 OpenUTAU 的键集一致。
    language: str = field(default='', metadata=NO_YAML)
    # [YamlIgnore]：运行时解析出来的实体
    singer_obj: Any = field(default=None, metadata=NO_YAML)
    voice_color_exp: Any = field(default=None, metadata=NO_YAML)
    voice_color2_exp: Any = field(default=None, metadata=NO_YAML)
    #: `[YamlIgnore] public int TrackNo { set; get; }` —— Validate 时由 project.tracks 的
    #: 下标填进来（`TrackNo = project.tracks.IndexOf(this)`），不写盘。
    track_no: int = field(default=0, metadata=NO_YAML)

    def __post_init__(self):
        # ★ C# 有三个构造重载：UTrack() / UTrack(string trackName) / UTrack(UProject)。
        #   Python dataclass 只有签名字段，`UTrack(project)` 这种 C# 写法会把
        #   UProject 对象塞进 `singer` 字段（首字段）——加类型闸门防呆。
        if not isinstance(self.singer, str):
            raise TypeError(
                'UTrack.singer 必须是字符串（C# 的歌手 id 字段）；'
                '想按工程构造轨道请用 UTrack.for_project(project)'
                '（对应 C# 的 UTrack(UProject) 重载），拿到的是 %r'
                % type(self.singer).__name__)
        if not isinstance(self.track_name, str):
            raise TypeError('UTrack.track_name 必须是字符串，拿到的是 %r'
                            % type(self.track_name).__name__)

    @classmethod
    def for_project(cls, project) -> 'UTrack':
        """对应 `UTrack(UProject project)` 构造重载：新轨道名取 `Track{N+1}`。

        N = max(各轨道名里 "Track" 后面的数字, 轨道数)（解析不出按 0）。
        """
        track_count = 0
        if project.tracks:
            numbers = []
            for t in project.tracks:
                try:
                    numbers.append(int(t.track_name.replace('Track', '')))
                except ValueError:
                    numbers.append(0)
            track_count = max(numbers)
            if len(project.tracks) > track_count:
                track_count = len(project.tracks)
        return cls(track_name='Track%d' % (track_count + 1))

    def try_get_exp_descriptor(self, project, abbr):
        """照搬 UTrack.cs 的 `TryGetExpDescriptor`：轨道级 → 工程级依次查找。

        顺序不能改：voice color（clr / clry）优先命中运行时字段，
        然后才是轨道自己的表达式表，最后落回工程表达式表。
        """
        from .format import Ustx  # 常量表在 ustx 包内，避免与 openutau 包循环导入
        if abbr == Ustx.CLR and self.voice_color_exp is not None:
            return self.voice_color_exp
        if abbr == Ustx.CLRY and self.voice_color2_exp is not None:
            return self.voice_color2_exp
        for e in self.track_expressions:
            if e.abbr == abbr:
                return e
        return project.expressions.get(abbr)


@dataclass
class UProject:
    """对应 UProject.cs 的 UProject。"""

    name: str = 'New Project'
    comment: str = ''
    output_dir: str = 'Vocal'
    cache_dir: str = 'UCache'
    # 注意 C# 标了 [YamlMember(SerializeAs = typeof(string))]：写成字符串，如 "0.6"
    ustx_version: str = '0.6'
    # ustx v0.6 起以下三项已废弃，但仍会读写，保持兼容
    bpm: float = 120
    beat_per_bar: int = 4
    beat_unit: int = 4
    expressions: Dict[str, UExpressionDescriptor] = field(default_factory=dict)
    exp_selectors: List[str] = field(default_factory=lambda: list(DEFAULT_EXP_SELECTORS))
    exp_primary: int = 0
    exp_secondary: int = 1
    expression_graphs: Optional[List[Any]] = None
    default_expression_graphs: Optional[Dict[str, str]] = None
    key: int = 0
    time_signatures: List[UTimeSignature] = field(default_factory=lambda: [UTimeSignature()])
    tempos: List[UTempo] = field(default_factory=lambda: [UTempo()])
    tracks: List[UTrack] = field(default_factory=lambda: [UTrack()])
    # [YamlIgnore]：运行时把 voice_parts/wave_parts 合并成的统一列表
    parts: List[Any] = field(default_factory=list, metadata=NO_YAML)
    # [YamlIgnore]：tick↔ms 换算轴（C# 是 readonly 字段，构造时 BuildSegments）
    time_axis: Any = field(default=None, metadata=NO_YAML)
    # 序列化用的临时字段（AfterLoad 时会并回 parts）
    voice_parts: Optional[List[UVoicePart]] = None
    wave_parts: Optional[List[UWavePart]] = None
    # ---- 运行时状态（C# 里是普通属性，但标了不写盘）
    #: 对应 `UProject.Saved` —— 「这个工程来自磁盘且没再改过」。
    #: ★ `.ust` 导出的 `[#SETTING]` 里 `Project=` 那一行**只在此为真时**才写。
    saved: bool = field(default=False, metadata=NO_YAML)
    #: 对应 `UProject.FilePath` —— 读 .ustx 时记下来；导出 .ust 时用它推 `Project=`
    file_path: str = field(default='', metadata=NO_YAML)

    def __post_init__(self):
        self.build_time_axis()

    def build_time_axis(self) -> None:
        """重建时间轴。延迟导入 TimeAxis 是为了避免 ustx ↔ openutau 循环导入。

        对应 C# 里 `UProject` 构造函数的 `timeAxis.BuildSegments(this)` 与 `Validate()` 里的同名调用。
        """
        from ..openutau.timeaxis import TimeAxis
        self.time_axis = TimeAxis()
        self.time_axis.build_segments(self)

    def create_note(self, note_num: Optional[int] = None,
                    pos_tick: Optional[int] = None,
                    dur_tick: Optional[int] = None) -> 'UNote':
        """对应 `CreateNote()` 与 `CreateNote(noteNum, posTick, durTick)`。

        ★ 新音符自带**默认滑音**：两个弯音点 `(PortamentoStart, 0)` 与
          `(PortamentoStart + PortamentoLength, 0)`，形状都是 `io`。
          上游取自 `NotePresets.Default.DefaultPortamento`
          —— 即 `PortamentoPreset("Standard", 80, -40)`，**注意构造器的参数序是
          `(name, length, start)`**，所以 `PortamentoStart = -40`、`PortamentoLength = 80`，
          两个点落在 x = **-40** 与 **40**。这不是笔误，是 UTAU 的默认滑音形状。
        """
        from ..openutau.note_presets import (DEFAULT_PITCH_SHAPE,
                                             DEFAULT_PORTAMENTO_LENGTH,
                                             DEFAULT_PORTAMENTO_START)
        shape = DEFAULT_PITCH_SHAPE
        start = DEFAULT_PORTAMENTO_START
        length = DEFAULT_PORTAMENTO_LENGTH
        note = UNote.create()
        note.pitch.data.append(PitchPoint(x=start, y=0, shape=shape))
        note.pitch.data.append(PitchPoint(x=start + length, y=0, shape=shape))
        if note_num is not None:
            note.tone = note_num
        if pos_tick is not None:
            note.position = pos_tick
        if dur_tick is not None:
            note.duration = dur_tick
        return note

    def register_expression(self, descriptor: UExpressionDescriptor) -> None:
        if descriptor.abbr not in self.expressions:
            self.expressions[descriptor.abbr] = descriptor

    def marge_expression(self, old_abbr: str, new_abbr: str) -> None:
        """对应 `MargeExpression(oldAbbr, newAbbr)`：把旧表达式并到新表达式上。

        ★ C# 的拼写就是 `Marge`（不是 Merge），照搬。

        逐音符处理 `phoneme_expressions`：
          · 只有旧的 → **就地改名**成新的，并换 `descriptor`；
          · 新的同 index 已存在 → **删掉旧的**（新的优先）。
        音符来源与 C# 一致：`parts` 优先，为空则用 `voice_parts`。
        """

        def _convert(note, track):
            if not any(e.abbr == old_abbr for e in note.phoneme_expressions):
                return
            to_remove = []
            for old_exp in [e for e in note.phoneme_expressions if e.abbr == old_abbr]:
                if not any(n.abbr == new_abbr and n.index == old_exp.index
                           for n in note.phoneme_expressions):
                    old_exp.abbr = new_abbr
                    if track is not None:
                        desc = self.expressions.get(new_abbr)
                        if desc is not None:
                            old_exp.descriptor = desc
                else:
                    to_remove.append(old_exp)
            for exp in to_remove:
                if exp in note.phoneme_expressions:
                    note.phoneme_expressions.remove(exp)

        parts = self.parts or []
        if parts:
            for p in parts:
                track = self.tracks[p.track_no] if 0 <= p.track_no < len(self.tracks) else None
                for n in getattr(p, 'notes', []) or []:
                    _convert(n, track)
        elif self.voice_parts:
            for p in self.voice_parts:
                track = self.tracks[p.track_no] if 0 <= p.track_no < len(self.tracks) else None
                for n in getattr(p, 'notes', []) or []:
                    _convert(n, track)
        self.expressions.pop(old_abbr, None)

    @property
    def resolution(self) -> int:
        """对应 UProject.resolution —— 固定 480，不写盘。"""
        return 480

    def after_load(self) -> None:
        """对应 `UProject.AfterLoad()`：读盘后把文件数据修整成可用的运行时状态。

        逐段对照 C#：
        - `foreach (var track in tracks) track.AfterLoad(this)` —— 那边做
          音素化器/歌手实体解析（PhonemizerFactory / SingerManager，宿主级注册表），
          我们的 ustx 包是纯数据模型，这步留给调用方（engine_openutau / session）。
        - voice_parts / wave_parts 并回 parts（io.after_load 原来做的事，并入这里）。
        - `part.AfterLoad(this, tracks[part.trackNo])`：
          · UVoicePart.AfterLoad —— 逐音符补表达式 descriptor（补不上的丢）；
            曲线同样按轨道补 descriptor，**未知表达式的曲线剔除并告警**；
            `Duration = max(Duration, GetMinDurTick(project))`（音符被时间轴
            圆整到下一拍后的最小长度）。
          · UWavePart.AfterLoad —— 音频文件加载（宿主级 IO），数据模型层只留
            relativePath 不动。
        - `ExpressionGraphProgram.LogProblems(this)` —— 表达式图模块未搬，跳过。

        ★ 这步不是可选项：不绑定 descriptor 的曲线在 `UCurve.sample` 里会回落 0
          （`descriptor is None` 分支），加载 OpenUTAU 工程后音高/力度曲线会静默失效。
        """
        if self.voice_parts is not None:
            self.parts.extend(self.voice_parts)
            self.voice_parts = None
        if self.wave_parts is not None:
            self.parts.extend(self.wave_parts)
            self.wave_parts = None

        for part in self.parts:
            track = (self.tracks[part.track_no]
                     if 0 <= part.track_no < len(self.tracks) else None)
            if isinstance(part, UVoicePart):
                for note in part.notes:
                    note.after_load(self, track, part)
                # ---- 曲线 descriptor 绑定 + 未知表达式剔除（UVoicePart.AfterLoad）
                kept_curves = []
                for curve in part.curves:
                    descriptor = (track.try_get_exp_descriptor(self, curve.abbr)
                                  if track is not None else None)
                    if descriptor is not None:
                        curve.descriptor = descriptor
                        kept_curves.append(curve)
                    else:
                        # C#：Log.Warning($"Removed curve \"{curve.abbr}\" ...")
                        logging.getLogger(__name__).warning(
                            'Removed curve "%s" with unknown expression from part "%s".',
                            curve.abbr, part.name)
                part.curves = kept_curves
                # ---- Duration 修正：Duration = Math.Max(Duration, GetMinDurTick(project))
                if part.notes:
                    last = max(part.notes, key=lambda n: n.position)  # SortedSet 末位语义
                    end_ticks = part.position + last.end
                else:
                    end_ticks = part.position + 1
                bar, beat, _rem = self.time_axis.tick_pos_to_bar_beat(end_ticks)
                min_dur = self.time_axis.bar_beat_to_tick_pos(bar, beat + 1) - part.position
                part.duration = max(part.duration, min_dur)

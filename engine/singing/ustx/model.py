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

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# --- 标记：对应 C# 的 [YamlIgnore] ---
NO_YAML = {'yaml': False}


class PitchPointShape:
    """对应 UNote.cs 的 `enum PitchPointShape`（序列化为名字）。"""

    IO = 'io'   # SineInOut
    L = 'l'     # Linear
    O = 'o'


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


@dataclass
class Vector2:
    """对应 System.Numerics.Vector2 的用法（包络点用 (x, y)，单位 ms）。"""

    x: float = 0
    y: float = 0


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
    """对应 UNote.cs 的 PitchPoint。"""

    x: float = 0
    y: float = 0
    shape: str = PitchPointShape.IO


@dataclass
class UPitch:
    """对应 UNote.cs 的 UPitch。"""

    data: List[PitchPoint] = field(default_factory=list)
    snap_first: bool = True


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
    phonemizer_override: Optional[str] = None

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


@dataclass
class UCurve:
    """对应 UCurve.cs 的 UCurve（x 为 tick，y 为取值）。"""

    xs: List[int] = field(default_factory=list)
    ys: List[int] = field(default_factory=list)
    abbr: str = ''


@dataclass
class UMaskedRun:
    """对应 UMaskedCurve.cs 的 UMaskedRun。"""

    x: int = 0
    ys: List[float] = field(default_factory=list)


@dataclass
class UMaskedCurve:
    """对应 UMaskedCurve.cs 的 UMaskedCurve（有些区段没有取值）。"""

    abbr: str = ''
    runs: List[UMaskedRun] = field(default_factory=list)


@dataclass
class UPart:
    """对应 UPart.cs 的 UPart（基类）。"""

    name: str = 'New Part'
    comment: str = ''
    track_no: int = 0
    position: int = 0


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
    # [YamlIgnore]：运行时解析出来的实体
    singer_obj: Any = field(default=None, metadata=NO_YAML)
    voice_color_exp: Any = field(default=None, metadata=NO_YAML)
    voice_color2_exp: Any = field(default=None, metadata=NO_YAML)

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

    def __post_init__(self):
        self.build_time_axis()

    def build_time_axis(self) -> None:
        """重建时间轴。延迟导入 TimeAxis 是为了避免 ustx ↔ openutau 循环导入。

        对应 C# 里 `UProject` 构造函数的 `timeAxis.BuildSegments(this)` 与 `Validate()` 里的同名调用。
        """
        from ..openutau.timeaxis import TimeAxis
        self.time_axis = TimeAxis()
        self.time_axis.build_segments(self)

    @property
    def resolution(self) -> int:
        """对应 UProject.resolution —— 固定 480，不写盘。"""
        return 480

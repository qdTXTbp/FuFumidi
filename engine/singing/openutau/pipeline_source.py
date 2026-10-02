# -*- coding: utf-8 -*-
"""渲染流水线的输入契约 —— 照搬 `OpenUtau.Core/Pipeline/PhraseSource.cs`（548 行）里的
`NoteSource` / `VibratoSource` / `CurveSource` / `PhonemeSource` / `PhraseSource`。

这一层是「渲染器的输入」：`RenderPhrase` / `RenderNote` / `RenderPhone` 的构造函数
都只吃这几个结构的字段。把它们先照搬到位，渲染器那三个类才能按原文转写。
（C# 里这些字段多为 `{ get; private set; }`，由 `PhraseSource` 的构造函数填充；
Python 侧作为纯数据类，字段名与 C# 逐一对齐。）

## 模块同时承载两种东西
1. **数据类**（`NoteSource` / `VibratoSource` / `CurveSource` / `PhonemeSource` /
   `PhraseSource`）：字段与 C# 逐一对齐。
2. **取快照的行为**：C# 把"从活文档拷贝出不变副本"写在各自的构造函数里
   （`NoteSource(...)` / `PhonemeSource(...)` / `PhraseSource(...)`），
   Python 的纯数据类不写业务构造，于是这些逻辑落在对应的
   `of()` / `from_part()` / `build_phrases()` 上 —— **语句顺序与 C# 一一对应**，
   顺序本身是语义（`Leading` 要先算出来才能给 `TemposBetweenTicks` 用，等等）。

## 与 C# 的等价性差异
- `PartId` / `DocRevision` 已照搬（`pipeline_identities.py`），不再用占位类型。
- 仍用 `Any` 占位的只剩表达式图程序（`ExpressionGraphProgram`）与 `PhonemeAnchors` ——
  属于"类型未搬"，不是行为差异。
- `VibratoSource.In` / `.Out` 在 C# 里是 `In`/`Out`（`in`/`out` 在 Python 是关键字），
  这里写作 `vib_in` / `vib_out`。
- `VibratoSource.Evaluate` / `EvaluateVolume` 与 `CurveSource.Sample` / `Empty` 是
  **行为**（不只是数据），必须逐位复刻实时版：`RenderPhrase` 的音高/动态全靠它们。
- MOD+ 段落依赖 `ClassicSinger`/`OtoFrq`（尚未照搬）：`PhraseSource.classic_singer`
  当前恒为 None，故 `RenderPhrase` 里那条分支不会走到。
- **`DocManager.Inst.Revision`**：C# 直接读全局文档管理器。Python 无全局单例，
  由本模块的可注入宿主 `host` 顶替（见 `DocHost`），`from_part` 也留了显式参数。
- **`track.Singer`**：C# 的 `UTrack.Singer` 是解析出来的 `USinger` 实体；我们的
  `UTrack` 上叫 `singer_obj`（`singer` 已被"歌手名字符串"占用），调用处按此映射。
- **`part.Id`**：C# 的 `UPart.Id` 是运行时 `PartId`；我们在 `UPart` 上补了同名字段。
- **`UNote.pitch` / `UNote.vibrato`**：C# 的 `UNote.Create()` 一定会把它们初始化成
  实例；我们的 `UNote` 默认是 `None`（未载入时），所以两处取快照时留了 `None` 守卫
  —— 这是**载体差异**（我们的默认值更宽松），不是行为差异。
- **`tempos` 的元素**：C# 是 `UTempo[]`；我们沿用 `TimeAxis.tempos_between_ticks()`
  既有的 `dict` 形态（`{'position', 'bpm'}`），字段名一致。
- 数值仍是 Python 的 float64（C# 到处是 float32），偏差见 `render_phrase.py` 开头说明。
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import bisect
import math

# C# 里这几处用的都是 System.Numerics.Vector2；ustx 包已为同一用途照搬了它。
from ..ustx.format import Ustx
from ..ustx.model import PitchPoint, UExpressionType, Vector2
from .music_math import MusicMath, fdiv
from .phoneme import UPhoneme
from .pipeline_identities import DocRevision, PartId


class DocHost:
    """C# `DocManager.Inst` 的替身 —— 管线只用到它的三项。

    | C# | 用途 |
    |---|---|
    | `Revision` | `PhraseSource.FromPart` 记进快照的文档版本号 |
    | `Project` | `PhraseSourceBuilder.SendResult` 判断"这个 part 还在工程里吗" |
    | `MainScheduler` | `PhraseSourceBuilder.SendResult` 把结果投回主线程 |

    Python 没有全局单例，宿主在启动时把这三项填进来（**载体差异，不是行为差异**）。
    未配置时 `revision` 为 `DocRevision(0)`、`project` 为 `None` —— 与 C# "空文档"
    的语义一致：`project` 为 None 时构建结果会被丢弃（与"part 已被删除"同一条路径），
    不会静默写进错的地方。
    """

    revision: DocRevision = DocRevision(0)
    project: Any = None
    #: 一个可调用对象：接收 `() -> None` 并安排到主线程执行（C# 的 `TaskScheduler`）
    main_scheduler: Any = None


#: 当前宿主（对应 C# 的全局单例 `DocManager.Inst`）。测试/主程序在启动时替换它。
host = DocHost()


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

    @classmethod
    def of(cls, source) -> 'VibratoSource':
        """对应 C# 的 `VibratoSource(UVibrato source)` 构造函数（逐字段拷一份快照）。"""
        return cls(
            length=source.length,
            period=source.period,
            depth=source.depth,
            vib_in=source.vib_in,       # C#: source.@in
            vib_out=source.vib_out,     # C#: source.@out
            shift=source.shift,
            drift=source.drift,
            vol_link=source.vol_link,
        )

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
    def of(cls, curve, default_y: int) -> 'CurveSource':
        """对应 C# 的 `CurveSource(UCurve curve, int defaultY)` 构造函数。

        `Min` 取的是曲线**描述符**的 min；描述符缺失时按 0（C# 的 `?? 0f`）。
        """
        descriptor = getattr(curve, 'descriptor', None)
        min_ = float(descriptor.min) if descriptor is not None else 0.0
        return cls(abbr=curve.abbr, xs=list(curve.xs), ys=list(curve.ys),
                   default_y=default_y, min=min_)

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

    @classmethod
    def of(cls, index: int, note, axis, part_position: int,
           prev: int, next_: int, extends: int) -> 'NoteSource':
        """对应 C# 的 `NoteSource(...)` 构造函数。

        ★ `PitchPoints` 必须**逐点新建**（C# 的 `Select(p => new PitchPoint(...))`）：
        `PitchPoint` 在 C# 是 `struct`，`ToList()` 得到的是副本；Python 里若直接
        `list(note.pitch.data)` 会把活文档上的点共享进快照，`RenderPhrase` 里插入
        "自动补全端点"时会**污染原音符**（见陷阱清单 #1）。
        """
        return cls(
            index=index,
            position=note.position,
            duration=note.duration,
            end=note.end,
            extended_duration=note.extended_duration,
            lyric=note.lyric,
            tone=note.tone,
            tuning=note.tuning,
            adjusted_tone=note.adjusted_tone,
            duration_ms=axis.ms_between_tick_pos(part_position + note.position,
                                                 part_position + note.end),
            prev=prev,
            next=next_,
            extends=extends,
            vibrato=VibratoSource.of(note.vibrato) if note.vibrato is not None else None,
            pitch_points=[PitchPoint(p.x, p.y, p.shape, p.auto_completed)
                          for p in (note.pitch.data if note.pitch is not None else [])],
        )


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

    @classmethod
    def of(cls, phoneme, note_index: int, axis, part_position: int, track, project,
           track_resampler: str, xsy_available: bool,
           graph_expressions: Optional[List[Any]]) -> 'PhonemeSource':
        """对应 C# 的 `PhonemeSource(UPhoneme, int, TimeAxis, int, UTrack, UProject,
        string, bool, IReadOnlyList<UExpressionDescriptor>?)` 构造函数。

        表达式在这里**一次性解析成展开值**（音量×0.01、辅音伸缩的速度、resampler
        名字与 flags、语音色后缀…），之后渲染线程不再碰文档。
        """
        # ---- 几何：part 相对 tick / 绝对 ms
        position = phoneme.position
        duration = phoneme.duration
        end = phoneme.end
        position_ms = phoneme.position_ms
        duration_ms = phoneme.duration_ms
        end_ms = phoneme.end_ms
        preutter = phoneme.preutter
        overlap = phoneme.overlap
        tail_intrude = phoneme.tail_intrude
        tail_overlap = phoneme.tail_overlap
        # `Leading` 必须先算出来，下面的 `Tempos` 要用它
        leading = max(0, axis.ticks_between_ms_pos(position_ms - phoneme.preutter, position_ms))
        prev_adjacent = phoneme.prev is not None and phoneme.prev.end == phoneme.position
        next_adjacent = phoneme.next is not None and end == phoneme.next.position

        # ---- 身份
        note = phoneme.parent
        phone = phoneme.phoneme
        tone = note.tone if note is not None else 0

        # ---- 时间
        abs_start = part_position + position
        abs_end = part_position + end
        tempos = axis.tempos_between_ticks(abs_start - leading, abs_end)
        note_tempos = axis.tempos_between_ticks(abs_start, abs_end)
        fallback_bpm = project.tempos[0].bpm if len(project.tempos) > 0 else 120
        tempo = note_tempos[0]['bpm'] if len(note_tempos) > 0 else fallback_bpm

        # 等效 tick 时长：被 tempo 分段切开，按各段 bpm 折算回基准 bpm
        actual_tick_duration = 0.0
        for i in range(len(note_tempos)):
            tempo_start = max(abs_start, note_tempos[i]['position'])
            tempo_end = note_tempos[i + 1]['position'] if i + 1 < len(note_tempos) else abs_end
            tempo_length = tempo_end - tempo_start
            # C# 是 `(double)(tempoLength * (Tempo / bpm))`：先按 float 乘再转 double
            actual_tick_duration += tempo_length * (tempo / note_tempos[i]['bpm'])
        # `Duration / actualTickDuration * Tempo` —— C# 除以 0 得 Inf，别让 Python 抛异常
        adjusted_tempo = fdiv(duration, actual_tick_duration) * tempo

        # ---- 解析出的渲染参数（Classic 线）
        eng = int(phoneme.get_expression(project, track, Ustx.ENG)[0])
        resampler = track_resampler
        eng_descriptor = track.try_get_exp_descriptor(project, Ustx.ENG)
        if (eng_descriptor is not None
                and 0 <= eng < len(eng_descriptor.options or [])
                and (eng_descriptor.options[eng] or '')):
            resampler = eng_descriptor.options[eng]
        flags = phoneme.get_resampler_flags(project, track)
        voice_color = phoneme.get_voice_color(project, track)
        suffix = _subbank_suffix(track.singer_obj, voice_color)
        # `xsyAvailable` 为假时目标语音色**不是空串而是 null**（两处判断因此都跳过）
        target_color = phoneme.get_voice_color2(project, track) if xsy_available else None
        suffix2 = None
        if target_color:
            suffix2 = _subbank_suffix(track.singer_obj, target_color) or ''
        volume = phoneme.get_expression(project, track, Ustx.VOL)[0] * 0.01
        vel = phoneme.get_expression(project, track, Ustx.VEL)[0]
        modulation = phoneme.get_expression(project, track, Ustx.MOD)[0] * 0.01
        direct = phoneme.get_expression(project, track, Ustx.DIR)[0] == 1
        # C# 是 `(int)` 转换 → **向零截断**（不是四舍五入，也不是 floor）
        tone_shift = int(phoneme.get_expression(project, track, Ustx.SHFT)[0])
        # `Envelope.ToArray()`：C# 的 Vector2 是 struct，逐点拷贝；Python 必须新建
        envelope = [Vector2(p.x, p.y) for p in phoneme.envelope.data]
        # mod+ 是可选描述符：描述符不存在时原码**根本不取值**，按 0（"关"）而不是报错
        has_modp = track.try_get_exp_descriptor(project, Ustx.MODP) is not None
        modp_raw = phoneme.get_expression(project, track, Ustx.MODP)[0] if has_modp else 0.0

        values = None
        if graph_expressions is not None:
            values = {d.abbr: phoneme.get_expression(project, track, d.abbr)[0]
                      for d in graph_expressions}

        oto = phoneme.oto
        oto2 = None
        if oto is not None and target_color:
            base_phoneme = oto.phonetic or phoneme.phoneme
            found, secondary = track.singer_obj.try_get_mapped_oto(
                base_phoneme, note.tone, target_color)
            if found:
                oto2 = secondary

        return cls(
            position=position, duration=duration, end=end,
            position_ms=position_ms, duration_ms=duration_ms, end_ms=end_ms,
            preutter=preutter, overlap=overlap,
            tail_intrude=tail_intrude, tail_overlap=tail_overlap,
            leading=leading, prev_adjacent=prev_adjacent, next_adjacent=next_adjacent,
            phoneme=phone, tone=tone, note_index=note_index,
            tempos=tempos, note_tempos=note_tempos,
            tempo=tempo, adjusted_tempo=adjusted_tempo,
            resampler=resampler, flags=flags, suffix=suffix, suffix2=suffix2,
            volume=volume, velocity=vel * 0.01, vel_raw=vel,
            modulation=modulation, direct=direct, tone_shift=tone_shift,
            envelope=envelope, modp_raw=modp_raw, values=values,
            oto=oto, oto2=oto2,
        )

    def with_driven(self, driven: Dict[str, float], source: 'PhraseSource') -> 'PhonemeSource':
        """对应 C# 的 `PhonemeSource.WithDriven`：把表达式图驱动的值换成展开值。

        只重算**被驱动项真正决定的东西**（音量 / 调制 / MOD+ / 包络电平 / flags），
        其余字段保持快照值。C# 用 `MemberwiseClone()`（浅拷贝），Python 用 `copy.copy`
        —— 两者语义一致：列表字段仍是**共享**的，只有被显式替换的才换新对象。
        """
        def value(abbr: str) -> float:
            if abbr in driven:
                return driven[abbr]
            if self.values is not None and abbr in self.values:
                return self.values[abbr]
            return 0.0

        import copy
        result = copy.copy(self)
        result.driven = driven
        if Ustx.VOL in driven:
            result.volume = value(Ustx.VOL) * 0.01
        if Ustx.MOD in driven:
            result.modulation = value(Ustx.MOD) * 0.01
        if Ustx.MODP in driven:
            result.modp_raw = value(Ustx.MODP)
        if Ustx.VOL in driven or Ustx.ATK in driven or Ustx.DEC in driven:
            # 电平按 `UPhoneme.ValidateEnvelope` 的算式重算；时间坐标与这些值无关
            vol = value(Ustx.VOL)
            atk = value(Ustx.ATK)
            dec = value(Ustx.DEC)
            envelope = [Vector2(p.x, p.y) for p in self.envelope]
            envelope[1].y = atk * vol / 100.0
            envelope[2].y = vol
            envelope[3].y = vol * (1.0 - dec / 100.0)
            result.envelope = envelope
        if any(d.abbr in driven for d in source.flag_expressions):
            result.flags = UPhoneme.build_resampler_flags(source.flag_expressions, value)
        return result


def _subbank_suffix(singer, color: Optional[str]) -> Optional[str]:
    """`track.Singer.Subbanks.FirstOrDefault(s => s.Color == color)?.Suffix ?? string.Empty`。

    C# 的原码**不检查 `Singer` 是否为 null**（会抛 NullReferenceException），
    这里保持一致：`singer` 为 None 时同样抛 AttributeError，不做"更友好"的兜底。
    """
    for subbank in singer.subbanks:
        if subbank.color == color:
            return subbank.suffix if subbank.suffix is not None else ''
    return ''


@dataclass
class PhraseSource:
    """对应 PhraseSource.cs 的 PhraseSource（一个乐句的全部输入）。"""

    part_id: Optional[PartId] = None           # PartId（Pipeline/Identities.cs）
    revision: Optional[DocRevision] = None     # DocRevision（Pipeline/Identities.cs）
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
    #: 半开区间 `[start, end)` 的**下标**范围，指向 `phonemes`
    phrase_groups: List[Tuple[int, int]] = field(default_factory=list)

    # ------------------------------------------------------------------ 取快照

    @classmethod
    def from_part(cls, project, track, part, generation: int,
                  revision: Optional[DocRevision] = None) -> Optional['PhraseSource']:
        """对应 C# 的 `PhraseSource.FromPart(project, track, part, generation)`。

        在 UI 线程上把整条音乐链路的输入拷成不变副本，并按"间隙"把音素切成乐句组；
        真正的重活（`build_phrases`）留给后台线程。

        ★ 切组条件里那个 `&& !renderer.ShouldMergePhrases(...)` 不能省：间隙照例切组，
        但渲染器可以在"填充后的音频会重叠"时要求把相邻乐句并成一条（DiffSinger 的
        padding 就靠它）。

        返回 `None` 表示"这个 part 没有可用的音素"（音素化还没跑，或全部报错）——
        调用方据此清空 `renderPhrases`，而不是拿到一个空快照。
        """
        phonemes = [phoneme for phoneme in part.phonemes if not phoneme.error]
        if len(phonemes) == 0:
            return None
        renderer = track.renderer_settings.renderer_obj
        groups: List[Tuple[int, int]] = []
        start = 0
        for i in range(1, len(phonemes)):
            if (phonemes[i - 1].end != phonemes[i].position
                    and not renderer.should_merge_phrases(
                        project, track, phonemes[i - 1], phonemes[i])):
                groups.append((start, i))
                start = i
        groups.append((start, len(phonemes)))
        return cls._of(project, track, part, phonemes, groups, generation,
                       revision if revision is not None else host.revision)

    @classmethod
    def _of(cls, project, track, part, phonemes: List[Any],
            groups: List[Tuple[int, int]], generation: int,
            revision: DocRevision) -> 'PhraseSource':
        """对应 C# 的 `PhraseSource(...)` 构造函数本体（逐字段取快照）。

        ★ 语句顺序是语义：`XsyAvailable` 要在 `PhonemeSource` 之前算好（它决定
        是否解析第二语音色），`Resolution`/`CurveDefaults` 在 `_of` 里就地求值。
        """
        axis = project.time_axis.clone()
        singer = track.singer_obj
        renderer = track.renderer_settings.renderer_obj
        resampler = track.renderer_settings.resampler
        wavtool = track.renderer_settings.wavtool
        # `Singer as ClassicSinger`：ClassicSinger（M2-a 剩余）未照搬 → 恒为 None
        classic_singer = None
        modp = track.try_get_exp_descriptor(project, Ustx.MODP)
        modp_supported = modp is not None and renderer.supports_expression(modp)
        xsy_available = any(curve.abbr == Ustx.XSY for curve in part.curves)

        # C# 用 `Dictionary<UNote, int>`（引用相等）；我们的 UNote 是 dataclass，
        # `__hash__` 被 `__eq__` 抹掉了，所以键改用 `id(note)` —— 同一份引用语义。
        note_index_by_note = {}
        notes = list(part.notes)
        for i, note in enumerate(notes):
            note_index_by_note[id(note)] = i

        def note_index(note) -> int:
            # C# 是 `noteIndexByNote[n.Prev]`：不在这个 part 里就抛（KeyNotFoundException）
            return note_index_by_note[id(note)] if note is not None else -1

        note_sources = [
            NoteSource.of(i, note, axis, part.position,
                          note_index(note.prev), note_index(note.next), note_index(note.extends))
            for i, note in enumerate(notes)
        ]
        # `(int)(c.descriptor?.defaultValue ?? 0)` —— 描述符缺失时按 0
        curves = [CurveSource.of(
            curve, int(curve.descriptor.default_value) if curve.descriptor is not None else 0)
            for curve in part.curves]
        # 渲染器支持的**曲线**描述符，按工程里的声明顺序
        curve_descriptors = [d for d in project.expressions.values()
                             if d.type == UExpressionType.CURVE and renderer.supports_expression(d)]
        # 注意 C# 用 `ToDictionary`：同缩写重复会抛异常；Python 的字典推导会**覆盖**
        curve_defaults = {d.abbr: int(d.default_value) for d in project.expressions.values()
                          if d.type == UExpressionType.CURVE}
        # 表达式图（ExpressionGraph/*）未照搬 → ForTrack 恒为 None，下辖四项一并保持默认
        expression_graph = None
        graph_expressions = None

        phoneme_sources = [
            PhonemeSource.of(phoneme, note_index(phoneme.parent),
                             axis, part.position, track, project, resampler,
                             xsy_available, graph_expressions)
            for phoneme in phonemes
        ]
        return cls(
            part_id=part.id,
            revision=revision,
            generation=generation,
            part_position=part.position,
            axis=axis,
            default_bpm=project.tempos[0].bpm if len(project.tempos) > 0 else 120,
            singer=singer,
            renderer=renderer,
            resampler=resampler,
            wavtool=wavtool,
            classic_singer=classic_singer,
            modp_supported=modp_supported,
            notes=note_sources,
            curves=curves,
            curve_descriptors=curve_descriptors,
            xsy_available=xsy_available,
            resolution=project.resolution,
            curve_defaults=curve_defaults,
            expression_graph=expression_graph,
            masked_curves=None,
            phoneme_anchors=None,
            flag_expressions=[],
            drivable_phoneme_expressions={},
            phonemes=phoneme_sources,
            phrase_groups=list(groups),
        )

    # ------------------------------------------------------------------ 出乐句

    def build_phrases(self) -> List[Any]:
        """对应 C# 的 `BuildPhrases()`：把每个音素组装配成一条 `RenderPhrase`。"""
        # 延迟导入：render_phrase 在模块级 import 本模块，顶层反向导入会成环
        from .render_phrase import RenderPhrase

        phonemes = self.driven_phonemes()
        return [RenderPhrase(self, phonemes, start, end)
                for (start, end) in self.phrase_groups]

    def driven_phonemes(self) -> List[PhonemeSource]:
        """对应 C# 的 `DrivenPhonemes()`：把表达式图的逐音素输出应用上去。

        图在整条 part 上**只跑一次**，每个音素读自己位置上的值，所以不会有重采样。

        表达式图（`OpenUtau.Core/ExpressionGraph/*`）尚未照搬，`expression_graph`
        恒为 None → 直接返回原音素表，与 C# 的提前返回同一条路径。
        """
        if self.expression_graph is None or len(self.expression_graph.phoneme_outputs) == 0:
            return self.phonemes
        raise NotImplementedError(
            '表达式图（ExpressionGraph）尚未照搬；PhraseSource.expression_graph 应为 None。')

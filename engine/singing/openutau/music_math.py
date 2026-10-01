# -*- coding: utf-8 -*-
"""音乐/时间换算工具 —— **照搬** `OpenUtau.Core/Util/MusicMath.cs`（全文件）。

原先只把 `NameToTone` 塞在 `oto.py` 里（当时只用到音名换算）。现在渲染乐句要用到
`InterpolateShape` / `Linear` / `DecibelToLinear` / `TempoMsToTick`，
按 C# 的文件边界整份搬到这里，`oto.py` 改为从这里再导出（保持原有 import 路径可用）。

## 照搬时保留的语义（别"整理"掉）
- 所有插值函数在 `x1 - x0 < ep`（ep = 0.001）时**直接返回 y1**，不做除法 —— 这是
  OpenUTAU 防止除零的既有做法，换成"返回 y0"或抛异常都会改变音高曲线。
- `InterpolateShape` 里 `io` 与 `sp` **都走 SinEasingInOut**（spline 的曲率由
  `CubicSplineSegment` 单独处理，不走这里）；`i` / `o` 各自走 SinEasingIn / Out；
  其余（含 `l`）走 `Linear`。
- `NameToTone` 非法输入返回 **-1**，不是抛异常。
- `GetToneName` 对负数返回**空串**。
- `TempoMsToTick` / `TempoTickToMs` 写死 **480 ticks/四分音符**（OpenUTAU 的固定
  resolution 约定），不是从工程里取。
- `PanToChannelVolumes` 先把 pan 夹到 [-100, 100] 再算。

## 与 C# 的等价性差异
- `IsBlackKey` / `IsCenterKey` 在 C# 里用 `noteNum % 12` 当数组下标，负数会抛
  IndexOutOfRange；Python 的负数取模会"绕回"成正下标而不抛。这里**显式还原 C# 的
  抛错行为**（负数抛 `IndexError`），避免静默给出错误答案。
"""

import math

#: `MusicMath.a = Math.Pow(2, 1.0 / 12)` —— 半音频率比
_A = math.pow(2, 1.0 / 12)

#: 每个八度内的音名与黑白键（对应 `KeysInOctave`）
KEYS_IN_OCTAVE = (
    ('C', 'White'), ('C#', 'Black'),
    ('D', 'White'), ('D#', 'Black'),
    ('E', 'White'),
    ('F', 'White'), ('F#', 'Black'),
    ('G', 'White'), ('G#', 'Black'),
    ('A', 'White'), ('A#', 'Black'),
    ('B', 'White'),
)

#: 对应 `NameInOctave`
NAME_IN_OCTAVE = {
    'C': 0, 'C#': 1, 'Db': 1,
    'D': 2, 'D#': 3, 'Eb': 3,
    'E': 4,
    'F': 5, 'F#': 6, 'Gb': 6,
    'G': 7, 'G#': 8, 'Ab': 8,
    'A': 9, 'A#': 10, 'Bb': 10,
    'B': 11,
}

#: 对应 `Solfeges`
SOLFEGES = ('do', '', 're', '', 'mi', 'fa', '', 'sol', '', 'la', '', 'ti')

#: 对应 `NumberedNotations`
NUMBERED_NOTATIONS = ('1', '', '2', '', '3', '4', '', '5', '', '6', '', '7')

#: 对应 `zoomRatios`
ZOOM_RATIOS = (4.0, 2.0, 1.0, 1.0 / 2, 1.0 / 4, 1.0 / 8, 1.0 / 16, 1.0 / 32, 1.0 / 64)

#: 对应 C# 的 `const double ep = 0.001`
_EP = 0.001


def fdiv(a: float, b: float) -> float:
    """C# 的 `double / double` 除法语义：除数为 0 时返回 ±Inf / NaN，**不抛异常**。

    这不是 MusicMath.cs 里的东西，而是为了在 Python 侧复现 C# 的浮点除法行为：
    移植渲染代码时会出现 `Period / DurationMs`、`Δ / note.Duration` 这类式子，
    零长度音符（或零长度时值）在 C# 里静默得到 Infinity 并继续算下去，
    在 Python 里却会抛 `ZeroDivisionError`。用它保证两边"要么同结果、要么同不崩"。
    """
    if b == 0:
        if a == 0 or a != a:
            return float('nan')
        return math.copysign(float('inf'), a) * math.copysign(1.0, b)
    return a / b


def idiv(a, b) -> int:
    """C# 里「整数除法」与「浮点除法后 `(int)` 截断」这**两种**写法都等价于向零截断。

    Python 的 `//` 是向下取整，负数时结果不同（-7 // 5 = -2，而 C# 是 -1）。
    这里先把入参截成 int（与 C# 的 `(int)` 转换同语义），再向零截断。
    """
    a = int(a)
    b = int(b)
    q = abs(a) // abs(b)
    return -q if (a < 0) != (b < 0) else q


class MusicMath:
    """对应 C# 的 `static class MusicMath`。"""

    # ------------------------------------------------------------ 音名 / 音高

    @staticmethod
    def get_tone_name(note_num: int) -> str:
        """音高号 → 音名（C4 = 60）。负数返回空串（照搬 C#）。"""
        if note_num < 0:
            return ''
        return KEYS_IN_OCTAVE[note_num % 12][0] + str(note_num // 12 - 1)

    @staticmethod
    def name_to_tone(name: str) -> int:
        """音名 → 音高号（C4 = 60）。非法返回 -1（照搬 C# 的 -1 约定，不是抛异常）。"""
        if not name or len(name) < 2:
            return -1
        n = 2 if name[1] in '#b' else 1
        head, num = name[:n], name[n:]
        try:
            octave = int(num)
        except ValueError:
            return -1
        if head not in NAME_IN_OCTAVE:
            return -1
        return 12 * (octave + 1) + NAME_IN_OCTAVE[head]

    @staticmethod
    def is_black_key(note_num: int) -> bool:
        """是否为黑键。负数按 C# 行为抛 IndexError（不静默绕回）。"""
        if note_num < 0:
            raise IndexError('note_num must be >= 0: %d' % note_num)
        return KEYS_IN_OCTAVE[note_num % 12][1] == 'Black'

    @staticmethod
    def is_center_key(note_num: int) -> bool:
        """是否为 C（中央类白键）。负数按 C# 行为抛 IndexError。"""
        if note_num < 0:
            raise IndexError('note_num must be >= 0: %d' % note_num)
        return note_num % 12 == 0

    # ------------------------------------------------------------ 缩放

    @staticmethod
    def get_zoom_ratio(quarter_width: float, beat_per_bar: int, beat_unit: int, min_width: float) -> float:
        """对应 `getZoomRatio`。"""
        if beat_unit == 2:
            i = 0
        elif beat_unit == 4:
            i = 1
        elif beat_unit == 8:
            i = 2
        elif beat_unit == 16:
            i = 3
        else:
            raise ValueError('Invalid beat unit.')

        if beat_per_bar % 4 == 0:
            i -= 1  # 小节下一级是半小节（2 个 beat unit）

        if quarter_width * beat_per_bar * 4 <= min_width * beat_unit:
            return beat_per_bar / beat_unit * 4
        while i + 1 < len(ZOOM_RATIOS) and quarter_width * ZOOM_RATIOS[i + 1] > min_width:
            i += 1
        return ZOOM_RATIOS[i]

    # ------------------------------------------------------------ 缓动插值

    @staticmethod
    def sin_easing_in_out(x0: float, x1: float, y0: float, y1: float, x: float) -> float:
        if x1 - x0 < _EP:
            return y1
        return y0 + (y1 - y0) * (1 - math.cos((x - x0) / (x1 - x0) * math.pi)) / 2

    @staticmethod
    def sin_easing_in_out_x(x0: float, x1: float, y0: float, y1: float, y: float) -> float:
        return math.acos(1 - (y - y0) * 2 / (y1 - y0)) / math.pi * (x1 - x0) + x0

    @staticmethod
    def sin_easing_in(x0: float, x1: float, y0: float, y1: float, x: float) -> float:
        if x1 - x0 < _EP:
            return y1
        return y0 + (y1 - y0) * (1 - math.cos((x - x0) / (x1 - x0) * math.pi / 2))

    @staticmethod
    def sin_easing_in_x(x0: float, x1: float, y0: float, y1: float, y: float) -> float:
        return math.acos(1 - (y - y0) / (y1 - y0)) / math.pi * 2 * (x1 - x0) + x0

    @staticmethod
    def sin_easing_out(x0: float, x1: float, y0: float, y1: float, x: float) -> float:
        if x1 - x0 < _EP:
            return y1
        return y0 + (y1 - y0) * math.sin((x - x0) / (x1 - x0) * math.pi / 2)

    @staticmethod
    def sin_easing_out_x(x0: float, x1: float, y0: float, y1: float, y: float) -> float:
        return math.asin((y - y0) / (y1 - y0)) / math.pi * 2 * (x1 - x0) + x0

    @staticmethod
    def linear(x0: float, x1: float, y0: float, y1: float, x: float) -> float:
        if x1 - x0 < _EP:
            return y1
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0)

    @staticmethod
    def linear_x(x0: float, x1: float, y0: float, y1: float, y: float) -> float:
        return (y - y0) / (y1 - y0) * (x1 - x0) + x0

    @staticmethod
    def interpolate_shape(x0: float, x1: float, y0: float, y1: float, x: float, shape) -> float:
        """按 `PitchPointShape`（字符串名）插值。shape 取 'io'/'sp'/'i'/'o'，其余走线性。"""
        if shape in ('io', 'sp'):
            return MusicMath.sin_easing_in_out(x0, x1, y0, y1, x)
        if shape == 'i':
            return MusicMath.sin_easing_in(x0, x1, y0, y1, x)
        if shape == 'o':
            return MusicMath.sin_easing_out(x0, x1, y0, y1, x)
        return MusicMath.linear(x0, x1, y0, y1, x)

    @staticmethod
    def interpolate_shape_x(x0: float, x1: float, y0: float, y1: float, y: float, shape) -> float:
        if shape in ('io', 'sp'):
            return MusicMath.sin_easing_in_out_x(x0, x1, y0, y1, y)
        if shape == 'i':
            return MusicMath.sin_easing_in_x(x0, x1, y0, y1, y)
        if shape == 'o':
            return MusicMath.sin_easing_out_x(x0, x1, y0, y1, y)
        return MusicMath.linear_x(x0, x1, y0, y1, y)

    # ------------------------------------------------------------ 分贝 / 频率

    @staticmethod
    def decibel_to_linear(db: float) -> float:
        return math.pow(10, db / 20)

    @staticmethod
    def linear_to_decibel(v: float) -> float:
        return math.log10(v) * 20

    @staticmethod
    def tone_to_freq(tone) -> float:
        return 440.0 * math.pow(_A, tone - 69)

    @staticmethod
    def freq_to_tone(freq: float) -> float:
        return math.log(freq / 440.0, _A) + 69

    # ------------------------------------------------------------ 吸附 / 时间

    @staticmethod
    def get_snap_divs(resolution: int):
        """对应 `GetSnapDivs`：先 4 分再 6 分（三连）两条链。"""
        result = []
        div = 4
        ticks = resolution * 4 // div
        result.append(div)
        while ticks % 2 == 0:
            ticks //= 2
            div *= 2
            result.append(div)
        div = 6
        ticks = resolution * 4 // div
        result.append(div)
        while ticks % 2 == 0:
            ticks //= 2
            div *= 2
            result.append(div)
        return result

    @staticmethod
    def get_snap_unit(resolution: int, min_ticks: float, triplet: bool):
        """对应 `GetSnapUnit`，返回 `(ticks, div)`。"""
        div = 6 if triplet else 4
        ticks = resolution * 4 // div
        while ticks % 2 == 0 and ticks / 2 >= min_ticks:
            ticks //= 2
            div *= 2
        return ticks, div

    @staticmethod
    def tempo_ms_to_tick(tempo: float, ms: float) -> float:
        """ms → tick（写死 480 ticks/四分音符，照搬 C#）。"""
        return (tempo * 480 * ms) / (60.0 * 1000.0)

    @staticmethod
    def tempo_tick_to_ms(tempo: float, tick: int) -> float:
        """tick → ms（写死 480 ticks/四分音符，照搬 C#）。"""
        return (60.0 * 1000.0 * tick) / (tempo * 480)

    @staticmethod
    def pan_to_channel_volumes(pan: float):
        """声像 → 左右声道增益，返回 `(left, right)`（照搬 C# 的 90° 正弦分配）。"""
        angle = (max(-100.0, min(100.0, pan)) + 100.0) / 200.0 * (math.pi / 2)
        return math.cos(angle), math.sin(angle)

# -*- coding: utf-8 -*-
"""内置拼接器 —— **照搬** `OpenUtau.Core/Classic/SharpWavtool.cs`（187 行）。

它是 Classic 线**唯一不依赖外部程序**的 wavtool，两个变体：

- `simple`（`phase_comp=False`）：每个音素按 `skipOver` 裁掉前导、按 `positionMs`
  叠进乐句缓冲，包络由 `ResamplerItem.ApplyEnvelope` 施加。
- `convergence`（`phase_comp=True`，OpenUTAU 的**默认**）：在 simple 的基础上做
  **相位对齐** —— 用 `IirPeak`（谐振器）+ 零相位滤波找出首/尾窗口里的基频周期峰，
  算出相邻音素拼接处的相位差，把它折算成 `correction`（样本数）后整体平移，
  让接缝处的波形尽量连续。

## 照搬时保留的怪癖（别"顺手修好"）
1. `Array.Resize(ref phraseSamples, ...)` 在**变小时会截断**。上游依赖"音素的
   `posSamples` 单调不减"，从前往后累加；照搬后语义一致。
2. `CalcPhase` 里 `DiscreteSignal(fs, samples)` 的采样率**只用于构造对象**，
   算法本身只用到 `padLength`，不用它 —— 所以这里直接把采样率丢掉。
3. `samples.Max() > 10 → return null` 是**滤波后**的信号判据，不是原始样本；
   谐振器把目标频率放大后容易溢出，这条是"这段不可信"的兜底。
4. `CalcPhase` 里 `Guard.AgainstInvalidRange(padLength, signal.Length, ...)`：
   窗口短于 6 个样本时会**抛异常**（不是返回 null）。`nwaves_filter` 保留了这个行为。
5. 相邻音素相位差的取模：
   `if (Math.Abs(diff - 2π) < diff) diff -= 2π;` —— 目的是让 `diff` 取到
   **离 0 更近**的那个等价角。写成别的取模方式会在某些相位下差一个周期。

## 与 C# 的载体差异（不是行为差异）
- `Wave.OpenFile(...).ToSampleProvider().ToMono(1, 0)` + `Wave.GetSamples(...)`
  → `Wave.get_samples(path)`（见 `wave.py` 的说明）。
- `CancellationTokenSource` → `threading.Event`（见 `i_wavtool.py`）。
- `IList<Vector2> envelope` 用 ustx 的 `Vector2`（同样是 (x, y) 二元组语义）。
- C# 的 `Segment` 是私有嵌套类；这里保持嵌套，字段名逐一对齐。
- 数值仍是 float64（C# 到处 float32），偏差同上。
"""

import math
import os
from typing import List, Optional

from ..music_math import MusicMath
from ..renderers import get_cache_lock
from ..wave import Wave
from ...ustx.model import Vector2
from .i_wavtool import IWavtool
from .nwaves_filter import ZiFilter, iir_peak

#: C# 里写死的采样率（`segment.posMs = ... * 44100 / 1000`）
SAMPLE_RATE = 44100


class SharpWavtool(IWavtool):
    """对应 C# 的 `SharpWavtool`。"""

    #: C# 的 `nameConvergence` / `nameSimple`
    NAME_CONVERGENCE = 'convergence'
    NAME_SIMPLE = 'simple'

    class _Segment:
        """对应 C# 的私有嵌套类 `Segment`。"""

        __slots__ = ('samples', 'pos_ms', 'pos_samples', 'skip_samples', 'correction',
                     'envelope', 'head_window_start', 'head_window_f0', 'head_phase',
                     'tail_window_start', 'tail_window_f0', 'tail_phase')

        def __init__(self):
            self.samples: List[float] = []
            self.pos_ms = 0.0
            self.pos_samples = 0
            self.skip_samples = 0
            self.correction = 0
            self.envelope: List[Vector2] = []
            self.head_window_start = 0
            self.head_window_f0 = 0.0
            self.head_phase: Optional[float] = None
            self.tail_window_start = 0
            self.tail_window_f0 = 0.0
            self.tail_phase: Optional[float] = None

    def __init__(self, phase_comp: bool):
        self.phase_comp = phase_comp

    # ------------------------------------------------------------------ 主入口

    def concatenate(self, resampler_items: List, temp_path: str,
                    cancellation=None) -> Optional[List[float]]:
        """对应 `Concatenate(List<ResamplerItem>, string, CancellationTokenSource)`。"""
        if cancellation is not None and cancellation.is_set():
            return None
        phrase = resampler_items[0].phrase
        segments: List[SharpWavtool._Segment] = []
        for item in resampler_items:
            segment = SharpWavtool._Segment()
            if item.phone.direct:
                samples = Wave.get_samples(item.input_file)
                # C# 是 `(int)` 截断转换（不是四舍五入）
                offset = int(item.phone.oto.offset / 1000 * SAMPLE_RATE)
                cutoff = int(item.phone.oto.cutoff / 1000 * SAMPLE_RATE)
                length = (len(samples) - offset - cutoff) if cutoff >= 0 else -cutoff
                # C# 是 `Skip(offset).Take(length)`：length ≤ 0 时取空，不是负索引切片
                segment.samples = samples[offset:offset + max(0, length)]
            else:
                # 与 ClassicRenderer 里 resampler 的**写**共用同一把按路径的锁：
                # 两条乐句共享同一份 resample 缓存时并发渲染，否则会撞上
                # "文件正被另一进程占用"
                lock = get_cache_lock(item.output_file)
                with lock:
                    if not os.path.isfile(item.output_file):
                        continue
                    segment.samples = Wave.get_samples(item.output_file)
            segments.append(segment)

            segment.pos_ms = (item.phone.position_ms - item.phone.leading_ms
                              - (phrase.position_ms - phrase.leading_ms))
            segment.pos_samples = int(round(segment.pos_ms * SAMPLE_RATE / 1000))
            segment.skip_samples = int(round(item.skip_over * SAMPLE_RATE / 1000))
            segment.envelope = item.envelope_ms_to_samples()

            if self.phase_comp:
                head_window, segment.head_window_start = self._get_head_window(
                    segment.samples, segment.envelope)
                segment.head_window_f0 = self._get_f0_at_sample(
                    phrase,
                    segment.pos_samples - segment.skip_samples
                    + segment.head_window_start + len(head_window) // 2)
                segment.head_phase = self._calc_phase(
                    head_window,
                    segment.pos_samples - segment.skip_samples + segment.head_window_start,
                    SAMPLE_RATE, segment.head_window_f0)

                tail_window, segment.tail_window_start = self._get_tail_window(
                    segment.samples, segment.envelope)
                segment.tail_window_f0 = self._get_f0_at_sample(
                    phrase,
                    segment.pos_samples - segment.skip_samples
                    + segment.tail_window_start + len(tail_window) // 2)
                segment.tail_phase = self._calc_phase(
                    tail_window,
                    segment.pos_samples - segment.skip_samples + segment.tail_window_start,
                    SAMPLE_RATE, segment.tail_window_f0)

            item.apply_envelope(segment.samples)

        # ---- 相位对齐：把当前音素的头部平移到上一个音素尾部的相位上
        if self.phase_comp:
            for i in range(1, len(segments)):
                tail_phase = segments[i - 1].tail_phase
                head_phase = segments[i].head_phase
                if tail_phase is None or head_phase is None:
                    continue
                last_corr_angle = (segments[i - 1].correction * 2.0 * math.pi
                                   / SAMPLE_RATE * segments[i].head_window_f0)
                diff = head_phase - (tail_phase - last_corr_angle)
                while diff < 0:
                    diff += 2 * math.pi
                while diff >= 2 * math.pi:
                    diff -= 2 * math.pi
                # 取离 0 更近的等价角（见模块 docstring 的怪癖 5）
                if abs(diff - 2 * math.pi) < diff:
                    diff -= 2 * math.pi
                segments[i].correction = int(
                    diff / 2 / math.pi * SAMPLE_RATE / segments[i].head_window_f0)

        # ---- 叠加（C# 的 Array.Resize 在变小时会截断，照搬）
        phrase_samples: List[float] = []
        for segment in segments:
            _resize(phrase_samples,
                    segment.pos_samples + segment.correction
                    + len(segment.samples) - segment.skip_samples)
            start = max(0, -segment.skip_samples)
            for i in range(start, len(segment.samples) - segment.skip_samples):
                phrase_samples[segment.pos_samples + segment.correction + i] += \
                    segment.samples[segment.skip_samples + i]
        return phrase_samples

    # ------------------------------------------------------------------ 相位窗口

    def _get_head_window(self, samples: List[float], envelope: List[Vector2]):
        """对应 `GetHeadWindow`：首两个包络点的中点为窗口中心，取 ≤880 个样本。"""
        window_center = (envelope[0] + envelope[1]) * 0.5
        window_start = max(int(window_center.x) - 440, 0)
        window_length = min(880, len(samples) - window_start)
        return samples[window_start:window_start + max(0, window_length)], window_start

    def _get_tail_window(self, samples: List[float], envelope: List[Vector2]):
        """对应 `GetTailWindow`：末两个包络点的中点为窗口中心。"""
        window_center = (envelope[-1] + envelope[-2]) * 0.5
        window_start = max(int(window_center.x) - 440, 0)
        window_length = min(880, len(samples) - window_start)
        return samples[window_start:window_start + max(0, window_length)], window_start

    def _get_f0_at_sample(self, phrase, sample_index: float) -> float:
        """对应 `GetF0AtSample`：样本下标 → 乐句音高 → 频率（Hz）。"""
        sample_ms = sample_index / SAMPLE_RATE * 1000
        sample_tick = phrase.time_axis.ms_pos_to_tick_pos(
            phrase.position_ms - phrase.leading_ms + sample_ms)
        pitch_index = int(round(
            (sample_tick - (phrase.position - phrase.leading)) / 5))
        pitch_index = max(0, min(len(phrase.pitches) - 1, pitch_index))
        return MusicMath.tone_to_freq(phrase.pitches[pitch_index] / 100)

    def _calc_phase(self, samples: List[float], offset: float, fs: int, f: float):
        """对应 `CalcPhase`：用谐振器 + 零相位滤波找窗口内的周期峰，返回相位。

        返回 `None` 表示"这段不可信"（样本太少 / 滤波后溢出 / 找不到峰 /
        测出的周期与期望频率差太远）。C# 同样用 `double?` 表达。
        """
        if len(samples) < 4:
            return None
        # C#: `new DiscreteSignal(fs, samples)`（采样率不进算法，见怪癖 2）
        peak_tf = iir_peak(f / fs, 5)
        filter_ = ZiFilter(peak_tf)
        samples = filter_.zero_phase(samples)
        if max(samples) > 10:
            return None
        left = 0.0
        right = 0.0
        for i in range(len(samples) // 2 - 1, 0, -1):
            if samples[i] >= samples[i - 1] and samples[i] >= samples[i + 1]:
                left = i
                break
        for i in range(len(samples) // 2, len(samples) - 1):
            if samples[i] >= samples[i - 1] and samples[i] >= samples[i + 1]:
                right = i
                break
        if left >= right:
            return None
        actual_f = fs / (right - left)
        if abs(f - actual_f) > f * 0.25:
            return None
        t = (offset + (left + right) * 0.5) / fs * f
        # Math.Round 与 Python 的 round() 同为 banker's rounding
        return 2 * math.pi * (round(t) - t)

    # ------------------------------------------------------------------ 其它

    def check_permissions(self) -> None:
        """对应 `CheckPermissions`：内置实现无需任何权限处理。"""
        return None

    def __str__(self):
        # 对应 `ToString() => phaseComp ? nameConvergence : nameSimple`
        return self.NAME_CONVERGENCE if self.phase_comp else self.NAME_SIMPLE

    __repr__ = __str__


def _resize(values: List[float], size: int) -> None:
    """对应 `Array.Resize(ref arr, size)`：**变大补 0、变小截断**（见怪癖 1）。

    负数长度在 C# 会抛 `ArgumentOutOfRangeException`，这里同样抛（不静默当空表）。
    """
    if size < 0:
        raise ValueError('Array.Resize 长度为负：%d' % size)
    if size < len(values):
        del values[size:]
    else:
        values.extend([0.0] * (size - len(values)))

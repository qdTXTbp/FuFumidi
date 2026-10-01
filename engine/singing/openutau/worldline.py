# -*- coding: utf-8 -*-
"""Worldline —— **照搬** `OpenUtau.Core/Render/Worldline.cs` 里**不含原生调用**的部分。

## 先看清楚：Worldline 不是纯 C#
`Worldline.cs`(780 行) 里约 380 行是 `[DllImport("worldline")]` —— 真正的 DSP 在
`cpp/worldline/`（1534 行 C++，Bazel 构建，vendor 了 WORLD / libpyin / spline），
预编译二进制随仓库分发（`runtimes/*/native/worldline.{dll,so,dylib}`）。
所以这里只搬**能脱离原生库成立**的那部分，原生边界单独放在 `WorldlineNative`：

| 本模块包含（纯逻辑） | 对应 C# |
|---|---|
| `AnalysisConfig` / `init_analysis_config` | `InitAnalysisConfig` 的**结构**与字段计算 |
| `get_samples_for_dio` / `world_synthesis_sample_count` | 两个 Count 导出函数的公式 |
| `get_flag` | `GetFlag` |
| `fit_curve` | `PhraseSynthV2.FitCurve` |
| `compute_timemap` | `SynthSegment` 的 `tSrc`/`tDst`/`stretch` 计算 |
| `resample_features` | `SynthSegment` 里按 `tDst` 对 f0/sp/ap 的线性插值 |
| `apply_pitch_bend` | `Resample` 里的音高弯曲线 → f0 |
| `resample_auto_gain` | `Resample` 的 auto gain（用 `ResamplerVoicedF0`） |
| `segment_auto_gain` | `SynthSegment.GetAutoGain`（用 `config.f0_floor`，阈值不同） |
| `blend_features` | `PhraseSynthV2.SynthFeatures` 的交叠混合 |
| `blend_continuous_noise_features` | `PhraseSynthV2.SynthContinuousNoise` 的交叠混合 |
| `WorldlineNative` | 那 10 个导出的 ctypes 绑定 |

## 照搬时保留的语义（别"整理"掉）
1. **`Resample` 与 `SynthSegment.GetAutoGain` 是两个不同的 auto gain**，别合并：
   - `Resample`：有声阈值 `ResamplerVoicedF0 = 40.0`；`max == 0` 才算退化；增益指数取 flag `P`（默认 86）。
   - `GetAutoGain`：有声阈值是 `config.f0_floor`；`max < 1e-3f` 就退化；同样取 flag `P`。
2. `AnalysisConfig.f0_floor` 在 C# 里是 **float**（`(float)GetF0FloorForCheapTrick(...)`），
   `frame_ms` 是 double。这里也按 float32 舍入 f0_floor，否则边界帧的"有声/无声"判定
   可能和 C# 差一帧。
3. `GetF0FloorForCheapTrick(fs, fft_size) = 3.0 * fs / (fft_size - 3.0)`（取自上游 WORLD
   的 `cheaptrick.cpp`，已核对）。
4. `SynthSegment` 的时间映射：`consonantSpeed = 0.5^(1 - velocity/100)`；
   `dstConsonantMs = srcConsonantMs / consonantSpeed`；
   `vowelSpeed = clamp(srcVowelMs/dstVowelMs, 0.01, 1.0)`，且**只有 `dstVowelMs > 0` 时才算**，
   否则取 1.0。`stretch` 在辅音段是 `1/consonantSpeed`、元音段是 `1/vowelSpeed`。
5. 重采样到 `tDst` 时把位置 `clamp(0, n-1)`，`index = floor(pos)`、`frac = pos - index`；
   `index + 1 < n` 才做线性插值，否则**直接取该帧**（不是外推）。
6. `blend_*` 的 `dirty` 规则：`weight` 只有三种取值（1.0 / 上升沿 / 下降沿）；
   `f0` 仅当 `dirty == 0 || weight > 0.5` 时才被覆盖；`sp` **累加**（初值 1e-12）；
   `ap` 是"`dirty==0` 时直接取自身值，否则按 `1-weight`/`weight` 混合"（初值 1.0）。
7. 混合结束后**把最后一帧复制成前一帧**（"the wavtool fades the phrase out"）。
8. `f0Curve` 覆盖只在 `f0 > f0_floor`（有声）的帧上生效。

## 与 C# 的载体差异
- C# 用 **NumSharp**（`NDArray`）表示 f0/sp/ap 矩阵；这里一律用**扁平 list**
  （`sp[k]` 的地址是 `frame * sp_size + k`）。数学一致，且正好对应 ctypes 要传的
  `double*` 扁平缓冲。C# 里 `SynthFeatures` 用二维数组、`SynthContinuousNoise`
  用扁平数组 —— 两者算式相同，这里统一成扁平。
- C# 的 `Math.Exp` / `Math.Pow` 是 double；Python 的 `math.exp` / `math.pow` 同精度。
"""

import ctypes
import math
import struct
from dataclasses import dataclass
from typing import Any, List, Optional, Sequence

from .music_math import MusicMath

# ---------------------------------------------------------------- 常量

#: `const int ResamplerPadding = 2`
RESAMPLER_PADDING = 2
#: `const double ResamplerVoicedF0 = 40.0`（world::kFloorF0StoneMask）
RESAMPLER_VOICED_F0 = 40.0
#: WORLD 的 `kFloorF0`（默认 f0 下限，仅用于对账）
FLOOR_F0 = 71.0

#: `Resample` 里写死的分析参数：`InitAnalysisConfig(44100, 441, 2048)`
RESAMPLER_FS = 44100
RESAMPLER_HOP_SIZE = 441
RESAMPLER_FFT_SIZE = 2048


# ---------------------------------------------------------------- 异常（对应 C# 的三个类）

class SynthRequestError(Exception):
    """对应 `SynthRequestError`：失败的请求挂在 `item` 上。"""

    def __init__(self, message='', item=None):
        super().__init__(message)
        self.item = item


class CutOffExceedDurationError(SynthRequestError):
    """对应 `CutOffExceedDurationError`。"""


class CutOffBeforeOffsetError(SynthRequestError):
    """对应 `CutOffBeforeOffsetError`。"""


# ---------------------------------------------------------------- AnalysisConfig


@dataclass
class AnalysisConfig:
    """对应 C# 的 `struct AnalysisConfig`（`fs / hop_size / fft_size / f0_floor / frame_ms`）。"""

    fs: int = 0
    hop_size: int = 0
    fft_size: int = 0
    f0_floor: float = 0.0
    frame_ms: float = 0.0


def _as_float32(v: float) -> float:
    """把 double 舍成 float32（对应 C# 的 `(float)expr`）。"""
    return struct.unpack('<f', struct.pack('<f', v))[0]


def get_f0_floor_for_cheap_trick(fs: int, fft_size: int) -> float:
    """对应上游 WORLD 的 `GetF0FloorForCheapTrick`：`3 * fs / (fft_size - 3)`。

    C# 调用处会 `(float)` 转换，所以这里也做 float32 舍入。
    """
    return _as_float32(3.0 * fs / (fft_size - 3.0))


def init_analysis_config(fs: int, hop_size: int, fft_size: int,
                         backend: Optional['WorldlineNative'] = None) -> AnalysisConfig:
    """对应 `InitAnalysisConfig(fs, hop_size, fft_size)`。

    ★ 有原生后端时**优先问原生库**（它是唯一权威），Python 侧的公式只在没有后端时兜底。
    """
    if backend is not None and backend.available:
        return backend.init_analysis_config(fs, hop_size, fft_size)
    return AnalysisConfig(
        fs=fs,
        hop_size=hop_size,
        fft_size=fft_size,
        f0_floor=get_f0_floor_for_cheap_trick(fs, fft_size),
        frame_ms=hop_size * 1000.0 / fs,
    )


def get_samples_for_dio(fs: int, x_length: int, frame_period: float) -> int:
    """对应 WORLD 的 `GetSamplesForDIO(fs, x_length, frame_period)`。"""
    return int(1000.0 * x_length / fs / frame_period) + 1


def f0_frame_count(length: int, fs: int, frame_period: float, method: int) -> int:
    """对应原生 `F0FrameCount(length, fs, frame_period, method)`。

    注意 `method == 2`（pyin）会再取一次 `length / round(fs*frame_period/1000)` 的较大值 ——
    pyin 的步进因取整可能比 frame_period 略小。
    """
    if length <= 0:
        return 0
    count = get_samples_for_dio(fs, length, frame_period)
    if method == 2:
        nhop = max(1, int(round(fs * frame_period / 1000.0)))
        count = max(count, length // nhop)
    return count


def world_synthesis_sample_count(f0_length: int, frame_period: float, fs: int) -> int:
    """对应原生 `WorldSynthesisSampleCount(f0_length, frame_period, fs)`。"""
    if f0_length <= 0:
        return 0
    return 1 + int((f0_length - 1) * frame_period / 1000.0 * fs)


# ---------------------------------------------------------------- 小工具


def get_flag(item, name: str, default_value: int) -> int:
    """对应 `GetFlag`：在 `item.flags` 里找 `flag[0] == name` 且带了值的第一个。"""
    for flag in getattr(item, 'flags', None) or []:
        if flag[0] == name:
            if flag[1] is not None:
                return flag[1]
            return default_value
    return default_value


def fit_curve(curve: Optional[Sequence[float]], length: int,
              default_value: float) -> List[float]:
    """对应 `FitCurve`：把曲线拉伸/截断到 `length` 帧，**不足部分用曲线末值填充**。

    ★ 别写成"用默认值填充"：C# 是 `Array.Fill(result, curve[^1], copy, length - copy)`。
    只有 `curve` 为 null / 空时才整体填 `default_value`。
    """
    result = [0.0] * length
    if curve is None or len(curve) == 0:
        for i in range(length):
            result[i] = default_value
        return result
    copy = min(length, len(curve))
    for i in range(copy):
        result[i] = curve[i]
    last = curve[-1]
    for i in range(copy, length):
        result[i] = last
    return result


# ---------------------------------------------------------------- SynthSegment 的纯逻辑


def voice_ratio(f0: Sequence[float], floor: float) -> float:
    """有声帧占比（C# 里 `f0.Count(f => f > floor) / (double)f0.Length`）。"""
    if not f0:
        return 0.0
    return sum(1 for f in f0 if f > floor) / float(len(f0))


def logistic_weight(voiced_ratio: float) -> float:
    """`1 / (1 + exp(5 - 10 * voicedRatio))`（两处 auto gain 共用）。"""
    return 1.0 / (1.0 + math.exp(5.0 - 10.0 * voiced_ratio))


def compute_frame_bounds(frame_ms: float, pos_ms: float, skip_ms: float,
                         length_ms: float, fade_in_ms: float, fade_out_ms: float):
    """对应 `SynthSegment` 构造里的 `skipFrames / p0 / p1 / p3 / p4` 计算。

    ★ 三段夹紧**不能省**，它们正是 `_blend_weight` 里除法的前提：
    `p0 = max(0, p0)` / `p1 = max(p0 + 1, p1)` / `p3 = min(p4 - 1, p3)`。
    少了它们，`p1 - p0` 或 `p4 - p3` 会变成 0 → 除零。
    注意用的是 `Math.Round`（**四舍六入五成双**）→ Python `round()`。
    """
    skip_frames = int(round(skip_ms / frame_ms))
    p0 = int(round(pos_ms / frame_ms))
    p1 = int(round((pos_ms + fade_in_ms) / frame_ms))
    p3 = int(round((pos_ms + length_ms - fade_out_ms) / frame_ms))
    p4 = int(round((pos_ms + length_ms) / frame_ms))
    p0 = max(0, p0)
    p1 = max(p0 + 1, p1)
    p3 = min(p4 - 1, p3)
    return skip_frames, p0, p1, p3, p4


def compute_timemap(src_start_frame: int, src_end_frame: int, offset_frac_ms: float,
                    dur_required: float, velocity: float, consonant: float,
                    frame_ms: float):
    """对应 `SynthSegment` 里 `tSrc` / `tDst` / `stretch` 的那段。

    `velocity` 是 **ResamplerItem 的 ×100 整数值**（所以 `1 - velocity/100` 通常在 0 附近）。
    返回 `(t_dst, stretch)`；`t_src` 只是 `i * frame_ms`，不单独返回。
    """
    src_len_frames = src_end_frame - src_start_frame
    if src_len_frames < 0:
        src_len_frames = 0

    n_dst = int(math.ceil(dur_required / frame_ms))
    t_dst = [0.0] * n_dst
    stretch = [0.0] * n_dst

    src_length_ms = src_len_frames * frame_ms - offset_frac_ms
    consonant_speed = math.pow(0.5, 1.0 - velocity / 100.0)
    src_consonant_ms = consonant
    src_vowel_ms = src_length_ms - src_consonant_ms
    dst_length_ms = n_dst * frame_ms
    dst_consonant_ms = src_consonant_ms / consonant_speed
    dst_vowel_ms = dst_length_ms - dst_consonant_ms
    vowel_speed = (max(0.01, min(1.0, src_vowel_ms / dst_vowel_ms))
                   if dst_vowel_ms > 0 else 1.0)

    for i in range(n_dst):
        dst_ms = i * frame_ms
        if dst_ms < dst_consonant_ms:
            src_ms = dst_ms * consonant_speed
            t_dst[i] = (src_ms + offset_frac_ms) / frame_ms + src_start_frame
            stretch[i] = 1.0 / consonant_speed
        else:
            vowel_ms = dst_ms - dst_consonant_ms
            src_ms = src_consonant_ms + vowel_ms * vowel_speed
            t_dst[i] = (src_ms + offset_frac_ms) / frame_ms + src_start_frame
            stretch[i] = 1.0 / vowel_speed
    return t_dst, stretch


def resample_features(t_dst: Sequence[float], f0_src: Sequence[float],
                      sp_src: Sequence[float], ap_src: Sequence[float],
                      sp_size: int):
    """对应 `SynthSegment` 里按 `tDst` 对 f0/sp/ap 做线性插值的那段。

    `sp_src` / `ap_src` 是**扁平**数组（第 i 帧的第 k 个频点 = `i * sp_size + k`）。
    返回 `(f0_dst, sp_dst, ap_dst)`（同样扁平）。
    """
    n_src = len(f0_src)
    n = len(t_dst)
    f0_dst = [0.0] * n
    sp_dst = [0.0] * (n * sp_size)
    ap_dst = [0.0] * (n * sp_size)
    for i in range(n):
        pos = max(0.0, min(t_dst[i], n_src - 1.0))
        index = int(math.floor(pos))
        frac = pos - index
        if index + 1 < n_src:
            i1 = (index + 1) * sp_size
            i0 = index * sp_size
            o = i * sp_size
            f0_dst[i] = f0_src[index] * (1.0 - frac) + f0_src[index + 1] * frac
            for k in range(sp_size):
                sp_dst[o + k] = sp_src[i0 + k] * (1.0 - frac) + sp_src[i1 + k] * frac
                ap_dst[o + k] = ap_src[i0 + k] * (1.0 - frac) + ap_src[i1 + k] * frac
        else:
            o = i * sp_size
            i0 = index * sp_size
            f0_dst[i] = f0_src[index]
            for k in range(sp_size):
                sp_dst[o + k] = sp_src[i0 + k]
                ap_dst[o + k] = ap_src[i0 + k]
    return f0_dst, sp_dst, ap_dst


def apply_pitch_bend(f0: List[float], pitches: Sequence[int], tone: int,
                     start_ms: float, step_ms: float, frame_ms: float,
                     f0_floor: float) -> None:
    """对应 `Resample` 里的音高弯曲线（**就地**改 `f0`）。

    - 无声帧（`f0 <= f0_floor`）**保持分析出来的 f0 不变**。
    - 音高曲线是"每 5 tick 一个音分值"，按 `stepMs` 采样并线性插值，位置夹在
      `[0, len-1]`；末点直接取最后一个值（不外推）。
    - 最后把"音高号"换成频率：`item.tone + pitch * 0.01`。
    """
    n_pitch = len(pitches)
    for i in range(len(f0)):
        if f0[i] <= f0_floor:
            continue
        pitch = 0.0
        if n_pitch > 0:
            pos = max(0.0, min((i * frame_ms - start_ms) / step_ms, float(n_pitch - 1)))
            index = int(math.floor(pos))
            t = pos - index
            if index + 1 < n_pitch:
                pitch = pitches[index] * (1 - t) + pitches[index + 1] * t
            else:
                pitch = pitches[index]
        f0[i] = tone_to_freq(tone + pitch * 0.01)


def tone_to_freq(tone: float) -> float:
    """对应 `MusicMath.ToneToFreq`（转调共用一份实现，避免两处公式漂移）。"""
    return MusicMath.tone_to_freq(tone)


def resample_auto_gain(output: Sequence[float], wav_max: float,
                       f0: Sequence[float], direct: bool, volume: float,
                       peak_comp: int) -> float:
    """对应 `Resample` 里的 auto gain，返回**要乘到输出上的系数**。

    ★ 与 `segment_auto_gain` 的区别见模块 docstring 第 1 条。
    """
    voiced_ratio = voice_ratio(f0, RESAMPLER_VOICED_F0)
    weight = logistic_weight(voiced_ratio)
    out_max = max((abs(s) for s in output), default=0.0) if output else 0.0
    mx = out_max * weight + wav_max * (1.0 - weight)
    gain = (0 if direct else volume) * 0.01
    auto_gain = 1.0 if mx == 0 else math.pow(0.5 / mx, peak_comp * 0.01)
    return auto_gain * gain


def segment_auto_gain(samples: Sequence[float], f0: Sequence[float],
                      wav_max: float, f0_floor: float, peak_comp: int) -> float:
    """对应 `SynthSegment.GetAutoGain`（**另一个** auto gain，阈值与退化点都不同）。"""
    seg_max = max((abs(s) for s in samples), default=0.0) if samples else 0.0
    voiced_ratio = voice_ratio(f0, f0_floor)
    weight = logistic_weight(voiced_ratio)
    mx = seg_max * weight + wav_max * (1.0 - weight)
    if mx < 1e-3:
        return 1.0
    return math.pow(0.5 / mx, peak_comp * 0.01)


# ---------------------------------------------------------------- 特征混合


def _blend_weight(j: int, p0: int, p1: int, p3: int, p4: int) -> float:
    """`SynthFeatures` / `SynthContinuousNoise` 共用的 `weight` 三分支。"""
    if j < p1:
        return (j - p0) / (p1 - p0)
    if j >= p3:
        return (p4 - j) / (p4 - p3)
    return 1.0


def blend_features(segments: Sequence[Any], sp_size: int,
                   f0_curve: Optional[Sequence[float]] = None,
                   f0_floor: float = 0.0):
    """对应 `PhraseSynthV2.SynthFeatures`。

    段对象需带：`p0 / p1 / p3 / p4 / skip_frames / f0 / sp_env / ap`
    （`f0` 与 `sp_env` / `ap` 都是**扁平**数组）。返回 `(total_frames, f0, sp, ap)`。
    """
    total_frames = max(s.p4 for s in segments) + 1
    f0_out = [0.0] * total_frames
    sp_out = [1e-12] * (total_frames * sp_size)
    ap_out = [1.0] * (total_frames * sp_size)
    dirty = [0] * total_frames

    for seg in segments:
        for j in range(seg.p0, seg.p4):
            weight = _blend_weight(j, seg.p0, seg.p1, seg.p3, seg.p4)
            seg_idx = seg.skip_frames + j - seg.p0
            if dirty[j] == 0 or weight > 0.5:
                f0_out[j] = seg.f0[seg_idx]
            o = j * sp_size
            so = seg_idx * sp_size
            wa = 0.0 if dirty[j] == 0 else (1.0 - weight)
            wb = 1.0 if dirty[j] == 0 else weight
            for k in range(sp_size):
                sp_out[o + k] = sp_out[o + k] + seg.sp_env[so + k] * weight
                ap_out[o + k] = ap_out[o + k] * wa + seg.ap[so + k] * wb
            dirty[j] = 1

    if total_frames >= 2:
        last = total_frames - 1
        f0_out[last] = f0_out[last - 1]
        o = last * sp_size
        po = (last - 1) * sp_size
        for k in range(sp_size):
            sp_out[o + k] = sp_out[po + k]
            ap_out[o + k] = ap_out[po + k]

    if f0_curve is not None:
        f0_fit = fit_curve(f0_curve, total_frames, 0)
        for i in range(total_frames):
            if f0_out[i] > f0_floor:
                f0_out[i] = f0_fit[i]

    return total_frames, f0_out, sp_out, ap_out


def blend_continuous_noise_features(segments: Sequence[Any], sp_size: int,
                                    f0_curve: Optional[Sequence[float]] = None,
                                    f0_floor: float = 0.0):
    """对应 `PhraseSynthV2.SynthContinuousNoise` 的特征混合（R1.1）。

    比 `blend_features` 多混一条 `sp_harmonic`（谐波半边的包络）与逐帧 `stretch`。
    段对象需额外带 `sp_env_harmonic` 与 `stretch`（后者是**每帧**一个值）。
    """
    total_frames = max(s.p4 for s in segments) + 1
    f0 = [0.0] * total_frames
    sp = [1e-12] * (total_frames * sp_size)
    sp_harmonic = [1e-12] * (total_frames * sp_size)
    ap = [1.0] * (total_frames * sp_size)
    stretch = [1.0] * total_frames
    dirty = [False] * total_frames

    for seg in segments:
        for j in range(seg.p0, seg.p4):
            weight = _blend_weight(j, seg.p0, seg.p1, seg.p3, seg.p4)
            seg_idx = seg.skip_frames + j - seg.p0
            if (not dirty[j]) or weight > 0.5:
                f0[j] = seg.f0[seg_idx]
            o = j * sp_size
            so = seg_idx * sp_size
            wa = (1.0 - weight) if dirty[j] else 0.0
            wb = weight if dirty[j] else 1.0
            for k in range(sp_size):
                sp[o + k] += seg.sp_env[so + k] * weight
                sp_harmonic[o + k] += seg.sp_env_harmonic[so + k] * weight
                ap[o + k] = ap[o + k] * wa + seg.ap[so + k] * wb
            stretch[j] = stretch[j] * wa + seg.stretch[seg_idx] * wb
            dirty[j] = True

    if total_frames >= 2:
        last = total_frames - 1
        f0[last] = f0[last - 1]
        stretch[last] = stretch[last - 1]
        o = last * sp_size
        po = (last - 1) * sp_size
        for k in range(sp_size):
            sp[o + k] = sp[po + k]
            sp_harmonic[o + k] = sp_harmonic[po + k]
            ap[o + k] = ap[po + k]

    if f0_curve is not None:
        f0_fit = fit_curve(f0_curve, total_frames, 0)
        for i in range(total_frames):
            if f0[i] > f0_floor:
                f0[i] = f0_fit[i]

    return total_frames, f0, sp_harmonic, ap, stretch


# ---------------------------------------------------------------- 原生边界


class WorldlineNative:
    """`worldline` 原生库的 ctypes 绑定（对应 `Worldline.cs` 里那 10 个 `DllImport`）。

    ★ 这是**可选**的：找不到库时 `available` 为 False，纯逻辑部分照常工作，
    只有真正要分析/合成时才会抛错。库名与查找顺序照搬 C# 的 `DllImport("worldline")`
    在各平台上的解析结果（`worldline.dll` / `libworldline.so` / `libworldline.dylib`）。

    `library_path` 可显式指定（便于把随包分发的 `worldline.dll` 指过来）。
    """

    _LIB_NAMES = ('worldline.dll', 'libworldline.so', 'libworldline.dylib', 'worldline')

    def __init__(self, library_path: Optional[str] = None):
        self._lib = None
        self.error: Optional[str] = None
        try:
            self._lib = ctypes.CDLL(library_path or 'worldline')
            self._bind()
        except Exception as e:                     # 找不到库不是致命错误
            self._lib = None
            self.error = str(e)

    def _bind(self):
        lib = self._lib
        lib.F0FrameCount.restype = ctypes.c_int
        lib.F0FrameCount.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_double, ctypes.c_int]
        lib.F0.restype = ctypes.c_int
        lib.F0.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.c_int, ctypes.c_int,
                           ctypes.c_double, ctypes.c_int, ctypes.POINTER(ctypes.c_double)]
        lib.WorldSynthesisSampleCount.restype = ctypes.c_int
        lib.WorldSynthesisSampleCount.argtypes = [ctypes.c_int, ctypes.c_double, ctypes.c_int]

    @property
    def available(self) -> bool:
        return self._lib is not None

    def init_analysis_config(self, fs: int, hop_size: int, fft_size: int) -> AnalysisConfig:
        """问原生库要 `AnalysisConfig`（唯一权威来源）。

        原生侧的 `InitAnalysisConfig(AnalysisConfig*, fs, hop_size, fft_size)` 只写结构体，
        不分配任何内存，所以这里用一块 ctypes 结构体直接取回。
        """

        class _NativeConfig(ctypes.Structure):
            _fields_ = [('fs', ctypes.c_int),
                        ('hop_size', ctypes.c_int),
                        ('fft_size', ctypes.c_int),
                        ('f0_floor', ctypes.c_float),
                        ('frame_ms', ctypes.c_double)]

        if not self.available:
            raise SynthRequestError('worldline 原生库不可用：%s' % (self.error or '未加载'))
        func = self._lib.InitAnalysisConfig
        func.restype = None
        func.argtypes = [ctypes.POINTER(_NativeConfig), ctypes.c_int, ctypes.c_int, ctypes.c_int]
        cfg = _NativeConfig()
        func(ctypes.byref(cfg), fs, hop_size, fft_size)
        return AnalysisConfig(fs=cfg.fs, hop_size=cfg.hop_size, fft_size=cfg.fft_size,
                              f0_floor=cfg.f0_floor, frame_ms=cfg.frame_ms)


#: 默认实例（惰性创建；找不到库时 available 为 False，不影响纯逻辑）
default_native: Optional[WorldlineNative] = None


def get_native(library_path: Optional[str] = None) -> WorldlineNative:
    """取（并缓存）原生库绑定。"""
    global default_native
    if default_native is None or (library_path and not default_native.available):
        default_native = WorldlineNative(library_path)
    return default_native

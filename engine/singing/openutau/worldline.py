# -*- coding: utf-8 -*-
"""Worldline —— **照搬** `OpenUtau.Core/Render/Worldline.cs`（780 行）。

## 先看清楚：Worldline 不是纯 C#
`Worldline.cs` 里约 380 行是 `[DllImport("worldline")]` —— 真正的 DSP 在
`cpp/worldline/`（1534 行 C++，Bazel 构建，vendor 了 WORLD / libpyin / spline），
预编译二进制随仓库分发（`runtimes/*/native/worldline.{dll,so,dylib}`）。
所以这里把**能脱离原生库成立的纯逻辑**放在模块级，原生调用收进 `WorldlineNative`
一个类里；`resample()` 则是把两者串起来的那条主路径。

| 本模块 | 对应 C# |
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
| `SynthSegment` | 私有嵌套类 `SynthSegment`（含 `.frq` 接入与裁段） |
| `resample` | `Worldline.Resample(ResamplerItem)` —— **经典线的变调入口** |
| `WorldlineNative` | ctypes 绑定（已绑 6 个导出，见该类的 docstring） |

**未照搬**：`PhraseSynthV2` 整个类（含 `AnalyzeRequests` 的并行分析、
`Synth` / `SynthContinuousNoise`）—— 它只被 `WorldlineRenderer` 用，等 P1-d 一起搬；
届时还要补 `DecodeMgc` / `DecodeBap` / `HnAnalysisF0In` / `WorldSynthesisContinuousNoise`
四个绑定与 `Core/Analysis/Hnsep`（R1.1）。

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
9. **`SynthSegment` 的两条构造路径增益位置相反**：resampler 那条（`forResampler: true`）
   不做输入增益、增益在 `Resample` 的输出端做，且 cutoff 超过文件长度是**错误**；
   乐句合成那条（`forResampler: false`）在**输入端**乘增益，并额外算
   `skipFrames / p0 / p1 / p3 / p4`。C# 用构造器链实现，这里用 `for_resampler` 参数
   —— 但语义等价，且 `p0..p4` 只有乐句那条才会被设置。
10. `.frq` 接入时的**帧对齐**：`ratio = config.hop_size / frq.hopSize`，
    分析帧 i 覆盖 `[floor(i*ratio), ceil((i+1)*ratio)]` 这段 `.frq` 帧，
    只把其中 `> f0_floor` 的取平均；一个有声帧都没有就写 0。
    这也是 `F0(..., method: -1)` 的意义 —— 有 `.frq` 时只问帧数，不真做 F0 提取。
11. `srcEndMs` 的两支不对称（与 `Frq.Cs` 的 cutoff 换算同源）：
    `cutoff < 0` 时是 `-cutoff + offset`，否则是 `wavMs - cutoff`。
12. **`F0FrameCount` 是上界，不是"帧数"**：缓冲按它分配，但 `F0` 返回的是估计器
    实际产出的帧数（可能更少 —— 实测 pyin 对 1 秒 44.1kHz 是 99 帧、容量 101）。
    所以 `f0()` 必须按返回值**裁长度**。`method == -1`（"只要帧数"）则是把整块
    缓冲填 0 并返回**容量** —— `.frq` 那条路径正是靠这个：先拿一整套 0，
    再用 `.frq` 的值把每一帧覆盖掉。

## 与 C# 的载体差异
- C# 用 **NumSharp**（`NDArray`）表示 f0/sp/ap 矩阵；这里一律用**扁平 list**
  （`sp[k]` 的地址是 `frame * sp_size + k`）。数学一致，且正好对应 ctypes 要传的
  `double*` 扁平缓冲。C# 里 `SynthFeatures` 用二维数组、`SynthContinuousNoise`
  用扁平数组 —— 两者算式相同，这里统一成扁平。
- C# 的 `Math.Exp` / `Math.Pow` 是 double；Python 的 `math.exp` / `math.pow` 同精度。
"""

import ctypes
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, List, Optional, Sequence, Tuple

from .music_math import MusicMath, as_float32
from .wave import Wave

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


class SynthCancelled(Exception):
    """对应 C# 的 `OperationCanceledException`（`ParallelOptions.CancellationToken` 触发）。

    `RenderPhrase`/渲染器只需 `catch` 它然后返回已有结果，语义与 C# 一致。
    """


# ---------------------------------------------------------------- AnalysisConfig


@dataclass
class AnalysisConfig:
    """对应 C# 的 `struct AnalysisConfig`（`fs / hop_size / fft_size / f0_floor / frame_ms`）。"""

    fs: int = 0
    hop_size: int = 0
    fft_size: int = 0
    f0_floor: float = 0.0
    frame_ms: float = 0.0


def get_f0_floor_for_cheap_trick(fs: int, fft_size: int) -> float:
    """对应上游 WORLD 的 `GetF0FloorForCheapTrick`：`3 * fs / (fft_size - 3)`。

    C# 调用处会 `(float)` 转换，所以这里也做 float32 舍入。
    """
    return as_float32(3.0 * fs / (fft_size - 3.0))


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

    返回 `(total_frames, f0, sp, sp_harmonic, ap, stretch)` —— **六个**，
    与 C# 传给 `WorldSynthesisContinuousNoise` 的五个数组 + 帧数一一对应。
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

    # ★ 必须把 **sp 与 sp_harmonic 都返回** —— C# 的
    #   `WorldSynthesisContinuousNoise(f0, sp, spHarmonic, ap, stretch, ...)` 要两个都吃。
    #   （早前这版漏了 `sp`，而当时的测试跟着实现写成了 5 元组，于是"一致地错"。）
    return total_frames, f0, sp, sp_harmonic, ap, stretch


# ---------------------------------------------------------------- 原生边界


class _NativeAnalysisConfig(ctypes.Structure):
    """对应 `cpp/worldline/worldline.h` 的 `struct AnalysisConfig`（字段顺序即内存布局）。"""

    _fields_ = [('fs', ctypes.c_int),
                ('hop_size', ctypes.c_int),
                ('fft_size', ctypes.c_int),
                ('f0_floor', ctypes.c_float),
                ('frame_ms', ctypes.c_double)]


def _f32_buffer(values: Sequence[float]):
    return (ctypes.c_float * len(values))(*values)


def _f64_buffer(values: Sequence[float]):
    return (ctypes.c_double * len(values))(*values)


class WorldlineNative:
    """`worldline` 原生库的 ctypes 绑定（对应 `Worldline.cs` 里的 `[DllImport]`）。

    ★ 这是**可选**的：找不到库时 `available` 为 False，纯逻辑部分照常工作，
    只有真正要分析/合成时才会抛错。库名与查找顺序照搬 C# 的 `DllImport("worldline")`
    在各平台上的解析结果（`worldline.dll` / `libworldline.so` / `libworldline.dylib`）。

    `library_path` 可显式指定（便于把随包分发的 `worldline.dll` 指过来）。

    **已绑定**（`Resample` 这条链路要用的）：`F0FrameCount` / `F0` /
    `InitAnalysisConfig` / `WorldAnalysisF0In` / `WorldSynthesisSampleCount` /
    `WorldSynthesis`。
    **未绑定**（调用方还没搬进来）：`DecodeMgc` / `DecodeBap` / `HnAnalysisF0In` /
    `WorldSynthesisContinuousNoise` —— 它们分别服务 R1.1 的 `Hnsep` 分析与
    `PhraseSynthV2.SynthContinuousNoise`，等 `PhraseSynthV2` 落地时一起补。
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
        lib.InitAnalysisConfig.restype = None
        lib.InitAnalysisConfig.argtypes = [ctypes.POINTER(_NativeAnalysisConfig),
                                          ctypes.c_int, ctypes.c_int, ctypes.c_int]
        lib.WorldAnalysisF0In.restype = None
        lib.WorldAnalysisF0In.argtypes = [ctypes.POINTER(_NativeAnalysisConfig),
                                          ctypes.POINTER(ctypes.c_float), ctypes.c_int,
                                          ctypes.POINTER(ctypes.c_double), ctypes.c_int,
                                          ctypes.POINTER(ctypes.c_double),
                                          ctypes.POINTER(ctypes.c_double)]
        lib.WorldSynthesisSampleCount.restype = ctypes.c_int
        lib.WorldSynthesisSampleCount.argtypes = [ctypes.c_int, ctypes.c_double, ctypes.c_int]
        # 扁平数组那一版重载（C# 里 `double[] mgcOrSp` 那个）
        lib.WorldSynthesisContinuousNoise.restype = ctypes.c_int
        lib.WorldSynthesisContinuousNoise.argtypes = [
            ctypes.POINTER(ctypes.c_double), ctypes.c_int,
            ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double),
            ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double),
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_double),
            ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double),
            ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double)]
        lib.WorldSynthesis.restype = ctypes.c_int
        lib.WorldSynthesis.argtypes = [ctypes.POINTER(ctypes.c_double), ctypes.c_int,
                                       ctypes.POINTER(ctypes.c_double), ctypes.c_bool,
                                       ctypes.c_int,
                                       ctypes.POINTER(ctypes.c_double), ctypes.c_bool,
                                       ctypes.c_int,
                                       ctypes.c_double, ctypes.c_int,
                                       ctypes.POINTER(ctypes.c_double),
                                       ctypes.POINTER(ctypes.c_double),
                                       ctypes.POINTER(ctypes.c_double),
                                       ctypes.POINTER(ctypes.c_double),
                                       ctypes.POINTER(ctypes.c_double)]

    @property
    def available(self) -> bool:
        return self._lib is not None

    def _require(self) -> None:
        if not self.available:
            raise SynthRequestError('worldline 原生库不可用：%s' % (self.error or '未加载'))

    def init_analysis_config(self, fs: int, hop_size: int, fft_size: int) -> AnalysisConfig:
        """问原生库要 `AnalysisConfig`（唯一权威来源）。

        原生侧的 `InitAnalysisConfig(AnalysisConfig*, fs, hop_size, fft_size)` 只写结构体，
        不分配任何内存，所以这里用一块 ctypes 结构体直接取回。
        """
        self._require()
        cfg = _NativeAnalysisConfig()
        self._lib.InitAnalysisConfig(ctypes.byref(cfg), fs, hop_size, fft_size)
        return AnalysisConfig(fs=cfg.fs, hop_size=cfg.hop_size, fft_size=cfg.fft_size,
                              f0_floor=cfg.f0_floor, frame_ms=cfg.frame_ms)

    def f0_frame_count(self, length: int, fs: int, frame_period: float, method: int) -> int:
        """对应原生 `F0FrameCount`（`F0` 的输出缓冲上界）。"""
        self._require()
        return self._lib.F0FrameCount(length, fs, frame_period, method)

    def f0(self, samples: Sequence[float], fs: int, frame_period: float,
           method: int) -> List[float]:
        """对应 `Worldline.F0(samples, fs, framePeriod, method)`。

        ★ 与 C# 的差异：原包装 `catch` 住异常后**返回 null**（调用方随即 NRE），
        这里让 `SynthRequestError` 直接冒出来 —— 失败语义相同，但错误信息可读。
        """
        self._require()
        count = self._lib.F0FrameCount(len(samples), fs, frame_period, method)
        buffer = (ctypes.c_double * count)()
        size = self._lib.F0(_f32_buffer(samples), len(samples), fs, frame_period,
                            method, buffer)
        if size == count:
            return list(buffer)
        return list(buffer[:size])

    def world_analysis_f0_in(self, config: AnalysisConfig, samples: Sequence[float],
                             f0_in: Sequence[float]):
        """对应 `Worldline.WorldAnalysisF0In` → 返回 `(sp_env, ap)`，都按**扁平**排布。

        每帧 `fft_size // 2 + 1` 个 double；第 i 帧第 k 个频点 = `i * sp_size + k`。
        """
        self._require()
        num_frames = len(f0_in)
        sp_size = config.fft_size // 2 + 1
        sp_env = (ctypes.c_double * (num_frames * sp_size))()
        ap = (ctypes.c_double * (num_frames * sp_size))()
        cfg = _NativeAnalysisConfig(fs=config.fs, hop_size=config.hop_size,
                                    fft_size=config.fft_size,
                                    f0_floor=config.f0_floor, frame_ms=config.frame_ms)
        self._lib.WorldAnalysisF0In(ctypes.byref(cfg), _f32_buffer(samples),
                                    len(samples), _f64_buffer(f0_in), num_frames,
                                    sp_env, ap)
        return list(sp_env), list(ap)

    def world_synthesis_continuous_noise(
            self, f0: Sequence[float], sp: Sequence[float], harmonic_sp: Sequence[float],
            ap: Sequence[float], stretch: Sequence[float],
            fft_size: int, hop_size: int, fs: int, seed: int,
            gender: Sequence[float], tension: Sequence[float],
            breathiness: Sequence[float], voicing: Sequence[float]) -> List[float]:
        """对应 `Worldline.WorldSynthesisContinuousNoise`（R1.1 的合成）。

        输出长度用 `WorldSynthesisSampleCount(f0.Length, hopSize*1000/fs, fs)` 算
        —— 注意这里的帧周期是**用 hopSize 换算的**，不是 `config.frame_ms`。
        """
        self._require()
        frame_period = hop_size * 1000.0 / fs
        count = self._lib.WorldSynthesisSampleCount(len(f0), frame_period, fs)
        y = (ctypes.c_double * count)()
        self._lib.WorldSynthesisContinuousNoise(
            _f64_buffer(f0), len(f0),
            _f64_buffer(sp), _f64_buffer(harmonic_sp),
            _f64_buffer(ap), _f64_buffer(stretch),
            fft_size, hop_size, fs, seed, y,
            _f64_buffer(gender), _f64_buffer(tension),
            _f64_buffer(breathiness), _f64_buffer(voicing))
        return list(y)

    def world_synthesis(self, f0: Sequence[float], mgc_or_sp: Sequence[float],
                        is_mgc: bool, mgc_size: int,
                        bap_or_ap: Sequence[float], is_bap: bool, fft_size: int,
                        frame_period: float, fs: int,
                        gender: Sequence[float], tension: Sequence[float],
                        breathiness: Sequence[float], voicing: Sequence[float]) -> List[float]:
        """对应扁平数组那一版 `Worldline.WorldSynthesis`（`isMgc` / `isBap` 都是 false）。"""
        self._require()
        count = self._lib.WorldSynthesisSampleCount(len(f0), frame_period, fs)
        y = (ctypes.c_double * count)()
        self._lib.WorldSynthesis(_f64_buffer(f0), len(f0),
                                 _f64_buffer(mgc_or_sp), bool(is_mgc), mgc_size,
                                 _f64_buffer(bap_or_ap), bool(is_bap), fft_size,
                                 frame_period, fs, y,
                                 _f64_buffer(gender), _f64_buffer(tension),
                                 _f64_buffer(breathiness), _f64_buffer(voicing))
        return list(y)


#: 默认实例（惰性创建；找不到库时 available 为 False，不影响纯逻辑）
default_native: Optional[WorldlineNative] = None


def get_native(library_path: Optional[str] = None) -> WorldlineNative:
    """取（并缓存）原生库绑定。"""
    global default_native
    if default_native is None or (library_path and not default_native.available):
        default_native = WorldlineNative(library_path)
    return default_native


# ---------------------------------------------------------------- SynthSegment / Resample


class SynthSegment:
    """对应 `Worldline.cs` 的私有嵌套类 `SynthSegment`。

    它把"一个音素的原音 wav → 一帧一帧的 f0/sp/ap"这段做完：读 wav（有 `.frq`
    就直接用它，省掉一次 F0 提取）→ 按 oto 的 offset/cutoff 裁段 → 分析 →
    按 `tDst` 把特征重采样到目标时长。

    ★ C# 有两个公开构造函数，**相反的两条路**（别混）：
    - `SynthSegment(cfg, item)`（`forResampler: true`）：resampler 用。
      **不做输入增益**（因为增益在 `Resample` 的输出端做），cutoff 超过文件长度是**错误**。
    - `SynthSegment(cfg, item, posMs, skipMs, lengthMs, fadeInMs, fadeOutMs, hnsep)`
      （`forResampler: false`）：乐句合成（`PhraseSynthV2`）用。**做输入增益**，
      并且额外算 `skipFrames / p0 / p1 / p3 / p4` 这几个帧边界。

    `hnsep`（Worldline-R1.1 的谐波/噪声分离，`Core/Analysis/Hnsep`）尚未照搬，
    传入非 None 会抛 `NotImplementedError` —— `Resample` 这条路径恒为 None。
    """

    def __init__(self, config: AnalysisConfig, item, pos_ms: float = 0.0,
                 skip_ms: float = 0.0, length_ms: float = 0.0,
                 fade_in_ms: float = 0.0, fade_out_ms: float = 0.0,
                 for_resampler: bool = True, hnsep=None, native=None):
        self.config = config
        self.f0: List[float] = []
        self.sp_env: List[float] = []
        self.ap: List[float] = []
        self.sp_env_harmonic: Optional[List[float]] = None
        self.stretch: List[float] = []
        self.wav_max = 0.0
        #: oto offset 的**亚帧**部分；f0/sp/ap 的第 0 帧正好落在 offset 上
        self.offset_frac_ms = 0.0
        self.skip_frames = 0
        self.p0 = 0
        self.p1 = 0
        self.p3 = 0
        self.p4 = 0

        native = native if native is not None else get_native()
        fs = RESAMPLER_FS
        samples = Wave.get_samples(item.input_file)
        if len(samples) == 0:
            raise Exception('Empty samples in %s.' % item.input_file)

        # 延迟导入：`classic/__init__.py` 会 import 本模块（经 WorldlineResampler），
        # 顶层反向 import 会在"先导入 classic 再导入本模块"时成环。
        from .classic.frq import Frq

        frq = Frq()
        has_frq = frq.load(item.input_file)
        f0_src = native.f0(samples, fs, config.frame_ms, -1 if has_frq else 2)
        if has_frq:
            # 把 .frq 的帧（hopSize 一般是 256）搬到分析帧（hop_size = 441）上：
            # 每个分析帧取它覆盖到的那些 .frq 帧里**有声**帧的平均
            frq_f0 = frq.f0
            for i in range(len(f0_src)):
                ratio = config.hop_size / frq.hop_size
                index0 = min(len(frq_f0) - 1, int(math.floor(i * ratio)))
                index1 = min(len(frq_f0) - 1, int(math.ceil((i + 1) * ratio)))
                sum_f0 = 0.0
                count = 0
                for j in range(index0, index1 + 1):
                    if frq_f0[j] > config.f0_floor:
                        sum_f0 += frq_f0[j]
                        count += 1
                f0_src[i] = (sum_f0 / count) if count > 0 else 0.0

        src_start_frame = int(item.offset / config.frame_ms)     # C# 是 `(int)` 截断
        src_start_frame = max(0, src_start_frame)
        self.offset_frac_ms = max(0.0, item.offset - src_start_frame * config.frame_ms)
        wav_ms = len(samples) / fs * 1000.0
        src_end_ms = ((-item.cutoff + item.offset) if item.cutoff < 0
                      else (wav_ms - item.cutoff))
        if for_resampler and src_end_ms > wav_ms + 0.1:
            raise CutOffExceedDurationError()
        src_end_frame = int(math.ceil(src_end_ms / config.frame_ms))
        src_end_frame = min(len(f0_src), src_end_frame)
        if src_end_frame <= src_start_frame:
            raise CutOffBeforeOffsetError()

        self.wav_max = max((abs(s) for s in samples), default=0.0)

        # 前后各留 2 帧再分析，合成时多余的边缘帧会被丢掉（让合成"稳下来"）
        trim_start_frame = max(0, src_start_frame - 2)
        trim_end_frame = min(len(f0_src), src_end_frame + 2)
        src_start_frame -= trim_start_frame
        src_end_frame -= trim_start_frame
        f0_src = f0_src[trim_start_frame:trim_end_frame]
        trim_start_sample = trim_start_frame * config.hop_size
        trim_end_sample = min(len(samples), trim_end_frame * config.hop_size)
        untrimmed = samples
        samples = [0.0] * ((trim_end_frame - trim_start_frame) * config.hop_size)
        n_copy = trim_end_sample - trim_start_sample
        if n_copy < 0:
            raise ValueError('Array.Copy 长度为负：%d' % n_copy)
        samples[0:n_copy] = untrimmed[trim_start_sample:trim_start_sample + n_copy]

        if hnsep is not None:
            raise NotImplementedError(
                'hnsep（Worldline-R1.1 的谐波/噪声分离）尚未照搬；'
                'Resample 这条路径的 hnsep 恒为 None。')

        if not for_resampler:
            # 乐句合成那条路：增益在**输入端**做（resampler 那条在输出端做）
            gain = item.volume * 0.01 * segment_auto_gain(
                samples, f0_src, self.wav_max, config.f0_floor, get_flag(item, 'P', 86))
            for i in range(len(samples)):
                samples[i] = samples[i] * gain

        sp_size = config.fft_size // 2 + 1
        sp_env_src, ap_src = native.world_analysis_f0_in(config, samples, f0_src)

        t_dst, self.stretch = compute_timemap(
            src_start_frame, src_end_frame, self.offset_frac_ms, item.dur_required,
            item.velocity, item.consonant, config.frame_ms)
        f0_dst, sp_dst, ap_dst = resample_features(t_dst, f0_src, sp_env_src, ap_src, sp_size)
        self.f0 = f0_dst
        self.sp_env = sp_dst
        self.ap = ap_dst

        if not for_resampler:
            self.skip_frames, self.p0, self.p1, self.p3, self.p4 = compute_frame_bounds(
                config.frame_ms, pos_ms, skip_ms, length_ms, fade_in_ms, fade_out_ms)


def resample(item, native=None) -> List[float]:
    """对应 `Worldline.Resample(ResamplerItem)`：把一个音素渲染成**恰好 `durRequired` ms**。

    包络与重叠留给 wavtool —— 这里只负责"变调 + 拉伸 + 自动增益"。
    """
    native = native if native is not None else get_native()
    config = native.init_analysis_config(RESAMPLER_FS, RESAMPLER_HOP_SIZE, RESAMPLER_FFT_SIZE)
    segment = SynthSegment(config, item, native=native)
    sp_size = config.fft_size // 2 + 1
    frame_ms = config.frame_ms
    fs = config.fs

    # 两端各补 ResamplerPadding 帧（边缘帧复制），让合成在"要保留的音频"之前稳下来
    length = len(segment.f0)
    total = length + 2 * RESAMPLER_PADDING
    f0 = [0.0] * total
    sp = [0.0] * (total * sp_size)
    ap = [0.0] * (total * sp_size)
    for i in range(total):
        src = max(0, min(i - RESAMPLER_PADDING, length - 1))
        f0[i] = segment.f0[src]
        so = src * sp_size
        o = i * sp_size
        sp[o:o + sp_size] = segment.sp_env[so:so + sp_size]
        ap[o:o + sp_size] = segment.ap[so:so + sp_size]

    # 输出从"补边 + offset 的亚帧部分"之后开始（与原生 resampler 对齐）
    start_ms = RESAMPLER_PADDING * frame_ms + segment.offset_frac_ms

    # 音高弯曲线：从输出起点算起，每 5 tick 一个音分值
    step_ms = 60000.0 / item.tempo / 480.0 * 5
    apply_pitch_bend(f0, item.pitches, item.tone, start_ms, step_ms, frame_ms,
                     config.f0_floor)

    flag_g = get_flag(item, 'g', 0)
    flag_mt = get_flag(item, 'Mt', 0)
    flag_mb = get_flag(item, 'Mb', 0)
    flag_mv = get_flag(item, 'Mv', 100)
    samples = native.world_synthesis(
        f0, sp, False, sp_size, ap, False, config.fft_size, frame_ms, fs,
        [0.5 + flag_g / 200.0] * total,
        [0.5 + flag_mt / 200.0] * total,
        [0.5 + flag_mb * 0.005] * total,
        [flag_mv * 0.01] * total)

    start_sample = min(len(samples), int(start_ms * fs / 1000))
    length_samples = min(len(samples) - start_sample, int(item.dur_required * fs / 1000))
    output = list(samples[start_sample:start_sample + length_samples])

    # 自动增益：与源文件整体（不是本段）做加权，避免把辅音过度放大
    gain_factor = resample_auto_gain(output, segment.wav_max, f0, item.phone.direct,
                                     item.volume, get_flag(item, 'P', 86))
    if gain_factor != 1:
        for i in range(len(output)):
            output[i] = output[i] * gain_factor
    return output


# ---------------------------------------------------------------- PhraseSynthV2


def _cancelled(cancellation) -> bool:
    """C# 的 `cancellation.IsCancellationRequested`；`None` 表示不取消。"""
    return cancellation is not None and cancellation.is_set()


def _default_hnsep() -> Optional[Any]:
    """`Hnsep.Instance` 的替身（可注入）。

    C# 是 `Hnsep.Instance`（单例，首次访问时加载 ONNX 模型）。Python 侧由宿主注入；
    没注入就是 `None` → R1.1 那条路给出明确报错，而不是静默算错。
    """
    return _HNSEP_INSTANCE


#: 宿主注入的谐波/噪声分离模型（对应 `Hnsep.Instance`）
_HNSEP_INSTANCE: Optional[Any] = None


def set_hnsep(instance: Optional[Any]) -> None:
    """注入 hnsep 模型（宿主在启动时调；传 None 恢复为"没有"）。

    需要的接口（对应 `Core/Analysis/Hnsep`）：
        .sample_rate -> int
        .harmonic(samples: list[float]) -> list[float]
    """
    global _HNSEP_INSTANCE
    _HNSEP_INSTANCE = instance


class PhraseSynthV2:
    """对应 `Worldline.PhraseSynthV2`。

    一个乐句的"分析 + 合成"会话：先 `AddRequest` 排队，再 `AnalyzeRequests` 并行分析
    （每项变成一个 `SynthSegment`），然后 `SetCurves` 给曲线，最后
    `Synth()`（Worldline-R）或 `SynthContinuousNoise(seed)`（R1.1）出样本。

    ★ 三个方法的**调用顺序**是语义：`AnalyzeRequests` 可重复调用（队列空就返回），
    所以 `SynthFeatures` / `Synth` / `SynthContinuousNoise` 各自开头都会调一次。

    ★ `AnalyzeRequests` 的失败语义：**按提交顺序取第一个异常**原样重抛
    （C# 用 `Parallel.For` + `state.Break()`，注释说明 "Break still runs every lower
    index, so the earliest failure is found"）。失败的请求会挂到异常的 `.item` 上。
    """

    def __init__(self, fs: int, hop_size: int, fft_size: int, use_hnsep: bool = False,
                 native: Optional[WorldlineNative] = None,
                 num_render_threads: Optional[int] = None,
                 hnsep: Optional[Any] = None):
        self._native = native if native is not None else get_native()
        self.config = init_analysis_config(fs, hop_size, fft_size, self._native)
        #: 对应 `hnsep = useHnsep ? Hnsep.Instance : null;`
        self.hnsep = (hnsep if hnsep is not None else _default_hnsep()) if use_hnsep else None
        if num_render_threads is None:
            from .singer import Preferences
            num_render_threads = Preferences.num_render_threads
        self._num_render_threads = num_render_threads

        self._segments: List[SynthSegment] = []
        self._pending: List[Tuple[Any, Any]] = []
        self._f0_curve: Optional[Sequence[float]] = None
        self._gender_curve: Optional[Sequence[float]] = None
        self._tension_curve: Optional[Sequence[float]] = None
        self._breathiness_curve: Optional[Sequence[float]] = None
        self._voicing_curve: Optional[Sequence[float]] = None

    # ------------------------------------------------------------------ 排队 / 分析

    def add_request(self, item, pos_ms: float, skip_ms: float, length_ms: float,
                    fade_in_ms: float, fade_out_ms: float) -> None:
        """对应 `AddRequest`：**只排队**，分析留给 `AnalyzeRequests`。"""
        cfg = self.config
        hnsep = self.hnsep
        native = self._native
        self._pending.append((item, lambda: SynthSegment(
            cfg, item, pos_ms, skip_ms, length_ms, fade_in_ms, fade_out_ms,
            for_resampler=False, hnsep=hnsep, native=native)))

    def analyze_requests(self, cancellation=None) -> None:
        """对应 `AnalyzeRequests`：并行分析，按**提交顺序**取第一个异常重抛。

        `cancellation` 是 `threading.Event`（`is_set()`）；已取消时抛 `SynthCancelled`
        —— 对应 C# 把 `CancellationToken` 交给 `Parallel.For` 后抛出的
        `OperationCanceledException`。渲染器接住它就返回已有结果。
        """
        if len(self._pending) == 0:
            return
        if _cancelled(cancellation):
            raise SynthCancelled()
        n = len(self._pending)
        results: List[Optional[SynthSegment]] = [None] * n
        errors: List[Optional[BaseException]] = [None] * n

        def run(i: int) -> None:
            try:
                results[i] = self._pending[i][1]()
            except BaseException as e:          # noqa: BLE001 —— 逐个收集，最后按序取首个
                if isinstance(e, SynthRequestError):
                    e.item = self._pending[i][0]
                errors[i] = e

        with ThreadPoolExecutor(max_workers=max(1, self._num_render_threads)) as pool:
            futures = [pool.submit(run, i) for i in range(n)]
            for f in futures:                   # 全部等完，不提前取消
                f.result()

        error = next((e for e in errors if e is not None), None)
        if error is not None:
            raise error
        self._segments.extend(results)          # type: ignore[arg-type]
        self._pending.clear()

    def set_curves(self, f0, gender, tension, breathiness, voicing) -> None:
        """对应 `SetCurves`。"""
        self._f0_curve = f0
        self._gender_curve = gender
        self._tension_curve = tension
        self._breathiness_curve = breathiness
        self._voicing_curve = voicing

    # ------------------------------------------------------------------ 合成

    def synth_features(self):
        """对应 `SynthFeatures`。返回 `(total_frames, f0, sp, ap)`（sp/ap 是**扁平**数组）。"""
        self.analyze_requests()
        sp_size = self.config.fft_size // 2 + 1
        return blend_features(self._segments, sp_size, f0_curve=self._f0_curve,
                              f0_floor=self.config.f0_floor)

    def synth(self) -> List[float]:
        """对应 `Synth`（Worldline-R / version 10）。

        C# 返回 `float[]`（`samples.Select(s => (float)s)`），所以这里逐个过 `as_float32`。
        """
        self.analyze_requests()
        if len(self._segments) == 0:
            return []
        total_frames, f0, sp, ap = self.synth_features()
        sp_size = self.config.fft_size // 2 + 1
        samples = self._native.world_synthesis(
            f0, sp, False, sp_size, ap, False, self.config.fft_size,
            self.config.frame_ms, self.config.fs,
            fit_curve(self._gender_curve, total_frames, 0.5),
            fit_curve(self._tension_curve, total_frames, 0.5),
            fit_curve(self._breathiness_curve, total_frames, 0.5),
            fit_curve(self._voicing_curve, total_frames, 1.0))
        return [as_float32(s) for s in samples]

    def synth_continuous_noise(self, seed: int) -> List[float]:
        """对应 `SynthContinuousNoise`（Worldline-R1.1 / version 11）。

        ★ 第一行的守卫照搬 C#：`if (hnsep == null) throw new InvalidOperationException(
        "SynthContinuousNoise needs the hnsep analysis.");`

        目前**还走不通**，两处依赖未搬（都给的是明确报错，不是静默出错）：
        - `SynthSegment` 的谐波分离分支（需要 `HnAnalysisF0In` 原生绑定 + 把
          `sp_env_harmonic` 一路带到 `resample_features`）；
        - 就算上面通了，还要宿主注入 hnsep 模型（见 `set_hnsep`）。
        """
        if self.hnsep is None:
            raise RuntimeError('SynthContinuousNoise needs the hnsep analysis.')
        self.analyze_requests()
        if len(self._segments) == 0:
            return []
        sp_size = self.config.fft_size // 2 + 1
        total_frames, f0, sp, sp_harmonic, ap, stretch = blend_continuous_noise_features(
            self._segments, sp_size, f0_curve=self._f0_curve, f0_floor=self.config.f0_floor)
        samples = self._native.world_synthesis_continuous_noise(
            f0, sp, sp_harmonic, ap, stretch,
            self.config.fft_size, self.config.hop_size, self.config.fs, seed,
            fit_curve(self._gender_curve, total_frames, 0.5),
            fit_curve(self._tension_curve, total_frames, 0.5),
            fit_curve(self._breathiness_curve, total_frames, 0.5),
            fit_curve(self._voicing_curve, total_frames, 1.0))
        return [as_float32(s) for s in samples]

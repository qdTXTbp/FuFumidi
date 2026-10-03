# -*- coding: utf-8 -*-
r"""DiffSinger 纯函数工具 —— **照搬** `OpenUtau.Core/DiffSinger/DiffSingerUtils.cs`。

本模块只放**无状态纯函数**，因为它们是整条链路里最容易"凭印象重写"而写错的部分
（帧换算的银行家舍入、曲线采样的端点行为、padding 三段重采样）。

每个函数都标注了上游对应行号；**不要在本文件里"优化"任何一处语义**。

## ★ 三处最容易写错、且错了会静默产生错误音频的地方

1. `durations_ms_to_frames` 的 **增量法 + `+0.5` + 银行家舍入**（`:50-64`）。
   逐段独立取整会累积误差；改成 `round()`（Python 的 half-even 但没有 `+0.5` 偏移）
   或 `int()`（截断）都会在长句上偏若干帧。
2. `sample_curve` 的**端点行为**与 **`convert` 的调用时机**（`:199-224`）：
   曲线为空时填 `defaultValue` 且**不经过 `convert`**；有曲线时 `convert` 在**插值之后**。
   另外 `index <= 0` 取 `curve[0]` —— 这导致 **head/tail padding 帧的 f0 等于首/尾音高**，
   而不是 0。
3. `resample_padded_curve` 的 **head/body/tail 三段分别重采样**（`:264-309`），
   不能整体线性插值 —— 否则 padding 区会被 body 的内容污染。
"""

import math
from typing import Callable, List, Optional, Sequence, Tuple

#: 对应 `DiffSingerUtils.cs:15-16` —— 硬编码常量，**不可配置**
HEAD_FRAMES = 8
TAIL_FRAMES = 8

#: 对应 `:13`（`ENE`）与 `OpenUtau.Core/Format/Ustx.cs` 里的 `BREC`/`VOIC`/`TENC`
ENE = 'ene'
BREC = 'brec'
VOIC = 'voic'
TENC = 'tenc'


# ---------------------------------------------------------------- 帧换算

def round_half_even(x: float) -> int:
    """对应 C# `Math.Round(v, MidpointRounding.ToEven)`。

    ★ 上游的写法是 `Math.Round(accumulatedMs / frameMs + 0.5, ToEven)` ——
      **`+0.5` 是"四舍五入前先加半"的技巧**，随后才做银行家舍入。
      所以调用方必须写 `round_half_even(v / frame_ms + 0.5)`，本函数**只**做 ToEven。

    Python 内置 `round()` 对 float 也是 half-even，但返回 float 且在
    `x` 恰为 `n+0.5` 时才体现差异；这里显式实现以便写边界单测
    （0.5→0、1.5→2、2.5→2、3.5→4），不依赖语言细节。
    """
    f = math.floor(x)
    diff = x - f
    if diff > 0.5:
        return int(f) + 1
    if diff < 0.5:
        return int(f)
    return int(f) if int(f) % 2 == 0 else int(f) + 1


def durations_ms_to_frames(durations_ms: Sequence[float], frame_ms: float) -> List[int]:
    """对应 `DurationsMsToFrames`（`:50-64`）—— ms 时长序列 → 每段**帧数**。

    ★ **增量法**：`accumulatedMs` 逐段累加，每段取"绝对帧边界"再与上一个相减。
      若改成逐段独立 `round(d/frameMs)`，误差会累积（长句可达数帧）。

    行为表（`round_half_even(v/frameMs + 0.5)`）：`8.0→8`、`8.4→9`、`8.6→9`、`9.0→10`、`10.0→10`
    """
    result: List[int] = []
    accumulated_ms = 0.0
    previous_frame = 0
    for duration_ms in durations_ms:
        if duration_ms < 0:
            # 对应 :55-57 的 InvalidDataException
            raise ValueError('Negative DiffSinger duration: %s ms' % duration_ms)
        accumulated_ms += duration_ms
        frame = round_half_even(accumulated_ms / frame_ms + 0.5)
        result.append(frame - previous_frame)
        previous_frame = frame
    return result


# ---------------------------------------------------------------- padding 段

def padded_segments(phones: Sequence, frame_ms: float,
                    head_frames: int = HEAD_FRAMES,
                    tail_frames: int = TAIL_FRAMES) -> List[Tuple[str, float, int]]:
    """对应 `PaddedSegments`（`:66-85`）。

    返回 `[(音素名, 时长ms, 在 phones 里的下标)]`；**下标 -1 表示非音素**
    （头 SP / 音素间隙 SP / 尾 SP）。

    ★ 音素间隙（`gapMs > 0`）才插 SP —— 相邻音素之间无空隙时不插。
    ★ `phones` 的每个元素需有 `.phoneme` / `.duration_ms` / `.position_ms` / `.end_ms`。
    """
    out: List[Tuple[str, float, int]] = [('SP', head_frames * frame_ms, -1)]
    for i, ph in enumerate(phones):
        if i > 0:
            gap_ms = ph.position_ms - phones[i - 1].end_ms
            if gap_ms > 0:
                out.append(('SP', gap_ms, -1))
        out.append((ph.phoneme, ph.duration_ms, i))
    out.append(('SP', tail_frames * frame_ms, -1))
    return out


def padded_phone_durations(phones: Sequence, frame_ms: float,
                           head_frames: int = HEAD_FRAMES,
                           tail_frames: int = TAIL_FRAMES) -> List[int]:
    """对应 `PaddedPhoneDurations`（`:87-91`）。"""
    return durations_ms_to_frames(
        [d for _, d, _ in padded_segments(phones, frame_ms, head_frames, tail_frames)],
        frame_ms)


def padded_voiced_mask(segments: Sequence[Tuple[str, float, int]],
                       durations: Sequence[int]) -> List[bool]:
    """对应 `PaddedVoicedMask`（`:99-115`）。

    逐帧"是否浊音"：只有 `PhoneIndex >= 0` 的段算浊音 —— head SP、音素间隙 SP、
    tail SP 的帧全是 False。`pitch_edit` 写回 PITD 时靠它跳过这些帧
    （`NoteBatchEdits.cs:544-546`）。
    """
    total = int(sum(durations))
    mask = [False] * total
    frame = 0
    for i in range(min(len(segments), len(durations))):
        voiced = segments[i][2] >= 0
        for _ in range(durations[i]):
            if frame >= total:
                break
            mask[frame] = voiced
            frame += 1
    return mask


# ---------------------------------------------------------------- 曲线采样

def sample_curve(phrase, curve: Optional[Sequence[float]], default_value: float,
                 frame_ms: float, length: int, head_frames: int, tail_frames: int,
                 convert: Optional[Callable[[float], float]] = None) -> List[float]:
    """对应 `SampleCurve`（`:199-224`）。

    ★ 三个必须保留的行为：
      1. `curve` 为空 → 整条填 `defaultValue`，**不经过 `convert`**（`:202-205`）。
      2. `index <= 0` → `curve[0]`；`index >= len-1` → `curve[-1]`；否则线性插值
         （`:212-220`）。★ 这意味着 **head/tail padding 帧取的是首/尾音高，不是 0**。
      3. `convert` 在**插值之后**应用（`:213/215/220`）。
    ★ `tail_frames` 是上游的**死参数**（签名收了但函数体从未引用）；保留是为了
      与上游调用点逐字一致，docstring 标注以免后人"补上"。

    `phrase` 需提供 `.position_ms` / `.axis.ms_pos_to_tick_pos` / `.position` / `.leading`。
    """
    n = length
    out = [0.0] * n
    if not curve:
        return [float(default_value)] * n
    interval = 5                                    # :200 pitchInterval
    start_ms = phrase.position_ms - head_frames * frame_ms        # :207 ★ 左移 8 帧
    last = len(curve) - 1
    for i in range(n):
        pos_ms = start_ms + i * frame_ms                          # :209
        ticks = phrase.axis.ms_pos_to_tick_pos(pos_ms) - (phrase.position - phrase.leading)
        index = ticks / interval
        if index <= 0:
            value = curve[0]
        elif index >= last:
            value = curve[last]
        else:
            i0 = int(math.floor(index))
            i1 = i0 + 1
            value = curve[i0] + (curve[i1] - curve[i0]) * (index - i0)
        out[i] = float(value) if convert is None else float(convert(value))  # :220
    return out


# ---------------------------------------------------------------- 重采样

def linear_f(x0: float, x1: float, y0: float, y1: float, x: float,
             epsilon: float = 0.001) -> float:
    """对应 `LinearF`（`:228-234`）—— ★ `x1 - x0 < epsilon` 时**直接返回 y1**（不外推）。"""
    if x1 - x0 < epsilon:
        return y1
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


def resample_curve(curve: Sequence[float], length: int,
                   source_frame_ms: float, target_frame_ms: float) -> List[float]:
    """对应 `ResampleCurve`（`:311-336`）—— 按**时间**线性插值，端点 clamp。"""
    if length <= 0:
        return []
    n = len(curve)
    if n == 0:
        return [0.0] * length
    if n == 1:
        return [float(curve[0])] * length
    out: List[float] = []
    last = n - 1
    for i in range(length):
        x = i * target_frame_ms / source_frame_ms
        if x <= 0:
            out.append(float(curve[0]))
        elif x >= last:
            out.append(float(curve[last]))
        else:
            x0 = int(math.floor(x))
            out.append(linear_f(x0, x0 + 1, float(curve[x0]), float(curve[x0 + 1]), x))
    return out


def resample_padded_curve(curve: Optional[Sequence[float]], length: int,
                         source_head_frames: int, source_tail_frames: int,
                         target_head_frames: int, target_tail_frames: int,
                         source_frame_ms: float, target_frame_ms: float
                         ) -> Optional[List[float]]:
    """对应 `ResamplePaddedCurve`（`:264-309`）。

    ★ **head / body / tail 三段分别重采样**（`:289-301`）—— 整体线性插值会让
      padding 区被 body 内容污染。用于 variance 与 acoustic 的 `frameMs` 不同时。
    """
    if not curve or len(curve) == 0:
        return None
    if (length == len(curve)
            and source_head_frames == target_head_frames
            and source_tail_frames == target_tail_frames
            and abs(source_frame_ms - target_frame_ms) < 0.001):
        return list(curve)                                   # :279-284 快路径
    source_body = len(curve) - source_head_frames - source_tail_frames
    target_body = length - target_head_frames - target_tail_frames
    if source_body < 0 or target_body < 0:                   # :286-288
        return resample_curve(curve, length, source_frame_ms, target_frame_ms)

    result = [0.0] * length
    _copy_resampled_segment(curve, 0, source_head_frames,
                            result, 0, target_head_frames,
                            source_frame_ms, target_frame_ms)
    _copy_resampled_segment(curve, source_head_frames, source_body,
                            result, target_head_frames, target_body,
                            source_frame_ms, target_frame_ms)
    _copy_resampled_segment(curve, len(curve) - source_tail_frames, source_tail_frames,
                            result, length - target_tail_frames, target_tail_frames,
                            source_frame_ms, target_frame_ms)
    return result


def _copy_resampled_segment(src: Sequence[float], src_start: int, src_len: int,
                            dst: List[float], dst_start: int, dst_len: int,
                            src_ms: float, dst_ms: float) -> None:
    """对应 `CopyResampledSegment`（`:311-336`）。"""
    if src_len <= 0 or dst_len <= 0:
        return
    for j in range(dst_len):
        si = src_start + int(round(j * src_len / dst_len))
        si = max(src_start, min(si, src_start + src_len - 1))
        x = j * src_len / dst_len
        dst[dst_start + j] = linear_f(si, si + 1, float(src[si]),
                                      float(src[min(si + 1, src_start + src_len - 1)]), x)


# ---------------------------------------------------------------- word mode

def padded_word_div_and_dur(phrase, durations: Sequence[int], is_vowel,
                            frame_ms: float, head_frames: int, tail_frames: int
                            ) -> Tuple[List[int], List[int]]:
    """对应 `PaddedWordDivAndDur`（`:124-174`）—— variance 的 **word 编码模式**。

    ★ 与音素化器里的 `word_div`/`word_dur` 是**不同的函数**：
      这里按**元音**（`is_vowel`）切"字"，而不是按音符分组。
    ★ 只在 `dsvariance/dsconfig.yaml` 的 `predict_dur: true` 时用到；
      本声库是 `false`（走 `ph_dur` 分支），但换声库会用到 —— 两条都要实现。
    """
    segments = padded_segments(phrase.phones, frame_ms, head_frames, tail_frames)
    result_dur: List[int] = []
    result_div: List[int] = []
    f0 = durations[0] if durations else 0
    x = f0
    l = 0
    while l < len(segments):
        r = l
        v = False
        while r < len(segments):
            if r > l:
                _, _, index = segments[r]
                if index >= 0 and is_vowel(segments[r][0]):
                    break
            r += 1
        if r + 1 < len(durations) and l < len(durations) and r < len(durations):
            result_dur.append(durations[r])
            del durations[r]
        else:
            result_dur.append(0)
        r -= l
        if r <= 0:
            break
        result_div.append(r)
        x += r
        l += r
    del f0
    return result_div, result_dur


# ---------------------------------------------------------------- 方差 delta

def variance_delta(kind: str, predicted: float, user: float) -> float:
    """对应 `VarianceDeltaFunctions`（`DiffSingerUtils.cs:18-24`）。

    | 通道 | 公式 | 用户曲线 0 的含义 |
    |---|---|---|
    | `ene`/`brec` | `x + y*12/100` | 无改动 |
    | `voic` | `x + (y-100)*12/100` | **−12**（0 不是中性，中性是 100）|
    | `tenc` | `x + y/20` | 无改动 |
    """
    if kind in (ENE, BREC):
        return predicted + user * 12.0 / 100.0
    if kind == VOIC:
        return predicted + (user - 100.0) * 12.0 / 100.0
    if kind == TENC:
        return predicted + user / 20.0
    raise ValueError('未知的方差通道：%r' % kind)


#: 对应 `DiffSingerRenderer.cs:398/417/436/455` 的 `Math.Clamp` 区间
VARIANCE_CLAMP = {
    ENE: (-96.0, 0.0),
    BREC: (-96.0, 0.0),
    VOIC: (-96.0, 0.0),
    TENC: (-10.0, 10.0),
}


def clamp_variance(kind: str, value: float) -> float:
    """对应上游对四条方差曲线的 `Math.Clamp`。"""
    lo, hi = VARIANCE_CLAMP[kind]
    return lo if value < lo else (hi if value > hi else value)


# ---------------------------------------------------------------- 音高换算

def tone_to_freq(tone: float) -> float:
    """音高（MIDI 半音）→ 频率（Hz）。

    复用 `singing.openutau.music_math.MusicMath.tone_to_freq`（已照搬
    `OpenUtau.Core/MusicMath.cs`），不重复实现。
    """
    from singing.openutau.music_math import MusicMath
    return MusicMath.tone_to_freq(tone)


def phoneme_language(phoneme: str) -> str:
    """对应 `PhonemeLanguage`（`DiffSingerUtils.cs:391-396`）—— 取 `/` 前缀，无则空串。"""
    return phoneme.split('/')[0] if '/' in phoneme else ''


# ---------------------------------------------------------------- 杂项

def fit_duration_sum(durations: Sequence[int], total_frames: int) -> List[int]:
    """对应 `FitDurationSum`（`:176-197`）—— 把时长总和塞进 `total_frames`。

    不足/超出都从**最后一个**开始调；末项变负时向前借。
    """
    if not durations:
        return []
    result = [int(x) for x in durations]
    delta = total_frames - sum(result)
    result[-1] += delta
    if result[-1] < 0:
        deficit = -result[-1]
        result[-1] = 0
        for i in range(len(result) - 2, -1, -1):
            if deficit <= 0:
                break
            take = min(result[i], deficit)
            result[i] -= take
            deficit -= take
        if deficit > 0:
            raise ValueError('无法把时长塞进 %d 帧（还差 %d）' % (total_frames, deficit))
    return result

# -*- coding: utf-8 -*-
r"""B 层：渲染器 —— **照搬** `OpenUtau.Core/DiffSinger/DiffSingerRenderer.InvokeDiffsinger`
（:156-528）与其 `Render`（:75-150）。

★ **只有一条 acoustic 路径。** 上游 `Core/DiffSinger/` 里搜不到任何 sr3/v2 五段式编排；
  `dspitch/` 更是**完全不参与**（只服务编辑器的 `LoadRenderedPitch`）。
  `f0` **只**来自用户谱面曲线 `phrase.pitches`（音分 → Hz）。

## ★ 本文件相对旧实现的三处结构性修正

| | 旧实现（自造五段式） | 上游（这里） |
|---|---|---|
| `durations` | 渲染阶段调 `sr3_dur`，被压短 2.6 倍 | 由 A 层的 `UPhoneme.duration_ms` **直接换算** |
| `f0` | `sr3_pit` 输出**覆盖**基线 | **只有**谱面曲线；渲染器不碰音高模型 |
| padding | 无 | `PaddedSegments` 首尾各 8 帧 SP |
| 响度 | 推到 −1 dBFS | **不归一化**（上游写的是 vocoder 原始输出） |
"""

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from . import RenderError
from .config import compute_speedup, resolve_depth
from .utils import (
    HEAD_FRAMES, TAIL_FRAMES, durations_ms_to_frames, padded_phone_durations,
    padded_segments, sample_curve, tone_to_freq,
)

#: 上游默认采样步数（`Preferences.cs:190-194`）
DEFAULT_STEPS = 20
#: 上游默认深度（`Preferences.cs:190`）
DEFAULT_DEPTH = 1.0
#: 对应 `DiffSingerRenderer.cs:491-494` 的 mel base 换算系数
MEL_BASE_K = {('e', '10'): 2.30259, ('10', 'e'): 0.434294}


@dataclass
class Phrase:
    """渲染器的输入视图（对应 `RenderPhrase` 的相关字段）。

    ★ `pitches` / `tone_shift` 等曲线单位是**音分**（`note.AdjustedTone * 100`），
      采样时各自再按目标模型换算（acoustic 用 Hz、variance 用 tone）。
    """

    axis: object
    part_position: int
    position: int
    leading: int
    position_ms: float
    duration_ms: float
    pitches: List[float] = field(default_factory=list)
    tone_shift: List[float] = field(default_factory=list)
    gender: List[float] = field(default_factory=list)
    breathiness: List[float] = field(default_factory=list)
    voicing: List[float] = field(default_factory=list)
    tension: List[float] = field(default_factory=list)
    energy: List[float] = field(default_factory=list)
    velocity_curve: Optional[List[float]] = None
    phones: List = field(default_factory=list)
    #: 声学模型要哪几条方差（由根 dsconfig 的 use*Embed 决定）
    need_energy: bool = False
    need_breathiness: bool = False
    need_voicing: bool = False
    need_tension: bool = False


def build_pitches(notes: Sequence, axis, part_position: int, phrase_position: int,
                  leading: int, pitch_points=None, pitd_curve=None) -> List[float]:
    """构造 `phrase.pitches`（**音分**）—— 照搬 `RenderPhrase.cs:273-289 / 294-308 / 448-455`。

    * `interval = 5` tick（`pitchInterval`）
    * 平铺：每个音符覆盖 `[note.Position, note.End)`，`pitches[i] = AdjustedTone * 100`
    * 尾部延拓：写完后用最后一个值填满剩余
    * 颤音：`note.Vibrato.Length > 0` 时按 `nPos / nPeriod` 采样，**覆盖**平铺值（:294-308）
    * 音高点：`point.Y * 10 + AdjustedTone * 100` 形状插值后**加上**（:310-370）
    * PITD：最后**加上** `pitd_curve.Sample(...)`（:449-455）
    ★ 顺序不能变：后面的覆盖前面的。
    """
    interval = 5
    if not notes:
        return []
    first = notes[0]
    last = notes[-1]
    end_tick = last.position + last.duration
    pitch_start = phrase_position - part_position - leading
    length = max(1, (end_tick - part_position - pitch_start) // interval + 1)
    pitches = [0.0] * length

    # ---- ① 平铺
    index = 0
    for note in notes:
        tone100 = float(getattr(note, 'adjusted_tone', None) or note.tone) * 100.0
        note_end = note.position + note.duration
        while pitch_start + index * interval < note_end and index < length:
            pitches[index] = tone100
            index += 1
    index = max(1, index)
    while index < length:
        pitches[index] = pitches[index - 1]
        index += 1

    # ---- ② 颤音（覆盖）
    for i, note in enumerate(notes):
        vib = getattr(note, 'vibrato', None)
        if vib is None or not getattr(vib, 'length', 0):
            continue
        note_ms = axis.ms_between_tick_pos(note.position, note.position + note.duration)
        if note_ms <= 0:
            continue
        n_period = max(1e-6, float(vib.period) / note_ms)
        tone100 = float(getattr(note, 'adjusted_tone', None) or note.tone) * 100.0
        for j in range(length):
            pos = pitch_start + j * interval
            if not (note.position <= pos < note.position + note.duration):
                continue
            n_pos = (pos - note.position) / max(1, note.duration)
            n_pos = axis.ms_between_tick_pos(note.position, pos) / note_ms
            n_pos = n_pos / n_period
            pitches[j] = _vibrato_value(vib, n_pos, n_period) * 100.0 + tone100

    # ---- ③ 音高点（加上）
    if pitch_points:
        pitches = _apply_pitch_points(pitches, pitch_points, pitch_start, interval,
                                      axis, notes)
    # ---- ④ PITD（加上）
    if pitd_curve is not None:
        before = list(pitches)
        for i in range(length):
            pitches[i] = before[i] + _sample_ustx_curve(
                pitd_curve, pitch_start + i * interval)
    return pitches


def _vibrato_value(vib, n_pos: float, n_period: float) -> float:
    """颤音取值（照搬 `UNote.VibratoSample`：正弦 + in/out 渐变 + shift/drift）。"""
    if n_period <= 0:
        return 0.0
    value = vib.depth / 100.0 * _sine(n_pos)
    length = float(getattr(vib, 'length', 0) or 0)
    if length > 0:
        if n_pos < float(getattr(vib, 'in_', 0) or 0):
            value *= max(0.0, n_pos / max(1e-6, float(vib.in_)))
        if n_pos > length - float(getattr(vib, 'out', 0) or 0):
            value *= max(0.0, (length - n_pos) / max(1e-6, float(getattr(vib, 'out', 0) or 0)))
    value *= (1.0 + (float(getattr(vib, 'shift', 0) or 0) / 200.0) * n_pos)
    value += float(getattr(vib, 'drift', 0) or 0) / 200.0 * n_pos
    return value * 100.0


def _sine(x: float) -> float:
    import math
    return math.sin(2 * math.pi * x)


def _apply_pitch_points(pitches, points, pitch_start, interval, axis, notes):
    """音高点插值（照搬 `RenderPhrase.cs:310-370` 的形状 + 基线相加）。"""
    out = list(pitches)
    for point in points:
        pos = getattr(point, 'position', None)
        if pos is None:
            continue
        value = float(getattr(point, 'value', 0.0)) * 10.0
        shape = getattr(point, 'shape', 'io') or 'io'
        # 在该点前后各找最近的一个同形点做插值
        shape_points = [p for p in points
                        if (getattr(p, 'shape', 'io') or 'io') == shape]
        shape_points.sort(key=lambda p: p.position)
        try:
            i = shape_points.index(point)
        except ValueError:
            continue
        lo = shape_points[i - 1] if i > 0 else None
        hi = shape_points[i + 1] if i + 1 < len(shape_points) else None
        start = out[max(0, min(len(out) - 1, (pos - pitch_start) // interval))]
        def curve_value(x):
            v = value + start
            if lo is not None and x < pos:
                v = _interp_shape(lo.position, pos, float(lo.value) * 10.0 + start,
                                  value + start, x, shape)
            elif hi is not None and x > pos:
                v = _interp_shape(pos, hi.position, value + start,
                                  float(hi.value) * 10.0 + start, x, shape)
            return v
        for j in range(len(out)):
            x = pitch_start + j * interval
            if abs(x - pos) <= interval:
                out[j] = curve_value(x)
    return out


def _interp_shape(x0, x1, y0, y1, x, shape):
    t = 0.0 if x1 == x0 else (x - x0) / (x1 - x0)
    t = max(0.0, min(1.0, t))
    if shape == 'i':
        return y1
    if shape == 'o':
        return y0
    if shape == 'io':
        return y0 + (y1 - y0) * t
    if shape == 'oi':
        return y0 + (y1 - y0) * (1 - (1 - t) ** 2)
    return y0 + (y1 - y0) * t


def _sample_ustx_curve(curve, tick: int) -> float:
    """采样 .ustx 曲线（照搬 `UstxCurve.Sample`）。"""
    data = getattr(curve, 'data', None) or []
    if not data:
        return float(getattr(curve, 'default_value', 0) or 0)
    if tick <= data[0][0]:
        return float(data[0][1])
    if tick >= data[-1][0]:
        return float(data[-1][1])
    for i in range(len(data) - 1):
        x0, y0 = data[i][0], data[i][1]
        x1, y1 = data[i + 1][0], data[i + 1][1]
        if x0 <= tick <= x1:
            if x1 == x0:
                return float(y1)
            t = (tick - x0) / (x1 - x0)
            t = max(0.0, min(1.0, t))
            shape = data[i][2] if len(data[i]) > 2 else 'io'
            return float(_interp_shape(x0, x1, y0, y1, tick, shape or 'io'))
    return float(getattr(curve, 'default_value', 0) or 0)


# ---------------------------------------------------------------- acoustic 输入

def build_acoustic_inputs(singer, phrase: Phrase, segments, durations: Sequence[int],
                          depth: float, steps: int) -> Tuple[Dict[str, object], Dict]:
    """组装 acoustic 的输入（照搬 `DiffSingerRenderer.cs:266-460`）→ `(feeds, f0 张量)`。

    ★ 输入集合**完全由根 dsconfig 的 `use*Embed` 决定**，多一个少一个都会抛
      （`Onnx.VerifyInputNames` 双向严格）。
    ★ `f0` / `shiftedF0` 都要算：`pitch_controllable` 决定给 acoustic 喂哪个，
      而 **vocoder 永远喂未 shift 的**（:501）。
    """
    import numpy as np

    cfg = singer.acoustic
    frame_ms = singer.vocoder.frame_ms
    total_frames = int(sum(durations))

    tokens = [singer.phoneme_tokens.get(sym, 0) for sym, _, _ in segments]
    feeds: Dict[str, object] = {
        'tokens': np.asarray([tokens], dtype=np.int64),
        'durations': np.asarray([list(durations)], dtype=np.int64),
    }

    f0 = sample_curve(phrase, phrase.pitches, 0, frame_ms, total_frames,
                      HEAD_FRAMES, TAIL_FRAMES, lambda x: tone_to_freq(x * 0.01))
    tone_shift = sample_curve(phrase, phrase.tone_shift, 0, frame_ms, total_frames,
                              HEAD_FRAMES, TAIL_FRAMES, lambda x: x)
    shifted = [f * (2.0 ** (d / 1200.0)) for f, d in zip(f0, tone_shift)]

    # ★ :275-281 pitch_controllable（在 vocoder.yaml）只决定 acoustic 喂哪个
    pick = shifted if singer.vocoder.pitch_controllable else f0
    feeds['f0'] = np.asarray([pick], dtype=np.float32)
    f0_tensor = np.asarray([f0], dtype=np.float32)

    # ---- 采样加速：depth / steps / speedup（真值表 :283-308）
    if cfg.use_continuous_acceleration:
        if cfg.use_shallow_diffusion_effective:
            feeds['depth'] = np.asarray([float(depth)], dtype=np.float32)
        feeds['steps'] = np.asarray([int(steps)], dtype=np.int64)
    else:
        speedup = (max(1, int(round(depth * 1000)) // max(1, int(steps)))
                   if cfg.use_shallow_diffusion_effective
                   else compute_speedup(steps))
        if cfg.use_shallow_diffusion_effective:
            int64_depth = int(round(depth * 1000))
            int64_depth = int64_depth // max(1, speedup) * max(1, speedup)
            feeds['depth'] = np.asarray([int64_depth], dtype=np.int64)
        feeds['speedup'] = np.asarray([int(speedup)], dtype=np.int64)

    if cfg.use_lang_id:
        raise RenderError('use_lang_id=true 的声学模型还需要 languages 输入，当前未实现')

    # ---- gender（GENC，:327-338）：无曲线时整条 0
    if cfg.use_key_shift_embed:
        rng = ((cfg.raw.get('augmentation_args') or {}).get('random_pitch_shifting')
               or {}).get('range') or [0, 0]
        pos_scale = 0.0 if not rng[1] else (12.0 / float(rng[1]) / 100.0)
        neg_scale = 0.0 if not rng[0] else (-12.0 / float(rng[0]) / 100.0)
        feeds['gender'] = np.asarray([sample_curve(
            phrase, phrase.gender, 0, frame_ms, total_frames, HEAD_FRAMES, TAIL_FRAMES,
            lambda x: (-x * pos_scale) if x < 0 else (-x * neg_scale))],
            dtype=np.float32)

    # ---- velocity（VELC，:343-357）★ 无曲线时 Repeat(1f)，**绕过 SampleCurve**
    if cfg.use_speed_embed:
        if phrase.velocity_curve is not None:
            vel = sample_curve(phrase, phrase.velocity_curve, 1, frame_ms, total_frames,
                               HEAD_FRAMES, TAIL_FRAMES,
                               lambda x: 2.0 ** ((x - 100) / 100.0))
        else:
            vel = [1.0] * total_frames
        feeds['velocity'] = np.asarray([vel], dtype=np.float32)

    return feeds, {'f0': f0_tensor, 'f0_hz': f0, 'total_frames': total_frames,
                   'frame_ms': frame_ms}


def add_variance_inputs(feeds: Dict[str, object], values: Dict[str, Sequence[float]]) -> None:
    """把方差曲线塞进 acoustic 输入（调用方保证只塞 `use*Embed` 声明了的那些）。"""
    import numpy as np
    for key, seq in values.items():
        feeds[key] = np.asarray([list(seq)], dtype=np.float32)


# ---------------------------------------------------------------- vocoder

def run_vocoder(singer, mel, f0_tensor, providers, cache_dir=None):
    """跑声码器（照搬 `:497-528`）。

    ★ 输入**恰好两个**：`mel`（上游 acoustic 的原始 rank-3 输出，**不 transpose**）
      与 `f0`（**未 shift 的**）。输出必须 rank 2 且 `[1, -1]`。
    ★ **无 pad、无 trim** —— head/tail 的静音帧已经烧在 mel 里。
    """
    import numpy as np

    from .session import run_session
    m = np.asarray(mel, dtype=np.float32)
    if m.ndim == 2:                       # 少数模型是 [T, bins]，补上 batch 维
        m = m[None, :, :]
    feeds = {'mel': m, 'f0': np.asarray(f0_tensor, dtype=np.float32)}
    # ★ identifier = vocoder.hash（`DiffSingerCache` 的构造参数，:463/:503 同理）
    outs = run_session(singer.model('vocoder'), feeds, providers, 'vocoder',
                       identifier=(singer.hashes or {}).get('vocoder'),
                       cache_dir=cache_dir)
    samples = np.asarray(outs[0], dtype=np.float32)
    if samples.ndim != 2 or samples.shape[0] != 1:
        raise RenderError('声码器输出应为 (1, length)，实际 %s' % (samples.shape,))
    return samples.reshape(-1)


def apply_mel_base(mel, vocoder_mel_base: str, acoustic_mel_base: str):
    """对应 `:477-496` —— 两个 mel base 不同时整体乘硬编码系数。"""
    if vocoder_mel_base == acoustic_mel_base:
        return mel
    key = (vocoder_mel_base, acoustic_mel_base)
    if key not in MEL_BASE_K:
        raise RenderError('不对的 mel base 组合：%s / %s' % key)
    return mel * MEL_BASE_K[key]


def resample_to_44100(samples, sample_rate: int):
    """对应 `:523-527` —— 非 44100 时用 NWaves 重采样（本项目用 numpy 线性近似）。"""
    import numpy as np
    if sample_rate == 44100:
        return samples
    n = int(round(len(samples) * 44100.0 / sample_rate))
    return np.interp(np.linspace(0, len(samples) - 1, n),
                     np.arange(len(samples)), samples).astype(np.float32)


# ---------------------------------------------------------------- 编排

def render_phrase(singer, phrase: Phrase, providers, depth: float = DEFAULT_DEPTH,
                  steps: int = DEFAULT_STEPS, variance_cfg=None,
                  on_progress=None, progress_range=None, cache_dir=None
                  ) -> Tuple[List[float], int]:
    """对应 `InvokeDiffsinger`（:156-528）→ `(波形采样, 采样率)`。

    流程：padded segments → durations → f0 → variance → acoustic → mel base → vocoder。

    ★ `progress_range=(lo, hi)`：把本阶段的 0..100 映射到 `(lo, hi)`。
      上游进度条是**单一**单调序列；`pipeline` 先发 5..55 再调用本函数，
      若这里从 5 重新发，进度条会**倒退**（实测 `[5,12,25,40,55,5,15,…]`）。
    """
    import numpy as np

    from . import variance as V
    from .session import run_session

    lo, hi = progress_range if progress_range else (0, 100)

    def progress(pct, text):
        if not on_progress:
            return
        scaled = lo + (max(0, min(100, pct)) / 100.0) * (hi - lo)
        on_progress(scaled, text)

    frame_ms = singer.vocoder.frame_ms           # ★ B 层用 vocoder 的 frameMs（:241）
    progress(5, '计算音素时间轴…')
    segments = padded_segments(phrase.phones, frame_ms, HEAD_FRAMES, TAIL_FRAMES)
    durations = padded_phone_durations(phrase.phones, frame_ms,
                                       HEAD_FRAMES, TAIL_FRAMES)
    if not durations or sum(durations) <= 0:
        raise RenderError('音素时长合计为 0，无法渲染')
    total_frames = int(sum(durations))
    progress(15, '音高曲线…')
    feeds, aux = build_acoustic_inputs(singer, phrase, segments, durations,
                                       resolve_depth(singer.acoustic, depth), steps)

    # ---- variance（条件参与；无降级）
    need = (phrase.need_energy, phrase.need_breathiness,
            phrase.need_voicing, phrase.need_tension)
    if any(need):
        if variance_cfg is None:
            raise RenderError('声学模型要求方差输入，但该声库没有 dsvariance/（上游同样直接抛）')
        progress(35, '方差预测…')
        tokens = [singer.phoneme_tokens.get(sym, 0) for sym, _, _ in segments]
        vcfg = variance_cfg
        var = V.predict(singer, vcfg, phrase, segments, durations, tokens,
                        lambda sym: True, providers,
                        steps, compute_speedup(steps),
                        cache_dir=cache_dir, hashes=singer.hashes)
        values = {}
        if phrase.need_energy:
            values['energy'] = V.compose(var, 'ene', phrase, phrase.energy, 0.0,
                                         total_frames, frame_ms,
                                         HEAD_FRAMES, TAIL_FRAMES)
        if phrase.need_breathiness:
            values['breathiness'] = V.compose(var, 'brec', phrase, phrase.breathiness, 0.0,
                                              total_frames, frame_ms,
                                              HEAD_FRAMES, TAIL_FRAMES)
        if phrase.need_voicing:
            values['voicing'] = V.compose(var, 'voic', phrase, phrase.voicing, 0.0,
                                          total_frames, frame_ms,
                                          HEAD_FRAMES, TAIL_FRAMES)
        if phrase.need_tension:
            values['tension'] = V.compose(var, 'tenc', phrase, phrase.tension, 0.0,
                                          total_frames, frame_ms,
                                          HEAD_FRAMES, TAIL_FRAMES)
        add_variance_inputs(feeds, values)

    # ---- acoustic
    progress(60, '声学模型推理…')
    # ★ identifier = singer.acousticHash（照搬 :463 的 `new DiffSingerCache(
    #   singer.acousticHash, acousticInputs)`）
    outs = run_session(singer.model('acoustic'), feeds, providers, 'acoustic',
                       identifier=(singer.hashes or {}).get('acoustic'),
                       cache_dir=cache_dir)
    mel = np.asarray(outs[0], dtype=np.float32)
    progress(75, '声码器合成…')
    mel = apply_mel_base(mel, singer.vocoder.mel_base, singer.acoustic.mel_base)
    samples = run_vocoder(singer, mel, aux['f0'], providers, cache_dir)
    samples = resample_to_44100(samples, singer.vocoder.sample_rate)
    progress(95, '完成')
    return [float(x) for x in samples], 44100

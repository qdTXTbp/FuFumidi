# -*- coding: utf-8 -*-
r"""DiffSinger 的 `IRenderer` 实现 —— **照搬**
`OpenUtau.Core/DiffSinger/DiffSingerRenderer.cs`（:25-100、:102-150）。

## 为什么需要这个文件

之前 `singing/adapters/diffsinger.py::DiffSingerRenderer` 实现的是
**简化协议** `singing/api.py::Renderer`（`render(req)` 整曲一把梭），把
`engine_diffsinger.render_phrase` 当黑盒调用。结果绕过了：

* `PhraseSource.FromPart` 的**切句**（`pipeline_source.py:537` 调 `should_merge_phrases`）
* `RenderPhrase` 的音高/曲线/hash 构造
* wav 缓存（`ds-{hash:x16}-depth{}-steps{}.wav`）
* `ApplyDynamics`

本文件让**照搬的 OpenUtau 管线**（`PhraseSource` → `RenderPhrase` → 本渲染器）
真正驱动 DiffSinger 合成，于是工程管理与片段管理自动接上。

★ 注意 `dspitch` 仍**不参与**渲染（上游 `InvokeDiffsinger` 全程不碰音高模型），
  它只服务编辑器的「渲染音高曲线」（`load_rendered_pitch`）。
"""

import math
import os
from typing import List, Optional, Tuple

from ..renderer import IRenderer, RenderResult
from ..renderers import DIFFSINGER, apply_dynamics, register_renderer
from ..singer import USingerType

#: 上游 `DiffSingerUtils.cs:11-13` 的三条额外曲线常量（不在项目默认表达式里）
VELC = 'velc'
ENE = 'ene'
PEXP = 'p-exp'


def _head_tail_ms(frame_ms: float) -> Tuple[float, float]:
    """对应 `DiffSingerUtils.GetHeadMs/GetTailMs`（:26-40）= `frameMs * headFrames`。

    ★ `headFrames`/`tailFrames` 是**硬编码 8**（`:15-16`），不分句。
    """
    return (8.0 * frame_ms, 8.0 * frame_ms)


def _frame_ms(singer) -> float:
    """该歌手的帧时长（ms）。取自 **vocoder**（`DiffSingerRenderer.cs:241`）。"""
    cfg = getattr(singer, 'ds_config', None) or getattr(singer, 'dsconfig', None)
    if cfg is not None:
        try:
            return 1000.0 * float(cfg.hop_size) / float(cfg.sample_rate)
        except Exception:  # noqa: BLE001
            pass
    hop = getattr(singer, 'hop_size', 512)
    sr = getattr(singer, 'sample_rate', 44100)
    return 1000.0 * float(hop) / float(sr)


class DiffsingerIRenderer(IRenderer):
    """DiffSinger 渲染器（`IRenderer` 形状，逐句渲染）。"""

    #: 上游 `DiffSingerRenderer.cs:25-37` 的 `supportedExp` 白名单
    SUPPORTED_EXP = frozenset({
        'dyn', 'pitd', 'genc', 'clr', 'brec', 'voic', 'tenc',
        VELC, ENE, PEXP, 'shfc',
    })

    def __init__(self, merge_nearby_phrases: bool = False,
                 depth: float = 1.0, steps: int = 20,
                 cache_dir: Optional[str] = None):
        """
        * `merge_nearby_phrases` ← `Preferences.Default.DiffSingerMergeNearbyPhrases`
          （`DiffSingerRenderer.cs:98`）。关着时**按音素间隙切句**。
        * `depth`/`steps` 进缓存文件名，不进 hash（`:123`）。
        * `cache_dir` ← `PathManager.Inst.CachePath` 的等价物。
        """
        self.merge_nearby_phrases = bool(merge_nearby_phrases)
        self.depth = float(depth)
        self.steps = int(steps)
        self.cache_dir = cache_dir

    # ---------------------------------------------------------------- 基本属性

    def __str__(self) -> str:
        return 'DIFFSINGER'

    def singer_type(self):
        return USingerType.DIFFSINGER

    def supports_render_pitch(self) -> bool:
        return True

    @property
    def supports_real_curve(self) -> bool:
        """上游 `IRenderer.SupportsRealCurve` 的 DiffSinger 取值为 true。"""
        return True

    def supports_expression(self, descriptor) -> bool:
        abbr = getattr(descriptor, 'abbr', None) or ''
        return abbr in self.SUPPORTED_EXP

    def get_suggested_expressions(self, singer, render_settings) -> List:
        """照搬 `DiffSingerRenderer.cs:25-37` 的白名单 → 建议暴露的表达式描述符。"""
        out = []
        for abbr in ('dyn', 'pitd', 'genc', 'brec', 'voic', 'tenc', 'shfc'):
            out.append(abbr)
        return out

    # ---------------------------------------------------------------- 布局 / 切句

    def phrase_padding(self, singer, phonemes) -> Tuple[float, float]:
        """对应 `DiffSingerRenderer.cs:84-91` → `(GetHeadMs(frameMs), GetTailMs(frameMs))`。

        ★ 与基类默认的 `(0, 0)` 不同：DiffSinger **要**这 8+8 帧的首尾静音，
          `GapOverlapsPadding` 依赖它判断"两段该合并吗"。
        """
        return _head_tail_ms(_frame_ms(singer))

    def should_merge_phrases(self, project, track, prev, next_) -> bool:
        """对应 `DiffSingerRenderer.cs:97-100`。

        ```csharp
        return Preferences.Default.DiffSingerMergeNearbyPhrases
            && IRenderer.GapOverlapsPadding(this, track, prev, next);
        ```
        ★ 开关**默认关** → 默认行为是「有音素间隙就切句」。
        """
        return self.merge_nearby_phrases and self.gap_overlaps_padding(
            self, track, prev, next_)

    def layout(self, phrase) -> RenderResult:
        """对应 `DiffSingerRenderer.cs:70-82` 的 `Layout`。

        ```csharp
        float headMs = DiffSingerUtils.GetHeadMs(phrase);
        float tailMs = DiffSingerUtils.GetTailMs(phrase);
        return new RenderResult() {
            leadingMs = headMs,
            positionMs = phrase.positionMs,
            estimatedLengthMs = headMs + phrase.durationMs + tailMs,
        };
        ```
        ★ `estimatedLengthMs` **含**首尾 padding，而 `leadingMs` 让调用方知道
          要往回挪多少 —— 拼接时 `phraseOffsetMs = positionMs - leadingMs`
          （`RenderEngine.cs:318`）。
        """
        head_ms, tail_ms = self.phrase_padding(phrase.singer, phrase.phones)
        return RenderResult(
            samples=None,
            leading_ms=head_ms,
            position_ms=phrase.position_ms,
            estimated_length_ms=head_ms + phrase.duration_ms + tail_ms,
        )

    # ---------------------------------------------------------------- 渲染

    async def render(self, phrase, progress=None, track_no: int = 0, cancellation=None,
                     is_pre_render: bool = False,
                     render_events=None) -> RenderResult:
        """对应 `DiffSingerRenderer.Render`（:102-150）**逐句**渲染。

        流程（顺序不可改）：
          1. `Layout(phrase)` 先算布局
          2. 缓存文件名 `ds-{hash:x16}-depth{depth:f2}-steps{steps}.wav`，命中就读
          3. 未命中 → 走 `diffsinger` 包（A 层已由音素化器完成，这里只跑 B 层）
          4. **写缓存**
          5. **`ApplyDynamics`** ← 必须在写缓存**之后**
        """
        import numpy as np

        result = self.layout(phrase)
        head_ms, tail_ms = self.phrase_padding(phrase.singer, phrase.phones)

        depth = self._resolve_depth(phrase.singer)
        steps = self.steps
        wav_path = self._cache_path(phrase, depth, steps)
        if wav_path:
            phrase.add_cache_file(wav_path)

        samples = None
        if wav_path and os.path.isfile(wav_path):
            samples = _read_wav_mono(wav_path)
            if samples is None:
                # 对应 :132-134：读失败只记日志，继续重渲
                _log('failed to read cached render, re-rendering: %s' % wav_path)

        if samples is None:
            samples = await _render_phrase_audio(phrase, progress, cancellation)
            if samples is not None and wav_path:
                _write_wav_mono(wav_path, samples)

        if samples is not None:
            # ★ 对应 :142-144 —— ApplyDynamics 在**缓存写盘之后**。
            #   磁盘上的 wav 不含 dynamics；缓存命中时也要重跑一遍。
            samples = self._apply_dynamics(phrase, samples,
                                           result.position_ms - result.leading_ms)
        # ★ `openutau.renderer.RenderResult` 只有 4 个字段 —— **没有 sample_rate**
        #   （44100 是传输域常量，`ApplyDynamics` 里也是硬编码的）。
        return RenderResult(
            samples=samples,
            leading_ms=result.leading_ms,
            position_ms=result.position_ms,
            estimated_length_ms=result.estimated_length_ms,
        )

    def _resolve_depth(self, singer) -> float:
        """对应 `DiffSingerRenderer.cs:112-122`。"""
        cfg = getattr(singer, 'ds_config', None)
        use_var = getattr(cfg, 'use_variable_depth', None) if cfg is not None else None
        if use_var is None:
            raw = (getattr(cfg, 'raw', {}) or {}) if cfg is not None else {}
            use_var = bool(raw.get('use_variable_depth', False))
        if not use_var:
            return 1.0
        # ★ 复用 `diffsinger.config.resolve_depth`（已照搬 DiffSingerConfig.cs:70 的
        #   `maxDepth => useContinuousAcceleration ? _maxDepth : _maxDepth/1000.0`
        #   与 DiffSingerRenderer.cs:112-122 的 `min(preferred, maxDepth)`）
        from diffsinger.config import resolve_depth
        cfg = getattr(singer, 'ds_config', None)
        if cfg is None:
            return self.depth
        return resolve_depth(_as_acoustic_config(cfg), self.depth)

    def _cache_path(self, phrase, depth: float, steps: int) -> Optional[str]:
        """对应 `DiffSingerRenderer.cs:123-124` 的文件名。"""
        if not self.cache_dir:
            return None
        return os.path.join(
            self.cache_dir,
            'ds-%016x-depth%.2f-steps%d.wav' % (phrase.hash, depth, steps))

    # ---------------------------------------------------------------- dynamics

    def _apply_dynamics(self, phrase, samples, start_ms: float):
        """对应 `Renderers.ApplyDynamics`（`Render/Renderers.cs:105-125`）。

        ★ 三个要点：
          1. **44100 Hz 硬编码**（`:116`）
          2. `startTick = phrase.position - phrase.leading`（`:110`）—— 与
             `pitchStart` 同一个负偏移基准
          3. 原地乘；`dynamics` 已在 `RenderPhrase` 里做过 dB→线性
        """
        import numpy as np

        dynamics = getattr(phrase, 'dynamics', None)
        if dynamics is None or not len(dynamics):
            return samples
        axis = phrase.time_axis
        interval = 5
        start_tick = phrase.position - phrase.leading
        out = np.asarray(samples, dtype=np.float32)
        start_sample = 0
        for i in range(len(dynamics)):
            end_tick = start_tick + interval
            end_ms = axis.tick_pos_to_ms_pos(end_tick)
            end_sample = min(int((end_ms - start_ms) / 1000 * 44100), len(out))
            a = float(dynamics[i])
            b = float(dynamics[i]) if i + 1 == len(dynamics) else float(dynamics[i + 1])
            if end_sample > start_sample:
                seg = out[start_sample:end_sample]
                ramp = np.linspace(a, b, end_sample - start_sample, dtype=np.float32)
                out[start_sample:end_sample] = seg * ramp
            elif end_sample > start_sample - 1 and 0 <= start_sample < len(out):
                out[start_sample] *= a
            start_tick = end_tick
            start_sample = max(0, end_sample)
        return out

    # ---------------------------------------------------------------- 音高编辑

    def load_rendered_pitch(self, phrase, selected_note_positions=None,
                            pitch_steps=None, fast_realtime: bool = False):
        """对应 `LoadRenderedPitch`（:556-587）→ 跑 `dspitch` 拿真实曲线。

        ★ **编辑功能**，不参与渲染（`InvokeDiffsinger` 全程不碰音高模型）。
        """
        # ★ 接 `diffsinger.pitch_edit`（已照搬 DiffSingerPitch.DsPitch.Process +
        #   NoteBatchEdits.cs:540-566）。这是**编辑功能**，渲染不参与。
        import asyncio

        from diffsinger import pitch_edit as PE
        from diffsinger.g2p import load_ds_g2p
        from diffsinger.session import resolve_providers
        from diffsinger.voicebank import load_singer

        vb_dir = _singer_dir(phrase.singer)
        cfg = PE.load_pitch(vb_dir)
        if cfg is None:
            raise ValueError('该声库没有 dspitch/（无音高预测器）—— '
                             '这是编辑功能，渲染本身不需要它')
        warn_list: list = []
        g2p, _ = load_ds_g2p(load_singer(vb_dir).dur.root, 'zh', warn_list)
        singer = load_singer(vb_dir)
        res = PE.load_rendered_pitch(
            singer, cfg, phrase, phrase.notes, singer.phoneme_tokens, g2p,
            resolve_providers('cpu'), pitch_steps=pitch_steps,
            fast_realtime=fast_realtime)
        sel = set(selected_note_positions or ())
        pitd = PE.pitch_result_to_pitd(res, phrase, 0, list(phrase.pitches))
        return {'ticks': [t for t, _ in pitd], 'tones': [y for _, y in pitd],
                'voiced': res.voiced, 'retake_mask': res.retake_mask,
                'selected': sel}


# ---------------------------------------------------------------- 小工具

def _singer_dir(singer) -> str:
    """从 `USinger` 上取声库目录（不同版本的字段名不一样，全试一遍）。"""
    for attr in ('location', 'dir', 'path', 'location_or_dir'):
        v = getattr(singer, attr, None)
        if v:
            return str(v)
    raise ValueError('singer 上找不到声库目录（location/dir/path）')


def _as_acoustic_config(ds_config):
    """把 `USinger.ds_config` 适配成 `diffsinger.config.DsAcousticConfig`。

    ★ 只为复用 `resolve_depth`；`diffsinger` 包自己解析的是**根 `dsconfig.yaml`**，
      而这里拿到的是 `USinger` 侧已解析的配置对象，字段名一致（`use_continuous_acceleration`
      / `use_variable_depth` / `use_shallow_diffusion` / `_max_depth`）。
    """
    from diffsinger.config import DsAcousticConfig
    raw = getattr(ds_config, 'raw', None) or {}
    kw = {}
    for name in ('use_continuous_acceleration', 'use_variable_depth',
                 'use_lang_id', 'use_key_shift_embed', 'use_speed_embed',
                 'use_energy_embed', 'use_breathiness_embed',
                 'use_voicing_embed', 'use_tension_embed'):
        if hasattr(ds_config, name):
            kw[name] = getattr(ds_config, name)
    if 'use_shallow_diffusion' in raw:
        kw['use_shallow_diffusion'] = raw['use_shallow_diffusion']
    md = raw.get('max_depth', getattr(ds_config, '_max_depth', 0.6))
    cfg = DsAcousticConfig(root='.', acoustic='', vocoder='', phonemes='',
                           _max_depth=float(md), **kw)
    return cfg


def _log(msg: str) -> None:
    import sys
    sys.stderr.write('[diffsinger] ' + str(msg) + '\n')


def _read_wav_mono(path: str):
    """读 16-bit mono WAV → float32 [-1,1]（失败返回 None）。"""
    import wave
    import numpy as np
    try:
        with wave.open(path, 'rb') as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2:
                return None
            raw = w.readframes(w.getnframes())
        a = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
        return a if a.size else None
    except Exception:  # noqa: BLE001
        return None


def _write_wav_mono(path: str, samples) -> None:
    """写 16-bit mono WAV（`Wave.WriteMono16Wav` 的等价）。"""
    import struct
    import wave
    import numpy as np
    a = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    frames = (a * 32767.0).astype('<i2').tobytes()
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(frames)


async def _render_phrase_audio(phrase, progress=None, cancellation=None):
    """调 `diffsinger` 包渲染**单个** phrase 的 B 层 → float32 采样。

    ★ 这里只跑 B 层：A 层（dsdur 的 linguistic + dur + 对齐算法）在
      `DiffSingerBasePhonemizer` 阶段就完成了 —— 音素已带 `positionMs`/`durationMs`，
      正是 `padded_segments` 需要的输入。
    """
    import asyncio
    import numpy as np

    from diffsinger import renderer as ds_renderer
    from diffsinger import variance as ds_variance
    from diffsinger.voicebank import load_singer

    if progress:
        progress(0, 'DiffSinger 渲染…')

    def _work():
        vb_dir = _singer_dir(phrase.singer)
        singer = load_singer(vb_dir)
        frame_ms = 1000.0 * float(singer.vocoder.hop_size) / float(singer.vocoder.sample_rate)

        ac = singer.acoustic
        dp = ds_renderer.Phrase(
            axis=phrase.time_axis,
            part_position=0,
            position=phrase.position,
            leading=phrase.leading,
            position_ms=phrase.position_ms,
            duration_ms=phrase.duration_ms,
            phones=list(phrase.phones),
            pitches=list(phrase.pitches),
            tone_shift=list(phrase.tone_shift) if phrase.tone_shift else [],
            gender=list(phrase.gender) if phrase.gender else [],
            breathiness=list(phrase.breathiness) if phrase.breathiness else [],
            voicing=list(phrase.voicing) if phrase.voicing else [],
            tension=list(phrase.tension) if phrase.tension else [],
            energy=list(getattr(phrase, 'xsy', []) or []),
            need_energy=ac.use_energy_embed,
            need_breathiness=ac.use_breathiness_embed,
            need_voicing=ac.use_voicing_embed,
            need_tension=ac.use_tension_embed,
        )
        from diffsinger.session import resolve_providers
        samples, sr = ds_renderer.render_phrase(
            singer, dp, resolve_providers('cpu'),
            variance_cfg=ds_variance.load_variance(vb_dir))
        return samples, sr

    loop = asyncio.get_event_loop()
    samples, _sr = await loop.run_in_executor(None, _work)
    if progress:
        progress(len(phrase.phones), '完成')
    return np.asarray(samples, dtype=np.float32)


def _factory(**kwargs):
    """对照 C# `RendererFactory` 里的 `case "DIFFSINGER": return new DiffSingerRenderer();`。

    ★ 生产路径**默认带上 `PathManager.Inst.CachePath`**（对应 :124 的
      `Path.Combine(PathManager.Inst.CachePath, wavName)`）；
      测试可以显式传 `cache_dir=None` 关掉。
    """
    if kwargs.get('cache_dir') is None and 'cache_dir' not in kwargs:
        try:
            from singing.path_manager import get_path_manager
            kwargs['cache_dir'] = get_path_manager().cache_path
        except Exception:      # noqa: BLE001 —— 拿不到就退化为不缓存
            kwargs['cache_dir'] = None
    return DiffsingerIRenderer(**kwargs)


# ★ 注册**不在这里**做 —— 由 `__init__.py` 统一调用
#   `register_renderer(DIFFSINGER, _factory)`（与 `classic/__init__.py:48` 同一时机），
#   否则「只 import 本模块」与「import 包」两条路会注册出两个不同实例。

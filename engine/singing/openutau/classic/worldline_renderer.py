# -*- coding: utf-8 -*-
"""Worldline 渲染器 —— **照搬** `OpenUtau.Core/Classic/WorldlineRenderer.cs`（276 行）。

三个版本共用这一个类，靠 `version` 分派（也决定帧长）：

| version | 名字 | hopSize | 帧长 | 合成方式 |
|---|---|---|---|---|
| 10 | `WORLDLINE-R` | 441 | 10 ms | `PhraseSynthV2.Synth()`（纯 WORLD 合成） |
| 11 | `WORLDLINE-R1.1` | 220 | 5 ms | `SynthContinuousNoise()`（谐波半边 + 连续噪声） |
| 20 | `WORLDLINE-R2` | 512 | 512/44100 s | WORLD 特征喂给 ONNX 声码器包 |

★ **version 10 就是 `Renderers.GetDefaultRenderer` 对 Classic 歌手给出的默认渲染器**，
所以本文件把 v10 做完整；v11 / v20 各缺一块外部依赖，都在**入口处**报错说清楚缺什么
（不是静默算错、也不是留个 `NotImplementedError` 了事）。

## 照搬时保留的语义（别"整理"掉）
1. `SupportsExpression` 与 `ClassicRenderer` 的**不一样**：这里**只**看白名单，
   没有 `descriptor.isFlag || !string.IsNullOrEmpty(descriptor.flag)` 那两条 ——
   所以带 flag 的表达式在 Worldline 下**不被认为受支持**。
2. 缓存文件是 `wdl-v{version}-{phrase.hash:x16}.wav`（**版本号进文件名**），
   且真版本号（10/11/20）与 `ToString()` 返回的名字（`WORLDLINE-R*`）是两回事。
3. 读缓存与写缓存**分别**在 `lock (cacheLock)` 里，合成在锁**外**；
   写缓存是**同步**的（C# 注释：detached write 会和后续的冷渲染读抢）。
4. 三种版本的样本都要过 `AddDirects`（把 `direct` 音素的原音**原样**盖回去）
   与 `Renderers.ApplyDynamics`。
5. `SampleCurve` 的 `IndexOutOfRange` 语义：`index >= curve.Length` 时**留 0**
   （`result` 初值是 0），不是夹到最后一个点。
6. `AddDirects` 里 `length = cutoff >= 0 ? (samples.Length - offset - cutoff) : -cutoff`，
   然后 `Skip(offset).Take(length)` —— `Take` 负数会得到空数组（不是抛错）。
7. `ExpressionGraphSlot` 固定是 `WORLDLINE_R`（C# 注释：三个变体渲染同样的表达式，
   共用 R 的表达式图）。

## v11 / v20 缺什么（都在入口报错）
- **v11**：`PhraseSynthV2(use_hnsep: true)` —— 谐波/噪声分离模型 `Hnsep` 未搬
  （`SynthSegment` 的谐波分支 + `HnAnalysisF0In` 绑定 + `sp_env_harmonic` 的传递）。
- **v20**：需要两个 ONNX 会话 —— mel 模型是 `OpenUtau.Core` **程序集内嵌资源**
  （`Data.Resources.mel`，仓库里没有对应文件），声码器是**可下载包**
  `pc-nsf-hifigan`（走 `PackageManager` + `vocoder.yaml`）。两者都不在照搬范围内。
"""

import asyncio
import logging
import math
import os
from typing import List, Optional

from ..music_math import MusicMath
from ..render_engine import Progress
from ..renderer import IRenderer, RenderResult
from ..renderers import (WORLDLINE_R, WORLDLINE_R11, WORLDLINE_R2, apply_dynamics,
                         get_cache_lock, register_renderer)
from ..singer import USingerType
from ..wave import Wave
from ..worldline import PhraseSynthV2, SynthCancelled, SynthRequestError
from ...ustx.format import Ustx
from .resampler_item import ResamplerItem

logger = logging.getLogger(__name__)

#: 三个版本的 hopSize（对应 C# 构造函数里的 `version switch`）
HOP_SIZES = {10: 441, 11: 220, 20: 512}

#: 采样率写死 44100（C# 里 `initAnalysisConfig(44100, hopSize, 2048)` 与 `frameMs` 都用它）
SAMPLE_RATE = 44100
FFT_SIZE = 2048

#: v20 的 ONNX 两件套（都未搬，报错时要把名字说清楚）
R2_MEL_RESOURCE = 'Data.Resources.mel'
R2_VOCODER_PACKAGE = 'pc-nsf-hifigan'


def hop_size_for_version(version: int) -> int:
    """对应 C# 构造函数的 `version switch`（未知版本抛 `ArgumentException`）。"""
    if version not in HOP_SIZES:
        raise ValueError('Unsupported WorldlineRenderer version: %s' % version)
    return HOP_SIZES[version]


class WorldlineRenderer(IRenderer):
    """对应 C# 的 `WorldlineRenderer`。"""

    #: 对应 C# 的静态 `supportedExp`
    #: ★ 注意与 `ClassicRenderer.SUPPORTED_EXP` **不同**：这里没有 flag 兜底，
    #:   也少了 ENG / ATK / DEC。
    SUPPORTED_EXP = frozenset((
        Ustx.DYN, Ustx.PITD, Ustx.CLR, Ustx.CLRY, Ustx.XSY, Ustx.SHFT,
        Ustx.VEL, Ustx.VOL, Ustx.MOD, Ustx.MODP, Ustx.ALT,
        Ustx.GENC, Ustx.BREC, Ustx.TENC, Ustx.VOIC, Ustx.DIR,
    ))

    def __init__(self, version: int = 10, num_render_threads: Optional[int] = None,
                 classic_host=None):
        self.version = version
        self.hop_size = hop_size_for_version(version)
        self.frame_ms = self.hop_size * 1000.0 / float(SAMPLE_RATE)
        if num_render_threads is None:
            from ..singer import Preferences
            num_render_threads = Preferences.num_render_threads
        self._num_render_threads = num_render_threads
        self._injected_host = classic_host

    @property
    def classic_host(self):
        """与 `ClassicRenderer` 同一套宿主解析（显式注入优先，否则跟随模块级替身）。"""
        if self._injected_host is not None:
            return self._injected_host
        from . import resampler_item
        return resampler_item.host

    # ------------------------------------------------------------------ 能力

    @property
    def singer_type(self) -> int:
        return USingerType.CLASSIC

    @property
    def supports_render_pitch(self) -> bool:
        return False

    def supports_expression(self, descriptor) -> bool:
        """对应 `SupportsExpression`：**只**看白名单（没有 Classic 那两条 flag 兜底）。"""
        if descriptor is None:
            return False
        return descriptor.abbr in self.SUPPORTED_EXP

    @property
    def expression_graph_slot(self) -> str:
        """对应 `ExpressionGraphSlot => Renderers.WORLDLINE_R`（三个变体共用）。"""
        return WORLDLINE_R

    # ------------------------------------------------------------------ 布局

    def layout(self, phrase) -> RenderResult:
        """对应 `Layout`。"""
        return RenderResult(
            samples=None,
            leading_ms=phrase.leading_ms,
            position_ms=phrase.position_ms,
            estimated_length_ms=phrase.duration_ms + phrase.leading_ms,
        )

    def load_rendered_pitch(self, phrase, selected_note_positions=None):
        return None

    def get_suggested_expressions(self, singer, render_settings) -> List:
        return []

    # ------------------------------------------------------------------ 渲染

    async def render(self, phrase, progress: Optional[Progress] = None, track_no: int = 0,
                     cancellation=None, is_pre_render: bool = False,
                     render_events=None) -> RenderResult:
        """对应 `Render`：缓存 → 合成 → 盖回 direct 音素 → 写缓存 → 应用动态。

        C# 在 `Task.Run` 的 lambda 里闭包捕获 `resamplerItems`；Python 的
        `run_in_executor` 只能传参，所以那份清单在 `_render_sync` 里就地构造
        （构造顺序与 C# 一致：**先**为每个音素建 `ResamplerItem`）。
        """
        return await asyncio.get_event_loop().run_in_executor(
            None, self._render_sync, phrase, progress, track_no, cancellation)

    def _render_sync(self, phrase, progress, track_no, cancellation) -> RenderResult:
        resampler_items = [ResamplerItem(phrase, phone) for phone in phrase.phones]
        result = self.layout(phrase)
        wav_path = os.path.join(self.classic_host.cache_path,
                                'wdl-v%d-%016x.wav' % (self.version, phrase.hash))
        phrase.add_cache_file(wav_path)
        progress_info = 'Track %d: %s %s' % (
            track_no + 1, self, ' '.join(p.phoneme for p in phrase.phones))
        _complete(progress, 0, progress_info)

        cache_lock = get_cache_lock(wav_path)
        with cache_lock:
            if os.path.isfile(wav_path):
                result.samples = Wave.get_samples(wav_path)

        if result.samples is None:
            phrase_synth = self._make_phrase_synth()
            for item in resampler_items:
                phone = item.phone
                pos_ms = (phone.position_ms - phone.leading_ms
                          - (phrase.position_ms - phrase.leading_ms))
                skip_ms = item.skip_over
                length_ms = phone.envelope[4].x - phone.envelope[0].x
                fade_in_ms = phone.envelope[1].x - phone.envelope[0].x
                fade_out_ms = phone.envelope[4].x - phone.envelope[3].x
                phrase_synth.add_request(item, pos_ms, skip_ms, length_ms,
                                         fade_in_ms, fade_out_ms)

            try:
                phrase_synth.analyze_requests(cancellation)
            except SynthCancelled:
                # 对应 C# `catch (OperationCanceledException) { return result; }`
                return result
            except SynthRequestError as e:
                # 对应 C# 把两类错误包成带 `<translate:...>` 文案的异常后重抛。
                # 我们**保留异常类型**并把音素名写进消息（翻译键是 UI 层 M3 的事）。
                phoneme = e.item.phone.phoneme if getattr(e, 'item', None) is not None else ''
                raise type(e)('%s: %s' % (e, phoneme), item=getattr(e, 'item', None)) from e

            frames = math.ceil(result.estimated_length_ms / self.frame_ms)
            f0 = self.sample_curve(phrase, phrase.pitches, 0.0, frames,
                                   lambda x: MusicMath.tone_to_freq(x * 0.01))
            gender = self.sample_curve(phrase, phrase.gender, 0.5, frames,
                                       lambda x: 0.5 + 0.005 * x)
            tension = self.sample_curve(phrase, phrase.tension, 0.5, frames,
                                        lambda x: 0.5 + 0.005 * x)
            breathiness = self.sample_curve(phrase, phrase.breathiness, 0.5, frames,
                                            lambda x: 0.5 + 0.005 * x)
            voicing = self.sample_curve(phrase, phrase.voicing, 1.0, frames,
                                        lambda x: 0.01 * x)
            phrase_synth.set_curves(f0, gender, tension, breathiness, voicing)

            if self.version == 11:
                result.samples = phrase_synth.synth_continuous_noise(seed=phrase.hash)
            elif self.version == 10:
                result.samples = phrase_synth.synth()
            else:
                result.samples = self._synth_r2(phrase_synth)

            self._add_directs(phrase, resampler_items, result)
            if result.samples is not None:
                # 同步写：detached write 会和后续冷渲染的读抢同一个文件
                try:
                    with cache_lock:
                        Wave.write_mono16_wav(wav_path, result.samples)
                except Exception as e:      # noqa: BLE001 —— C# 也只记日志
                    logger.error('Failed to write cache file: %s (%s)', wav_path, e)

        _complete(progress, len(phrase.phones), progress_info)
        if result.samples is not None:
            apply_dynamics(phrase, result)
        return result

    # ------------------------------------------------------------------ 各版本的合成

    def _make_phrase_synth(self) -> PhraseSynthV2:
        """对应 `new Worldline.PhraseSynthV2(44100, hopSize, 2048, useHnsep: version == 11)`。

        v11 需要 hnsep 模型（未搬）→ 在 `PhraseSynthV2.synth_continuous_noise` 里报错；
        这里额外在**构造时**就给一句更贴近渲染器语境的说明。
        """
        if self.version == 11:
            from ..worldline import _default_hnsep
            if _default_hnsep() is None:
                raise NotImplementedError(
                    'Worldline-R1.1（v11）需要谐波/噪声分离模型，尚未照搬：\n'
                    '  - Classic/WorldlineRenderer 依赖 Worldline.PhraseSynthV2(useHnsep: true)\n'
                    '  - 需要 Core/Analysis/Hnsep（ONNX）+ Analysiss 的谐波分支\n'
                    '  - 另需 SynthSegment 的 sp_env_harmonic 传递与 HnAnalysisF0In 绑定\n'
                    '临时替代：用 version=10（WORLDLINE-R，默认渲染器）')
        return PhraseSynthV2(SAMPLE_RATE, self.hop_size, FFT_SIZE,
                             use_hnsep=(self.version == 11),
                             num_render_threads=self._num_render_threads)

    def _synth_r2(self, phrase_synth) -> List[float]:
        """v20（Worldline-R2）：WORLD 特征 → patch 到 16 的倍数 → mel ONNX → 声码器 ONNX。

        ★ 未搬，原因不是"懒得写"：
        - mel 模型是 `OpenUtau.Core` 的**程序集内嵌资源**（`Data.Resources.mel`），
          仓库里没有独立文件可取；
        - 声码器是**可下载包** `pc-nsf-hifigan`（`PackageManager` + `vocoder.yaml` 的
          `model` 字段指向 .onnx），属于包管理子系统，也未搬。
        所以这里给的是**可执行的替代方案**，而不是半截实现。
        """
        raise NotImplementedError(
            'Worldline-R2（v20）需要两个 ONNX 会话，均未照搬：\n'
            '  - mel 模型：%s（程序集内嵌资源，仓库中无独立文件）\n'
            '  - 声码器包：%s（走 PackageManager/ vocoder.yaml，包管理子系统未搬）\n'
            '临时替代：用 version=10（WORLDLINE-R，默认渲染器）'
            % (R2_MEL_RESOURCE, R2_VOCODER_PACKAGE))

    # ------------------------------------------------------------------ 曲线 / direct

    def sample_curve(self, phrase, curve, default_value: float, length: int,
                     convert) -> List[float]:
        """对应 `SampleCurve`。

        ★ `index >= len(curve)` 时**留 0**（`result` 初值），不是夹到最后一个点。
        """
        interval = 5
        result = [0.0] * length
        if curve is None:
            return [default_value] * length
        for i in range(length):
            pos_ms = phrase.position_ms - phrase.leading_ms + i * self.frame_ms
            ticks = (phrase.time_axis.ms_pos_to_tick_pos(pos_ms)
                     - (phrase.position - phrase.leading))
            index = max(0, int(float(ticks) / interval))
            if index < len(curve):
                result[i] = convert(curve[index])
        return result

    @staticmethod
    def _add_directs(phrase, resampler_items, result) -> None:
        """对应静态的 `AddDirects`：把 `direct` 音素的原音**原样**盖回输出上。"""
        if result.samples is None:
            return
        for item in resampler_items:
            phone = item.phone
            if not phone.direct:
                continue
            pos_ms = (phone.position_ms - phone.leading_ms
                      - (phrase.position_ms - phrase.leading_ms))
            start_phrase_index = int(pos_ms / 1000 * SAMPLE_RATE)
            samples = Wave.get_samples(phone.oto.file)
            if samples is None:
                continue
            offset = int(phone.oto.offset / 1000 * SAMPLE_RATE)
            cutoff = int(phone.oto.cutoff / 1000 * SAMPLE_RATE)
            length = (len(samples) - offset - cutoff) if cutoff >= 0 else -cutoff
            # C# 的 `Skip(offset).Take(length)`：Take 负数得到空数组（不抛错）
            samples = samples[offset:offset + length] if length > 0 else []
            item.apply_envelope(samples)
            n = min(len(samples), len(result.samples) - start_phrase_index)
            for i in range(max(0, n)):
                result.samples[start_phrase_index + i] = samples[i]

    # ------------------------------------------------------------------ 其它

    def __str__(self) -> str:
        """对应 `ToString()`。★ 返回的是**渲染器名**，不是版本号。"""
        if self.version == 11:
            return WORLDLINE_R11
        if self.version == 20:
            return WORLDLINE_R2
        return WORLDLINE_R


def _complete(progress, n: int, info: str) -> None:
    if progress is not None:
        progress.complete(n, info)


def register_worldline_renderers() -> None:
    """把三个版本登记进渲染器注册表（C# 是 `CreateRenderer` 里的 `new WorldlineRenderer(version: N)`）。

    三个 id 各自的工厂都接受 `version=`，正好对上 `renderers.create_renderer` 的调用方式
    （`WORLDLINE_R2 → version=20`、`WORLDLINE_R11 → version=11`、
    任何 `WORLDLINE*` 前缀 → `version=10`）。

    与 `register_classic_renderer` 一样单独开一个函数，是为了在
    `reset_registry()` 之后能重新登记。
    """
    register_renderer(WORLDLINE_R, WorldlineRenderer)
    register_renderer(WORLDLINE_R11, WorldlineRenderer)
    register_renderer(WORLDLINE_R2, WorldlineRenderer)

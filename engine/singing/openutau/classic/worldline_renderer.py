# -*- coding: utf-8 -*-
"""Worldline 渲染器 —— **照搬** `OpenUtau.Core/Classic/WorldlineRenderer.cs`（276 行）。

三个版本共用这一个类，靠 `version` 分派（也决定帧长）：

| version | 名字 | hopSize | 帧长 | 合成方式 |
|---|---|---|---|---|
| 10 | `WORLDLINE-R` | 441 | 10 ms | `PhraseSynthV2.Synth()`（纯 WORLD 合成） |
| 11 | `WORLDLINE-R1.1` | 220 | 5 ms | `SynthContinuousNoise()`（谐波半边 + 连续噪声） |
| 20 | `WORLDLINE-R2` | 512 | 512/44100 s | WORLD 特征喂给 ONNX 声码器包 |

★ **version 10 就是 `Renderers.GetDefaultRenderer` 对 Classic 歌手给出的默认渲染器**，
所以本文件把 v10 做完整。v11 的**代码链路已全部接通**（hnsep 分离 → `HnAnalysisF0In` →
`SynthContinuousNoise`），它唯一的外部依赖是**模型包** `hnsep_240512` 有没有装；
没装时在**入口处**报错说清楚缺什么（不是静默算错、也不是留个 `NotImplementedError` 了事）。
v20 的编码链已接通（mel 模型随包，见 `resolve_mel_model`），只差 128bin/512hop 声码器这个外部资源。

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
- **v11**：代码侧**已全部搬完**（`hnsep.py` + `worldline.`{`hn_analysis_f0_in`,`synth_continuous_noise`}`）。
  现在缺的只是**运行时依赖**：模型包 `hnsep_240512` 还没安装（约 52 MB，走资源中心下载）。
  宿主用 `worldline.set_hnsep()` 注入已加载的实例；没注入就在这里给出可操作的报错。
- **v20**：需要两个 ONNX 会话 —— mel 模型是仓库里的**独立文件**
  `OpenUtau.Core/Classic/Data/mel.onnx`（83.4 KB；`.resx` 只是 .NET 把它编进程序集的方式，
  源文件一直都在），声码器是 128bin / 512hop 的 PC-NSF-HiFiGAN
  （**每个 DiffSinger 声库的 `dsvocoder/` 里就带一个**，资源中心也会下通用声码器）。
  ★ **两个依赖都在盘上（WP3-3 实测）**：v20 缺的不是模型，而是"这段编排"。
  别再照着"拿不到 mel 模型"重估 —— 详见 `_synth_r2` 的 docstring。
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
#: 随包的 mel 模型（上游 `Classic/Data/mel.onnx`）。来源与 sha256 见 docs/VENDOR.md。
#: 上游把它放在 `OpenUtau.Core/Classic/Data/`，这里镜像成 `classic/data/`。
R2_MEL_BUNDLED = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'mel.onnx')
R2_MEL_RESOURCE = 'Data.Resources.mel'
R2_VOCODER_PACKAGE = 'pc-nsf-hifigan'


def resolve_mel_model() -> str:
    """mel 模型在哪：环境变量 → 数据根 → **随包**。都没有则给可行动的报错。

    随包那份是默认路径（83.4 KB），所以正常情况下永远走得到。
    """
    cands = [os.environ.get('FUFUMIDI_MEL_ONNX')]
    root = os.environ.get('FUFUMIDI_DATA_ROOT')
    if root:
        cands.append(os.path.join(root, 'diffsinger', 'mel', 'mel.onnx'))
    cands.append(R2_MEL_BUNDLED)
    for p in cands:
        if p and os.path.isfile(p):
            return p
    raise RuntimeError(
        'v20（Worldline-R2）需要 mel 模型，但一个候选路径都没有：%s\n'
        '  随包那份应该在这里：%s\n'
        '  （它只有 83.4 KB，若缺失说明安装包不完整；也可用 FUFUMIDI_MEL_ONNX 指定）'
        % (cands, R2_MEL_BUNDLED))


def resolve_r2_vocoder() -> str:
    """128bin / 512hop 的 PC-NSF-HiFiGAN：环境变量 → **数据根的通用声码器**。

    只认这两个来源：声库自带的 `dsvocoder/` 是 DiffSinger 管线的东西，签名相近但训练集不同，
    静默用错比报错更难查。缺了就报错，让用户去资源中心装通用声码器（那边已经会下）。
    """
    env = os.environ.get('FUFUMIDI_R2_VOCODER')
    if env and os.path.isfile(env):
        return env
    root = os.environ.get('FUFUMIDI_DATA_ROOT')
    dirs = []
    if root:
        dirs.append(os.path.join(root, 'diffsinger', 'vocoder'))
    for d in dirs:
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        # 优先 512hop / 128bin（与 mel 的 128 bins 精确衔接），否则退回任意 onnx
        pick = [n for n in names if n.lower().endswith('.onnx') and 'hop512' in n and '128bin' in n] \
            or [n for n in names if n.lower().endswith('.onnx')]
        if pick:
            return os.path.join(d, pick[0])
    raise RuntimeError(
        'v20（Worldline-R2）需要 128bin/512hop 的 PC-NSF-HiFiGAN 声码器，没找到。\n'
        '  资源中心装「通用声码器」即可（约 55 MB）；也可用 FUFUMIDI_R2_VOCODER 指定。')


def r2_pad(total_frames, f0, sp, ap, sp_size):
    """按上游补帧：**左补 4 帧**，再补到 16 的倍数。

    `WorldlineRenderer.cs:140-147`。★ 三件容易漏的事：
      1. 不是「补到 16 的倍数」那么简单 —— 先 `+8` 再 `+4` 再取整，等价于
         `ceil((T + 12) / 16) * 16`，**左边固定 4 帧**、其余全在右边；
      2. `f0` 与 `sp_env` 补 **0**，`ap` 补 **1** —— ap 是「非周期成分」，补 0 等于
         宣称这些帧完全周期，边缘会出错；
      3. 补出来的帧**不参与最终输出**（见 `r2_synthesize` 的裁剪），只是为了满足
         mel 模型对帧数的整除要求、并给边缘一点余量。

    返回 `(padded_len, left, f0, sp, ap)`。
    """
    import numpy as np

    T = int(total_frames)
    padded = int(math.ceil((T + 12) / 16.0)) * 16
    left = 4
    right = padded - T - left
    f0a = np.asarray(f0, dtype=np.float32).reshape(-1)
    spa = np.asarray(sp, dtype=np.float32).reshape(-1, sp_size)
    apa = np.asarray(ap, dtype=np.float32).reshape(-1, sp_size)
    f0p = np.concatenate([np.zeros(left, np.float32), f0a, np.zeros(right, np.float32)])
    spp = np.concatenate([np.zeros((left, sp_size), np.float32), spa,
                          np.zeros((right, sp_size), np.float32)], axis=0)
    app = np.concatenate([np.ones((left, sp_size), np.float32), apa,
                          np.ones((right, sp_size), np.float32)], axis=0)
    return padded, left, f0p, spp, app


def r2_synthesize(total_frames, f0, sp, ap, sp_size, providers=None):
    """v20 的**核心编排**（独立成函数，便于不起 native 库就单测）：

    WORLD 特征 → 左补 4 帧并补到 16 的倍数 → `mel.onnx` → 128bin/512hop 声码器 →
    裁掉补出来的帧 → 首尾各 512 样本淡入淡出。上游 `WorldlineRenderer.cs:138-193`，逐行对齐。

    三个输入与 mel 输出的签名**精确衔接**：`f0 [1,T]` · `sp_env [1,T,1025]` · `ap [1,T,1025]`
    → `mel [1,T,128]` → 声码器 `mel [1,n,128]` · `f0 [1,n]` → `waveform [1,n_samples]`。

    ★ 两个上游决定照搬：mel 会话用 **CPU**（`OnnxRunnerChoice.CPU`，模型只有 85 KB，
    挪去 GPU 不划算），声码器用默认（GPU 可用就用）。
    """
    import numpy as np
    from diffsinger.session import resolve_providers, run_session

    T = int(total_frames)
    if T <= 0:
        # 空乐句不该因为缺模型而失败（也不该白跑一次路径解析）
        return []
    mel_path = resolve_mel_model()
    voc_path = resolve_r2_vocoder()
    prov = providers or resolve_providers('auto')
    padded, left, f0p, spp, app = r2_pad(T, f0, sp, ap, sp_size)
    # run_session 会做双向输入名比对（缺/多都抛）—— 正好替我们盯住签名漂移
    mel = run_session(mel_path, {
        'f0': f0p.reshape(1, padded),
        'sp_env': spp.reshape(1, padded, sp_size),
        'ap': app.reshape(1, padded, sp_size),
    }, resolve_providers('cpu'), 'worldline r2 mel')[0]
    mel = np.asarray(mel, dtype=np.float32)
    wave = run_session(voc_path, {'mel': mel, 'f0': f0p.reshape(1, padded)},
                       prov, 'worldline r2 vocoder')[0]
    wave = np.asarray(wave, dtype=np.float32).reshape(-1)
    # ★ 丢掉左补的 4 帧，只取 T 帧（上游 :183）—— 留着补出来的帧会让乐句整体前移。
    start = left * HOP_SIZES[20]
    want = T * HOP_SIZES[20]
    wave = wave[start:start + want]
    if wave.size == 0:
        return []
    # ★ 首尾各 512 样本线性淡入淡出（上游 :184-193）—— 这是乐句拼接处不爆音的原因。
    n = min(wave.size, HOP_SIZES[20])
    if n > 0:
        wave[:n] = wave[:n] * (np.arange(n, dtype=np.float32) / n)
        wave[wave.size - n:] = wave[wave.size - n:] * (np.arange(n, 0, -1, dtype=np.float32) / n)
    return [float(x) for x in wave]


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

        v11 的代码链路已经搬完，**唯一的前置条件是模型包**：
        这里在**构造时**就给出可操作的说明（比让 `synth_continuous_noise` 深处再抛要清楚）。
        """
        if self.version == 11:
            from ..worldline import _default_hnsep
            if _default_hnsep() is None:
                # ★ WP4-4：宿主没注入时，**按资源中心的安装位置自己找一次**（懒加载）。
                #   放在这里而不是进程启动时 —— v10 用户不该为它付任何启动成本。
                from ..hnsep import PACKAGE_ID as HNSEP_PACKAGE_ID
                from ..hnsep import autoload as _autoload_hnsep, autoload_error
                _autoload_hnsep()
            if _default_hnsep() is None:
                raise RuntimeError(
                    'Worldline-R1.1（v11）需要谐波/噪声分离模型 %s，当前没有装。\n'
                    '  · 代码侧已就绪：hnsep 网络 + HnAnalysisF0In + SynthContinuousNoise 都已搬完\n'
                    '  · 缺的是模型包本体（约 52 MB）—— 装到「资源中心」即可，'
                    '引擎会在渲染 v11 时自动加载\n'
                    '  · 本次查找结果：%s\n'
                    '临时替代：用 version=10（WORLDLINE-R，默认渲染器）'
                    % (HNSEP_PACKAGE_ID, autoload_error() or '未找到'))
        return PhraseSynthV2(SAMPLE_RATE, self.hop_size, FFT_SIZE,
                             use_hnsep=(self.version == 11),
                             num_render_threads=self._num_render_threads)

    def _synth_r2(self, phrase_synth) -> List[float]:
        """v20（Worldline-R2）：WORLD 特征 → 左补 4 帧并补到 16 的倍数 → mel ONNX → 声码器 ONNX。

        ★ 未搬 —— **但 WP3-3（2026-10-14）查证后，原来的两条理由都是错的**，别再照着它们重估：

        1. ❌ 旧理由："mel 模型是程序集内嵌资源，仓库里没有独立文件可取"。
           **实际**：`OpenUtau.Core/Classic/Data/mel.onnx` 就是仓库里的**独立文件**（83.4 KB）。
           `.resx` / `Resources.Designer.cs` 只是 .NET 把它**编进程序集**的方式，
           源文件一直都在，直接取即可。已实测可加载：
             in  `f0 [1,T]` · `sp_env [1,T,1025]` · `ap [1,T,1025]`
             out `mel [1,T,128]`
           —— 这三个输入正是 `SynthFeatures()` 已经在算的东西，衔接是现成的。

        2. ⚠ 旧理由："声码器是 `pc-nsf-hifigan` 可下载包，包管理子系统未搬"。
           按字面仍成立（我们没有 `PackageManager`），但**不构成阻塞**：
           `pc-nsf-hifigan` 是 PC-NSF-HiFiGAN，而**每个 DiffSinger 声库的 `dsvocoder/` 里就带一个**
           （如 `kouon_pc_mini_nsf-hifigan_1028_44100hz_512hop_128bin.onnx`，54 MB），
           资源中心也已经会下通用声码器 `nsf_hifigan_44.1k_hop512_128bin`。两者签名一致：
             in  `mel [1,n_frames,128]` · `f0 [1,n_frames]`
             out `waveform [1,n_samples]`
           与上面的 `mel[1,T,128]` **精确对上**。

        **结论：v20 的两个依赖都在手上，它不是"拿不到模型"而是"还没写这段编排"。**
        实现时要做的是：取 `mel.onnx`（随包或下载）→ 按上游 `WorldlineRenderer.cs:150-175` 串
        `f0/sp_env/ap → mel` → 配一个 128bin/512hop PC-NSF-HiFiGAN 声码器出波形；
        `sp_env/ap` 的 1025 宽与本类的 `FFT_SIZE`=2048 一致，不用改分析侧。
        **已实现（2026-10-14）**：mel 模型随包（`classic/data/mel.onnx`，83.4 KB，
        sha256 见 `docs/VENDOR.md`），声码器走数据根的通用声码器。
        """
        total, f0, sp, ap = phrase_synth.synth_features()
        sp_size = FFT_SIZE // 2 + 1
        return r2_synthesize(total, f0, sp, ap, sp_size)

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
            # ★ 上游 b30d3347：同 sharp_wavtool，用 ResamplerItem 算出来的值
            offset = int(item.offset / 1000 * SAMPLE_RATE)
            cutoff = int(item.cutoff / 1000 * SAMPLE_RATE)
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

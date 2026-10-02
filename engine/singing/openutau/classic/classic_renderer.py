# -*- coding: utf-8 -*-
"""Classic 线渲染器 —— **照搬** `OpenUtau.Core/Classic/ClassicRenderer.cs`（152 行）。

它把"变调器"和"拼接器"串成一条乐句：

    RenderPhrase
      → 每个音素造一个 ResamplerItem
      → 并行跑 resampler（`DoResamplerReturnsFile` 写缓存 wav）
      → wavtool.Concatenate 把缓存 wav 叠成整条乐句
      → ApplyDynamics 把动态曲线乘上去

两条分支（`Render` 里按 `phrase.wavtool` 分派）：

- **`RenderInternal`**：wavtool 是自带的 `simple` / `convergence` 时走这条。
  它**直接 `new SharpWavtool(true)`** —— 也就是说这条路上 `phrase.wavtool` 只用来
  **判断分支**，拼接永远用 `convergence`（上游如此，别"顺手"按名字 new）。
- **`RenderExternal`**：外部 wavtool 那条路。它按 `phrase.hash` 找一条
  `cat-{hash:x16}.wav` 缓存，命中就直接读、不重算；否则请
  `ToolsManager.GetWavtool(phrase.wavtool)` 来拼，并把结果写进那条缓存路径。

## 照搬时保留的语义（别"整理"掉）
1. `RenderInternal` 里 `SharpWavtool(true)` 是**写死的**（见上）。
2. **缓存命中判断在并行体里**：C# 是 `!File.Exists(item.outputFile)` 才去调
   resampler —— 已渲染过的音素直接跳过，这是"改一个音符只重算一个音素"的关键。
3. `RenderInternal` 里对 `VoicebankFiles` 的两次调用都**带 guard**
   （`!(item.resampler is WorldlineResampler)`）：自带 Worldline 直接读原音，
   不需要"解码到临时文件 / 回抄元数据"。缺了 guard 会让自包含路径直接抛。
4. **direct 音素不做 resample**（`if (!item.phone.direct)`）：它整段用原音，
   拼接阶段由 `SharpWavtool` 的 direct 分支按 oto 的 offset/cutoff 切片。
5. resampler 跑完仍**没有产出文件**时抛错，并把音素位置换算成"小节:拍.刻度"
   写进消息（用**乐句**的 `position + phone.position`）。
6. `progress.Complete(1, ...)` 在 `if` **之外**，取消/缓存命中也照样上报一步。
7. `ApplyDynamics` 只在 `samples is not None` 时调（取消时拼接器返回 None）。
8. `Layout` 的 `estimatedLengthMs = durationMs + leadingMs`（不是 durationMs）。
9. **外部路径自己不跑 resampler**：`RenderExternal` 只把 `ResamplerItem` 交给
   wavtool，**音素缓存文件是 wavtool 负责产出的** —— `ExeWavtool.Concatenate`
   里那段 `if (item.resampler.NoWrapperScript && !File.Exists(item.outputFile))`
   会在拼之前先把 resampler 跑掉（外部 resampler 则由它生成的脚本去调 exe）。
   所以"内部路径跑 resampler、外部路径不跑"是**有意的不对称**，别"顺手补齐"。
10. **`GetCacheLock` 必须可重入**：C# 返回 `object` 一律配 `lock()`（= Monitor，
    同线程可重复进入），而这条嵌套是真实存在的 —— `RenderInternal` 先按
    `item.outputFile` 加锁、再进 `WorldlineResampler.DoResamplerReturnsFile`
    里的**同一把**锁；`SharpWavtool` 读缓存文件时也按同一 key 加锁。
    Python 侧必须用 `RLock`，用 `Lock` 会在第一次真渲染时**自锁死**（已实测）。

## 与 C# 的载体差异（不是行为差异）
- `Parallel.ForEach(MaxDegreeOfParallelism = NumRenderThreads)` →
  `ThreadPoolExecutor(max_workers=...)`。**多线程是有意义的**：真正的计算在
  ctypes 调的原生库里，那里会释放 GIL。C# 会把异常包成 `AggregateException` 重抛；
  这里按**提交顺序**取第一个异常原样重抛（比随机顺序更可预期，失败语义相同）。
- `Task.Run(...)` 返回 `Task<RenderResult>` → 这里保留 `async def`，用
  `run_in_executor` 把阻塞的整段丢到线程池（对应"不在 UI 线程上跑"）。
- `Progress progress` → `render_engine.Progress`（计数 + 回调）。
- `ToolsManager` / `VoicebankFiles` / `PathManager` → 可注入的 `ClassicHost`
  （未配置时抛 `NotImplementedError`，见 `resampler_item.ClassicHost`）。
- `DocManager.Inst.Project.timeAxis.TickPosToBarBeat(...)` → 可注入宿主
  `pipeline_source.host.project`；工程缺失时退化成 `tick N`（不编造坐标）。
- `Log.Logger`（Serilog）→ 标准库 `logging.Logger`。
- `Renderers.CLASSIC` 的注册放在 `classic/__init__.py`（C# 是 `switch` 里 `new`）。
"""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional

from ..pipeline_source import host as doc_host
from ..render_engine import Progress
from ..renderer import IRenderer, RenderResult
from ..renderers import CLASSIC, apply_dynamics, get_cache_lock
from ..singer import USingerType
from ..wave import Wave
from ...ustx.format import Ustx

logger = logging.getLogger(__name__)


class ClassicRenderer(IRenderer):
    """对应 C# 的 `ClassicRenderer`。"""

    #: 对应 C# 的静态 `supportedExp`（`HashSet<string>`）
    SUPPORTED_EXP = frozenset((
        Ustx.DYN, Ustx.PITD, Ustx.CLR, Ustx.CLRY, Ustx.XSY, Ustx.ENG, Ustx.VEL,
        Ustx.VOL, Ustx.ATK, Ustx.DEC, Ustx.MOD, Ustx.MODP, Ustx.ALT, Ustx.DIR, Ustx.SHFT,
    ))

    def __init__(self, num_render_threads: Optional[int] = None,
                 classic_host=None):
        """`num_render_threads` 对应 `Preferences.Default.NumRenderThreads`（默认 2）。

        `classic_host` 是**可注入的落点**（C# 走三个全局单例）：只有外部
        wavtool 那条路会用到它（`get_wavtool` / `cache_path` / `CopySourceTemp`）；
        自包含的 `RenderInternal` 完全不碰它，所以离线跑自包含路径时
        `classic_host` 可以是 `None`。

        ★ 不给 `classic_host` 时**跟随 `resampler_item.host`**（同一个模块级替身）
        —— C# 里 `ResamplerItem` 与渲染器读的就是同一批全局单例，分成两处会让
        "换了宿主却没生效"变成隐形 bug。取用时**惰性**求值，后装的宿主也算数。
        """
        from ..singer import Preferences

        self._num_render_threads = (num_render_threads
                                    if num_render_threads is not None
                                    else Preferences.num_render_threads)
        self._injected_host = classic_host
        #: 延迟到用时再构造（对应 C# 在 `RenderInternal` 里 `new SharpWavtool(true)`）
        self._internal_wavtool = None

    @property
    def classic_host(self):
        """当前宿主：显式注入的优先，否则用 `ResamplerItem` 那个模块级替身。"""
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
        """对应 `SupportsExpression`：**有 flag 的一律支持**，其余看白名单。"""
        if descriptor is None:
            return False
        return (bool(descriptor.is_flag)
                or bool(descriptor.flag)
                or descriptor.abbr in self.SUPPORTED_EXP)

    # ------------------------------------------------------------------ 布局

    def layout(self, phrase) -> RenderResult:
        """对应 `Layout`：不合成，只给出时长/位置。"""
        return RenderResult(
            samples=None,
            leading_ms=phrase.leading_ms,
            position_ms=phrase.position_ms,
            estimated_length_ms=phrase.duration_ms + phrase.leading_ms)

    # ------------------------------------------------------------------ 渲染

    async def render(self, phrase, progress=None, track_no: int = 0, cancellation=None,
                     is_pre_render: bool = False,
                     render_events=None) -> RenderResult:
        """对应 `Render`：按 `phrase.wavtool` 名分派到 internal / external。"""
        from .sharp_wavtool import SharpWavtool

        if phrase.wavtool in (SharpWavtool.NAME_CONVERGENCE, SharpWavtool.NAME_SIMPLE):
            return await self._render_internal(phrase, progress, track_no, cancellation)

        return await self._render_external(phrase, progress, track_no, cancellation)

    async def _render_internal(self, phrase, progress: Optional[Progress],
                               track_no: int, cancellation) -> RenderResult:
        """对应 `RenderInternal`：自带 wavtool 那条路（**唯一不需要外部程序**的）。"""
        from .resampler_item import ResamplerItem
        from .worldline_resampler import WorldlineResampler

        items = [ResamplerItem(phrase, phone) for phone in phrase.phones]
        classic_host = self.classic_host

        def work() -> RenderResult:
            def resample_one(item) -> None:
                if not _cancelled(cancellation) and not os.path.isfile(item.output_file):
                    # 自带 Worldline 直接读原音 → 不需要解码到临时文件
                    is_worldline = isinstance(item.resampler, WorldlineResampler)
                    if not is_worldline:
                        classic_host.copy_source_temp(item.input_file, item.input_temp)
                    if not item.phone.direct:
                        with get_cache_lock(item.output_file):
                            item.resampler.do_resampler_returns_file(item, logger)
                        if not os.path.isfile(item.output_file):
                            raise OSError(
                                '%s failed to resample "%s" at %s'
                                % (item.resampler, item.phone.phoneme,
                                   _bar_beat(item.phrase.position + item.phone.position)))
                    if not is_worldline:
                        classic_host.copy_back_meta_files(item.input_file, item.input_temp)
                # ★ 在 if 之外：取消/缓存命中也照样上报一步
                _complete(progress, 1, 'Track %d: %s "%s"'
                          % (track_no + 1, item.resampler, item.phone.phoneme))

            _run_parallel(resample_one, items, self._num_render_threads)

            result = self.layout(phrase)
            result.samples = self._get_internal_wavtool().concatenate(
                items, '', cancellation)
            if result.samples is not None:
                apply_dynamics(phrase, result)
            return result

        return await _to_thread(work)

    async def _render_external(self, phrase, progress: Optional[Progress],
                               track_no: int, cancellation) -> RenderResult:
        """对应 `RenderExternal`：外部 wavtool 那条路（按 `phrase.hash` 缓存整条乐句）。"""
        from .resampler_item import ResamplerItem

        items = [ResamplerItem(phrase, phone) for phone in phrase.phones]
        classic_host = self.classic_host

        def work() -> RenderResult:
            info = 'Track %d : %s "%s"' % (
                track_no + 1, phrase.wavtool, ' '.join(p.phoneme for p in phrase.phones))
            _complete(progress, 0, info)
            wav_path = os.path.join(classic_host.cache_path,
                                    'cat-%016x.wav' % phrase.hash)
            phrase.add_cache_file(wav_path)
            result = self.layout(phrase)
            if os.path.isfile(wav_path):
                try:
                    result.samples = Wave.get_samples(wav_path)
                except Exception:
                    logger.exception('Failed to render: failed to open %s', wav_path)
            if result.samples is None:
                for item in items:
                    classic_host.copy_source_temp(item.input_file, item.input_temp)
                wavtool = classic_host.get_wavtool(phrase.wavtool)
                result.samples = wavtool.concatenate(items, wav_path, cancellation)
                for item in items:
                    classic_host.copy_back_meta_files(item.input_file, item.input_temp)
            _complete(progress, len(phrase.phones), info)
            if result.samples is not None:
                apply_dynamics(phrase, result)
            return result

        return await _to_thread(work)

    def _get_internal_wavtool(self):
        if self._internal_wavtool is None:
            from .sharp_wavtool import SharpWavtool
            # ★ 写死 true（convergence）—— 对应 C# 的 `new SharpWavtool(true)`
            self._internal_wavtool = SharpWavtool(True)
        return self._internal_wavtool

    # ------------------------------------------------------------------ 其它

    def load_rendered_pitch(self, phrase, selected_note_positions=None):
        """对应 `LoadRenderedPitch`：Classic 线不产出音高曲线，返回 null。"""
        return None

    def get_suggested_expressions(self, singer, render_settings) -> List:
        """对应 `GetSuggestedExpressions`：直接交出 resampler 清单里的表达式。

        ★ 两个 null 都要兜：`render_settings` 为 None、以及
        `Resampler` / `Manifest` 为 None（对应 C# 的 `manifest == null`）。
        """
        resampler = getattr(render_settings, 'resampler_obj', None)
        manifest = getattr(resampler, 'manifest', None) if resampler is not None else None
        if manifest is None:
            return []
        return list(manifest.expressions.values())

    def __str__(self):
        # 对应 `ToString() => Renderers.CLASSIC`
        return CLASSIC


# ---------------------------------------------------------------- 内部工具


def _cancelled(cancellation) -> bool:
    """C# 的 `cancellation.IsCancellationRequested`；`None` 表示不取消。"""
    return cancellation is not None and cancellation.is_set()


def _complete(progress, n: int, info: str) -> None:
    if progress is not None:
        progress.complete(n, info)


def _bar_beat(tick: int) -> str:
    """把 tick 换算成 `bar:beat.ticks`（对应 C# 的 `TickPosToBarBeat` + 格式化）。

    ★ 工程缺失时**不编造坐标**：C# 那里会 NRE，这里退化成 `tick N`。
    """
    project = doc_host.project
    if project is None:
        return 'tick %d' % tick
    bar, beat, remaining = project.time_axis.tick_pos_to_bar_beat(tick)
    return '%d:%d.%03d' % (bar, beat, remaining)


def _run_parallel(fn, items, max_workers: int) -> None:
    """对应 `Parallel.ForEach(... MaxDegreeOfParallelism ...)`。

    按**提交顺序**取回结果，把第一个异常原样抛出 —— C# 会包一层
    `AggregateException`、顺序不确定；这里失败语义相同但更可预期。
    """
    if len(items) == 0:
        return
    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
        futures = [pool.submit(fn, item) for item in items]
        first_error = None
        for future in futures:
            try:
                future.result()
            except BaseException as e:      # noqa: BLE001 —— 逐个取回，保留第一个
                if first_error is None:
                    first_error = e
        if first_error is not None:
            raise first_error


async def _to_thread(fn):
    """对应 `Task.Run(action)`：把整段阻塞工作丢到线程池，别卡住调用方的事件循环。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, fn)


def register_classic_renderer() -> None:
    """把 `ClassicRenderer` 登记进渲染器注册表（C# 是 `CreateRenderer` 里的 `new`）。

    单独开一个函数是为了**可重复调用**：测试里 `reset_registry()` 会清空注册表，
    之后需要有办法重新登记，而不是依赖"import 副作用只发生一次"。
    """
    from ..renderers import register_renderer

    register_renderer(CLASSIC, ClassicRenderer)

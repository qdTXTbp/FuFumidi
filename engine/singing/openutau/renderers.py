# -*- coding: utf-8 -*-
"""渲染器注册表与共享后处理 —— **照搬** `OpenUtau.Core/Render/Renderers.cs`（141 行）。

为什么先搬它：`ClassicRenderer` 与 `WorldlineRenderer` 都要用它——
常量表（`CLASSIC` / `WORLDLINE-R*`）、`GetCacheLock`（按输出文件串行化）、
以及**唯一一段纯信号处理** `ApplyDynamics`（把乐句的动态曲线乘到样本上）。
把这一层先钉住，两条渲染器主线就只剩"造样本"这一件事。

## 照搬时保留的语义（别"整理"掉）
- `GetSupportedRenderers` 的 switch **没有 fallthrough**：只按**精确值**匹配
  `USingerType`。注意 `USingerType.DiffSinger = 0x5` 同时含 `Classic(0x1)|Vogen(0x4)`，
  用"位包含"来判定会错，必须按值相等。
- `GetDefaultRenderer` 比的是字面量 `"Classic"`（**首字母大写**），而常量 `CLASSIC`
  是 `"CLASSIC"` —— 因为 `getRendererOptions()` 里给用户看的选项名就是 `"Classic"`。
  别"顺手统一大小写"，那会让这个分支永远进不去。
- `CreateRenderer` 的**分支顺序是语义**：`WORLDLINE-R2` / `WORLDLINE-R1.1` 必须排在
  那个 `StartsWith("WORLDLINE")` 的兜底**之前**，否则它们会被当成 R1。
  （`WORLDLINE_R[0:9]` 就是 `"WORLDLINE"`，C# 原文写的也是 `Substring(0, 9)`。）
- `GetOrCreate` **永不失效**（进程级缓存）：同一个 renderer 名永远拿到同一个实例。
  这一点与 `RenderPhrase.Hash()` 里的 `renderer.ToString()` 项强相关——
  换了实例哈希就会变（见 `renderer.py` 对 `__str__` 的说明）。
- `ApplyDynamics` 的采样率写死 **44100**，与工程设置无关；并且**末尾一格用自身值**
  （`b = (i+1)==len ? dynamics[i] : dynamics[i+1]`），不做外推。

## 与 C# 的等价性差异
- C# 在 `CreateRenderer` 里直接 `new` 具体类。这里改成**注册表**：具体渲染器
  （Classic / Worldline / Enunu / Vogen / DiffSinger / Voicevox）尚未照搬，
  未注册时返回 `None`（C# 对未知名同样返回 null）。等各渲染器搬进来，
  在它自己的模块里 `register_renderer(CLASSIC, factory)` 即可，
  这样 `renderers.py` 不必反向依赖它们（避免循环导入，也让这个包可独立单测）。
- `ToolsManager` 相关的两个方法（`GetSupportedResamplers` / `GetSupportedWavtools`）
  依赖外部工具管理器，未搬 —— 等 Classic 线的工具层补齐时一并加。
"""

import threading
from typing import Any, Callable, Dict, List, Optional

# ---------------------------------------------------------------- 常量（对应 C# 的 const）
CLASSIC = 'CLASSIC'
WORLDLINE_R = 'WORLDLINE-R'
WORLDLINE_R2 = 'WORLDLINE-R2'
WORLDLINE_R11 = 'WORLDLINE-R1.1'
ENUNU = 'ENUNU'
VOGEN = 'VOGEN'
DIFFSINGER = 'DIFFSINGER'
VOICEVOX = 'VOICEVOX'

#: 对应 C# 的 `classicRenderers` 等四个静态数组 + `noRenderers`
CLASSIC_RENDERERS = (WORLDLINE_R, WORLDLINE_R11, CLASSIC)
ENUNU_RENDERERS = (ENUNU,)
VOGEN_RENDERERS = (VOGEN,)
DIFFSINGER_RENDERERS = (DIFFSINGER,)
VOICEVOX_RENDERERS = (VOICEVOX,)
NO_RENDERERS: tuple = ()

#: C# 里 `WORLDLINE_R.Substring(0, 9)` —— 任何以它开头的 id 都落到 R1
_WORLDLINE_PREFIX = WORLDLINE_R[:9]

#: 采样率：`ApplyDynamics` 里写死的 44100（与工程设置无关）
SAMPLE_RATE = 44100

#: 动态曲线的采样间隔（tick），与 `PITCH_INTERVAL` 同为 5
DYNAMICS_INTERVAL = 5

#: `getRendererOptions()` 返回的字面量（注意 `"Classic"` 的大小写）
RENDERER_OPTIONS = ('WORLDLINE-R', 'Classic')


# ---------------------------------------------------------------- 具体渲染器注册表

_FACTORIES: Dict[str, Callable[..., Any]] = {}
_RENDERER_CACHE: Dict[str, Any] = {}
_CACHE_LOCKS: Dict[str, threading.Lock] = {}
_REGISTRY_LOCK = threading.Lock()


def register_renderer(renderer_id: str, factory: Callable[..., Any]) -> None:
    """登记某个渲染器 id 的构造器（对应 C# 里 `CreateRenderer` 的 `new XxxRenderer()`）。

    `factory` 会以 `factory(**kwargs)` 调用；Worldline 系列需要 `version=` 参数，
    所以构造器要接受它（R1 → version=10，R1.1 → 11，R2 → 20）。
    """
    _FACTORIES[renderer_id] = factory


def registered_renderers() -> List[str]:
    """已登记的渲染器 id（供测试与自检）。"""
    return sorted(_FACTORIES)


def _create(renderer_id: str, **kwargs) -> Optional[Any]:
    factory = _FACTORIES.get(renderer_id)
    return factory(**kwargs) if factory is not None else None


# ---------------------------------------------------------------- 查询


def get_supported_renderers(singer_type) -> tuple:
    """对应 C# `GetSupportedRenderers`：按 `USingerType` 的**精确值**取列表。

    未知类型返回**同一个**空元组（C# 也是返回共享的 `noRenderers`）。
    """
    if singer_type == 0x1:      # USingerType.Classic
        return CLASSIC_RENDERERS
    if singer_type == 0x2:      # USingerType.Enunu
        return ENUNU_RENDERERS
    if singer_type == 0x4:      # USingerType.Vogen
        return VOGEN_RENDERERS
    if singer_type == 0x5:      # USingerType.DiffSinger（注意 == Classic|Vogen，不能按位判）
        return DIFFSINGER_RENDERERS
    if singer_type == 0x6:      # USingerType.Voicevox
        return VOICEVOX_RENDERERS
    return NO_RENDERERS


def get_supported_resamplers(wavtool=None) -> list:
    """对应 C# `GetSupportedResamplers(IWavtool? wavtool)`。

    ★ 判据是 **wavtool 的类型**，不是它的名字：
      wavtool 是 `SharpWavtool`（内置拼接器）→ 全部 resampler 都可用；
      否则（外部 wavtool / ExeWavtool / UnixWavtool）→ **排除 WorldlineResampler**。

    原因见上游注释：外部 wavtool 只能从 bat / 脚本里调起变调器，
    而 Worldline 是原生库、从脚本里调不起来（与 `ExeWavtool` 里那段逻辑呼应）。
    """
    from .classic.sharp_wavtool import SharpWavtool
    from .classic.tools_manager import get_tools_manager
    resamplers = get_tools_manager().resamplers
    if isinstance(wavtool, SharpWavtool):
        return list(resamplers)
    from .classic.worldline_resampler import WorldlineResampler
    return [r for r in resamplers if not isinstance(r, WorldlineResampler)]


def get_supported_wavtools(resampler=None) -> list:
    """对应 C# `GetSupportedWavtools(IResampler? resampler)`。

    ★ 上游**忽略** `resampler` 参数、无条件返回全部 wavtool（形参只是为了对称）。
      照搬这个"看起来奇怪但确实是上游行为"的写法。
    """
    from .classic.tools_manager import get_tools_manager
    return get_tools_manager().wavtools


def get_renderer_options() -> List[str]:
    """对应 C# `getRendererOptions()`：给用户看的选项名，每次返回**新列表**。"""
    return list(RENDERER_OPTIONS)


def get_default_renderer(singer_type, preferences=None) -> str:
    """对应 C# `GetDefaultRenderer`。

    ⚠ 比的是 `"Classic"`（首字母大写），与常量 `CLASSIC="CLASSIC"` 不是同一个串 ——
    这是 C# 原文，因为选项名来自 `getRendererOptions()`。别统一大小写。
    """
    prefs = preferences
    default_renderer = getattr(prefs, 'default_renderer', '') if prefs is not None else ''
    if default_renderer == 'Classic' and singer_type == 0x1:   # USingerType.Classic
        return CLASSIC
    return get_supported_renderers(singer_type)[0]


def get_expression_graph_slot(renderer: str) -> str:
    """对应 C# `GetExpressionGraphSlot`：取渲染器的表达式图槽位，取不到就用 id 自己。"""
    r = get_or_create(renderer)
    slot = getattr(r, 'expression_graph_slot', None) if r is not None else None
    return slot if slot is not None else renderer


def create_renderer(renderer: Optional[str]) -> Optional[Any]:
    """对应 C# `CreateRenderer`。**分支顺序即语义**（见模块 docstring）。"""
    if renderer == CLASSIC:
        return _create(CLASSIC)
    if renderer == WORLDLINE_R2:
        return _create(WORLDLINE_R2, version=20)
    if renderer == WORLDLINE_R11:
        # 必须在前缀兜底之前 —— 否则 R1.1 会被当成 R1
        return _create(WORLDLINE_R11, version=11)
    if renderer is not None and renderer.startswith(_WORLDLINE_PREFIX):
        return _create(WORLDLINE_R, version=10)
    if renderer in (ENUNU, VOGEN, DIFFSINGER, VOICEVOX):
        return _create(renderer)
    return None


def get_or_create(renderer: Optional[str]) -> Optional[Any]:
    """对应 C# `GetOrCreate`：进程级缓存，同一 id 永远同一个实例（**永不失效**）。"""
    key = renderer if renderer is not None else ''
    with _REGISTRY_LOCK:
        if key not in _RENDERER_CACHE:
            _RENDERER_CACHE[key] = create_renderer(renderer)
        return _RENDERER_CACHE[key]


def reset_registry() -> None:
    """清空注册表与实例缓存（**仅供测试**；C# 无对应物）。"""
    with _REGISTRY_LOCK:
        _FACTORIES.clear()
        _RENDERER_CACHE.clear()
        _CACHE_LOCKS.clear()


def get_cache_lock(key: str) -> threading.Lock:
    """对应 C# `GetCacheLock`：按 key 取一把共享锁，用于串行化同一输出文件的读写。

    ★ **必须是可重入锁（`RLock`）**。C# 的 `GetCacheLock` 返回的是 `object`，
    调用方一律配 `lock (obj)` —— 也就是 `Monitor`，**同一线程可重复进入**。
    而嵌套是真的会发生的：`ClassicRenderer.RenderInternal` 先按 `item.outputFile`
    加锁，再调 `IResampler.DoResamplerReturnsFile`；`WorldlineResampler` 的
    实现里**又加了一次同一把锁**（C# 原文如此，见 `WorldlineResampler.cs`）。
    用非重入的 `threading.Lock` 会在这里**自锁死**（线程等自己持有的锁）。
    """
    with _REGISTRY_LOCK:
        lock = _CACHE_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _CACHE_LOCKS[key] = lock
        return lock


# ---------------------------------------------------------------- 后处理


def apply_dynamics(phrase, result) -> None:
    """对应 C# `ApplyDynamics`：把 `phrase.dynamics` 线性插值后**就地**乘到样本上。

    ★ 三个容易搬错的地方：
    1. 采样率写死 44100，不读工程设置；
    2. `endSample` 用 **int 截断**再夹到 `samples` 长度；
    3. 最后一格的 `b` 取**自身**（不外推），即最后一段是常数增益。
    另外 `dynamics is None` 时**直接返回**（不是乘 1）。
    """
    dynamics = getattr(phrase, 'dynamics', None)
    if dynamics is None:
        return
    samples = result.samples
    if samples is None:
        return

    start_tick = phrase.position - phrase.leading
    start_ms = result.position_ms - result.leading_ms
    start_sample = 0
    for i in range(len(dynamics)):
        end_tick = start_tick + DYNAMICS_INTERVAL
        end_ms = phrase.time_axis.tick_pos_to_ms_pos(end_tick)
        end_sample = min(int((end_ms - start_ms) / 1000 * SAMPLE_RATE), len(samples))
        a = dynamics[i]
        b = dynamics[i] if (i + 1) == len(dynamics) else dynamics[i + 1]
        span = end_sample - start_sample
        for j in range(start_sample, end_sample):
            samples[j] = samples[j] * (a + (b - a) * (j - start_sample) / span)
        start_tick = end_tick
        start_sample = end_sample

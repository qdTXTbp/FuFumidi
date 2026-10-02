# -*- coding: utf-8 -*-
"""`OpenUtau.Classic` 命名空间 —— **照搬** `OpenUtau.Core/Classic/`。

为什么单独开一个子包：C# 那边 Classic 线有 30 来个文件（原音、resampler/wavtool 的
外部进程封装、工具管理器、预设、Flags…），平铺进 `openutau/` 会让目录失去结构。
这里按 C# 的**文件夹边界**划子包，一眼能对上。

已照搬：
  - `resampler_item.py`        单音素的 resampler 调用参数与缓存键（Classic/ResamplerItem.cs）
  - `i_resampler.py`           变调器接口（Classic/IResampler.cs）
  - `i_wavtool.py`             拼接器接口（Classic/IWavtool.cs）
  - `resampler_manifest.py`    resampler 自描述清单（Classic/ResamplerManifest.cs）
  - `sharp_wavtool.py`         内置 wavtool（Classic/SharpWavtool.cs）
  - `nwaves_filter.py`         NWaves 的 IirPeak / ZiFilter.ZeroPhase 转写（**第三方库替换**）
  - `frq.py`                   `.frq` / `.mrq` 基频缓存与 `OtoFrq`（Classic/Frq.cs）
  - `worldline_resampler.py`   自带的变调器（Classic/WorldlineResampler.cs）
  - `classic_renderer.py`      把变调器与拼接器串成一条乐句（Classic/ClassicRenderer.cs）
  - `oto_watcher.py`           `oto.ini` 变更监视（Classic/OtoWatcher.cs；后端可注入）
  - `classic_singer.py`        UTAU 声库歌手（Classic/ClassicSinger.cs）
  - `classic_singer_loader.py` 声库发现（Classic/ClassicSingerLoader.cs；工厂可注册）
  - `ini.py`                   INI 分块读取（Classic/Ini.cs）
  - `voicebank_config.py`      `character.yaml` 的配置模型（Classic/VoicebankConfig.cs）
  - `voicebank_loader.py`      声库加载：character.txt / character.yaml / oto.ini /
                               prefix.map（Classic/VoicebankLoader.cs）

未照搬（后续）：
  - `ExeResampler` / `ExeWavtool` / `UnixWavtool` / `ToolsManager` / `VoicebankFiles`
    （外部工具进程那一整片；还需要 `Util/Base64.cs`、`Util/ProcessRunner.cs`、`OS.cs`）
  - `WorldlineRenderer`（Worldline 线 R1.1/R2；依赖 `Worldline.PhraseSynthV2`）
  - `Presamp`(731) / `Ust` / `UstNote` / `PluginLoader` / `VoicebankErrorChecker`
  - `EnunuSinger` / `DiffSingerSinger` / `VoicevoxSinger`（`ClassicSingerLoader` 里
    留了 `register_singer_factory` 注册点，未注册时回落到 `ClassicSinger`）
"""

from .classic_renderer import ClassicRenderer, register_classic_renderer  # noqa: F401
from .frq import IFrqFiles, Frq, Mrq, OtoFrq  # noqa: F401
from .i_resampler import IResampler  # noqa: F401
from .i_wavtool import IWavtool  # noqa: F401
from .classic_singer import OTO_DATA_EMPTY, ClassicSinger, OtoData  # noqa: F401
from .classic_singer_loader import (  # noqa: F401
    adjust_singer_type,
    find_all_singers,
    register_singer_factory,
    registered_singer_types,
    reset_singer_factories,
)
from .oto_watcher import OtoWatcher, ReloadScheduler  # noqa: F401
from .resampler_item import ClassicHost, ResamplerItem  # noqa: F401
from .resampler_manifest import ResamplerManifest  # noqa: F401
from .sharp_wavtool import SharpWavtool  # noqa: F401
from .voicebank_config import (  # noqa: F401
    SingerTypeValues,
    SymbolSet,
    SymbolSetPreset,
    VoicebankConfig,
)
from .voicebank_loader import FileTrace, VoicebankLoader  # noqa: F401
from .worldline_resampler import WorldlineResampler  # noqa: F401

# 让 `Renderers.CreateRenderer(CLASSIC)` 拿得到实例（C# 是 switch 里 `new`）
register_classic_renderer()

__all__ = [
    'ClassicSinger', 'OtoData', 'OTO_DATA_EMPTY', 'OtoWatcher', 'ReloadScheduler',
    'adjust_singer_type', 'find_all_singers', 'register_singer_factory',
    'registered_singer_types', 'reset_singer_factories',
    'IResampler', 'IWavtool', 'ResamplerItem', 'ClassicHost', 'ResamplerManifest',
    'SharpWavtool', 'WorldlineResampler', 'ClassicRenderer',
    'register_classic_renderer',
    'IFrqFiles', 'Frq', 'Mrq', 'OtoFrq',
    'VoicebankConfig', 'SymbolSet', 'SymbolSetPreset', 'SingerTypeValues',
    'VoicebankLoader', 'FileTrace',
]

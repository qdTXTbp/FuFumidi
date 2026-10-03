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
  - `worldline_renderer.py`    Worldline 渲染器 v10/v11/v20（Classic/WorldlineRenderer.cs）
  - `oto_watcher.py`           `oto.ini` 变更监视（Classic/OtoWatcher.cs；后端可注入）
  - `yaml_watcher.py`          `.yaml` 变更监视（Classic/YamlWatcher.cs；后端可注入）
  - `classic_singer.py`        UTAU 声库歌手（Classic/ClassicSinger.cs）
  - `classic_singer_loader.py` 声库发现（Classic/ClassicSingerLoader.cs；工厂可注册）
  - `ini.py`                   INI 分块读取（Classic/Ini.cs）
  - `voicebank_config.py`      `character.yaml` 的配置模型（Classic/VoicebankConfig.cs）
  - `voicebank_loader.py`      声库加载：character.txt / character.yaml / oto.ini /
                               prefix.map（Classic/VoicebankLoader.cs）
  - `ust_note.py`             .ust 单个音符块读写（Classic/UstNote.cs）
  - `ust.py`                  .ust 工程读写与插件 diff（Classic/Ust.cs）
  - `plugin.py`               UTAU 旧插件体系（IPlugin/Plugin/PluginLoader/PluginRunner/ExeInstaller）
  - `voicebank_error_checker.py` 声库体检（Classic/VoicebankErrorChecker.cs）
  - `presamp.py`              presamp.ini 解析（Classic/Presamp.cs；数据表在 _presamp_data.py，由 _gen_presamp_data.py 生成）
  - `ust_flag.py`             UST flag 解析（Classic/Flags/UstFlag.cs + UstFlagParser.cs；.ust 导入的前置）
  - `exe_resampler.py`         外部 resampler（Classic/ExeResampler.cs）
  - `unix_wavtool.py`          Unix 外部 wavtool（Classic/UnixWavtool.cs）
  - `exe_wavtool.py`           Windows 外部 wavtool（Classic/ExeWavtool.cs；生成 bat）
  - `tools_manager.py`         工具管理器：内置 Worldline + SharpWavtool 与外部工具扫描
                               （Classic/ToolsManager.cs）
  - `voicebank_files.py`       声库源文件的临时缓存与元文件搬运（Classic/VoicebankFiles.cs）

未照搬（后续）：
  - `PresampWatcher`(44)
  - `Plugin` / `IPlugin` / `PluginLoader` / `PluginRunner` / `ExeInstaller`
  - `VoicebankInstaller` / `VoicebankPublisher` / `VoicebankErrorChecker`
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
from .worldline_renderer import (  # noqa: F401
    HOP_SIZES,
    WorldlineRenderer,
    hop_size_for_version,
    register_worldline_renderers,
)
from .worldline_resampler import WorldlineResampler  # noqa: F401

from .exe_resampler import ExeResampler  # noqa: F401
from .ust_flag import SINGLE_CHARACTER_FLAGS, UstFlag, UstFlagParser  # noqa: F401
from .ust_note import FileFormatError, UstNote, parse_float  # noqa: F401
from . import ust  # noqa: F401
from .presamp import (Presamp, PresampAliasRules, PresampConsonant,  # noqa: F401
                      PresampPhoneme, PresampVowel)
from .voicebank_error_checker import (VoicebankError,  # noqa: F401
                                    VoicebankErrorChecker)
from .plugin import (ExeInstaller, IPlugin, Plugin, PluginErrorEventArgs,  # noqa: F401
                     PluginLoader, PluginRunner, ReplaceNoteEventArgs)
from .exe_wavtool import ExeWavtool  # noqa: F401
from .tools_manager import (  # noqa: F401
    ToolsManager,
    get_tools_manager,
    set_tools_manager,
)
from .unix_wavtool import UnixWavtool  # noqa: F401
from .voicebank_files import (  # noqa: F401
    VoicebankFiles,
    get_voicebank_files,
    set_voicebank_files,
)

# 让 `Renderers.CreateRenderer(...)` 拿得到实例（C# 是 switch 里 `new`）
register_classic_renderer()
register_worldline_renderers()

__all__ = [
    'ClassicSinger', 'OtoData', 'OTO_DATA_EMPTY', 'OtoWatcher', 'ReloadScheduler',
    'adjust_singer_type', 'find_all_singers', 'register_singer_factory',
    'registered_singer_types', 'reset_singer_factories',
    'IResampler', 'IWavtool', 'ResamplerItem', 'ClassicHost', 'ResamplerManifest',
    'SharpWavtool', 'WorldlineResampler', 'ClassicRenderer',
    'register_classic_renderer',
    'WorldlineRenderer', 'register_worldline_renderers', 'HOP_SIZES', 'hop_size_for_version',
    'IFrqFiles', 'Frq', 'Mrq', 'OtoFrq',
    'VoicebankConfig', 'SymbolSet', 'SymbolSetPreset', 'SingerTypeValues',
    'VoicebankLoader', 'FileTrace',
    'ExeResampler', 'UnixWavtool', 'ExeWavtool',
    'UstFlag', 'UstFlagParser', 'SINGLE_CHARACTER_FLAGS',
    'UstNote', 'FileFormatError', 'parse_float',
    'ToolsManager', 'get_tools_manager', 'set_tools_manager',
    'VoicebankFiles', 'get_voicebank_files', 'set_voicebank_files',
]

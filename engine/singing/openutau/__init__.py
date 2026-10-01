# -*- coding: utf-8 -*-
"""OpenUTAU 引擎侧的**照搬移植**（Python 转写）。

方针（用户 2026-10-01）：**除外观外不允许自研**。所以这个包里的每一处都应能回答
「对应 OpenUTAU 的哪个文件/函数」，且语义逐一对齐 —— 包括默认值、边界处理、
方法时序。转写处都在 docstring 里注明了出处。

与 `singing/api.py`（M1 时我们自己设计的 Renderer/Phonemizer 抽象）的关系：
**以本包为准**。M1 那层是"先立接口再适配"的过渡产物；后续会把 M1 的适配器
改成实现本包的接口，最终退役 `api.py` 里的自有设计。

已照搬：
  - `ustx/`               工程格式（.ustx 读写）
  - `openutau/timeaxis.py`    tick↔ms 换算轴（TimeAxis.cs）
  - `openutau/phonemizer.py`  音素化器基类（Api/Phonemizer.cs）
  - `openutau/renderer.py`    渲染器接口（Render/IRenderer.cs）
  - `openutau/music_math.py`  音乐/时间换算（Util/MusicMath.cs）
  - `openutau/spline.py`      三次样条（Util/SplineInterpolate.cs）
  - `openutau/phrase_layout.py` 乐句时域排布（Render/PhraseLayout.cs）
  - `openutau/xxhash.py`      XXH32/XXH64（K4os.Hash.xxHash.XXH32/XXH64）
  - `openutau/binary_writer.py`  `System.IO.BinaryWriter` 的字节布局复刻（缓存键用）
  - `openutau/classic/`        `OpenUtau.Classic` 命名空间（ResamplerItem 等）
  - `openutau/plugin_builtin/` `OpenUtau.Plugin.Builtin` 内置音素化器（JA VCV 已搬）
  - `openutau/pipeline_source.py` 渲染输入契约（Pipeline/PhraseSource.cs）
  - `openutau/render_phrase.py`   RenderNote/RenderPhone/RenderPhrase（Render/RenderPhrase.cs）
  - `openutau/oto.py`         原音模型（Ustx/USinger.cs 的 UOto + Classic/VoiceBank.cs）
  - `openutau/singer.py`      USinger 基类（Ustx/USinger.cs）
  - `openutau/phoneme.py`     UPhoneme（Ustx/UPhoneme.cs）
  - `openutau/renderers.py`   渲染器注册表 + ApplyDynamics（Render/Renderers.cs）

未照搬（后续）：
  - `Classic/ClassicRenderer.cs`、`Classic/WorldlineRenderer.cs`、`Render/Worldline.cs`（M2-a 主体）
  - `Classic/ClassicSinger.cs` / `Ustx/UOtoFrq.cs`（MOD+ 与 .frq 依赖）
  - `Pipeline/PhraseBuilder.cs` / `PhraseSource.FromPart`（乐句切分）
  - `ExpressionGraph/*`（表达式图；`RenderPhrase` 里对应的分支恒跳过）
  - `OpenUtau.Plugin.Builtin/*Phonemizer.cs` 的具体实现（M2-b 主体）
"""

from .format import Ustx  # noqa: F401
from .music_math import (  # noqa: F401
    KEYS_IN_OCTAVE,
    NAME_IN_OCTAVE,
    NUMBERED_NOTATIONS,
    SOLFEGES,
    ZOOM_RATIOS,
    MusicMath,
    fdiv,
    idiv,
)
from .oto import (  # noqa: F401
    Oto,
    OtoSet,
    Subbank,
    UOto,
    UOtoSet,
    USubbank,
)
from .phrase_layout import PhraseLayout  # noqa: F401
from .phonemizer import (  # noqa: F401
    Note,
    Phoneme,
    PhonemeAttributes,
    PhonemeExpression,
    Phonemizer,
    Result,
    register,
    registered,
)
from .phoneme import UPhoneme, ValidateOptions  # noqa: F401
from .pipeline_source import (  # noqa: F401
    CurveSource,
    NoteSource,
    PhonemeSource,
    PhraseSource,
    VibratoSource,
)
from .render_phrase import (  # noqa: F401
    PITCH_INTERVAL,
    RenderNote,
    RenderPhone,
    RenderPhrase,
)
from .renderers import (  # noqa: F401
    CLASSIC,
    CLASSIC_RENDERERS,
    DIFFSINGER,
    DIFFSINGER_RENDERERS,
    ENUNU,
    ENUNU_RENDERERS,
    NO_RENDERERS,
    RENDERER_OPTIONS,
    SAMPLE_RATE,
    VOICEVOX,
    VOICEVOX_RENDERERS,
    VOGEN,
    VOGEN_RENDERERS,
    WORLDLINE_R,
    WORLDLINE_R2,
    WORLDLINE_R11,
    apply_dynamics,
    create_renderer,
    get_cache_lock,
    get_default_renderer,
    get_expression_graph_slot,
    get_or_create,
    get_renderer_options,
    get_supported_renderers,
    register_renderer,
    registered_renderers,
    reset_registry,
)
from .renderer import (  # noqa: F401
    IRenderer,
    RenderPhraseEvents,
    RenderPitchResult,
    RenderRealCurveResult,
    RenderResult,
)
from .singer import (  # noqa: F401
    SINGER_TYPE_FROM_NAME,
    SINGER_TYPE_NAMES,
    USinger,
    USingerType,
    Preferences,
)
from .spline import CubicSplineSegment  # noqa: F401
from .base_chinese import BaseChinesePhonemizer  # noqa: F401
from .timeaxis import TimeAxis  # noqa: F401
from .worldline import (  # noqa: F401
    FLOOR_F0,
    RESAMPLER_FFT_SIZE,
    RESAMPLER_FS,
    RESAMPLER_HOP_SIZE,
    RESAMPLER_PADDING,
    RESAMPLER_VOICED_F0,
    AnalysisConfig,
    CutOffBeforeOffsetError,
    CutOffExceedDurationError,
    SynthRequestError,
    WorldlineNative,
    apply_pitch_bend,
    blend_continuous_noise_features,
    blend_features,
    compute_frame_bounds,
    compute_timemap,
    f0_frame_count,
    fit_curve,
    get_flag,
    get_native,
    init_analysis_config,
    resample_auto_gain,
    resample_features,
    segment_auto_gain,
    world_synthesis_sample_count,
)
from .xxhash import digest_of32, digest_of64, xxh32, xxh64  # noqa: F401

# 导入内置音素化器即完成注册（对应 C# 的 [Phonemizer(...)] 在程序集加载时注册）。
# 放在最后：它们依赖上面的基类与注册表。
from . import plugin_builtin  # noqa: E402,F401

__all__ = [
    'Ustx',
    'TimeAxis',
    'MusicMath', 'NAME_IN_OCTAVE', 'KEYS_IN_OCTAVE', 'SOLFEGES', 'NUMBERED_NOTATIONS',
    'ZOOM_RATIOS', 'fdiv', 'idiv',
    'UOto', 'UOtoSet', 'USubbank', 'Oto', 'OtoSet', 'Subbank',
    'Phonemizer', 'Note', 'Phoneme', 'PhonemeAttributes', 'PhonemeExpression', 'Result',
    'register', 'registered',
    'UPhoneme', 'ValidateOptions',
    'IRenderer', 'RenderResult', 'RenderPitchResult', 'RenderRealCurveResult',
    'RenderPhraseEvents',
    'USinger', 'USingerType', 'SINGER_TYPE_NAMES', 'SINGER_TYPE_FROM_NAME', 'Preferences',
    'xxh32', 'xxh64', 'digest_of32', 'digest_of64',
    'BaseChinesePhonemizer',
    'AnalysisConfig', 'SynthRequestError', 'CutOffExceedDurationError', 'CutOffBeforeOffsetError',
    'WorldlineNative', 'RESAMPLER_PADDING', 'RESAMPLER_VOICED_F0', 'FLOOR_F0',
    'RESAMPLER_FS', 'RESAMPLER_HOP_SIZE', 'RESAMPLER_FFT_SIZE',
    'init_analysis_config', 'get_native', 'f0_frame_count', 'world_synthesis_sample_count',
    'get_flag', 'fit_curve', 'compute_frame_bounds', 'compute_timemap', 'resample_features',
    'apply_pitch_bend', 'resample_auto_gain', 'segment_auto_gain',
    'blend_features', 'blend_continuous_noise_features',
    'CubicSplineSegment', 'PhraseLayout',
    'VibratoSource', 'CurveSource', 'NoteSource', 'PhonemeSource', 'PhraseSource',
    'RenderNote', 'RenderPhone', 'RenderPhrase', 'PITCH_INTERVAL',
    'CLASSIC', 'WORLDLINE_R', 'WORLDLINE_R2', 'WORLDLINE_R11', 'ENUNU', 'VOGEN',
    'DIFFSINGER', 'VOICEVOX', 'CLASSIC_RENDERERS', 'ENUNU_RENDERERS', 'VOGEN_RENDERERS',
    'DIFFSINGER_RENDERERS', 'VOICEVOX_RENDERERS', 'NO_RENDERERS', 'RENDERER_OPTIONS',
    'SAMPLE_RATE', 'apply_dynamics', 'create_renderer', 'get_cache_lock',
    'get_default_renderer', 'get_expression_graph_slot', 'get_or_create',
    'get_renderer_options', 'get_supported_renderers', 'register_renderer',
    'registered_renderers', 'reset_registry',
]

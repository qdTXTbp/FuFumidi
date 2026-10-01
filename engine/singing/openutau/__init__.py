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

未照搬（后续）：
  - `USinger` / `UPitch` 之外的 UPhoneme、RenderPhrase
  - `Classic/ClassicRenderer.cs`、`Classic/WorldlineRenderer.cs`（M2-a 主体）
  - `OpenUtau.Plugin.Builtin/*Phonemizer.cs` 的具体实现（M2-b 主体）
"""

from .format import Ustx  # noqa: F401
from .oto import (  # noqa: F401
    MusicMath,
    NAME_IN_OCTAVE,
    Oto,
    OtoSet,
    Subbank,
    UOto,
    UOtoSet,
    USubbank,
)
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
from .timeaxis import TimeAxis  # noqa: F401

__all__ = [
    'Ustx',
    'TimeAxis',
    'MusicMath', 'NAME_IN_OCTAVE', 'UOto', 'UOtoSet', 'USubbank', 'Oto', 'OtoSet', 'Subbank',
    'Phonemizer', 'Note', 'Phoneme', 'PhonemeAttributes', 'PhonemeExpression', 'Result',
    'register', 'registered',
    'IRenderer', 'RenderResult', 'RenderPitchResult', 'RenderRealCurveResult',
    'RenderPhraseEvents',
    'USinger', 'USingerType', 'SINGER_TYPE_NAMES', 'SINGER_TYPE_FROM_NAME', 'Preferences',
]

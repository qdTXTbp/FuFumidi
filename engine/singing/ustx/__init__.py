# -*- coding: utf-8 -*-
"""`.ustx` 工程格式 —— 照搬 OpenUTAU（`OpenUtau.Core/Ustx/*.cs` + `Util/Yaml.cs`）。

只做**数据模型与读写**，外观/交互不在这一层。

    from singing.ustx import UProject, UNote, UVoicePart, load_ustx, save_ustx

    p = UProject()
    part = UVoicePart(track_no=0, position=0, duration=480)
    part.notes.append(UNote(position=0, duration=480, tone=60, lyric='la'))
    p.parts = [part]
    save_ustx(p, 'demo.ustx')
    assert load_ustx('demo.ustx').parts[0].notes[0].lyric == 'la'
"""

from .io import after_load, before_save, dumps, from_plain, load_ustx, loads, save_ustx, to_plain
from .model import (  # noqa: F401
    DEFAULT_EXP_SELECTORS,
    NO_YAML,
    PitchPoint,
    PitchPointShape,
    UMixFx,
    UNote,
    UPart,
    UPhonemeOverride,
    UPitch,
    UProject,
    UCurve,
    UExpression,
    UExpressionDescriptor,
    UEnvelope,
    UExpressionType,
    UMaskedCurve,
    UMaskedRun,
    URenderSettings,
    UTimeSignature,
    UTempo,
    UTrack,
    Vector2,
    UVibrato,
    UVoicePart,
    UWavePart,
)

__all__ = [
    'UProject', 'UTrack', 'UPart', 'UVoicePart', 'UWavePart', 'URenderSettings',
    'UNote', 'UPitch', 'UVibrato', 'PitchPoint', 'PitchPointShape',
    'UExpression', 'UExpressionDescriptor', 'UExpressionType',
    'UCurve', 'UMaskedCurve', 'UMaskedRun', 'UMixFx', 'UPhonemeOverride', 'UEnvelope', 'Vector2',
    'UTempo', 'UTimeSignature', 'DEFAULT_EXP_SELECTORS', 'NO_YAML',
    'load_ustx', 'save_ustx', 'loads', 'dumps', 'to_plain', 'from_plain',
    'before_save', 'after_load',
]

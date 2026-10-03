# -*- coding: utf-8 -*-
r"""DiffSinger 引擎 —— 与上游 OpenUtau 逐项对齐的实现。

## 分层（与上游一一对应）

```
A 层 音素化   phonemizer.py   ← DiffSingerBasePhonemizer.cs   （用 dsdur/ 的时长模型）
B 层 渲染     renderer.py     ← DiffSingerRenderer.cs        （只有一条 acoustic 路径）
   方差       variance.py     ← DiffSingerVariance.cs        （可选，dsvariance/）
   音高编辑   pitch_edit.py   ← DiffSingerPitch.cs           （★ 不参与渲染）
```

★ **`dspitch/` 不参与渲染**（上游 `InvokeDiffsinger` 全程不碰音高模型）；
  `f0` 只来自用户谱面曲线 `phrase.pitches`（音分 → Hz）。

★ **A 层的 `frame_ms` 来自 `dsdur/dsconfig.yaml`，B 层的来自 `vocoder.yaml`** ——
  两者可能不同，不要混用。
"""

from .config import (  # noqa: F401
    MAX_MEL_BINS,
    DsAcousticConfig,
    DsDurConfig,
    DsVocoderConfig,
    compute_speedup,
    frame_ms_of,
    resolve_depth,
)


class RenderError(Exception):
    """面向用户的可预期失败（对应上游抛 `Exception` / `MessageCustomizableException` 的那些点）。"""


__all__ = [
    'RenderError',
    'DsDurConfig', 'DsAcousticConfig', 'DsVocoderConfig',
    'frame_ms_of', 'resolve_depth', 'compute_speedup', 'MAX_MEL_BINS',
]

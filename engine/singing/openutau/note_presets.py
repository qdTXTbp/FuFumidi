# -*- coding: utf-8 -*-
"""音符预设的默认值 —— **照搬** `OpenUtau.Core/Util/NotePresets.cs` 里
`NotePresets.Default` 那一档（只取 `UProject.CreateNote()` 与 `.ust` 导出真正用到的几项）。

上游是一个可编辑的预设集合（编辑器里能改、能存成 json），我们只保留**出厂默认值** ——
`.ust` 导入/导出的语义只依赖这些常量，用户自定义预设属于编辑器功能（不在引擎侧）。

## ★ `PortamentoPreset` 的构造器参数序是 **`(name, length, start)`**
上游：
```csharp
public PortamentoPreset(string name, int length, int start) {
    Name = name; PortamentoLength = length; PortamentoStart = start;
}
// 默认那一档：
public PortamentoPreset DefaultPortamento = new PortamentoPreset("Standard", 80, -40);
```
★ 字段默认值也是 `PortamentoLength = 80` / `PortamentoStart = -40`，与构造器一致。
所以 `UProject.CreateNote()` 的两个默认弯音点落在 **x = -40** 与 **x = 40**
（`start + length = -40 + 80`）。**别把两个参数看反** —— 看反了滑音方向就反了。
"""

from ..ustx.model import PitchPointShape, UVibrato

#: 对应 `DefaultPortamento = new PortamentoPreset("Standard", 80, -40)`
DEFAULT_PORTAMENTO_NAME = 'Standard'
#: 对应 `PortamentoPreset.PortamentoStart`（★ 注意是构造器的**第三个**参数）
DEFAULT_PORTAMENTO_START = -40
#: 对应 `PortamentoPreset.PortamentoLength`（构造器的**第二个**参数）
DEFAULT_PORTAMENTO_LENGTH = 80

#: 对应 `DefaultPitchShape = PitchPointShape.io`
DEFAULT_PITCH_SHAPE = PitchPointShape.IO

#: 对应 `DefaultVibrato = new VibratoPreset("Standard", 75, 175, 25, 10, 10, 0, 0, 0)`
#: 构造器参数序（对照上游 `VibratoPreset`）：(name, length, period, depth, in, out, shift, drift, volLink)
DEFAULT_VIBRATO = {
    'length': 75.0, 'period': 175.0, 'depth': 25.0,
    'vib_in': 10.0, 'vib_out': 10.0,
    'shift': 0.0, 'drift': 0.0, 'vol_link': 0.0,
}


def default_vibrato() -> UVibrato:
    """按出厂默认造一个 `UVibrato`。

    ★ `UVibrato.__setattr__` 会照搬 C# setter 钳制范围
      （`depth` 是 5..200，`length`/`in`/`out` 是 0..100），这里逐项赋值即可。
    """
    return UVibrato(**DEFAULT_VIBRATO)
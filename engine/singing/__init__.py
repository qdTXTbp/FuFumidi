# -*- coding: utf-8 -*-
"""singing —— 歌声合成的渲染器 / 音素化器抽象层（M1）。

## 为什么要有这一层

OpenUTAU 的可维护性来自两条主抽象：**Renderer**（乐句 → 波形）与
**Phonemizer**（歌词 → 音素）。我们原来的 `engine_utau.py` / `engine_diffsinger.py`
把「音素化 + 渲染 + 拼接」揉在各自的命令行入口里，导致：
  - 加一种引擎就要改一遍 IPC，前端也要跟着改；
  - 编辑器（钢琴卷帘/音素条带）拿不到统一的音素数据；
  - 无法像 OpenUTAU 那样「同一套编辑器 + 可插拔渲染器/音素化器」。

M1 只做**接口与适配**：把现有实现接到这两条抽象上，**行为一行不变**。
M2 起才在抽象后面替换成真正的实现（worldline → WORLD、DiffSinger 流水线拆分、
多语言 phonemizer）。

## 用法

    import sys; sys.path.insert(0, '<repo>/engine')
    from singing import get_renderer, get_phonemizer, renderer_names

    r = get_renderer('utau', voicebank_dir=r'...\\voicebank')
    res = r.render(RenderRequest(notes=[{'lyric': 'a', 'note': 'C4', 'length_ms': 500}]))
    res.samples, res.sample_rate

    p = get_phonemizer('diffsinger', voicebank_dir=r'...\\vb')
    p.phonemize([{'lyric': 'la', 'startBeat': 0, 'durBeat': 1, 'pitch': 60}])

## IPC 契约（M1 定义，前端在 M3 切换；切换完成后旧 `utau:*` / `diffsinger:*` 才可下线）

统一走 `sing:*` 命名空间，payload 一律**扁平原始值**（禁止传 Vue 响应式 Proxy，
那是本项目已复发多次的 `An object could not be cloned`）：

  sing:status      → {} → { ok, kinds:['utau','diffsinger'], renderers:[str], phonemizers:[str] }
  sing:phonemize   → { kind, voicebankDir, bpm, notes:[{startBeat,durBeat,pitch,lyric,...}] }
                   → { ok, notes:[{ index, lyric, phonemes:[{phoneme,position_ms,preutter_ms,
                        overlap_ms,env,muted,error}] }], warnings:[str] }
  sing:render      → { kind, voicebankDir, bpm, device, params:{...}, out }
                   → { ok, out, sampleRate, durationMs, leadingMs, warnings:[str] }
  sing:pitch       → 同上入参 → { ok, ticks:[], f0:[] }（可选，渲染器未实现则返回 ok:false）

约定：
- `kind` 与 `voicebankDir` 必填；`params` 为引擎私有参数（UTAU 的 flags/gender/breath、
  DiffSinger 的 depth/steps），**不跨引擎复用**。
- 失败一律 `{ok:false, error}`，不抛到 IPC 层；`warnings` 用于「音素回退」这类可继续的情况。
- 渲染结果**写文件**并回路径（与现有 `utau:renderTrack` 一致），不经 IPC 传大块音频。
"""

from .api import (  # noqa: F401
    Phonemizer,
    Renderer,
    get_phonemizer,
    get_renderer,
    phonemizer_names,
    register_phonemizer,
    register_renderer,
    renderer_names,
)
from .types import (  # noqa: F401
    Phoneme,
    PhonemizedNote,
    RenderContext,
    RenderPitchResult,
    RenderRequest,
    RenderResult,
    envelope_default,
)

__all__ = [
    'Phonemizer', 'Renderer',
    'get_phonemizer', 'get_renderer',
    'phonemizer_names', 'renderer_names',
    'register_phonemizer', 'register_renderer',
    'Phoneme', 'PhonemizedNote', 'RenderContext', 'RenderPitchResult',
    'RenderRequest', 'RenderResult', 'envelope_default',
]

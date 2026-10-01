# -*- coding: utf-8 -*-
"""DiffSinger（神经歌声合成）适配器。

委托目标（`engine_diffsinger.py` 里既有的核心函数）：
  - `load_voicebank(vb_dir)`                 声库 → dict（含 phonemes / 各阶段模型）
  - `load_dictionaries(vb, cache=None)`      声库内词典 → {word: [phonemes]}
  - `lyrics_to_phonemes(notes, vb, dicts, phoneme_set)`  每音符歌词 → 音素序列
  - `split_ph_duration` / `build_pitch_curve` / `run_acoustic` / `run_vocoder`（M2 用）

**M1 只接「音素化」这一半**：
`cmd_render()` 里 1817–2150 行把「音符归一化 → 音素 → 时长 → 音高 → 声学 → 声码器」
整条流水线写在一个函数体内，没有可复用的边界。要把它接进 Renderer 抽象，
必须先做一次**纯搬运式抽取**（把函数体切成 render_phrase()，cmd_render 改为调用它）。
这类改动没有模型就跑不了验证，属于 M2 的第一步，故此处不留半成品实现：
`DiffSingerRenderer.render()` 明确抛 NotImplementedError，而不是给出可能不对的结果。
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE_DIR = os.path.dirname(os.path.dirname(_HERE))
if _ENGINE_DIR not in sys.path:
    sys.path.insert(0, _ENGINE_DIR)

import engine_diffsinger  # noqa: E402

from ..api import Phonemizer, Renderer, register_phonemizer, register_renderer  # noqa: E402
from ..types import Phoneme, PhonemizedNote, RenderContext, RenderRequest, RenderResult  # noqa: E402


def normalize_notes(notes, bpm):
    """音符归一化 —— 与 `engine_diffsinger.cmd_render` 里 1891–1913 行**逐字对应**。

    这段逻辑原本内联在 cmd_render 里。为避免两处实现漂移，
    适配器直接引用同一份规则，并由对照测试断言与原实现等价。
    （M2 抽取 render_phrase() 时，这个函数应当被移回 engine_diffsinger 供双方共用。）
    """
    spb = 60.0 / max(20.0, min(400.0, float(bpm or 120)))
    out = []
    for n in notes or []:
        try:
            sb = float(n.get('startBeat', 0.0))
            db = float(n.get('durBeat', 1.0))
            pitch = int(n.get('pitch', 60))
        except (TypeError, ValueError):
            continue
        out.append({
            'startSec': max(0.0, sb * spb),
            'durSec': max(0.05, db * spb),
            'pitch': max(0, min(127, pitch)),
            'lyric': str(n.get('lyric') or ''),
            'vibrato': bool(n.get('vibrato')),
            'vibDepth': float(n.get('vibDepth', 25)),
            'vibFreq': float(n.get('vibFreq', 5.5)),
            'vibFade': float(n.get('vibFade', 0)),
            'pitchOffset': float(n.get('pitchOffset') or 0),
        })
    out.sort(key=lambda x: x['startSec'])
    return out


def _load_vb(ctx, vb_dir):
    vb = ctx.loaded.get('ds.vb')
    if vb is None:
        vb = engine_diffsinger.load_voicebank(vb_dir)
        ctx.loaded['ds.vb'] = vb
        ctx.loaded['ds.dicts'] = engine_diffsinger.load_dictionaries(vb)
    return vb


@register_phonemizer
class DiffSingerPhonemizer(Phonemizer):
    """歌词 → 音素：委托 `lyrics_to_phonemes`。"""

    name = 'diffsinger'
    kinds = ('diffsinger',)

    def phonemize(self, notes, ctx=None):
        ctx = ctx or RenderContext(voicebank_dir=self.voicebank_dir)
        vb_dir = self.voicebank_dir or ctx.voicebank_dir
        vb = _load_vb(ctx, vb_dir)
        dicts = ctx.loaded.get('ds.dicts') or {}

        bpm = float(self.opts.get('bpm') or (ctx.cache.get('bpm') if ctx.cache else 0) or 120.0)
        norm = normalize_notes(notes, bpm)
        if not norm:
            return []
        if not dicts:
            ctx.warn('声库里没有词典（*.dsdict），只能使用音素级歌词')

        phoneme_set = set(vb.get('phonemes') or []) or {'AP', 'SP'}
        per_note, warns = engine_diffsinger.lyrics_to_phonemes(norm, vb, dicts, phoneme_set)
        for w in (warns or [])[:30]:
            ctx.warn(w)

        out = []
        for i, (note, phs) in enumerate(zip(norm, per_note)):
            out.append(PhonemizedNote(
                index=i,
                lyric=note['lyric'],
                phonemes=[Phoneme(phoneme=str(p)) for p in (phs or [])],
            ))
        return out


@register_renderer
class DiffSingerRenderer(Renderer):
    """DiffSinger 渲染器 —— M2 才接（见模块 docstring）。"""

    name = 'diffsinger'
    kinds = ('diffsinger',)

    def render(self, req, ctx=None):   # pragma: no cover - M2 实现
        raise NotImplementedError(
            'DiffSingerRenderer 尚未接入：`cmd_render()` 的流水线仍内联在单函数里，'
            '需要先在 M2 做一次纯搬运式抽取（render_phrase()），再用模型实测做对照验证。'
            '当前请继续走既有的 diffsinger:render IPC。')

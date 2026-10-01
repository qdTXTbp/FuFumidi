# -*- coding: utf-8 -*-
"""UTAU（拼接合成）适配器。

委托目标（`engine_utau.py` 里既有的、可直接复用的核心函数）：
  - `Voicebank(vb_dir)`                     音源（oto.ini + 采样）
  - `Voicebank.get(lyric, strict=False)`    歌词 → 原音条目（别名解析）
  - `render_track(vb, notes, sample_note, sr, strict)`  多音节音轨 → (波形, warnings)

**不复制任何 DSP**：`render_note` / `render_track` 内部一行未改，
所以适配器与直接调用原函数的结果必须逐位一致（由对照测试保证）。
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE_DIR = os.path.dirname(os.path.dirname(_HERE))
if _ENGINE_DIR not in sys.path:
    sys.path.insert(0, _ENGINE_DIR)

import engine_utau  # noqa: E402

from ..api import Phonemizer, Renderer, register_phonemizer, register_renderer  # noqa: E402
from ..types import Phoneme, PhonemizedNote, RenderContext, RenderRequest, RenderResult  # noqa: E402

_DEFAULT_SAMPLE_NOTE = 'C4'


def _load_voicebank(ctx, vb_dir):
    """按 ctx 复用已解析的音源，避免一个乐句里重复读 oto.ini。"""
    vb = ctx.loaded.get('utau.vb')
    if vb is None:
        vb = engine_utau.Voicebank(vb_dir)
        ctx.loaded['utau.vb'] = vb
    return vb


@register_phonemizer
class UtauPhonemizer(Phonemizer):
    """UTAU 的音素化 = 歌词 → oto.ini 别名（原音条目）。

    与 OpenUTAU 的差别要记在心里：OpenUTAU 会把歌词先过 phonemizer 拆成音素序列
    （中文 CVVC/VCV、日文等），我们这一步目前只做**别名解析**，
    真正的「歌词 → 音素」拆分是 M2 的移植内容。
    """

    name = 'utau'
    kinds = ('utau',)

    def phonemize(self, notes, ctx=None):
        ctx = ctx or RenderContext(voicebank_dir=self.voicebank_dir)
        vb_dir = self.voicebank_dir or ctx.voicebank_dir
        vb = _load_voicebank(ctx, vb_dir)
        strict = bool(self.opts.get('strict', False))

        out = []
        for i, n in enumerate(notes or []):
            lyric = str((n or {}).get('lyric') or '')
            entry = vb.get(lyric, strict=strict)
            out.append(PhonemizedNote(index=i, lyric=lyric, phonemes=[Phoneme(
                phoneme=entry.alias,
                position_ms=0.0,
                preutter_ms=float(entry.preutterance),
                overlap_ms=float(entry.overlap),
                meta={
                    'filename': entry.filename,
                    'offset_ms': float(entry.offset),
                    'consonant_ms': float(entry.consonant),
                    'blank_ms': float(entry.blank),
                },
            )]))

        # 回退提示与 `cmd_render` 的文案保持一致，便于 UI 直接复用
        for lyric, used in vb.take_fallbacks():
            ctx.warn('歌词「%s」在原音中不存在，已回退到「%s」（可用「发音」按钮替换）' % (lyric, used))
        return out


@register_renderer
class UtauRenderer(Renderer):
    """UTAU 渲染器：直接委托 `render_track`，波形与直接调用逐位一致。"""

    name = 'utau'
    kinds = ('utau',)

    def render(self, req, ctx=None):
        ctx = ctx or RenderContext(voicebank_dir=self.voicebank_dir, sample_rate=req.sample_rate)
        vb_dir = self.voicebank_dir or ctx.voicebank_dir
        vb = _load_voicebank(ctx, vb_dir)

        sr = int(req.sample_rate or engine_utau.SAMPLE_RATE)
        sample_note = str(req.params.get('sample_note') or self.opts.get('sample_note') or _DEFAULT_SAMPLE_NOTE)
        strict = bool(req.params.get('strict', self.opts.get('strict', False)))

        buf, warnings = engine_utau.render_track(
            vb, list(req.notes or []), sample_note=sample_note, sr=sr, strict=strict)
        for w in warnings or []:
            ctx.warn(w)

        dur_ms = (len(buf) / float(sr) * 1000.0) if len(buf) else 0.0
        # 拼接式合成里，音符起点前的 lead 已经由 render_track 内部按 preutterance/overlap
        # 对齐到 0，因此这里 leading/position 恒为 0（与现有 CLI 输出一致）。
        return RenderResult(
            samples=buf,
            sample_rate=sr,
            leading_ms=0.0,
            position_ms=0.0,
            estimated_length_ms=dur_ms,
        )

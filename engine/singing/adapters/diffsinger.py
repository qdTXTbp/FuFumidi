# -*- coding: utf-8 -*-
"""DiffSinger（神经歌声合成）适配器。

委托目标（`engine_diffsinger.py` 里既有的核心函数）：
  - `load_voicebank(vb_dir)`                 声库 → dict（含 phonemes / 各阶段模型）
  - `load_dictionaries(vb, cache=None)`      声库内词典 → {word: [phonemes]}
  - `lyrics_to_phonemes(notes, vb, dicts, phoneme_set)`  每音符歌词 → 音素序列
  - `render_phrase(cfg, on_progress)`        **M2 抽取出的整条渲染流水线**（原 cmd_render 主体）

M2 进展：`cmd_render()` 里原本内联成一整段的流水线（1817–2143 行）已**纯搬运**抽成
`render_phrase()`，CLI 与这里的 `DiffSingerRenderer` 共用同一份实现。

⚠ 关于验证方式的重要事实：**这条流水线不是逐位可复现的**。
实测同一份代码连跑 4 次，波形 `max|d| ≈ 0.11–0.16`、逐样本相关系数 ≈ 0（声码器激励相位每次不同），
所以「WAV sha256 相同」**不能**当作等价判据。改用对数谱（幅度谱）对照：
同码重跑相关 0.9927–0.9959，抽取前 vs 抽取后 0.9929–0.9961 —— 区间完全重叠，
即抽取带来的差异落在流水线自身的噪声地板上。详见 `engine/tests/test_singing_adapters.py`。
"""

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE_DIR = os.path.dirname(os.path.dirname(_HERE))
if _ENGINE_DIR not in sys.path:
    sys.path.insert(0, _ENGINE_DIR)

import engine_diffsinger  # noqa: E402

from ..api import Phonemizer, Renderer, register_phonemizer, register_renderer  # noqa: E402
from ..types import Phoneme, PhonemizedNote, RenderContext, RenderPitchResult, RenderRequest, RenderResult  # noqa: E402


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
    """DiffSinger 渲染器：委托 `render_phrase()`（M2 从 cmd_render 抽出的整条流水线）。

    注意 `render_phrase` 的 `notes` 走的是 CLI 同款解析（JSON 字符串或 `@文件`），
    所以这里显式 `json.dumps` —— 直接传 list 会落到 `json.loads(list)` 而报错。
    """

    name = 'diffsinger'
    kinds = ('diffsinger',)

    def render(self, req, ctx=None):
        ctx = ctx or RenderContext(voicebank_dir=self.voicebank_dir, sample_rate=req.sample_rate)
        vb_dir = self.voicebank_dir or ctx.voicebank_dir
        p = req.params or {}
        cfg = {
            'voicebank': vb_dir,
            'notes': json.dumps(list(req.notes or []), ensure_ascii=False),
            'bpm': req.bpm,
            'vocoder': p.get('vocoder'),
            'start_beat': p.get('start_beat'),
            'end_beat': p.get('end_beat'),
            'context_sec': p.get('context_sec', 0.5),
            'full': p.get('full', False),
            'device': req.device or 'auto',
            # 适配器只要波形，不落盘（out 为空时 render_phrase 跳过写文件）
            'out': p.get('out') or '',
        }
        # RenderError 直接向上抛：接口约定「失败应抛异常，不要把错误塞进 samples」
        res = engine_diffsinger.render_phrase(cfg, on_progress=p.get('on_progress'))
        for w in (res.get('warnings') or []):
            ctx.warn(w)
        ctx.cache['bpm'] = req.bpm
        return RenderResult(
            samples=res.get('wav'),
            sample_rate=int(res.get('sample_rate') or req.sample_rate or 44100),
            leading_ms=0.0,
            position_ms=0.0,
            estimated_length_ms=float(res.get('duration_ms') or 0.0),
        )

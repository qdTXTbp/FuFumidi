# -*- coding: utf-8 -*-
r"""`dspitch` → PITD 写回 —— **照搬**
`OpenUtau.Core/DiffSinger/DiffSingerPitch.cs` 的 `DsPitch.Process` 与
`DiffSingerRenderer.LoadRenderedPitch`（:556-587）+ `NoteBatchEdits.cs:540-566`。

★ **本模块不参与渲染。** 上游 `InvokeDiffsinger` 全程不碰音高模型 —— 渲染用的
  `f0` 永远来自用户谱面曲线。`dspitch` 是**编辑期**功能：让声乐者"唱一版"，
  把模型预测的音高曲线写回 PITD 供微调（`NoteBatchEdits.cs`）。

## ★ 写回时的两个关键语义（`NoteBatchEdits.cs:540-566`）

```csharp
// :544-546  voiced==false 的帧（head/tail SP、音素间隙）**不写**
if (!voiced[i]) continue;
// :554      曲线下标按 5 tick 间隔夹取
int pitchIndex = Math.Clamp((int)((x - (phrase.position - part.position - phrase.leading)) / 5), 0, pitchesBeforeDeviation.Length - 1);
// :557      写回的是**音分差**，不是绝对音高
int y = (int)(tones[i] * 100 - pitchesBeforeDeviation[pitchIndex]);
```
`y > minPitD` 才发命令（`:559`）—— 也就是**只下调**。
"""

import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Set

from . import RenderError
from .utils import (
    HEAD_FRAMES, TAIL_FRAMES, durations_ms_to_frames, fit_duration_sum,
    padded_phone_durations, padded_segments, padded_voiced_mask, sample_curve,
)

#: 上游 `Preferences.cs:193` `DiffSingerStepsPitch = 10`（注意：不是 Steps 的 20）
DEFAULT_PITCH_STEPS = 10
#: 曲线的采样间隔（`RenderPhrase.cs:272` `pitchInterval`）
PITCH_INTERVAL = 5


@dataclass
class DsPitchConfig:
    """`<声库>/dspitch/dsconfig.yaml`。"""

    root: str
    linguistic: str
    pitch: str
    phonemes: str
    languages: Optional[str] = None
    predict_dur: bool = False
    use_expr: bool = False
    use_note_rest: bool = False
    use_lang_id: bool = False
    use_continuous_acceleration: bool = False
    hop_size: int = 512
    sample_rate: int = 44100
    raw: dict = None

    @property
    def frame_ms(self) -> float:
        from .config import frame_ms_of
        return frame_ms_of(self.hop_size, self.sample_rate)

    def model(self, which: str) -> str:
        return os.path.join(self.root, self.linguistic if which == 'linguistic'
                            else self.pitch)


def load_pitch(singer_dir: str) -> Optional[DsPitchConfig]:
    """对应 `DiffSingerSinger.HasPitchPredictor`（:65）—— 目录不存在返回 None。

    ★ 注意这是**编辑功能**的可用性，与渲染无关（渲染根本不用它）。
    """
    root = os.path.join(singer_dir, 'dspitch')
    cfg_path = os.path.join(root, 'dsconfig.yaml')
    if not os.path.isfile(cfg_path):
        return None
    import yaml
    with open(cfg_path, encoding='utf-8') as f:
        raw = yaml.safe_load(f) or {}
    for key in ('linguistic', 'pitch'):
        if not raw.get(key):
            raise RenderError('dspitch/dsconfig.yaml 缺少必需键 "%s"' % key)
    return DsPitchConfig(
        root=root,
        linguistic=raw['linguistic'],
        pitch=raw['pitch'],
        phonemes=raw.get('phonemes', ''),
        languages=raw.get('languages'),
        predict_dur=bool(raw.get('predict_dur', False)),
        use_expr=bool(raw.get('use_expr', False)),
        use_note_rest=bool(raw.get('use_note_rest', False)),
        use_lang_id=bool(raw.get('use_lang_id', False)),
        use_continuous_acceleration=bool(raw.get('use_continuous_acceleration', False)),
        hop_size=int(raw.get('hop_size', 512)),
        sample_rate=int(raw.get('sample_rate', 44100)),
        raw=raw,
    )


@dataclass
class RenderPitchResult:
    """对应 `OpenUtau.Core/Ustx/RenderPitchResult.cs` → 可直接写回 PITD。"""

    #: 相对 `phrase.position` 的 tick（步长 5）
    ticks: List[float] = None
    #: 模型预测的音高（**MIDI tone**，不是音分）
    tones: List[float] = None
    #: 该音素是否要"重取"（`DiffSingerRetake`）
    retake_mask: Optional[List[bool]] = None
    #: ★ head/tail SP 与音素间隙的帧是 False —— 写回时跳过（`NoteBatchEdits.cs:544-546`）
    voiced: Optional[List[bool]] = None


def load_rendered_pitch(singer, cfg: DsPitchConfig, phrase, notes: Sequence,
                        phoneme_tokens: Dict[str, int], g2p,
                        providers, pitch_steps: Optional[int] = None,
                        fast_realtime: bool = False,
                        retake_note_indexes: Optional[Set[int]] = None,
                        existing_pitch: Optional[Sequence[float]] = None,
                        cache_dir=None, hashes=None) -> RenderPitchResult:
    """照搬 `DsPitch.Process`（`DiffSingerPitch.cs:110-360`）。

    `phrase` 需有 `.phones` / `.pitches`（音分）/ `.position` / `.position_ms` / `.leading`。
    `notes` 是 `phrase.notes` 对应的音符序列（要读 `position` / `duration` / `tone`）。
    """
    import numpy as np

    from .session import make_session, run_session
    from .utils import fit_duration_sum as _fit

    frame_ms = cfg.frame_ms
    start_ms = phrase.phones[0].position_ms - HEAD_FRAMES * frame_ms

    # ---- 每个音素都要有类型定义（:117-123）
    for ph in phrase.phones:
        if not g2p.is_valid_symbol(ph.phoneme):
            raise RenderError(
                '音素 "%s" 没有类型定义，请把它加进 dspitch/dsdict-<lang>.yaml'
                % ph.phoneme)

    # ---- linguistic（:126-181）
    segments = padded_segments(phrase.phones, frame_ms, HEAD_FRAMES, TAIL_FRAMES)
    tokens = []
    for sym, _, _ in segments:
        if sym not in phoneme_tokens:
            raise RenderError('音素 "%s" 不被音高模型支持（查 dspitch/%s）'
                              % (sym, cfg.phonemes))
        tokens.append(phoneme_tokens[sym])
    ph_dur = padded_phone_durations(phrase.phones, frame_ms, HEAD_FRAMES, TAIL_FRAMES)
    total_frames = int(sum(ph_dur))
    # ★ head/tail padding 与音素间隙是静音：模型在这些帧上吐的值**不能**变成曲线点
    voiced = padded_voiced_mask(segments, ph_dur)

    ling_feeds: Dict[str, object] = {
        'tokens': np.asarray([tokens], dtype=np.int64),
    }
    if cfg.predict_dur:
        from .utils import padded_word_div_and_dur
        word_div, word_dur = padded_word_div_and_dur(phrase, ph_dur, g2p.is_vowel,
                                                      frame_ms, HEAD_FRAMES, TAIL_FRAMES)
        ling_feeds['word_div'] = np.asarray([word_div], dtype=np.int64)
        ling_feeds['word_dur'] = np.asarray([word_dur], dtype=np.int64)
    else:
        ling_feeds['ph_dur'] = np.asarray([ph_dur], dtype=np.int64)

    if cfg.use_lang_id:
        # ★ 多语声库（Ria）的 dspitch linguistic 同样要 `languages`（形状同 tokens）：
        #   逐音素取符号的语言前缀，查 **dspitch 自己**那份 <x>.languages.json。
        from .g2p import lang_id_of
        from .voicebank import load_language_ids
        _ids = load_language_ids(cfg)
        langs = [lang_id_of(sym, _ids) for sym, _, _ in segments]
        if len(langs) != len(tokens):
            raise RenderError('dspitch 的 languages 与 tokens 不等长：%d vs %d'
                              % (len(langs), len(tokens)))
        ling_feeds['languages'] = np.asarray([langs], dtype=np.int64)

    # ★ 走 run_session 以启用 tensorcache（identifier = dspitch linguistic 的模型 hash）
    ling_names = [o.name for o in make_session(cfg.model('linguistic'),
                                               providers).get_outputs()]
    louts = dict(zip(ling_names, run_session(
        cfg.model('linguistic'), ling_feeds, providers, 'dspitch linguistic',
        identifier=(hashes or {}).get('pitch_linguistic'), cache_dir=cache_dir)))
    encoder_out = louts['encoder_out']
    x_masks = louts.get('x_masks')
    if x_masks is not None:
        ling_feeds = dict(ling_feeds)

    # ---- note 级输入（:184-258）：头 padding / 间隙 rest / 各音符 / 尾 padding
    note_dur_ms: List[float] = []
    note_midi: List[float] = []
    note_rest: List[bool] = []
    padded_to_real: List[int] = []

    def adjusted_tone(note) -> float:
        return float(getattr(note, 'adjusted_tone', None) or note.tone)

    note_dur_ms.append(max(0.0, notes[0].position_ms - start_ms))
    note_midi.append(adjusted_tone(notes[0]))
    note_rest.append(True)                                # 头 padding 恒为 rest
    padded_to_real.append(0)

    prev_end_ms = notes[0].position_ms
    for real_idx, note in enumerate(notes):
        gap = note.position_ms - prev_end_ms
        if gap > 0:                                        # :199-206 插 rest
            note_dur_ms.append(gap)
            note_midi.append(adjusted_tone(note))
            note_rest.append(True)
            padded_to_real.append(real_idx - 1)
        note_dur_ms.append(note.duration_ms)
        note_midi.append(adjusted_tone(note))
        padded_to_real.append(real_idx)
        if str(note.lyric).startswith('+'):               # :212-213 连排沿用前一个
            note_rest.append(note_rest[-1])
        else:
            # 该音符覆盖的音素里只要有一个元音就不是 rest（:214-218）
            phs = [p for p in phrase.phones
                   if p.end_ms > note.position_ms and p.position_ms < note.end_ms]
            is_rest = (not phs
                       or all(p.phoneme in ('AP', 'SP') or not g2p.is_vowel(p.phoneme)
                              for p in phs))
            note_rest.append(is_rest)
        prev_end_ms = note.end_ms

    note_dur_ms.append(TAIL_FRAMES * frame_ms)             # 尾 padding
    note_midi.append(adjusted_tone(notes[-1]))
    note_rest.append(True)
    padded_to_real.append(len(notes) - 1)

    # ---- rest 组的音高用最近的非 rest 音符（:233-257）
    if all(note_rest):
        note_midi = [60.0] * len(note_midi)
    else:
        i = 0
        while i < len(note_rest):
            if not note_rest[i]:
                i += 1
                continue
            j = i + 1
            while j < len(note_rest) and note_rest[j]:
                j += 1
            if i == 0:
                for k in range(0, j):
                    note_midi[k] = note_midi[j]
            elif j == len(note_rest):
                for k in range(i, len(note_rest)):
                    note_midi[k] = note_midi[i - 1]
            else:
                mid = (i + j + 1) // 2
                for k in range(i, mid):
                    note_midi[k] = note_midi[i - 1]
                for k in range(mid, j):
                    note_midi[k] = note_midi[j]
            i = j

    # ★ :258-260 note_dur = DurationsMsToFrames 再塞进 total_frames
    note_dur = _fit(durations_ms_to_frames(note_dur_ms, frame_ms), total_frames)

    # ---- 采样输入（:265-275）
    pitch = [60.0] * total_frames
    retake = [True] * total_frames
    if retake_note_indexes is not None and existing_pitch is not None:
        retake = _build_retake_mask(note_dur, padded_to_real, retake_note_indexes,
                                    total_frames)
        for k in range(min(total_frames, len(existing_pitch))):
            pitch[k] = float(existing_pitch[k])

    # ---- pitch 模型（:277-300）
    steps = int(pitch_steps if pitch_steps is not None else DEFAULT_PITCH_STEPS)
    feeds: Dict[str, object] = {
        'encoder_out': encoder_out,
        'ph_dur': np.asarray([ph_dur], dtype=np.int64),
        'note_midi': np.asarray([note_midi], dtype=np.float32),
        'note_dur': np.asarray([note_dur], dtype=np.int64),
        'pitch': np.asarray([pitch], dtype=np.float32),
        'retake': np.asarray([retake], dtype=bool),
    }
    # ★ `use_note_rest` 为真时模型要 `note_rest`（:281-283）——本声库就是 true。
    #   我们已经按 :184-231 算好了 note_rest，只是漏了喂进去。
    if cfg.use_note_rest:
        feeds['note_rest'] = np.asarray([note_rest], dtype=bool)
    if cfg.use_expr:
        feeds['expr'] = np.asarray([sample_curve(
            phrase, None, 1, frame_ms, total_frames, HEAD_FRAMES, TAIL_FRAMES,
            lambda x: min(1.0, max(0.0, x / 100.0)))], dtype=np.float32)
    feeds['steps' if cfg.use_continuous_acceleration else 'speedup'] = np.asarray(
        [steps if cfg.use_continuous_acceleration
         else max(1, 1000 // max(1, steps))], dtype=np.int64)

    pit_names = [o.name for o in make_session(cfg.model('pitch'), providers).get_outputs()]
    outs = dict(zip(pit_names, run_session(
        cfg.model('pitch'), feeds, providers, 'dspitch',
        identifier=(hashes or {}).get('pitch'), cache_dir=cache_dir)))
    tones = [float(x) for x in np.asarray(outs['pitch_pred']).reshape(-1)]
    if len(tones) < total_frames:                          # 长度兜底
        tones = tones + [tones[-1] if tones else 60.0] * (total_frames - len(tones))
    tones = tones[:total_frames]

    # ---- 曲线的 tick（步长 5，起点是 phrase 起点）
    ticks = [float(i * PITCH_INTERVAL) for i in range(total_frames)]
    return RenderPitchResult(ticks=ticks, tones=tones,
                             retake_mask=retake[:total_frames] if retake_note_indexes else None,
                             voiced=voiced)


def _build_retake_mask(note_dur, padded_to_real, retake_note_indexes, total_frames):
    """对应 `DiffSingerRetake.BuildRetakeFrameMask`（简化版：按 note_dur 展开）。"""
    mask = [False] * total_frames
    f = 0
    for k, dur in enumerate(note_dur):
        real = padded_to_real[k] if k < len(padded_to_real) else 0
        want = real in retake_note_indexes
        for _ in range(dur):
            if f >= total_frames:
                break
            mask[f] = want
            f += 1
    return mask


# ---------------------------------------------------------------- 写回 PITD

def pitch_result_to_pitd(result: RenderPitchResult, phrase, part_position: int,
                         pitches_before_deviation: Sequence[float],
                         min_pitd: int = -1200) -> List[tuple]:
    """把预测音高写回成 `[(x_tick, y_pitd), ...]`（照搬 `NoteBatchEdits.cs:540-566`）。

    * `x` = 曲线局部 tick = `ticks[i] + (phrase.position - part.position - phrase.leading)`
    * `y` = `(int)(tones[i] * 100 - pitches_before_deviation[idx])`，**音分差**
    * ★ `voiced[i] == False` 的帧**跳过**（head/tail SP、音素间隙）
    * ★ `y > min_pitd`（默认 -1200）才输出 —— 这是 **PITD 的下调下限**
      （`descriptor.min`），不是「只允许下调」：模型预测高于原谱面时 `y` 为正也照写。
    """
    base = phrase.position - part_position - phrase.leading
    n = len(pitches_before_deviation)
    if n == 0:
        return []
    out: List[tuple] = []
    for i, tone in enumerate(result.tones):
        if result.voiced is not None and i < len(result.voiced) and not result.voiced[i]:
            continue
        x = result.ticks[i] + base
        idx = int((x - base) / PITCH_INTERVAL)
        idx = 0 if idx < 0 else (n - 1 if idx >= n else idx)
        y = int(tone * 100 - pitches_before_deviation[idx])
        if y > min_pitd:
            out.append((x, y))
    return out

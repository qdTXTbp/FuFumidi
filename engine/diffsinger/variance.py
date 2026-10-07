# -*- coding: utf-8 -*-
r"""方差预测 —— **照搬** `OpenUtau.Core/DiffSinger/DiffSingerVariance.cs`。

只在根 `dsconfig.yaml` 声明了 `use*Embed` 时参与渲染（`DiffSingerRenderer.cs:359-368`），
而且**没有降级路径**：模型缺失或某个通道缺输出都是直接抛（`:365-368` / `:388-391`）。

## ★ 最容易搞错的一点：variance 的 `pitch` 输入不是 Hz

```csharp
// DiffSingerVariance.cs:187-192
var pitch = SampleCurve(phrase, phrase.pitches, 0, ..., x => x * 0.01);   // 音分 → tone
var toneShift = SampleCurve(phrase, phrase.toneShift, 0, ..., x => x * 0.01);
pitch = pitch.Zip(toneShift, (x, d) => x + d).ToArray();
```

acoustic 的 `f0` 是 **Hz**（`ToneToFreq(x*0.01)`），variance 的 `pitch` 是 **MIDI tone**
（`x*0.01`，还没转频率）。同一个物理量、两种单位 —— 混淆这两处会让方差完全错。
"""

import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

from . import RenderError
from .utils import (
    BREC, ENE, TENC, VOIC, clamp_variance, resample_padded_curve, variance_delta,
)

#: 通道顺序硬编码于 `DiffSingerVariance.cs:234-239`（**不是**字典序）
VARIANCE_ORDER = (ENE, BREC, VOIC, TENC)

#: ★ 模型输出名 → 内部通道键。**两套命名不一样**：
#:   模型输出是 `breathiness_pred` / `voicing_pred` / `tension_pred` / `energy_pred`，
#:   而 .ustx 的曲线缩写是 `BREC` / `VOIC` / `TENC` / `ENE`（`Format/Ustx.cs`）。
#:   照搬时就是「按名字取 *_pred」（`:338-361`），所以必须显式映射，
#:   不能简单地把 `_pred` 剥掉当键用。
PRED_NAME_TO_KIND = {
    'energy_pred': ENE,
    'breathiness_pred': BREC,
    'voicing_pred': VOIC,
    'tension_pred': TENC,
}


@dataclass
class DsVarianceConfig:
    """`<声库>/dsvariance/dsconfig.yaml`。"""

    root: str
    linguistic: str
    variance: str
    phonemes: str
    languages: Optional[str] = None
    predict_dur: bool = False
    predict_energy: bool = False
    predict_breathiness: bool = True
    predict_voicing: bool = True
    predict_tension: bool = True
    use_lang_id: bool = False
    use_continuous_acceleration: bool = False
    hop_size: int = 512
    sample_rate: int = 44100
    raw: dict = None

    @property
    def frame_ms(self) -> float:
        from .config import frame_ms_of
        return frame_ms_of(self.hop_size, self.sample_rate)

    @property
    def num_variances(self) -> int:
        """★ 预测**通道数**（决定 `retake` 的第 3 维），本声库是 3。"""
        return sum((self.predict_energy, self.predict_breathiness,
                    self.predict_voicing, self.predict_tension))

    def model(self, which: str) -> str:
        return os.path.join(self.root, self.linguistic if which == 'linguistic'
                            else self.variance)


def load_variance(singer_dir: str) -> Optional[DsVarianceConfig]:
    """对应 `DiffSingerSinger.HasVariancePredictor`（:66）—— 目录不存在返回 None。"""
    root = os.path.join(singer_dir, 'dsvariance')
    cfg_path = os.path.join(root, 'dsconfig.yaml')
    if not os.path.isfile(cfg_path):
        return None
    import yaml
    with open(cfg_path, encoding='utf-8') as f:
        raw = yaml.safe_load(f) or {}
    for key in ('linguistic', 'variance'):
        if not raw.get(key):
            raise RenderError('dsvariance/dsconfig.yaml 缺少必需键 "%s"' % key)
    return DsVarianceConfig(
        root=root,
        linguistic=raw['linguistic'],
        variance=raw['variance'],
        phonemes=raw.get('phonemes', ''),
        languages=raw.get('languages'),
        predict_dur=bool(raw.get('predict_dur', False)),
        predict_energy=bool(raw.get('predict_energy', False)),
        predict_breathiness=bool(raw.get('predict_breathiness', True)),
        predict_voicing=bool(raw.get('predict_voicing', True)),
        predict_tension=bool(raw.get('predict_tension', True)),
        use_lang_id=bool(raw.get('use_lang_id', False)),
        use_continuous_acceleration=bool(raw.get('use_continuous_acceleration', False)),
        hop_size=int(raw.get('hop_size', 512)),
        sample_rate=int(raw.get('sample_rate', 44100)),
        raw=raw,
    )


@dataclass
class VarianceResult:
    """对应 `VarianceResult`（`DiffSingerVariance.cs:36-49`）。"""

    energy: Optional[List[float]] = None
    breathiness: Optional[List[float]] = None
    voicing: Optional[List[float]] = None
    tension: Optional[List[float]] = None
    head_frames: int = 0
    tail_frames: int = 0
    frame_ms: float = 0.0


def predict(singer, cfg: DsVarianceConfig, phrase, segments, durations: Sequence[int],
            tokens: Sequence[int], phoneme_is_vowel, providers,
            steps: int, speedup: int, cache_dir=None,
            hashes=None) -> VarianceResult:
    """跑 `dsvariance`（照搬 `DsVariance.Process`）。

    `phrase` 需提供 `.pitches`（音分）/ `.tone_shift`（音分）与 `SampleCurve` 所需字段。
    ★ 输出按**名字**取（`:338-361` 的 `*_pred`），不按顺序。
    """
    import numpy as np

    from .session import run_session
    from .utils import HEAD_FRAMES, TAIL_FRAMES, sample_curve

    total_frames = int(sum(durations))
    frame_ms = cfg.frame_ms

    # ---- linguistic: :140-176（两分支）
    ling_feeds: Dict[str, object] = {
        'tokens': np.asarray([list(tokens)], dtype=np.int64),
    }
    if cfg.predict_dur:
        from .utils import padded_word_div_and_dur
        word_div, word_dur = padded_word_div_and_dur(
            phrase, durations, phoneme_is_vowel, frame_ms, HEAD_FRAMES, TAIL_FRAMES)
        ling_feeds['word_div'] = np.asarray([word_div], dtype=np.int64)
        ling_feeds['word_dur'] = np.asarray([word_dur], dtype=np.int64)
    else:
        ling_feeds['ph_dur'] = np.asarray([list(durations)], dtype=np.int64)

    if cfg.use_lang_id:
        # ★ 多语声库（Ria）的 variance linguistic 也多一个 `languages` 输入（形状同 tokens）：
        #   逐音素取符号的语言前缀，查 **dsvariance 自己**那份 <x>.languages.json。
        from .g2p import lang_id_of
        from .voicebank import load_language_ids
        _ids = load_language_ids(cfg)
        langs = [lang_id_of(sym, _ids) for sym, _, _ in segments]
        if len(langs) != len(tokens):
            raise RenderError('variance 的 languages 与 tokens 不等长：%d vs %d'
                              % (len(langs), len(tokens)))
        ling_feeds['languages'] = np.asarray([langs], dtype=np.int64)

    # ★ 按**名字**取 `encoder_out`（:182-185），不按顺序；走 run_session 以启用缓存
    ling_outs = run_session(cfg.model('linguistic'), ling_feeds, providers,
                            'dsvariance linguistic',
                            identifier=(hashes or {}).get('variance_linguistic'),
                            cache_dir=cache_dir)
    names = _output_names(cfg.model('linguistic'), providers)
    by_name = {n: np.asarray(v) for n, v in zip(names, ling_outs)}
    if 'encoder_out' not in by_name:
        raise RenderError('dsvariance linguistic 没有输出 encoder_out')
    encoder_out = by_name['encoder_out']

    # ---- pitch 输入：★ tone 域（x*0.01），不是 Hz（:187-192）
    pitch_tone = sample_curve(phrase, phrase.pitches, 0, frame_ms, total_frames,
                              HEAD_FRAMES, TAIL_FRAMES, lambda x: x * 0.01)
    shift_tone = sample_curve(phrase, phrase.tone_shift, 0, frame_ms, total_frames,
                              HEAD_FRAMES, TAIL_FRAMES, lambda x: x * 0.01)
    pitch_tone = [a + b for a, b in zip(pitch_tone, shift_tone)]

    num_var = cfg.num_variances
    if num_var <= 0:
        raise RenderError('dsvariance 没有启用任何 predict_* 通道')
    ones = np.zeros((1, total_frames), dtype=np.float32)
    feeds: Dict[str, object] = {
        'encoder_out': encoder_out,
        'ph_dur': np.asarray([list(durations)], dtype=np.int64),
        'pitch': np.asarray([pitch_tone], dtype=np.float32),
        # ★ 各 predict_* 通道**从全 0 起步**（:225-233），不是默认 1
        'breathiness': ones.copy(),
        'voicing': ones.copy(),
        'tension': ones.copy(),
        # ★ retake 是 **bool** [1, totalFrames, numVariances]，全 true（:240）
        'retake': np.ones((1, total_frames, num_var), dtype=bool),
        'steps' if cfg.use_continuous_acceleration else 'speedup':
            np.asarray([steps if cfg.use_continuous_acceleration else speedup],
                       dtype=np.int64),
    }
    if cfg.predict_energy:
        feeds['energy'] = ones.copy()

    v_outs = run_session(cfg.model('variance'), feeds, providers,
                         'dsvariance', identifier=(hashes or {}).get('variance'),
                         cache_dir=cache_dir)
    outs = dict(zip(_output_names(cfg.model('variance'), providers), v_outs))
    result = VarianceResult(head_frames=HEAD_FRAMES, tail_frames=TAIL_FRAMES,
                            frame_ms=frame_ms)
    for name, value in outs.items():
        key = PRED_NAME_TO_KIND.get(name)
        if key is None:
            continue
        flat = [float(x) for x in np.asarray(value).reshape(-1)]
        if not flat:
            continue
        setattr(result, key, flat)
    return result


def _output_names(model_path: str, providers) -> List[str]:
    """取模型的输出名列表（按声明顺序）。

    ★ `run_session` 只返回数组列表（缓存里不存名字），所以要单独查一次签名
      把数组对回名字 —— 上游是 `outputs.Where(o => o.Name == "encoder_out")`（:182-185），
      语义相同。
    """
    from .session import make_session
    return [o.name for o in make_session(model_path, providers).get_outputs()]


def compose(result: VarianceResult, kind: str, phrase, curve, default: float,
            total_frames: int, target_frame_ms: float,
            head_frames: int, tail_frames: int) -> List[float]:
    """把「预测 + 用户曲线」合成并 clamp（照搬 `DiffSingerRenderer.cs:397-458`）。

    1. `ResamplePaddedCurve` 把预测重采样到 acoustic 的帧数（**三段**）
    2. `variance_delta(预测, 用户)`
    3. `clamp_variance`
    """
    from .utils import sample_curve

    predicted = getattr(result, kind, None)
    if predicted is None:
        # 对应 :388-391：模型要求某通道但没输出 → 直接抛，不降级
        raise RenderError('variance 预测里缺少 "%s"（声学模型要求该输入）' % kind)
    pred = resample_padded_curve(predicted, total_frames,
                                result.head_frames, result.tail_frames,
                                head_frames, tail_frames,
                                result.frame_ms, target_frame_ms)
    if pred is None:
        pred = [0.0] * total_frames
    user = sample_curve(phrase, curve, default, target_frame_ms, total_frames,
                        head_frames, tail_frames, lambda x: x)
    return [clamp_variance(kind, variance_delta(kind, p, u)) for p, u in zip(pred, user)]

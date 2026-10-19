# -*- coding: utf-8 -*-
"""识别片段长度（segment_sec）的模型映射（纯函数，便于单测）。

用户需求（2026-10-18）：「为所有模型添加调节一次性喂入模型识别的片段长度」。
不同模型的「片段」实现不一样，这里集中把用户给的一个秒数映射成各模型要的参数：

| 模型 | 映射 |
|---|---|
| transkun | CLI --segmentSize（秒）；hop 取 segment/2 |
| piano-transcription | PianoTranscription(segment_samples=秒*16000) |
| MuScriptor | 内部 5 秒块 → 运行时改 transcription_model._SEGMENT_DURATION |
| Aria-AMT | amt.inference.transcribe.LEN_MS（毫秒），CHUNK_LEN_MS = LEN_MS // STRIDE_FACTOR |
| basic-pitch | 音频按片段切分后逐段 predict，再合并 MIDI（片段长度=切片秒数） |

0 / 空 = 各模型默认（保持旧行为，任何模型都不变）。
"""
from typing import Optional

MIN_SEGMENT_SEC = 2.0
MAX_SEGMENT_SEC = 120.0


def normalize_segment_sec(value) -> float:
    """用户值 → 合法秒数；0/None/非法 = 0（表示用模型默认）。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if v <= 0:
        return 0.0
    return max(MIN_SEGMENT_SEC, min(MAX_SEGMENT_SEC, v))


def transkun_segment_args(segment_sec) -> list:
    """transkun CLI 的 --segmentSize / --segmentHopSize（hop = 片段的一半）。"""
    sec = normalize_segment_sec(segment_sec)
    if not sec:
        return []
    return ["--segmentSize", ("%.3f" % sec), "--segmentHopSize", ("%.3f" % (sec / 2.0))]


def piano_segment_samples(segment_sec, sample_rate=16000) -> Optional[int]:
    """piano-transcription 的 segment_samples；None = 用库默认。"""
    sec = normalize_segment_sec(segment_sec)
    if not sec:
        return None
    return int(round(sec * float(sample_rate)))


def muscriptor_segment_sec(segment_sec, default=5.0) -> float:
    """MuScriptor 内部块长（秒）；未设置返回模型默认 5.0。"""
    sec = normalize_segment_sec(segment_sec)
    return sec if sec else float(default)


def aria_len_ms(segment_sec) -> Optional[int]:
    """Aria-AMT 的 LEN_MS（毫秒）；None = 用默认 30000。"""
    sec = normalize_segment_sec(segment_sec)
    if not sec:
        return None
    return int(round(sec * 1000.0))

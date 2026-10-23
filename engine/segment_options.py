# -*- coding: utf-8 -*-
"""识别片段长度（segment_sec）的模型映射（纯函数，便于单测）。

★ 2026-10-23 重新定位：**默认一律不开启**。

用户 2026-10-21 要求「取消分块转录」（实测按固定长度切片再合并会让块与块之间
质量参差不齐：接缝重复音、换音色、延音被切断），当时整体删掉了这个能力；
随后用户明确「改成不强制开启分段识别，允许用户手动切换」—— 所以这里恢复成一个
**显式可选**的能力：

  · **默认 0 / 不传 = 各模型原生块长**（= 训练块长），与「取消分块转录」后的行为
    完全一致。basic-pitch 一次 predict 跑完整首；MuScriptor 用它自己的 5 秒块。
  · **只有用户在高级参数里把滑条调离 0**，才按用户给的秒数改对应模型的取窗。
  · **预设一律不写这个键** —— 6.1.x 的预设给每个模型都写了值（MuScriptor 5s /
    钢琴 10s / Aria 30s…），切模型就自动套上，那正是「强制开启」。
    这条由 engine/tests/test_transcribe_options.py 固化为机器断言。

不同模型的「片段」实现不一样，这里集中把一个秒数映射成各模型要的参数：

| 模型 | 映射 |
|---|---|
| transkun | CLI --segmentSize（秒）；hop 取 segment/2 |
| piano-transcription | PianoTranscription(segment_samples=秒*16000) |
| MuScriptor | 内部 5 秒块 → 运行时改 transcription_model._SEGMENT_DURATION |
| Aria-AMT | amt.inference.transcribe.LEN_MS（毫秒），CHUNK_LEN_MS = LEN_MS // STRIDE_FACTOR |
| basic-pitch | 音频按片段切分后逐段 predict，再合并 MIDI（片段长度=切片秒数） |
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

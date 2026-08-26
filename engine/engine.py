# -*- coding: utf-8 -*-
"""
统一转录入口：按模式选择引擎
============================
- universal  通用识别（任意歌曲/人声/多乐器）   → basic-pitch
- piano      钢琴专用（最高精度）              → piano-transcription
- separate   人声/乐器分离（可选增强）         → demucs + basic-pitch

GUI 与命令行只依赖本模块，切换模式即可。
"""

import os

# 模式定义：显示名 + 描述（GUI 用）
MODES = {
    "universal": ("通用识别", "任意歌曲 · 人声 · 多乐器（basic-pitch）"),
    "piano":     ("钢琴专用", "纯钢琴高精度 · 含踏板（piano-transcription）"),
    "separate":  ("人声分离", "分声部转录：人声/贝斯/乐器/鼓（需 demucs）"),
}

DEFAULT_MODE = "universal"

# 各模式默认参数（GUI 滑块与 CLI 共用基准）
DEFAULTS = {
    "universal": {
        "onset_threshold": 0.5,
        "frame_threshold": 0.3,
        "minimum_note_length": 128.0,
        "minimum_frequency": None,
        "maximum_frequency": None,
        "melodia_trick": True,
        "midi_tempo": 120.0,
        # 后处理（midi_post）：
        "merge_overlap": True,
        "merge_gap_ms": 30.0,
        "normalize_vel": True,
        # 智能音频预处理（可选）：
        "denoise": False,
        "normalize": False,
        "auto_bpm": False,
    },
    "piano": {
        "onset_threshold": 0.3,
        "frame_threshold": 0.1,
        "min_note_ms": 60,
        "merge_gap_ms": 40,
        "include_pedal": True,
        # 智能音频预处理（可选）：
        "denoise": False,
        "normalize": False,
    },
    "separate": {
        "onset_threshold": 0.5,
        "frame_threshold": 0.3,
        "minimum_note_length": 128.0,
        "include_drums": False,
        "midi_tempo": 120.0,
        # 智能音频预处理（可选）：
        "denoise": False,
        "normalize": False,
        "auto_bpm": False,
    },
}


def engine_available(mode):
    """该模式的引擎是否可用。"""
    if mode == "universal":
        from engine_basic import available
        return available()
    if mode == "piano":
        from engine_pt import available
        return available()
    if mode == "separate":
        import engine_separate
        return engine_separate.available() and _basic_ok()
    return False


def _basic_ok():
    from engine_basic import available
    return available()


def transcribe(audio_path, output_midi, mode=None, params=None, log_cb=None,
               perf_mode="quality"):
    """统一转录入口。

    参数:
        audio_path  输入音频（任意格式）
        output_midi 输出 .mid 路径
        mode        引擎模式（universal / piano / separate）
        params      参数字典（各模式默认值见 DEFAULTS）
        log_cb      日志回调 func(str)
        perf_mode   性能模式：quality(默认,全部核心) / balanced / fast（低配）
    返回:
        音符数量
    """
    import engine_perf
    engine_perf.apply_global(perf_mode)
    num_threads = engine_perf.resolve_threads(perf_mode)

    mode = mode or DEFAULT_MODE
    params = {**(DEFAULTS.get(mode, {})), **(params or {})}

    if mode == "piano":
        import engine_pt
        params["perf_mode"] = perf_mode   # 性能档 → engine_pt 批量前向上限（自适应）
        return engine_pt.transcribe_pt(audio_path, output_midi, log_cb=log_cb,
                                       num_threads=num_threads, **params)

    if mode == "separate":
        import engine_separate
        return engine_separate.transcribe_separate(
            audio_path, output_midi, params=params, log_cb=log_cb,
            num_threads=num_threads)

    # 默认 universal
    import engine_basic
    return engine_basic.transcribe_basic(audio_path, output_midi, log_cb=log_cb,
                                         num_threads=num_threads, **params)


def merge_params(mode, values):
    """把部分参数与默认值合并成完整参数字典（并清理 None/非法键）。"""
    merged = dict(DEFAULTS.get(mode, {}))
    if values:
        merged.update(values)
    return merged

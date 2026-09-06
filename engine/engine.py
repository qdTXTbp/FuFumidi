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
    "universal": ("通用识别", "任意歌曲 · 人声 · 多乐器（basic-pitch 兜底 / MuScriptor 可选）"),
    "piano":     ("钢琴专用", "纯钢琴高精度（piano-transcription / Aria-AMT / Transkun）"),
    "separate":  ("人声分离", "分声部转录：人声/贝斯/乐器/鼓（需 demucs）"),
}

DEFAULT_MODE = "universal"

# 通用转录子模型（universal 模式下的候选模型）
UNIVERSAL_MODELS = {
    "basic":    ("Basic Pitch", "Release 内置兜底模型"),
    "muscriptor": ("MuScriptor", "Kyutai 多乐器转录 · 资源中心下载 · Small/Medium/Large"),
}
MUSCRIPTOR_SIZES = ["small", "medium", "large"]

# 钢琴引擎子模型（piano 模式下的候选模型）
PIANO_MODELS = {
    "piano_pt": ("piano-transcription（ByteDance）", "内置模型"),
    "aria":     ("Aria-AMT（EleutherAI）", "资源中心下载"),
    "transkun": ("Transkun（Neural Semi-CRF）", "pip 安装含权重"),
}

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
        # 通用子模型：basic（默认 / Basic Pitch）| muscriptor（可选）
        "model": "basic",
        "model_size": "medium",
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
        # 任一子模型可用即可（basic 兜底 / muscriptor 可选）
        return _basic_ok() or _muscriptor_ok()
    if mode == "piano":
        from engine_pt import available
        return available()
    if mode == "separate":
        # 音频处理（MSST 分离）为独立引擎，不参与音频→MIDI 转录
        try:
            import engine_msst
            return bool(engine_msst.available())
        except Exception:
            return False
    return False


def _muscriptor_ok():
    try:
        import engine_muscriptor
        return engine_muscriptor.available()
    except Exception:
        return False


def piano_model_available(model):
    """钢琴子模型是否可用（piano_pt / aria / transkun）。"""
    if model == "aria":
        try:
            import engine_aria
            return engine_aria.available()
        except Exception:
            return False
    if model == "transkun":
        try:
            import engine_transkun
            return engine_transkun.available()
        except Exception:
            return False
    # 默认 piano_pt
    from engine_pt import available
    return available()


def _basic_ok():
    from engine_basic import available
    return available()


def _release_gpu_memory():
    """转录完成/中断后统一释放模型与显存。

    torch 的缓存分配器不会自动把已删除张量的显存归还给驱动，
    需显式 empty_cache()；否则模型卸载后显存仍被占用（用户直观感受「占显存」）。
    各引擎进程内加载的模型对象在 transcribe_* 返回后引用归零，
    这里的 gc.collect() + torch.cuda.empty_cache() 即可真正释放。
    """
    try:
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    except Exception:
        pass


def _apply_auto_bpm(midi_path, audio_path, log_cb=None):
    """统一 auto-BPM 后处理：从源音频测速并重写 MIDI 的 tempo 事件。

    用于未内置测速的子引擎（basic-pitch / MuScriptor / 钢琴系）——它们把 MIDI
    写成固定 120 BPM，导致播放/导出与原曲录音速度不符。basic（engine_basic）
    与分轨链路已内置测速，无需此步。
    """
    import os
    if not midi_path or not os.path.isfile(midi_path):
        return
    from audio_io import load_audio_float32
    from preprocess import detect_bpm
    try:
        wav = load_audio_float32(audio_path, 22050)
        bpm = detect_bpm(wav, 22050)
    except Exception as e:
        if log_cb:
            log_cb(f"[auto-bpm] 测速失败，保留默认速度: {e}")
        return
    if not bpm:
        if log_cb:
            log_cb("[auto-bpm] 测速失败，保留默认速度")
        return
    import mido
    mid = mido.MidiFile(midi_path)
    us = int(round(60_000_000 / float(bpm)))
    done = False
    for tr in mid.tracks:            # 转录输出至多一个 tempo，统一改写
        for msg in tr:
            if msg.type == 'set_tempo':
                msg.tempo = us
                done = True
    if not done:
        first = mid.tracks[0]
        first.insert(0, mido.MetaMessage('set_tempo', tempo=us, time=0))
    mid.save(midi_path)
    if log_cb:
        log_cb(f"[auto-bpm] 已按源音频自动测速：{bpm} BPM")


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
    auto_bpm = bool((params or {}).get("auto_bpm"))
    native_bpm = False   # 子引擎是否已内置测速（basic 是；其余统一走后处理）
    n = 0
    try:
        if mode == "piano":
            # 钢琴子模型：piano_pt（默认 / ByteDance）/ aria / transkun
            pmodel = (params or {}).get("model") or "piano_pt"
            if pmodel == "aria":
                import engine_aria
                n = engine_aria.transcribe_aria(audio_path, output_midi, params=params,
                                                log_cb=log_cb, num_threads=num_threads)
            elif pmodel == "transkun":
                import engine_transkun
                n = engine_transkun.transcribe_transkun(audio_path, output_midi, params=params,
                                                        log_cb=log_cb, num_threads=num_threads)
            else:
                import engine_pt
                params["perf_mode"] = perf_mode   # 性能档 → engine_pt 批量前向上限（自适应）
                n = engine_pt.transcribe_pt(audio_path, output_midi, log_cb=log_cb,
                                            num_threads=num_threads, **params)

        elif mode == "separate":
            # 音频处理（MSST 分离）已改为独立 `separate` 子命令（engine_msst），
            # 不再走「分离后转 MIDI」的转录链路。若被误调用则给出明确引导。
            raise RuntimeError(
                "音频处理（MSST 分离）已不再生成 MIDI。\n"
                "请使用新的「音频处理」面板输出分离音轨；需要转 MIDI 请用通用识别或钢琴专用模式。"
            )

        else:
            # 默认 universal：子模型 basic（Basic Pitch 兜底）| muscriptor（可选）
            umodel = (params or {}).get("model") or "basic"
            if umodel == "muscriptor":
                import engine_muscriptor
                n = engine_muscriptor.transcribe_muscriptor(audio_path, output_midi, params=params,
                                                             log_cb=log_cb, num_threads=num_threads)
            else:
                native_bpm = True   # basic 内置节拍测速
                n = engine_basic.transcribe_basic(audio_path, output_midi, log_cb=log_cb,
                                                  num_threads=num_threads, **params)

        if auto_bpm and not native_bpm:
            try:
                _apply_auto_bpm(output_midi, audio_path, log_cb)
            except Exception as e:
                if log_cb:
                    log_cb(f"[警告] 自动 BPM 应用失败，保留默认速度: {e}")
        return n
    finally:
        # 无论成功/异常，转录结束后释放模型对象与显存
        _release_gpu_memory()


def merge_params(mode, values):
    """把部分参数与默认值合并成完整参数字典（并清理 None/非法键）。"""
    merged = dict(DEFAULTS.get(mode, {}))
    if values:
        merged.update(values)
    return merged

# -*- coding: utf-8 -*-
"""
通用转录引擎：任意歌曲 / 人声 / 多乐器
========================================
基于 Spotify **basic-pitch**（ONNX 版，无需 TensorFlow）。
- 能从混音中同时识别多个音高（主旋律/人声 + 和弦 + 各类乐器），
  不再局限于纯钢琴。
- `melodia_trick` 开启后会对主旋律/人声做额外强化，更贴近听感。
- 任意音频格式：内部统一经 audio_io 解码为 22050Hz 单声道 WAV。
"""

import os


def available():
    """basic-pitch 是否安装。"""
    try:
        import basic_pitch  # noqa: F401
        return True
    except Exception:
        return False


def transcribe_basic(audio_path, output_midi,
                     onset_threshold=0.5,
                     frame_threshold=0.3,
                     minimum_note_length=128.0,
                     minimum_frequency=None,
                     maximum_frequency=None,
                     melodia_trick=True,
                     midi_tempo=120.0,
                     num_threads=None,
                     log_cb=None,
                     **kwargs):
    """用 basic-pitch 把任意歌曲转录为 MIDI。

    参数:
        onset_threshold       起音阈值，越小越灵敏（默认 0.5）
        frame_threshold       音符判定阈值，越大过滤杂音越多（默认 0.3）
        minimum_note_length   最短音符时长(ms)，短于此被过滤（默认 128）
        minimum_frequency     最低音高 Hz；0 或 None 表示不限（默认 None）
        maximum_frequency     最高音高 Hz；0 或 None 表示不限（默认 None）
        melodia_trick         旋律增强（人声/主旋律更突出，默认 True）
        midi_tempo            导出 MIDI 的节拍速度 BPM（默认 120）
        num_threads           onnxruntime 推理线程数（None=用全部核心）

    返回:
        识别出的音符数量
    """
    from basic_pitch.inference import predict
    from engine_perf import make_basic_model

    from audio_io import decode_to_wav, remove_temp

    # 可选智能预处理：降噪 / 响度平衡 / 自动 BPM
    denoise_on = bool(kwargs.get("denoise", False))
    normalize_on = bool(kwargs.get("normalize", False))
    auto_bpm = bool(kwargs.get("auto_bpm", False))

    _log(log_cb, f"解码音频 → 22050Hz …")
    wav = decode_to_wav(audio_path, 22050)
    try:
        if denoise_on or normalize_on:
            from preprocess import process_wav_file
            wav = process_wav_file(wav, 22050, denoise_on, normalize_on, log_cb)
        if auto_bpm:
            from preprocess import bpm_of_file
            detected = bpm_of_file(wav, 22050)
            if detected:
                _log(log_cb, f"智能预处理 · 检测到 BPM = {detected}")
                midi_tempo = float(detected)
        _log(log_cb, f"推理识别中（basic-pitch 通用模型）…")
        _model_output, midi_data, note_events = predict(
            wav,
            make_basic_model(num_threads),
            onset_threshold=float(onset_threshold),
            frame_threshold=float(frame_threshold),
            minimum_note_length=float(minimum_note_length),
            minimum_frequency=_none_or(minimum_frequency),
            maximum_frequency=_none_or(maximum_frequency),
            melodia_trick=bool(melodia_trick),
            midi_tempo=float(midi_tempo),
        )
        # 后处理：合并同音高碎片 / 力度归一化（可开关）
        try:
            from midi_post import apply_post
            apply_post(midi_data, kwargs, log_cb=log_cb)
        except Exception:
            pass

        out_dir = os.path.dirname(os.path.abspath(output_midi))
        os.makedirs(out_dir, exist_ok=True)
        _log(log_cb, f"保存 MIDI → {os.path.basename(output_midi)}")
        midi_data.write(output_midi)
        return _count_notes(midi_data) or len(note_events)
    finally:
        remove_temp(wav)


def _count_notes(midi):
    try:
        return sum(len(inst.notes) for inst in midi.instruments)
    except Exception:
        return 0


def _none_or(v):
    """把 0 或空值转成 None（basic-pitch 中 None 表示不限频率）。"""
    if v is None:
        return None
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _log(cb, msg):
    if cb:
        try:
            cb(msg)
        except Exception:
            pass

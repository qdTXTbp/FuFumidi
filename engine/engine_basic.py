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

import pause_gate


def _install_audio_input_gate(inference_module=None):
    """把暂停闸门挂到 basic-pitch 的**取窗生成器**上（只挂一次，不叠加）。

    basic-pitch 的 `predict()` 是「一次调用跑完整首」，但它的取窗生成器
    `basic_pitch.inference.get_audio_input()` 是模块级生成器：每 yield 一个窗（约 1.6 秒
    音频）之前过一下闸门，就等于把断点放在"窗与窗之间"——窗的推理是下游"要下一个窗"时
    才发生的，所以停下时已算的窗都还在 `_predict` 的 output 列表里，继续时**从原处接着算**。

    包装器**不许**捕获 log_cb：worker 常驻、只挂一次，log_cb 却每次都不同（见 pause_gate 模块）。
    """
    if inference_module is None:
        from basic_pitch import inference as inference_module
    if getattr(inference_module, '_fufumidi_pause_wrapped', False):
        return
    _orig = inference_module.get_audio_input

    def _gated(*a, **kw):
        for item in _orig(*a, **kw):
            pause_gate.wait()
            yield item

    inference_module.get_audio_input = _gated
    inference_module._fufumidi_pause_wrapped = True


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
                     multiple_pitch_bends=False,
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
        multiple_pitch_bends  True = 同一音符可以挂**多条**弯音曲线（颤音 / 滑音）。
                              basic-pitch 的默认是 False，我们过去没转发它 —— 所以一直按默认走。
                              开了会**真的落进导出的 MIDI**（midi_post 不动 pitch_bends，
                              播放端 fluidsynth 认弯音）。对唱腔 / 弦乐等有滑音的材料有用；
                              对钢琴、鼓这类是纯噪声（会多出大量弯音事件）。
        midi_tempo            导出 MIDI 的节拍速度 BPM（默认 120）
        num_threads           onnxruntime 推理线程数（None=用全部核心）

    返回:
        识别出的音符数量
    """
    from basic_pitch.inference import predict
    from engine_perf import make_basic_model

    from audio_io import decode_to_wav, remove_temp

    # ★ 转录中途暂停 / 继续（用户 2026-10-14 要求，见 pause_gate 模块）：
    #   basic-pitch 是一次调用跑完整首，但它的取窗生成器可以包 —— 停点落在「窗与窗之间」。
    pause_gate.install(log_cb)
    _install_audio_input_gate()

    # 可选：自动 BPM（降噪/电平统一已经合并进下面的「转录前音频链」，不再各管一段）
    auto_bpm = bool(kwargs.get("auto_bpm", False))

    _log(log_cb, f"解码音频 → 22050Hz …")
    wav = decode_to_wav(audio_path, 22050)
    try:
        # ★ 转录前音频链（2026-10-15 方案 A/B）：高通 → 降噪 → 电平统一。
        #   （旧路径用的是 preprocess.process_wav_file：前 0.3 秒估噪的谱减法 + 可选响度归一，
        #     实测会把现场音乐从 69 个音符变成 0 个；电平也不再随素材漂。）
        try:
            import audio_chain as _ac
            _ac.process_wav_inplace(wav, 22050, kwargs, log_cb,
                                    strong_runner=_ac.make_strong_runner(log_cb))
        except Exception as _e:
            _log(log_cb, "[预处理] 音频链失败，按原始音频继续：%s" % _e)
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
            multiple_pitch_bends=bool(multiple_pitch_bends),
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

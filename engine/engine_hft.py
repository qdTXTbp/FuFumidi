# -*- coding: utf-8 -*-
"""hFT-Transformer 钢琴转录（可选引擎，资源中心下载权重）
================================================================
Sony ISMIR2023 hFT-Transformer，MIT License。权重 22 MB，CPU 可跑。
模型代码见 hft_model.py（vendored）；推理封装见 hft_amt.py。

权重目录约定：<FUFUMIDI_MODELS_DIR>/hft_transformer/checkpoint/MAESTRO-V3/model_016_003.pkl
运行时/权重一律不随安装包分发，由 main/models.js 的统一安装通道下载；
运行时相关的公共能力（路径、torchaudio 补丁、设备、线程、暂停闸门）见
transcribe_runtime.py —— 本文件只留 hFT 自己的推理逻辑。
"""
import os
import sys
import time
import pickle
import types

import transcribe_runtime as TR

_RUNTIME = "hft_transformer"
_MODEL_REL = os.path.join("hft_transformer", "checkpoint", "MAESTRO-V3", "model_016_003.pkl")
_AMT_DIR = os.path.dirname(os.path.abspath(__file__))


def find_model():
    """定位 hFT 权重（资源中心解包后的固定相对路径）。"""
    models_dir = TR.models_dir()
    if not models_dir:
        return None
    p = os.path.join(models_dir, _MODEL_REL)
    return p if os.path.isfile(p) and os.path.getsize(p) > 1_000_000 else None


def available():
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        import soundfile  # noqa: F401
        import pretty_midi  # noqa: F401
    except Exception:
        return False
    return find_model() is not None


def _load_model(model_path):
    """pkl 里保存的是 CUDA 张量；用 torch.load patch 强制映射到 CPU。"""
    import torch
    import hft_model
    if _AMT_DIR not in sys.path:
        sys.path.insert(0, _AMT_DIR)
    # pickle 引用 model.model_spec2midi.*，映射到本文件旁的 hft_model
    pkg = types.ModuleType("model")
    pkg.model_spec2midi = hft_model
    sys.modules["model"] = pkg
    sys.modules["model.model_spec2midi"] = hft_model
    _orig_load = torch.load

    def _cpu_load(*args, **kwargs):
        kwargs["map_location"] = "cpu"
        try:
            kwargs["weights_only"] = False
        except Exception:
            pass
        return _orig_load(*args, **kwargs)

    torch.load = _cpu_load
    try:
        with open(model_path, "rb") as f:
            model = pickle.load(f)
    finally:
        torch.load = _orig_load
    model = model.to("cpu")
    model.eval()
    for mod in model.modules():
        if hasattr(mod, "device"):
            mod.device = "cpu"
    return model


def _sf_load(path, **kwargs):
    import torch
    import soundfile as sf
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(data.T), sr


def transcribe_hft(audio_path, output_midi, params=None, log_cb=None, num_threads=None):
    import torch
    import torchaudio
    import pretty_midi  # noqa: F401
    import audio_io

    params = params or {}
    # 统一运行时层：线程上限 + torchaudio 补丁 + 暂停闸门
    threads = TR.limit_threads(num_threads)
    TR.patch_torchaudio_soundfile()
    TR.install_pause(log_cb)
    if log_cb:
        log_cb("hFT-Transformer：5.5M 参数，CPU 推理（MIT License）"
               + ("，线程 %d" % threads if threads else ""))

    model_path = find_model()
    if not model_path:
        raise RuntimeError(
            "未找到 hFT-Transformer 权重。请到「资源中心 → 转录模型」下载 hFT-Transformer（约 22 MB）。"
        )

    import hft_amt
    config = {
        "feature": {"sr": 16000, "hop_sample": 256, "mel_bins": 256, "n_bins": 256,
                    "fft_bins": 2048, "window_length": 2048, "log_offset": 1e-8,
                    "window": "hann", "pad_mode": "constant"},
        "input": {"margin_b": 32, "margin_f": 32, "num_frame": 128,
                  "min_value": 0.0, "max_value": 0.0},
        "midi": {"note_min": 21, "note_max": 108, "num_note": 88, "num_velocity": 128},
    }

    tmp_wav = None
    t_all = time.perf_counter()
    try:
        tmp_wav = audio_io.decode_to_wav(audio_path, 16000)
        if log_cb:
            log_cb("hFT：音频解码完成（16 kHz 单声道）")
        amt = hft_amt.AMT(config, None)       # 先只建空对象
        amt.model = _load_model(model_path)   # 权重加载（CPU 映射）
        amt.device = "cpu"
        # hFT 的 wav2feature 用 torchaudio.load；补丁已在上面统一装好，
        # 这里再兜一次（补丁是幂等的，重复装无副作用）。
        _orig_load = torchaudio.load
        torchaudio.load = _sf_load
        try:
            feat = amt.wav2feature(tmp_wav)
        finally:
            torchaudio.load = _orig_load
        if log_cb:
            log_cb("hFT：特征 %s，开始推理" % (tuple(feat.shape),))
        t_inf = time.perf_counter()
        out = amt.transcript(feat, mode="combination")
        _a_onset, _a_off, _a_mpe, _a_vel, o_onset, o_off, o_mpe, o_vel = out
        onset_th = float(params.get("onset_threshold", 0.5) or 0.5)
        frame_th = float(params.get("frame_threshold", 0.5) or 0.5)
        notes = amt.mpe2note(
            a_onset=o_onset, a_offset=o_off, a_mpe=o_mpe, a_velocity=o_vel,
            thred_onset=onset_th, thred_offset=frame_th, thred_mpe=frame_th,
            mode_velocity="ignore_zero", mode_offset="shorter",
        )
        if len(notes) == 0:
            # 高阈值有时会把弱奏整段滤空；用更保守的阈值重试一次，避免产出空 MIDI
            notes = amt.mpe2note(
                a_onset=o_onset, a_offset=o_off, a_mpe=o_mpe, a_velocity=o_vel,
                thred_onset=0.3, thred_offset=0.3, thred_mpe=0.3,
                mode_velocity="ignore_zero", mode_offset="shorter",
            )
        amt.note2midi(notes, output_midi)
        n = len(notes)
        if log_cb:
            log_cb("hFT：推理 %.1fs，输出 %d 个音符 → %s"
                   % (time.perf_counter() - t_inf, n, os.path.basename(output_midi)))
        return n
    finally:
        if tmp_wav:
            try:
                audio_io.remove_temp(tmp_wav)
            except Exception:
                pass
        TR.release_gpu()
        TR.log_timing(log_cb, "hFT-Transformer 总计", t_all)

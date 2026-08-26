# -*- coding: utf-8 -*-
"""
智能音频预处理（可选，不影响原流程）
====================================
- 降噪：谱减法（scipy STFT），用前 0.3s 估计噪声谱后扣除
- 响度平衡：整体 RMS 归一，输出更贴近真人演奏的动态
- BPM 检测：librosa 节拍追踪，自动作为导出 MIDI 的速度

均为可选开关，关闭时与原工具行为完全一致。
"""


def denoise(wav, sr, amount=0.5):
    """谱减法降噪（amount 0~1，越大越激进）。返回 float32 数组。"""
    try:
        import numpy as np
        from scipy.signal import stft, istft
    except Exception:
        return wav
    wav = np.asarray(wav, dtype="float32")
    if len(wav) < 2048:
        return wav
    nperseg = min(512, max(256, len(wav) // 4))
    n_noise = max(int(0.3 * sr), nperseg)
    n_noise = min(n_noise, len(wav) // 4)
    noise = wav[:n_noise]
    f, t, Z = stft(wav, fs=sr, nperseg=nperseg)
    _, _, N = stft(noise, fs=sr, nperseg=nperseg)
    noise_mag = np.abs(N).mean(axis=1, keepdims=True)
    mag = np.abs(Z)
    phase = np.angle(Z)
    thresh = noise_mag * (1.2 + 1.8 * float(amount))
    mag = np.maximum(mag - thresh, 0.0)
    Z2 = mag * np.exp(1j * phase)
    _, out = istft(Z2, fs=sr, nperseg=nperseg)
    out = out[:len(wav)]
    return np.asarray(out, dtype="float32")


def normalize_loudness(wav, target_rms=0.06):
    """响度平衡：缩放使整体 RMS 接近 target_rms。返回 float32 数组。"""
    import numpy as np
    wav = np.asarray(wav, dtype="float32")
    rms = float(np.sqrt(np.mean(wav ** 2) + 1e-8))
    if rms <= 1e-5:
        return wav
    return (wav * (target_rms / rms)).astype("float32")


def detect_bpm(wav, sr):
    """librosa 节拍追踪检测 BPM；失败或不在 40~240 范围返回 None。"""
    try:
        import numpy as np
        import librosa
        tempo, _ = librosa.beat.beat_track(y=wav, sr=sr)
        tempo = float(np.atleast_1d(tempo)[0])
        if 40 <= tempo <= 240:
            return int(round(tempo))
    except Exception:
        pass
    return None


def read_wav_float(path, sr):
    """读 WAV 为 float32 单声道数组（供检测/处理）。"""
    import numpy as np
    import soundfile as sf
    data, sr0 = sf.read(path, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr0 != sr:
        data = _resample(data, sr0, sr)
    return np.asarray(data, dtype="float32")


def _resample(data, sr0, sr):
    try:
        import librosa
        return librosa.resample(data, orig_sr=sr0, target_sr=sr)
    except Exception:
        import numpy as np
        n = int(round(len(data) * sr / sr0))
        x_old = np.linspace(0, 1, len(data), endpoint=False)
        x_new = np.linspace(0, 1, n, endpoint=False)
        return np.interp(x_new, x_old, data).astype(data.dtype)


def process_wav_file(path, sr, denoise_on=False, normalize_on=False, log_cb=None):
    """读 WAV → 可选降噪/响度归一 → 写回同一临时文件。返回同一路径。"""
    import numpy as np
    import soundfile as sf
    data = read_wav_float(path, sr)
    if denoise_on:
        _log(log_cb, "智能预处理 · 降噪 …")
        data = denoise(data, sr)
    if normalize_on:
        _log(log_cb, "智能预处理 · 响度平衡 …")
        data = normalize_loudness(data)
    sf.write(path, data, sr, subtype="PCM_16")
    return path


def bpm_of_file(path, sr):
    """读 WAV 检测 BPM（返回 int 或 None）。"""
    try:
        data = read_wav_float(path, sr)
        return detect_bpm(data, sr)
    except Exception:
        return None


def _log(cb, msg):
    if cb:
        try:
            cb(msg)
        except Exception:
            pass

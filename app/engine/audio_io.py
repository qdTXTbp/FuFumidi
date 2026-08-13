# -*- coding: utf-8 -*-
"""
音频解码层：把「任意格式」的音频/视频解码为各转录引擎需要的 WAV 或采样数组。
================================================================================
- soundfile 直接支持 WAV / FLAC / OGG / AIFF 等无损格式（进程内转换，最快最稳）
- 其余一切格式（MP3 / M4A / AAC / OPUS / M4S / MP4 / MKV / 视频 …）交给 ffmpeg，
  本工具内置 imageio-ffmpeg 静态版，无需手动安装 ffmpeg。
- 因此对外表现为「原生支持所有格式」。
"""

import os
import subprocess
import tempfile

# 转录可接受的扩展名（音频 + 常见含音频轨的视频）
AUDIO_EXTENSIONS = {
    ".wav", ".wave", ".mp3", ".flac", ".ogg", ".oga", ".opus",
    ".m4a", ".aac", ".mp4", ".aiff", ".aif", ".au", ".snd", ".caf",
    ".webm", ".wma", ".wmv", ".m4s", ".m4v", ".mov", ".mkv", ".ts",
    ".mpg", ".mpeg", ".avi", ".flv", ".3gp", ".amr", ".mka", ".ra", ".rm",
}

# 播放器（MIDI 播放页）可打开的 MIDI 文件扩展名
MIDI_EXTENSIONS = {".mid", ".midi", ".kar", ".rmi"}


def find_ffmpeg():
    """返回可用的 ffmpeg 路径（系统自带或 imageio-ffmpeg 内置）。"""
    import shutil
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        try:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            ffmpeg = None
    return ffmpeg


def ffmpeg_to_wav(src, sr, mono=True, extra=()):
    """用 ffmpeg 把任意媒体解码为指定采样率的 WAV 临时文件。

    返回临时文件路径，调用方负责删除（用 remove_temp()）。
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(
            "未找到 ffmpeg，无法解码该格式。请双击运行 install.bat 完成依赖安装。"
        )

    fd, tmp = tempfile.mkstemp(prefix="midi_tool_", suffix=".wav")
    os.close(fd)
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
           "-i", src, "-vn"]
    if mono:
        cmd += ["-ac", "1"]
    cmd += ["-ar", str(sr), "-c:a", "pcm_s16le", *extra, tmp]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=3600)
    except Exception as e:  # 超时 / 无法启动
        _try_remove(tmp)
        raise RuntimeError(f"ffmpeg 解码异常: {e}")

    if result.returncode != 0 or not os.path.isfile(tmp):
        err = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        err = err or (result.stdout or b"").decode("utf-8", errors="replace").strip()
        _try_remove(tmp)
        raise RuntimeError(f"音频解码失败: {err[:300]}")
    return tmp


def decode_to_wav(src, sr):
    """把任意音频解码为指定采样率的 16bit 单声道 WAV 临时文件路径。

    WAV / FLAC / OGG / AIFF 走 soundfile 进程内转换；其余走 ffmpeg。
    返回值是一个临时文件，用完请调用 remove_temp() 删除。
    """
    ext = os.path.splitext(src)[1].lower()
    if ext in (".wav", ".wave", ".flac", ".ogg", ".oga", ".aiff", ".aif", ".opus"):
        try:
            import numpy as np
            import soundfile as sf
            data, sr0 = sf.read(src, dtype="float32", always_2d=True)
            if data.shape[1] > 1:
                data = data.mean(axis=1)
            else:
                data = data[:, 0]
            if sr0 != sr:
                data = _resample(data, sr0, sr)
            fd, tmp = tempfile.mkstemp(prefix="midi_tool_", suffix=".wav")
            os.close(fd)
            sf.write(tmp, data, sr, subtype="PCM_16")
            return tmp
        except Exception:
            pass  # 走 ffmpeg 兜底
    return ffmpeg_to_wav(src, sr, mono=True)


def load_audio_float32(src, sr):
    """读取任意格式音频为 float32 单声道数组（重采样到 sr）。

    供钢琴引擎（需要 16k 数组）等直接处理数组的引擎使用。
    """
    try:
        import librosa
        return librosa.load(src, sr=sr, mono=True)[0].astype("float32")
    except Exception:
        pass
    wav = decode_to_wav(src, sr)
    try:
        import numpy as np
        import soundfile as sf
        data, _ = sf.read(wav, dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        return data.astype("float32")
    finally:
        _try_remove(wav)


def _resample(data, sr0, sr):
    """librosa 高质量重采样（丢失时退回线性插值）。"""
    try:
        import librosa
        return librosa.resample(data, orig_sr=sr0, target_sr=sr)
    except Exception:
        import numpy as np
        n = int(round(len(data) * sr / sr0))
        x_old = np.linspace(0, 1, len(data), endpoint=False)
        x_new = np.linspace(0, 1, n, endpoint=False)
        return np.interp(x_new, x_old, data).astype(data.dtype)


def _try_remove(path):
    try:
        if path and os.path.isfile(path):
            os.remove(path)
    except Exception:
        pass


def remove_temp(path):
    """删除临时文件（幂等，绝不抛错）。"""
    _try_remove(path)

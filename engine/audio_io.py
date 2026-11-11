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

# 最近一次解码耗时（秒）：转录引擎完成后由 engine.transcribe 读取并上报 [计时] 日志
LAST_DECODE_SEC = 0.0

# 本模块所有临时文件/目录统一用这个前缀，便于启动时批量回收
TEMP_PREFIX = "midi_tool_"
# 回收阈值：超过这个时长仍留在临时目录的，视为上次异常退出（进程被强杀）留下的
STALE_TEMP_HOURS = 6


def sweep_stale_temp(max_age_hours=STALE_TEMP_HOURS):
    """清掉系统临时目录里本应用遗留的临时文件/目录，返回清理项数。

    正常路径下每个临时文件都在调用方的 finally 里删掉了；但引擎进程被强杀
    （取消转录 / 超时 / 崩溃）时 finally 不会执行 —— 而解码出来的 WAV 是整首歌
    （单文件上百 MB），demucs 的声部目录更大，堆在 %TEMP% 里会一直涨。
    实测遗留 12 个 midi_tool_*.wav 共 1.34 GB。
    """
    import glob
    import shutil
    import time
    root = tempfile.gettempdir()
    cutoff = time.time() - max_age_hours * 3600
    n = 0
    for p in glob.glob(os.path.join(root, TEMP_PREFIX + "*")):
        try:
            # 刚生成的可能正被别的进程使用，只回收"明显过期"的
            if os.path.getmtime(p) > cutoff:
                continue
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                os.remove(p)
            n += 1
        except Exception:
            pass
    return n


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

    fd, tmp = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=".wav")
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
    global LAST_DECODE_SEC
    import time as _time
    _t0 = _time.perf_counter()
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
            fd, tmp = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=".wav")
            os.close(fd)
            sf.write(tmp, data, sr, subtype="PCM_16")
            LAST_DECODE_SEC = _time.perf_counter() - _t0
            return tmp
        except Exception:
            pass  # 走 ffmpeg 兜底
    out = ffmpeg_to_wav(src, sr, mono=True)
    LAST_DECODE_SEC = _time.perf_counter() - _t0
    return out


def _ffmpeg_wav_keep_shape(src):
    """ffmpeg 解码为「原始采样率、原始声道数」的 PCM16 WAV 临时文件。

    ★ 与 ffmpeg_to_wav 的区别：**不加 -ar / -ac** —— 采样率与声道数原样保留，
    下混与重采样全部留给 muscriptor 官方 load_audio（float 域 mean + julius sinc）。
    位深取 pcm_s16le：bench3 隔离实验证明经官方重采样路径时位深不影响质量
    （48k PCM16 → 官方 = 5 乐器组 / 1472 音符）。
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(
            "未找到 ffmpeg，无法解码该格式。请双击运行 install.bat 完成依赖安装。"
        )

    fd, tmp = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=".wav")
    os.close(fd)
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
           "-i", src, "-vn", "-c:a", "pcm_s16le", tmp]

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


def _official_loadable(src):
    """判断 muscriptor 官方 load_audio 能否原生读这个文件。

    官方分发逻辑（muscriptor/utils/audio.py load_audio，0.3.0 逐字核对）：
      1) 先用 stdlib wave 读（按内容判定，wave.Error / EOFError 才往下走）；
      2) 其余交给 soundfile（float32 读，同样按内容判定）。
    这里用**完全相同的两个读取器**做探针 —— 同一解释器、同一库版本，
    探针通过 = 官方能读，我们就可以原样交文件、不做任何 DSP。
    """
    import wave as _wave
    try:
        with _wave.open(str(src), "rb") as wf:
            if (wf.getnchannels() >= 1 and wf.getframerate() > 0
                    and wf.getsampwidth() in (1, 2, 3, 4)):
                return True
    except (getattr(_wave, "Error", Exception), EOFError):
        pass
    try:
        import soundfile as _sf
        info = _sf.info(str(src))
        return bool(info.frames > 0 and info.samplerate > 0)
    except Exception:  # noqa: BLE001
        return False


def prepare_for_muscriptor(src):
    """把任意音频准备成 muscriptor 官方推理路径的最优输入。

    ★★ 2026-11-07 质量修复（用户报障「转出来只有钢琴、音色一段一段」的根因）：
      官方训练分布的输入 = 原始采样率文件 → float32 → **julius sinc** 重采样到 16k。
      旧做法 decode_to_wav(src, 16000) 自己做 librosa/线性插值重采样 + PCM16 量化，
      绕开了官方重采样器 → 输入分布偏离训练。bench3 隔离 A/B（同一段 30s 音频）：
        原始 48k 交官方路径            5 乐器组 / 1472 音符
        预解码 16k FLOAT（线性插值）    3 组 / 1535
        预解码 16k PCM16（旧引擎现状）  2 组 / 425（吉他/贝斯整轨消失）
      位深与声道已排除（同实验隔离），唯一变量就是「谁来做重采样」。
    因此这里**不做任何重采样/下混/位深转换**：
      · 官方能原生读的（PCM WAV / soundfile 可读格式）→ 原文件直接交；
      · 官方读不了的（非标准 MP3 / 改名容器 / 损坏头，3.2.6 热修覆盖的场景）→
        ffmpeg 转成「原始采样率、原始声道数」的 PCM16 WAV（不加 -ar/-ac），
        重采样与下混仍由官方路径完成。
    返回 (path, is_temp)；is_temp=True 时调用方负责 remove_temp()。
    """
    if os.path.isfile(src) and _official_loadable(src):
        return src, False
    return _ffmpeg_wav_keep_shape(src), True


def add_lead_in(src, seconds=0.2):
    """在信号前补一段静音，返回 (临时 wav 路径, 实际补的秒数)；失败返回 (None, 0.0)。

    ★ 边界对齐修正，来自 DamRsn/muscriptor.cpp 的 `Transcriber`（NeuralNote v2 的
      C++/ggml 引擎）：官方 Python 实现把「chunk 开头已经在响的声音」当成需要续的
      tie prologue，drum hit 不发出，于是块首的鼓被整段吞掉；补一段静音并把所有
      上报时间减掉它，可让每个 5 秒块的开头落在静音上。
      2026-11-11 实测（NightTheater 前 30s，medium/CPU）：空鼓块 2→0、
      鼓 236→331、耗时不增，且仍是贪心解码（结果可复现）。

    实现约束（6.4.6 踩过的坑）：**绝不重采样/下混/改位深** —— subtype 跟随源文件，
    逐块流式复制，内存恒定；重采样仍由官方 load_audio 的 julius sinc 完成。
    失败一律返回 None 让调用方退回原路径，绝不能拖垮转录。
    """
    out = None
    try:
        import numpy as np
        import soundfile as sf
        info = sf.info(str(src))
        if info.frames <= 0 or info.samplerate <= 0:
            return None, 0.0
        pad_frames = int(round(seconds * info.samplerate))
        if pad_frames <= 0:
            return None, 0.0
        fd, out = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=".wav")
        os.close(fd)
        with sf.SoundFile(str(src)) as inf, sf.SoundFile(
                out, mode="w", samplerate=info.samplerate,
                channels=info.channels, subtype=info.subtype or "FLOAT") as of:
            of.write(np.zeros((pad_frames, info.channels), dtype="float32"))
            for block in inf.blocks(blocksize=65536, dtype="float32"):
                of.write(block)
        return out, float(pad_frames) / float(info.samplerate)
    except Exception:  # noqa: BLE001
        _try_remove(out)
        return None, 0.0


def load_audio_float32(src, sr):
    """读取任意格式音频为 float32 单声道数组（重采样到 sr）。

    供钢琴引擎（需要 16k 数组）等直接处理数组的引擎使用。

    注意：一律先经 decode_to_wav（soundfile 快速通道 / imageio-ffmpeg 静态 ffmpeg）
    解码，绝不依赖 librosa.load → audioread 的系统解码后端。打包后的应用若机器上
    未安装 ffmpeg，librosa 会抛 NoBackendError；此处则始终能走内置 ffmpeg。
    """
    wav = decode_to_wav(src, sr)
    try:
        import numpy as np
        import soundfile as sf
        data, _ = sf.read(wav, dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        return np.asarray(data, dtype="float32")
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

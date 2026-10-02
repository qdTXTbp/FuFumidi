# -*- coding: utf-8 -*-
"""音频容器的读写 —— **照搬** `OpenUtau.Core/Format/Wave.cs`（173 行）。

C# 的 `Wave` 是 NAudio 的门面：`OpenFile` 按**文件头魔数**分派到 wav / mp3 /
ogg(vorbis 或 opus) / flac / aiff / m4a 各自的解码器，`GetSamples` 再把任意采样率
重采样到 44100 并交出 `float[]`。

本包只照搬**渲染链路真正用到的那三件事**：读单声道样本、写 16 位 WAV 缓存文件、
把疑似整数量化的样本缩回 ±1。其余是编辑器波形显示（M3）。

## 与 C# 的载体差异（不是行为差异）
1. **解码后端可注入**：`WaveHost.decode_mono(path) -> List[float]` 顶替
   `OpenFile(p).ToSampleProvider().ToMono(1, 0)` 这条 NAudio 链。
   默认实现只认 **44.1kHz 的 PCM WAV**（stdlib `wave`），正好覆盖 UTAU 音源的
   绝大多数情况；其它容器（mp3/ogg/flac/aiff/m4a）或**非 44.1kHz** 一律**明确报错**，
   由宿主注入 ffmpeg 之类的解码器（项目已有 `engine/ffmpeg_wrap.py` 可复用）。
   ★ 不静默重采样：C# 的 `WdlResamplingSampleProvider` 是自研重采样器，
   照搬它等于自研 DSP，违背方针；宁可报错也不给错采样率的数据。
2. **单声道化**：C# 是 NAudio 的 `ToMono(1, 0)`；默认解码器取**第 0 声道**
   （UTAU 音源基本是单声道，这条差异在实践中不可见）。
3. **`WriteMono16Wav`**：C# 用 `WaveFileWriter`；这里用 stdlib `wave`，
   样本换算逐位照搬（先夹到 ±1，再 `(short)(v * short.MaxValue)` 向零截断）。
4. **`DiscreteSignal` 返回值去掉**：C# 的 `GetSignal` 返回 NWaves 信号对象，
   这里只保留样本数组（本包里没有 NWaves 的 `DiscreteSignal`）。
5. **未搬**（编辑器侧 M3）：`BuildPeaks`（波形峰值图）、`GetStereoSamples`
   （只被波形读取用）、`GetSignal`、`OverrideMp3Reader`。
"""

import array
import struct
import wave
from typing import List

#: C# 里所有渲染样本都固定在这个采样率（`Wave.GetSamples` 会重采样过来）
SAMPLE_RATE = 44100


class WaveHost:
    """`Wave.OpenFile` 的解码后端（NAudio 的替身）。

    `decode_mono` 的契约就是 C# 那条链的结果：**44.1kHz、单声道、±1 浮点**。
    上层只需替换/继承这个宿主即可接入 ffmpeg 之类的解码器。
    """

    #: 目标采样率（对应 `Wave.GetSamples` 里写死的 44100）
    sample_rate: int = SAMPLE_RATE

    def decode_mono(self, path: str) -> List[float]:
        """解码成 44.1kHz 单声道浮点样本。"""
        return _decode_pcm_wav_mono(path, self.sample_rate)


#: 当前宿主。主程序在启动时替换它即可换解码器。
host = WaveHost()


class Wave:
    """对应 C# 的静态类 `Wave`。"""

    @staticmethod
    def get_samples(path: str) -> List[float]:
        """对应 `Wave.GetSamples(Wave.OpenFile(path).ToSampleProvider().ToMono(1, 0))`。

        ★ 入参是**路径**而不是 C# 的 `ISampleProvider`：整条 NAudio 链在 Python 侧
        折叠进 `host.decode_mono`（见模块 docstring 的差异 1）。调用点因此读起来与
        C# 略有不同，但语义一致。
        """
        return host.decode_mono(path)

    @staticmethod
    def write_mono16_wav(path: str, samples: List[float]) -> None:
        """把 44.1kHz 单声道浮点缓冲写成 16 位 WAV —— **渲染缓存文件就是它**。

        换算逐位照搬 C#：先夹到 ±1，再 `(short)(v * short.MaxValue)`。
        """
        pcm = bytearray(len(samples) * 2)
        for i, sample in enumerate(samples):
            v = sample
            if v > 1.0:
                v = 1.0
            if v < -1.0:
                v = -1.0
            # C# 的 `(short)` 是**向零截断**（不是四舍五入）；Python 的 int() 同语义
            s = int(v * 32767)
            struct.pack_into('<h', pcm, i * 2, s)
        with wave.open(path, 'wb') as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(SAMPLE_RATE)
            writer.writeframes(bytes(pcm))

    @staticmethod
    def correct_sample_scale(samples: List[float]) -> None:
        """照搬 `CorrectSampleScale`：**就地**把疑似整数量化的样本缩回 ±1。

        判据（别"整理"）：峰值 > 2^23 认为是 32 位整数、> 8 认为是 16 位整数。
        `samples` 为空时 C# 的 `Max()` 会抛异常，这里同样抛。
        """
        max_v = max(samples)
        scale = 1.0
        if max_v > 2 ** 23:
            scale = 0.5 ** 31          # 32 bit
        elif max_v > 8:
            scale = 0.5 ** 15          # 16 bit
        for i in range(len(samples)):
            samples[i] *= scale


def _decode_pcm_wav_mono(path: str, sample_rate: int) -> List[float]:
    """默认解码器：44.1kHz PCM WAV → 单声道浮点。

    C# 那条链里 `ConvertWaveProviderIntoSampleProvider` 的换算比例照搬：
    8 位无符号 `(b-128)/128`、16 位 `/32768`、24 位 `/8388608`、32 位 `/2147483648`。
    """
    with wave.open(path, 'rb') as reader:
        channels = reader.getnchannels()
        sampwidth = reader.getsampwidth()
        framerate = reader.getframerate()
        raw = reader.readframes(reader.getnframes())

    if framerate != sample_rate:
        raise ValueError(
            '采样率 %d Hz 不受支持（只认 %d Hz）：%s；'
            '请在 WaveHost.decode_mono 里注入解码/重采样后端' % (framerate, sample_rate, path))

    if sampwidth == 1:
        samples = [(b - 128) / 128.0 for b in raw]
    elif sampwidth == 2:
        values = array.array('h')
        values.frombytes(raw)
        samples = [v / 32768.0 for v in values]
    elif sampwidth == 3:
        samples = []
        for i in range(0, len(raw) - 2, 3):
            v = raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16)
            if v & 0x800000:
                v -= 0x1000000
            samples.append(v / 8388608.0)
    elif sampwidth == 4:
        values = array.array('i')
        values.frombytes(raw)
        samples = [v / 2147483648.0 for v in values]
    else:
        raise ValueError('不支持的位深 %d bit：%s' % (sampwidth * 8, path))

    if channels <= 1:
        return samples
    # C# 是 `ToMono(1, 0)`：取第 0 声道（见模块 docstring 的差异 2）
    return samples[0::channels]

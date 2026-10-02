# -*- coding: utf-8 -*-
"""基频缓存文件 —— **照搬** `OpenUtau.Core/Classic/Frq.cs`（284 行）。

UTAU 生态里 `xxx_wav.frq` 是"这个 wav 的逐帧基频 + 振幅"的缓存，由 SetParam 之类的
工具生成。它的意义是**省掉一次 F0 提取**：`Worldline.SynthSegment` 会先找 `.frq`，
找到就用它（`F0(..., method: -1)` 只问帧数），找不到才用原生 pyin（`method: 2`）。

本文件包含 C# 同文件的四样东西：

| 本文件 | C# |
|---|---|
| `IFrqFiles` | `IFrqFiles` 接口（`.frq` 与 `.mrq` 的共同门面） |
| `Frq` | `.frq`（`FREQ0003` 格式，世界线默认） |
| `Mrq` | `.mrq`（moresampler 的容器，一个包里塞多个 wav 的 f0） |
| `OtoFrq` | 把 `.frq` 折算成"相对平均音高的偏差"（MOD+ 用） |

## 照搬时保留的语义（别"整理"掉）
1. `Frq` 的**文件格式**：ASCII `FREQ0003`（8 字节）→ `hopSize` int32 → `averageF0`
   double → **16 字节空白** → `length` int32 → `length` 组 `(f0 double, amp double)`。
   全部小端（C# `BinaryReader` 的默认序）。`Save` 里那 16 字节是 4 个 `int 0` 写出来的。
2. `Frq.Build` 的 `averageF0` 过滤条件是 **`f > 0`**（注意不是 `> 60`），
   而 `OtoFrq.Completion` 的"有声"判据是 **`<= 60` 视为无声**。两处阈值不同，别统一。
3. `OtoFrq.Completion` 的补全规则：无声帧用它**前后最近的有声帧**；一侧没有就用
   另一侧；两侧都有才线性插值。`MusicMath.Linear(min, max, minFrq, maxFrq, i)` 用的是
   **帧下标**做自变量（不是时间）。
4. `OtoFrq` 的 `cutoff` 换算**不对称**：
   `cutoff < 0` 时是 `ConvertMsToFrqLength(Offset - Cutoff)`（含 offset），
   否则是 `f0.Length - ConvertMsToFrqLength(Cutoff)`（**只有 cutoff 自己**）。
   照搬，别"顺手对称化"。
5. `ConvertMsToFrqLength` 是 `(int)Math.Floor(ms * wavSampleRate / 1000 / hopSize)`。
6. `Mrq.Load` 的文件名是 **UTF-16LE**（moresampler 在 Windows 上的习惯），
   并且只在找到目标 wav 时才 return true；`averageF0` 是**对数域平均**后转回 Hz
   （`2^mean(log2(f))`），与 `Frq` 的算术平均**不同**。

## 与 C# 的载体差异
- `Frq.Load` / `Mrq.Load` 失败时 C# 会 `DocManager.Inst.ExecuteCmd(ErrorMessageNotification)`；
  那是编辑器的错误提示（M3，未照搬），这里用标准库 `logging` 记一条，**返回值仍是 false**。
- `IFrqFiles.Load` 的 `out` 语义由返回 bool 表达（C# 本来就是 bool）。
- `GetFrqFile` / `GetMrqFile` 属于 `Classic/VoicebankFiles.cs`（该文件整体在 P1-c），
  这里先搬 `Frq.cs` 依赖的这两个**纯路径**静态函数。
- C# 的 `MessageCustomizableException`（带翻译键）不在这里产生。
"""

import logging
import math
import os
import struct
from typing import Dict, List, Optional

from ..music_math import MusicMath

logger = logging.getLogger(__name__)


def get_frq_file(source: str) -> str:
    """对应 `VoicebankFiles.GetFrqFile`：`a.wav` → `a_wav.frq`（扩展名的点换成下划线）。"""
    ext = os.path.splitext(source)[1]
    no_ext = source[:len(source) - len(ext)]
    frq_ext = ext.replace('.', '_') + '.frq'
    return no_ext + frq_ext


def get_mrq_file(source: str) -> str:
    """对应 `VoicebankFiles.GetMrqFile`：与 wav 同目录下的 `desc.mrq`。"""
    return os.path.join(os.path.dirname(source), 'desc.mrq')


class IFrqFiles:
    """对应 C# 的 `IFrqFiles` 接口。"""

    @property
    def hop_size(self) -> int:
        raise NotImplementedError

    @property
    def average_f0(self) -> float:
        raise NotImplementedError

    @property
    def f0(self) -> List[float]:
        raise NotImplementedError

    #: `public int wavSampleRate { get; set; } = 44100;`
    wav_sample_rate: int = 44100

    def load(self, wav_path: str) -> bool:
        """对应 `Load(wavPath)`：`wav_path` 为 None（机器学习声库）时返回 False。"""
        raise NotImplementedError


class Frq(IFrqFiles):
    """对应 C# 的 `Frq`（`FREQ0003`）。"""

    #: `public const int kHopSize = 256;`
    K_HOP_SIZE = 256

    def __init__(self):
        self._hop_size = 0
        self._average_f0 = 0.0
        self._f0: List[float] = []
        self.amp: List[float] = []
        # .frq 的采样率是**写死**的
        self.wav_sample_rate = 44100

    @property
    def hop_size(self) -> int:
        return self._hop_size

    @property
    def average_f0(self) -> float:
        return self._average_f0

    @property
    def f0(self) -> List[float]:
        return self._f0

    def load(self, wav_path: str) -> bool:
        """对应 `Frq.Load(wavPath)`：读 `xxx_wav.frq`，失败返回 False（不抛）。"""
        if not wav_path:
            return False
        frq_file = get_frq_file(wav_path)
        if not os.path.isfile(frq_file):
            return False
        try:
            with open(frq_file, 'rb') as f:
                data = f.read()
            header = data[:8].decode('ascii')
            if header != 'FREQ0003':
                raise ValueError('FREQ0003 header not found.')
            # 8(header) + 4(hopSize) + 8(averageF0) + 16(blank) = 36
            self._hop_size = struct.unpack_from('<i', data, 8)[0]
            self._average_f0 = struct.unpack_from('<d', data, 12)[0]
            length = struct.unpack_from('<i', data, 36)[0]
            need = 40 + length * 16
            if length < 0 or len(data) < need:
                raise ValueError('truncated frq file: need %d bytes, got %d'
                                 % (need, len(data)))
            f0 = [0.0] * length
            amp = [0.0] * length
            for i in range(length):
                f0[i], amp[i] = struct.unpack_from('<dd', data, 40 + i * 16)
            self._f0 = f0
            self.amp = amp
            return True
        except Exception as e:
            # C#: DocManager.Inst.ExecuteCmd(new ErrorMessageNotification(...))
            # —— 编辑器错误提示属 M3，这里只记日志，返回值仍是 false
            logger.error('Failed to load frq file %s: %s', frq_file, e)
            return False

    def save(self, stream) -> None:
        """对应 `Frq.Save(Stream)`：写出 `FREQ0003` 格式（16 字节空白 = 4 个 int 0）。"""
        stream.write(b'FREQ0003')
        stream.write(struct.pack('<i', self._hop_size))
        stream.write(struct.pack('<d', self._average_f0))
        stream.write(struct.pack('<iiii', 0, 0, 0, 0))
        stream.write(struct.pack('<i', len(self._f0)))
        for i in range(len(self._f0)):
            stream.write(struct.pack('<dd', self._f0[i], self.amp[i]))

    @staticmethod
    def build(samples: List[float], f0: List[float]) -> 'Frq':
        """对应 `Frq.Build(samples, f0)`：由样本 + f0 现造一个 `.frq`。

        `averageF0` 是**有声帧的算术平均**（判据 `f > 0`）；`amp` 是每个 hop 内的
        平均绝对值再乘 `2^15`。
        """
        frq = Frq()
        frq._hop_size = Frq.K_HOP_SIZE
        frq._f0 = list(f0)
        voiced = [f for f in frq._f0 if f > 0]
        frq._average_f0 = (sum(voiced) / len(voiced)) if voiced else 0.0

        amp_mult = 2.0 ** 15
        hop = frq._hop_size
        frq.amp = [0.0] * len(frq._f0)
        for i in range(len(frq.amp)):
            total = 0.0
            count = 0
            for j in range(hop * i, hop * (i + 1)):
                if j >= len(samples):
                    break
                total += abs(samples[j])
                count += 1
            frq.amp[i] = 0.0 if count == 0 else total * amp_mult / count
        return frq


class Mrq(IFrqFiles):
    """对应 C# 的 `Mrq`（moresampler 的 `desc.mrq`）。"""

    def __init__(self):
        self._hop_size = 0
        self._average_f0 = 0.0
        self._f0: List[float] = []
        self.wav_sample_rate = 44100

    @property
    def hop_size(self) -> int:
        return self._hop_size

    @property
    def average_f0(self) -> float:
        return self._average_f0

    @property
    def f0(self) -> List[float]:
        return self._f0

    def load(self, wav_path: str) -> bool:
        """对应 `Mrq.Load(wavPath)`：在 `desc.mrq` 里找同名条目。"""
        if not wav_path:
            return False
        mrq_path = get_mrq_file(wav_path)
        if not os.path.isfile(mrq_path):
            return False
        try:
            with open(mrq_path, 'rb') as f:
                data = f.read()
            pos = 0

            def read(fmt):
                nonlocal pos
                size = struct.calcsize(fmt)
                value = struct.unpack_from(fmt, data, pos)
                pos += size
                return value

            magic = data[pos:pos + 4].decode('ascii', errors='replace')
            pos += 4
            if magic != 'mrq ':
                raise ValueError('mrq header not found')
            (ver,) = read('<i')
            if ver <= 0:
                raise ValueError('invalid mrq version')
            (nentries,) = read('<i')
            target = os.path.basename(wav_path)

            for _ in range(nentries):
                (nfilename,) = read('<i')
                if nfilename < 0:
                    raise ValueError('bad name length')
                # moresampler 把文件名存成 UTF-16LE（Windows 的习惯）
                name_bytes = data[pos:pos + nfilename * 2]
                pos += nfilename * 2
                if len(name_bytes) != nfilename * 2:
                    raise EOFError('truncated mrq name')
                filename = name_bytes.decode('utf-16-le')
                (size,) = read('<i')
                if size < 0:
                    raise ValueError('negative payload size')
                if filename != target:
                    pos += size                      # 不是目标文件 → 跳过
                    continue
                nf0, wav_sample_rate, hop_size = read('<iii')
                if nf0 < 0 or size < 12 or size < 12 + nf0 * 4:
                    raise ValueError('f0 length mismatch')
                self.wav_sample_rate = wav_sample_rate
                self._hop_size = hop_size
                f0 = [0.0] * nf0
                for j in range(nf0):
                    (f0[j],) = read('<f')            # ReadSingle → float32
                # 可选尾巴：timestamp + modified（8 字节），不需要
                used = 12 + nf0 * 4
                if size - used >= 8:
                    read('<ii')
                self._f0 = f0
                voiced = [v for v in f0 if v > 0]
                if not voiced:
                    self._average_f0 = 0.0
                else:
                    # 对数域平均再转回 Hz（与 Frq 的算术平均不同）
                    mean_log2 = sum(math.log(v, 2.0) for v in voiced) / len(voiced)
                    self._average_f0 = 2.0 ** mean_log2
                return True
            return False                             # 没找到这个 wav 的条目
        except Exception as e:
            logger.error('Failed to load mrq file %s: %s', mrq_path, e)
            return False


class OtoFrq:
    """对应 C# 的 `OtoFrq`：把 oto 的 offset/consonant/cutoff 折算成"相对平均音高的偏差"。

    MOD+ 用它给每个音素做音高微调：`tone_diff_fix` 覆盖辅音段、
    `tone_diff_stretch` 覆盖元音段（单位都是**半音**）。
    """

    def __init__(self, oto, table: Dict[str, IFrqFiles]):
        self.tone_diff_fix: List[float] = []
        self.tone_diff_stretch: List[float] = []
        self.hop_size = 0
        self.loaded = False

        frq = table.get(oto.file)
        if frq is None:
            frq = self._load(oto.file)
            if frq is not None:
                table[oto.file] = frq

        if frq is not None:
            self.hop_size = frq.hop_size
            offset = self._convert_ms_to_frq_length(frq, oto.offset)
            consonant = self._convert_ms_to_frq_length(frq, oto.offset + oto.consonant)
            cutoff = (self._convert_ms_to_frq_length(frq, oto.offset - oto.cutoff)
                      if oto.cutoff < 0
                      else len(frq.f0) - self._convert_ms_to_frq_length(frq, oto.cutoff))
            completion_f0 = self._completion(frq.f0)
            average_tone = MusicMath.freq_to_tone(frq.average_f0)
            self.tone_diff_fix = [
                MusicMath.freq_to_tone(f) - average_tone
                for f in completion_f0[offset:offset + max(0, consonant - offset)]]
            self.tone_diff_stretch = [
                MusicMath.freq_to_tone(f) - average_tone
                for f in completion_f0[consonant:consonant + max(0, cutoff - consonant)]]
            self.loaded = True

    @staticmethod
    def _load(oto_path: str) -> Optional[IFrqFiles]:
        """对应 `OtoFrq.Load`：先试 `.frq`，再试 `.mrq`。"""
        frq = Frq()
        if frq.load(oto_path):
            return frq
        mrq = Mrq()
        if mrq.load(oto_path):
            return mrq
        # C# 原文注释：Please write a code to read other frequency files!
        return None

    @staticmethod
    def _convert_ms_to_frq_length(frq: IFrqFiles, length_ms: float) -> int:
        return int((length_ms * frq.wav_sample_rate / 1000 / frq.hop_size) // 1)

    @staticmethod
    def _completion(frqs: List[float]) -> List[float]:
        """对应 `Completion`：把 `<= 60` 的帧用前后最近的有声帧补上。"""
        out: List[float] = []
        n = len(frqs)
        for i in range(n):
            if frqs[i] <= 60:
                low = i - 1
                min_frq = 0.0
                while low >= 0:
                    if frqs[low] > 60:
                        min_frq = frqs[low]
                        break
                    low -= 1
                high = i + 1
                max_frq = 0.0
                while high < n:
                    if frqs[high] > 60:
                        max_frq = frqs[high]
                        break
                    high += 1
                if min_frq <= 60:
                    out.append(max_frq)
                elif max_frq <= 60:
                    out.append(min_frq)
                else:
                    out.append(MusicMath.linear(low, high, min_frq, max_frq, i))
            else:
                out.append(frqs[i])
        return out

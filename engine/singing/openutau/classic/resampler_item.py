# -*- coding: utf-8 -*-
"""单个音素的 resampler 调用参数与缓存键 —— **照搬** `OpenUtau.Core/Classic/ResamplerItem.cs`（188 行）。

`RenderPhone`（乐句级、与"输出什么"有关）到这里变成 `ResamplerItem`（单音素级、
与"怎么调 resampler"有关）：算好输入/输出路径、stretch 后的时长、音高序列（音分）、
参数哈希。**Classic 与 Worldline 两条线都吃这个结构。**

## 照搬时保留的语义（别"整理"掉）
- `skipOver = oto.Preutter * 2^(1 - velocity*0.01) - phone.leadingMs`
  —— 辅音拉伸用 **2 的幂**（不是线性），与 `phonemizer` 里的 VEL 语义一致。
- `durRequired`：先加 `skipOver`，再 `max(..., oto.Consonant)`，最后
  **向上取整到 50 ms 的整数倍**（`ceil(x/50 + 0.5)*50`，注意里面还多加了 0.5）。
- 音高序列 `pitches[]` 是**音分**（相对音高号 0，即 `sampleLerped - tone*100`），
  在乐句音高数组上按 ms→tick 双向定位后**线性插值**取样。
- 哈希写入顺序/类型宽度是缓存文件名的一部分，逐字节照搬。
- 输出文件名：`res-{XXH32(singerId):x8}-{hash:x16}.wav`。

## ★ 与 C# 的一处**重要**载体差异：`Vector2` 是 struct
`EnvelopeMsToSamples` 里 C# 写的是：

    var envelope = phone.envelope.ToList();   // 逐个拷贝 struct
    for (...) { var point = envelope[i]; point.X = ...; envelope[i] = point; }

因为 C# 的 `Vector2` 是**值类型**，`ToList()` 拿到的是独立副本，所以这段
**不会改动** `phone.envelope`。Python 的 `Vector2` 是普通类（引用语义），
`list(...)` 只是浅拷贝 —— 直接照抄就会**污染乐句里的包络**，且因为乐句要重复渲染，
第二次渲染的包络就成了"已经换算过一次的样本坐标"，表现为音量和包络越渲染越怪。
所以这里显式**逐点新建** `Vector2(x, y)`，并在测试里钉死"原包络不被改动"。
"""

import math
import os
from typing import List

from ..binary_writer import BinaryWriter
from ..music_math import MusicMath, fdiv
from ..xxhash import xxh32
from ...ustx.model import Vector2


class ClassicHost:
    """C# 三个单例（`ToolsManager` / `VoicebankFiles` / `PathManager`）的替身。

    C# 里 `ResamplerItem` 的构造函数直接从这三个全局单例取东西；Python 侧没有全局单例，
    这里用一个可替换的宿主对象顶替，方法/字段名与 C# 用法一一对应。
    这是**载体差异，不是行为差异**。

    未配置时会抛 `NotImplementedError`（而不是静默给错路径），避免"文件找不到"
    这类问题被伪装成其他错误。
    """

    #: 对应 `PathManager.Inst.CachePath`（resampler/wavtool 的临时文件都落在这里）
    cache_path: str = ''
    #: 对应 `PathManager.Inst.RootPath`（随包分发的 `worldline.dll` 就在这一层；
    #: 它也是 `Preferences.Inst` 之类的同级目录）
    root_path: str = ''
    #: 对应 `PathManager.Inst.SingersPaths`：声库搜索根目录列表。
    #: 默认空列表 —— 对应"一个搜索路径都没配"，于是 `find_all_singers()` 返回空表
    #: （这是**真实答案**，不是错误，所以不抛 `NotImplementedError`）。
    singers_paths: List[str] = []

    def get_resampler(self, name: str):
        """对应 `ToolsManager.Inst.GetResampler(name)`。

        返回的对象需满足 C# `IResampler` 里被本品用到的三项：
        `supports_flag(abbr) -> bool`、`__str__()`（进哈希与文件名前缀判定）。
        """
        raise NotImplementedError(
            'ClassicHost.get_resampler 未配置：需要工具管理器（Classic/ExeResampler 等尚未照搬）')

    def get_source_temp_path(self, singer_id: str, oto, ext: str) -> str:
        """对应 `VoicebankFiles.Inst.GetSourceTempPath(singerId, oto, ext)`。"""
        raise NotImplementedError(
            'ClassicHost.get_source_temp_path 未配置：需要 VoicebankFiles（尚未照搬）')

    def get_wavtool(self, name: str):
        """对应 `ToolsManager.Inst.GetWavtool(name)`。

        ★ C# 里 `name` 对不上时**回落**到 `wavtoolsMap[SharpWavtool.nameConvergence]`，
        而不是返回 null；所以返回的对象必须永远可用。
        """
        raise NotImplementedError(
            'ClassicHost.get_wavtool 未配置：需要工具管理器（Classic/ToolsManager 尚未照搬）')

    def copy_source_temp(self, source: str, temp: str) -> None:
        """对应 `VoicebankFiles.Inst.CopySourceTemp(source, temp)`。

        ★ 只在**外部 resampler** 那条路上被调用（C# 用
        `!(item.resampler is WorldlineResampler)` 守卫）：外部程序要一个解码成
        WAV 的临时输入文件，而自带的 Worldline 直接读原音，不需要这一趟拷贝。
        默认抛 `NotImplementedError` —— 自包含路径永远不会走到。
        """
        raise NotImplementedError(
            'ClassicHost.copy_source_temp 未配置：需要 VoicebankFiles（尚未照搬）')

    def copy_back_meta_files(self, source: str, temp: str) -> None:
        """对应 `VoicebankFiles.Inst.CopyBackMetaFiles(source, temp)`（同上，仅外部路径用）。"""
        raise NotImplementedError(
            'ClassicHost.copy_back_meta_files 未配置：需要 VoicebankFiles（尚未照搬）')


#: 当前宿主（对应 C# 的全局单例）。测试/主程序在启动时替换它。
host = ClassicHost()


class ResamplerItem:
    """对应 `ResamplerItem`。"""

    __slots__ = ('phrase', 'phone', 'resampler', 'input_file', 'input_temp', 'output_file',
                 'tone', 'flags', 'velocity', 'volume', 'modulation',
                 'preutter', 'overlap', 'offset', 'dur_required', 'dur_correction',
                 'consonant', 'cutoff', 'skip_over', 'tempo', 'pitches', 'hash')

    def __init__(self, phrase, phone):
        self.phrase = phrase
        self.phone = phone

        self.resampler = host.get_resampler(phone.resampler)
        self.input_file = phone.oto.file
        self.input_temp = host.get_source_temp_path(phrase.singer.id, phone.oto, '.wav')
        self.tone = phone.tone

        # 只保留 resampler 认识的 flag（abbr 是 flag 的表达式缩写，用来过滤）
        self.flags = [f for f in phone.flags if self.resampler.supports_flag(f[2])]
        self.velocity = int(phone.velocity * 100)
        self.volume = int(phone.volume * 100)
        self.modulation = int(phone.modulation * 100)

        self.preutter = float(phone.preutter_ms)
        self.overlap = float(phone.overlap_ms)
        self.offset = phone.oto.offset
        # 辅音伸缩：2^(1 - velocity*0.01)，与 VEL 语义一致（不是线性）
        stretch_ratio = 2 ** (1.0 - self.velocity * 0.01)
        pitch_leading_ms = phone.oto.preutter * stretch_ratio
        self.skip_over = phone.oto.preutter * stretch_ratio - phone.leading_ms
        dur_required = phone.end_ms - phone.position_ms + phone.dur_correction_ms + self.skip_over
        dur_required = max(dur_required, phone.oto.consonant)
        self.dur_required = _ceil(dur_required / 50.0 + 0.5) * 50.0
        self.dur_correction = phone.dur_correction_ms
        self.consonant = phone.oto.consonant
        self.cutoff = phone.oto.cutoff

        self.tempo = phone.adjusted_tempo

        # ---- 音高序列：在乐句音高数组上取样，结果转成"音分"
        pitch_count_ms = (phone.position_ms + phone.envelope[4].x) - (phone.position_ms - pitch_leading_ms)
        pitch_count = _ceil(MusicMath.tempo_ms_to_tick(self.tempo, pitch_count_ms) / 5.0)
        pitch_count = max(pitch_count, 0)
        pitches = [0] * pitch_count

        phrase_pitch_start_ms = phrase.position_ms - phrase.leading_ms
        phrase_pitch_start_tick = _floor(phrase.time_axis.ms_pos_to_non_exact_tick_pos(phrase_pitch_start_ms))

        pitch_interval_ms = MusicMath.tempo_tick_to_ms(self.tempo, 5)
        pitch_sample_start_ms = phone.position_ms - pitch_leading_ms

        for i in range(len(pitches)):
            sample_pos_ms = pitch_sample_start_ms + pitch_interval_ms * i
            sample_pos_tick = _floor(phrase.time_axis.ms_pos_to_non_exact_tick_pos(sample_pos_ms))

            sample_interval = (phrase.time_axis.tick_pos_to_ms_pos(sample_pos_tick + 5)
                               - phrase.time_axis.tick_pos_to_ms_pos(sample_pos_tick))
            sample_index = (sample_pos_tick - phrase_pitch_start_tick) / 5.0
            sample_index = max(0.0, min(float(len(phrase.pitches) - 1), sample_index))

            sample_start = _floor(sample_index)
            sample_end = _ceil(sample_index)

            diff_pitch_ms = sample_pos_ms - phrase.time_axis.tick_pos_to_ms_pos(
                phrase_pitch_start_tick + sample_start * 5)
            sample_alpha = fdiv(diff_pitch_ms, sample_interval)

            sample_lerped = (phrase.pitches[sample_start]
                             + (phrase.pitches[sample_end] - phrase.pitches[sample_start]) * sample_alpha)

            # Math.Round 是「四舍六入五成双」，Python 的 round() 同语义
            pitches[i] = int(round(sample_lerped - phone.tone * 100))
        self.pitches = pitches

        self.hash = self._hash()
        self.output_file = os.path.join(
            host.cache_path,
            'res-%08x-%016x.wav' % (xxh32(phrase.singer.id.encode('utf-8')), self.hash))

        phrase.add_cache_file(self.input_temp)
        phrase.add_cache_file(self.output_file)

    # ------------------------------------------------------------------ 参数串

    def get_flags_string(self) -> str:
        """对应 `GetFlagsString`：把 flags 拼成 resampler 命令行要的串。"""
        out = []
        for flag in self.flags:
            out.append(flag[0])
            if flag[1] is not None:
                out.append(str(flag[1]))
        return ''.join(out)

    def _hash(self) -> int:
        """照搬 `Hash()`：写入顺序/类型宽度必须逐字节一致。"""
        w = BinaryWriter()
        w.write_str(str(self.resampler))
        w.write_str(self.input_file)
        w.write_int(self.tone)

        for flag in self.flags:
            w.write_str(flag[0])
            if flag[1] is not None:
                w.write_int(flag[1])
        w.write_int(self.velocity)
        w.write_int(self.volume)
        w.write_int(self.modulation)

        w.write_double(self.offset)
        w.write_double(self.dur_required)
        w.write_double(self.consonant)
        w.write_double(self.cutoff)
        w.write_double(self.skip_over)

        w.write_double(self.tempo)
        for pitch in self.pitches:
            w.write_int(pitch)
        return w.digest()

    # ------------------------------------------------------------------ 包络

    def envelope_ms_to_samples(self):
        """对应 `EnvelopeMsToSamples`：把包络点从 ms 换算成**样本**坐标。

        ★ 返回的是**新建的** Vector2 列表，绝不动 `phone.envelope` —— 见模块 docstring
        里对 C# struct 语义的说明（照抄浅拷贝会污染乐句包络）。
        """
        skip_over_samples = int(self.skip_over * 44100 / 1000)
        envelope = [Vector2(p.x, p.y) for p in self.phone.envelope]
        shift = -envelope[0].x
        for i in range(len(envelope)):
            point = envelope[i]
            point.x = (point.x + shift) * 44100 / 1000 + skip_over_samples
            point.y = point.y / 100
            envelope[i] = point
        return envelope

    def apply_envelope(self, samples) -> None:
        """对应 `ApplyEnvelope`：按包络逐样本乘增益（**就地**修改 samples）。"""
        envelope = self.envelope_ms_to_samples()
        next_point = 0
        last = envelope[-1]
        first = envelope[0]
        for i in range(len(samples)):
            while next_point < len(envelope) and i > envelope[next_point].x:
                next_point += 1
            if next_point == 0:
                gain = first.y
            elif next_point >= len(envelope):
                gain = last.y
            else:
                p0 = envelope[next_point - 1]
                p1 = envelope[next_point]
                if p0.x >= p1.x:
                    gain = p0.y
                else:
                    gain = p0.y + (p1.y - p0.y) * (i - p0.x) / (p1.x - p0.x)
            samples[i] = samples[i] * gain

    def __str__(self):
        return '%s %s' % (self.resampler, self.phone.phoneme)

    __repr__ = __str__


# ---- C# 的 Math.Floor / Math.Ceiling 都返回 double 再被 (int) 截断，
#      这里直接给出 int（对有限值等价）。
def _floor(v: float) -> int:
    return int(math.floor(v))


def _ceil(v: float) -> int:
    return int(math.ceil(v))

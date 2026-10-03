# -*- coding: utf-8 -*-
r"""DiffSinger 三份配置的解析 —— **照搬** `OpenUtau.Core/DiffSinger/DiffSingerConfig.cs`
与 `DiffSingerVocoder.cs` 的 `DsVocoderConfig`。

★ **三份配置互不相同，且 `frameMs` 来源不同** —— 这是本项目最容易出错的地方：

| 配置 | 位置 | `frameMs` / `hop` 来源 | 决定什么 |
|---|---|---|---|
| `DsDurConfig` | `<声库>/dsdur/dsconfig.yaml` | **它自己**的 `hop_size`/`sample_rate` | A 层音素时长的帧数换算 |
| `DsAcousticConfig` | `<声库>/dsconfig.yaml` | 只用 mel 规格 + `use*Embed` | acoustic 的输入集合 |
| `DsVocoderConfig` | `<声库>/dsvocoder/vocoder.yaml` 或 `Dependency/<name>` | **它自己**的 `hop_size`/`sample_rate` | B 层 `frameMs`（`DiffSingerRenderer.cs:241`） |

★ 所以 A 层与 B 层的 `frameMs` **可能不同**，绝不能共用一个 `hop_size`
  （我们旧实现只有一个 `vb["hop_size"]`，这正是 `_as_int_frames` 那个单位启发式坑的来源）。
"""

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

#: 对应 `DiffSingerConfig.cs:112-114` 的 `frameMs()`
def frame_ms_of(hop_size: int, sample_rate: int) -> float:
    """`1000 * hop_size / sample_rate`（毫秒）。

    ★ **必须用 float32 单精度**：C# 的 `DsConfig.frameMs()` 返回 `float`
      （`DiffSingerConfig.cs:112`），而 `DiffSingerRenderer.frameMs()` 也是 `float`
      （`DiffSingerVocoder.cs:54`）。`DiffSingerUtils.DurationsMsToFrames` 里
      `accumulatedMs / frameMs + 0.5` 的结果正好卡在 `.5` 边界上（head/tail 各 8 帧
      时 `8*frameMs/frameMs` 理论值就是 8.0），单/双精度的差异会让它落到 8 或 9。
      照搬就要照搬精度。
    """
    import numpy as np
    return float(np.float32(np.float32(1000.0 * np.float32(hop_size))
                            / np.float32(sample_rate)))


@dataclass
class DsDurConfig:
    """`<声库>/dsdur/dsconfig.yaml`（照搬 `DiffSingerBasePhonemizer._executeSetSinger`）。

    ★ `root` 是**强制**的（上游 `:87` + `:160-164` 缺了就抛）。
    """

    root: str
    linguistic: str
    dur: str
    phonemes: str
    languages: Optional[str] = None
    speakers: Optional[List[str]] = None
    use_lang_id: bool = False
    hop_size: int = 512
    sample_rate: int = 44100
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def frame_ms(self) -> float:
        """对应 `:110` `this.frameMs = dsConfig.frameMs();`"""
        return frame_ms_of(self.hop_size, self.sample_rate)

    def path(self, *parts: str) -> str:
        return os.path.join(self.root, *parts)


@dataclass
class DsAcousticConfig:
    """`<声库>/dsconfig.yaml`（根，照搬 `DiffSingerConfig.cs` + `DiffSingerSinger`）。

    只有 `use*Embed` 家族与 mel 规格参与渲染；`max_depth` 还要按
    `use_continuous_acceleration` 做一次隐藏换算（`DiffSingerConfig.cs:70`）。
    """

    root: str
    acoustic: str
    vocoder: str
    phonemes: str
    hop_size: int = 512
    win_size: int = 2048
    fft_size: int = 2048
    num_mel_bins: int = 128
    mel_fmin: float = 40.0
    mel_fmax: float = 16000.0
    mel_base: str = '10'
    mel_scale: str = 'slaney'
    sample_rate: int = 44100
    # --- use*Embed 家族（决定 acoustic 的输入集合，缺一个就抛）
    use_lang_id: bool = False
    use_key_shift_embed: bool = False
    use_speed_embed: bool = False
    use_energy_embed: bool = False
    use_breathiness_embed: bool = False
    use_voicing_embed: bool = False
    use_tension_embed: bool = False
    # --- 采样加速
    use_continuous_acceleration: bool = False
    use_variable_depth: bool = False
    use_shallow_diffusion: Optional[bool] = None
    _max_depth: float = 0.6
    # --- 其它
    languages: Optional[str] = None
    speakers: Optional[List[str]] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def max_depth(self) -> float:
        """对应 `DiffSingerConfig.cs:70`。

        ```csharp
        public double maxDepth => useContinuousAcceleration ? _maxDepth : _maxDepth / 1000.0;
        ```
        """
        return self._max_depth if self.use_continuous_acceleration else self._max_depth / 1000.0

    @property
    def use_shallow_diffusion_effective(self) -> bool:
        """对应 `:51-67` 的别名合并（`use_variable_depth` 优先，其次 `use_shallow_diffusion`）。"""
        if self.use_variable_depth:
            return True
        if self.use_shallow_diffusion is not None:
            return bool(self.use_shallow_diffusion)
        return False

    def path(self, *parts: str) -> str:
        return os.path.join(self.root, *parts)


@dataclass
class DsVocoderConfig:
    """`vocoder.yaml`（照搬 `DiffSingerVocoder.cs:76-99` 的 `DsVocoderConfig`）。"""

    root: str
    model: str = 'model.onnx'
    sample_rate: int = 44100
    hop_size: int = 512
    win_size: int = 2048
    fft_size: int = 2048
    num_mel_bins: int = 128
    mel_fmin: float = 40.0
    mel_fmax: float = 16000.0
    mel_base: str = '10'
    mel_scale: str = 'slaney'
    #: ★ 在 **vocoder.yaml**（不是 dsconfig）—— 只决定给 acoustic 喂 f0 还是 shiftedF0；
    #:   vocoder 自己永远拿**未 shift 的** f0（`DiffSingerRenderer.cs:501`）。
    pitch_controllable: bool = False
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def frame_ms(self) -> float:
        """对应 `DiffSingerVocoder.cs:54-56`；B 层用它（`DiffSingerRenderer.cs:241`）。"""
        return frame_ms_of(self.hop_size, self.sample_rate)

    def model_path(self) -> str:
        return os.path.join(self.root, self.model)


#: `DsVocoderConfig.MaxMelBins`（`DiffSingerVocoder.cs:86`）—— 硬编码上限
MAX_MEL_BINS = 255


def resolve_depth(cfg: DsAcousticConfig, preferred: float = 1.0) -> float:
    """对应 `DiffSingerRenderer.cs:110-122`。

    ```csharp
    if (singer.dsConfig.useVariableDepth) {
        double maxDepth = singer.dsConfig.maxDepth;
        if (maxDepth < 0) throw …;
        depth = Math.Min(Preferences.Default.DiffSingerDepth, maxDepth);
    } else { depth = 1.0; }
    ```
    ★ 本声库 `use_continuous_acceleration: true` + `max_depth: 0.6` → `depth = 0.6`。
    """
    if not cfg.use_shallow_diffusion_effective:
        return 1.0
    max_depth = cfg.max_depth
    if max_depth < 0:
        raise ValueError('max_depth 未设置或为负：%r' % max_depth)
    return min(float(preferred), max_depth)


def compute_speedup(steps: int, diffusion_timesteps: int = 1000) -> int:
    """对应 `DiffSingerRenderer.cs:300-305` 的 speedup 搜索。

    ```csharp
    speedup = Math.Max(1, 1000 / steps);
    while (1000 % speedup != 0 && speedup > 1) { speedup--; }
    ```
    ★ 必须整除 1000，否则逐步递减 —— 照抄这个短路顺序。
    """
    speedup = max(1, diffusion_timesteps // max(1, int(steps)))
    while diffusion_timesteps % speedup != 0 and speedup > 1:
        speedup -= 1
    return speedup

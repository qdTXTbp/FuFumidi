# -*- coding: utf-8 -*-
"""hnsep 谐波/噪声分离 —— **照搬** `OpenUtau.Core/Analysis/Hnsep.cs`（180 行，MIT）。

上游注释（照译）：
    用 hnsep 网络做谐波/噪声分离（yxlllc/vocal-remover，MIT，源自 tsurumeso/vocal-remover）。
    网络在 STFT 上预测一个**复数掩码**；这里的 STFT/ISTFT **复刻 torch.stft / torch.istft**
    （periodic Hann、center=True 带零填充），所以只有网络跑 ONNX。
    模型包是 `hnsep_240512`：`hnsep.yaml` + ONNX；网络输入输出都是
    `[1, 2 (re, im), n_fft/2+1, frames]`。

## 为什么它存在（Worldline-R1.1 的依赖）

`Worldline-R1.1`（renderer version 11）走 `PhraseSynthV2(useHnsep: true)` →
`SynthContinuousNoise()`：**WORLD 的周期部分 + 连续噪声分量**。
v10 用 WORLD 的脉冲模型拟合整个声音，气声/呼吸/摩擦这类**非周期成分会被抹平**；
R1.1 把它们分离出来单独建模再合成回去，所以人声的气声质感更自然。

## 照搬时保留的语义（别「整理」掉）

1. **帧对齐是整数除法**：`tPad = seg * ((t1 - 1) // seg + 1) - t1`、
   `left = tPad // 2 // hop * hop`、`frames = 1 + length // hop` ——
   写成浮点或「四舍五入」会让帧数差 1，整段输出随之偏移。
2. **MDCT 式的 centered STFT**：`padded[n_fft//2 + left + i] = x[i]`（两边各 n_fft/2 个零）。
3. **掩码的内存布局**是 `[1, 2, bins, frames]` **展平**：实部在 `mask[k*frames + m]`、
   虚部在 `mask[(bins + k)*frames + m]` —— 注意**不是** `[k][m]` 的二维直觉。
4. **DC 与 Nyquist 必须强制为实数**（`frame[0]`、`frame[bins-1]`）—— 实信号的这两根是实数，
   掩码给成复数会让 irfft 出来有虚部残差。
5. **重叠相加要除以窗平方和**，且 `wsum <= 1e-11` 时取 0（不是除）。
6. **FFT 符号约定 = numpy**：正变换不除、逆变换除以 n → 直接用 `np.fft.rfft` / `np.fft.irfft`。

## ★ 只在 CPU 上跑（上游明确写了理由，别改成 GPU）

> Always CPU: it's faster than DirectML for this network (whose LSTMs are slow
> there), and callers run it from several threads, which CPU sessions allow and
> DirectML sessions don't.

这条与本仓库 P2 的 DirectML 串行化（上游 799ba8de）是同一件事的两面：
**DirectML 会话不支持多线程并发**，而这里的调用方是多线程的。
"""
import os
from dataclasses import dataclass
from typing import Any, Callable, List, Optional

import numpy as np

#: 上游 `Hnsep.PackageId` —— 包在 CNB 镜像 `FuFuCloud-mirror/Models@hnsep-v1`
PACKAGE_ID = 'hnsep_240512'

#: 上游 `Hnsep.SegmentFrames`：网络要求帧数是 32 的倍数
SEGMENT_FRAMES = 32


@dataclass
class HnsepConfig:
    """对应 `HnsepConfig`（字段名与 `hnsep.yaml` 一一对应）。"""

    model: str = 'model.onnx'
    sample_rate: int = 44100
    n_fft: int = 2048
    hop_length: int = 512

    @staticmethod
    def load(path: str) -> 'HnsepConfig':
        import yaml
        with open(path, 'r', encoding='utf-8-sig') as f:
            d = yaml.safe_load(f) or {}
        return HnsepConfig(
            model=str(d.get('model', 'model.onnx')),
            sample_rate=int(d.get('sample_rate', 44100)),
            n_fft=int(d.get('n_fft', 2048)),
            hop_length=int(d.get('hop_length', 512)),
        )


def periodic_hann(n: int) -> np.ndarray:
    """对应 `Hnsep.PeriodicHann`：`0.5 - 0.5*cos(2*pi*i/n)`。

    ★ 是 **periodic**（分母 n）不是 symmetric（分母 n-1）—— 与 torch.hann_window(periodic=True) 一致。
    """
    i = np.arange(n, dtype=np.float64)
    return 0.5 - 0.5 * np.cos(2.0 * np.pi * i / n)


def separate(x: np.ndarray, nfft: int, hop: int, window: np.ndarray,
             predict_mask: Callable[[np.ndarray], np.ndarray]) -> np.ndarray:
    """对应 `Hnsep.Separate`：STFT → 掩码 → ISTFT，返回**与输入等长**的谐波分量。

    `predict_mask` 收 `[1, 2, bins, frames]` 的 float32 数组，返回同布局的展平掩码。
    """
    x = np.asarray(x, dtype=np.float64)
    bins = nfft // 2 + 1
    T = int(x.shape[0])

    # 补齐到整数个网络段（照搬 hnsep 的 predict_fromaudio）
    seg = SEGMENT_FRAMES * hop
    t1 = T + hop
    t_pad = seg * ((t1 - 1) // seg + 1) - t1
    left = t_pad // 2 // hop * hop
    length = T + t_pad
    frames = 1 + length // hop

    # centered STFT：补齐信号两侧各 n_fft/2 个零
    padded = np.zeros(length + nfft, dtype=np.float64)
    padded[nfft // 2 + left: nfft // 2 + left + T] = x

    # 分帧 → rfft。np.fft.rfft 的符号约定与上游 RealFourierTransform 一致。
    idx = (np.arange(nfft)[None, :] + (np.arange(frames) * hop)[:, None])
    framed = padded[idx] * window[None, :]              # [frames, nfft]
    spec = np.fft.rfft(framed, axis=1)                  # [frames, bins] complex

    # 网络输入 [1, 2, bins, frames]：实部/虚部分块，且**转置**成 [bins, frames]
    inp = np.empty((1, 2, bins, frames), dtype=np.float32)
    inp[0, 0] = spec.real.T.astype(np.float32)
    inp[0, 1] = spec.imag.T.astype(np.float32)

    mask = np.asarray(predict_mask(inp), dtype=np.float64).reshape(2, bins, frames)
    # 掩码按 [2, bins, frames] 取用：实部 mask[0]，虚部 mask[1]
    masked = spec.T * (mask[0] + 1j * mask[1])          # [bins, frames]
    masked = masked.T                                    # 回到 [frames, bins]

    # DC 与 Nyquist 对实信号必为实数
    masked[:, 0] = masked[:, 0].real
    masked[:, bins - 1] = masked[:, bins - 1].real

    time = np.fft.irfft(masked, n=nfft, axis=1)          # [frames, nfft]，逆变换已除 n
    frame_out = time * window[None, :]

    y = np.zeros(length + nfft, dtype=np.float64)
    wsum = np.zeros(length + nfft, dtype=np.float64)
    w2 = window * window
    for m in range(frames):
        o = m * nfft
        p = m * hop
        y[p:p + nfft] += frame_out[m]
        wsum[p:p + nfft] += w2

    j = nfft // 2 + left + np.arange(T)
    w = wsum[j]
    out = np.zeros(T, dtype=np.float64)
    np.divide(y[j], w, out=out, where=(w > 1e-11))
    return out


class Hnsep:
    """对应 `Hnsep`。接口只需两项：`.sample_rate` 与 `.harmonic(samples)`。"""

    def __init__(self, model_path: str, config: HnsepConfig, session: Any = None):
        self.config = config
        self._window = periodic_hann(config.n_fft)
        self._session = session if session is not None else self._make_session(model_path)

    @staticmethod
    def _make_session(model_path: str):
        """★ **固定 CPU**（上游理由见模块 docstring 第 5 条）：
        DML 上这个网络的 LSTM 很慢，而且调用方是多线程的、DirectML 会话不支持并发。"""
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = 1
        return ort.InferenceSession(model_path, so, providers=['CPUExecutionProvider'])

    @property
    def sample_rate(self) -> int:
        return int(self.config.sample_rate)

    def harmonic(self, samples) -> List[float]:
        """对应 `Hnsep.Harmonic`：返回 x 的谐波分量（等长、同采样率）；噪声分量 = x - 它。"""
        x = np.asarray(samples, dtype=np.float64)
        name = self._session.get_inputs()[0].name

        def _predict(inp: np.ndarray) -> np.ndarray:
            return np.asarray(self._session.run(None, {name: inp})[0]).ravel()

        return separate(x, self.config.n_fft, self.config.hop_length,
                        self._window, _predict).tolist()


_INSTANCE: Optional[Hnsep] = None


def load_package_dir(package_dir: str) -> Hnsep:
    """从解包后的 `hnsep_240512` 目录加载（该目录含 `hnsep.yaml` 与 `model.onnx`）。"""
    cfg_path = os.path.join(package_dir, 'hnsep.yaml')
    if not os.path.isfile(cfg_path):
        raise RuntimeError('hnsep 包不完整：找不到 %s' % cfg_path)
    cfg = HnsepConfig.load(cfg_path)
    model_path = os.path.join(package_dir, cfg.model)
    if not os.path.isfile(model_path):
        raise RuntimeError('hnsep 包不完整：找不到 %s' % model_path)
    return Hnsep(model_path, cfg)


def get_instance() -> Optional[Hnsep]:
    """已加载的实例（没有就返回 None）—— 供宿主注入 `worldline.set_hnsep`。"""
    return _INSTANCE


def set_instance(inst: Optional[Hnsep]) -> None:
    global _INSTANCE
    _INSTANCE = inst


# ---------------------------------------------------------------- 自动装配（WP4-4）

#: 资源中心把这个包解到哪（与 `main/models.js` 的同名条目必须一致）
PACKAGE_DIR_REL = os.path.join('hnsep', PACKAGE_ID)

#: `autoload` 的结果缓存：`'ok'` / `'missing'` / `'error: ...'`
#: ★ 必须缓存 —— 否则每一句渲染都会去扫一次盘（v11 是**逐乐句**调的）。
_AUTOLOAD: Optional[str] = None


def candidate_dirs(models_dir: str = '') -> List[str]:
    """按优先级列出可能放着**已解包** hnsep 包的目录。

    `<模型目录>/hnsep/hnsep_240512/` 是资源中心的落点；
    `<模型目录>/hnsep/` 是给"用户自己把包摊平放"留的兜底。
    """
    root = models_dir or os.environ.get('FUFUMIDI_MODELS_DIR') or ''
    if not root:
        return []
    return [os.path.join(root, PACKAGE_DIR_REL),
            os.path.join(root, 'hnsep')]


def autoload(models_dir: str = '', force: bool = False) -> Optional[Hnsep]:
    """自动找到 hnsep 包并**注入 `worldline`**；返回实例或 `None`。

    ★ 只在真正要跑 v11 时调（见 `WorldlineRenderer._make_phrase_synth`）——
    v10 用户不该为它付任何启动成本。

    ★ **本函数不抛错**：没装、包坏了、`onnxruntime` 缺失，一律返回 `None`，
    并把原因记进 `autoload_error()`。v11 之外的路径不该因为这块挂掉，
    而 v11 那条路会在拿不到实例时给出**可操作**的报错（指到资源中心）。
    """
    global _AUTOLOAD
    if _AUTOLOAD == 'ok' and not force:
        return _INSTANCE
    if _AUTOLOAD is not None and _AUTOLOAD != 'ok' and not force:
        return None                       # 已经试过且失败 —— 不重复扫盘
    tried = []
    for d in candidate_dirs(models_dir):
        cfg = os.path.join(d, 'hnsep.yaml')
        if not os.path.isfile(cfg):
            tried.append(d)
            continue
        try:
            inst = load_package_dir(d)
        except Exception as e:            # noqa: BLE001 —— 任何一种失败都不该炸上层
            _AUTOLOAD = 'error: %s: %s' % (type(e).__name__, e)
            return None
        # 同步两边：本模块的 _INSTANCE 与 worldline 的 _HNSEP_INSTANCE
        set_instance(inst)
        from . import worldline
        worldline.set_hnsep(inst)
        _AUTOLOAD = 'ok'
        return inst
    _AUTOLOAD = 'missing（找过：%s）' % ('; '.join(tried) if tried else '模型目录未设置')
    return None


def autoload_error() -> Optional[str]:
    """上一次 `autoload` 为什么没成功（成功则返回 `None`）—— 供报错文案使用。"""
    return None if _AUTOLOAD in (None, 'ok') else _AUTOLOAD
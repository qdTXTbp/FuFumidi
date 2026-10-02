# -*- coding: utf-8 -*-
"""NWaves 的两个 DSP 原语的**转写**（第三方库替换）。

`Classic/SharpWavtool.cs` 的相位补偿（`phaseComp`，也就是 `convergence` wavtool）
依赖 NWaves 这一个 NuGet 包的三样东西：

| 本文件 | NWaves 出处 |
|---|---|
| `iir_peak(frequency, q)` | `NWaves/Filters/Fda/DesignIirFilter.cs` → `DesignFilter.IirPeak` |
| `TransferFunction.zi` | `NWaves/Filters/Base/TransferFunction.cs` → `TransferFunction.Zi` |
| `ZiFilter.zero_phase(samples)` | `NWaves/Filters/Base/ZiFilter.cs` → `ZiFilter.ZeroPhase` |

换句话说：**这不是自研，是照搬 NWaves（MIT）** —— 与 `pypinyin` 替代
`csharp-pinyin` 属于同一类"载体差异"。NWaves 是 .NET 库，没法在 Python 里直接引用，
所以把用到的这几个函数逐行转写过来。表格里的路径就是核对来源。

## 照搬时保留的细节
- `IirPeak` 的算式（含 `gb = 1/√2`、`beta = gb/√(1-gb²)·tan(bw/2)`）逐行照抄，
  它**不是** RBJ 的 peaking EQ（没有增益参数，是"峰值谐振器"）。
- `Zi` 用的是"阶跃响应稳态"初值：先按 `a[0]` 归一化，再用伴随矩阵求
  `Matrix.Eye(size-1) - Matrix.Companion(a).T` 的首列之和。
- `ZeroPhase` 是 MATLAB/sciPy 的 `filtfilt` 对应物：**先反向前后各补 padLength 个
  镜像样本，再前向滤波一遍、倒过来滤波一遍**。补边用的
  `2*edge - neighbor` 反射式、以及"前向结果再倒着过一遍"的顺序都不能改。

## 与 C# 的载体差异
- NWaves 的滤波器系数是 `float[]`（double 构造器里 `b.ToFloats()`）；这里同样把
  系数**舍到 float32**（`struct` 往返），保证与 C# 判定一致。中间状态仍用 float64
  —— 与包内其它模块同一条取舍（偏差 ~1e-7，见 `render_phrase.py` 的说明）。
- `DiscreteSignal` 包装去掉：`zero_phase` 直接收发 `List[float]`（采样率只用于
  C# 的对象字段，算法本身不读它）。
- `Guard.AgainstInvalidRange(padLength, signal.Length, ...)` → 显式抛 `ValueError`。
"""

import math
import struct
from typing import List, Optional, Sequence


def _f32(v: float) -> float:
    """C# 的 `(float)` 转换：舍到 float32 再回读。"""
    return struct.unpack('<f', struct.pack('<f', v))[0]


class TransferFunction:
    """对应 NWaves 的 `TransferFunction`（这里只保留用到的一小部分）。"""

    def __init__(self, numerator: Sequence[float], denominator: Optional[Sequence[float]] = None):
        # C# 的构造函数**不做归一化**，原样存两份系数
        self.numerator: List[float] = list(numerator)
        self.denominator: List[float] = list(denominator) if denominator is not None else [1.0]

    @property
    def zi(self) -> List[float]:
        """对应 `TransferFunction.Zi`：与**阶跃响应稳态**对应的滤波器初值。"""
        size = max(len(self.numerator), len(self.denominator))
        a = _pad_zeros(self.denominator, size)
        b = _pad_zeros(self.numerator, size)
        a0 = a[0]
        a = [v / a0 for v in a]
        b = [v / a0 for v in b]
        big_b = [b[i] - a[i] * b[0] for i in range(1, size)]
        m = _eye_minus_companion_transposed(a)
        total = 0.0
        for i in range(size - 1):
            total += m[i][0]
        zi = [0.0] * size
        zi[0] = sum(big_b) / total
        asum = 1.0
        csum = 0.0
        for i in range(1, size - 1):
            asum += a[i]
            csum += b[i] - a[i] * b[0]
            zi[i] = asum * zi[0] - csum
        return zi


def _pad_zeros(values: Sequence[float], size: int) -> List[float]:
    """对应 NWaves 的 `PadZeros(size)`：整体左对齐、尾部补 0。"""
    out = list(values[:size])
    out.extend([0.0] * (size - len(out)))
    return out


def _companion(a: Sequence[float]) -> List[List[float]]:
    """对应 `Matrix.Companion(a)`：首行为 `-a[i+1]/a[0]`，次对角线为 1。"""
    size = len(a) - 1
    matrix = [[0.0] * size for _ in range(size)]
    for i in range(size):
        matrix[0][i] = -a[i + 1] / a[0]
    for i in range(1, size):
        matrix[i][i - 1] = 1.0
    return matrix


def _eye_minus_companion_transposed(a: Sequence[float]) -> List[List[float]]:
    """对应 `Matrix.Eye(size-1) - Matrix.Companion(a).T`。"""
    comp = _companion(a)
    size = len(comp)
    return [[(1.0 if i == j else 0.0) - comp[j][i] for j in range(size)]
            for i in range(size)]


def iir_peak(frequency: float, q: float = 20.0) -> TransferFunction:
    """对应 `DesignFilter.IirPeak(double frequency, double q = 20.0)`。

    `frequency` 是**归一化**中心频率（0..0.5，即 Hz/采样率）。
    """
    if frequency < 0 or frequency > 0.5:
        # C#: Guard.AgainstInvalidRange(frequency, 0, 0.5, "Center frequency")
        raise ValueError('Center frequency 必须落在 [0, 0.5]：%r' % (frequency,))
    w0 = 2 * frequency * math.pi
    bw = w0 / q
    gb = 1 / math.sqrt(2)
    beta = gb / math.sqrt(1 - gb * gb) * math.tan(bw / 2)
    gain = 1 / (1 + beta)
    num = [1 - gain, 0.0, gain - 1]
    den = [1.0, -2 * math.cos(w0) * gain, 2 * gain - 1]
    return TransferFunction(num, den)


class ZiFilter:
    """对应 NWaves 的 `ZiFilter`：用状态向量实现的双二阶滤波器 + 零相位滤波。"""

    def __init__(self, tf: TransferFunction):
        # C# 走的是 `ZiFilter(TransferFunction)` → `ZiFilter(IEnumerable<double>, ...)`
        # → `ToFloats()`：系数**舍到 float32**（见模块 docstring 的载体差异）
        self._b = [_f32(v) for v in tf.numerator]
        self._a = [_f32(v) for v in tf.denominator]
        max_length = max(len(self._a), len(self._b))
        self._b = _pad_zeros(self._b, max_length)
        self._a = _pad_zeros(self._a, max_length)
        self._zi = [0.0] * max_length
        self._tf = tf

    def init(self, zi: Sequence[float]) -> None:
        """对应 `Init(zi)`：只拷前 `len(self._zi)` 项。"""
        for i in range(min(len(zi), len(self._zi))):
            self._zi[i] = zi[i]

    def process(self, sample: float) -> float:
        """对应 `Process(sample)`：直接 II 型转置结构，一次一个样本。"""
        output = self._b[0] * sample + self._zi[0]
        for j in range(1, len(self._zi)):
            self._zi[j - 1] = self._b[j] * sample - self._a[j] * output + self._zi[j]
        return output

    def zero_phase(self, samples: Sequence[float], pad_length: int = 0) -> List[float]:
        """对应 `ZiFilter.ZeroPhase(DiscreteSignal signal, int padLength = 0)`。

        默认补边长度是 `3 * (max(len(a), len(b)) - 1)`。
        """
        if pad_length <= 0:
            pad_length = 3 * (max(len(self._a), len(self._b)) - 1)
        if pad_length > len(samples):
            # C#: Guard.AgainstInvalidRange(padLength, signal.Length, "pad length", "Signal length")
            raise ValueError('pad length 不能超过信号长度（%d > %d）'
                             % (pad_length, len(samples)))
        input_ = samples
        output = [0.0] * len(samples)
        edge_left = [0.0] * pad_length
        edge_right = [0.0] * pad_length

        # ---- 前向滤波
        initial_zi = self._tf.zi
        zi = list(initial_zi)
        base_sample = 2 * input_[0] - input_[pad_length]
        for i in range(len(zi)):
            zi[i] *= base_sample
        self.init(zi)

        base_sample = input_[0]
        k = 0
        i = pad_length
        while i > 0:
            edge_left[k] = self.process(2 * base_sample - input_[i])
            k += 1
            i -= 1
        for i in range(len(input_)):
            output[i] = self.process(input_[i])

        base_sample = input_[-1]
        k = 0
        i = len(input_) - 2
        while i > len(input_) - 2 - pad_length:
            edge_right[k] = self.process(2 * base_sample - input_[i])
            k += 1
            i -= 1

        # ---- 反向滤波
        zi = list(initial_zi)
        base_sample = edge_right[-1]
        for i in range(len(zi)):
            zi[i] *= base_sample
        self.init(zi)

        for i in range(pad_length - 1, -1, -1):
            self.process(edge_right[i])
        for i in range(len(output) - 1, -1, -1):
            output[i] = self.process(output[i])
        for i in range(pad_length - 1, -1, -1):
            self.process(edge_left[i])
        return output

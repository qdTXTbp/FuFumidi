# -*- coding: utf-8 -*-
"""三次样条段 —— **照搬** `OpenUtau.Core/Util/SplineInterpolate.cs`（全文件）。

用途：`.ustx` 音符的弯音点形状为 `sp`（spline）时，音高不使用
`MusicMath.InterpolateShape`，而是用本类的 Catmull-Rom 段求值
（见 `render_phrase.py` 的音高构建）。

## 照搬时保留的语义（别"整理"掉）
- 控制点用的是 **(x_{-1}, y_{-1}) (x0, y0) (x1, y1) (x2, y2)** 四个点 ——
  `x_{-1}` / `x2` 只参与切线 `m0` / `m1` 的计算，不参与区间判断。
- `m0 = (y1 - y_{-1}) * (x1 - x0) / (x1 - x_{-1})`，
  `m1 = (y2 - y0) * (x1 - x0) / (x2 - x0)` —— 分母互换是原文，别改。
- 构造时**就把 a/b/c/d 算好**（`a = 2y0-2y1+m0+m1` …），
  `GetY` 只是求值，不再重算。
- `GetY` 在区间外**夹到端点值**（`x <= x0 → y0`，`x >= x1 → y1`）。
- `GetX` 用**牛顿迭代 5 次**解 t（不是解析解），并在 `|f'(t)| < 1e-6` 时提前退出；
  退出条件、迭代次数、`Clamp(t, 0, 1)` 都要保留 —— 反解结果会因迭代次数不同而变。
"""


class CubicSplineSegment:
    """对应 C# 的 `CubicSplineSegment`。"""

    __slots__ = ('x0', 'y0', 'x1', 'y1', 'a', 'b', 'c', 'd')

    def __init__(self, x_1: float, y_1: float, x0: float, y0: float,
                 x1: float, y1: float, x2: float, y2: float):
        self.x0 = x0
        self.y0 = y0
        self.x1 = x1
        self.y1 = y1

        # Catmull-Rom
        m0 = (y1 - y_1) * (x1 - x0) / (x1 - x_1)
        m1 = (y2 - y0) * (x1 - x0) / (x2 - x0)

        self.a = 2 * y0 - 2 * y1 + m0 + m1
        self.b = -3 * y0 + 3 * y1 - 2 * m0 - m1
        self.c = m0
        self.d = y0

    def get_y(self, x: float) -> float:
        """给定 x，返回段上的 y（区间外夹到端点）。"""
        if x <= self.x0:
            return self.y0
        if x >= self.x1:
            return self.y1
        t = (x - self.x0) / (self.x1 - self.x0)
        return ((self.a * t + self.b) * t + self.c) * t + self.d

    def get_x(self, y: float) -> float:
        """给定 y，牛顿迭代反解 x（照搬：5 次迭代 + 斜率下限提前退出）。"""
        if y <= min(self.y0, self.y1):
            return self.x0 if y == self.y0 else self.x1
        if y >= max(self.y0, self.y1):
            return self.x1 if y == self.y1 else self.x0

        t = (y - self.y0) / (self.y1 - self.y0)

        for _ in range(5):
            # f(t) = at^3 + bt^2 + ct + d - y
            ft = ((self.a * t + self.b) * t + self.c) * t + (self.d - y)
            # f'(t) = 3at^2 + 2bt + c
            dft = (3 * self.a * t + 2 * self.b) * t + self.c
            if abs(dft) < 1e-6:
                break  # 斜率接近 0 时提前退出（照搬 C#）
            t -= ft / dft
            t = max(0.0, min(1.0, t))

        return self.x0 + t * (self.x1 - self.x0)

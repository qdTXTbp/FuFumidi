# FuFumidi 6.1.6

## 修复

- 自动探测乐器组时，探测器可能返回 `program_105` 这类 MuScriptor 不接受的原始 program 名；此前会作为硬约束传给模型并报 `unknown instrument name(s)`，导致整首转录失败。
- 现在会在整曲/手动/分段/稳定组各条路径统一过滤非法组名，日志提示「忽略无效乐器组」，再按剩余合法组继续转录。

其余功能与 6.1.5 一致（含转录完成提示音、hFT-Transformer / YourMT3+ / MIROS 可选引擎）。

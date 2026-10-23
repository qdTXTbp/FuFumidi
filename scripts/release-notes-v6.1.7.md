# FuFumidi 6.1.7

## 改进

- 自动探测返回 `program_105` 这类未分组 GM 音色时，不再直接丢弃，而是按 General MIDI 家族映射到 MuScriptor 已有的 35 个乐器组：
  - 例如 `program_105` → `acoustic_guitar`，`program_71` → `clarinet`。
  - 没有合理近似的 `program_120`–`program_127`（音效类）仍然丢弃。
- 映射只落在已有组上，不改变模型词表，也不会绕过 MuScriptor 的硬约束校验；日志会输出「映射近似乐器组」。

其余功能与 6.1.6 一致（含转录完成提示音、hFT-Transformer / YourMT3+ / MIROS 可选引擎、非法乐器组过滤）。

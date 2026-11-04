# ADR-0002：Tauri 替换 Electron；非 ML 尽量 Rust，Python 仅保留模型推理

- 状态：**已接受（2026-11-04，用户决定）**
- 关联：[ADR-0001](ADR-0001-cancel-python-engine-replacement.md)（取消 Python 引擎替换）、
  [整合总方案](../plans/2026-11-03-master-integrated-plan.md)、[AI 实现规格](../plans/2026-11-03-master-ai-spec.md)

## 背景

用户先决定「Rust/ONNX 替换 Python 引擎」不执行（ADR-0001），并要求「现有模型都能使用」；
随后明确「继续用 Tauri 替换 Electron」，再追加「在这些前提下,尽量都用 RUST 重写」。

因此目标不是「全 Rust、无 Python」，而是**混合架构**：
Tauri(Rust) 负责外壳、主进程逻辑与非 ML 算法；Python 只保留**模型推理**这一层（及其不可替代的第三方依赖）。

## 决策

1. **Tauri 2 替换 Electron**：窗口/托盘/单实例/热键/自启/文件关联/数据根/日志/更新器、IPC 宿主、插件宿主。
2. **非 ML 尽量 Rust**（按收益排序）：
   - 主进程业务：文件/工程/设置/曲库/任务队列/下载/更新/导出/崩溃与日志；
   - 纯算法：SMF/SF2/MusicXML/ustx 转换、MIDI 编辑/量化/统计、UTAU/OpenUTAU 渲染 DSP；
   - 音频链：解码/重采样/降噪/DSP/LUFS/编码（ffmpeg sidecar 允许）；
   - OMR 编排、模型下载/校验、任务调度与进度事件；
   - 可选：已 ONNX 的模型可用 `ort` 加速，但**不作为替换 Python 推理的硬要求**。
3. **Python 只做模型推理**：Basic Pitch / MuScriptor / YourMT3+ / MIROS / 钢琴模型、MSST 分离、
   DiffSinger 声库、RVC 变声等；由 Rust 启动并管理 Python sidecar，模型格式/ID/路径/下载源不变。
4. **允许的外部依赖**：Audiveris(Java)、ffmpeg、C/C++ 库（WebView2/音频/压缩）、Python runtime；
   「尽量 Rust」不等于为了纯血放弃可用性。

## 决策边界（不做）

- 不做「移除 Python / 无 Python 全功能」；不导出/改写模型格式（ADR-0001）。
- 不要求 Rust 重写训练栈、OMR 引擎（Audiveris）、MSST 29 种架构推理。
- 不为了 Rust 化而改变现有 IPC 契约语义；迁移必须逐步替换并保持双跑回归。

## 后果

- `main/*.js` 将被 Rust host 逐步替换；过渡期 Electron 与 Tauri 双轨，最终默认 Tauri。
- 包体仍包含 Python runtime 与模型（约 1.1 GiB 构建口径），不再追求 ≤250 MiB。
- 需要新增：Rust host / IPC 代码生成 / Python sidecar supervisor / Rust 音频链 / A 类算法对拍。
- 现有模型与转录/分轨/OMR/调教/翻唱功能必须持续可用（R-014 硬约束）。

## 证据

- 用户原话（2026-11-04）：「继续用 Tauri 替换 Electron」「在这些前提下,尽量都用 RUST 重写」。
- POC：docs/rust/TAURI-POC.md（外壳可行；IPC 缺 ~172 条；更新链需自研）。

# ADR-0001：取消「Rust/ONNX 替换 Python 引擎」

- 状态：**已接受（2026-11-04，用户决定）**
- 决策人：用户
- 影响范围：转录/分轨/OMR/调教/翻唱的推理引擎、Rust 引擎 A 类迁移、ONNX 推理、去 Python 的里程碑与验收
- 关联：[整合总方案](../plans/2026-11-03-master-integrated-plan.md)、[AI 实现规格](../plans/2026-11-03-master-ai-spec.md)、[ML 边界调研](../plans/rust-rewrite/03-engine-ml-boundary.md)

## 背景

原 A 口径计划在 Tauri 2 外壳下用 Rust/ONNX 替换全部 Python 引擎，并在 M3/M4 移除 Python。
调研（03-engine-ml-boundary）证明：Basic Pitch / audio-tagger / hnsep / DiffSinger / rmvpe 已经是 ONNX，
但 MuScriptor、YourMT3+、MIROS、piano_pt、Aria-AMT、Transkun、hFT、MSST、RVC 主体都是 torch 动态图，
导出困难或不可行；用户导入的 RVC 音色也无法保证逐个成功转换。
强行推进会导致功能缩水、模型失效或包体膨胀（可选 tch 包 1–2 GB）。

## 决策

**不执行「Rust/ONNX 替换 Python 引擎」这一项改动。**
Python 引擎（含 torch/onnxruntime、模型与运行时）作为产品的正式组成部分保留。
不再以「去 Python / 安装包 ≤250 MiB / 首任务 ≤1.5 s」作为运行时验收。

## 保留项（不在本 ADR 取消范围）

- Tauri 2 外壳 POC 与后续「去 Electron」方向（待单独确认是否继续投入）。
- Rust 非 ML 核心（SMF/统计/量化/移调、可选批处理加速）继续作为**可选**能力保留；
  已完成的 `crates/` 与 `main/rust.js` 不删除。
- 契约层（IPC/引擎参数 schema）、现有门禁、品牌/设计约束继续有效。
- 产品专业化升级（6.6 / 6.7 / 6.8）不受影响，继续按计划推进。

## 后果

- 安装包体积与首任务延迟维持现状（Python 运行时 ~1.1 GiB 构建口径）；不再以缩小包体为目标。
- 智能分轨、转录、OMR、调教、翻唱全部保持现有 Python 实现与模型格式，用户无需迁移模型。
- 原方案中的 R-007（Rust 引擎 A 类）、R-008（Rust 音频链）、R-009（ONNX 推理）、
  R-010（去 Python）、R-011（原生 probe/deps）、W-E0…W-E4、T-306/T-307/T-308 冻结，不再执行。
- 本文档保留为历史决策记录；后续若重启该方向，需要新 ADR。

## 证据

- 用户原话（2026-11-04）：「Rust/ONNX 替换 Python 引擎,这一项改动不执行了」。
- 现状：Rust workspace 仅覆盖 SMF/统计/量化/移调（64 测试），尚未接任何推理；Python 引擎与模型完全未动。

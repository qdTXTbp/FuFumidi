# FuFumidi 全 Rust 技术栈重写方案（A 口径 · v3）

> 版本基线：**6.5.0-beta.1**（2026-11-04 用户指定；base commit 47f6062）。
> 决策记录：**2026-11-03 用户选定 A 口径** —— 外壳与业务后端全部 Rust，运行时不再有 Electron 与 Python；UI 保留 Web（Vue 3）跑在 WebView2 里。
> 配套方案：**功能升级见 [专业化音乐制作工具升级方案](./2026-11-03-pro-daw-upgrade-plan.md)**；**两者已合并为 [整合总方案](./2026-11-03-master-integrated-plan.md) + [AI 实现规格](./2026-11-03-master-ai-spec.md)**（本文件保留为 A 口径技术细节）。
> 前置阅读：[主方案 v2](./2026-11-03-rust-rewrite-plan.md) + 证据附件 [01](./rust-rewrite/01-perf-evidence.md) / [02](./rust-rewrite/02-frontend-hotpaths.md) / [03](./rust-rewrite/03-engine-ml-boundary.md) / [04](./rust-rewrite/04-shell-decision.md) / [05](./rust-rewrite/05-ecosystem.md)。
> 本文件只写「A 口径相对 v2 的差异与完整执行计划」；v2 中的性能证据、引擎可移植矩阵、许可证与生态结论继续有效。

---

## 0. 结论与口径

### 0.1 一句话

**可行，但这是一次「换运行时」级别的大工程：3 人 12–18 个月、核心 530–840 人日（含 25% 缓冲 660–1,050）。** 成败不在 Rust 语言，而在四件事：**Tauri 更新链重建、插件宿主兼容、printToPDF、torch 系模型去 Python**。这四件必须先用 4–6 周 POC 证明，再投入全量。

### 0.2 A 口径的准确边界（必须先说清）

| 层 | A 口径下的形态 | 说明 |
|---|---|---|
| 外壳 | **Tauri 2（Rust）** | 替代 Electron；WebView2 由系统提供 |
| 主进程 | **Rust（Tauri commands + 服务）** | 替代 main/*.js 的 Node 主进程 |
| 引擎 | **Rust sidecar / 内嵌 crate** | 替代 engine/*.py |
| ML 推理 | **ONNX Runtime（ort）**；个别模型允许 tch(libtorch) 或砍功能 | 允许的 C/C++ 依赖走绑定 |
| UI | **保留 Vue 3（Web）** | 「连 UI 也 Rust 原生」是 B 口径，另加 600–900 人日；本方案不做 |
| 系统依赖 | WebView2、视频/音频 C 库、verovio（LGPL）等 | 通过绑定/动态库使用，不算「自有代码」 |
| 运行时不再有 | Electron、Node 主进程、Python | 渲染层仍有 JS（UI 代码），这是 A 口径的公认例外 |

> 如果「完全用 Rust」要求连 Vue/JS 界面都不留，请明说 —— 那是 B 口径（原生 UI），本方案需再 +600–900 人日，且中文输入法/无障碍/乐谱交互生态会明显退化。

### 0.3 与 v2 的差异（重点）

| 项 | v2（内核重写，保留 Electron） | v3（A 口径，全 Rust 技术栈） |
|---|---|---|
| 外壳 | Electron 37 保留 | **Tauri 2，Electron 在 GA 前作回退** |
| 主进程 | Node（main/*.js 19,063 行） | **Rust 重写** |
| 引擎 | Rust 逐步替换 Python | **Rust 全量，Python 最终删除** |
| 更新链 | 沿用 Kachina | **自研 Rust 更新器 + 老用户迁移桥** |
| 插件 | Node vm 沙箱保留 | **rquickjs 内嵌（保留 CommonJS 兼容）或 WASM（破坏兼容）** |
| 打印/PDF | Electron printToPDF | **WebView2 COM 或替代方案（POC 决定）** |
| 体积目标 | 606→≤350 MiB（base） | **安装包 ≤250 MiB、安装后 ≤500 MiB（base）** |
| 工程量 | 180–280 人日（内核） | **530–840 人日（核心）+ 25% 缓冲** |
| 周期（3 人） | 6–8 个月 | **12–18 个月（含 POC 与双轨）** |

---

## 1. 目标架构

    渲染进程（Vue 3 + Vite + Canvas/WebGL，保留）
      window.fuBridge（252 通道 API 形状不变）
      bridge/tauri.js → Tauri invoke（由代码生成，避免手写 252 条）
    ┌─────────────────────────────────────────────────────────┐
    │ Tauri 2 外壳（Rust）                                     │
    │  · 窗口/splash/托盘/单实例/全局热键/自启/文件关联          │
    │  · 数据根/日志/崩溃钩子/完整性校验/GPU 探测                │
    │  · 更新器（多源测速/增量/Ed25519 验签/守护重启）            │
    │  · 下载器（快下：分段/续传/看门狗/完整性）                 │
    │  · 插件宿主（rquickjs 沙箱 + 白名单 require）              │
    │  · 数据库（rusqlite+WAL）/ 设置 / 工程 / 资源中心          │
    │  · 模型管理（目录/校验/安装状态机/GPU 包）                 │
    │  · 壁纸引擎（多 webview + 录屏）/ 视频导出（WebCodecs/ffmpeg）│
    │  · PDF（WebView2 PrintToPdf 或替代）                      │
    └───────────────▲─────────────────────────────────────────┘
                    │ 进程内调用或 sidecar JSON 行协议（###PROG/###RESULT）
    ┌───────────────┴─────────────────────────────────────────┐
    │ Rust 引擎（fufumidi-engine）                             │
    │  core：SMF/MIDI、时间图、量化/移调、MusicXML、SF2/SF3、ustx │
    │  audio：解码(symphonia)/重采样(rubato)/DSP/LUFS/编码       │
    │  ml：ort（Basic Pitch/audio-tagger/DiffSinger/hnsep/rmvpe/│
    │      RVC 导出件）、模型仓库、EP 选择、warm session         │
    │  utau：OpenUTAU/UTAU 渲染（numpy DSP → Rust）             │
    │  jobs：任务/取消/暂停/进度/看门狗                          │
    └─────────────────────────────────────────────────────────┘
    外部依赖（允许，通过绑定/动态库）：
      WebView2 · ONNX Runtime · verovio(LGPL) · ffmpeg · libfluidsynth
      · Audiveris(Java, 若保留 OMR) · VST3 插件宿主（若有）

### 1.1 前端如何保持「零改动」

- window.fuBridge 形状保持不变；新增 bridge/tauri.js 适配层：invoke(domain:action, payload) → Tauri command。
- 252 条通道、28 个事件由 **同一份 schema 生成** Rust command 注册、TS 类型、桥适配层（v2 已规划的 params.schema.json 扩展）。
- 迁移期前端同时支持两种桥（Electron preload / Tauri invoke），由启动时探测决定；GA 后删除 Electron 分支。

### 1.2 为什么保留 Vue UI

- UI 不是本次目标（v2 §3.2）；且 Tauri 仍用 WebView2，保留 Vue 是零成本的。
- 前端 78,563 行、23 视图、13,491 行 i18n 是产品资产；换原生 UI 属 B 口径，另计。

---

## 2. 四个生死 POC（4–6 周，Gate G-A）

> 四个 POC 各 3–5 天，全部通过才进入全量；任何一个失败都触发「替代方案」或「回到 v2」。

| # | POC | 验证什么 | 通过标准 | 失败时的替代 |
|---:|---|---|---|---|
| P1 | **更新链 + 签名 + 迁移** | Tauri 应用能否：多源测速 → 下载 → Ed25519 验签 → 静默 NSIS 安装 → 重启；老 Electron 用户如何升到新外壳 | 端到端跑通 3 个源；失败可回滚；老版本可经「迁移桥」升级 | 保留 Kachina 作为外部 updater（Rust 壳调用），代价是第三方无源码风险继续存在 |
| P2 | **插件宿主** | 用 rquickjs（嵌入式 QuickJS）加载现有 CommonJS 插件：plugin.json + activate(ctx) + 白名单 require + 事件/命令 | 2–3 个真实插件零改动跑通；崩溃隔离；体积增加 ≤5 MiB | 改 Extism/WASM：**现有插件全部失效**，需插件作者重写（产品决策） |
| P3 | **printToPDF** | Tauri/WebView2 下能否无交互把乐谱页导出 PDF，与现网 printToPDF+打印 CSS 分页等价 | 页数/页边距/字号与 Electron 版逐页对比通过 | ① 保留一个最小 Chromium sidecar 只做 PDF（+80–150 MiB）；② 接受系统打印对话框；③ 自研 PDF 排版（不现实，+40–60 人日且效果降级） |
| P4 | **视频导出 + 壁纸录屏** | WebView2 的 WebCodecs 硬编可用性；壁纸引擎多 webview + 录屏；不行则 ffmpeg 兜底 | 导出 30 s 视频与现网一致（分辨率/帧率/码率）；CPU 回退可用 | 全部走 ffmpeg 子进程（保留外部二进制） |

**Gate G-A**：P1–P4 全过（或有明确可接受的替代）→ 进入阶段 1；否则暂停，回到 v2（Electron + Rust 内核）。

### 2.1 先做的两件「非代码」准备

1. **Authenticode 代码签名证书**：新 exe = 从零积累杀软/SmartScreen 信誉；现在是「待证书」状态，必须先落实（采购周期可能 1–2 周）。
2. **更新源与安装器身份**：决定产品名/AppId/升级路径；老用户从 Electron 版迁移，不能丢数据根与设置。

---

## 3. ML 去 Python 的裁决表（A 口径最大风险）

> 来源：03 §3.1 的可移植矩阵。A 口径要求「运行时无 Python」，因此每个 torch 模型必须三选一：**ONNX 导出 / tch(libtorch) 绑定 / 砍功能或降级**。

| 模型/链路 | 现状 | A 口径建议 | 风险/代价 |
|---|---|---|---|
| Basic Pitch（通用转录） | 已是 ONNX | **ort 直接跑** | 前后处理需重写 + 对拍 |
| audio-tagger / CED | 已是 ONNX int8 | **ort 直接跑** | 低 |
| DiffSinger（4 模型） | 全 ONNX | **ort 跑**；G2P/音素化需移植 | G2P（pypinyin/多语言）工程量中 |
| hnsep（Worldline） | ONNX | **ort 跑** | 前后处理需重写 |
| RVC 的 rmvpe | ONNX | **ort 跑** | 低 |
| RVC 变声主体 | torch | **优先 ONNX 导出**（VITS 解码器 + HuBERT 导出）；导出失败则 tch 或砍翻唱 | 导出可行性待实测；翻唱是卖点，建议保留 tch 可选包 |
| piano-transcription（transkun） | torch，自定义 semiring CRF | **尝试 ONNX；失败则 tch；否则降级/下线** | 钢琴高质量转录可能保不住 |
| MuScriptor（103M/307M/1.4B） | torch safetensors | **ONNX 导出 1.4B 不现实**；建议：只保留 ONNX 可导的小模型，或 tch 可选包 | 多轨转录核心卖点，需产品决策 |
| MSST 分离（29 架构） | torch | **只迁 2–3 个主力架构到 ONNX**，其余下线 | 分离质量/速度可能变化 |
| aria / hft / yourmt3 / miros | torch/ckpt | **建议下线或 tch 可选包** | 每个都带独立运行时，纯 Rust 化收益最低 |
| UTAU/OpenUTAU 渲染 | numpy DSP | **Rust 重写**（A 类，1,586+ 行） | 听感需人工 A/B |
| OMR（Audiveris） | Java 外部进程 | **保留 Java sidecar**（外部二进制，不算自有代码） | 若「零外部进程」则需自研 OMR（不建议） |

**默认裁决（需用户确认 D-A1）**：
- 保留：Basic Pitch、audio-tagger、DiffSinger、hnsep、rmvpe、UTAU/OpenUTAU（Rust）、OMR（Java sidecar）、ffmpeg。
- 尝试 ONNX：RVC 变声主体、piano（transkun）。
- 允许 tch 可选包（+1–2 GB，仅在使用时下载）：RVC 主体、piano（若 ONNX 失败）。
- 砍掉/降级：muscriptor 大模型、aria、hft、yourmt3、miros、MSST 非主力架构（如果用户不接受功能缩水，则必须接受 tch 包或回到 v2 保留 Python）。

---

## 4. 分阶段路线图（3 人，12–18 个月）

> 分工建议：1 人 Rust 系统/外壳（Tauri、更新、插件、系统集成）；1 人 Rust 引擎（core/audio/ML/UTAU）；1 人 ML+前端+集成（ONNX 对拍、桥适配、QA）。
> 双轨原则：Electron 版保留为主发布版，直到 Tauri 版通过「功能对齐 + 稳定期」；Tauri 版先走 Beta 通道。

### 阶段 0 · POC 与骨架（第 0–2 个月）

| 事项 | 交付/验收 |
|---|---|
| P1–P4 四个 POC | Gate G-A 通过；每个 POC 有失败替代方案与决策记录 |
| 签名证书与安装器身份 | 证书申请/采购启动；安装器 AppId 确定 |
| Rust workspace + Tauri 骨架 | 能启动空壳：窗口/splash/托盘/单实例/日志/数据根 |
| Rust 内核骨架（继承 v2 Phase 1） | sidecar 协议 + 原生 probe/deps + SMF 解析；对拍框架 |
| 前端桥适配层原型 | Vue 页面在 Tauri 里跑通；10 条通道试点（文件、设置、日志） |

**Gate G0-A**：POC 全过 + 骨架能跑 → 进入阶段 1；否则回 v2。

### 阶段 1 · 双轨 Alpha（第 2–6 个月）

| 事项 | 交付/验收 |
|---|---|
| Tauri 宿主系统集成 | 窗口/splash/托盘/单实例/热键/自启/文件关联（运行期可开关）/数据根迁移/崩溃钩子/日志/诊断包 |
| IPC 适配层与代码生成 | 252 通道 schema → Rust command + TS 类型 + 桥适配；先覆盖 60%（文件/工程/设置/资源/播放相关） |
| Rust 引擎 A 类 | SMF/MIDI、量化/移调、SF2/SF3、MusicXML→MIDI、ustx；对拍 100% |
| 前端可运行主流程 | 在 Tauri 壳里：打开工程 → 播放 → 编辑 → 保存（引擎走 Rust sidecar） |
| 双构建流水线 | Electron 版照旧；Tauri 版出内部包（不对外） |

**验收**：内部 Alpha 冒烟清单全绿（12 条核心流程）；性能不低于 Electron 版基线（启动/帧率/内存待实测）。

### 阶段 2 · 功能对齐 Beta（第 6–10 个月）

| 事项 | 交付/验收 |
|---|---|
| 剩余 40% IPC 与主进程模块 | 模型管理、下载器、GPU 包、DS/UTAU/RVC/OMR/score、任务中心、反馈、壁纸、视频导出 |
| 更新链生产化 | 自研 Rust 更新器：多源、测速、增量、Ed25519、静默安装、守护重启；Beta 通道灰度 |
| 数据库/设置迁移 | sql.js → rusqlite(WAL)；旧库迁移脚本 + 回滚 |
| 音频链 + ONNX 推理 | Basic Pitch/audio-tagger/DiffSinger/hnsep/rmvpe；质量对拍 |
| 老用户迁移桥 | 在最后一个 Electron 版本内置「下载并运行 Tauri 安装器」；数据根/设置/工程兼容验证 |
| 稳定性 | 崩溃看门狗、日志、失败回退、7×24 smoke |

**验收**：Beta 功能对齐率 100%（对照 30 项系统能力清单）；安装包/启动/内存达到阶段目标；灰度高危问题清零。

### 阶段 3 · RC 与去 Python（第 10–14 个月）

| 事项 | 交付/验收 |
|---|---|
| ML 裁决执行 | ONNX 导出成功项删除 Python 路径；需 tch 的模型进可选包；决定砍掉的功能并在发布说明中明示 |
| 插件宿主生产化 | rquickjs 方案通过真实插件集验证；崩溃隔离/权限/白名单/超时 |
| PDF/打印 | 按 P3 结果落地（COM 或替代） |
| 视频/壁纸 | WebCodecs 或 ffmpeg 兜底；录制/导出对齐 |
| 移除 Python 运行时 | resources/python 删除；AI Pack 改为按需下载（含 tch 可选包） |
| 性能与体积 | 安装包 ≤250 MiB（base）、安装后 ≤500 MiB；启动/PSS 实测达标 |

**验收（G2-A）**：base 无 Python 全功能可用；转录/分离/翻唱质量对拍达标；Tauri 版连续 2 周 Beta 无 P0。

### 阶段 4 · GA 与清理（第 14–18 个月）

| 事项 | 交付/验收 |
|---|---|
| 全量发布 | Tauri 版成为默认下载；Electron 版标记停止维护 |
| 老用户迁移 | 旧版本经迁移桥升级成功率 ≥99%；失败可回退旧安装包 |
| 删除 Electron/Node/Python | main/*.js、preload.js、engine/*.py 下线；仓库归档说明 |
| 清理与文档 | FOUNDATION/AGENTS/licenses/VENDOR 更新；删除 src-tauri 旧原型 |

---

## 5. 工程量 WBS（人日，核心 → 含 25% 缓冲）

| 工作包 | 人日 | 阶段 |
|---|---:|---|
| P1–P4 四个 POC | 15–25 | 0 |
| Tauri 宿主骨架（窗口/splash/托盘/单实例/热键/自启/文件关联/数据根/日志/崩溃/对话框） | 30–45 | 0–1 |
| IPC 适配层（252 通道 + 28 事件 + 类型生成 + 错误语义 + 桥） | 45–65 | 1–2 |
| 主进程模块移植（models/catalog/diffsinger/utau/omr/score/soundfonts/presets/project/library/db/settings/paths/gpu/video/wallpaper/feedback/taskcenter） | 70–100 | 2 |
| 更新链 + 签名 + 迁移桥 | 35–55 | 2 |
| 下载器重写（fast-download 等价 + 测试集） | 15–22 | 2 |
| 插件宿主（rquickjs 或 WASM） | 25–40 | 2–3 |
| PDF/打印 | 10–20（COM 可行）/ 40–60（替代） | 3 |
| 壁纸引擎 + 视频导出 | 20–30 | 2–3 |
| 打包/CI/安装器/签名/发布流水 | 20–30 | 2–4 |
| 前端桥适配 + 迁移 UI + i18n/版本提示 | 20–35 | 1–2 |
| Rust 引擎 core A 类 | 35–55 | 1 |
| Rust 音频链（解码/重采样/DSP/编码） | 30–45 | 2 |
| ONNX 推理（Basic/audio-tagger/DiffSinger/hnsep/rmvpe）+ 模型仓库 | 30–45 | 2–3 |
| UTAU/OpenUTAU 渲染 | 40–70 | 2–3 |
| torch 去 Python 裁决与实施（导出/tch/砍功能） | 30–60 | 3 |
| Python 运行时移除 + AI Pack 重组 | 10–20 | 3 |
| 前端既有 P0/性能修复（v2 Phase 0 内容） | 10–15 | 0–1 |
| QA/双跑/回归/性能门禁 | 40–60 | 全程 |
| **合计** | **530–840** | — |
| **含 25% 缓冲** | **660–1,050** | — |

**工期换算**：
- 3 人（60 人日/月）：**9–14 个月（核心）→ 12–18 个月（含缓冲）**。
- 2 人（40 人日/月）：**13–21 个月 → 17–26 个月**。
- 单人：不推荐（24–36 个月，且产品停更风险极高）。

---

## 6. 目标指标

| 指标 | Electron 版现状 | A 口径目标 | 置信度 |
|---|---:|---:|---|
| 安装包（base） | 606.3 MiB | **≤250 MiB** | 中高（去掉 Electron+Python 后主要剩 WebView2 系统依赖、models、Rust 二进制） |
| 安装后（base） | 1,691.5 MiB | **≤500 MiB** | 中高 |
| 冷启动到可交互 | 820 ms（旧基线） | **≤600 ms（待 POC 实测）** | 中（Tauri+WebView2 通常更快，但渲染层不变） |
| 运行时内存（PSS） | 待实测（Electron 基线未测） | **−30–40%** | 中（需实测对比） |
| 首次转录固定开销 | 10.65 s | **≤1.5 s**（Rust 引擎常驻） | 中高 |
| 资源中心 | 11.6 s CPU | **<100 ms** | 高 |
| 导出后处理（2 min 立体声） | 0.7 s | **≤0.15 s**（napi/原生） | 中高 |
| 安装体积（数据根） | 32.7 GiB | 不变（模型资产仍在） | 高 |
| 转录质量/速度 | 基线 | 质量平齐；速度不变（模型算力） | 高 |

**不承诺**：转录更快、UI 更顺滑（UI 仍是 Web）、「零外部进程」（Audiveris/ffmpeg 仍是外部二进制）、原生音频低延迟（ASIO 另议）。

---

## 7. 风险与止损（A 口径新增）

| # | 风险 | 概率/影响 | 对策 | 止损 |
|---:|---|---|---|---|
| A-R1 | P3 printToPDF 无解 | 中/高 | POC 先验；备选 COM/最小 Chromium sidecar/打印对话框 | P3 失败且不接受替代 → 回 v2 |
| A-R2 | 插件兼容（rquickjs）不如预期 | 中/中 | P2 用真实插件集验证；保留 WASM 长期路线 | 失败 → 插件生态降级（需用户接受） |
| A-R3 | 更新链迁移断代（老用户升不上来） | 中/高 | 最后一个 Electron 版内置迁移桥；灰度；保留旧安装包 | 升级成功率 <95% → 延长双轨 |
| A-R4 | torch 模型无法 ONNX 且不接受 tch | 高/高 | 逐模型裁决表；默认砍掉低收益模型 | 功能缩水不可接受 → 回 v2（保留 Python） |
| A-R5 | WebView2 依赖（企业策略/离线/旧系统） | 中/中 | 安装器带 WebView2 bootstrapper；检测提示 | 目标用户环境不满足 → 回 v2 |
| A-R6 | 新 exe 杀软/SmartScreen 信誉从零 | 高/中 | 尽早买证书；灰度；提交误报 | 误报率高 → 延长 Electron 双轨 |
| A-R7 | 双轨期 12–18 个月维护成本 | 高/中 | Electron 只修安全/数据 bug；功能只进 Tauri | 双轨超 18 个月 → 冻结新功能 |
| A-R8 | 体积不达 ≤250 MiB（tch/模型） | 中/中 | 模型全部按需下载；tch 可选包 | 超标 → 目标改 ≤350 MiB 并说明 |
| A-R9 | UI 仍是 Web，用户预期「全 Rust=更快」落空 | 中/中 | 发布说明明确「本次换运行时，不改 UI」 | 预期管理失败 → 提前沟通 |
| A-R10 | 团队只有 1–2 人 | 中/高 | 按阶段可发布；先 POC 再投入 | 资源不足 → 只做 v2 R0/R1 |

**总止损线**：阶段 2 结束（第 10 个月）若 IPC 对齐 <90% 或更新链未生产化 → 停止，回退到 v2 的「Electron + Rust 内核」形态，已完成的 Rust 引擎与 IPC 适配仍可复用。

---

## 8. 需要现在拍板的决策

| # | 决策 | 选项 | 建议 |
|---:|---|---|---|
| **D-A1** | ML 取舍 | ① 保留 ONNX 可迁项 + 砍 muscriptor/aria/hft/yourmt3/miros/MSST 非主力（base 小）② 全部保留，用 tch 可选包（+1–2 GB）③ 回 v2 保留 Python | **① + tch 仅给 RVC/piano**（需确认功能缩水可接受） |
| **D-A2** | 插件兼容 | rquickjs（保留 CommonJS）/ WASM（破坏现插件） | **rquickjs**（P2 验证） |
| **D-A3** | 更新链 | 自研 Rust 更新器 / 继续用 Kachina（外部无源码） | **自研**（P1 验证） |
| **D-A4** | PDF 方案 | WebView2 COM / 最小 Chromium sidecar / 系统打印对话框 | P3 后定；优先 COM |
| **D-A5** | 双轨与节奏 | 12–18 个月双轨（Electron 只修 Bug）/ 停更全量转 | **双轨**，但新功能只进 Tauri |
| **D-A6** | 安装体积目标 | base ≤250 MiB / ≤350 MiB / 不设目标 | **先按 ≤250 设计，达标不了改 350** |

---

## 9. 验收与迁移

- **功能验收**：30 项系统能力清单逐项打勾（04 §2）；12 条核心流程冒烟；250 条 IPC 通道 100% 覆盖；28 个事件通道退订语义保持。
- **质量验收**：转录/分离/翻唱对拍（F1/音高/时值/听感）；MIDI/工程/导出事件级/逐样本对拍；更新链灰度；崩溃率。
- **迁移验收**：老 Electron 用户升级成功率 ≥99%；数据根/设置/工程/插件/模型不丢；可回退旧安装包。
- **性能验收**：perf:gate 进 CI；Tauri 版 vs Electron 版同场景对比（启动/帧率/PSS/首任务/导出）。
- **回退方案**：发布包保留旧版下载；迁移桥失败自动留在旧版；数据格式向前兼容一个版本。

---

## 10. 与 v2 的关系（怎么落地）

1. **v2 的 Phase 0（止血）照做**——它们与外壳无关，且是 A 路线的前置（基准、契约、db 修复、资源中心缓存等）。
2. **v2 的 Rust 引擎（Phase 1–3）直接复用**为 A 路线的引擎部分；A 路线只是把外壳从「保留 Electron」改为「Tauri 并行」。
3. **Tauri 外壳从阶段 0 开始并行**（POC + 骨架），不等到 Phase 4。
4. **Python 退场按 §3 的裁决表执行**；torch 不可迁项要么 tch 可选包，要么砍功能，不能「悄悄留着」。
5. **Electron 在 GA 前保留为回退**；GA 后删除 main/*.js、preload.js、engine/*.py 与 Electron 依赖。

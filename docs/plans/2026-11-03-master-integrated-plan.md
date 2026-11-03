# FuFumidi 整合总方案：专业化音乐制作 + 全 Rust 技术栈（2026-11-03）

> 状态：**总方案 v1（待拍板）**
> 合并来源：[主方案 v2（证据与内核）](./2026-11-03-rust-rewrite-plan.md)、[A 口径全 Rust 方案 v3](./2026-11-03-rust-fullstack-plan.md)、[专业化升级方案](./2026-11-03-pro-daw-upgrade-plan.md)、证据附件 [01](./rust-rewrite/01-perf-evidence.md)…[05](./rust-rewrite/05-ecosystem.md)。
> 执行规格：[AI 实现规格（机器优先）](./2026-11-03-master-ai-spec.md)——所有任务、依赖、验收、上下文预算都在那里；本文件负责「为什么这样做、最终长什么样、怎么排期」。
> 读者：项目负责人（拍板）+ 后续 AI 执行者（按 ai-spec 干活）。

---

## 0. 一页结论

### 0.1 三句话

1. **把两张皮合成一张路线图**：产品专业化（6.6 能用 → 6.7 骨架 → 6.8 专业化）与运行时重写（Rust A 口径：Tauri 2 + Rust 引擎 + ONNX，去掉 Electron/Python）不是两条独立项目，而是同一批里程碑里的两个交付面。每个版本既要「用户能感知的功能」，也要「运行时少一块旧的」。
2. **先冻结数据模型，再动两条线**：工程模型 v2（轨道/拍号/速度图/片段/自动化/曲线归属）是功能与重写共同的地基。第 0 个月只做这一件事 + 四个 POC + 止血；之后功能与运行时并行，谁都不改数据模型。
3. **人力决定节奏**：3 人 18–24 个月、4–5 人 12–18 个月、2 人只能串行（先 6.6 + Rust 内核，再专业化）。总工作量去重后约 **950–1,450 人日**；其中功能升级 350–500，运行时 530–840，共享/测试/门禁 70–110。

### 0.2 合并后的总目标（可验收）

| # | 目标 | 验收（用户视角） | 负责里程碑 |
|---:|---|---|---|
| G1 | 专业 MIDI 工作流 | 从零写 8 小节 ≤10 分钟；循环里改 10 个音不丢位置；50 次撤销内存 <50 MB | M0/M1 |
| G2 | 转录/制谱校对闭环 | 3 分钟音频 ≤30 分钟完成校对；识谱结果可逐音在谱上核对 | M2/M3 |
| G3 | 编排参与播放 | 移动/裁剪/静音片段直接影响声音与导出；24 轨工程完整可见 | M1/M2 |
| G4 | 全 Rust 运行时 | 安装包 ≤250 MiB、安装后 ≤500 MiB；无 Electron、无 Python；首任务 ≤1.5 s | M3/M4 |
| G5 | 可替换的插件与更新 | 现有插件零改动可用；自研更新器多源/增量/验签；老用户升级成功率 ≥99% | M3/M4 |
| G6 | 可复现的工程效率 | 所有任务 AI 可执行：有上下文、验收命令、回滚；CI 门禁全绿；perf gate 进 CI | 全程 |

### 0.3 关键数字（合并后）

| 项 | 数值 | 说明 |
|---|---:|---|
| 总工作量（去重） | **950–1,450 人日** | 功能 350–500 + 运行时 530–840 + 共享 70–110 |
| 3 人 | 18–24 个月 | 串行为主 |
| 4–5 人 | 12–18 个月 | 功能与运行时并行 |
| 2 人 | 24–30 个月 | 只能串行，先 6.6 → Rust 内核 |
| 首个可见收益 | **4–6 周** | M0 的 6.6 止血 + 试听/多选/吸附/标尺 |
| 首个运行时收益 | **4–6 个月** | Rust probe/存储/导出 + Tauri Alpha |
| 最终体积 | 安装包 606.3→**≤250 MiB**；安装后 1,691.5→**≤500 MiB** | base 不含 torch 可选包 |

---

## 1. 合并原则（为什么不是两张皮）

1. **一个数据模型**：工程模型 v2 是功能升级（轨道/拍号/撤销/曲线归属）与 Rust 引擎（core 的 Song/Timeline）共同的规范；冻结一次，两边只读。
2. **一个契约层**：250 条 IPC + 28 事件 + 引擎 JSON 协议，全部由 params.schema.json 单一来源生成 Rust command / Python 转发 / TS 类型 / 桥适配。功能与重写都按它实现，避免「功能改了桥、重写又改一遍」。
3. **一个门禁**：构建、类型、单测、pytest、CDP 冒烟、perf gate、双跑对拍、契约漂移检查——同一套命令、同一份基线，功能版本与运行时版本共用。
4. **一个版本号**：6.6/6.7/6.8 是功能版本，7.0 是全 Rust GA；但 6.7/6.8 同时承载 Tauri Alpha/Beta，用户只感知一份产品。
5. **先止血后手术**：M0 先修「用了就放弃」的 P0（试听/多选/吸附/走带/快捷键/撤销时机），这些与语言无关，且是后面所有验收的地基。

---

## 2. 目标架构（A 口径）

    渲染进程：Vue 3 + Vite（保留，零改 API 形状）
      window.fuBridge（252 通道 + 28 事件）
      bridge/electron.js | bridge/tauri.js（由 schema 生成，启动时探测）
    ┌──────────────────────────────────────────────────────────┐
    │ 外壳：Tauri 2（Rust）                                     │
    │  窗口/splash/托盘/单实例/热键/自启/文件关联/数据根/日志     │
    │  更新器：多源测速→增量→Ed25519→静默安装→守护重启            │
    │  下载器：分段/续传/看门狗/完整性（fast-download 等价）      │
    │  插件宿主：rquickjs 沙箱（保留 CommonJS 兼容）              │
    │  数据库：rusqlite + WAL；设置/工程/资源中心                │
    │  模型管理/GPU 包/壁纸引擎/视频导出/PDF 导出                │
    └───────────────▲──────────────────────────────────────────┘
                    │ 进程内调用 或 sidecar JSON 行协议（###PROG/###RESULT）
    ┌───────────────┴──────────────────────────────────────────┐
    │ Rust 引擎：fufumidi-engine                               │
    │  core：Song/Timeline/拍号速度图/量化/移调/MusicXML/SF2/ustx │
    │  audio：symphonia/rubato/DSP/LUFS/编码                    │
    │  ml：ort（Basic Pitch/audio-tagger/DiffSinger/hnsep/rmvpe）│
    │  utau：UTAU/OpenUTAU 渲染（numpy DSP → Rust）             │
    │  jobs：任务/取消/暂停/进度/看门狗/健康探测                 │
    └──────────────────────────────────────────────────────────┘
    外部依赖（允许，绑定/动态库）：
      WebView2 · ONNX Runtime · verovio(LGPL) · ffmpeg · libfluidsynth
      · Audiveris(Java, OMR) · tch 可选包（仅无法 ONNX 的模型）

**UI 仍为 Web（Vue）**：这是 A 口径的既定边界；「UI 也原生」是 B 口径，另加 600–900 人日，不在本方案。

### 2.1 关键接口（AI 执行必须遵守）

- 前端只认 window.fuBridge；两种桥由启动探测选择，API 形状完全一致。
- 引擎协议：stdin JSON 行（{"id","cmd","argv"}）→ stdout ###PROG/###RESULT/###LOG；新增 ###READY（ready 后主进程才发任务）。
- 契约来源：engine/params.schema.json（参数）+ ipc.schema.json（通道/事件）→ 生成 Rust command 注册、Python 转发、TS 类型、桥适配；CI 校验 0 漂移。
- 数据格式：.fufumidi 工程只增不删；SQLite 迁移前备份；旧版本可读新工程（向前兼容一个版本）。
- 特性开关：engineBackend=python|rust|auto；dsp=js|rust；ml=python|rust；viz=js|wasm；更新器 legacy|native。

---

## 3. 产品专业化目标（合并后只保留四条主干）

| 主干 | 内容（合并 6.6/6.7/6.8） | 验收 |
|---|---|---|
| **A 工程骨架** | 轨道 CRUD/拍号速度图/marker-region/命令式撤销（应用级单栈）/每轨混音（gain/pan/M/S）/工程模板与崩溃恢复 | 20 轨工程可建、可编排、可保存重开；撤销跨页一致 |
| **B 编辑手感** | 音符试听/多选拖动+Ctrl 复制/拖动吸附+Alt/走带与循环保持/标尺与点击定位/快捷键可配/量化体系/Groove+人性化/CC 4 泳道+踏板区间+弯音范围/命中索引/MPE（延后） | 「从零写 8 小节 ≤10 分钟」成立；帧 p95 <16.7 ms |
| **C 编排与混音** | clip→事件流成为播放真源/框选复制/24 轨上限解除/rAF 播放头/clip 淡化循环 gain/自动化/每轨混音/音频轨录音（延后决策） | 编排操作直接影响声音与导出；分轨导出电平正确 |
| **D 校对闭环** | 公共节拍层（beat_this 全模型）/转录质量面板/音频-MIDI 双视图/refine 进编辑页/OMR 双栏对照/谱面校对/MusicXML 单解析器/调教曲线归属与 A/B 局部重渲 | 3 分钟音频 ≤30 分钟校对完；识谱可逐音核对；调教单次迭代 <10 s |

**明确不做**：完整排版引擎（Dorico 级）、实时 VST 宿主、音频时间伸缩、MIDI 2.0/UMP、云协作（本阶段）。理由见 midi-workflow.md §7 与本方案 §8。

---

## 4. 合并路线图（M0–M5）

> 每个里程碑同时给出「产品能力」与「运行时能力」；先决条件写死在 Gate 里。人日为「熟悉本仓库的工程师」，AI 执行时按 ai-spec 的 T-xxx 粒度分配。

### M0 · 冻结与止血（第 0–2 个月）

| 交付面 | 内容 | 验收 |
|---|---|---|
| 数据模型冻结 | 工程模型 v2 规范（轨道/片段/clip/拍号速度图/自动化/曲线归属/撤销命令）+ 迁移脚本设计 | 文档评审通过；6.6/6.7 与 Rust core 都按它实现 |
| 契约冻结 | params.schema.json + ipc.schema.json；代码生成器骨架；双跑对拍器 | 生成物与现有 250 通道差集 0；对拍脚本可跑 |
| 产品止血（6.6） | F-01 试听、F-02 多选拖动、F-03 走带/循环、F-08 全局键让位、F-04 撤销时机/标签、A2 标尺、A1 吸附、F-06 内置 CC 最小集、M3 重复音合并开关、H1–H3/H6 性能与门禁 | 0.2 节 G1 第一条成立；perf gate 进 CI |
| 运行时 POC（Gate G-A） | P1 更新链+签名+迁移桥；P2 插件 rquickjs；P3 printToPDF（WebView2 ICoreWebView2_16）；P4 视频/壁纸 WebCodecs | 四个 POC 通过或有可接受替代；否则回退 v2 |
| 准备 | 代码签名证书采购；安装器身份；Tauri 骨架仓库 | 证书有排期；骨架能启动 |

**Gate G-M0**：数据模型 v2 通过 + 契约生成 0 漂移 + 6.6 验收 + 四 POC 通过 → 进入 M1。

### M1 · 骨架与双轨 Alpha（第 2–4 个月）

| 交付面 | 内容 | 验收 |
|---|---|---|
| 产品（6.7 第一批） | 轨道 CRUD、拍号编辑、命令式撤销、快捷键可配、量化体系、编排进入播放（C1） | 20 轨工程可建可编排；撤销内存达标 |
| 运行时 | Tauri 宿主骨架（窗口/托盘/单实例/热键/自启/文件关联/数据根/日志）；IPC 60%（文件/工程/设置/资源/播放）；Rust core A 类（SMF/SF2/MusicXML/ustx） | Alpha 冒烟 12 条全绿；对拍 100% |
| 共享 | 双构建流水线（Electron + Tauri 内部包）；崩溃看门狗与日志 | 两个壳都能启动并打开同一工程 |

### M2 · 专业化 Beta（第 4–7 个月）

| 交付面 | 内容 | 验收 |
|---|---|---|
| 产品（6.8 第一批） | 每轨混音、编排交互/clip 编辑、转录质量面板+公共节拍层、MusicXML 单解析器、调教曲线归属 | G2/G3 验收成立；3 分钟音频 30 分钟校对 |
| 运行时 | IPC 100%、更新链生产化、rusqlite 迁移、音频链（解码/重采样/DSP/编码）、ONNX（Basic/audio-tagger/DiffSinger/hnsep/rmvpe） | Beta 功能对齐 100%；Tauri 版灰度可用 |
| 迁移 | 老用户迁移桥（最后一个 Electron 版内置下载 Tauri 安装器） | 迁移演练成功；数据不丢 |

### M3 · RC 与去 Python（第 7–11 个月）

| 交付面 | 内容 | 验收 |
|---|---|---|
| 产品（6.8 收尾） | 谱面校对/OMR 双栏、调教音素时长/A-B 局部重渲、导出格式与选区、每轨 FX/自动化（按裁决） | G2/G4 全链路验收 |
| 运行时 | 插件宿主生产化、PDF/视频/壁纸落地、ML 裁决执行（ONNX/tch/砍功能）、移除 Python、包体达标 | 安装包 ≤250 MiB、安装后 ≤500 MiB；首任务 ≤1.5 s |

### M4 · GA 与清理（第 11–14 个月，4–5 人配置）

| 交付面 | 内容 | 验收 |
|---|---|---|
| 发布 | Tauri 版默认下载；Electron 停止维护；7.0 发布 | 老用户升级 ≥99%；可回退 |
| 清理 | 删除 main/*.js、preload.js、engine/*.py、Electron 依赖；更新 FOUNDATION/AGENTS/licenses/VENDOR | 仓库无 Electron/Python 运行时引用 |

> 3 人配置把 M4 延到第 18–24 个月；2 人配置建议只做 M0–M1 + Rust 内核，6.8 延后。

---

## 5. 工作包目录（AI 执行粒度）

> 详细任务（ID/依赖/文件范围/验收命令/回滚）见 [AI 实现规格](./2026-11-03-master-ai-spec.md)。本表只列「块」，人日为估。

| 块 | 内容 | 人日 | 里程碑 |
|---|---|---:|---|
| W-P0 | 6.6 止血 10 项（试听/多选/走带/键位/撤销/标尺/吸附/CC/合并开关/性能门禁） | 40–60 | M0 |
| W-P1 | 工程骨架：轨道 CRUD/拍号/命令式撤销/快捷键/量化/Groove/编排入播放 | 100–150 | M1–M2 |
| W-P2 | 专业化：每轨混音/编排交互/clip/转录质量/谱面校对/调教深度/导出格式 | 200–300 | M2–M3 |
| W-D0 | 数据模型 v2 + 契约 schema + 代码生成 + 双跑对拍器 | 25–40 | M0 |
| W-T0 | Tauri 宿主（窗口/系统集成/日志/数据根/单实例/热键/自启/文件关联） | 30–45 | M0–M1 |
| W-T1 | IPC 适配层（252 通道 + 28 事件 + 生成 + 错误语义） | 45–65 | M1–M2 |
| W-T2 | 主进程模块移植（模型/下载/GPU/DS/UTAU/RVC/OMR/score/壁纸/视频/任务/反馈） | 70–100 | M2 |
| W-T3 | 更新链+签名+迁移桥 | 35–55 | M1–M2 |
| W-T4 | 插件宿主（rquickjs） | 25–40 | M2–M3 |
| W-T5 | PDF/打印 | 10–20（COM）/40–60（替代） | M3 |
| W-T6 | 打包/CI/安装器/签名/灰度 | 20–30 | M2–M4 |
| W-E0 | Rust core A 类 + 原生探测 | 40–60 | M0–M2 |
| W-E1 | 音频链 + ONNX 推理 | 60–90 | M2–M3 |
| W-E2 | UTAU/OpenUTAU 渲染 | 40–70 | M2–M3 |
| W-E3 | ML 去 Python 裁决与实施 | 30–60 | M3 |
| W-E4 | Python 运行时移除 + AI Pack 重组 | 10–20 | M3 |
| W-QA | 金标语料/双跑/回归/性能门禁/迁移演练 | 40–60 | 全程 |

---

## 6. 统一门禁（每个里程碑必须全绿）

    # 前端
    npm --prefix frontend run build
    npm run typecheck
    npm run test:ui
    # 引擎（venv 路径以 docs/FOUNDATION.md §5 为准）
    python -m pytest tests -q -p no:cacheprovider
    # 应用级
    node scripts/e2e/run.mjs              # CDP 冒烟，0 console 错误
    node scripts/perf-baseline.mjs        # perf gate
    node scripts/dualrun/compare.mjs      # 双跑对拍（MIDI/音频/JSON）
    node scripts/check-contracts.mjs      # IPC/引擎参数 schema 漂移
    # Rust
    cargo fmt --check && cargo clippy -- -D warnings && cargo test
    cargo bench -- --baseline=ci

**AI 执行规则（详见 ai-spec）**：每个任务先读指定文件、只改范围内文件、跑验收命令、失败即回滚；共享文件（schema、桥、FOUNDATION）由 Lead 独占；同一文件只有一个写入者；提交信息引用任务 ID。

---

## 7. 人力与排期（三套方案）

| 配置 | 排法 | 关键路径 | 总工期 | 建议 |
|---|---|---|---|---|
| **2 人** | M0（6.6+冻结+POC）→ Rust 内核 M1+M2 → 6.7/6.8 → Tauri Beta | 运行时 | 24–30 个月 | 只选一条主线；建议先产品止血再内核 |
| **3 人** | 1 人产品、2 人运行时；M0 并行；M2 起产品/运行时按周同步 | IPC + ML 裁决 | 18–24 个月 | **推荐起点** |
| **4–5 人** | 2 人产品、2 人运行时、1 人 QA/工具链 | 更新链 + 插件 + PDF | 12–18 个月 | 若要求 18 个月内 GA |

**不建议**：2 人同时全量做两条线；Rust 期间 UI 数据模型仍在变，返工会吃掉收益。

---

## 8. 风险与止损（合并版，Top 10）

| # | 风险 | 概率/影响 | 对策 | 止损 |
|---:|---|---|---|---|
| 1 | 数据模型反复（功能与重写各改一版） | 高/高 | M0 冻结 v2；只增不删；迁移脚本 | 出现第二次破坏性变更 → 停功能线 |
| 2 | 更新链断代（老用户升不上来） | 中/高 | 迁移桥 + 灰度 + 保留旧安装包 | 成功率 <95% → 延长双轨 |
| 3 | torch 模型无法去 Python | 高/高 | 逐模型裁决（ONNX/tch/砍） | 功能缩水不可接受 → 回 v2 |
| 4 | printToPDF 无等价 | 中/高 | POC；COM/最小 Chromium/打印对话框 | 不接受替代 → 回 v2 |
| 5 | 插件生态断裂 | 中/中 | rquickjs 保 CommonJS | 真实插件集跑不通 → WASM 长期路线 |
| 6 | 双轨维护吞掉人力 | 高/中 | Electron 只修安全/数据 bug；功能只进 Tauri | 双轨超 18 个月 → 冻结新功能 |
| 7 | 工期低估（AI 估时偏乐观） | 高/中 | 每任务 0.5–3 人日；缓冲 25%；每周偏差复盘 | 连续 2 周偏差 >30% → 缩范围 |
| 8 | 签名/杀软信誉 | 中/高 | 尽早买证书；灰度；提交误报 | 误报率高 → 延长 Electron |
| 9 | 许可证（verovio LGPL、GPL 音色库、AAC、kachina 无源码） | 中/中 | 逐项合规清单；AAC 不内置；kachina 登记风险 | 法务不通过 → 换实现/降级 |
| 10 | 范围蔓延 | 高/中 | 版本内只做表内条目；未列入不接 | 需求膨胀 → 砍到四条主干 |

---

## 9. 需要拍板的决策（合并）

| # | 决策 | 选项 | 建议 |
|---:|---|---|---|
| D1 | 人力配置 | 2 / 3 / 4–5 人 | **3 人起步，M2 后按进度加到 4** |
| D2 | 功能优先级 | 先 6.6 止血 / 先 Rust 内核 / 并行 | **先 6.6（M0），再双线** |
| D3 | ML 取舍 | ONNX+可选 tch / 全 tch / 回 v2 留 Python | **ONNX 为主，tch 仅 RVC/piano** |
| D4 | 音频轨/录音 | 做 / 延后 / 不做 | **延后到 M3 决策** |
| D5 | 每轨混音/FX | 基础（gain/pan/M/S）/ 完整（发送+FV）/ 不做 | **基础进 M2；完整不做** |
| D6 | 谱面校对深度 | 校对级 / 制谱级 / 只读 | **校对级** |
| D7 | 插件兼容 | rquickjs / WASM | **rquickjs**（POC 验证） |
| D8 | 更新链 | 自研 / 继续 Kachina | **自研**（POC 验证） |
| D9 | 体积目标 | ≤250 / ≤350 / 不设 | **先按 ≤250 设计，达标不了改 350** |

---

## 10. 立即可做（30 天）

1. 冻结工程模型 v2 + 写 params.schema.json / ipc.schema.json（W-D0）。
2. 6.6 前十项逐项开工（W-P0）：试听/多选拖动/走带循环/键位让位/撤销时机/标尺/吸附/CC 最小集/重复音合并/性能门禁。
3. 四 POC（W-T3/T4/T5 + 视频）：更新链、rquickjs 插件、printToPDF、WebCodecs。
4. 买签名证书、定安装器身份（外部前置）。
5. 建 Rust workspace + Tauri 骨架 + 双构建流水线（W-E0/W-T0）。
6. 金标语料首批（100 个 MIDI + 10 段音频 + 5 个工程）+ 双跑对拍器骨架。
7. 当前 HEAD 重测 perf-baseline（6.4.2 口径）并让 perf gate 进 CI。

**30 天验收**：6.6 前五项可用；四个 POC 有结论；数据模型 v2 评审通过；CI 门禁全绿。

---

## 11. 附录

### 11.1 网络参考（2026-11 检索；外部资料只作参考，不替代实测）

| 主题 | 来源 | 用途 |
|---|---|---|
| Tauri 2 发布与插件生态 | https://v2.tauri.app/ （Tauri 2 文档，2026 检索） | 外壳/更新器/插件选型 |
| Tauri updater（签名/动态端点） | https://v2.tauri.app/plugin/updater/ | 更新链 POC 基线；无多源/无增量，需自研补齐 |
| WebView2 打印接口 ICoreWebView2_16 | https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_16 | PrintToPDF 可行性 POC 依据（接口存在，但 Tauri 需自行取 WebView2 对象） |
| rquickjs（QuickJS Rust 绑定） | https://crates.io/crates/rquickjs | 插件宿主 POC 候选（0.8.x） |
| ort（ONNX Runtime Rust） | https://github.com/pykeio/ort | ML 推理；2.x 仍 RC，需钉版本 |
| wmidi / midly | https://github.com/RustAudio/wmidi | MIDI 消息/文件 crate 备选（自研 SMF 优先） |
| Zrythm undo/redo 架构 | https://docs.zrythm.org/md_doc_2dev_2undo__system.html | DAW 撤销/命令系统参考 |
| Tauri vs Electron 决策矩阵（社区） | https://github.com/jwynia/agent-skills（tauri-comparison.md） | 换壳权衡的第三方视角 |

### 11.2 仓库证据索引

- 性能/体积/启动：[01](./rust-rewrite/01-perf-evidence.md)；前端热路径：[02](./rust-rewrite/02-frontend-hotpaths.md)；引擎与 ML 边界：[03](./rust-rewrite/03-engine-ml-boundary.md)；外壳决策：[04](./rust-rewrite/04-shell-decision.md)；生态与许可：[05](./rust-rewrite/05-ecosystem.md)。
- 审计：docs/audit/2026-10-29/backend-perf.md、frontend-ux.md、midi-workflow.md、external-research.md。
- 架构宪法：docs/FOUNDATION.md（注意：157 应为 250）；测试：docs/TESTING.md；许可：docs/licenses.md；vendor：docs/VENDOR.md；下载契约：docs/DOWNLOADS.md。
- 既有产品计划：docs/plans/2026-11-01-6.5.0-update-plan.md、stem-aware-transcription.md、3d-piano-rhythm-game.md、2026-10-29-full-audit-upgrade.md、docs/editor-upgrade-plan.md、docs/track-clip-editor-plan.md。

### 11.3 与三份原方案的关系

| 原方案 | 在本整合方案中的角色 |
|---|---|
| v2（内核方案） | 性能证据与「为什么不换壳」的决策依据；Rust 内核阶段仍在用 |
| v3（A 口径全 Rust） | 运行时路线的主体（Tauri/引擎/ML 裁决/POC） |
| 专业化升级 | 产品路线的主体（四条主干/版本 6.6–6.8/验收场景） |
| 本文件 | 把两者合并为一张路线图（M0–M5 + 人力 + 门禁 + 风险） |
| AI 实现规格 | 机器优先执行层（任务/依赖/验收/上下文） |

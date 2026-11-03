# FuFumidi Rust 重写方案（2026-11-03）

> 状态：**v2 内核方案（历史稿）**；2026-11-03 用户已选定 **A 口径（全 Rust 技术栈）** →
> 执行方案见 [全 Rust 技术栈方案 v3](./2026-11-03-rust-fullstack-plan.md)；
> 功能升级见 [专业化音乐制作工具升级方案](./2026-11-03-pro-daw-upgrade-plan.md)。
> 本文件保留为「性能证据 + 引擎边界 + 为什么不做全量/换壳」的决策依据。
> 版本基线：**6.5.0-beta.1**（2026-11-04 用户指定；分支 feat/audio-tagger-auto-probe，base commit 47f6062；原 6.4.2/99cbe75 口径的体积与性能实测保留作历史参照）
> 证据附件（分项调研，全部为本日夜完成，可独立阅读）：
> - 01 性能/体积/启动证据与可量化目标 —— ./rust-rewrite/01-perf-evidence.md
> - 02 渲染进程热路径与 WASM/napi 候选 —— ./rust-rewrite/02-frontend-hotpaths.md
> - 03 Python 引擎与 ML 边界 —— ./rust-rewrite/03-engine-ml-boundary.md
> - 04 外壳与打包决策（Electron / Tauri / 全原生）—— ./rust-rewrite/04-shell-decision.md
> - 05 Rust 生态与同类改造案例 —— ./rust-rewrite/05-ecosystem.md
>
> 单位约定：体积一律 MiB（1 MiB = 1,048,576 B），除非明确写「安装包字节数」。
> 证据标注：实测 / 审计实测 / 推断 / 待实测（各附件内有逐条出处）。

---

## 0. 结论先行

### 0.1 三句话

1. **不要「全量重写（连界面一起用 Rust 重做）」，也不要把「换 Tauri 外壳」当成这次重写。** 数据很清楚：换 Tauri 的加权决策得分 51.0%，保留 Electron + Rust 内核 80.4%，全原生 UI 50.6%（04 篇 14 维矩阵）；而前端 78,563 行代码（frontend/src 全部 85,935 行）、250 条 IPC、Node 插件沙箱、10 源自动更新链、printToPDF、壁纸引擎这些资产一旦换壳就清零（04 篇 §2/§6）。
2. **「提高性能」必须先拆成四件事，否则会做错方向。** 实测：启动 820 ms（旧基线）、播放帧间隔 p95 3.4 ms、60k 工程 MIDI 解析 6.2 ms——**界面并不慢**。真正值钱的四件事是：**① Python 运行时带来的固定开销与安装体积（首次任务 import 10.65 s、probe 6.07 s、运行时 1,099 MiB、占安装体积 65%）；② 进资源中心一次点掉 11.6 s CPU；③ 导出后处理 0.7 s / 2 分钟立体声；④ 大工程可视化编译 31 ms/帧、开图 238 ms**。转录本身（GPU 34.2 min / CPU 148 min / 120 分钟素材）是**模型算力**，Rust 只影响其中 0.28%（解码），不要承诺「转录快 N 倍」。
3. **推荐「内核重写」：保留 Electron + Vue 界面，把引擎/格式/音频/文件 IO 里适合 Rust 的部分按「无状态计算 → 状态所有权」的顺序搬过去，外壳归档 Tauri。** 目标是把基础包从 606.3 MiB 压到 **≤450 MiB（Phase 2）/ ≤350 MiB（Phase 3，torch 模型转可选包）**，首次任务固定开销从 10.65 s 压到 **≤2 s**，资源中心从 11.6 s 压到 **<100 ms**，导出后处理 **4–8×**。

### 0.2 推荐路线（R1：内核重写，分四阶段）

| 阶段 | 周期（1.5–2 人 + agent 辅助） | 交付 | 硬指标 |
|---|---|---|---|
| **Phase 0 基线与止血** | 2–4 周 | 基准与门禁、原地修 P0、契约冻结、Tauri 归档、文档纠偏 | 资源中心二次进入 <1 s；存储面板 <200 ms；设置保存 <10 ms；perf:gate 进 CI |
| **Phase 1 Rust 骨架 + A 类批处理 + 原生探测** | 4–6 周 | Cargo workspace、sidecar 协议、SMF/MIDI/SF2/MusicXML/ustx、原生 probe/deps | 探测 <100 ms；A 类事件级对拍 100%；sidecar 冷启动 ≤100 ms |
| **Phase 2 引擎 A 类扩展 + 音频链 + 导出后处理** | 6–8 周 | 解码/重采样/DSP、Basic Pitch + audio-tagger（ONNX）、UTAU 渲染、导出后处理 napi、前端可视化算法修复 | 安装包 ≤500 MiB；导出后处理 ≤0.2 s/2 min；Python 运行时 ≤800 MiB |
| **Phase 3 ML 边界收敛 + Python 可选包** | 8–12 周 | DiffSinger/hnsep/rmvpe ONNX、torch 系转可选 AI 包、基础包与 AI 包拆包、质量对拍 | 基础包 ≤350 MiB；首任务 ≤2 s（warm ≤300 ms）；转录质量平齐 |
| **Phase 4 前端 WASM（可选，按数据）** | 4–8 周 | 可视化编译 WASM、MusicXML/STFT 批处理 | 仅当真机统计证明编译占帧预算 >50% 才做 |

**总投入**：Phase 0–3 约 **180–280 人日**（含测试/双跑/文档），Phase 4 另 **20–35 人日**。
- 2 名工程师（1 Rust + 1 前端/集成）并行：**6–8 个月**。
- 单人：**12–16 个月**，期间不能大改产品功能。
- **若你只想要「界面更快、资源中心不卡、导出快」，不需要重写**：走 R0（见 0.5），约 **30–60 人日**，2–3 个月拿到可测收益，但安装包与 Python 依赖不变。

### 0.3 为什么不做全量重写 / 为什么先不动外壳

| 方案 | 内容 | 加权得分 | 发布可用工程量 | 结论 |
|---|---|---:|---:|---|
| **A** | Electron 保留 + Rust 内核（本文方案） | **80.4%** | 45–70 人日（外壳/基础设施）+ 算法迁移另计 | **推荐** |
| **B** | Tauri 2 外壳 + Rust 内核 + Vue UI 迁移 | 51.0% | 270–380 人日 | 归档（触发条件见 04 §4.4） |
| **C** | 全原生 UI（egui/slint/iced） | 50.6% | 1,000–1,450 人日 | 不做 |

三条硬理由：
1. **换壳省不了体积**：安装后 1,691.5 MiB 中 Electron 本体约 285 MiB（17%），Python 运行时 1,099 MiB（65%）。先换壳=只捡 17%。
2. **换壳要重写 250 条 IPC 与整条更新链**：src-tauri 当年只完成 76 条（30.4%，功能等价约 36%），16 次提交里 14 次只改版本号，2026-10-06 冻结；冻结真因不是版本落后，而是**更新链与插件沙箱在 Tauri 下无等价物**（04 §2/§3）。
3. **这一步会清零最值钱的工程资产**：250 条 preload↔main 零漂移契约、250+ 条 E2E 依赖的桥、Node vm 插件沙箱。换壳后这些全部重做，且用户无感。

### 0.4 Rust 收益边界（提前对齐预期，避免做完失望）

| 问题 | Rust 能解决吗 | 关键数字 |
|---|---|---|
| Python 运行时体积 / 冷启动 / 内存 | **能**（换运行时） | python 1,099 MiB（65%）、import 10.65 s、torch import 后 RSS +186 MB |
| 进资源中心卡 11.6 s | **能**（原生探测 + 缓存） | probe 6.07 s + depCheck 5.50 s，并发 11.6 s CPU |
| 导出后处理慢（0.7 s / 2 min） | **能**（napi/SIMD/多线程） | encodeWav 234.8 + LUFS 144.3 + limiter 116.8 + normalize 201.4 ms |
| 大工程可视化开图/每帧编译 | **部分** | buildVizBlocks 238 ms（先 JS 修算法，0.5 天）；每帧编译 31 ms（WASM 2–3×，需真机确认） |
| 首次/冷启动转录慢 | **部分** | 固定开销 10.65 s 可消除；模型前向不变 |
| 编辑手感（撤销深拷贝/播放重排） | **部分**（Rust 数据模型长期可根治，但前端重构更便宜） | 9 万音符整轨深拷贝 ×80 步，约 3–4 MB/步 |
| 转录更快 | **不能** | 120.5 min 素材：GPU 34.2 min / CPU 148 min；解码仅 5.8 s = 0.28% |
| 界面切换 / 启动速度 | **不能** | 旧基线 820 ms / cold 412 ms / warm 183 ms，Electron 进程启动固定成本 |
| 播放流畅度 | **不能** | 帧间隔 p95 3.4 ms，已远优于 16.7 ms 预算 |
| 安装包体积 | **能，但主要靠删 Python** | 安装包 606.3 MiB；python 压缩后仍是最大单项 |
| 音频延迟 | 能，但受限 | WebAudio RTL 10 ms（interactive）已达标；原生 ASIO 需非开源 SDK，只在「独占 ≤10 ms」目标下才值 |

### 0.5 两个投入档（本次需要拍板的第一件事）

| 档 | 内容 | 人日 | 见效 | 体积收益 | 适合 |
|---|---|---:|---|---|---|
| **R0 最小 Rust 内核** | 原生 probe/deps（替 11.6 s）、存储遍历索引（替 5.78 s）、导出后处理 napi（0.7→0.2 s）、buildVizBlocks 算法修复（238→<10 ms）、db 修 bug + node:sqlite/WAL、perf:gate 进 CI | **30–60** | 2–3 个月 | 几乎为 0（Python 仍在） | 「只想变快、不想动分发」 |
| **R1 内核重写（推荐）** | R0 全部 + A 类批处理、音频链、ONNX 推理、Python 可选包、安装包拆分 | **180–280** | 6–8 个月（2 人） | 606→≤350 MiB | 「要体积、要首启、要长期技术栈」 |

> 建议：**先批 R0（它本身是 R1 的 Phase 0+1 一部分），跑 2–3 个月用数据决定是否升 R1。** 这样最坏情况也能拿到体感收益，不会烂尾。

---

## 1. 现状基线（2026-11-03 实测，全部复核过 6.4.2）

### 1.1 架构分层

| 层 | 位置 | 规模（实测） | 说明 |
|---|---|---|---|
| 渲染进程 | frontend/src/ | 187 文件 / 85,935 行 / 6.24 MiB（代码 181 文件 / 78,563 行）；23 个视图 | Vue 3 + Vite；i18n 13,491 行（1.12 MB）；可视化已重做（viz/ 14 文件 2,653 行） |
| 桥 | preload.js | 467 行，252 通道 + 28 事件 | 与主进程 250 条 ipcMain.handle + 2 条 ipcMain.on **双向差集 0**（04 §1 实测） |
| 主进程 | main.js + main/*.js | 58 文件 / 19,063 行 | 窗口/文件/子进程/数据库/下载/更新/插件 |
| 引擎 | engine/** | 顶层 71 文件 / 25,345 行；含 singing 29,652 / diffsinger 4,191 / rvc 3,950 / tests 28,495（617 用例） | 转录/分离/翻唱/OMR/歌声合成/格式转换 |
| 运行时 | resources/ | python 1,099.0 MiB · models 211.7 MiB · g2p 24.2 MiB | 不入库，构建时准备 |
| 已有 Rust | rust-core/ · src-tauri/ | rust-core 572 行 / 7 命令；src-tauri 3,681 行 / 76 命令 / 已冻结 | 两者都不在主链路；工具链 rustc 1.97.1 已装 |

### 1.2 体积（6.4.2 构建实测）

| 项 | 体积 | 占比 | 备注 |
|---|---:|---:|---|
| 安装包（NSIS 6.4.2） | **606.3 MiB**（635,789,305 B） | — | 6.2.9 是 711.7 MiB，6.3.0 起裁剪进门禁后降 105 MiB |
| 安装目录（fresh build） | **1,691.5 MiB** / 15,362 文件 | 100% | 本地 dir 构建因 app.asar 是目录，逐文件统计会多约 40 MiB（本机实测 1,733.4 MiB，取前者口径） |
| └ resources | 1,406.3 MiB | 83% | — |
| └ resources/python | **1,099.0 MiB / 15,014 文件** | 65% | Lib 1,074 MiB；.pyc 已从 251.9 降到 24.1 MiB，.lib 归零 |
| └ resources/models | 211.7 MiB | 13% | piano_transcription 164 MiB、audio-tagger 25.8 + 21.6 MiB |
| └ app.asar（正式包为单文件） | 28.7 MiB | 2% | renderer/dist 15.9 MiB |
| Electron 运行时（其余） | 约 285 MiB | 17% | FuFumidi.exe 195.2 MiB（Electron 37） |
| 安装后数据根 | **32,738 MiB / 62,453 文件** | — | models 21,121 / gpu 4,737 / soundfonts 2,674 / diffsinger 2,407 / omr 1,369 MiB |

> **重要发现（体积债）**：本机安装版 E:/Midi/FuFumidi 的 resources 实测 2,177 MB，其中 python **1,695.8 MiB / 56,097 文件**（是 fresh build 的 1.5 倍），另有 3 份 app.asar 备份（.bak-642-hybrid/.bak-644/.bak-pre650）。**增量更新不清理旧文件**——这既是分发问题，也是「用户越用越胖」的真实体验问题，应单独立项治理（不依赖 Rust）。

Python site-packages Top（实测）：torch 382.9 · llvmlite 115.1 · imageio_ffmpeg 83.6 · scipy 66.7+19.3 · av.libs 64.1 · transkun 54.0 · transformers 49.7 · onnxruntime 41.7 · numpy 34.3 · PIL/fontTools 25.2 MiB。

### 1.3 性能（复核后的口径）

| 指标 | 数值 | 出处 / 口径 |
|---|---:|---|
| 启动到可交互 | **820 ms** | docs/perf-baseline.json（2026-10-17，app 6.2.0 / Electron 33）；**6.4.2 需重测**（Electron 37 + splash 改变可见时序） |
| 视图切换 cold / warm p95 | 412 / 183 ms | 同上，旧基线 |
| 60k 音符编辑页首次进入 | 529 ms | 同上（量到首个 canvas，不是完整首绘） |
| 播放帧间隔 p50 / p95 | 3.3 / 3.4 ms | 同上；不构成瓶颈 |
| JS 堆（首屏 → 60k） | 10.5 → 44.7 MB | 同上；+34 MB 属正常 |
| Python 全栈 import | **10.65 s**（1,203 模块） | 01 实测（温页缓存）；审计冷口径 13.47 s |
| music2midi probe | **6.07 s** | 01 实测（审计 6.46 s） |
| deps.py check | **5.50 s**（6 组依赖都真 import） | 01 实测（审计 4.70 s） |
| 进资源中心（probe + depCheck 并发） | **11.6 s CPU**，无缓存/无单飞 | 01 实测 + ViewResources.vue:565-570 |
| torch 冷 / 热 import | 9.03 s / 2.87 s（两次实测） | 01/Lead 实测 |
| Python 进程基线 / import torch 后 RSS | 14 MB / 200 MB | Lead 实测 |
| 存储面板遍历 | **5.78 s / 62,453 文件**（已异步，但仍全量） | 01 实测 |
| sql.js 每次持久化 | 60.7 MiB 全库导出 + 写 = **74 ms**（结构未变） | 01 实测 |
| 最贵操作（模型前向） | 120.5 min 素材 GPU 34.2 min / CPU 148.0 min | 审计实测（docs/plans/2026-10-12-...§7.5/7.6） |
| 音频 RTL（WebAudio） | interactive 10 ms / playback 20 ms | docs/audio-rtl-report.md |

**前端热点（02 实测）**：可视化每帧编译 **31.1 ms/帧**（60k 密集工程，11,561 图元）；可视化开图 buildVizBlocks **238 ms**（O(k²) 回扫）；导出后处理 2 min 立体声 **约 0.7 s**（encodeWav 234.8 + LUFS 144.3 + limiter 116.8 + normalize 201.4 ms）；MusicXML 60k 全谱 **66.7 ms**；工程 JSON 序列化 22 ms；频谱 STFT 46.4 ms；MIDI 解析 6.2 ms（**不需要 Rust**）；i18n 首屏同步 import 61.6 ms。

### 1.4 已有 Rust 资产（可复用）

| 资产 | 内容 | 结论 |
|---|---|---|
| rust-core/ | 572 行 CLI：ping/version/midi-stats/batch-stats/hash-batch/quantize-batch/transpose-batch；自研 SMF 解析（支持 running status）、SHA-256；构建/测试脚本齐全，产物已随包 | **Phase 1 种子**；目前前端 0 调用，是「沉睡能力」 |
| src-tauri/ | 3,681 行 / 76 命令 / 16 模块，Tauri 2；冻结于 2026-10-06，版本停在 3.1.8 | **归档**（不是备用外壳）；只保留为历史参考 |
| main/rust.js | sidecar 探测 + JSON 调用桥（88 行），优雅降级 | **未来 Rust 引擎接入范式**（但每次调用 spawn，不能用于热路径） |
| 构建链 | scripts/build-rust.ps1、test-rust.ps1、resources/rust-core 打包位；rustc 1.97.1 | 可直接扩展 |

---

## 2. 性能归因：哪些是 Rust 的活

> 完整证据见 01 §3–§6、02 §2–§3、03 §2–§4。本节给决策结论。

分类：**A** 只能换运行时/语言；**B** 原地可修（异步/缓存/算法/常驻进程）；**C** 受模型算力限制；**D** 受 UI/渲染限制。

| # | 成本中心 | 现状 | 根因 | 归属 | 关键判断 |
|---:|---|---|---|---|---|
| 1 | Python 运行时固定开销 | import 10.65 s、probe 6.07 s、deps 5.50 s；torch RSS +186 MB | 解释器 + 重型包导入；无预热/缓存 | **A（部分 B）** | Rust 原生探测可 <100 ms；常驻/缓存也能先救急 |
| 2 | 运行时体积 1,099 MiB | 占安装 65% | 整包分发 CPython + torch/scipy | **A** | 只有把 A/B 类搬走 + torch 转可选包，才能真降 |
| 3 | 资源中心 11.6 s | probe+depCheck 并发、零缓存 | 两个 Python 各导入一遍 torch | **A（B 也能救）** | R0 就能解决，最值得先做 |
| 4 | 存储面板 5.78 s | 全量 62k stat；cleanup 三遍历 | 算法 + 主线程 IO | **A（B 也能救）** | 缓存 60 s + 索引；Rust 并行可亚秒 |
| 5 | 设置保存 74 ms | 每次全库导出 60.7 MiB | sql.js 结构 | **B** | 换 node:sqlite/WAL 即可，**不需要 Rust**；另修 db.js:201-203 的 ReferenceError（退出冲刷从未执行） |
| 6 | 导出后处理 0.7 s / 2 min | 逐样本 JS：dither/LUFS/limiter/normalize/encode | 单线程 JS + 无 SIMD | **A（napi）** | 4–8×，用户可感知（点击后等待） |
| 7 | 可视化编译 31 ms/帧 + 开图 238 ms | 11.5k 图元/帧；O(k²) 回扫 | JS 分配 + 算法 | **B 先修算法；A 再 WASM** | 先做 0.5 天算法修复（238→<10 ms）；WASM 需真机确认是否值得 |
| 8 | 大工程编辑（撤销/播放重排） | 深拷贝 3–4 MB/步 ×80；prepare 4.2 ms | JS 对象模型 | **B（前端重构）** 或 A（长期） | 先做命令式撤销，不换语言 |
| 9 | 转录速度 | GPU 34.2 min / CPU 148 min | 模型算力 | **C** | **Rust 收益 ≈0.28%**，不要承诺提速 |
| 10 | 视图切换/启动 | cold 412 ms / warm 183 ms / 启动 820 ms | Vue 挂载 + Chromium 启动 | **D** | 前端/Electron 问题，与 Rust 无关 |

**结论**：真正非 Rust 不可的是 #1、#2、#6（以及 #4 的并行遍历）；#3、#5、#7 先做 B；#9、#10 明确不指望 Rust。

---

## 3. 方案选择

### 3.1 四方案对比（04 §4.2 的 14 维加权矩阵，权重合计 100）

| 方案 | 加权得分 | 到发布可用 | 主要收益 | 主要代价 |
|---|---:|---:|---|---|
| **A Electron + Rust 内核（推荐）** | **402/500 = 80.4%** | 45–70 人日（基础设施）+ 算法迁移 135–210 人日 | 体积/首启/IO/导出/平台能力 | Rust 学习与双栈维护；算法迁移期长 |
| B Tauri 2 外壳 | 255/500 = 51.0% | 270–380 人日 | 再省约 250 MiB 与部分内存 | 250 条 IPC + 更新链 + 插件沙箱 + printToPDF + 壁纸引擎全部重做 |
| C 全原生 UI | 253/500 = 50.6% | 1,000–1,450 人日 | 理论最优启动/内存 | 78,563 行前端代码、23 视图、i18n、无障碍、3D/乐谱排版全部重做 |
| D 只止血（不写 Rust） | — | 3–5 人日 P0 + 前端 1–2 个月 | 体感收益 60–80% | 体积/首启/Python 依赖不变 |

### 3.2 为什么 A 赢，以及 Tauri 的归档条件

- A 赢在**契约**：权重最高的「250 IPC 对齐成本」A 拿满分，B 丢 63 分，是总差距 147 分的主因（04 §4.3）。
- 换壳收益（体积/内存/UI 上限）权重合计 23；代价（IPC/更新/插件/迭代速度）权重 45 —— **收益成本比结构性小于 1**。
- 不写「永远不迁」；满足以下任意两条再重开（04 §4.4）：
  1) 全量包 >600 MiB 且 python 已瘦身到 <400 MiB；
  2) 现场 RSS >1.5 GB 且 Rust 内核已承担主进程 90% CPU；
  3) Electron 官方停止 ABI 支持、37/45 线无法再升。
- **Tauri 相关决策**：src-tauri 归档；frontend/src/bridge/tauri.js 标 FROZEN 或删除；官网「Rust · Tauri 桌面核心」表述修正（04 §8.1 三条止血）。

### 3.3 为什么 ML 边界是「Rust 跑 ONNX + Python 只做可选 torch 包」

- 已有 ONNX：Basic Pitch（nmp.onnx 230 KB）、audio-tagger（27 MB int8）、hnsep、RVC rmvpe、DiffSinger 四模型（03 §0/§3.1）。
- 必须留 Python 的 torch 系：piano_pt / aria / transkun / hft / muscriptor / yourmt3 / miros / MSST（29 架构）/ RVC 主体（03 §3.1 的 C 类）。
- Rust ort 不改变推理数值（同一 ONNX Runtime），只省进程与启动；torch 动态图不能靠「翻译」解决。
- **禁止 tch 嵌入 libtorch**：等于把省下的 1–2 GB 再花回去；只在某模型无法 ONNX 且用户接受可选包时评估。

---

## 4. 目标架构

### 4.1 分层

    渲染进程（Vue 3，保留）
      视图/交互/i18n/无障碍：不动
      Phase 4 可选：wasm（可视化编译、MusicXML、STFT），不碰数据模型
            │ window.fuBridge（252 通道，契约不变）
    Electron 主进程（保留）
      窗口/托盘/更新/插件/下载/壁纸：不动
      engine 客户端抽象：python | rust | auto（双跑开关）
      Phase 0 起：node:sqlite/WAL 替代 sql.js（B，不需要 Rust）
      Phase 2 起：导出后处理 napi 模块 / utility process
            │ ###PROG / ###RESULT / ###LOG（现有 JSON 行协议，兼容）
    fufumidi-engine.exe（Rust sidecar，长驻 + 按需 spawn）
      core：SMF/MIDI、时间图、量化/移调/人性化、MusicXML→MIDI、
            SF2/SF3 合并、ustx 互转、哈希/清单
      audio：解码(symphonia)/重采样(rubato)/DSP/LUFS/编码；
             UTAU 渲染（numpy DSP 重写）
      ml：ort 会话（CPU/CUDA/DirectML/TensorRT）：
          basic-pitch、audio-tagger、DiffSinger、hnsep、rmvpe
      jobs：任务注册表、取消/暂停/进度节流、健康探测（probe/deps）
      cli：probe/deps/bench/转换（运维与开发）
            │ Python 可选包（AI Pack，按需下载）
    torch 系：piano(transkun)/aria/hft/muscriptor/yourmt3/miros/
              MSST 分离/RVC 主体、Audiveris(Java)/ffmpeg

**明确保留、不重写**：libfluidsynth 2.4.6 WASM（SF2 合成，跑在 AudioWorklet）、Verovio 6.3.0 WASM（乐谱排版）、sql.js→node:sqlite（Phase 0 B 方案）、Verovio/ffmpeg sidecar、Node 插件沙箱、250 条 IPC。

### 4.2 crate 划分

| crate | 职责 | 关键依赖 | 阶段 |
|---|---|---|---|
| fufumidi-core | 领域模型、SMF 读写（running status/SMPTE/多轨/tempo map）、量化/移调/人性化、MusicXML→MIDI、SF2/SF3 合并、ustx | 自研 SMF（复用 rust-core）、serde、thiserror | P1 |
| fufumidi-engine | sidecar 二进制：JSON 行协议、job 注册表、取消/暂停/进度、probe/deps、双跑路由 | tokio、serde_json、tracing | P1 |
| fufumidi-audio | 解码（symphonia + ffmpeg 兜底）、重采样（rubato）、DSP（EQ/压缩/限幅/LUFS/dither）、编码（WAV/FLAC，MP3 走 ffmpeg 或许可评估）、UTAU 渲染 | symphonia、rubato、hound、clap | P2 |
| fufumidi-ml | ort 会话池、模型注册/校验、EP 选择、warm session、内存守卫 | ort（2.x 仍 RC，钉版本）、ndarray | P2–P3 |
| fufumidi-node | napi：导出后处理、目录遍历/索引、哈希、zip（仅在实测需要时） | napi-rs、rayon、sha2 | P2 |
| fufumidi-wasm | 前端可视化编译、MusicXML、STFT（Phase 4，按数据） | wasm-bindgen、rustfft | P4 |

### 4.3 进程与协议

- **sidecar 优先**（03 §6.1 结论）：与现有 spawnEngine/worker/会话模型同构；沿用 ###PROG/###RESULT/###LOG；新增 ###READY（version/capabilities）；kill=取消、pause flag 文件不变。
- 兼容现有 worker 池（1–4 槽、GPU −1、120 s 回收）、超时/暂停预算、进度节流、日志落盘；切换只改 main/engine.js 的引擎选择层。
- napi 仅用于**毫秒级热路径**（导出后处理、索引）；Rust panic 会带崩主进程，因此只在明确收益 >5× 时使用。
- 双跑：engine.rust.enabled 与 engineBackend=python|rust|auto；失败自动回退并上报；契约用同一份 params.schema.json 生成三方（Rust/Python/前端类型）。

### 4.4 数据所有权（决定风险的关键顺序）

| 数据 | 短期（P1–P2） | 长期（P3+，可选） |
|---|---|---|
| 工程模型 | 仍由前端 JS 持有；Rust 只做无状态函数 + 文件 | 若做，先搬编辑命令与撤销日志，不搬 reactive 状态 |
| 播放调度 | 不变（Web Audio） | 不变 |
| 撤销 | 前端命令式重构（Phase 0/1） | Rust 命令日志（只存 diff） |
| DB/设置 | Phase 0 换 node:sqlite/WAL | 主进程只做壳 |
| 模型/缓存 | Rust 管理目录与校验（Phase 2 起） | 同一事实源 |

**原则：先搬「无状态、可对拍」的计算，最后才搬状态所有权。** 这一条直接决定每阶段能否独立回滚。

---

## 5. 分阶段路线图（含验收与回滚）

### Phase 0 · 基线与止血（2–4 周，不改架构）

| # | 事项 | 验收 | 归属 |
|---:|---|---|---|
| 0.1 | 基准固化：perf-baseline（含 6.4.2 splash 新口径）+ 引擎首任务/probe/deps + 导出耗时 + 存储面板，统一 npm run bench，输出 JSON + 阈值 | 可复现；**perf:gate 进 CI**（现在只是 package.json 里的孤儿脚本） | B |
| 0.2 | 修 HEAD 真 bug：main/db.js:201-203 引用未声明的 persistTimer/persistPromise/persistNow，close() 抛 ReferenceError，退出冲刷从未执行 | 退出后 DB 落盘；单测覆盖 | B |
| 0.3 | sql.js → node:sqlite/WAL（或 better-sqlite3），清 songs 死表 + VACUUM | 库 60.7 MiB → <5 MiB；写入 O(1)；设置保存 <10 ms | B |
| 0.4 | 资源中心：probe/depCheck 加 TTL + single-flight；同时减少 onMounted 并发 load* | 二次进入 0 新 Python；首次 <1 s | B |
| 0.5 | 存储面板：60 s 缓存 + 异步遍历（已有）+ cleanup 去掉重复遍历 | 首次 <1 s，之后 <200 ms；无 >50 ms 长任务 | B |
| 0.6 | 前端零风险修复：buildVizBlocks O(k²)→O(k log k)（0.5 天，238→<10 ms）；i18n ja 懒加载（首屏 61.6 ms 的一部分） | 60k 开图 <10 ms；首屏 import 降低 | B |
| 0.7 | 文档/事实纠偏：FOUNDATION 157→250、官网「Rust · Tauri 桌面核心」、tauri.js FROZEN、electron-builder base/ci/local-dir 的 33.4.11 漂移 | 4 项修正入库 | B |
| 0.8 | 契约冻结：engine params.schema.json（唯一来源）、桥/持久化/.fufumidi 版本号；双跑对拍器骨架 | 契约文档 + 对拍脚本可跑 | B |
| 0.9 | Rust 原生 probe POC（第一个 Rust 切片）：读 CPU/内存/GPU/依赖目录，输出 probe JSON；替换两次 Python 探测 | probe <100 ms；失败回退 Python | A |

**决策门 G0**：基准齐、0.1–0.8 达标、POC 通过 → 进入 Phase 1；否则只保留 R0 继续优化，不启动重写。

### Phase 1 · Rust 骨架 + A 类批处理（4–6 周）

范围（03 §3.2 的 R1）：
- workspace + CI（fmt/clippy/test/bench）、Windows x64 静态 CRT/LTO、签名、版本注入。
- core：SMF 全特性、量化/移调/人性化、MIDI 编辑/后处理/合并、MusicXML/MXL→MIDI、SF2 合并、SF3→SF2、.ustx 互转（合计约 1,900 行 A 类）。
- engine：协议 + job 注册表 + 暂停/取消 + probe/deps + bench。
- 主进程 engine 客户端抽象 + 灰度开关 + 自动回退。
- 对拍：随机 1,000+ MIDI + 现有 617 个 pytest fixture；事件级一致率 100%。

验收：探测 <100 ms；A 类对拍 100%；sidecar 冷启动 ≤100 ms；10 万音符 MIDI 解析 <100 ms；安装包不增加（二进制 ≤15 MiB）。
回滚：默认 Python；Rust 二进制可缺失。

### Phase 2 · 引擎 A 类扩展 + 音频链 + 导出后处理（6–8 周）

- 音频链：解码/重采样/DSP 迁 Rust（symphonia + rubato + ffmpeg 兜底）；替换 librosa/numba/llvmlite 路径；float32 化修内存。
- Basic Pitch + audio-tagger 改 Rust ort（B 类），质量对拍。
- UTAU 渲染（engine_utau.py 1,586 行）迁 Rust，听感 A/B（人工）。
- 前端导出后处理（C3）→ napi/utility process（SIMD/多线程），逐样本对拍 null test。
- 视情况：napi 目录索引（替 storage 5.78 s 的剩余部分）、哈希/zip（已有 Rust 但接热路径）。
- Python 运行时瘦身第一/第二批（按 03 §4.2 的 P1，约 −325 MiB）：llvmlite/numba/scipy/av/PIL 等（前置条件：对应 Rust 实现 + 7 条端到端冒烟）。

验收：安装包 ≤500 MiB；python ≤800 MiB；导出后处理 ≤0.2 s/2 min（null test ≤-60 dBFS）；首任务固定开销下降 30%+；7 条冒烟全绿。
回滚：dsp/导出双实现；dsp 开关；Python 目录快照备份。

### Phase 3 · ML 边界收敛 + Python 可选包（8–12 周）

- DiffSinger/hnsep/rmvpe 改 Rust ort；RVC HuBERT→ONNX（解锁 transformers 链 68.3 MiB）。
- torch 系保持 Python，但打包拆分：**base（Rust 引擎 + ONNX + 小模型）** 与 **AI Pack（torch 模型 + Python 运行时，按需下载）**。
- 模型仓库、EP 选择（CPU/CUDA/DirectML/TensorRT）、warm session、内存守卫、失败降级。
- 质量对拍：≥200 条音频，F1/音高/时值/置信度阈值；不达标不删 Python 路径。

验收：基础包 ≤350 MiB（torch 模型不内置）；首任务 ≤2 s（warm ≤300 ms）；转录质量平齐（F1 不低于基线 0.5%）；无 Python 时基础功能 100% 可用。
回滚：ml 开关；AI Pack 可回退下载；旧安装包通道保留。

### Phase 4 · 前端 WASM（可选，4–8 周，按数据）

- 只做被真机统计证明值得的：可视化图元编译（31 ms/帧 → 10–12 ms）、MusicXML（67→25–35 ms）、STFT（46→10–15 ms）。
- 明确不做：数据模型进 Rust（02 §4.3 判定投入产出最差）、卷帘绘制、SF2/Verovio、播放调度。
- 触发条件：真机 viz 统计显示编译占帧预算 >50%，且 60k 工程掉帧可复现。

---

## 6. 目标数字（承诺 / 不承诺）

| 指标 | 现状（实测） | Phase 2 后 | Phase 3 后 | 置信度 |
|---|---:|---:|---:|---|
| 安装包 | 606.3 MiB | ≤500 MiB | **≤350 MiB**（base，torch 模型不内置） | 中高 |
| 安装后 | 1,691.5 MiB | ≤1,350 MiB | ≤900 MiB（base） | 中 |
| 资源中心（probe+depCheck） | 11.6 s CPU | <100 ms（Rust 探测） | <50 ms | 高 |
| 首任务固定开销 | 10.65 s | 7–8 s（部分 Rust 化 + 预热） | **≤2 s**（Rust 引擎 + ort） | 中 |
| 存储面板 | 5.78 s | <200 ms | <100 ms | 高 |
| 设置保存 | 74 ms | <10 ms | <10 ms | 高 |
| 导出后处理（2 min 立体声） | 0.7 s | **≤0.2 s** | ≤0.15 s | 中高 |
| 可视化开图（60k） | 238 ms | <10 ms（JS 算法修复，Phase 0） | — | 高 |
| 可视化每帧编译 | 31 ms | 31 ms（不改；先观察） | 10–12 ms（若做 WASM） | 低（需真机） |
| MIDI 解析 100k 音符 | 待测（60k≈6.2 ms） | ≥5×（引擎侧，不承诺用户可感） | 同 | 中 |
| 音频 RTL | 10 ms（interactive） | 不变 | 不变（原生 ASIO 另行评估） | 高 |
| 启动到可交互 | 820 ms（旧基线） | 重记基线，不大幅承诺 | 同 | 高 |
| 转录速度 | GPU 34.2 min / CPU 148 min | **不变**（模型算力） | 同 | 高 |

**不承诺**：
- 「转录快 N 倍」——120 分钟素材里 Rust 能碰的解码只占 0.28%；
- 「启动 <300 ms」——Electron/Chromium 固定成本，splash 只改感知；
- 「安装包 <300 MiB」——除非把 piano 164 MiB 等大模型全部改为按需下载（需产品决策），否则 base 目标 ≤350 MiB；
- 「内存减半」——60k 的 +34 MB 是数据本身；除非搬数据模型（已判定不划算）；
- 「界面完全不卡」——前端工程问题，不是 Rust 的功劳。

---

## 7. 工程与质量

### 7.1 构建与仓库
- 新目录 crates/（workspace）；npm run build:rust-core 产物进 resources/rust-core/；electron-builder extraResources。
- 构建：x86_64-pc-windows-msvc、静态 CRT、LTO、strip、版本注入（git describe + FUFUMIDI_RUST_VERSION）；ARM64 后评估。
- 签名：Rust exe 纳入 Authenticode 流程（未签名 sidecar 会被 SmartScreen/杀软拦）。
- 打包事实源：6 份 builder 配置收敛为 1 份 + 环境变量；修 base/ci/local-dir 的 Electron 33.4.11 漂移。

### 7.2 测试与对拍
- cargo test + clippy + fmt；criterion 基准。
- 金标语料：1,000+ 随机 MIDI、600+ 真实工程片段、200+ 音频、OMR/DiffSinger/翻唱 fixture。
- 对拍：MIDI 事件级 diff；音频 null test（≤-60 dBFS）；模型 F1/音高/时值阈值；JSON 结构 diff。
- 性能门禁：perf:gate 进 CI；Rust criterion 阈值 = 基线 +25%；每次发版前跑真实 GUI 基准（需可见会话，headless 会失真）。

### 7.3 可观测性（先做）
- Rust tracing → JSON 日志到 <dataRoot>/logs/engine-*.log，与主进程同轮转；每次 job 记录引擎类型、启动/首事件耗时、峰值 RSS、回退原因。
- 诊断包含 Rust 版本、crate 列表、模型哈希、EP 信息、Python 回退次数。
- 崩溃：主进程看门狗重启 sidecar；记录重启次数；可选 minidump。

### 7.4 灰度与回滚
- 灰度：Beta 通道 10%→50%；auto 模式下新版本默认 Rust，失败自动回退并上报。
- 双跑一个月后再切默认；每次只切一个能力域。
- 数据迁移只增不删：node:sqlite 迁移前备份；.fufumidi 格式向前兼容一个版本。
- 回滚开关：engineBackend、dsp、ml、viz 四个维度独立。

### 7.5 许可证（本次调研新发现的雷区）
- verovio 上游是 **LGPL-3.0**，仓库 docs/licenses.md:42 标 MIT → 必须纠正并补许可证文本/源码获取途径（05 §4）。
- MuPDF/mupdf-rs 是 **AGPL-3.0** → 禁止引入；PDF 继续 pdfjs-dist + Electron printToPDF。
- 内置 4 个 GPL-3.0 音色库（FM/GM、雅马哈 C5、Galaxy 电钢琴、Supersaw）→ 逐个确认「音色库例外」，不能确认的改按需下载（05 §4.2）。
- 编解码：MP3 专利 2017-04-23 已全部到期可安全；**AAC 仍在 Via LA 专利池**，不要内置 AAC 解码（走 ffmpeg/系统）。
- 新 crate 准入：cargo deny / cargo license 人工核对，AGPL/GPL 禁入；bincode 已归档（换 rmp-serde/postcard）；midly 停更（复用自研 SMF）。

---

## 8. 风险与止损

| # | 风险 | 概率/影响 | 对策 | 止损/触发 |
|---:|---|---|---|---|
| R1 | torch 系无法迁移，Python 删不掉 | 高/中 | 一开始就按「双轨 + 可选 AI 包」设计；A+B 类先做 | 若 Phase 3 结束 python 仍 >650 MiB：接受双轨，base 目标改 ≤450 MiB，不追加投入 |
| R2 | ONNX 精度/数值偏差 | 中/高 | 逐模型对拍 + 保留 Python 通道 | 某模型 F1 掉 >2% 且两周调不回 → 留 Python |
| R3 | ort 2.x 仍 RC、EP 矩阵复杂（CUDA/TensorRT/DirectML） | 中/高 | 钉版本 + CPU 默认 + GPU 可选包；沿用现有增强包策略 | GPU 包失败率 >10% → 回退 CPU |
| R4 | 双跑期契约漂移 | 高/中 | params.schema.json 单一来源 + 对拍 + CI；每次只切一个域 | 连续两次回归 → 暂停迁移 |
| R5 | Rust 人力/学习曲线/工期 | 中/高 | R0 先行、每阶段可发布、范围可缩 | Phase 1 超期 >50% → 缩为「只做 MIDI/音频/探测」 |
| R6 | 更新链/签名/杀软信誉 | 中/高 | Phase 1 起签名；更新器校验 Rust 产物；保留旧通道；kachina 登记为 P0 外部依赖风险（无源码，只能换版本） | 灰度更新失败率 >1% → 回滚版本 |
| R7 | 数据迁移（sqlite/工程）事故 | 低/极高 | 迁移前备份、只增不删、双读验证、回滚脚本 | 出现一次数据丢失 → 停迁移 |
| R8 | 音频许可/专利（AAC/ASIO） | 中/中 | AAC 不内置；ASIO 需非开源 SDK → 原生音频后端延后，先做 WASAPI/共享模式评估 | 法务不通过 → 不做原生音频 |
| R9 | 用户安装体积因增量更新继续膨胀 | 高/中 | 独立治理：更新后清理旧 python/asar 备份；安装器支持「清理式更新」 | 实测安装目录已 2,177 MB resources（python 1,695.8）→ 立项治理 |
| R10 | 文档/契约/门禁成本被低估 | 高/中 | 把文档与门禁当交付物；每阶段验收含文档 | 文档欠账 → 不进入下一阶段 |

**三个止损门**：
- **G0（Phase 0 末）**：基准 + 0.1–0.8 达标 + 原生探测 POC 通过。
- **G1（Phase 1 末）**：A 类对拍 100%、sidecar 稳定、包体不增。
- **G2（Phase 3 中段）**：Basic Pitch + audio-tagger 迁移后质量平齐、安装包 ≤450 MiB → 才继续 torch 边界与拆包。

**总止损线**：Phase 3 结束时安装包 >450 MiB 或首任务 >5 s → 停止追加，保留「Rust 内核 + Python 可选包」中间态（本身可交付）。

---

## 9. 需要拍板的决策

| # | 决策 | 选项 | 建议 | 不拍板的代价 |
|---:|---|---|---|---|
| **D1** | **投入档位** | R0（30–60 人日）先做 / R1（180–280 人日）/ 只做 Phase 0 止血 | **先 R0，3 个月后用数据决定 R1** | 直接全量 = 烂尾风险；只止血 = 体积问题永存 |
| **D2** | 重写范围 | A 内核 / B 换 Tauri / C 全原生 | **A** | 选 B/C 会把 250 IPC 与更新链清零 |
| **D3** | ML 边界 | Rust 跑 ONNX + Python 可选 AI 包 / 全部 Rust / 全部留 Python | **前者** | 全部 Rust 不现实；全留 Python 体积不降 |
| **D4** | 包体目标 | base ≤350 MiB + AI Pack 按需 / 全部内置 / 不设目标 | **前者**（需产品确认首次体验与下载引导） | 不设目标 = 体积继续涨（安装版已 1,695.8 MiB python） |
| **D5** | 外壳 | Electron 保留 / 立即 Tauri | **保留 + 归档 Tauri** | 保留 src-tauri 会继续双维护与误导 |
| **D6** | 迁移期功能节奏 | 主干冻结 / 双线并行 | **Phase 1–2 主干冻结，Phase 3 恢复** | 双线 = 两边都慢 |

---

## 10. 立即可做（不需要等拍板，全部是 R0 内容）

1. 修 main/db.js:201-203 的 ReferenceError（退出冲刷）；sql.js→node:sqlite/WAL + 清 songs + VACUUM。
2. 资源中心 probe/depCheck 加 TTL + 单飞（11.6 s → 亚秒）。
3. storage 面板 60 s 缓存；cleanup 去掉重复遍历。
4. buildVizBlocks O(k²)→O(k log k)（0.5 天，238 ms → <10 ms）。
5. i18n ja 表懒加载（首屏 import 61.6 ms 的一部分）。
6. 当前 HEAD 重测 perf-baseline（6.4.2 口径）并把 perf:gate 接进 CI。
7. 文档/事实纠偏四项（FOUNDATION 250、官网 Tauri 表述、tauri.js FROZEN、builder Electron 33.4.11）。
8. 写 engine/params.schema.json 单一来源（消除三份手工参数表——审计认定的最高频缺陷源）。
9. 原生 probe POC：50 行 Rust 读 CPU/内存/GPU/依赖目录，替换两次 Python 探测（这是第一个 Rust 切片）。
10. 建 crates/ workspace + CI（只含 SMF 解析 + 对拍），把 rust-core 的 572 行迁进去。

---

## 11. 附录：证据索引

| 主题 | 文件 |
|---|---|
| 性能/体积/启动证据与目标 | ./rust-rewrite/01-perf-evidence.md |
| 前端热路径与 WASM/napi 候选 | ./rust-rewrite/02-frontend-hotpaths.md |
| Python 引擎与 ML 边界 | ./rust-rewrite/03-engine-ml-boundary.md |
| 外壳与打包决策（Electron / Tauri / 全原生） | ./rust-rewrite/04-shell-decision.md |
| Rust 生态、案例、许可证 | ./rust-rewrite/05-ecosystem.md |
| 既有审计（性能/UX/工作流/外部研究） | docs/audit/2026-10-29/backend-perf.md、frontend-ux.md、midi-workflow.md、external-research.md |
| 架构与契约宪法 | docs/FOUNDATION.md（注意：157 应为 250，见 04 §1） |
| 音频延迟实测 | docs/audio-rtl-report.md |
| 跨平台 | docs/CROSS-PLATFORM.md |
| 冻结的 Tauri 移植 | src-tauri/、docs/FOUNDATION.md §6.2 |
| 开源许可与 vendor | docs/licenses.md、docs/VENDOR.md |
| 下载器契约 | docs/DOWNLOADS.md |

---

## 12. 附：关于「完全用 Rust 全量重写」的三档口径（2026-11-03 补充）

> 用户追问「能不能完全用 Rust 全量重写」。能写，但「完全」有三种定义，成本差 3–10 倍，必须先对齐。

### 12.1 三种「完全」

| 口径 | 含义 | 仍存在的非 Rust 依赖 | 交付估计 | 时间（2–3 人） | 评价 |
|---|---|---|---:|---|---|
| **A. 自有代码 100% Rust（推荐目标）** | Tauri 2 外壳 + Rust 引擎 + ONNX/FFI；自有业务代码一行 JS/Python 不剩 | WebView2（系统 Chromium）、ONNX Runtime、verovio/ffmpeg/fluidsynth 等 C/C++ 库通过绑定 | **450–700 人日** | 12–18 个月 | **现实可交付**；与现计划相比多约 270–380 人日换壳 + 更新链/插件重写 |
| **B. 连 UI 也用 Rust 原生** | egui / Slint / iced 重画 23 个视图 | 图形后端（wgpu/Skia）、系统 IME | A + 600–900 人日 | 3–5 年 | 高风险：i18n/无障碍/输入法/乐谱交互全部重做；无成熟乐谱排版生态 |
| **C. 零非 Rust 依赖（纯血 Rust）** | 连 OMR、乐谱排版、SF2 合成、视频编码都自研或换纯 Rust 实现 | 无（理想态） | A + 1,000–2,000 人日，且部分能力无等价物 | 5 年以上 | **不建议**；Audiveris（Java OMR）/Verovio（C++ 排版）没有 Rust 等价替代，自研等于重做两个专业引擎 |

> 行业中说的「Rust 重写」通常指 A：**重写自己的代码，依赖继续用成熟库（通过绑定）**；不是把 glibc/Chromium/ONNX 也重写一遍。

### 12.2 逐层可行性（对 A 口径）

| 层 | 能否用 Rust 重写 | 关键障碍与代价 |
|---|---|---|
| 外壳/窗口/托盘/单实例 | 能（Tauri 2） | 250 条 IPC 重映射（45–65 人日）；更新链（25–35）、插件沙箱（25–35）、壁纸引擎（10–15）、下载器（12–18） |
| 自动更新/签名/多源 | 能（自研 Rust updater） | 25–35 人日 + 长期维护；kachina 第三方无源码，换掉需重建发布链 |
| 插件沙箱 | 不能等价 | 现插件是 Node CommonJS + vm 沙箱；纯 Rust 只能改 WASM/Extism，**现有第三方插件全部失效** |
| printToPDF | 不能等价 | WebView2 COM（非 Rust）或自研 PDF 排版；乐谱 PDF 导出是产品线，风险高 |
| UI（Vue → 原生） | 能但不划算（B 口径） | 78,563 行代码 / 23 视图 / 13,491 行 i18n / 无障碍 / 3D 可视化 / 乐谱交互 |
| 引擎 A 类（MIDI/SF2/MusicXML/ustx/UTAU） | 能 | 约 1,900 行；已有计划 Phase 1–2 |
| 引擎 B 类（ONNX 推理） | 能（ort） | basic-pitch/audio-tagger/DiffSinger/hnsep/rmvpe；数值对拍 |
| 引擎 C 类（torch 系） | 难 | 8 个模型 + MSST 29 架构 + RVC 主体；只能逐模型 ONNX 导出（部分不可行）或 candle 重实现（极高成本），否则留 Python 就不是「完全」 |
| OMR | 不能（无等价） | Audiveris 是 Java + 成熟算法；纯 Rust 需自研 OMR（研究项目） |
| 乐谱排版 | 不能（无等价） | Verovio 是 C++/WASM；纯 Rust 无同等引擎 |
| SF2 合成 | 部分 | 播放已是 FluidSynth WASM；纯 Rust 可用 rustysynth/oxisynth，但听感/兼容性需 A/B，不等于现有 |
| 音频解码/编码 | 部分 | 解码 symphonia 可；AAC 专利；MP3/FLAC/OGG 可；视频编码仍要 ffmpeg 或 WebCodecs |
| 数据库/下载/文件 IO | 能 | rusqlite/reqwest/tokio；需重写下载器并对拍 |

### 12.3 结论与建议

1. **A 口径可行**：Tauri 2 + Rust 引擎 + ONNX，预算 450–700 人日、2–3 人 12–18 个月；最大风险不在 Rust，而在**更新链/插件沙箱/printToPDF 三件套**与 **torch 模型精度**。
2. **B 口径不建议**：多花 600–900 人日，换来的是 UI 生态全面降级（IME/无障碍/乐谱）。
3. **C 口径不接受**：现有 OMR 与乐谱排版没有 Rust 等价物，重写等于同时做两个专业引擎。
4. **最优顺序不变**：先做 Rust 内核（本方案 Phase 1–3，6–8 个月），再决定是否上 Tauri——原因是从数据看，内核做完后换壳成本从 270–380 人日降到约 120–160 人日（04 §8.1），而且体积/首启/导出的收益已经在手。
5. **如果坚持一步到位 A 口径**：可把本方案改为「Phase 1 Rust 内核 + Tauri 外壳并行」，但工期按 12–18 个月、风险按 04 §6 的最贵 5 模块写进计划；并先做三个 1–2 周 POC：① Tauri 下更新链+签名；② 插件 WASM 化；③ WebView2 printToPDF 分页等价性。
6. **一句话**：能全量用 Rust，但只能到「自有代码全 Rust + 依赖绑定」；「UI 也 Rust + 零 C 依赖」是 3–5 年研究项目，不建议拿产品去赌。

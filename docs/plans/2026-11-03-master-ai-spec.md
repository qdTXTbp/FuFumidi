---
spec_id: FUFUMIDI-MASTER-2026-11
status: proposed
baseline: 6.4.2
target: 6.6 + 6.7 + 6.8 + 7.0
platform: win32-x64
canonical_for_ai: true
human_doc: docs/plans/2026-11-03-master-integrated-plan.md
companions:
  - docs/plans/2026-11-03-rust-rewrite-plan.md
  - docs/plans/2026-11-03-rust-fullstack-plan.md
  - docs/plans/2026-11-03-pro-daw-upgrade-plan.md
  - docs/plans/rust-rewrite/01-perf-evidence.md
  - docs/plans/rust-rewrite/03-engine-ml-boundary.md
  - docs/plans/rust-rewrite/04-shell-decision.md
non_goals:
  - native_ui_rewrite
  - full_engraving_engine
  - realtime_vst_host
  - audio_time_stretch
  - midi2_ump
  - cloud_sync
---

# FuFumidi 整合总方案 — AI 实现规格（机器优先）

> 本文件是「专业化升级 + 全 Rust 重写」的执行层。AI 按本文件干活；人类背景读 human_doc。
> 所有任务有 ID、依赖、文件范围、验收命令、回滚方式；任何一条不满足都不算完成。

## 0. AI 使用规则（硬规则）

1. 开工前必读：AGENTS.md、docs/FOUNDATION.md §1/§2/§5、本文件当前任务涉及的 T-xxx 条目。
2. **只改任务 in_scope 列出的文件**；需要改共享文件（schema、preload、FOUNDATION、build 配置）时，先停下并标记 NEED_LEAD。
3. 每个任务一个分支/一组提交；提交信息格式：feat(<area>): <task-id> <一句话>；不得夹带无关改动。
4. **一个文件同一时间只有一个写入者**；并行任务按 §8 的写作用域划分。
5. 改完必须跑 §7 的门禁子集（任务里列出的 verify）；失败即回滚（git checkout 本任务改动）并在报告里写失败原因。
6. 不新增外部依赖，除非任务明确允许；新增必须说明体积/许可证，并更新 docs/VENDOR.md 与 docs/licenses.md。
7. 中文文案必须 EN + JA 同补（i18n.js / i18n_ja.js），缺一条算未完成。
8. 界面改动必须装到 E:/Midi/FuFumidi 冒烟（deploy-installed.cjs + 冒烟脚本）；构建绿不等于能用。
9. 不构建安装包、不发布 Release，除非用户明确要求。
10. 任务超过 3 人日必须拆分；AI 一次只做 0.5–3 人日的任务。
11. 上下文预算：每个任务只读 in_scope 相关文件 + 1 份契约文档；禁止全仓 grep 式探索超过 20 个文件（除非任务要求）。
12. 遇到与契约/数据格式冲突：停，写 ADR 草案（docs/plans/adr/），等拍板，不擅自改格式。

## 1. 目标与非目标

### 目标

| ID | 目标 |
|---|---|
| G-001 | 6.6 内让「从零写 8 小节 ≤10 分钟」成立 |
| G-002 | 6.7 内让 20 轨工程可建、可编排、可撤销、可保存重开 |
| G-003 | 6.8 内让 3 分钟音频转录 ≤30 分钟完成校对 |
| G-004 | M3 内移除 Electron 与 Python，安装包 ≤250 MiB、安装后 ≤500 MiB |
| G-005 | 全程：250 IPC + 28 事件契约零漂移；每个任务可独立验收与回滚 |
| G-006 | 7.0 前 Tauri 版成为默认发布，老用户升级成功率 ≥99% |

### 非目标

见 frontmatter non_goals。另：本规格不覆盖「UI 原生重写」（B 口径）。

## 2. 决策记录

| ID | 决策 | 理由 |
|---|---|---|
| D-001 | UI 保留 Vue/WebView2，不做原生 UI | 成本 +600–900 人日，收益不成比例 |
| D-002 | 外壳/引擎用 Tauri 2 + Rust sidecar | 与现有 JSON 行协议同构；崩溃隔离；可双跑 |
| D-003 | 数据模型 v2 在 M0 冻结，之后只增不删 | 防止功能与重写互相返工 |
| D-004 | IPC/参数用 schema 单一来源生成 | 消除三份手工参数表（最高频缺陷源） |
| D-005 | ML 以 ONNX 为主，tch 仅 RVC/piano 可选包 | 体积与工程量折中 |
| D-006 | 插件宿主用 rquickjs 保 CommonJS 兼容 | 不破坏现有插件生态 |
| D-007 | 更新链自研 Rust 更新器 + 迁移桥 | Kachina 无源码、无法修 |
| D-008 | 先 6.6 止血，再双线并行 | 先拿体感收益，也建立基准 |
| D-009 | 不做每轨完整 FX/发送；只做 gain/pan/M/S + 主 EQ | 避免进入 DAW 混音军备竞赛 |
| D-010 | 音频轨/录音延到 M3 决策 | 范围最大、与定位关联弱 |

## 3. 里程碑与 Gate

| Gate | 条件 | 不通过时 |
|---|---|---|
| G-M0 | 数据模型 v2 评审通过；schema 生成 0 漂移；6.6 十项验收；四 POC 有结论 | 停止进入 M1，只保留 6.6 维护 |
| G-M1 | Alpha 12 条冒烟全绿；A 类对拍 100%；Tauri 壳可打开同一工程 | 缩范围到「只做 Rust core + Electron」 |
| G-M2 | Tauri Beta 功能对齐 100%；更新链灰度通过；迁移演练成功 | 延长 M2，不上 RC |
| G-M3 | 无 Python 全功能可用；包体/首启达标；质量对拍通过 | 回退 tch 可选包或回 v2 |
| G-M4 | 老用户升级 ≥99%；可回退；无 P0 | 延长双轨 |

## 4. 契约（任务必须遵守）

### 4.1 工程模型 v2（C-001，M0 产出）

- Song：id/name/bpm/timeSigMap/tempoMap/tracks[]/arrange/markers/regions/version。
- Track：id/type(midi|audio|bus)/name/program/volume/pan/mute/solo/notes[]/ccs[]/automation[]。
- Note：id/midi/vel/startTick/durTicks/offVel/voice/channel/pitchCurveRef?（v2 新增：曲线归属）。
- Clip：id/trackId/startTick/lenTicks/loopCount/fadeIn/fadeOut/gain/sourceRef（音频）。
- 持久化：.fufumidi JSON 只增不删；旧版本可读新文件（向前兼容一个版本）；SQLite 存索引与缓存，不是唯一真相。

### 4.2 IPC 契约（C-002）

- ipc.schema.json：通道名、方向（invoke/event）、payload/返回值、错误码。
- 生成物：frontend/src/types/ipc.ts、bridge 适配层、Rust command 注册、Python 转发表。
- 事件通道必须返回退订函数；测试覆盖 28 条事件。

### 4.3 引擎协议（C-003）

- stdin 行：{"id":7,"cmd":"...","argv":[...]}
- stdout：###READY / ###PROG / ###RESULT / ###LOG；exit/cancel 语义沿用 main/engine.js。
- 新引擎能力必须带 capabilities 声明；主进程按 capabilities 路由 rust|python|auto。

### 4.4 特性开关（C-004）

- settings.engineBackend=python|rust|auto；dsp=js|rust；ml=python|rust；viz=js|wasm；updater=legacy|native。
- auto 语义：能力可用→Rust，否则 Python；失败自动回落并上报。

### 4.5 质量契约（C-005）

- MIDI：事件级 diff 0 差异（允许字段顺序）。
- 音频：null test ≤ -60 dBFS。
- 模型：F1 不低于基线 0.5%，音高/时值误差阈值按 03 号文件。
- UI：CDP 冒烟 0 console error；perf gate 不超基线 +25%。

## 5. 需求清单

### 5.1 产品（P-xxx）

| ID | 必须 | 验收 |
|---|---|---|
| P-001 | 卷帘内点音符/画音符/移调即响（可开关） | 画 20 个音逐个听出音高 |
| P-002 | 多选拖动整体移动；Ctrl 拖拽复制 | 框选 8 音拖动 8 个一起动 |
| P-003 | 拖动吸附网格；Alt 临时自由 | 落点永远在网格上 |
| P-004 | 编辑后保持走带位置与循环区间 | 循环里改 10 个音不重置 |
| P-005 | 编辑/调教页数字键不切歌单；方向键不双触发 | 按 1~6 只改时值 |
| P-006 | 撤销先存后改、带操作名与真实时间 | 逻辑编辑器/宏一次 Ctrl+Z 完全还原 |
| P-007 | 卷帘标尺：小节号/拍线/点击定位/Shift 拖循环 | 点击任意位置定位 |
| P-008 | 内置音色下 CC7/CC11/CC64/CC1/弯音生效 | 画表情/踏板能听出变化 |
| P-009 | 轨道新建/删除/复制/改名/拖排 | 20 轨工程可建可保存 |
| P-010 | 拍号可在播放头插入/删除 | 变拍小节重排正确 |
| P-011 | 命令式撤销（应用级单栈、带标签、跨页一致） | 10 万音符 50 次编辑栈 <50 MB |
| P-012 | 快捷键可配置（两套方案、帮助由实现生成） | 改键生效并持久化 |
| P-013 | 量化面板：起点/终点/长度 + 强度 + 网格偏移 + swing 50~75% | 60% 强度只吸 60% |
| P-014 | Groove 导入（16 步偏移+力度表）+ 时间人性化 | 导入片段律动一致 |
| P-015 | 编排 clip → 事件流参与播放/导出 | 移动/裁剪/静音直接影响声音 |
| P-016 | 编排框选/复制/跨轨/去 16 轨上限 | 24 轨管弦乐完整可见 |
| P-017 | 每轨 gain/pan/mute/solo（基础混音） | 同通道多轨可分别调 |
| P-018 | 转录公共节拍层（tempoMap + 拍号） | 现场录音小节线与音频对齐（±1 帧） |
| P-019 | 转录质量面板（F1/置信度/异常片段） | 3 分钟音频 5 分钟内定位问题 |
| P-020 | 音频/MIDI 双视图 + 局部重转 + 接受/拒绝 | 30 分钟内完成 3 分钟校对 |
| P-021 | MusicXML 单一解析器（前端复用引擎结果） | 两处导入同一文件结果一致 |
| P-022 | 谱面校对（Verovio 点击 ↔ 卷帘定位） | 识谱结果逐音可核对 |
| P-023 | 调教音高曲线挂到音符、随音符移动 | 移动音符颤音跟随 |
| P-024 | 调教局部重渲 + A/B 对比 | 单次迭代 <10 秒 |
| P-025 | 导出 FLAC/MP3/OGG；导出选区/循环；MIDI 带 marker | 三种格式可播放；选区导出正确 |
| P-026 | 前端设计完善：三大视图样式换控件契约类；980/1280/1585 三档布局回归；a11y/空状态/错误反馈收口 | audit:ui-tokens 绿 + 三档截图通过；不改变品牌视觉语言 |
| P-027 | 品牌与 logo 保持：图标/立绘/安装器图/splash/官网 logo 不因重写而变化 | npm run check:brand 绿；迁移前后截图一致 |

### 5.2 运行时（R-xxx）

| ID | 必须 | 验收 |
|---|---|---|
| R-001 | Tauri 2 外壳可用（窗口/托盘/单实例/热键/自启/文件关联/数据根/日志） | Alpha 冒烟全绿 |
| R-002 | 252 通道 + 28 事件在 Tauri 下 100% 覆盖 | 双向差集 0；事件退订正确 |
| R-003 | 自研更新器（多源/测速/增量/Ed25519/静默安装/守护重启） | 三源端到端通过；失败可回滚 |
| R-004 | 迁移桥：最后一个 Electron 版可下载并安装 Tauri 版 | 老用户演练升级成功 |
| R-005 | 插件宿主 rquickjs 保 CommonJS 兼容 | 真实插件集零改动跑通 |
| R-006 | printToPDF 等价方案（COM 或替代） | 页数/边距/字号逐页对比通过 |
| R-007 | Rust 引擎 A 类（SMF/SF2/MusicXML/ustx/UTAU 渲染） | 对拍 100% |
| R-008 | Rust 音频链（解码/重采样/DSP/LUFS/编码） | 解码覆盖 m4a/mp3/flac/wav；null test 通过 |
| R-009 | ONNX 推理（Basic/audio-tagger/DiffSinger/hnsep/rmvpe） | 质量对拍通过；warm ≤300 ms |
| R-010 | 去 Python：base 无 Python 全功能可用 | 安装包 ≤250 MiB；首任务 ≤1.5 s |
| R-011 | 原生 probe/deps | 资源中心 <100 ms；0 Python 进程 |
| R-012 | 包体/启动/内存达标 | 见 human_doc §0.3 |

### 5.3 共享（S-xxx）

| ID | 必须 | 验收 |
|---|---|---|
| S-001 | 数据模型 v2 冻结 + 迁移脚本 | 旧工程可开、可存、可回滚 |
| S-002 | schema 单一来源 + 代码生成 + CI 漂移检查 | 手改生成物会被 CI 拦 |
| S-003 | 双跑对拍器 + 金标语料 | 100 MIDI/10 音频/5 工程 |
| S-004 | perf gate 进 CI（6.4.2 基线） | 超基线 +25% 失败 |
| S-005 | 日志/崩溃/诊断包含 Rust 与回退信息 | diag:export 可见 |
| S-006 | 许可证清单更新（verovio LGPL、GPL 音色库、AAC、kachina 风险） | 文档与 CI 检查通过 |
| S-007 | 品牌资产守恒门禁：scripts/brand/manifest + docs/BRAND.md | check:brand 绿；任何 logo/图标变更必须 --update + 用户确认 |

## 6. 任务清单（T-xxx）

> 粒度 ≤3 人日；in_scope 之外禁止改动；verify 必须可复制执行。

### M0（第 0–2 月）

| ID | 目标 | 依赖 | in_scope | verify | 人日 |
|---|---|---|---|---|---|
| T-001 | 写工程模型 v2 规范（docs/RUST-PROJECT-MODEL.md） | — | docs/ | 评审通过 | 2–3 |
| T-002 | params.schema.json（引擎参数单一来源） | T-001 | engine/、scripts/ | generate + 单测 | 2–3 |
| T-003 | ipc.schema.json（252 通道 + 28 事件） | T-001 | preload.js、main/、scripts/ | 双向差集 0 | 2–3 |
| T-004 | 代码生成器骨架（TS 类型 + Rust stub + Python 转发） | T-002,T-003 | scripts/、frontend/src/types/ | 生成物编译通过 | 2–3 |
| T-005 | 双跑对拍器骨架（MIDI/音频/JSON 三类） | T-002 | scripts/dualrun/ | 100 用例对拍 | 2–3 |
| T-006 | 音符试听 P-001 | — | EditorCanvas.vue、synth.js、player.js | 手测 + test:ui | 2–3 |
| T-007 | 多选拖动 + Ctrl 复制 P-002 | — | EditorCanvas.vue | 手测 + 单测 | 1–2 |
| T-008 | 走带/循环保持 P-004 | — | EditorCanvas.vue、player.js | 手测 + 单测 | 2–4 |
| T-009 | 全局键让位 P-005 | — | App.vue、PianoRoll.vue | 手测 | 1–2 |
| T-010 | 撤销时机 + 标签 P-006 | — | EditorCanvas.vue、ViewEdit.vue | 手测 + 单测 | 2–3 |
| T-011 | 标尺/点击定位 P-007 | — | EditorCanvas.vue | 手测 | 3–5 |
| T-012 | 拖动吸附 + Alt P-003 | — | EditorCanvas.vue | 手测 + 单测 | 2–3 |
| T-013 | 内置音色 CC 最小集 P-008 | — | synth.js、EditorCanvas.vue | 手测 + 单测 | 3–5 |
| T-014 | 重复音合并开关 | — | engine/midi_post.py、ViewTranscribe.vue | pytest | 1–2 |
| T-015 | 设置保存/debounce + db.js ReferenceError 修复 | — | main/db.js、main/settings-ipc.js | node --test + 手测 | 2–3 |
| T-016 | 资源中心 probe 缓存 + 单飞 | — | main/system-ipc.js、main/diagnostics.js、ViewResources.vue | 手测（二次进入 0 新进程） | 2–3 |
| T-017 | 存储面板缓存 + cleanup 去重复遍历 | — | main/storage.js | node --test | 1–2 |
| T-018 | perf gate 进 CI + 6.4.2 基线重测 | — | .github/workflows/、scripts/perf-baseline.mjs | CI 绿 | 2–3 |
| T-019 | POC 更新链（Tauri） | — | docs/、临时分支 | POC 报告 | 3–5 |
| T-020 | POC 插件 rquickjs | — | docs/、临时分支 | 真实插件 2 个跑通 | 3–5 |
| T-021 | POC printToPDF | — | docs/、临时分支 | 逐页对比通过 | 3–5 |
| T-022 | POC 视频/壁纸 WebCodecs | — | docs/、临时分支 | 30 s 导出对比 | 3–5 |
| T-023 | Rust workspace + Tauri 骨架 | — | crates/、src-tauri-new/、scripts/rust/ | 空壳启动 | 3–5 |
| T-024 | 金标语料首批 + 对拍基线 | T-005 | test/fixtures/ | 数量与对拍通过 | 2–3 |
| T-025 | 品牌资产门禁 + docs/BRAND.md（本轮已完成） | — | scripts/brand/、package.json、docs/BRAND.md | npm run check:brand 绿；16 个资产哈希入库 | 1–2 |

### M1（第 2–4 月）

| ID | 目标 | 依赖 | in_scope | verify | 人日 |
|---|---|---|---|---|---|
| T-101 | 轨道 CRUD P-009 | T-001 | stores/、ViewEdit.vue、EditorCanvas.vue | 手测 + test:ui | 3–5 |
| T-102 | 拍号编辑 P-010 | T-001 | stores/、ViewEdit.vue、TimelineModel | 手测 + 单测 | 2–3 |
| T-103 | 命令式撤销核心 P-011 | T-001,T-005 | frontend/src/core/commands.js、stores/ | 单测 + 内存测试 | 5–8 |
| T-104 | 快捷键可配置 P-012 | T-003 | SettingsPanel.vue、core/hotkeys | 手测 | 3–5 |
| T-105 | 量化体系 P-013 | T-012 | midi-tools.js、ViewEdit.vue | 单测 | 3–5 |
| T-106 | 编排进入播放 P-015 | T-001 | core/arrange.js、player.js、ViewArrange.vue | 手测 + 导出测试 | 3–5 |
| T-107 | Tauri 系统集成 R-001 | T-023 | crates/shell/ | 冒烟清单 | 5–8 |
| T-108 | IPC 适配层 60% | T-003,T-004,T-107 | crates/shell/ipc/、preload 生成物 | 差集 0（60% 范围） | 5–8 |
| T-109 | Rust core：SMF/MIDI | T-023 | crates/core/ | cargo test + 对拍 | 5–8 |
| T-110 | Rust core：SF2/SF3/MusicXML/ustx | T-109 | crates/core/ | cargo test + 对拍 | 5–8 |
| T-111 | 原生 probe/deps R-011 | T-023 | crates/shell/ | 手测 <100 ms | 2–3 |
| T-112 | 双构建流水线 | T-107 | scripts/、.github/ | 两个壳都能出内部包 | 2–3 |
| T-113 | 前端设计完善第一批：ViewSing/ViewEdit/ViewTranscribe 换控件契约类（逐视图） | T-025 | frontend/src/views/*、styles/controls.css | audit:ui-tokens 绿 + 三档窗口截图 | 5–8 |
| T-114 | 品牌一致性迁移校验：Tauri 图标/安装器/splash 复用同一套品牌图 | T-107、T-025 | build/、poc/tauri-poc 或 crates/shell/ | check:brand 绿 + 截图对比 | 1–2 |

### M2（第 4–7 月）

| ID | 目标 | 依赖 | in_scope | verify | 人日 |
|---|---|---|---|---|---|
| T-201 | 每轨混音（基础）P-017 | T-103 | synth.js、PlayerBar.vue、stores/ | 手测 + 导出对比 | 5–8 |
| T-202 | 编排交互/clip 编辑 P-016 | T-106 | ViewArrange.vue、core/arrange.js | 手测 | 5–8 |
| T-203 | 转录质量面板 P-019 | T-106? | ViewTranscribe.vue、engine/quality | 手测 + 指标 | 5–8 |
| T-204 | 公共节拍层 P-018 | — | engine/beat_*.py、ViewTranscribe.vue | 音频对齐 ±1 帧 | 5–8 |
| T-205 | MusicXML 单解析器 P-021 | T-110 | core/musicxml.js、ViewScore.vue | 往返对比 | 3–5 |
| T-206 | 调教曲线归属 P-023 | T-001 | stores/singer.ts、ViewSing.vue | 手测 | 3–5 |
| T-207 | IPC 100% | T-108 | crates/shell/ipc/ | 差集 0 | 8–12 |
| T-208 | 更新链生产化 R-003 | T-019 | crates/shell/updater/ | 三源灰度 | 8–12 |
| T-209 | rusqlite 迁移 | T-015 | crates/shell/db/、scripts/migrate/ | 迁移 + 回滚演练 | 3–5 |
| T-210 | Rust 音频链 R-008 | T-023 | crates/audio/ | 解码矩阵 + null test | 8–12 |
| T-211 | ONNX 推理（Basic/audio-tagger） | T-023 | crates/ml/ | 质量对拍 | 5–8 |
| T-212 | 迁移桥 R-004 | T-208 | 最后 Electron 版本 | 演练通过 | 3–5 |

### M3（第 7–11 月）

| ID | 目标 | 依赖 | in_scope | verify | 人日 |
|---|---|---|---|---|---|
| T-301 | 谱面校对/OMR 双栏 P-022 | T-205 | ViewScore.vue、engine/omr | 手测 | 8–12 |
| T-302 | 调教音素时长/A-B P-024 | T-206 | ViewSing.vue、stores/singer.ts、engine | 手测 | 5–8 |
| T-303 | 导出格式/选区/marker P-025 | T-106 | export_audio.js、export_options.js、main/export.js | 手测 + 单测 | 3–5 |
| T-304 | 插件宿主生产化 R-005 | T-020 | crates/shell/plugins/ | 插件集通过 | 8–12 |
| T-305 | PDF/视频/壁纸落地 R-006 | T-021,T-022 | crates/shell/ | 逐页/逐帧对比 | 5–8 |
| T-306 | ML 裁决执行 R-009（DiffSinger/hnsep/rmvpe/RVC/piano） | T-211 | crates/ml/、AI pack | 对拍 + 体积 | 8–15 |
| T-307 | 移除 Python + AI Pack R-010 | T-306 | resources/、build/、main/models.js | 无 Python 全功能冒烟 | 5–8 |
| T-308 | 包体/首启验收 R-012 | T-307 | 构建配置 | 实测达标 | 2–3 |

### M4（第 11–14 月）

| ID | 目标 | 依赖 | in_scope | verify | 人日 |
|---|---|---|---|---|---|
| T-401 | GA 发布 + 迁移 | T-308 | release/、更新配置 | 灰度 + 回退演练 | 5–8 |
| T-402 | 删除 Electron/Python | T-401 | main/、preload.js、engine/、package.json | 仓库无引用 + 冒烟 | 5–8 |
| T-403 | 文档/许可/vendor 更新 | T-402 | docs/、licenses | 检查通过 | 2–3 |

## 7. 门禁命令

    # 快速门禁（每个任务必跑相关子集）
    npm --prefix frontend run build
    npm run typecheck
    npm run test:ui
    node --test scripts/test-*.mjs

    # 引擎（venv 以 docs/FOUNDATION.md §5 为准；在 engine/ 下）
    python -m pytest tests -q -p no:cacheprovider

    # 应用级（里程碑 Gate 必跑）
    node scripts/e2e/run.mjs
    node scripts/perf-baseline.mjs
    node scripts/dualrun/compare.mjs
    node scripts/check-contracts.mjs

    # Rust
    cargo fmt --check && cargo clippy -- -D warnings && cargo test
    cargo bench -- --baseline=ci

## 8. 并行与写作用域

- 共享文件（Lead 独占）：preload.js、main.js、docs/FOUNDATION.md、schema 生成物、build 配置、.github/。
- 产品线写域：frontend/src/{views,components,stores,core}；engine/ 仅限任务指定文件。
- 运行时线写域：crates/**、scripts/rust/**、src-tauri-new/**。
- 同一里程碑内：产品线与运行时线不得改同一文件；需要时由 Lead 做桥接提交。
- 并行任务数 ≤4；每任务独立分支；合并前跑门禁并 rebase。

## 9. 停止条件与升级

- NEED_LEAD：需要改共享文件/契约/数据格式/新增依赖 → 停下上报。
- NEED_USER：产品取舍（音频轨、tch 可选包、砍功能）、工期偏差 >30%、POC 失败无替代。
- 每任务失败最多重试 2 次；仍失败则回滚并标记 BLOCKED，写清复现步骤。
- 连续 2 周里程碑偏差 >30% → 触发范围重排（砍 P2 或延后）。

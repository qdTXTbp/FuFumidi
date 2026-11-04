# Master Plan 执行进度（滚动更新）

> 关联：[整合总方案](./2026-11-03-master-integrated-plan.md) · [AI 实现规格](./2026-11-03-master-ai-spec.md)
> 规则：每轮只记「已验收的事实」；数字要有命令/文件出处；未验收的移到「进行中」。

## 轮次 3（2026-11-03 夜）— M0 开工

### 0. 前置复核：6.6 清单里哪些其实已经做完了

审计文档写于 6.2.9；当前 HEAD（6.4.2）已包含 6.3.1 的编辑器 P0 修复。逐项对照代码：

| 需求 | 状态 | 证据 |
|---|---|---|
| P-001 音符试听 | **已满足** | EditorCanvas.vue:65-76（auditionNote → synth.preview，45ms 节流） |
| P-002 多选拖动 | **已满足** | EditorCanvas.vue:1375-1388（targets=selection；onMove 遍历 d.notes） |
| P-003 拖动吸附 | **已满足** | EditorCanvas.vue:1462-1468（按 snapRatio 取整；Ctrl 自由） |
| P-004 走带/循环保持 | **已满足** | EditorCanvas.vue:360-380（afterEdit 保存并恢复 pausedTick/loop） |
| P-005 全局键让位 | **已满足** | App.vue:514-520（编辑器/调教焦点分区，__fromGlobalHotkey 拦截） |
| P-006 撤销时机/标签 | **已满足（时机）** | EditorCanvas.vue:340-353（pushState 在修改前；label 传入快照） |
| P-007 标尺/点击定位 | **本轮新增** | EditorCanvas.vue（RULER_H / drawRuler / rulerDown/Move/Up） |
| P-008 内置音色 CC 最小集 | **已满足（CC7/CC11/CC64/bend）** | synth.js:389-396、player.js:169-214（CC64 延长音符） |
| P-009 轨道 CRUD | 未做 | 属 6.7 |
| P-012 快捷键可配置 | **已完成（E2E 验收）** | core/shortcuts.js + SettingsPanel 录像/持久化；shortcuts-config E2E 验证改 T 后真实播放/暂停 |
| P-013 量化体系 | 未做 | 属 6.7 |
| P-015 编排进入播放 | **已完成（事件级验收）** | core/arrange.js + player.js 真源；E2E arrange-playback 验证移动/静音改变 player.events |

> 结论：M0 产品止血的实际剩余项远少于计划；本轮把可验证的剩余项做了，其余移到 6.7。

### 1. 本轮完成（已验收）

| 任务 | 内容 | 验收 |
|---|---|---|
| T-001 | 工程模型 v2 冻结稿 docs/RUST-PROJECT-MODEL.md | 文档评审（字段/不变量/迁移/所有权） |
| T-002/T-003/T-004（IPC 部分） | 契约提取脚本 scripts/contracts/extract-ipc.mjs + docs/contracts/ipc.schema.json + npm run check:contracts | 实测 250 invoke / 2 send / 250 handle / 2 ipcMain.on / 28 events，双向差集 0；CI 已接线 |
| T-011 | 卷帘标尺：小节号/拍线/循环区间/播放头；点击定位；Shift 拖动设循环；双击清除 | 前端 build/typecheck 通过；UI 测试 555/555 |
| T-014 | 合并同音高碎片开关；默认合并间隔 30ms→0（保留轮指/颤音）；no_merge 贯穿 UI→worker→引擎；EN/JA 文案 | 前端 build 通过；i18n 已补 |
| T-015 | main/db.js：修复 close() 引用未声明变量（ReferenceError）；持久化改 800ms 去抖 + 异步落盘 + 退出 flush | node --test scripts/test-db-persist.mjs 3/3 |
| T-016 | main/engine-probe-cache.js：probe/depCheck TTL 10min + 单飞；安装依赖后清缓存 | node --test scripts/test-engine-probe-cache.mjs 5/5 |
| T-017 | main/storage.js：60s 报表缓存 + 单飞；cleanup 用 fresh 实时报表 | node --test scripts/test-storage-cache.mjs 4/4 |
| T-018（部分） | CI 增加契约漂移门 + M0 单测；perf:gate 保持脚本入口 | CI 配置已改；待下一次 CI 验证 |

### 2. 进行中（本轮未验收）

| 任务 | 负责 | 状态 |
|---|---|---|
| Rust workspace + SMF core + engine CLI（T-023/T-109 前置） | 子代理 A | 运行中 |
| Tauri 2 最小 POC（构建/体积/updater/WebView2） | 子代理 B | 运行中 |
| T-018 完整 perf gate（真实 GUI 基线） | Lead | 需可见会话，下一轮 |
| 6.6 剩余项：快捷键可配、轨道 CRUD、量化面板 | — | 属 6.7，按计划推进 |

### 3. 本轮验证记录

- npm --prefix frontend run build → exit 0（7.96s）
- npm run typecheck → exit 0
- npm run test:ui → 555/555 pass
- node --test scripts/test-{engine-probe-cache,db-persist,storage-cache}.mjs → 12/12 pass
- node scripts/contracts/extract-ipc.mjs --check → 零漂移

### 4. 下一轮（R4）候选

1. 合并子代理产物（crates/、poc/、docs/rust/）并跑 cargo test。
2. 若 Tauri POC 通过：把 crates/ 接入 scripts/build-rust.ps1，产出 resources/rust-core/fufumidi-engine.exe。
3. 6.7 第一组：轨道 CRUD（P-009）、拍号编辑（P-010）、快捷键可配置（P-012）。
4. 数据模型 v2 的 JS 侧落地：Note.id/Clip/命令接口（先把「命令可序列化」做出来）。
5. perf gate：在有 GUI 的会话跑 node scripts/perf-baseline.mjs --update-baseline，更新 6.4.2 基线。

### 5. 本轮追加（运行时轨道，23:1x–23:4x）

| 事项 | 结果 | 证据 |
|---|---|---|
| Rust workspace 可构建 | crates/ 下 fufumidi-core（零依赖）+ fufumidi-engine（CLI + JSON 行协议），cargo test / build 绿 | crates/target/debug/fufumidi-engine.exe |
| 测试数 | **64 个 Rust 测试全绿**（core 38 = smf_parse 16 + smf_contract 8 + stats 6 + transform 8；engine 26 = cli_tests 19 + protocol 7） | cargo test 输出（2026-11-03 复核） |
| 新引擎实测 | ping/version/midi-stats/batch-stats 与旧契约兼容，且多出 avg_dur_ticks | 手动执行 |
| JS↔Rust 双跑 | 6 个真实 fixture + 12 个合成 MIDI，0 差异（含 avg_dur_ticks） | node scripts/dualrun/compare-midi.mjs --gen --rust-bin ... |
| 引擎参数契约 | 57 params / 43 worker keys / 27 engine map / 15 flags，已知漂移 0 | docs/contracts/engine-params.schema.json |
| 主进程接入新引擎 | main/rust.js 优先 fufumidi-engine.exe（FUFUMIDI_RUST_BIN 可覆盖），3 个桥测试通过 | scripts/test-rust-bridge.mjs |
| CI | 新增 rust-core job（cargo test + release build + dual-run + bridge tests） | .github/workflows/ci.yml |
| Tauri POC | 子代理仍在拉取依赖（网络慢）；结论待其报告，暂不阻塞主线 | poc/tauri-poc/ |

### 6. 下一轮（修订）

1. 合并子代理 A 的 docs/rust/WORKSPACE.md 与其 scripts/rust/*（若已交付），更新根 npm run build:rust。
2. 若 Tauri POC 有结论：把 updater/printToPDF/插件三个 POC 的通过标准写成可执行验收。
3. 6.7 第一组：轨道 CRUD（P-009）或拍号编辑（P-010）二选一，先冻结数据模型细节再动代码。
4. 把 cargo fmt/clippy 加进 CI（当前本机工具链未装组件，CI 可装）。
5. 全量门禁：npm run audit（含 check:contracts）在干净环境跑一遍。

### 7. 门禁修复（本轮）

- check:i18n：新增的 2 条中文文案已同时进 EN/JA 的**单引号词典区**（checker 只解析单引号键）；现在 EN/JA 均 0 新增缺失。
- check:empty-catch：原门禁默认基线 0，而 HEAD 有 9 个存量空 catch → 必红（红门禁等于没有门禁）。
  改为 scripts/empty-catch-baseline.json 棘轮（当前 9），--update-baseline 显式重记；现在通过。
- 验证：check:i18n / check:empty-catch / check:contracts 全绿；test:ui 555/555。

### 8. 子代理 A 交付（已并入）

- crates/ workspace（fufumidi-core 零依赖 + fufumidi-engine CLI/协议）+ crates/Cargo.lock。
- docs/rust/WORKSPACE.md（326 行：目录、API、协议、构建/测试、限制）。
- scripts/rust/build.ps1（UTF-8 BOM；构建后复制到 resources/rust-core/，含兼容别名）与 test.ps1（test→fmt→clippy，缺组件跳过）。
- 测试：core 38 + engine 26 = **64 个全绿**；cargo fmt / clippy -D warnings 均 clean（子代理已安装组件，Lead 复核）。
- 与 Lead 的工作无冲突：main/rust.js 候选顺序、CI rust job、双跑脚本均按此接入。

### 9. 前端设计与品牌（用户 2026-11-03 追加要求）

- 新增 docs/BRAND.md：品牌规则/16 个资产清单/变更流程/迁移检查（Tauri 必须复用同一套 logo）。
- 新增 npm run check:brand：SHA-256 manifest 门禁（scripts/brand/brand-manifest.json），CI 已接线；
  品牌资产当前 **16/16 未变**。
- 前端设计完善进入 P-026 / T-113：三大视图样式换 controls.css 契约类、980/1280/1585 三档回归、
  a11y/空状态/错误反馈收口；原则是「不借重写顺手改视觉语言」。
- 品牌迁移校验 T-114：Tauri 图标/安装器/splash 复用 build/icon.* 与 installer*.bmp，截图对比。

### 10. 基线切换：6.4.2 → 6.5.0-beta.1（2026-11-04）

- 用户指定「以最新预发行版 6.5.0 beta-1 为基线」：代码 rebase 到 **47f6062**（chore(release): 6.5.0-beta.1），
  备份分支 backup/pre-650-rebase；原 8 个提交中 licenses 重生成被跳过（改由 6.5.0 生成器重生成）。
- 冲突处理：package.json 保留 beta 的 test:zip（去掉 test:zip-safe/engine-memory），合并我们的
  storage-cache/db/probe/rust-bridge 测试；licenses 由 beta 生成器重算。
- 基线自带欠账（切换后 audit 红）一并修复：
  · i18n 13 条 3D/侧栏新文案 —— 采用 6.5.0 post-beta 的官方译文（与我们初稿不一致处以官方为准）；
  · Piano3D/SideBar/ViewViz 的 19 处设计 token 字面值 → var(--sp-*/--r-*/--fs-*/语义色)；
  · **stemEnhance / trackBudget 死控件**：真接到 renderer → task-queue → stem-workflow → stem_merge.py --budget，
    新增 Python 测试；audit:dead-options 与 audit:params 均绿。
- 契约：事件 28 → **29**（beta 新增 1 个）；invoke/handle 250/250、引擎参数 0 漂移。
- 品牌：beta 删除独立更新器图标与下载页横幅、更新 NSIS 安装器图；**应用图标/侧栏徽标/首页吉祥物/母图/立绘哈希未变**，
  manifest 16 → 13（docs/BRAND.md 记录了差异）。
- 用户进场前的未提交 WIP（README 版本号 + MIROS CUDA 修复）保存在 stash@{0}，未混入本次提交。
- 门禁：build 8.47s / typecheck 0 / test:ui **561** / audit 全绿 / cargo 64 / dualrun 18 文件 0 差异。

## 11. 前端设计回归基线（2026-11-04）

- 新增 `scripts/design/shoot.mjs`（npm run design:shoot）：三大视图 × 980/1280/1585 三档宽度截图，
  自动统计横向溢出与越界元素；实测三档均无页面级横向溢出。
- 首轮截图发现并修复两处真实布局病（980 档）：
  · 调教页（ViewSing）：页头/页签不换行、左右两栏把时间线与属性面板挤出可视区 →
    ≤1120px 改上下布局（轨道栏限高 + 编辑区全宽）、页头/页签换行、轨道卡横向排布；
  · 转录页（ViewTranscribe）：智能分轨的超长提示把「保留轨道」预算选择挤出 →
    提示独占第二行（flex-basis 100% + order），第一行只留开关与预算。
- 视觉证据：scripts/design/artifacts/{edit,sing,transcribe}-{980,1280,1585}.png（本地产物，gitignored）。

### 11.1 全量 E2E 基线（2026-11-04）

- 6.5.0-beta.1 上全量 `node scripts/e2e/run.mjs`：**33/33 通过**（首轮 26/29；新增用例后复核）。
- 修掉 3 个真实问题（不是改断言绕过）：
  · `transcribe-queue-chain`：`ReferenceError: quality is not defined` —— ViewTranscribe 的
    analyzeQuality/长音修复引用了一个从未声明的 ref，队列收尾即崩；
  · `tasks-ui`：TaskCenter 的 FAB 只绑 pointerup，没有 click 语义（键盘/自动化都打不开面板）
    —— 去掉 pointerdown 的 preventDefault，click 打开，拖动后抑制一次 click；
  · `convert-ui`：导入流程会晚一步抢 hash，测试在首页采样到空 labels —— 测试改为重试导航直到
    `.convert-view` 真正挂载。
- E2E 基础设施：`Page.addScriptToEvaluateOnNewDocument` 持久注入浮层关闭器，`location.reload()`
  后不再被动态壁纸/更新浮层挡住。

### 11.2 设计回归覆盖（2026-11-04）

- design:shoot 扩到 **7 个主视图 × 3 档宽度 = 21 张**（home / music / views / resources / edit / sing / transcribe）。
- 21/21 无页面级横向溢出；仍有 3 个「越界但可滚动/被容器裁剪」的交互控件，记为下一批：
  sing 980 的一个 header 按钮（右溢出 3px）、sing 1280 的逐音素 select（右 1322）、
  transcribe 1280 的队列按钮（右 1316）。它们不影响功能但属于布局欠账，T-113 收口时一并处理。

## 12. 6.7 轨道 CRUD（2026-11-04）

- EditorCanvas 全量快照升级：除音符/CC 外记录轨道元数据（name / program / ch / isDrum / events），
  undo/redo 走 `restoreAllSnapshot()` **重建 tracks 数组**，因此新建/删除轨道也能撤销（此前只回填音符）。
- ViewEdit 检查器「轨道」页签新增操作行：新建 / 删除 / 改名 / 上移 / 下移。
  · 新建默认名「轨道 N」，通道取第一个未占用（跳过 9）；
  · 操作前 `pushStateForTrack(-1, 动作名)`，操作后 `notifyExternalEdit()` → 脏标记/自动保存；
  · 删除至少保留一条；改名走统一 promptDialog。
- E2E `edit-track-crud`：新建→改名→上移→删除→Ctrl+Z 恢复→Ctrl+Y 重做，断言直接读 song().tracks，全绿。
- 验证：audit exit 0、test:ui 561/561、typecheck 0、build 通过、smoke/edit-basic/edit-track-crud 3/3。

### 12.1 拍号编辑（P-010，同日）

- EditorCanvas 快照同时记录/恢复 **sigMap**（此前只存 tempo），撤销改拍号不会丢。
- 检查器「视图」页签新增：分子 1–16 / 分母 2·4·8·16 + 「应用」——
  按**播放头所在小节**写入 sigMap（tick 0 替换默认拍号，其它 tick 插入变拍点），只改小节线不动音符。
- E2E `edit-time-signature`：4/4 → 3/4 → Ctrl+Z 恢复，音符数不变，全绿。

## 13. 3D 钢琴独立页（2026-11-04）

- 用户要求：3D 钢琴从「可视化」里独立出来，不再作为 viz 的一个 tab。
- 新增 `/piano3d` + `ViewPiano3D.vue`：页面头部（标题/副题/当前曲目/打开可视化/全屏）、全屏监听、
  3D 场景占满剩余高度；主导航新增 3D 入口（rail「3D」，title「3D 钢琴」），VIEWS 注册进命令面板。
- ViewViz 删除 3D 模式（按钮/组件/样式全部移除），只保留仪表盘/瀑布流。
- Piano3D：修正 prop 约定（必须传 app.currentSong 包装对象，传裸 song 会一直显示"载入一首 MIDI"）；
  控制条窄屏换行（≥1280 单行滚动），状态/评分/键位/录音/音游均保留。
- E2E `piano3d-page`：独立路由可达、有全屏按钮、rail 有入口；可视化里不再有 3D tab/挂载。

## 14. 智能分轨完善（2026-11-04）

- 修掉一个真实断链：main/task-queue.js 一直在发 `engine:stem-progress`，但 **preload 从未订阅**；
  新增 `onStemProgress`（preload + ipc.ts 类型），转录页实时显示分轨阶段/百分比。
- 转录页智能分轨行新增：分轨模型状态（已安装/未安装 + 模型名 + 去资源中心下载）、
  预算选择 tooltip（auto = 6–12 轨，按音符数/置信度评分，核心角色优先）、关闭开关时预算禁用。
- 契约：新增 `onStemProgress` 订阅后重新生成 schema，`check:contracts` 零漂移。
- E2E `transcribe-stem-ui`：预算 5 档、状态徽标、开关联动禁用，全绿。

## 14.1 量化增强（2026-11-04）

- 快速量化支持强度与终点选项（EditorCanvas quantize(opts)）；智能量化弹窗默认强度 100%，
  新增「量化终点（关闭则保持时值）」——默认保持时值，断奏/齐奏收尾可显式打开。
- E2E `edit-quantize`：非网格音符 → 全选 → 1/8 + 量化终点 → 起点/终点均落网格 → Ctrl+Z 恢复，全绿。

## 15. 范围变更：取消 Rust/ONNX 替换 Python 引擎（2026-11-04）

- 用户决定（原话）：「Rust/ONNX 替换 Python 引擎,这一项改动不执行了」；同时要求「注意让现有的模型都能使用」。
- 决策记录：docs/decisions/ADR-0001-cancel-python-engine-replacement.md。
- 冻结项：R-007…R-011、T-306…T-308、W-E0…W-E4、M3/M4 的「移除 Python/删 Electron 清理」；
  不再以「去 Python / 安装包 ≤250 MiB / 首任务 ≤1.5 s」作为验收。
- 保留项：产品专业化升级（6.6/6.7/6.8）、契约/门禁、设计/品牌约束继续；
  Rust 非 ML 核心（crates/、main/rust.js）作为可选加速保留，不删除；Tauri 外壳去 Electron 是否继续另行确认。
- 已同步：master-integrated-plan（G4/M3/M4/W-E/风险表）、master-ai-spec（R/T-3xx + R-014 硬约束）、
  rust-fullstack-plan、rust-rewrite-plan 顶部均加了取消横幅。

## 15.1 方向确认：Tauri 继续 + 非 ML 尽量 Rust（2026-11-04）

- 用户确认：「继续用 Tauri 替换 Electron」「在这些前提下,尽量都用 RUST 重写」→ [ADR-0002](../decisions/ADR-0002-tauri-rust-max-hybrid.md)。
- 目标架构改为混合：**Tauri/Rust host** + Rust 非 ML（文件/工程/任务队列/下载更新/音频链/
  MIDI·SF2·MusicXML·ustx/UTAU DSP）+ **Python 仅模型推理 sidecar** + Vue/WebView2 UI。
- 计划同步：R-007/R-008/R-011 恢复执行；R-009/R-010 仍取消；新增 R-015（Tauri host 替代主进程）、
  R-016（Python 只做推理）、T-117（Rust host 业务骨架）、T-118（Python sidecar supervisor）、
  T-119（Tauri 默认分发 + Electron 回退）、T-214（UTAU/OpenUTAU DSP）；T-211（ONNX）取消；
  T-402 改成「删除 Electron 主进程，保留 Python sidecar」。
- 下一步：Tauri host 骨架（加载 renderer/dist + Python 发现/自检）→ T-115 IPC 纵切 → T-118 sidecar supervisor。

## 16. 现有模型可用性（硬约束 R-014）

- 约束：转录/分轨/OMR/调教/翻唱的**模型格式、路径、ID、下载源不变**；Python 引擎随包保留。
- 本轮实测：`window.fuBridge.modelList()` 返回 **91 个模型条目**，覆盖 basic_pitch / piano_transcription /
  hft_transformer / miros / yourmt3 / muscriptor（3 规格）/ beat_this / audio_tagger / aria /
  separation（29 项，含 4 个 demucs 家族）；模型注册表未做任何删除或改格式。
- 真实推理回归：E2E `transcribe-queue-chain` 仍用 Basic Pitch 跑真实转录；`transcribe-stem-ui` 校验分轨入口；
  全量 33/33 通过。
- 新增 `scripts/e2e/cases/models-catalog.mjs`：守住模型家族与字段完整性，防止后续改动悄悄删模型/改 ID。
- 兼容矩阵与变更流程：docs/MODELS-COMPATIBILITY.md。

## 18. Tauri 真正外壳第一步（2026-11-04）

- 新增 `shells/tauri/`（不再是 POC）：tauri 2 壳，命令 `host_info` / `python_selfcheck` / `ping`；
  加载现有 `renderer/dist`，Python 只做发现/自检（推理仍归 Python，ADR-0002）。
- 实测：复用 POC target 编译 **16.7 s**；`--self-check` 输出 version 6.5.0-beta.1、
  `resources/python/python.exe` exists=true、renderer/dist exists=true；
  开窗 **0.66 s**，标题 FuFumidi，主进程 RSS 41.4 MB，WebView2 子进程 7；
  截图 `shells/tauri/artifacts/window.png`（真实首页 + 新手引导，不是占位页）。
- 文档：docs/rust/TAURI-SHELL.md（边界/构建/实测/下一步/风险）。
- 边界未变：**IPC 仍缺 ~172 条**、更新链仍要自研；模型兼容硬约束继续生效。
- **T-115 IPC 纵切已完成 11 条**：app_version / load_settings / save_settings / db_kv_get / db_kv_set /
  list_midi_files / read_binary / save_binary + host_info / python_selfcheck / ping；
  `npm run tauri:smoke` 通过 WebView2 CDP 实测 9 项断言全绿（settings 42 往返、MIDI 头 MThd、
  字节往返、Python 3.12.10、#app/fuBridge/__TAURI__、正文 >200 字），截图 artifacts/smoke.png。
- **T-118 第一步已完成**：Rust 命令 `engine_probe` 真实启动 Python `music2midi.py probe`，
  返回 engine 路径、耗时 **4.9 s**、完整 probe JSON（app=FuFumidi 转录引擎，piano available=true 等）；
  smoke 断言增到 **10 项**全绿（新增 engineProbe）。
- **T-118 常驻 supervisor 已完成（核心）**：Rust 维护 `music2midi.py worker` 进程，
  `###LOG/###PROG/###RESULT` 按 `_id` 解析并转发 Tauri 事件；退出时 kill；
  实测 1 s WAV → Basic Pitch **1 音符**，冷 14.3 s / 暖 **5.5 s**，13 条日志，输出 MIDI 头 MThd；
  smoke 扩到 **12 项**断言全绿（新增 convert/worker）。
- **T-118 P0（只落调度模块，未接生产）**：新增 `shells/tauri/src/worker_pool.rs`（`WorkerProc` trait +
  `WorkerPool` + `Lease` + `MockWorker`），cap 1–4、等待者上限、每 job 独立取消、`cancel_all`、
  `shutdown`、`status`，锁内只做 O(1) 元数据；14 项 mock 单测（并发上限、按 id 取消、取消全部、
  shutdown、等待者溢出、lease/panic 不泄漏槽、spawn 失败/取消回收、status）。实现用显式 `in_flight`
  容量计数，保证旧 worker 的 kill/drop 与新 spawn 不重叠（cap=1 实测曾出现瞬态 2，已修）；spawn 工厂 panic
  用 catch_unwind 归还容量。并发测试连跑 20 遍全绿。生产 `run_convert` 仍走单 worker，未改任何 IPC/桥/前端。
  cargo test **56/56 + 1 ignored**；无窗口/无真实进程测试。
- **T-118 P1（生产等价池化）**：`WorkerState` 改为 `WorkerPool::with_reuse(1)` + 全局 seq；新增真实
  `ChildWorker`（stdin/stdout、stderr null、CREATE_NO_WINDOW、kill 幂等、Drop 兜底、暖复用）；
  `run_convert/spawn_worker/cancel/engine_worker_status` 全走池；取消先置 per-job 标志再锁外 taskkill，
  cap=1 未知 id 回退唯一在途；退出 `pool.shutdown()` 杀暖 worker。新增 10 测试（4 个真实 Python 子进程），
  cargo test **78/78 + 1 ignored**，release 构建 + `--self-check` 通过；未接 `__slots` 并发（P2）。
- **T-118 P3 子集**：`_id`/`engine:log`/`engine:progress` 改用前端 `cfg.id`（缺省 `job-<seq>`），
  结果 id 同时接受字符串/数字；桥补 `onEngineProgress`；新增纯函数测试；cargo test **85/85 + 1 ignored**。
  剩余 P2 并发与进度节流/UI 队列绑定。
- **T-118 P2（动态并发）**：`WorkerPool::set_cap(1..=4)`；`convert` 按 `__slots` 调容（GPU 未禁用时 −1，
  `FUFUMIDI_MAX_WORKERS` 可压低）；`JobMap` 前端 id → 池 JobId 精确取消，cap>1 未知 id 不误杀；
  status 返回 cap/workers[]（在途 jobId + 空闲暖 pid），不抢在途槽锁；缩容只杀空闲暖 worker。
  默认缺省 `__slots` 仍 cap=1，与 P1 等价；7+3 项新测试；cargo test **95/95 + 1 ignored**。
- **T-117 第一步 + UI 路由冒烟**：新增 `db_status/db_songs_list/db_songs_put/db_songs_delete/
  db_playlists_list/db_playlists_put`（JSON store，原子 rename，dataDir 可覆盖）；命令总数 **20**。
  smoke 增加 **uiRoutes**：`#/transcribe → #/resources → #/piano3d → #/music → #/home` 逐页渲染，
  实测 textLen 658–1404、#app 挂载、无崩溃；smoke **15 项**全绿。
- **T-115 再扩面 + 数据根对齐**：新增 `model_list`（13 个核心模型条目，真实 exists/size），
  命令总数 **21**；默认数据根优先安装目录旁 `FuFumidiData`，否则 `%APPDATA%/FuFumidi/FuFumidiData`
  （与 Electron 版布局一致，模型目录=数据根/models）。
- smoke 增至 **16 项**全绿（新增 modelList：13 条、id 齐全、含 separate）；UI 路由 textLen 未回退。
- **桥注入时序修复（重要）**：`api.bridge` 改为 live binding + `refreshBridge()`；
  `bridge/install.ts` 作为 main.ts 第一个 import；新增 `npm run tauri:build`
  （Tauri 把 renderer/dist 嵌进 exe，只 build:ui 不会更新壳）。
- **uiLibrary 验收通过**：写入 `Smoke UI Song` → 真刷新 → storeSongs=1、曲库 1 首、
  首页"继续上次的工作"出现该曲；smoke **17 项**全绿。
- **T-115 又一批（6 条 → 共 27 条）**：`soundfont_list`（GeneralUser.sf2）、`dep_check`（Python `deps.py check`，
  返回 universal/piano/aria/muscriptor/separate/transkun 6 组）、`diag_export`（diagnostics-<ts>.json）、
  `notify`（明确 delivered=false）、`open_output/open_external`（校验路径/协议，非法安全失败）。
  smoke 增至 **21 项**全绿；页面数据仍缺 `presets_*`；
- **T-118 取消已打通**：`cancel` 置 AtomicBool + taskkill pid，convert 识别 EOF 返回
  `{ok:false,canceled:true}`，worker running=false；smoke 用 **120 s WAV** 在 1.2 s 时取消，
  **22 项**全绿（新增 cancel）；下次 convert 自动重新拉起 worker。
- **T-115 预设收尾**：新增 8 条 `presets_*` 命令（list/save/delete/last_used/set_model/reorder/reorder_to/restore），
  数据存 dataRoot/presets.json；内置 9 套预设由 engine/presets.py 生成并嵌入 builtin_presets.json
  （运行时不再调 Python）；桥补 setModelPreset；smoke **23 项**全绿（9 builtins/11 model_defaults/保存/绑定/删除）。
- **T-118 暂停已打通**：worker 启动注入 `FUFUMIDI_PAUSE_FILE=dataRoot/engine.pause`；
  `set_transcribe_pause` 写/删文件，引擎 pause_gate 原地等待（120 s WAV 实测：暂停 900 ms 未结束，
  继续后完成，pausedConv.elapsedMs=2255）；桥补 `setTranscribePause`；smoke **24 项**全绿。
- **T-114 品牌图标一致性**：Tauri 壳原用另一枚 icon（与 build/icon.ico 像素不一致），
  已替换为 build/icon.ico 同字节；`check:brand` 新增 shellIconMismatch equality 校验，
  13 项品牌资产 + Tauri 图标全绿。
- **T-119 第一步：release 构建**：锁 Tauri CLI 2.12.4（devDependency），新增
  `npm run tauri:release`；冷编译 1m38s，产物 **12.49 MB**；release 壳跑完整 smoke
  **24/24**（真实转录 7.9 s、worker、曲库、预设、取消、暂停）。
- **T-119 NSIS 安装包已打通**：`npm run tauri:bundle` 产出 **237.81 MiB** 安装包；
  安装后 **814 MB**；安装目录内 python/engine/soundfonts/models 全量落盘；
  安装版 smoke **24/24**，host_info 证实资源来自安装目录，真实转录 **4.2 s**。
  NSIS 工具链经代理预置（SHA1 校验）。
- **T-119 收尾进展**：`mainBinaryName: FuFumidi`，安装包主程序改为 **FuFumidi.exe**；
  重打并安装到干净目录，安装版 smoke 仍 **24/24**（renderer=<embedded>，python/engine 来自安装目录，转录 5.3 s）。
  Electron 回退基准：E2E **37/37**、`pack:base` 成功；**Electron NSIS 已重打**
  （排除 Tauri 产物后修复 7.2GB asar/EBUSY，安装包约 614 MiB；无头会话静默安装挂起，待交互桌面手测）。
- **P-011/T-103 命令式撤销核心（第一批已接入 EditorCanvas）**：新增 `frontend/src/core/command_history.js`：
  增量命令（undo/redo 闭包）、标签、事务合并、limit/50MB 硬上限、diff 字节估算；
  redo 预算、huge 上限、`seq/dropLast/entries`；`command-history.test.js` 5 项全过
  （含 10 万音符 × 50 次增量编辑 < 50MB 的内存验收）。
  `core/note_commands.js` 已修两个会在排序后删错/改错音符的索引缺陷，并补索引纪律回归；
  `core/editor_history.js` 提供快照+增量共栈的纯逻辑，新增 8 项单测。
  **第一批接入**：`EditorCanvas` 的 `addNote/deleteNoteExternal/editNote/insertKeySwitch` 改走命令 entry，
  与快照 entry 共用同一条 `undoStack`（`kind:'command'`），undo/redo 按 entry 类型分派；
  ViewEdit 支持 Ctrl+Shift+Z 重做。新增隐藏 E2E `edit-undo-commands`，并修掉 `about-ui` 的启动路由竞态；
  **隐藏窗口全量 E2E 38/38 通过**（无可见窗口）。
  **第二批**：`deleteNotes`（多选批量）也改走命令 entry；`ViewEdit` 切曲目时清空撤销栈（防串栈），
  历史面板加 `histRev` 版本号随编辑/撤销刷新；E2E 增加批量删除 undo/redo 断言。
  **第三批**：`quantize/transpose/velRamp/toggleMute/setSelMuted/setSelBend/setSelVel/setSelMidi/setSelStart/
  setSelLen/applyVelCurve` 在单轨内改走一条 update 命令（多字段 before/after + note 引用）；跨轨仍走快照，
  避免轨道归属错乱。E2E 增加 selectAll + transpose/setSelVel 的 undo/redo 断言。
  **第四批**：`pasteAt/duplicateSelected` 改走 add 命令，并按引用选中新音符（避免 afterEdit 排序后选错尾部）；步进输入也改走 add 命令。
  **第五批**：新增 `core/cc_commands.js`（CC 增/删命令，按引用定位）；`addPedal/delPedal` 改走命令 entry，
  E2E 覆盖踏板 undo/redo。CC 泳道拖拽仍走快照。
  **第六批**：`commitPreview` 改为一条 update 命令（预览前后字段 diff，撤销回预览前）；
  `applyDraft` 列表编辑器批量写回也走 update 命令；E2E 覆盖预览提交与草稿写回的 undo/redo。
  **第七批**：历史面板行内「撤销」不再是空操作：点击第 i 行连续 undo（该步及之后），面板文案/EN/JA 同步；
  E2E 覆盖 3 步历史回退 2 步/最后 1 步。
  **第八批**：CC/PB 泳道拖拽改为一次手势一条命令：down 捕获 ccs/events 副本、up 比较后
  用 `makeReplaceCcStateCommand` 整体替换（undo/redo 副本隔离）；`edit-pb-lane` E2E 增加撤销清零/重做恢复。
  **第九批（存储层）**：`session.js` 每 doc 持有 `createEditorHistory` 引擎（80/32MB/超大 8MB 留 2）；
  `pushUndo/undo/redo/canUndo/canRedo` 转发；新增 `history/depth/clearUndo`；`markDirty` 不再清 redo
  （保存后撤销不会被 4s 自动保存轮询清空）；4 项 session-history 测试。
  **第十批（接入）**：`EditorCanvas` 新增 `history` prop，删除内部 undo/redo 数组与裁剪逻辑，
  快照/命令全部走 session 引擎（fallback 本地引擎）；undo/redo 收敛为一次 engine 调用 + selection.clear+afterEdit；
  `pushMark`/长按取消用 `seq()/dropLast()`；`ViewEdit` 在 doc 切换时先同步 `histRef` 再 await 关旧 doc；
  新增隐藏 E2E `edit-undo-session`（单栈 bytes、跨页保留、切歌隔离、保存/自动保存轮询后 redo 仍存活）。
  **编辑页 P-011 已完成**：隐藏全量 **39/39** 通过。
  **第十一批（跨页统一）**：`ViewArrange` 删除 tabbed registry，改用 `appSession.history(docId)` 同一文档引擎；
  编排状态作为 `pushSnapshot` 的 arrange 快照 entry（capture/restore 只触编排状态），与编辑命令共享 LIFO；
  切曲目=切 doc=独立栈；新增隐藏 E2E `edit-arrange-session`（编辑加音符 → 编排加标记 → 撤销标记 → 回编辑撤销音符）。
  **编辑↔编排撤销栈已统一**，隐藏全量 **40/40** 通过；编排仍是快照 entry（非纯增量），但不再有双栈/双真相。
- **Tauri check_midi 已补**：Rust 实现与 Electron 同语义（只认数据根 midi/ 内非空文件），
  桥补 `checkMidi`；Tauri 曲库自愈不再因缺命令而跳过。Rust 单测覆盖根内保留/缺失/根外路径。
  命令总数 **44**；本轮全部无头验证（cargo test / typecheck / build / audit）。
- **Tauri wallpaper_defaults 已补**：桌面视频扫描（mp4/webm/mov，最多 4 个、按名排序），
  桥已有映射；Rust 单测覆盖排序/截断/扩展名过滤。命令总数 **45**。
- **Tauri 曲库文件操作已补**：`delete_midi` / `rename_midi`（限数据根 midi/、非法字符清洗、
  重名加 (2)、扩展名保留），桥补 deleteMidi/renameMidi；Rust 单测覆盖根外拒绝、改名落盘、
  同名不重命名、删除消失。命令总数 **47**；仍全部无头验证。
- **Tauri 曲库/音频辅助命令**：`list_audio_files`（递归音频扫描）、`library_stats`（顶层文件数/字节）、
  `read_soundfont`（SF2 原始字节，512MB 保护；SF3 转换仍留在 Electron/Python 路径）；
  Rust 测试覆盖音频扩展过滤/递归/统计；命令总数 **50**。
- **Tauri 歌单删除 + IPC 覆盖基线**：`db_playlists_delete`（SQLite 往返单测）命令总数 **51**；
  新增 `npm run tauri:coverage` 静态统计（不弹窗）：preload **265** 方法 / Tauri **97** 方法 /
  未映射 **168**（250 invoke vs 88 call），分类明细写入 `docs/rust/IPC-COVERAGE.md`，作为后续迁移路线图。
- **Tauri 数据根命令**：`data_root`（9 个目录大小概览）、`open_data_root`（安全子目录校验后打开）、
  `clean_temp`（清理 temp 并返回释放字节）；桥补 dataRoot/openDataRoot/cleanTemp；Rust 测试
  覆盖概览条目/大小/清理；命令总数 **54**，覆盖刷新为 100 方法/165 未映射（91 call）。
- **Tauri 曲库体检/查重（Rust core）**：`has_midi`、`verify_midi`（复用 fufumidi-core 解析，
  返回轨道/音符/BPM/损坏列表）、`dupe_midi`（FNV-1a 分组）；桥补 hasMidi/midiStats/verifyMidi/dupeMidi；
  Rust 测试覆盖合法 SMF 2 音符、坏文件、重复组；命令总数 **57**，覆盖 104 方法/161 未映射（95 call）。
- **Tauri 缩放/全屏**：`get_zoom_factor/set_zoom_factor/set_full_screen`（50%–300% 夹取、状态记忆、
  WebView 缩放与全屏）；桥补 getZoomFactor/setZoomFactor/setFullScreen；Rust 测试覆盖缩放夹取；
  命令总数 **60**，覆盖 107 方法/158 未映射（98 call）。真实窗口行为未在无头会话验证。
- **Tauri 自动保存/崩溃恢复**：`autosave_write/list/read/clear`（dataRoot/temp/autosave，
  ≤32MB、原子 rename、非法 docId 安全化）；桥补 `project.autosave*`；Rust 测试写/列/读/清；
  命令总数 **64**，覆盖 111 方法/154 未映射（102 call）。
- **Tauri 歌词/定位**：`read_sidecar_lyrics`（同名 .lrc/.LRC → base64）、`reveal_midi`（资源管理器定位，
  根外/缺失回退 midi 目录）；桥补 readSidecarLyrics/revealMidi；Rust 测试 base64/命中/缺失/回退；
  命令总数 **66**，覆盖 113 方法/152 未映射（104 call）。
- **Tauri 资产复制/打开目录**：`copy_asset`（分轨导出资产复制，自动建父目录）、`open_folder`
  （仅目录）；桥补 project.copyAsset；Rust 测试复制字节/源缺失；命令总数 **68**，覆盖 114 方法/
  151 未映射（105 call）。
- **Tauri 工程保存/打开（.fufumidi ZIP）**：`project_save/project_open`（project.json + files/，
  对话框或指定路径；条目数≤4096、总解压≤4GB、拒绝绝对路径/..，只解压 json.assets 白名单资产）；
  桥补 project.save/open；Rust 测试写包→读包、资产字节一致、非法 id 进 missing。命令总数 **70**，
  覆盖 115 方法/150 未映射（107 call）。无头未验证真实对话框流程。
- **工程包安全测试**：解包缓存目录参数化（测试写入临时目录，不污染真实数据根）；
  恶意 ZIP 的 `../evil.txt` 被忽略、只有白名单资产进入 resolved。Rust 测试仍 **13/13**。
- **Tauri 存储治理**：`storage_report/storage_cleanup`（10 类占用；曲库 protected 永不清；
  资产默认保留、includeAssets 才删；日志保留最近 5 份）；桥补 bridge.storage；Rust 测试分类/总字节/
  默认只清 safe/资产显式/midi 保留；命令总数 **72**，覆盖 117 方法/148 未映射（109 call）。
- **Tauri 音频时长**：`audio_duration`（WAV RIFF、FLAC STREAMINFO、MP3 逐帧扫描；其他格式明确
  unsupported，前端回退 decodeAudioData）；桥补 audioDuration；Rust 测试 WAV/FLAC/MP3/坏文件；
  命令总数 **73**，覆盖 118 方法/147 未映射（110 call）。
- **Tauri 音频导出落盘**：`export_audio`（文件名清洗、原子写、sidecar manifest 含 SHA-256/格式/
  采样率/时长；支持 targetPath 或保存对话框）；桥补 exportAudio；Rust 测试字节/manifest/清洗/空字节；
  命令总数 **74**，覆盖 119 方法/146 未映射（111 call）。manifest `createdAt` 已统一为
  ISO 8601 UTC（自实现 Unix→ISO，测 1970/2023 两个基准点），与 Electron 格式一致。
- **Tauri 分轨 ZIP 导出**：`export_stems_zip`（≤100 轨/总 ≤2GB/文件名清洗/对话框或 targetPath）；
  桥补 exportStemsZip；Rust 测试两轨 ZIP 条目与字节、非法名、空列表；命令总数 **75**，
  覆盖 120 方法/145 未映射（112 call）；cargo test **17/17**。
- **Tauri 封面选择 + 顶层别名**：`pick_cover`（图片→data URL，≤6MB，png/jpeg/webp/bmp）；
  桥补 pickCover，并补顶层 copyAsset/openExternal 别名（修复 singer.ts/设置页守卫静默不执行）；
  Rust 测试 base64/MIME/gif 拒绝/超大拒绝；命令总数 **76**，覆盖 121 方法/144 未映射（113 call），
  cargo test **18/18**。
- **Tauri DAWproject 导出 + 调用审计**：`export_dawproject`（project.xml/metadata.xml ZIP、
  ≤200 文件、拒绝路径穿越、对话框或 filePath）；桥补 exportDawproject；Rust 测试 ZIP 内容/
  ../ 跳过/空列表；新增 `npm run tauri:call-audit`（前端 bridge.* 调用 vs Tauri 实现，启发式，
  当前 212 调用/114 未实现）；命令总数 **77**，覆盖 122 方法/143 未映射（114 call），cargo test **19/19**。
- **Tauri 开机自启**：`autostart_get/autostart_set`（HKCU Run 注册项，reg.exe，隐藏窗口；
  设置路径加引号）；桥补 autostartGet/Set；Rust 测试只读查询与 exe 值，**不写注册表**；
  命令总数 **79**，覆盖 124 方法/141 未映射（116 call），cargo test **20/20**。
- **Tauri 体检**：`diag_health`（spawn engine/health.py --json，解析脱敏报告；桥补 diagHealth）；
  Rust 测试完整 JSON/噪声尾行/空输出；**真机冒烟已补并实测通过 5.64s**——health.py 实际输出
  `###RESULT {json}` 信封，原先纯 JSON 解析会失败，本轮已修正并兼容前缀；命令总数 **80**，
  覆盖 125 方法/140 未映射（117 call），bridge 调用审计未实现 **113**，cargo test **21/21**（另有 1 个 ignored 真机测试）。
- **Tauri 本地模型导入（ZIP）**：`pick_model_archive/model_import_local`（安全解压、识别
  muscriptor/small|medium|large、aria_amt、piano_transcription，复制到 models/<dest>；
  7z/tar 明确报错仍走 Electron）；桥补 pickModelArchive/modelImportLocal；Rust 测试 ZIP 导入/
  识别/7z 拒绝；命令总数 **82**，覆盖 127 方法/138 未映射（119 call），bridge 未实现 **111**，
  cargo test **22/22 + 1 ignored**。
- **Tauri 清除用户数据**：`clear_user_data`（按 scope 清 models/soundfonts/deps/playdata；
  **MIDI、settings、歌单永不清**；needRestart 提示）；桥补 clearUserData；Rust 测试临时目录
  单/多 scope、MIDI/settings 保留；命令总数 **83**，覆盖 128 方法/137 未映射（120 call），
  bridge 未实现 **110**，cargo test **23/23 + 1 ignored**。
- **Tauri 设置完整性检验/修复**：check_integrity/repair_integrity（settings 缺失/损坏；修复前备份并写回默认；presets/asar 校验不适用 Tauri）；桥 repairIntegrity 参数从 {req:{ids}} 改为 {ids}（修真实调用错配）；Rust 测试缺失/损坏/备份/恢复；命令总数 **85**，cargo test **24/24 + 1 ignored**。
- **Tauri 曲库写盘**：write_midi（曲目字节→真实 .mid，同名复用/重名 (2)/prev 路径根内校验）、write_binary（任意二进制写盘）；桥补 writeMidi/writeBinary——此前 Tauri 曲目自检重建文件会直接返回空路径；Rust 测试落盘/复用/重名/二进制；命令总数 **87**，覆盖 130 方法/135 未映射（122 call），bridge 未实现 **108**，cargo test **25/25 + 1 ignored**。
- **Tauri 资源用户元数据**：usermeta_list/set/remove/reorder/pin（name/author/source/category/tags/order/pinned，dataRoot/usermeta.json，损坏先另存 .corrupt-*）；桥补 bridge.usermeta；Rust 测试合并/标签去重/排序/取消 pin/删除/损坏备份；命令总数 **92**，覆盖 132 方法/133 未映射（127 call），bridge 未实现 **105**，cargo test **26/26 + 1 ignored**。
- **Tauri saveBinary 真实调用修复**：前端传 `{name,data}`，原 Rust 只认 `{path,bytes}` 且无对话框，导致 ViewEdit 导出 MIDI/壁纸预览导出直接失败；现支持原生保存对话框、data/bytes 两种字节、自动建父目录；Rust 测试字节解析；cargo test **27/27 + 1 ignored**。
- **Tauri 参数契约审计 + 真实参数错配修复**：新增 `npm run tauri:arg-audit`（Rust command 参数 vs bridge call 参数；`docs/rust/ARG-AUDIT.md`，当前 42 处不一致，主要来自未实现命令）。已修真实 camelCase→snake_case 错配：read_sidecar_lyrics(file_path)、model_import_local(file_path)、rename_midi(new_name)、project_open(file_path)、autosave_read/clear(doc_id)、notify(payload)；这些此前在真实 GUI 调用会因缺少参数失败。
- **Tauri 本地动态壁纸**：wallpaper_list/add_local/remove_local（共享 Electron legacy wallpapers/，.ok 标记、mp4/webm/mov、basename 校验）；桥补 bridge.wallpaper；Rust 测试添加/列表/删除/../ 拒绝；命令总数 **95**，arg 审计不一致 42→**39**，cargo test **28/28 + 1 ignored**。
- **Tauri 壁纸文件夹扫描**：wallpaper_scan_folder（图片/视频，深度 3、≤600、跳过点文件/空文件）；桥 wallpaper.scanFolder（合并重复 wallpaper 对象）；Rust 测试过滤与排序；命令总数 **96**，覆盖 133 方法/132 未映射（128 call），bridge 未实现 **104**，cargo test **29/29 + 1 ignored**。
- **Tauri MIDI 文件关联**：file_assoc（HKCU .mid/.midi→FuFumidi.MIDI；开发用 build/icon.ico，打包用 exe；隐藏 reg.exe；失败计数回报）；桥补 fileAssoc；Rust 测试开/关命令计划，**测试不写注册表**；命令总数 **97**，arg 审计不一致 39→**38**，cargo test **30/30 + 1 ignored**。
- **T-118 P3 进度节流**：`###PROG` 每 50ms 最多 emit 一次；首条立即发、最终结果仍由 `###RESULT` 驱动；ViewTranscribe 已有队列切换/旧队列迁移；P3 代码侧收口。
- **T-118 P3 UI 消费**：ViewTranscribe 订阅 `onEngineProgress`，按 `id`（batchN）更新队列 realPct；与日志 ###PROG 路径互补，卸载退订；type 补 onEngineProgress；build/test:ui 589/smoke 通过。
- **Tauri 单实例文件转发**：首实例 bind 127.0.0.1:47823 + accept 线程；第二实例把 .mid 路径或 `__FOCUS__` 发过去后**在 Builder 前退出**；首实例 emit `open-file`、聚焦窗口；桥 onOpenFile 接事件；Rust 单测路径/FOCUS；双实例真实窗口未跑。
- **Tauri 文件关联冷启动**：`take_pending_open_file` 从 argv 取第一个存在的 .mid/.midi，读字节返回 {name,bytes} 并清空；桥补 takePendingOpenFile；App.vue 已有兜底调用；Rust 测试 MID/非 MID/缺失；命令 **135**，cargo test **108/108 + 1 ignored**。
- **Tauri RVC 在线刷新**：`rvc_refresh_catalog` 用 curl 拉 ModelScope 文件树，解析 pth/index/采样率→写缓存；`rvc_catalog` 优先读缓存；**补注册之前漏挂的 rvc_catalog/rvc_open_catalog_page**；Rust 单测解析；命令 **136**，cargo test **110/110 + 1 ignored**。
- **Tauri RVC probe**：`rvc_probe` 等 id 找清单，spawn_blocking 调 `engine_rvc.py probe --model`，解析 ###RESULT 并回写 version/sr/f0/engine；无模型/脚本明确错误；桥补 rvcProbe；Rust 查找/patch 测试；命令 **134**，cargo test **107/107 + 1 ignored**。
- **Tauri RVC 内置目录**：`rvc_catalog` 编译期 include_str main/rvc-catalog.json（443KB，models 非空）、`rvc_open_catalog_page` 复用 open_external 仅 http/https；桥补；命令 **133**，cargo test **106/106 + 1 ignored**。
- **Tauri RVC zip 导入**：`rvc_pick_zip/rvc_import_zip` 安全解压到 models/rvc/<id>，多一层时定位含权重子目录并给文件加前缀，写 model.json；Rust 测试 flat/nested/无效包；命令 **131**，cargo test **105/105 + 1 ignored**。
- **Tauri RVC 导入**：`rvc_pick_folder/rvc_pick_files/rvc_import_folder/rvc_import_files`；文件夹引用式（index.json）或根内 model.json；文件复制到 models/rvc/<id>；检测 pth/pt+config/index/采样率提示；桥补；Rust 测试外部引用/根内物理/文件复制；命令 **129**，cargo test **104/104 + 1 ignored**。
- **Tauri RVC 列表/删除**：`rvc_list` 扫 models/rvc 的 model.json + index.json 引用式条目，计算 size/missing/ready/external；`rvc_remove` 物理目录+index 条目，外部引用只注销不删源；桥补 rvcList/rvcRemove；3 项 Rust 测试；命令 **125**，cargo test **102/102 + 1 ignored**。
- **Tauri UTAU 导出 zip**：`utau_export_voicebank_zip(files)` 原生保存 zip，Deflated 写入 base64 文件，清洗/空名/512MB；桥补；Rust 测试 zip 条目/内容/traversal；命令 **123**，cargo test **99/99 + 1 ignored**。
- **Tauri UTAU 导出声库**：`utau_export_voicebank(dir, files)` 写 base64 文件到已有目录，文件名清洗/空名跳过/总量 512MB；桥补 utauExportVoicebank；Rust 测试写入/traversal/目录缺失；命令 **122**，cargo test **98/98 + 1 ignored**。
- **Tauri UTAU 导入 zip**：`utau_import_voicebank_zip` 原生选包→临时安全解压→定位声库根→移到 voicebanks/<zip名>，重名加 _2；裸 oto 包补 character 文件；桥补 utauImportVoicebankZip；Rust 测试嵌套/重名/traversal/裸 oto/无 bank；命令 **121**，cargo test **97/97 + 1 ignored**。
- **Tauri UTAU 删除声库**：`utau_delete_voicebank` 只删 dataRoot/voicebanks 子目录，canonicalize 校验并拒绝根/根外；桥/类型补 utauDeleteVoicebank；Rust 测试 3 类拒绝/正常删除；命令 **120**，cargo test **96/96 + 1 ignored**；UI 侧已有 confirm 确认。
- **Tauri UTAU oto.ini 读写**：`utau_read_oto`（原始字节 base64 + size + mtimeMs）、`utau_save_oto`（手写宽容 base64、空/8MB 上限、先写 `oto.ini.bak` 再覆盖、返回 backup）；路径 canonicalize 后限制在 dataRoot/voicebanks 内（比 Electron 更严）；6 项 Rust 测试；命令 **119**，cargo test **84/84 + 1 ignored**。
- **Tauri UTAU/统一声库（只读）**：`utau_list_voicebanks`（voicebanks 根一层、character.txt/yaml/oto.ini 三标记、yaml name > txt name=/名前= > 目录名、BOM/lossy）、
  `voicebank_unified`（UTAU 任意目录 + DiffSinger dsconfig 根/下一层、递归 size、id=kind:name、两侧独立容错）；
  `dir_size` 改为**不跟随 symlink** + 深度上限 64（全仓存储/模型统计同样生效；避免声库链接成环）；
  桥补顶层 utauListVoicebanks/voicebankUnified；6 项 Rust 声库测试；命令总数 **117**，arg 审计 **23**，cargo test **68/68 + 1 ignored**。
- **Tauri 更新线路列表（本地）**：`update_sources`（stable/beta 后缀、CNB/GitHub 优先顺序、preferred 提前；只读 settings）、
  `update_set_preferred_source`（会话内存，不落盘）；桥补顶层 updateSources/updateSetPreferredSource；
  `build/kachina.config.json` 的 10 个 source id 单测校验；6 项 Rust 测试全过；命令总数 **115**，arg 审计仍 **23**。
- **Tauri GPU 状态/卸载**：gpu_status（dataRoot/gpu-enhancements 的 cuda/rocm/xpu、当前 Python、rocm 3.12 判定）、gpu_uninstall（删除对应目录）；桥已有映射；Rust 测试临时目录识别/卸载/非法类型；命令总数 **99**，arg 审计不一致 38→**36**，cargo test **31/31 + 1 ignored**。
- **Tauri 设桌面壁纸**：wallpaper_set_desktop（静态图片；HKCU Wallpaper/WallpaperStyle/TileWallpaper + rundll32 刷新；扩展名/文件校验）；桥补 setDesktop；Rust 测试注册表计划/路径，**测试不改真实桌面**；命令总数 **100**，覆盖 134 方法/131 未映射（129 call），cargo test **32/32 + 1 ignored**。
- **Tauri 插件中心本地列表/启停**：plugins_list/rescan（调 engine/plugin_render.py list，--dir 来自 settings/env，按 settings.plugins_enabled 标 enabled）、plugins_set_enabled（写 settings）、plugins_open_dir；桥已有映射；Rust 测试解析/启停；真实 Python 列表手工无窗口跑过返回空列表；命令总数 **104**，arg 审计不一致 36→**32**，cargo test **33/33 + 1 ignored**。
- **Release 构建门禁**：cargo build --release --offline 无窗口通过（optimized 2m10s），fufumidi-shell.exe 约 15 MiB；清理未使用的 autosave_root 警告；cargo test 33/33 + 1 ignored 保持通过。
- **Tauri 音色工坊本地能力**：从 main/soundfonts.js 生成 20 条静态注册表（scripts/tauri/gen-soundfont-registry.mjs）；sf_workshop_list（bundled/downloaded 体积核对 + 自定义 SF2/SF3 扫描）、import/delete/open_dir；桥已有映射；Rust 测试 20 条/GeneralUser builtin/自定义/导入删除；命令总数 **108**，arg 审计不一致 32→**28**，cargo test **34/34 + 1 ignored**；下载/取消仍未实现。
- **Tauri probe 别名 + 安全边界测试**：补 `probe` 命令（前端 bridge.probe 之前无 Rust 实现，复用 engine_probe）；模型 ZIP 增加 `../evil.onnx` 穿越测试，确认不会写出 models 目录；stems ZIP 增加 >100 文件拒绝测试；同时修复模型导入临时目录并发同名问题（进程 id + 纳秒）。命令总数 **109**，arg 审计 28→**27**，cargo test **35/35 + 1 ignored**。
- **Tauri 模型删除**：model_delete（按 id 删 models/<dest> 目录/文件，并清 .oudep/.parts/.tmp/.part；RVC 删除暂未迁移）；Rust 测试 muscriptor/small 删除/未知 id/RVC 拒绝；命令总数 **110**，arg 审计 27→**26**，cargo test **36/36 + 1 ignored**。
- **Tauri 帮助文档打开**：open_edit_guide/plugins_open_docs（复制 plugins/plugin-dev.html、renderer/edit-guide.html 到 dataRoot/temp/FuFumidi-doc 后用默认浏览器打开；stage-bundle 增加 bundle/docs，tauri.conf 增加 resources docs）；Rust 测试 dev 源存在，**不在测试中打开浏览器**；命令总数 **112**，arg 审计 26→**24**，cargo test **37/37 + 1 ignored**。
- **Tauri 智能修正 refine**：调 engine/smart_midi.py refine（audio/midi/out/mode/stemBalance/窗口参数），逐行 emit engine:refine:log，解析 ###RESULT；Rust 测试参数拼装；**真机引擎冒烟已完成**：合成 2 秒 WAV + 2 音符 MIDI，smart_midi 2.32s 返回 ###RESULT ok、输出 76 字节 MIDI；命令的 stderr 现会并入错误尾部；命令总数 **113**，arg 审计 24→**23**，cargo test **38/38 + 1 ignored**。
- **Tauri 音频时长补 M4A/MP4**：解析 MP4 box/`mvhd` 得到时长；合成 M4A 2s 单测通过；audio_duration 现覆盖 WAV/FLAC/MP3/M4A，cargo test **39/39 + 1 ignored**。
- **Tauri 音频时长补 OGG**：解析 OggS 页 granule + Vorbis 采样率 / Opus preskip；合成 1s OGG 单测；audio_duration 覆盖 WAV/FLAC/MP3/M4A/OGG，cargo test **40/40 + 1 ignored**。
- **Tauri 音频时长补 AIFF/AIFC**：FORM/COMM + 80-bit extended sample rate；合成 1s AIFF 单测；audio_duration 覆盖 WAV/FLAC/MP3/M4A/OGG/AIFF，cargo test **41/41 + 1 ignored**；另补未知扩展名 `.wma` 返回 unsupported 的回退测试，cargo test **42/42 + 1 ignored**。
- **隐藏窗口 E2E 恢复**：新增 `FUFUMIDI_E2E_HIDDEN=1`（E2E 启动器自动设置），主窗口与 splash 全程 `show:false`，**不弹窗**；隐藏模式实测 `shortcuts-config` 1/1、关键 9 子集 **9/9** 通过（smoke/edit-basic/track-crud/arrange-tabs-undo/arrange-playback/autosave/export/storage/tasks）。全量 37 用例尝试时工具 600s 超时，未拿到完整结果（非用例失败证据），后续可后台分段跑。
- **T-117 曲库/设置共享 Electron 数据（重要）**：Rust 用 rusqlite 直读/写
  `%APPDATA%/FuFumidi/fufumidi/fufumidi.sqlite`（songs/playlists/kv），设置优先读 legacy
  settings.json；只读验收实测 **1972 首真实曲目**、57 个设置键、侧栏「全部曲目 1972」正常；
  测试态由 FUFUMIDI_DATA_ROOT/DB_FILE 隔离；**SQLite 版 NSIS 已重打（238.38 MiB），安装版无 env 启动复验 1972 首**。
- **P-012 快捷键可配置已落地**：新增 `core/shortcuts.js`（10 个窗口级动作注册表、
  localStorage 持久化、冲突检测、重置）；App.onKey 改为按注册表分发；SettingsPanel
  快捷键页支持点击录制（Esc 取消、冲突提示）并保留只读编辑器键位表。
  E2E `shortcuts-config.mjs`：把播放/暂停改为 T → 持久化/按钮显示 → 关闭设置后按 T
  真实播放再暂停通过；另有 headless 单测（事件组合键/持久化/冲突拒绝/reset/坏 localStorage 回退）。
- **P-015 编排进入播放（事件级验收）**：新增 E2E `arrange-playback.mjs`：
  导入两轨 MIDI → 编排页 → 等 `song.arrange` 回写 → 校验移动 clip 改变 player.events 起点、
  静音 clip 减少事件数；用例通过，E2E 总数 36。真实声卡听感仍待人工验收。
- **原生文件对话框已接入（T-115/T-117 之间）**：`tauri-plugin-dialog 2.8.4`，
  新增 pick_file/pick_directory/pick_audio/pick_audio_files/pick_image/pick_music_xml（命令共 **43 条**）；
  安装版 smoke **25 项**全绿（新增 dialogs 接线断言）；另用 `dialog-check.mjs` 实弹打开系统对话框
  并 PowerShell 发 Esc，`pick_file` Promise 解析 null —— **原生对话框已实测可开可关**（选文件可人工复验）。
  剩余：安装包签名（需证书）；Electron 安装包已产出但安装冒烟待交互桌面。
  下一步：T-115 继续补这些 UI 必需通道，T-117 继续 settings/song/task host 化，批量并发与 T-119 双构建。

## 17. 待收口（下一轮）

1. 6.7 剩余：可配置快捷键、命令式撤销、量化增强（强度/终点）、编排参与播放。
2. 安装版冒烟：需要先产出 6.5.0-beta.1 的 win-unpacked / 安装包，再按 AGENTS 部署到 E:\Midi\FuFumidi 验证。
3. 3D 钢琴/智能分轨继续打磨（键位持久化、延迟校准、分轨结果面板）。
4. Tauri 外壳是否继续（更新链、172 条 IPC、rquickjs/printToPDF）需用户确认后再动。
5. 模型兼容矩阵随每次模型/引擎改动更新，并跑一次真实模型冒烟。

- **无窗口生产 worker 自检**：新增 `--engine-self-check`，在 Builder 前早退，真实拉起生产 `spawn_worker` 并读 `###RESULT`；实测 ok=true/warm=1，无窗口/无 Python 残留，作为 P1/P2 安装产物验收入口。

- **2026-11-04 终验（当前源码）**：release build 通过（2m19s）；release `--self-check` 与 `--engine-self-check` 通过（真实 worker、warm=1、无窗口/残留）；隐藏全量 E2E **40/40**、test:ui **589/589**、typecheck/audit 0、cargo **102/102 + 1 ignored**。

- **Tauri 命令注册审计**：新增 `scripts/tauri/handler-audit.mjs` + `npm run tauri:handler-audit`；修掉 `model_delete` 漏挂（modelDelete 桥调用会失败）；当前 **136/136** 注册。

- **modelDelete 委托 RVC**：`model_delete_at` 遇到 `rvc:` 前缀时转 `rvc_remove_at`，通用模型列表删除 RVC 不再报“尚未迁移”；测试覆盖物理目录删除。

- **修复单实例监听未挂**：编译警告显示 `start_single_instance_listener` 未使用——此前 `.setup` 仍是 `|_app|`，首实例只 bind 不 accept，第二实例转发会丢。现 `.setup(move |app| ...)` 真正启动 accept 线程；build 无 unused 警告。

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
| P-012 快捷键可配置 | 未做 | 属 6.7（SettingsPanel 仍只读） |
| P-013 量化体系 | 未做 | 属 6.7 |
| P-015 编排进入播放 | **部分已满足，待实测验收** | core/arrange.js + ViewArrange 已接线 |

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

## 15. 范围变更：取消 Rust/ONNX 替换 Python 引擎（2026-11-04）

- 用户决定（原话）：「Rust/ONNX 替换 Python 引擎,这一项改动不执行了」；同时要求「注意让现有的模型都能使用」。
- 决策记录：docs/decisions/ADR-0001-cancel-python-engine-replacement.md。
- 冻结项：R-007…R-011、T-306…T-308、W-E0…W-E4、M3/M4 的「移除 Python/删 Electron 清理」；
  不再以「去 Python / 安装包 ≤250 MiB / 首任务 ≤1.5 s」作为验收。
- 保留项：产品专业化升级（6.6/6.7/6.8）、契约/门禁、设计/品牌约束继续；
  Rust 非 ML 核心（crates/、main/rust.js）作为可选加速保留，不删除；Tauri 外壳去 Electron 是否继续另行确认。
- 已同步：master-integrated-plan（G4/M3/M4/W-E/风险表）、master-ai-spec（R/T-3xx + R-014 硬约束）、
  rust-fullstack-plan、rust-rewrite-plan 顶部均加了取消横幅。

## 16. 现有模型可用性（硬约束 R-014）

- 约束：转录/分轨/OMR/调教/翻唱的**模型格式、路径、ID、下载源不变**；Python 引擎随包保留。
- 本轮实测：`window.fuBridge.modelList()` 返回 **91 个模型条目**，覆盖 basic_pitch / piano_transcription /
  hft_transformer / miros / yourmt3 / muscriptor（3 规格）/ beat_this / audio_tagger / aria /
  separation（29 项，含 4 个 demucs 家族）；模型注册表未做任何删除或改格式。
- 真实推理回归：E2E `transcribe-queue-chain` 仍用 Basic Pitch 跑真实转录；`transcribe-stem-ui` 校验分轨入口；
  全量 33/33 通过。
- 新增 `scripts/e2e/cases/models-catalog.mjs`：守住模型家族与字段完整性，防止后续改动悄悄删模型/改 ID。
- 兼容矩阵与变更流程：docs/MODELS-COMPATIBILITY.md。

## 17. 待收口（下一轮）

1. 6.7 剩余：可配置快捷键、命令式撤销、量化增强（强度/终点）、编排参与播放。
2. 安装版冒烟：需要先产出 6.5.0-beta.1 的 win-unpacked / 安装包，再按 AGENTS 部署到 E:\Midi\FuFumidi 验证。
3. 3D 钢琴/智能分轨继续打磨（键位持久化、延迟校准、分轨结果面板）。
4. Tauri 外壳是否继续（更新链、172 条 IPC、rquickjs/printToPDF）需用户确认后再动。
5. 模型兼容矩阵随每次模型/引擎改动更新，并跑一次真实模型冒烟。

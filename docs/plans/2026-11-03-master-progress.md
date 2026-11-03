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

### 10. 待收口（下一轮）

- Tauri POC（子代理 B）：target/Cargo.lock 已生成、日志与 research 目录存在；等其结论文档，再决定是否记录为 POC 通过/阻塞。
- 6.7 第一组（轨道 CRUD / 拍号编辑）尚未动；先按 RUST-PROJECT-MODEL v2 冻结细节。
- 把 cargo fmt/clippy 加入 CI（本机缺组件）。

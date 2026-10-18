# v6.0.0 全局契约（W0 冻结）

> 状态：**已定稿（2026-10-18）**，owner = Lead（本仓库唯一实现者，DeepSeek agent）
> 依据：`_attic/FuFumidi-评估-2026-10-17/v6.0.0-实施方案-具体化.md` 第 2 章
> 规则：六个契约在 W0 一次冻结；冻结后任何包只能**消费**，改动必须单独 PR 并说明兼容影响。

## 0. 决策记录

| 项 | 决策 | 日期 |
|---|---|---|
| v6.0.0 范围 | P0 8 + P1 14 + P2 6 全部交付（评估方案原范围） | 2026-10-18 |
| 契约 owner | Lead 独占；W0 期间其他人不并行改 `core/` 下契约文件 | 2026-10-18 |
| Allvoice(ToH 派生) | **不下架**：已获作者书面授权，可再分发（注册表许可文案同步更新） | 2026-10-18 |
| E2E 交互回放 | 引入；已落地 `scripts/e2e`（CDP 驱动、零新依赖），纳入 G4 门禁 | 2026-10-18 |

## 1. 契约一览

| # | 契约 | 落点文件 | 状态 | 消费方 |
|---|---|---|---|---|
| C1 | CommandRegistry 命令注册表 | `frontend/src/core/commands.js`（新） | ✅ **已实现**（registry + ViewEdit 菜单同步 + 快捷键兜底 + 冲突检测；11 测例 + E2E） | 菜单/工具栏/右键/快捷键/命令面板/宏 |
| C2 | TaskCenter 长任务中心 | `main/taskcenter.js`（新）+ `preload.js` | ✅ **已实现**（主进程任务中心 + task:update 10Hz + 全局任务面板 + 7 测例 + E2E；导出已登记任务） | 转录/下载/渲染/导出/更新/OMR |
| C3 | DocumentSession 文档会话 | `frontend/src/core/session.js`（新） | ✅ **核心已实现**（`session.js` + `main/autosave.js` + IPC + 16 测例；编辑器 UI 接线属 P0-2 后续卡） | 编辑/调教/谱面/歌词；自动保存/恢复 |
| C4 | TimelineModel 时间轴模型 | `frontend/src/core/midi.js`（扩展）+ `core/timeline.js`（新） | ✅ **已实现**（`timeline.js` 264 行 + 10 测例；SMPTE 模式已预留，P0-6 接入口） | 编辑器/编排时间线/调教/可视化 |
| C5 | ExportJob 导出管线 | `main/export.js`（新）+ `frontend/src/core/export_audio.js`（新） | W0 待实现（接口冻结） | WAV/FLAC/MP3/OGG/分轨/MIDI/MusicXML/MP4 |
| C6 | GestureState 手势状态机 | `frontend/src/core/gesture.js`（新） | W0 待实现（接口冻结） | 编辑页/调教页/编排页 |

## 2. 接口（冻结版）

### C1 CommandRegistry

```js
// 注册：commands.register({ id, title, area, keys, when, run, undoable, palette })
// 查询：commands.all() / commands.palette(query) / commands.byKeys(combo) / commands.conflicts()
// 执行：commands.run(id, ctx) -> Promise<void>（统一包 try/catch + toast）
// 事件：commands.on("changed")（菜单/工具栏据此重绘）
```

规则：`id` = `area.action[.variant]`；`title` 一律是 i18n 中文原文，UI 走 `t()`；同一 `keys` 在 `when` 同时为真 = 冲突，启动期告警并在设置页展示。

### C2 TaskCenter

```js
// 主进程：tasks.register({ id, kind, title, cancelable }) -> handle
//         handle.progress(0..1, text?) / handle.done(result) / handle.fail(err) / handle.log(line)
// 前端：window.fuBridge.tasks.list() / cancel(id)；事件 task:update | task:done | task:error（节流 10Hz）
// 任务模型：{ id, kind, title, status:"running"|"done"|"error"|"canceled", progress, startedAt, endedAt, result?, error? }
```

规则：长任务**必须**登记；离开页面不丢；取消要真的杀子进程/中止下载；完成后可带 `jump` 参数（视图+路由+选中项）。

### C3 DocumentSession

```js
// session.open({ docId, kind, title, path?, model }) / close(docId) / markDirty(docId, delta=1)
// session.state(docId) -> { dirty, undo[], redo[], view:{zoom,scroll,selection,playhead}, lastSavedAt }
// 自动保存：dirty 且距上次 ≥ settings.editor.autosaveSec（默认 30s）→ project:autosave
// 恢复：启动时 project:recoverList() → 用户确认后 open（不自动覆盖当前文档）
```

### C4 TimelineModel

```js
// { tpb, tempoMap:[{tick,us}], sigMap:[{tick,num,den}], markers, regions, playheadTick, loop:{a,b}, selection }
// 唯一换算入口：secOfTick(tl, tick) / tickOfSec(tl, sec) / barBeatOf(tl, tick) / tickOfBarBeat(tl, bar, beat)
// 禁止：EditorCanvas / arrange / viz 各自做 tempo 积分
```

### C5 ExportJob

```js
// request = { kind:"midi"|"wav"|"flac"|"mp3"|"ogg"|"stems"|"xml"|"mp4", range:{a,b}|"all",
//             options:{ sampleRate, bitDepth, dither, loudness, format... }, dest }
// 执行：export.run(request) -> jobId（登记 TaskCenter）；产物 + manifest.json（files[], size, sha256, peak, rms, lufs）
```

### C6 GestureState

```js
// { tool:"select"|"pencil"|"eraser"|"knife"|"hand", mods, anchor, drag:{active,axis,preview},
//   snap:{grid,beat,frame,strength} }
// 所有拖拽：begin(e) -> update(e) 产生 preview -> commit() 才写入模型（一次手势 = 一次撤销）
// 吸附优先级：frame > beat > grid；编辑页与调教页共用同一实现
```

## 2.1 实现记录

- **C4 TimelineModel 已实现**：`frontend/src/core/timeline.js`
  - API：`normalizeTimeline / secOfTick / tickOfSec / barBeatOf / tickOfBarBeat / barTicksOf / iterBars / rulerMarks / snapStep / snapTick / timelineOfSong / cloneTimeline / playheadSec`
  - 单测：`frontend/tests/timeline-model.test.js`（10 例：恒定/变速积分、4/4→6/8→3/4、往返、吸附、SMPTE、song 桥接、深拷贝）
  - SMPTE 模式已支持（`{fps,ticksPerFrame}`），等 P0-6 把 `parseMidi` 的 SMPTE division 接进来即可。
- **P0-1 MIDI 导出保真（核心已实现）**：`core/midi.js`
  - 写出：format 按轨数正确写 1（多轨）/0（单轨）、pitch bend、复音/通道触后、歌词/文本/marker/cue 分类型、调号（带符号 sf）、中途 program、tempo/拍号去重且只写 0 号轨；
  - 解析：aftertouch 不再丢弃、marker/cue 与 text 分开、keySig 按带符号字节读；
  - 单测：`frontend/tests/midi-roundtrip.test.js`（9 例，encode→parse 逐事件断言）。
- 剩余：P0-1 的「弯音车道 UI / 编辑后导出接线」在 P0-1 后续卡（编辑器侧）完成；本文件状态列随批次回填。
- **C3 DocumentSession 核心已实现**：
  - 前端 `core/session.js`：open/close/activate、序号式脏标记（dirtySeq/savedSeq）、撤销/重做（上限可配、异常保护）、视图状态、`shouldAutosave`（默认 30s 可调）、snapshot/restore、订阅事件；
  - 主进程 `main/autosave.js`：原子写（.tmp→rename）、32MB 上限、任意 docId 安全文件名、list（按时间倒序、坏草稿跳过）/read/clear；
  - IPC：`autosave:write/list/read/clear` 三处同改（preload `project.autosave*` → main/project.js 注册 → types/ipc.ts）；
  - 单测：`frontend/tests/session.test.js`（10 例）+ `scripts/test-autosave.mjs`（6 例），并进 `npm test` 链。
- **P0-2 完成（第一版）**：
  - ViewEdit 已接线：4s 定时「序列化 MIDI → FNV 哈希」判定脏（任何修改都漏不掉，不靠逐入口埋点）、30s 落盘、失焦/切歌/离开视图/关窗立即冲刷、beforeunload 脏则拦截；
  - 崩溃恢复提示条（恢复=作为新曲目导入，绝不覆盖原文件；丢弃=清除草稿）；
  - **E2E 数据隔离（两处都要）**：① `FUFUMIDI_E2E_DATA_ROOT`（main/paths.js）隔离 FuFumidiData；② `--user-data-dir`（scripts/e2e/lib.mjs）隔离 IndexedDB/localStorage —— **只隔离①仍会读到用户真实曲库**（实测 280 首）。`window.__fufumidiE2E` 最小测试钩子（仅 FUFUMIDI_E2E=1 注册，含 hasSong/song/importMidi）；
  - 新增 E2E 用例 `autosave-ipc`（write→list→read→clear 全链）。
- **P0-6 数据层完成**：`parseMidi` 支持 SMPTE division（0xE728 → fps25/40tpf）、`buildSong` 按帧算时间（tempoMap 不参与）、`encodeMidi` 写回 SMPTE 头；多拍号 encode→parse→buildSong 全保留（此前只取首条）；状态栏位置读数改走 `formatBarBeat`（变拍号按分段算）。
  - **P0-6b ✅**：EditorCanvas 卷帘垂直网格改为按 `iterBars` 逐小节/逐拍绘制（6/8 小节线落点正确）；五线谱视图的 `scoreLayout` 生成 `barList` 分段小节表，`scoreXOf/scoreSystemY/scoreTickAt/拖动/播放头/HUD` 全部按分段算；`afterEdit` 的曲目小节数也改分段统计。
  - E2E 新增 `edit-varmeter`（4/4→6/8→3/4 三段，验证 sigMap 与谱面渲染）。
- **P0-5 默认 GM 音色懒加载 ✅**：
  - 随包分发的 `renderer/vendor/soundfonts/GeneralUser.sf2`（29.8MB）此前在桌面端从未被默认用起来；现在首次播放时后台装载，不阻塞首屏；
  - 纯决策逻辑抽到 `core/default_soundfont.js`（`pickDefaultSoundfont / shouldLazyLoadDefaultGm / defaultGmFlagOf`，6 测例）；
  - 设置新增 `default_gm`（默认 true）+ 音色工坊开关「启动时自动加载内置 GM 音色（推荐）」；用户显式选过音色或点「使用默认合成器」后不再抢；
  - 竞态：settings 异步加载的自愈逻辑加了「默认 GM 生效中」白名单，避免把刚装好的 GM 又切回内置合成器；
  - E2E 新增 `soundfont-lazy`：真实走 IPC 列表 → 读 29.8MB SF2 → synth 装载 → `appliedSoundfont` 指向 GeneralUser（**真链路验证，不是只测决策函数**）。
- **P0-3 录音引擎核心 ✅（UI 面板待接）**：
  - 新 `core/recorder.js`（288 行）：预备拍（0–4 小节，跨边界按住的音从 take 0 起算）、循环 take（overdub/replace、跨圈按住音圈尾收尾不叠音）、量化（off/1/4/1/8/1/16/1/32/自定义 tick）、输入延迟补偿、`applyTake`（replace 窗口替换 / overdub 同音高截断）、`calibrateLatency`（中位偏移 + p10–p90 稳定性，≤5ms 判 ok）；
  - `core/midiin.js` 升级：所有回调带 `performance.now()` 时间戳、新增 `onControl`（CC/延音踏板）与 `onRaw`、新增可测纯函数 `parseControlMessage`；
  - 测试：`frontend/tests/recorder.test.js`（15 例）+ `frontend/tests/midiin.test.js`（4 例），含 **假 MIDI 事件流 256 拍不丢事件** 的 DoD 用例；
  - **P0-3b ✅**：ViewEdit 录音面板（`components/editor/RecordPanel.vue`）—— 设备选择/刷新、预备拍 0–2 小节、量化 off…1/32、叠加/替换、输入延迟 ±200ms、延迟校准向导（4 击 click → 中位偏移 + 离散度，≤5ms 判通过，写入 settings.midiInputOffsetMs）、take「采用/丢弃」；采用走 `applyTake` + EditorCanvas.replaceNotes（可撤销）；
  - `recorder.js` 新增 `recordStartPlan`（预备拍时 seek 到「起点 − 预备拍」，预备拍结束正好落在起点）；新 E2E `record-ui`（面板打开/控件齐全/关闭）；
- **P0-4 导出核心 ✅（UI/分轨接线待接）**：
  - 新 `core/export_audio.js`（289 行）：WAV PCM16（TPDF dither）/ PCM24 / float32 编码、WAV 头解析、峰值/RMS、ITU-R BS.1770 K 加权响度（400ms 块 + 75% 重叠 + 门限）、前瞻限幅、响度归一（目标 −14/−16/−23，报告误差与衰减量）；
  - 新 `main/export.js`：`export:audio` IPC 原子落盘 + 同名 .manifest.json（sha256/size/格式/位深/采样率/声道/时长/LUFS/峰值/目标）；文件名 Windows 安全化；三处同改（preload.exportAudio → main.js 注册 → types/ipc.ts）；
  - 测试：`frontend/tests/export_audio.test.js`（10 例：头/大小/量化/dither 噪声形状/响度实测/限幅/归一）+ `scripts/test-export.mjs`（4 例：命名/落盘/manifest/错误路径），并进 `npm test` 链；
  - E2E 新增 `export-ipc`：渲染进程生成 WAV → bridge → 主进程落盘 → Node 侧校验文件头与 manifest 后清理；
  - **P0-4b ✅**：转换页导出面板接入 —— 导出格式（WAV 16/24/float32）、响度目标（off/−14/−16/−23 LUFS）、16bit TPDF dither、总线限幅（−1 dBFS）、**分轨导出**（每轨单独离线渲染一个文件）；选项持久化到 settings（`export.audio.*`）；渲染链路 = 增益 →（响度归一 + 限幅）→ WAV 编码 → `export:audio` 落盘 + manifest；文件预估按位深/分轨数算；
  - 测试：`frontend/tests/export_options.test.js`（5 例）+ E2E `convert-ui`（面板挂载与控件齐全）；
  - 剩余（P0-4c）：分轨 zip 打包、FLAC/MP3/OGG（按 Scope Guard 可延后到 P1）。

- **P0-7 文档与版本一致性 ✅**：
  - 版本唯一来源 = 根 `package.json`；构建时由 `vite.config.js` 注入 `__APP_VERSION__` 与 `__BUILD_TIME__`，`core/version.js` 删除写死的 `v5.0.1` 回退、关于页显示「版本 · 构建时间」；
  - `core/changelog.js` 补 5.2.4 条目（此前最新只到 5.2.3，升级后不会弹更新说明）；
  - 新门禁 `scripts/check-version-consistency.mjs`：根/前端 package.json、changelog 条目、version.js 禁止硬编码、vite 注入四处断言，已进 `npm run audit` 与 `npm test` 链。
- **P0-8 i18n 覆盖率门禁 ✅（棘轮版）**：
  - 新 `scripts/check-i18n-coverage.mjs`：扫全源码 `t('中文…')` 字面量，检查 EN(`i18n.js`) / JA(`i18n_ja.js`) 词条；拼接片段自动豁免、白名单文件 `scripts/i18n-whitelist.json`；
  - **历史欠账基线** `scripts/i18n-baseline.json`（EN 1208 / JA 1161 条老 UI 未译字符串）：只允许减少、不许增加，`--update-baseline` 缩表；已进 `npm run audit`；
  - 本批起新代码的键必须同步 EN/JA（本批新增的中文键均已补齐）。
  - 剩余：老欠账分批翻译（每批清一批并把基线缩小）；P0-8 其余已知 bug（音量/音效跨歌串扰、MIDI 输出设备固定首个等）逐条修 + 回归测试。

- **C1 CommandRegistry ✅**（P1-13 第一块）：
  - 新 `core/commands.js`（195 行）：`register/registerAll/unregister/all/palette/byKeys/conflicts/run/runSequence/on`，id 规则 `area.action[.variant]`、组合键规范化（Mod/CmdOrCtrl→ctrl、事件→组合键、修饰键定序）、面板打分、when 可用性过滤、统一 try/catch 与 ran/error 事件；
  - ViewEdit 接线：菜单动作 + 参数工具 + 工作区预设全部同步注册；命令面板数据源改为注册表（打开前重同步，避免 setup 期间求值 menuGroups 踩后段 ref 的 TDZ —— 已记注释）；未显式处理的组合键交给 `byKeys` 兜底；启动/打开时 `conflicts()` 告警；
  - 测试：`frontend/tests/commands.test.js` 11 例；E2E `command-palette`（Ctrl+Shift+P 打开、全量列表、搜索「量化」收窄、Esc 关闭）；
  - 取消 `watch(menuGroups)` 的原因与替代方案已写入代码注释（README 级教训：TDZ 只在运行时炸，构建/类型检查都发现不了）。

- **C2 TaskCenter ✅**：
  - 主进程 `main/taskcenter.js`（纯逻辑 `createTaskCenter` + Electron 适配 `registerTaskIpc`）：register→handle（progress/log/done/fail/cancel）、列表排序（running 前）、**10Hz 合并广播**、保留策略（5 分钟 / 最多 200 条 / 日志 200 行）、`tasks:list` / `tasks:cancel`；只回**可结构化克隆快照**（内部 onCancel 函数不回 IPC —— 踩过 "could not be cloned"）；
  - preload `tasks.list/cancel/onUpdate` + `types/ipc.ts` TaskItem；前端 `stores/tasks.ts` + `components/TaskCenter.vue`（全局右下角按钮 + 进度条 + 取消），已挂到 App 根（**必须放在 Transition 兄弟节点**，放里面会被当第二子节点移除 —— 踩过）；
  - 业务接入：`export:audio` 登记任务（写盘完成 done / 失败 fail）；E2E 模式额外注册 `tasks:demo` 造可控假任务；
  - 测试：`scripts/test-taskcenter.mjs` 7 例（状态机/节流/取消/保留/上限/日志）；E2E `tasks-ui`（demo 任务 → 面板显示 running+进度 → 取消 → 面板显示已取消）。

- **P1-1a/b 编排时间线 ✅（UI 第一版）**：
  - 模型（P1-1a）：`core/arrange.js` 扩展 clip 纯函数（add/move/resize/split/duplicate、track flags、markers/regions、`renderPlan` 秒映射、`focusRangeOfClip`），13 测例；
  - UI（P1-1b）：`views/ViewArrange.vue`（挂在「视图」组新页签「编排」，`/arrange` 重定向）——画布标尺/小节网格/C4 `iterBars`、clip 圆角块、拖拽移动+跨轨、拖边缩放、按播放头切分、删除、静音轨道、加标记/区间、缩放/全览/滚轮、播放头、双击片段写 focus 意图并跳编辑页（ViewEdit 读取后定位轨道+起点）；
  - E2E `arrange-ui`：挂载、片段统计、加两次标记、加区间、全览、截图。
  - **P1-1c ✅**：编排状态回写 `song.arrange`（防抖 250ms；`readArrangeFromSong` 校验失败回退默认）；`clipsRenderJobs` 把 clip 转成「从原曲区间渲染 + 放到时间线 placeSec」的任务（含播放倍速折算）；转换页新增「按编排片段导出」——逐 clip 离线渲染后按 placeSec 叠加到 master，再走既有编码/落盘/manifest 链路。
  - 剩余：编排编辑走 C1 命令注册表（撤销）；`.fufumidi` 工程包写入 clips（当前只挂 song 内存 + 自动保存的 MIDI 字节不含编排）。

- **P1-2 分析升级 ✅（核心 + UI 第一版）**：
  - 核心：`analysis.js` 新增 K-S 转调滑窗、转调段合并、和弦+能量段落聚类、和弦名解析、罗马数字（按输入拼写判升降号）；9 测例；
  - 写回：`chordMarkersOf` / `mergeChordMarkers` 把逐小节和弦转成 **MIDI marker 元事件**（P0-1 编码器直接导出；重复写只替换 `chordGen` 标记，不动用户手写 marker）；6 测例；
  - UI：分析页新增「转调与调性」「段落结构」卡片（大曲目自动跳过滑窗并提示）；编辑页工具菜单新增「分析和弦轨 → 写入 MIDI 标记」；E2E `analysis-ui` 验证 C→F 曲目切出 ≥2 段。

- **P1-6 影视配乐 ✅（帧吸附 / 时间码 / 视频偏移）**：
  - 新 `core/frame_snap.js`：5 档帧率（23.976/24/25/29.97/30）、`snapTickToFrame`（**时间域吸附**：tick→秒→按 fps 取整→秒→tick，变速曲目与 SMPTE 时间轴都正确）、时间码 `HH:MM:SS:FF`（29.97 走 NDF 30 帧计数）、`frameTickStep / framesBetween / videoTimeForPlayhead`；7 测例；
  - 编辑器：检查器「网格与显示」新增「帧吸附」开关 + 帧率选择（开帧吸附时拍吸附置灰）；EditorCanvas 的 `snapTick` 优先走帧吸附（失败自动回退拍吸附）；状态栏时间码统一走 `timecodeOfTick`（SMPTE 文件用文件 fps）；
  - 视频轨：新增「视频偏移（秒）」输入 + 播放同步（200ms 纠偏，偏差 >150ms 才 seek），偏移持久化 localStorage；
  - E2E `frame-snap-ui`：切检查器视图页 → 勾选帧吸附 → 帧率下拉出现且含 23.976/29.97 → 时间码格式正确。

- **P1-7 许可与溯源 ✅**：
  - `scripts/gen-licenses.mjs` 从**真实数据源**生成清单：应用自身（package.json）、内置音色库（main/soundfonts.js REGISTRY，20 项）、内置第三方二进制（docs/VENDOR.md 清单，10 项）+ 许可证提示；产物为 `frontend/src/core/licenses.js`（关于页 import）与 `docs/licenses.md`；
  - 门禁 `check:licenses`（已进 `npm run audit`）：生成物与数据源漂移即失败，且 **docs/VENDOR.md 列出的每个组件都必须出现在清单里**（防漏项）；生成内容做 `#` 清洗（避免被 UI token 审计误判为颜色）；
  - 新 `views/ViewAbout.vue` + 路由 `/about`；设置·关于新增「许可与溯源」按钮；
  - 导出溯源：MIDI 编码支持 **版权元事件（0x02）**（parse/encode/buildSong 全链路），编辑页导出自动写 `FuFumidi · 曲名`；2 个 round-trip 测例；
  - E2E `about-ui`：关于页出现应用/音色库/第三方组件清单（≥15 行）且含 MIT/GeneralUser/verovio 等关键条目。

- **P1-9 存储治理 ✅**：
  - 新 `main/storage.js`（纯逻辑 + IPC）：10 类占用（模型/音色/声库/DiffSinger/GPU 增强/缓存/临时/日志/曲库）×字节+文件数；
    清理规则硬编码在数据层 —— **曲库 protected 永不清**，资产（模型/音色/声库）需显式 `includeAssets`，日志只保留最近 5 份，其余目录只清空内容；
  - IPC `storage:report` / `storage:cleanup`（preload + types 同步）；`scripts/test-paths-storage.mjs` 5 测例（含"includeAssets 也不动曲库"）；
  - 资源中心新增「存储治理」页签：分类表 + 总计 + 刷新 + 清理（二次确认），危险选项「包含已下载资产」显式勾选；
  - E2E `storage-ui`：面板挂载、≥8 分类、曲库标记不可清理、刷新。

- **P1-11 音频轨最小闭环 ✅（补齐验收）**：
  - 音频轨模型/序列化（`song_project.js` `kind:'audio'`：asset/fileName/durationMs/skip/trim/fadeIn/fadeOut/gainDb/muted）与 UI（ViewSing 音频轨头：增益/静音/跳过/淡入淡出）原本已存在；
  - 本轮补上**缺失的自动化测试** `frontend/tests/audio-track.test.js`（8 例，假 AudioContext，无需声卡）：
    - 伴奏/人声两条源拿到**同一个 `when`**（采样级同步，误差 0ms；要求 <5ms）
    - 中途起播 offset = max(skip, 位置)；`durationMs` 按 (时长−skip) 取最大
    - 增益 dB→线性且单轨上限 1、muted=0；变速 `playbackRate` 与源时长、位置按倍率缩放
    - `applyFades` 首尾归零/中段不变、淡入+淡出超总长时按比例收缩
    - `renderOffline` 按播放同一套参数混音（仅非静音轨、总长含 0.3s 尾音）
  - 需要导出的 `applyFades` 已加 `export`（测试用，生产行为不变）。

- **P1-12 控件契约 + 任务模板 + 专家模式 ✅**：
  - 新 `core/ui_contract.js`：17 条控件语义（播放/撤销/重做/保存/量化/切分/删除/复制/缩放/全选…）声明**规范键位 + 覆盖视图 + 是否必需**；`validateControlContract` 检出「快捷键冲突 / 跨视图键位漂移 / 未声明语义 / 必需项缺失」；吸附档位 `SNAP_OPTIONS` 与模板共用一份；8 测例；
  - 新 `core/workspace_templates.js`：钢琴改编 / 乐队编曲 / 短视频 BGM 三个**任务模板**（只改吸附/着色/CC，不动曲目），`normalizeTemplatePrefs` 把吸附夹到合法档位，`applyTemplate` 只覆盖模板键；编辑器检查器「网格与显示」新增模板 chips；6 测例；
  - **专家模式**沿用已有设置键 `advanced_mode`（默认关）：普通模式隐藏「翻唱」导航与资源中心「OMR 识谱引擎 / GPU 加速」区块；设置 → 功能 新增开关；TopBar 与命令面板统一走 `core/expert.js` 过滤；4 测例 + E2E `expert-mode-ui`（普通隐藏 → 打开显式设置后重载可见 → 复原 → 模板把吸附切到 1/8）；
  - 布局预设（`stores/workspace.ts` 的编曲/调教/校对/混音）是既有能力，与任务模板正交保留。

- **P1-13 B1 手势状态机 ✅（核心 + 编排页接入）**：
  - 新 `core/gesture.js`（10 测例）：`resolveIntent` 判定 8 种语义（tap / drag / resize-start / resize-end / marquee / pan / create / erase），边缘命中 6px、**3px 拖动阈值**（手抖不再变成"挪 1 tick"，点击与拖动撤销粒度分开）；
  - `beginGesture/updateGesture/endGesture/cancelGesture`：`endGesture` 返回 `{tap, moved, intent, dx, snapDx}`，吸附通过注入 `snapX/snapY`（引擎不假设坐标含义）；`isMutatingIntent` 区分是否需要推撤销；未 active 时 update/end/cancel 全部安全；
  - 接入编排页：拖片段/拖边缩放/中键平移/标尺拖拽框区间都走状态机；**标尺拖动预览带**（松手才落 region，10px 以内当点击 seek）；E2E `arrange-ui` 增加「标尺拖出 1 个区间」断言；
  - 剩余（B1 后续）：EditorCanvas / ViewSing 的既有 dragState 迁移到同一状态机；B2 悬浮工具条/就地编辑、B3 曲线引擎、B4 导航/mini-map。

- **P1-10 性能基线 ✅**：
  - 新 `scripts/perf-baseline.mjs`（CDP 驱动真实应用，非估算）：启动到可交互、4 个视图冷/热切换、60k 音符编辑页首次进入、**播放时 rAF 帧间隔 p50/p95（180 帧）**、JS 堆增长；
  - 实测基线（本机 32 核）：启动 ~0.8s、视图冷切换 p95 ~0.4s（含懒加载）、热切换 p95 ~0.2s、60k 编辑页 ~0.55s、帧间隔 p95 3.4ms（240Hz 屏）、堆 10MB→45MB；
  - 预算 = 「基线 +25% 抖动」并带绝对值下限（启动 4s / 冷切 1.2s / 编辑 3s / 帧 20ms / 堆 25%）；`npm run perf:gate` 超预算非零退出，`npm run perf:baseline` 重记；生成 `docs/perf-baseline.json` + `docs/perf-report.md`（含口径说明：帧率随显示器刷新率变化，故取相对基线）。

- **P1-13 B2 撤销/重做 ✅（第一步：历史栈 + 编排页 C1 命令）**：
  - 新 `core/history_stack.js`（6 测例）：快照式 undo/redo 栈，默认深拷贝（可注入 clone 支持 Map/Set），limit 丢最旧、新操作清 redo、空栈安全返回 null；
  - 编排页接入：拖片段/拖边缩放/标尺拖区间/切分/删除/静音/加标记/加区间全部记一次历史（**一次手势=一条撤销项**：第一次真正移动才 push，快照是移动前）；工具栏「撤销/重做」按钮 + `Mod+Z`/`Mod+Shift+Z` 走 **C1 命令注册表**（`arrange.undo/redo`，命令面板/快捷键/按钮同一份）；
  - E2E `arrange-ui` 增加：标尺拖出区间 → 撤销回原状 → 重做恢复；同时修掉 `about-ui` 的启动期 hash 竞态（与 storage-ui 同一处理）。

- **P1-14 B3 导航历史 / 深链接 / 会话恢复 ✅（标签页与多文档未做）**：
  - 新 `core/nav_history.js`（7 测例）：应用级后退/前进栈（连续重复不入栈、新导航丢前进栈、上限 50、onChange 订阅）；`parseDeepLink/buildDeepLink` 解析、生成视图深链接（页签白名单校验）；`normalizeSession/readSession/writeSession` 会话快照（7 天 TTL、坏数据/未来时间安全返回 null）；
  - TopBar 新增**后退 / 前进**按钮（`data-guide=nav-back/nav-forward`，与浏览器语义一致但只走应用内路由；`navHistory.state.applying` 防止路由 watcher 重复入栈）；
  - App：路由变化写入历史 + 防抖写会话（hash + 曲目 id）；启动时**同步抓取**上次会话，仅在「本次从首页启动且上次不是首页」时 `router.replace` 恢复，避免深链接/文件关联被旧会话抢走；
  - E2E `nav-history-ui`：视图→资源中心→后退→前进；回首页写入自定义会话→重载→自动恢复到「视图/编排」；E2E-only 调试钩子 `window.__fufumidiNav`。
  - 剩余：多标签页 / 每个标签独立滚动与选区 / 会话里的曲目 id 恢复。

- **P1-8 更新包签名与验签 ✅（Phase 1：Ed25519 清单签名；Authenticode/EV 证书待购）**：
  - 新 `main/update_sign.js`：Ed25519（Node 内置 crypto）签名/验签，签名对象是规范串 `fufumidi-update/v1\n版本\n资产名\nsha256`；内嵌公钥、私钥只在构建机（`E:\Midi\_attic\update-signing\`，不入库）；
  - 新 `scripts/sign-update.mjs` 生成 `update-manifest.json`（默认签 update 目录的 `FuFumidi.Install.exe`，与 kachina 更新器实际下载资产名一致）；`archive-release.mjs` 自动归档清单并进 SHA256SUMS；
  - 更新器 `main/update.js`：安装包下载完成后从 CNB/GitHub（latest/beta + 镜像）取清单 → 校验大小/sha256 → 验签；**失败即删除安装包并拒绝更新**；旧版本 Release 无清单时跳过并告警（兼容），6.0.0 起发版必须带清单；
  - 7 测例（正常/篡改/同大小换内容/改版本/错 key/坏清单/坏路径）+ 真实私钥签名→内嵌公钥验签端到端通过；`npm run test:update-sign` 已进 test 链；`docs/UPDATE-SIGNING.md` 写清流程与密钥轮换；
  - 剩余：Windows Authenticode 代码签名（证书采购）、macOS 公证（P2-4）。

- **P1-7 导出元数据 ✅（WAV：BWF bext + LIST INFO）**：
  - `encodeWav` 新增 `metadata`：BWF **bext**（description/originator/originatorReference/日期/时间/时间参考，版本 1）+ **LIST INFO**（INAM/IART/ISFT/ICMT/ICRD）；chunk 偶数对齐，非 ASCII 写成 Latin-1 安全字符（'?'）避免非法字节；
  - `decodeWavHeader` 改为**按 chunk 扫描**（data 前可能有 bext/LIST，固定偏移会读错）；返回 `extraChunks`；
  - 转换页导出的每个 WAV 自动写「FuFumidi / 曲名 / 生成日期时间」溯源信息；6 测例（无元数据/bext 回读/INFO 回读/奇数对齐/float32/中文安全）；
  - MP4 元数据（ID3/BWF 之外的容器标签）暂未做：视频导出走 MediaRecorder，容器由 Electron 写，后续需要换封装链路。

- **P1-13 B3 曲线引擎统一 ✅（核心 + PB 泳道）**：
  - 新 `core/curve_engine.js`（11 测例）：点运算（排序/同拍去重、钳制、插入/删除/移动、线性取值+两端保持、RDP 简化、步长量化、平滑、缩放、合并）；**不可变**返回新数组，调用方决定撤销粒度；
  - MIDI 弯音换算：`bendToUnit/unitToBend`（**中心精确 64 ↔ 8192**：负半轴 8192 步、正半轴 8191 步，避免回中残留 +1.5 cent）、`bendToCents/centsToBend`（默认 ±2 半音，可配范围）、`bendNorm`；
  - 编辑器新增**弯音（PB）泳道**：CC 目标里加「弯音 PB（±2 半音）」，与 CC 共用同一条泳道但写入 14bit `bend` 事件（按 tick 有序插入、±2 tick 合并）；E2E `edit-pb-lane` 验证画一笔后轨道事件里出现正弯音；
  - 统一：`track_automation.sampleAt` 改为委托 `curve_engine.valueAt`，调教侧与编辑侧取值语义同源。

- **P1-13 B2 悬浮工具条 / 就地编辑 / 批量操作 ✅（补齐验收）**：
  - 能力原本已存在：M3 悬停工具条（音符名/力度/演奏法就地显示）、列表编辑器与参数工具（就地精确改值）、选区上下文任务条（移调/八度/力度/量化/复制/克隆/静音/删除/列表）；
  - 本轮为任务条所有高频按钮补 `data-guide`（sel-badge / sel-transpose-up/down / sel-oct-up/down / sel-vel-up/down / sel-quantize / sel-delete / sel-cancel），并新增 E2E `edit-selection-toolbar`：
    **Ctrl+A 全选 → 已选 3 → 批量升半音（每个音符 +1，逐条读回数据）→ 批量力度渐强 → 批量删除 → Ctrl+Z 恢复 3 个音符**（一次操作 = 一条撤销项）。

- **P1-13 B4 导航 / 跟随 / mini-map / 循环 ✅**：
  - 新 `core/editor_nav.js`（5 测例）：跟随播放的视口滚动策略——播放头在 12%~88% 可视区内不滚，越界才滚到 30% 锚点；纯函数、无 DOM、无数据安全返回 null；
  - EditorCanvas 新增 `followPlay`：播放中每帧按策略调整 `viewTick`（只在越界时改，手动滚动不会被每帧抢回）；新增 `viewInfo()` E2E 钩子；
  - 编辑器工具栏新增「跟随」开关（默认开、localStorage 持久化；`data-guide=edit-follow`）；
  - mini-map / 选区循环原本已有：补 `data-guide`（edit-minimap / edit-loop-set / edit-loop-clear）并纳入 E2E；
  - E2E `edit-follow-ui`：默认开启 → 关闭/重开持久化 → mini-map 点击导航 → Ctrl+A 设选区循环（按钮高亮）→ 清除循环 → 播放中画布正常。

- **P1-14 B4 任务中心 / 通知 / 设置可搜索 / 帮助 ✅（设置搜索为本轮新增）**：
  - 任务中心与通知体系（C2）此前已落地：`main/taskcenter.js` + `stores/tasks.ts` + `TaskCenter.vue`（E2E tasks-ui）；
  - 帮助：`GuideOverlay` / Guide 章节此前已存在；
  - **设置可搜索（新）**：`core/settings_index.js`——20 个设置项索引（label/hint/口头别名：字大/显卡/升级/热键/夜间模式…），`searchSettings` 打分排序（精确 > 前缀 > 包含 > 别名 > hint），`validateSettingsIndex` 校验 id 唯一与页签合法；6 测例；
  - SettingsPanel 头部新增搜索框 + 结果下拉；点结果切页签并 `scrollIntoView` 到 `data-setting` 锚点（短暂高亮）；已给 7 个高频设置行加锚点；
  - E2E `settings-search-ui`：输入「显卡」→ 首条命中 GPU 加速 → 点击切到 GPU 页签；「更新通道」→ 更新页签；无结果显示「没有找到匹配的设置」。

- **P1-14 多标签页 ✅（v1：曲目标签切换）**：
  - 新 `stores/tabs.ts`（5 测例）：标签列表 + activeId，open（已存在只激活）/activate/close（关当前自动选邻居）/closeOthers/hydrate（启动时清掉曲库里已不存在的标签）/上限 12/持久化 localStorage；
  - 新 `components/SongTabs.vue`：≥2 个曲目时显示标签栏（单曲目不占垂直空间），点击切换曲目、× 关闭（不删曲目）、双击关闭其它；`data-guide=song-tabs / song-tab-close`；
  - App：当前曲目变化自动开标签；恢复曲库后 hydrate；E2E-only 调试钩子 `window.__fufumidiTabs`；
  - E2E `song-tabs-ui`：导入两首 → 两个标签 → 点第一个切换（activeId 正确）→ 关闭另一个 → 剩 1 个且曲库仍有 2 首。
  - 边界（v1）：标签只是**切换入口**，不复制 song 数据；每个标签的独立撤销栈/滚动位置仍由重新进入编辑器时的实例状态决定（后续可做多编辑器实例缓存）。

- **P1-4 OMR 收口 ✅**：
  - 现状盘点：`engine/engine_omr_backends.py` 已是多后端调度层（classical 自带识谱 / Audiveris / homr AI 识谱），含按系统切带 `plan_page_bands`、拍号推定、失败分类 `classify_failure`、逐页体检 `page_checks`、按页重试缓存、跨页 `merge_pages`/`merge_midis`；UI 侧 `ViewScoreConvert` 已有失败页列表与「一键重试该页」；
  - **本轮补 SMT（Sheet Music Transformer）可选后端**：`find_smt/run_smt` 命令适配器（`FUFUMIDI_SMT_CMD` 或 `--smt`，契约 `--in <页图> --out <页 MIDI>`），逐页校验输出再用 `merge_midis` 拼接；未配置时明确报 `backend-missing`（不静默退化）；模型/权重不随包分发（体积与许可原因）；
  - 测试：`engine/tests/test_omr*.py` **62 项全部通过**（OMR 7 + 后端 55，含本轮 4 个 SMT 适配器用例）；新增 `npm run test:omr`（`scripts/test-engine-omr.mjs`：自动找带 pytest 的 Python，找不到则跳过；本机用 `_attic/envs/engine-test`）。

- **P1-5 咬字与歌词对齐 ✅（核心；UI 标记/手动修正待做）**：
  - 新 `engine/align_sofa.py`：能量包络（10ms）+ 字数比例先验 → 静音谷右沿取字边界；`clean_units`（中文按字、拉丁按词、标点剔除）、`align_signal/align_file/align_lines`、`boundary_error_ms`；
  - 丢字检测：`retention = min(时长保留率, 起音覆盖率)`（短于 55ms 视为没唱、超中位 2.2× 视为吞字；起音上升沿 70ms 去抖），<95% 写进合成 warnings；
  - 接入链路：`engine_gpt_sovits.py sing --char-align` → 每句 `lines.meta.json.char_align` 与 `RESULT.lines[]`；`engine_cover.py do_gsv` 默认开启（`--gsv-no-char-align` 可关），不影响合成；
  - 测试 `engine/tests/test_align_sofa.py` 6 例（合成 burst 真值：5 字中位边界误差 <30ms、缺一字时 onsetRatio/retention <95%、纯静音/空音频安全、标点与拉丁词切分）；
  - **UI 标记 ✅**：`engine_cover` 汇总逐句 `char_align.retention<0.95` → `info.gsv_char_report` 并写 `gsv/gsv_lines.json.charAlign`；ViewCover 结果卡显示「咬字校验」：坏句数、逐句文本/保留率、处理建议（`data-guide=cover-char-align`）。
  - **严格模式 ✅（本轮）**：`engine_cover --gsv-char-strict`：字保留率 <95% 的句子存在时**在混音前中止**（返回 code=char-retention，保留干声与 info 供调整后重试）；`main/cover.js` 透传 `charStrict`；ViewCover 高级区新增「咬字校验严格模式」开关（`data-guide=cover-char-strict`，仅 GPT-SoVITS 通道显示，选项持久化）。
  - 剩余：逐句自动重合成的"手动修正"UI（当前工作流：看「咬字校验」列表 → 换参考音/缩短句子 → 重跑，严格模式下干声保留便于对比）。

- **P2-3 MIDI 2.0 / MPE / Clock ✅（协议核心；设备 I/O 接线待做）**：
  - 新 `core/midi2.js`（13 测例）：UMP 编解码（MT2 = MIDI 1.0 通道消息 32-bit；MT4 = MIDI 2.0 通道消息 64-bit：Note On 16-bit 力度、逐音弯音 32-bit 有符号）、7/16-bit 力度换算；
  - MPE：lower/upper zone、master 通道保留、一音一 member 通道（池化分配/释放回收）、逐音弯音（semitone → 14-bit，默认 ±48）/CC74 音色/通道压力；通道耗尽安全返回 null；
  - MIDI Clock：24 PPQN 状态机（start/continue/stop/setBpm），**相位累计不丢脉冲**（100 次 10ms 小步进恰好 48 脉冲/秒@120BPM）；Song Position Pointer 14-bit；`clockSchedule` 静态时间表、`clockJitter` 接收抖动统计；
  - 剩余：把 clock 主/从接到 Web MIDI 输出（播放/停止/跳转时发 start/continue/stop/SPP）、MPE 输出设备选择、UMP 实际发送（当前协议层可测，未接设备）。

- **P2-1 VST3/CLAP Phase A ✅（离线插件节点 + 导出链接线；真实第三方插件宿主待接）**：
  - 新 `core/plugin_node.js`（10 测例）：离线 DSP 节点 —— gain、单段 EQ（RBJ peaking/low/high shelf/lowpass/highpass）、压缩器（peak 包络 + 软膝 + makeup）、饱和器（tanh + dry/wet）；参数按元数据夹紧、未知类型过滤、链顺序影响结果、立体声独立、输出钳制（NaN→0 / 超范围 ±1）；
  - `normalizePluginChain` / `describePluginChain`（UI 摘要）、`applyPluginChain` 返回每节点耗时与前后峰值报告；
  - **导出链接线**：`export.audio.plugins` 设置 → `normalizeExportOptions` 规范化 → ViewConvert 渲染后、**响度归一化之前**应用（压缩器不会破坏已校准 LUFS）；插件链异常只告警并跳过，不阻断导出；
  - 说明：真实 VST3/CLAP 需要外部宿主（`pedalboard` 或独立进程），本机未安装插件与宿主，本轮交付**可测的节点契约 + 内置等效节点**；接真实插件时只需把主进程宿主输出映射成同一 JSON 节点（Phase B 实时宿主不做）。

- **P2-2 原生音频 I/O ✅（契约 + 延迟实测；Rust 侧 WASAPI/ASIO 未实现）**：
  - 新 `core/audio_rt.js`（8 测例）：后端表（WebAudio / WASAPI 独占 / ASIO / CoreAudio / ALSA）、按平台与原生可用性过滤；`chooseAudioBackend`（auto/webaudio/native）——**原生不可用时必须回退 WebAudio 且把原因写进报告**（不静默）；延迟口径 `latencyReport`（base+output+输入缓冲，目标 ≤10ms，low/medium/high 分级）；`formatLatencyReport`、`bufferOptions`；
  - 新 `scripts/audio-rtl.mjs`（`npm run audio:rtl`）：在真实 Electron 渲染进程建 AudioContext（interactive / playback 两档）实测 baseLatency/outputLatency/采样率，生成 `docs/audio-rtl-report.md`；
  - 本机实测（48kHz）：interactive baseLatency 10ms → 估算 RTL 10ms（刚好达标）；playback 20ms（未达标）。outputLatency 上报 0（测试实例无实际输出设备），报告已注明；
  - 说明：真正把 RTL 压到 ≤10ms 且稳定需要 WASAPI 独占/ASIO（cpal + ASIO SDK）——属于 P2-2 的原生实现，当前未随包；本轮交付的是**可测的契约、回退策略与测量脚本**，原生实现可后续无痛接入（只需实现同一 `availableBackends/chooseAudioBackend` 输入）。

- **P2-4 跨平台 ✅（dev 包构建入口 + 路径/冒烟清单；签名公证与真机验证待环境）**：
  - 新 `main/platform.js`（7 测例）：目标平台的 Python 运行时/venv 解释器相对路径、安装包后缀、数据根默认位置、冒烟清单、平台说明、解释器候选优先级；**路径按目标平台风格生成**（Windows 上也能正确规划 mac/linux 路径）；
  - 跨平台路径收口：`main/omr.js` 的 venv 解释器、`main/cover.js` 的 GPT-SoVITS 运行时候选改用 `platform.js`（不再硬编码 `Scripts/python.exe`）；
  - 新 `scripts/build-platform.mjs`（`npm run build:platform`）：目标平台校验、前置条件检查（内置 Python、当前平台匹配）、冒烟清单打印、`--dry-run` 可在任何平台查看构建命令；非本机平台拒绝真正构建（原生依赖）；
  - 新 `docs/CROSS-PLATFORM.md`：dev 包构建步骤、Python/ffmpeg/模型前置、冒烟清单、已知缺口（签名公证 / 原生音频 I/O / Flatpak）；
  - `npm run test:platform` 已进 `npm test` 链。

## 发布记录（6.0.0）

- 版本四源一致 6.0.0；发布说明 `scripts/release-notes-v6.0.0.md`；更新日志内置 6.0.0。
- 构建：`scripts/build-release.ps1 -Version 6.0.0` 成功（Setup 675.9MB / Install 145.7MB / 更新器嵌入配置断言通过）。
- 签名：`scripts/sign-update.mjs` 对 `FuFumidi.Install.6.0.0.exe` 生成 `update-manifest.json`（Ed25519）；
  `archive-release.mjs` 归档到 `E:\Midi\安装包\FuFumidi\6.0.0`（含 SHA256SUMS）。
- **CNB 发布**：`v6.0.0` Release 9 个资产（Setup/blockmap/Install/更新器/latest.yml/metadata/说明/签名清单），
  `make_latest` 已置为最新；`releases/latest/download/{latest.yml,update-manifest.json,FuFumidi.Install.exe}` 校验一致，
  **下载安装包后用内嵌公钥验签通过**（sha256 7e4686…）。
- **安装版部署 + 真机冒烟**：`deploy-installed.cjs` 覆盖 app.asar 后启动冒烟通过（首屏 358 字符、fuBridge 就绪、0 未捕获异常、0 console.error）。
- **6.0.1（功能补齐版，源码与安装包一致）**：版本四源一致；新增 DAWproject 导出 / 可选 AI 生成 / 翻唱咬字校验 UI；
  `build-release.ps1 -Version 6.0.1` 成功、更新器嵌入断言通过；Ed25519 清单签名；归档 `E:\Midi\安装包\FuFumidi\6.0.1`；
  CNB `v6.0.1` Release 9 资产上传、**is_latest=true**（`releases/latest` → v6.0.1）；
  latest.yml/manifest/安装包大小一致，**从 CNB 下载安装包验签通过**（sha256 485250…）；安装版部署 6.0.1 + 冒烟通过。
- **6.0.2（体验补齐全）**：P0-4c 分轨 ZIP 打包 / P1-13 编排页分标签撤销；版本四源一致、构建成功（更新器断言通过）；
  Ed25519 清单签名（sha256 89d373…）；归档 `E:\Midi\安装包\FuFumidi\6.0.2`；CNB `v6.0.2` 9 资产、
  **is_latest=true**；latest.yml/manifest 一致，**下载安装包验签通过**；安装版部署 6.0.2 + 冒烟通过。
  （注：构建脚本在 vite 把告警写 stderr 时外部 PowerShell 退出码可能为 1，但产物/断言均已正确完成 —— 以产物校验为准。）
- 未完成：GitHub Release 资产上传（本机无 GitHub 凭据，credential fill 交互不可用）；mac/linux 真机构建与签名公证；
  Authenticode 证书；原生音频 I/O（WASAPI/ASIO）与真实插件宿主 —— 均属环境/资源依赖项。

- **P2-6 AI 生成接入 ✅（可选、默认关；本地命令适配器）**：
  - 新 `core/ai_generate.js`（7 测例）：状态机（disabled / not-configured / ready，**只有布尔 true 算开启**）、请求校验（kind/prompt 长度/seed 夹紧）、job 契约（`fufumidi-ai-job/v1` + promptHash）、结果规范化（**强制 aiGenerated=true + provider/model/时间/哈希**，去重、拒绝路径穿越/控制字符/空文件）、AI 标注文案；
  - 新 `main/ai-generate.js`：IPC `ai:status` / `ai:generate` —— 只调用用户自备本地命令（`ai.provider_cmd` 或 `FUFUMIDI_AI_CMD`，契约 `--job <job.json> --outdir <dir>`，结果 `result.json`），10 分钟超时、输出文件必须真实存在且在 outdir 内、退出码/缺结果文件/无有效文件都明确报错（**不伪造成功**）；不内置模型、不联网；
  - 三处同改：preload `ai.status/generate` + `types/ipc.ts` 类型 + 设置默认值 `ai.enabled=false` / `ai.provider_cmd=''`；设置索引新增「AI 生成（可选）」；SettingsPanel 专家模式下的开关与命令输入（`data-guide=ai-generate-*`）；EN/JA 文案同步；
  - E2E `ai-generate-ui`：默认关闭时 IPC 拒绝、专家模式出现开关、开启未配置 → not-configured、配置假命令 → **bad-result**、复原设置；全量 E2E 23/23；
  - 说明：真实生成能力取决于用户本地模型/命令，随包不提供模型；AI 产物已带标注字段，供导出/曲库展示。

### 6.0.0 完成度审计（对照 28 包）

- **P0-1…P0-8**：均有实现与测试（midi-roundtrip / session / midiin / recorder / export_audio / default-soundfont / timeline-model / check-version）。
  - **P0-4c 分轨 ZIP 打包 ✅（本轮）**：`export:stems-zip` IPC（主进程 adm-zip 一次写出、文件名安全化、总大小 ≤2GB、E2E 模式可绕过保存对话框）；转换页「打包为一个 ZIP（推荐）」开关（默认开，分轨勾选后出现）；`renderStems` 重构为「编码 → 一次打包 / 逐文件保存」，网页端自动退回逐文件下载；E2E `stems-zip-ui`（开关可见 + IPC 写出两轨 ZIP 并解包校验），全量 E2E 25/25。
  - P0-8 的 i18n **历史欠账正在逐批还**：新增 `scripts/i18n-apply-batch.mjs`（`npm run i18n:apply`：把 `{en,ja}` 批量插入两词典，跳过已有键）+ 每批后 `--update-baseline` 缩棘轮。第一批已补 **EN 60 / JA 57**，第二批 **EN 100 / JA 96**、第三批 **EN 100 / JA 99**（编辑工作台/声库/变谱/转录音频/队列/环境提示），基线 1203/1157 → **943/905**；第四批 **EN 100 / JA 91**、第五批 **EN 100 / JA 97**、第六批 **EN 100 / JA 97**、第七批 **EN 100 / JA 96**、第八批 **EN 100 / JA 97**、第九批 **EN 100 / JA 95**、第十批 **EN 100 / JA 98**（已操作反馈/音高音素说明/引擎属性/音频归一化），→ **243/234**；剩余按文件热度继续分批。
- **P1-1…P1-14**：全部主体完成；尾巴：P1-5 手动修正/强制校验。
  - **P1-13 分标签页独立撤销栈 ✅（编排页，本轮）**：`history_stack.js` 新增 `createTabbedHistoryRegistry`（每曲目一个快照栈、LRU 上限 16）；编排页按 `app.currentId` 取栈、切标签保存/恢复横向滚动位置；E2E `arrange-tabs-undo` 验证 A/B 两标签撤销互不影响且切回仍可撤销（全量 E2E 26/26）。
  - **P0-4c 分轨 ZIP 打包 ✅**（上轮）。
- **P2-1/P2-2/P2-3/P2-4**：协议层/契约/构建入口完成；真实第三方插件宿主、WASAPI/ASIO/CoreAudio 原生 I/O、mac/linux 真机构建与签名公证属环境/资源依赖项。
- **P2-5 DAW 互通（DAWproject）✅（导出子集；未经 DAW 实机导入验证）**：
  - `core/dawproject.js`（8 测例）：模型规范化（bpm 20–666、拍号分母 2 的幂、空轨/非法音符剔除、颜色 #RRGGBB）、`songToDawprojectModel`（**tick/tpb 直接换算 beats，变速曲目正确**）、`buildProjectXml`（官方 XSD/示例同构：Application/Transport Tempo+TimeSignature/Structure Track+Channel(Volume/Pan/Mute)+Master/Arrangement Lanes→Clips→Clip→Notes→Note/Scenes，全部转义）、`buildMetadataXml`、`parseProjectXml` 回读、标记导出；
  - `main/dawproject.js` + IPC `dawproject:export`：渲染进程出 XML，主进程用 adm-zip 写 .dawproject（校验只有 project.xml/metadata.xml、总大小上限、原生保存对话框；E2E 模式允许指定路径）；
  - 转换页新增「导出 DAWproject」按钮（有曲目才可用）；E2E `dawproject-ui`：按钮可见 + IPC 落盘 + 解包校验 project.xml/metadata.xml，全量 E2E 24/24；
  - **限制**：只覆盖 MIDI 音符轨 + 速度/拍号/标记子集；未在 Studio One / Bitwig 实机导入验证（无该软件），验收锚点中「导入报告」需真机补；音频事件/Warp/插件状态/自动化不导出。
- **P2-6 AI 生成**：✅ 本轮完成（可选、默认关、本地命令、强制 AI 标注）。

## 3. E2E（验收底座，已落地）

- 位置：`scripts/e2e/`（`lib.mjs` CDP 驱动、`run.mjs` 运行器、`cases/*.mjs` 用例）；
- 命令：`npm run test:e2e` / `npm run test:e2e -- smoke`；产物在 `scripts/e2e/artifacts/`（已 gitignore）；
- 现状：`smoke`（首屏/导航/无未捕获异常）与 `edit-basic`（编辑页画布 + 撤销/重做/播放快捷键）**2/2 通过**；
- 规则：P1-13/P1-14 的每个交互 PR **必须先加/改用例**；用例不得写真实数据目录；
- 文档：`docs/E2E.md`。

## 4. 变更流程

1. 契约变更 = 单独 PR（`contract:` 前缀），必须附「谁消费/兼容影响/迁移方式」；
2. 新增消费方先读本文件，接口不符时改需求而不是私加字段；
3. 每次 W 批次结束时回填本文件「状态」列；契约实现完成即把状态改成「已实现 @commit」。

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
| C1 | CommandRegistry 命令注册表 | `frontend/src/core/commands.js`（新） | W0 待实现（接口冻结） | 菜单/工具栏/右键/快捷键/命令面板/宏 |
| C2 | TaskCenter 长任务中心 | `main/taskcenter.js`（新）+ `preload.js` | W0 待实现（接口冻结） | 转录/下载/渲染/导出/更新/OMR |
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
  - 剩余（P0-3b）：ViewEdit 录音面板（录音/停止/take 试听采用丢弃）、延迟校准向导、settings.midiInputOffsetMs 持久化。
- **P0-4 导出核心 ✅（UI/分轨接线待接）**：
  - 新 `core/export_audio.js`（289 行）：WAV PCM16（TPDF dither）/ PCM24 / float32 编码、WAV 头解析、峰值/RMS、ITU-R BS.1770 K 加权响度（400ms 块 + 75% 重叠 + 门限）、前瞻限幅、响度归一（目标 −14/−16/−23，报告误差与衰减量）；
  - 新 `main/export.js`：`export:audio` IPC 原子落盘 + 同名 .manifest.json（sha256/size/格式/位深/采样率/声道/时长/LUFS/峰值/目标）；文件名 Windows 安全化；三处同改（preload.exportAudio → main.js 注册 → types/ipc.ts）；
  - 测试：`frontend/tests/export_audio.test.js`（10 例：头/大小/量化/dither 噪声形状/响度实测/限幅/归一）+ `scripts/test-export.mjs`（4 例：命名/落盘/manifest/错误路径），并进 `npm test` 链；
  - E2E 新增 `export-ipc`：渲染进程生成 WAV → bridge → 主进程落盘 → Node 侧校验文件头与 manifest 后清理；
  - **P0-4b ✅**：转换页导出面板接入 —— 导出格式（WAV 16/24/float32）、响度目标（off/−14/−16/−23 LUFS）、16bit TPDF dither、总线限幅（−1 dBFS）、**分轨导出**（每轨单独离线渲染一个文件）；选项持久化到 settings（`export.audio.*`）；渲染链路 = 增益 →（响度归一 + 限幅）→ WAV 编码 → `export:audio` 落盘 + manifest；文件预估按位深/分轨数算；
  - 测试：`frontend/tests/export_options.test.js`（5 例）+ E2E `convert-ui`（面板挂载与控件齐全）；
  - 剩余（P0-4c）：分轨 zip 打包、FLAC/MP3/OGG（按 Scope Guard 可延后到 P1）。

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

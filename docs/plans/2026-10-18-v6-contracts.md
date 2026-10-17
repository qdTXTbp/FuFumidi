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
| C3 | DocumentSession 文档会话 | `frontend/src/core/session.js`（新） | W0 待实现（接口冻结） | 编辑/调教/谱面/歌词；自动保存/恢复 |
| C4 | TimelineModel 时间轴模型 | `frontend/src/core/midi.js`（扩展）+ `core/timeline.js`（新） | W0 待实现（接口冻结） | 编辑器/编排时间线/调教/可视化 |
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

# V0.3 基线探针实测报告（2026-11-15）

## 目的

`docs/audit/2026-10-29/midi-workflow.md` 与 `docs/plans/2026-10-30-completion-matrix.md` 把
F-05 / F-06 / F-07 / P1-7 记为「未做」，而 `README` 6.3.1 与当前代码声称已修。
两份材料评估的是 **6.3.1 之前的本机安装版**，与当前工作区（6.7.0-beta.1）不是同一份代码。

本轮不判断实现好坏，只做一件事：**给四条争议项各留一条可复现的当前行为断言**，
让后续讨论有代码事实可依，不再靠文档互相引用。任务来源：
`docs/plans/2026-11-15-workstation-roadmap.md` 的 WP 0.3。

## 环境与方法

| 项 | 值 |
|---|---|
| 环境 | Windows / Node v22.22.2 |
| 方式 | `node:test` 纯逻辑断言，无浏览器、无音频设备、不发声 |
| 探针文件 | `frontend/tests/baseline-probe.test.js`（11 条） |
| 单文件 | `node --test frontend/tests/baseline-probe.test.js` → **11/11 通过** |
| 全量回归 | `npm run test:ui` → **646/646 通过**（新增探针未影响存量） |

探针只断言**当前代码的行为**，其中两条刻意断言「缺口仍存在」，作为留档证据；
将来实现变了，探针会红并提示更新口径，这正是它的用途。

## 结论总表

| 争议项 | 旧审计口径 | README 6.3.1 | 当前代码实测 | 结论 |
|---|---|---|---|---|
| F-05 编排片段参与播放 | 未做 | 已修 | 4 条通过 | **已修**，旧台账过期 |
| F-06 内置音色 CC / 弯音静默 | 未做 | 已修 | 3 条通过 | **已修（SF2 路径）**；内置合成器路径另有一套部分实现，见下 |
| F-07 乐谱跨小节时值 / 连音线 | 未做 | 已修 | 1 条通过 | **ABC 记谱路径已修**；MusicXML / Verovio 路径未覆盖 |
| L5 混音粒度（P1-7） | 未做、同通道多轨分不开 | — | 3 条通过 | **表述不准确**：内置合成器路径本就每轨独立；只有 SF2 路径是通道级 |

## 逐项证据

### F-05 · 编排 clip 是播放真源

`core/player.js:99-138` 在 `prepare()` 里读 `song.arrange.clips` / `arrange.tracks`，
按 clip 的 `startTick / endTick / offsetTick` 与轨道 mute / solo 过滤并重排音符；
`views/ViewConvert.vue:23` 引入 `clipsRenderJobs, readArrangeFromSong`，导出同样吃 arrange。

| 用例 | 断言 | 结果 |
|---|---|---|
| F-05-a | 无 arrange 时仍走旧路径，3 个音符全在 | 通过 |
| F-05-b | clip 移到 1920tick 且长 960tick：只保留源区间内 1 个音，起点变 1920 | 通过 |
| F-05-c | 裁剪到 480tick → 1 个音；编排轨 mute → 0 个音 | 通过 |
| F-05-d | clip 自身 muted → 0；存在 solo 轨时非 solo 轨不发声 | 通过 |

### F-06 · CC 与弯音有下发路径

`core/synth.js:797-843` 的 `midiEvent()` 处理 CC7 / CC10（记为文件基准并叠加到通道混音）、
CC11 / CC64 / 任意 CC（`_sendCcAt`）与 bend（`_sendBendAt`）；
`core/player.js:169-200` 把文件里的 `tr.ccs` / `tr.events` 排进 `ctlEvents` 与分通道基线表。

| 用例 | 断言 | 结果 |
|---|---|---|
| F-06-a | CC7 → `_fileCc7[2]=100` 且触发通道增益；CC10 → `_fileCc10[2]=40` 且触发声像 | 通过 |
| F-06-b | CC11 / CC64 走 `_sendCcAt`，bend 走 `_sendBendAt`，均不再静默丢弃 | 通过 |
| F-06-c | 播放器的 `ctlEvents` 按时间排好 CC11 / bend / CC64 下 / CC64 上 | 通过 |

**边界**：上述是 **SF2 / 音色库路径**。内置合成器路径另用
`_internalCc7 / _internalCc11 / _internalBend`（`core/synth.js:389-392`），
代码注释自述「仅 CC7/CC11 在当前实现里可听」，本探针未覆盖，也未做听感验证。
「已修」指有可验证的下发路径，不等于所有音色下听感一致。

### F-07 · 跨小节连音线

`core/score.js:77-114` 的 `abcVoiceBars()` 把长音按小节切块（`tieOut`），
在跨小节且不是最后一小节时给 ABC 文本追加 `-`。探针构造 4/4、一个 `0→3840tick`（跨两小节）的长音，
`songToAbc()` 输出的正文行包含 `-` 与小节分隔符 `|` → 通过。

**边界**：只覆盖 `core/score.js` 的 **ABC 记谱路径**。
README 6.3.1 说的是「cross-measure MusicXML ties」，而旧审计 F-07 指向 Verovio 制谱
（「仍只画起始小节」）。MusicXML 导入 / Verovio 渲染是否修好，**本探针没有结论**，
需要在乐谱页用真实 MusicXML 做一次 UI 实测；不要拿这条通过去关闭 F-07。

### L5 · 混音粒度（本轮最重要的校正）

`core/synth.js` 里存在**两套并存**的混音模型，旧审计把两者混为一谈：

| 路径 | 实现 | 粒度 |
|---|---|---|
| 内置合成器 | `ensure(n)` 为每轨建独立 `GainNode` + `StereoPanner` 接 master（`:734-751`）；`setTrackVol/Mute/Solo/Pan`（`:754-757`） | **按轨** |
| SF2 / 音色库 | 输出只有一路混合节点，改用 MIDI CC7 / CC10 下发；`setChannelVol(ch, ...)`（`:844-903`） | **按通道** |

UI 侧 `components/PlayerBar.vue:352-356`、`views/ViewPlay.vue:80-84`、`stores/app.ts:1239-1284`
都已接 `setTrack*`。

| 用例 | 断言 | 结果 |
|---|---|---|
| L5-a | `setTrackVol(1, 0.3)` 只改第 1 轨增益，第 0 轨保持 1 | 通过 |
| L5-b | `setTrackMute(1, true)` 把该轨拉到 0，另一轨不变；四个轨道级 API 都在 | 通过 |
| L5-c | `setChannelVol(5, 0.5)` 第一参数是 MIDI 通道，改动落在整条通道 | 通过 |

**结论**：「同通道多轨分不开」只在 **SF2 路径**成立，且注释已说明是架构性限制
（一路输出，无法在 Web Audio 层按轨插增益），不是简单漏做。
P1-7 若继续排工，应改写为「SF2 路径的每轨增益」或「混音台明确区分两种模式并提示限制」，
而不是笼统的「per-track/per-channel 未做」。

## 对既有文档的影响

1. `docs/plans/2026-10-30-completion-matrix.md` 第三节「下一步顺序」第 1 项列的
   「F-05 编排入播放、F-06 内置 CC、F-07 乐谱」中，前两项在当前代码已完成，第三项部分完成；
   **继续照该顺序排工会重复劳动**。已在同文件追加第四节校正，原表格不改，保留历史口径。
2. `docs/plans/2026-11-15-workstation-roadmap.md` 的 WP 0.3 标记为完成；V1 的优先级不变
   （统一工程模型仍是主线），但 V1.2 里的「轨道 CRUD」应理解为**MIDI 编辑页**缺，
   不是全局没有轨道模型。
3. F-07 与 L5-SF2 两项留给 UI 实测，不因本探针通过而关闭。

## 复现

```bash
node --test frontend/tests/baseline-probe.test.js   # 11/11
npm run test:ui                                     # 646/646
```

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-15 | 首版。新增 11 条基线探针，校正 F-05 / F-06 / L5 口径，标注 F-07 的覆盖边界。 |

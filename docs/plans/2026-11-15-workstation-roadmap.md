# FuFumidi 工作站路线规划（2026-11-15）

> 本文回答「在既定方向下，接下来按什么顺序做」。
> 定位前提沿用 2026-10-03 决策：**补「工程 / 轨道 / 导出」层，不削 AI 歌声，不做通用 DAW**。
> 任务池继承 `docs/audit/2026-10-29/midi-workflow.md` 第 7 节三期路线与 `docs/plans/2026-10-30-completion-matrix.md`；
> 本文只做**基线校正、排序、工作包拆分、退出条件**，不另起一套方案。

---

## 0. 决策边界

### 0.1 目标定位

**DAW 上游的离线 MIDI / 歌声工作站**：在这儿完成转录、调教、编辑、制谱，产物带进 Cubase / Studio One / Bitwig 完成混音与母带。
衡量标准是「导出的东西能被下游 DAW 无损接住」和「一首曲子能在本产品里从零做到可交付」，不是「能不能替代 Cubase」。

### 0.2 明确的非目标（本规划周期内不动）

| 非目标 | 理由 | 出处 |
|---|---|---|
| 多轨音频录制 / 音频波形剪辑 / time-stretch | 与 MIDI 工作流定位冲突，交给下游 DAW | `midi-workflow.md:488` |
| 实时 VST / AU / CLAP 宿主 | 另一个产品的工程量；离线 VST3 试验保留 | `midi-workflow.md:487`、`plugins.md` |
| ASIO / WASAPI 原生低延迟 I/O | 已在 2026-10-18 由用户明确排除 | `v6-completion-audit.md:68` |
| Dorico / MuseScore 级排版引擎 | Verovio 用到极致即可 | `midi-workflow.md:486` |
| MIDI 2.0 / UMP 全面接入 | 收益小于 MPE 与 CC 体系完善 | `midi-workflow.md:489` |
| macOS / Linux 正式构建、Authenticode 证书 | 2026-10-18 明确排除；**若定位改为商用 DAW 需重新拍板** | `v6-completion-audit.md:66-67` |

> ⚠️ 上一组排除项中的「证书 / 多平台 / 原生 I/O」是**商用 DAW 的入场券**，不是本项目目标的入场券。
> 只要定位仍是「上游工作站」，排除成立；一旦改成「完整商用 DAW」，本节整体作废、需重做规划。

### 0.3 需用户拍板的两件事

1. **授权模式**：继续 MIT 全免费，还是引入激活 / 试用 / 付费？决定 V3 是否需要做授权体系。
2. **DAWproject 要不要做成双向**：只做「导出子集」并写进文档，还是投入实机验证 + 导入？决定 V2 工作量。

**已拍板（2026-11-15）**：原第 3 项「导出格式兑现方式」用户选择 **「都要」** ——
既补 MP3 / FLAC / OGG 编码让宣传成真，也把全仓文案对齐。V0.2 已完成，
见 `docs/test-reports/2026-11-15-v0.2-audio-formats.md`。

---

## 1. 现状基线（以当前代码为准）

### 1.1 对旧审计的校正（重要）

`docs/plans/2026-10-30-completion-matrix.md` 与 `docs/audit/2026-10-29/midi-workflow.md` 评估的是 **6.3.1 之前的本机安装版**。以下条目在**当前工作区代码**里已经不是那个状态，规划不得再按「未做」排工：

| 条目 | 旧审计口径 | 当前代码事实 | 证据 |
|---|---|---|---|
| F-05 编排片段参与播放 | 未做 | **已修**：`core/player.js` 注释明确「编排页的 clip 是播放的真源」，按 `arrange.clips` / `arrange.tracks` 的 solo/mute/offset 过滤并移位音符；导出侧 `ViewConvert.vue` 已引入 `clipsRenderJobs, readArrangeFromSong` | `core/player.js:99-126`、`views/ViewConvert.vue:23` |
| F-06 内置音色 CC 静默 | 未做 | **部分修**：内置合成器通道级 CC 状态、文件事件注入 CC7 / CC10 / CC11 / CC64 / 弯音；SF2 路径走完整 CC | `core/synth.js:389-396, 793-850` |
| 工程格式 | 只服务歌声工作台 | 仍成立，但格式本身已含多点变速 `tempoMap` / 拍号 `sigMap` / 自动化片段白名单 | `core/song_project.js:1-38, 53-94` |
| 轨道增删改排 | 无 | **歌声侧有**（`ViewSing.vue` 有新建 / 重命名 / 删除），**MIDI 编辑侧仍无** | `stores/singer.ts:667-675`、`views/ViewSing.vue:2317-2410`；`views/ViewEdit.vue` 无命中 |
| 拍号编辑 | 无 | 数据结构与序列化齐全，编辑页仍只按 `sigMap[0]` 计算，无编辑入口 | `views/ViewEdit.vue:193,199,348,362` |
| DAWproject | 导出子集 | 仍成立：**单向导出**、音符轨子集、无导入、无实机验证 | `views/ViewConvert.vue:405-420`、`core/dawproject.js` |
| 导出格式 | WAV 3 档 | 仍成立，且 **README / 官网宣称 WAV/MP3/OGG 与代码不符** | `core/export_options.js:9-13` vs `README-CN.md:30` |

**结论**：上一轮盘点给出的「四条地基缺口」里，「时间线不是播放真源」这一条**已经不成立**；
「工程层割裂」依然成立，但性质从「什么都没有」变成「**两套各自完整、互不相通的模型**」。这是本规划真正的起点。

### 1.2 结构性诊断：两套工程 / 两条时间线

| | 歌声工作台 | MIDI 编辑 / 编排侧 |
|---|---|---|
| 工程持久化 | `.fufumidi`（zip + project.json + files/），`stores/singer.ts` 的 `saveProject/openProject` | **无**，状态在 `stores/app.ts` 内存 + 曲库 |
| 轨道模型 | `SingTrack`（声部轨 + 伴奏音频轨），有 CRUD | `song.tracks`，由导入 MIDI 的通道派生，无 CRUD |
| 时间线 | `components/sing/ArrangeView.vue`，自动化片段（6.6.3 已接播放 + 导出） | `views/ViewArrange.vue` + `core/arrange.js`，MIDI clip 已接播放 + 导出 |
| 撤销 | `song_history.js` / 快照栈 | 另一套快照栈，标签隔离 |
| 工程入口 | 首页 / 演唱页「打开工程」、Ctrl+S | 无保存入口，靠曲库与最近项 |

两边的时间线**都已各自接通播放与导出**，但 clip 模型、撤销栈、工程文件、轨道模型各一套。
继续给任一侧加功能只会放大这个裂缝；本规划的主线是**收敛**，不是加功能。

### 1.3 工作区状态（规划起点）

- `HEAD` = `9ae64f8` 6.6.2；`package.json` 版本 **6.7.0-beta.1**。
- **33 个文件未提交**（+1291 / −198），`changelog.js` 已写入 **6.6.3**（编排自动化片段、参数化 MIDI 工具、引擎子进程守护、启动闪屏）与 **6.7.0-beta.1**（阻尼弹簧动效、连续曲率圆角、Electron 38）两版条目，但两者都**尚未形成提交**。
- 另有 `engine/._pt_*` 历史临时目录被删除 / 权限报错（`Permission denied`），属既有污染，提交前需确认 files 白名单排除目录本身（见长期笔记第 5 节）。
- ⚠️ **V0 完成前不启动任何新功能开发**；在途改动由用户确认后再提交，本规划不代为执行 `git add` / `git commit`。

---

## 2. 目标态（四个阶段之后）

1. 打开 / 保存一个 `.fufumidi`，**同时**包含 MIDI 编排与歌声调教，不再分两个工作台两套文件。
2. 在 MIDI 编辑页可以新建 / 删除 / 改名 / 重排轨道、编辑拍号与变速、用标尺点击定位和拖拽循环区间。
3. 移动 / 裁剪 / 静音任一 clip，播放与所有导出路径同步变化，且能用一次 Ctrl+Z 还原。
4. 导出到下游 DAW 后，音符、速度、拍号、标记、分轨都能对上；导出的音频格式与对外宣传一致。
5. 质量门禁覆盖 CI 与安装版冒烟，崩溃与失败有日志可查。

**不承诺**：实时插件监听、多轨录音、低延迟原生 I/O、跨平台正式包。

---

## 3. 工作包与阶段

节奏按现有发布节奏推进，用**退出条件**而不是日历时间卡点。版本号为建议，可调整。

### V0 · 收口（建议 6.7.0 正式版）— 不新增功能

| WP | 内容 | 改动落点 | 验收 / 退出条件 |
|---|---|---|---|
| 0.1 | 在途改动固化（**2026-11-15 已完成，本地提交未 push**） | 6.6.3 与 6.7.0-beta.1 连同 V0.2/V0.3 收为一个本地提交（两组改动在 `main.js` / `preload.js` 等文件上按 hunk 重叠，拆分会产生不可单独构建的中间提交） | 门禁全绿；**安装版冒烟未做**，留 0.4。**排除**：含明文凭据的 `scripts/publish-*.js`、`release-*` 构建目录、`engine/._pt_*` 残留删除，详见 `docs/plans/2026-11-15-v0.1-commit-and-security.md` |
| 0.2 | 口径校正（**2026-11-15 已完成**） | 用户拍板「都要」：补齐 FLAC / MP3 / OGG 编码 **且** 对齐全仓文案。新增 `main/audio-encode.js`，主进程用包内 ffmpeg 从 24-bit WAV 母版转码 | 结果见 `docs/test-reports/2026-11-15-v0.2-audio-formats.md`：真实转码三种格式成功、9 项门禁全绿、README 中英文 4 处与 settings 注释已对齐；官网无格式列表、changelog 属历史不回写 |
| 0.3 | 争议项实测留证（**2026-11-15 已完成**） | 新增 `frontend/tests/baseline-probe.test.js` 11 条 | 结果见 `docs/test-reports/2026-11-15-v0-baseline-probe.md`：探针 11/11、`npm run test:ui` 646/646。**F-05 / F-06 已修；F-07 仅 ABC 路径已修，MusicXML / Verovio 待 UI 实测；L5 需按「内置合成器按轨 / SF2 按通道」两条路径拆开**。已回填 `completion-matrix.md` 第四节 |
| 0.4 | 发布链路复核 | `release/update-manifest.json` 签名、`build-release.ps1`、CNB / GitHub 双端资产 | 按长期笔记第 5 节手动重签 Ed25519 清单；双端 8/8 sha256 一致 |

**退出条件**：工作区干净、文档与代码一致、门禁绿、在途两版已发布或明确并入下一版。

### V1 · 统一工程与时间线（核心，建议 6.8.0）

这是全规划最重的一段，**必须先于任何互操作 / 商用硬化**，否则后续工作全部建立在两套模型上。

| WP | 内容 | 改动落点 | 验收 / 退出条件 |
|---|---|---|---|
| 1.1 | 工程格式 v2：把 MIDI song 纳入 `.fufumidi` | `core/song_project.js`（白名单扩字段、FORMAT_VERSION → 2、v1 兼容回落）、`main/project.js` | v1 工程能打开且播放结果不变；v2 工程含 `song.tracks` / `arrange` / `tempoMap` / `sigMap`；换机器打开无绝对路径断链 |
| 1.2 | MIDI 侧轨道 CRUD + 拍号 / 变速编辑 + 标尺 | `views/ViewEdit.vue`、`components/EditorCanvas.vue`、`core/timeline.js`、`core/frame_snap.js` | 新建 / 删除 / 改名 / 拖排轨道；在播放头插入 3/4 后小节线即时重排；卷帘有标尺、点击定位、Shift 拖画循环 |
| 1.3 | 收敛两条时间线 | `core/arrange.js`、`components/sing/ArrangeView.vue`、`views/ViewArrange.vue`、`core/song_history.js` / `history_stack.js`、`core/sing_transport.js` | 统一 clip 模型；两侧片段共用一套撤销栈（移动片段一次 Ctrl+Z 还原）；**6.6.3 的自动化片段淡入淡出 / 循环 / 播放与导出行为零回归**（`sing_transport.test.js` 全绿） |
| 1.4 | 工程入口统一 | `views/ViewHome.vue`、`views/ViewEdit.vue`、`stores/app.ts` / `stores/singer.ts`、`main/hotkeys.js` | 编辑页 Ctrl+S 保存到当前 `.fufumidi`；首页「新建空白工程」能建出一首无音符的多轨曲；关闭时有未保存提示 |

**风险**：1.3 会碰 6.6.3 刚交付的自动化片段与 `sing_transport.js`，是全规划回归风险最高的一处，需先补快照测试再重构。
**退出条件**：一首曲子从空白工程开始，做到 MIDI + 歌声 + 自动化片段，保存、关闭、重开，播放与导出结果完全一致。

### V2 · 互操作与导出（建议 6.9.0）

| WP | 内容 | 改动落点 | 验收 / 退出条件 |
|---|---|---|---|
| 2.1 | DAWproject 补完 | `core/dawproject.js`、`main/dawproject.js`、`views/ViewConvert.vue`、`docs/dawproject/` | 依 0.3 拍板：要么「导出子集」写进产品文案并保留 XSD 校验；要么导入 + 至少一款 DAW 实机往返验证 |
| 2.2 | MusicXML 单一解析器 | `core/score.js`、`views/ViewScoreConvert.vue`、`views/ViewScore.vue`、`engine/` 解析结果 | 同一 `.musicxml` 在变谱页与乐谱页导入得到相同 MIDI（往返测试）；修 `midi-workflow.md:406` 简谱/TAB 网格口径不一致 |
| 2.3 | 导出一致性 | `core/export_options.js`、`main/export.js`、`views/ViewConvert.vue` | 依 0.3 拍板补 MP3/FLAC 或收回宣传；补导出选区 / 循环区间（`midi-workflow.md` K2/K3）；估时跟随实际采样率（P2-12） |
| 2.4 | 分轨与 stems 完善 | `main/export.js` 的 `export:stems-zip`、`core/arrange.js` 的 `clipsRenderJobs` | 按轨导出 MIDI / WAV 与工程内轨道名、顺序、静音状态一致；marker 随 MIDI 导出 |

**退出条件**：把一首 V1 做的曲子导出到至少一款下游 DAW，音符 / 速度 / 拍号 / 标记 / 分轨全部对得上，且不需要手工修补。

### V3 · 商用硬化（建议 7.0.0）

| WP | 内容 | 改动落点 | 验收 / 退出条件 |
|---|---|---|---|
| 3.1 | 质量债 | `main/` 空 catch、`scripts/check-empty-catch.cjs`、`main/log.js`、`.github/workflows/ci.yml` | 611 个 pytest 进 CI（或明确白名单）；空 catch 增量归零且存量下降；关键路径有持久日志 |
| 3.2 | 包体与运行时 | `scripts/bundle-python312.js`、`main.js`、`electron-builder*.yml`（`docs/backlog.md` E1） | 两份 Python 合并为 3.12，先 A/B 再替换；安装体积下降；四条 GPU 路径（CUDA / DirectML / XPU / ROCm）冒烟通过 |
| 3.3 | 崩溃与反馈闭环 | `main/feedback.js`、`main/diagnostics.js`、`main/engine.js` | 引擎崩溃有日志、有熔断原因、诊断包能带上相关日志；用户反馈能定位到版本与阶段 |
| 3.4 | 授权与发行（**待拍板**） | `main/`、`main/update.js`、`docs/VENDOR.md` | 若继续免费：把「免费 / 离线 / 第三方许可」在产品内写清；若引入授权：激活、试用、离线宽限、更新验签联动 |

**退出条件**：干净 Win11 虚拟机从安装到完成一次「转录 → 编辑 → 调教 → 导出」全流程，0 未捕获异常，日志可回溯。

---

## 4. 排序原则与依赖

```
V0 收口 ──> V1 统一工程/时间线 ──> V2 互操作 ──> V3 商用硬化
              (最重、回归风险最高)      (依赖 V1 的单一模型)   (依赖前两阶段稳定)
```

- **V1 不可跳过**：DAWproject / MusicXML / stems 的往返正确性都依赖「一个工程模型」，在两套模型上做互操作等于做两遍且必然漂移。
- **V0 不可跳过**：`HEAD` 落后工作区两版，带着 33 个未提交文件开工，出问题时无法二分定位。
- 10-29 三期路线里的「手感类」任务（量化体系 C1~C4、Groove C3/C5、快捷键可配置 B1~B3、CC 体系 D3~D5）**穿插在 V1.2 与 V2 之间按回归风险安排**，不单独设阶段；它们不改数据模型，可并行。
- 明确的降级项（制谱校对闭环 I1~I5）：若 Verovio 做不到可点击校对，按 `midi-workflow.md:475` 把产品文案降级为「音高视图」，不硬撑「乐谱编辑」。

---

## 5. 每阶段发布检查表（沿用长期笔记第 5 节）

- [ ] 版本四处一致，`check:version` / `check:i18n`（新文案一律**单引号键**）/ `audit:ui-tokens` 0 基线
- [ ] `npm install` 走 npmmirror；打包前确认 `node_modules` 与 lock 对齐
- [ ] `build-release.ps1` 不会重签顶层 `release/update-manifest.json` → 手动跑 `sign-update.mjs`
- [ ] CNB 大资产用 `scripts/cnb-upload.py`，**与 GitHub 大文件串行**，禁止并行 728 MB
- [ ] `engine/._pt_*` 与 `.pytest_cache` 目录本身排除在 files 外
- [ ] 双端 8/8 资产 sha256 一致；安装版部署冒烟通过

---

## 6. 待办清单的单一事实来源

- 任务池：`docs/audit/2026-10-29/midi-workflow.md` 第 7 节（24 项，带验收）
- 完成度台账：`docs/plans/2026-10-30-completion-matrix.md`（每阶段结束时回填，勿另建台账）
- 有实测依据的性能 / 运行时方向：`docs/backlog.md`（A~E）
- 本文只管顺序、收敛主线与退出条件；**不复制任务描述**，避免第三份参数表 / 台账漂移（见 `backend-perf.md` 对「参数表 3 份副本」的批评）

---

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-15 | 首版。基于「距完整商用 DAW 还差什么」全库盘点；按当前代码校正 F-05 / F-06 旧审计口径；把主线从「补地基」改为「收敛两套工程模型」。 |
| 2026-11-15 | WP 0.3 完成：新增 11 条基线探针，实测校正 F-05 / F-06 / F-07 / L5；发现 L5 是两条播放路径，旧审计表述不准确。报告 `docs/test-reports/2026-11-15-v0-baseline-probe.md`，台账 `completion-matrix.md` 第四节。 |
| 2026-11-15 | WP 0.2 完成：待拍板第 3 项定为「都要」。补齐 FLAC / MP3 / OGG 导出（主进程包内 ffmpeg 转码）+ 全仓文案对齐；9 项门禁全绿。报告 `docs/test-reports/2026-11-15-v0.2-audio-formats.md`。 |
| 2026-11-15 | WP 0.1 完成：在途两版 + V0.2/V0.3 收为一个本地提交（未 push）。体检发现 **12 个 CNB 发布脚本硬编码 API token、其中 2 个已被 git 跟踪**，以及 20+ 未忽略的 350MB+ 构建目录；补 `.gitignore` 并排除风险文件。见 `docs/plans/2026-11-15-v0.1-commit-and-security.md`。**V0.4 发布链路复核与安装版冒烟仍未做。** |

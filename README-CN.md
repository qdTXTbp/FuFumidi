# FuFumidi

<p align="center">
  <img src="docs/CN.png" alt="FuFumidi 项目 Logo" />
</p>

<p align="center"><a href="README.md">English</a> | <strong>中文</strong></p>

[项目简介](#项目简介) | [功能特性](#功能特性) | [转录引擎](#转录引擎) | [编辑器](#编辑器) | [播放与可视化](#播放与可视化) | [分析](#分析) | [乐谱](#乐谱) | [转换与视频导出](#转换与视频导出) | [影视配乐](#影视配乐) | [离线运行](#离线运行) | [架构](#架构) | [目录结构](#目录结构) | [快速开始](#快速开始) | [构建与打包](#构建与打包) | [测试](#测试) | [插件](#插件) | [持续集成](#持续集成) | [致谢](#致谢) | [许可](#许可)

---

## 项目简介

FuFumidi 是一款完全离线的 MIDI 桌面工作站，面向音乐人、编曲者、转录师和影视配乐师，目标是把「音频」到「干净、可编辑、可发布的 MIDI / 乐谱」这条链路完整落在本机，全程不联网。

应用基于 Electron 桌面壳 + Vue 3 + TypeScript 渲染层 + 内置 Python 转录运行时，并提供可选的 Rust 核心以加速热点路径。所有音频、模型权重与推理都在本地执行，不上传任何数据。

当前版本线：**3.1.16**。

### 核心能力

- **音频转 MIDI**：三套可切换的本地引擎（通用、钢琴专用、人声分离）。
- **MIDI 编辑器**：完整钢琴卷帘、CC 自动化泳道、鼓组编辑器、宏系统、逻辑编辑器、列表编辑器。
- **播放与可视化**：Synthesia 风格瀑布、频谱、波形、实时和弦识别，支持外接 MIDI 硬件输出。
- **分析**：生成调性、和弦、密度与统计报告。
- **乐谱**：Verovio 制谱、自动谱号与八度、MusicXML 导入、PDF 导出。
- **转换与视频导出**：把 MIDI 渲染为 WAV / MP3 / OGG，或渲染为带可视化画面的 MP4。
- **影视配乐**：SMPTE 时间码、嵌入视频轨道、乐谱与钢琴卷帘双向点击定位。

### 亮点

- 安装后 100% 离线。完整安装包内附带 Python 运行时、全部转录模型与 Demucs 人声分离权重。
- 从原始单文件渲染层重构为 Vue 3 + TypeScript + Vite 现代前端。
- 11 个哈希路由视图，应用内 i18n，10 套内置主题 + 图片提取主色自定义主题，`Ctrl+K` 命令面板，新手引导，主题库，动态壁纸画廊。
- 插件沙箱，第三方代码在独立 worker 中运行。
- 完整性检验与一键修复。
- 可选 Rust 核心（`src-tauri/`）承担性能关键路径。
- 支持 CUDA 与 DirectML GPU 加速，无 GPU 时优雅回退到 CPU。

---

## 功能特性

按主视图梳理，每个视图都可以在侧边栏或命令面板中访问。

| 视图 | 用途 |
| --- | --- |
| 首页 | 歌单、最近文件、快捷操作。 |
| 演奏 | 播放控制、速度、MIDI 输出设备、混音台。 |
| 歌词 | LRC 编辑器，含编码识别与批量替换。 |
| 编辑 | 钢琴卷帘编辑器（详见下文）。 |
| 可视化 | 实时瀑布、频谱、示波器、和弦叠加。 |
| 分析 | 调性、和弦、密度与统计报告。 |
| 乐谱 | Verovio 制谱与 PDF 导出。 |
| 转录 | 音频转 MIDI（详见下文）。 |
| 转换 | MIDI 转音频与 MIDI 转视频。 |
| 资源 | 模型、音色库与素材管理。 |
| 设置 | 外观、引擎、插件、快捷键、语言。 |

---

## 转录引擎

转录支持三种模式与多个子模型，全部跑在内置 Python 运行时上，权重随包或按本地路径解析。

| 模式 | 子模型 | 适用场景 |
| --- | --- | --- |
| 通用 | `basic-pitch`（ONNX int8）、`MuScriptor`（small / medium / large） | 多种乐器的复调素材。 |
| 钢琴 | `piano_pt`、`aria`、`transkun` | 钢琴录音，含踏板检测。 |
| 人声分离 | `demucs`（htdemucs） | 先做人声或分轨再转录。 |

视图内的高级参数包括 onset/frame 阈值、最小音符时值、合并间隔、踏板检测、鼓点抽取、降噪、归一化、自动速度检测、分轨导出（WAV），以及可暂停、可取消、可重排的转录队列。

引擎层被拆分为一组独立 Python 模块，方便单独替换某个 transcriber 而不改动 UI：

- `engine/engine.py` - 引擎入口与分发。
- `engine/engine_basic.py`、`engine/engine_muscriptor.py`、`engine/engine_aria.py`、`engine/engine_pt.py`、`engine/engine_transkun.py`、`engine/engine_separate.py` - 各模型推理实现。
- `engine/engine_gpu.py` - CUDA / DirectML 选择与回退。
- `engine/smart_midi.py` - 转录后修正与智能清理。
- `engine/midi_post.py`、`engine/midi_edit.py` - 编辑器与插件共用的 MIDI 工具。
- `engine/deps.py` - 依赖检测与自动补全。
- `engine/diag.py` - 诊断导出，用于支持反馈。

转录流程由 `engine/tests/` 端到端验证，使用 `data/_test_melody.wav` 与 `data/_test_out.mid` 作为测试素材。

---

## 编辑器

编辑器是应用中体量最大的界面。

- 钢琴卷帘：画笔、选择、橡皮三种工具，吸附粒度从关闭到 1/32。
- 基于全量快照的撤销 / 重做栈，多轨道操作也能一步回退。
- 音符左右边缘拉伸，独立调整起点与时长。
- 力度曲线编辑器：在选区上绘制包络后应用，支持连续插值画线。
- CC 自动化泳道：CC1（调制）、CC7（力度）、CC10（声像）、CC11（表情）、CC64（延音踏板），每条支持手绘 / 直线 / 曲线三种笔刷。
- 鼓组编辑器：29 鼓件 × 8 小节网格，可逐轨显示 / 隐藏。
- Key Switch 可视化与映射：C-2 至 C0 技法命名，内置 Spitfire / VSL / EastWest 预设。
- 智能量化 + Groove：Funk、Jazz、Rock、Latin 与自定义 Groove 模板，可「提取选中为 Groove」。
- 逻辑编辑器：目标 × 条件 × 操作 的批量规则。
- 宏系统：内置宏（清理工程、批量移调、力度标准化）+ 自定义命令宏（本地持久化）。
- 音频对齐：载入原音频后在卷帘底部绘制波形，选区或整轨吸附起音（±80 ms 波形起音检测），可同步试听。
- 智能伴奏：按小节和弦分析自动生成「智能贝斯 + 智能分解和弦 + 智能铺底」三轨。
- 音色工具：GM 音色下拉切换、应用到全部非鼓轨、按音域或名称智能选音色。
- 批量操作：和弦批量选择、删除短于 80 ms 的音符、响度 ±10%、移调 ±1 / ±8 半音。
- 编辑器内添加歌词：为选中音符写入 lyric 事件。
- 全屏编辑、属性检查器、帮助弹窗，`Ctrl+S` 走原生保存对话框导出 MIDI。

---

## 播放与可视化

- 通过 js-synthesizer + FluidSynth + GeneralUser.sf2 实现 Web Audio 合成与桌面 MIDI 输出。
- 通过 `navigator.requestMIDIAccess` 选择外接 MIDI 设备，播放时同步发送 NoteOn / NoteOff，停止时发送 All Notes Off 防止卡音。
- 速度倍率与 BPM 双向联动：BPM = 原速 × tempo。
- 混音台弹窗：轨道音量、声像、独奏、静音。
- 四种可视化风格：Synthesia 风格音符瀑布、频谱瀑布、示波器波形、实时和弦识别。
- 仪表盘 / 瀑布布局切换，支持全屏可视化。

---

## 分析

分析视图对当前曲目生成报告。

- 调性检测、和弦检测（按时间轴）。
- 音高、力度、时值分布。
- 时间线密度（每小节音符数、每秒音符数）。
- 自然语言总结，可直接粘贴到简报或字幕中。

分析逻辑分为两层：`frontend/src/core/analysis.js` 负责报告组装，`engine/music2midi.py` 负责供转录使用的特征提取。

---

## 乐谱

- 基于 Verovio 的制谱，自动放置谱号、8va、8vb 与 15ma。
- 和弦标记、歌词、段落记号。
- 乐谱与钢琴卷帘同步：点击乐谱音符，播放头与卷帘光标一起跳转。
- 通过 `frontend/src/core/musicxml.js` 解析 MusicXML，支持多 part、拍号、调号、装饰音。
- 通过 `printToPDF` 导出 PDF，并提供逐页 SVG 栅格化为 PNG 的分页预览。
- 乐谱与钢琴卷帘分屏预览。

---

## 转换与视频导出

`ViewConvert` 负责把 MIDI 反向渲染为音频或视频。

音频导出支持 WAV、MP3、OGG，可选 26 种音色（钢琴、电钢、管风琴、弦乐、铜管、长笛、吉他、贝斯、主音合成、铺底、小提琴、大提琴、竖琴、马林巴、八音盒、颤音琴、人声合唱、小号、萨克斯、单簧管、双簧管、尼龙吉他、钢弦吉他、合成贝斯、钟琴、手风琴、班卓琴），另有一个自动模式按 GM 音色号自动匹配。可调速度倍率、采样率、增益，并支持整首或指定区间渲染。

音频渲染实现为分桶离线合成（`renderAudioBuffer`），避免为长曲目创建单个巨大 `OfflineAudioContext`。

视频导出使用 `canvas.captureStream` + `MediaRecorder` 录制可视化画布，然后通过内置 ffmpeg（`video:transcode` 桥接）合成 MP4 并叠加渲染音频。可选项：

- 画面比例：横屏 / 竖屏 / 字幕留白。
- 分辨率：720p 至 4K。
- 帧率：24 / 30 / 60 fps。
- 质量预设或自定义码率。
- 时长：15 / 30 / 60 秒 / 整首 / 自定义区间。
- 背景：纯色或图片。
- 水印与透明度。
- 歌词字幕、进度条、时间码开关。

视频内使用的可视化与播放时一致，同一份渲染代码同时服务于屏幕播放与离线录制。

---

## 影视配乐

- SMPTE 时间码显示与播放同步。
- 嵌入视频轨道并同步播放，视频固定在编辑区右上角。
- 点击定位：点击乐谱或钢琴卷帘上的音符，视频头跳到对应时间码。

---

## 离线运行

- 完整安装包附带 Python 运行时、全部转录模型与 Demucs 权重，安装后不再需要联网。
- 基础安装包仅包含 basic-pitch 模型，其余模型首次使用时按需下载，体积更小。
- `engine/deps.py` 在启动时执行依赖检测，可自动补全缺失依赖。
- 启动时后台执行完整性检验，若有缺失会在设置视图显示警告条并提供一键修复。
- SQLite 数据库（`main/db.js`）持久化设置、歌单与插件状态。
- 壁纸、视频壁纸、音色库随安装包分发。

---

## 架构

FuFumidi 由三个进程组成。

- **主进程**（`main.js`、`preload.js`、`main/`）
  Electron 主进程、IPC 路由、对话框、设置、歌单、数据库、更新器、视频转码桥接、壁纸服务与插件宿主。
- **渲染进程**（`frontend/`）
  由 Vite 构建到 `renderer/dist` 的 Vue 3 应用。状态由 Pinia store 管理（`stores/app.ts`、`stores/playlist.ts`、`stores/settings.ts`）。视图放在 `views/`，可复用组件放在 `components/`，音频 / MIDI / 分析 / 制谱核心放在 `core/`。
- **Python 引擎**（`engine/`）
  转录与音频工具层。通过 JSON 协议调用，渲染层只需 `bridge.convert` / `bridge.engine.run` 即可。

可选加速：

- **Rust 核心**（`rust-core/`、`src-tauri/`）：Tauri v2 壳与本地库 `fufumidi_lib`，承担性能关键路径。通过 `npm run build:rust` 构建，`npm run test:rust` 验证。
- **GPU 运行时**（`engine/engine_gpu.py`、`main/gpu.js`、`main/gpu-ipc.js`）：根据本地驱动选择 CUDA 或 DirectML，均不可用时回退到 CPU。
- **插件系统**（`plugins/`、`plugin-host.js`、`plugin-worker.js`）：每个插件运行在独立 worker 内，拥有受限的 API。

---

## 目录结构

```
FuFumidi/
  main.js                 Electron 主入口
  preload.js              渲染层与主进程的安全桥接
  main/                   主进程模块（engine、gpu、db、plugins 等）
  frontend/               Vue 3 + TypeScript 渲染层
    src/
      views/              每个应用视图对应一个组件
      components/         可复用 UI（PianoRoll、EditorCanvas、PlayerBar 等）
      core/               MIDI、合成、播放、分析、制谱、可视化、i18n
      stores/             Pinia 状态
      bridge/             Electron 桥接适配
      assets/             Logo 与共享图片
  renderer/               渲染层构建产物与 vendor 资源（音色库、js-synthesizer、abcjs、verovio）
  engine/                 Python 转录引擎、模型、ffmpeg 封装、MIDI 工具
    tests/                引擎测试与 wav / midi 测试素材
  plugins/                内置插件与插件开发指南
  src-tauri/              可选 Rust 路径使用的 Tauri v2 壳
  rust-core/              Tauri 壳使用的 Rust 库
  build/                  图标、kachina 配置、安装包素材
  scripts/                构建与校验脚本
  .github/workflows/      CI 流水线
  docs/                   语言相关 README 素材（EN.png、CN.png）
```

---

## 快速开始

### 前置条件

- Windows 10 / 11、macOS 12+ 或较新的 Linux 桌面。
- Node.js 20+ 与 npm。
- Python 3.11（推荐用于人声分离模式）或 Python 3.13（更精简）。缺失的依赖可用 `engine/deps.py` 检测并补全。
- 可选：Rust 工具链（`rustc` / `cargo`），用于 `npm run build:rust`。
- 可选：CUDA toolkit 或 WSL + MSVC 用于 GPU 构建；Rust 核心需要 MSVC。

### 安装

从 Releases 页下载安装包：

- **完整安装包** - 包含 Python 运行时、全部转录模型与 Demucs 权重，推荐用于离线环境。
- **基础安装包** - 仅 basic-pitch 模型，其余模型首次使用时按需下载。

首次启动会执行完整性检验，缺失项会提示修复。

### 从源码运行

```bash
cd frontend
npm install
npm run build

cd ..
npm install
npm start
```

`npm start` 会以刚构建的渲染层启动 Electron。Python 引擎通过安装包相同的 `engine/deps.py` 逻辑解析，指向一个装好转录依赖的 Python 3.11 或 3.13 环境即可。

---

## 构建与打包

```bash
# 前端
cd frontend && npm install && npm run build
cd ..

# 桌面端依赖
npm install

# 完整安装包（Python + 全部模型）
npm run dist:win

# 基础安装包（仅 basic-pitch）
electron-builder --config electron-builder.base.yml

# 源码归档（7z -mx9）
npm run pack:source

# Rust 核心
npm run build:rust
```

运行任一安装命令前，请把大体量二进制放到约定位置。构建脚本默认查找：

- `resources/` - Python 运行时、`elevate.exe` 与各平台辅助程序。
- `models/` - 转录模型权重（basic-pitch、钢琴转录器、Demucs）。

`resources/` 与 `models/` 已在 `.gitignore` 中排除，避免大文件进入版本库。

`engine/deps.py` 可单独执行以检测并修复 Python 环境：

```bash
python engine/deps.py
```

---

## 测试

```bash
# Rust 核心
npm run test:rust

# 前端单元测试（宏、i18n、工具函数）
npm run test:ui

# 插件沙箱
npm run test:plugin

# 全部测试
npm run test

# 前端类型检查
npm run typecheck

# 引擎测试
cd engine && pytest
```

`engine/tests/` 覆盖音频 I/O、引擎配置、MIDI 后处理与预设，配合仓库内的测试素材运行。

---

## 插件

FuFumidi 支持以插件形式扩展第三方能力，无需改动主程序。一个插件 = 一个目录 + `plugin.json` 清单 + 入口脚本。完整开发文档见 `plugins/plugin-dev.html`，简明索引见 `plugins/README.md`。

内置示例：

- `plugins/example-hello/` - 最小 hello-world 示例。
- `plugins/beat-detect/` - 对当前曲目做节拍检测。
- `plugins/midi-stats/` - 输出当前 MIDI 文件的统计信息。
- `plugins/batch-rename/` - 批量重命名导入文件。

每个插件在独立 worker 中运行，获得一个受限的 `ctx` 对象，暴露 `commands`、`events`、`engine.run`、`settings`、`ui`、`log` 与 `app.getSongMeta`。引擎调用与内置转录共用同一套 Python 运行时，因此插件可以复用 `engine/` 下的任意脚本。

---

## 持续集成

- `.github/workflows/ci.yml` - 代码检查与测试。
- `.github/workflows/build.yml` - 在 Windows / macOS / Linux 上构建前端与 asar。
- `.github/workflows/build-installers.yml` - 生成各平台安装包。
- `.github/workflows/test-installers.yml` - 安装产物并跑冒烟测试。

编码规范见 `.github/CODING_GUIDELINES.md`。


## 许可

MIT

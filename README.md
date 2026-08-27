# FuFumidi

> 离线 MIDI 播放 / 编辑 / 可视化 / 分析 / 乐谱 / 转录（音频转 MIDI）一体工具
> Offline MIDI player / editor / visualization / analysis / score / transcription (audio-to-MIDI) all-in-one tool.

FuFumidi is a fully offline desktop application designed for musicians, arrangers, and film composers. It combines transcription, editing, visualization, score rendering, and export in one lightweight workflow. No internet connection is required after installation.

FuFumidi 是一款完全离线的桌面应用，面向音乐人、编曲者和影视配乐师。它将转录、编辑、可视化、乐谱渲染和导出整合为一条轻量工作流。安装后无需联网。

> **当前版本：3.0.0**
>
> - 内置 Python 运行时、转录模型、Demucs 人声分离权重
> - Vue 3 + TypeScript 重构前端
> - 动态壁纸、插件沙箱、Rust 核心可选增强
> - 特别鸣谢 **monologue82（B站用户：骄傲的狼W0R）** 的前端设计与前端代码重构

---

## Features / 功能特性

### 🎵 Transcription / 音频转 MIDI
- Universal transcription with basic-pitch (ONNX int8)
- Piano-specialized transcription (CRNN, pedal detection)
- Vocal separation with Demucs
- Local processing, audio never uploaded
- 通用转录（basic-pitch ONNX int8）
- 钢琴专用转录（CRNN，含踏板检测）
- Demucs 人声分离
- 全程本地处理，音频不会上传

### 🎹 Editor / 编辑器
- Piano roll with pencil / select / eraser tools
- CC automation lanes (CC1/CC7/CC10/CC11/CC64) with freehand / line / curve drawing
- Key Switch visualization and mapping (Spitfire / VSL / EastWest presets)
- Logic editor (batch rules), list editor, macro system (preset / custom / recorder)
- Smart quantize with Groove templates
- Drum editor, fullscreen mode, side inspector
- 钢琴卷帘：画笔 / 选择 / 橡皮
- CC 自动化泳道：手绘 / 直线 / 曲线
- Key Switch 可视化与映射
- 逻辑编辑器、列表编辑器、宏系统（预设 / 自定义 / 录制）
- 智能量化 + Groove 模板
- 鼓组编辑器、全屏模式、属性检查器

### 🎬 Playback & Visualization / 播放与可视化
- Synthesia-style waterfall
- Spectrum / waveform / real-time chord
- Dashboard / waterfall layout switch
- 瀑布流播放
- 频谱 / 波形 / 实时和弦
- 仪表盘 / 瀑布流布局切换

### 📊 Analysis / 分析
- Key detection, pitch / velocity / duration distribution
- Timeline density, chord detection, natural-language summary
- 调性检测、音高 / 力度 / 时值分布
- 时间线密度、和弦检测、自然语言总结

### 🎼 Score / 乐谱
- Verovio engraving, auto clef / 8va / 8vb / 15ma
- Chord markers, lyrics, section marks
- Score sync and split preview
- Verovio 制谱、自动谱号 / 8va / 8vb / 15ma
- 和弦标记、歌词、段落记号
- 乐谱同步与分屏预览

### 🎬 Film Scoring / 影视配乐
- SMPTE timecode display
- Embedded video track with synchronized playback
- Click score notes to locate in piano roll
- SMPTE 时间码显示
- 嵌入视频轨道并同步播放
- 点击谱面音符定位到钢琴卷帘

### 📦 Offline Runtime / 离线运行
- Bundled Python, dependencies, and models
- One-click installer for Windows / macOS / Linux
- Dependency check and auto-repair (`engine/deps.py`)
- 内置 Python、依赖与模型
- Windows / macOS / Linux 一键安装包
- 依赖检测与自动补全

---

## 特别鸣谢 / Special Thanks

- **monologue82（B站用户：骄傲的狼W0R）**
  - 前端设计
  - Vue 3 前端代码重构

---

## Packaging / 打包

| Package | Command | Description |
| --- | --- | --- |
| Full installer | `npm run dist:win` / CI | Full Python + all models |
| Base installer | `electron-builder --config electron-builder.base.yml` | basic-pitch only, on-demand downloads |
| Source archive | `npm run pack:source` | 7z -mx9 |

## CI / 持续集成

`.github/workflows/build.yml` runs on Windows / macOS / Linux to verify dependencies and build asar.

`.github/workflows/build-installers.yml` builds platform installers on GitHub Actions.

## License / 许可

MIT
# FuFumidi

**离线音频转 MIDI 一条龙工具** —— 转录、修正、编辑、演奏、可视化、分析、乐谱，全程本地运行，无需联网。

> 当前版本：**v1.2.1**（Windows / macOS / Linux 安装包，内置 Python 运行时与转录模型）

## 项目简介

FuFumidi 是一款基于 Electron 的**纯离线**音频转 MIDI 桌面应用。音频文件全部在本地处理，**不上传任何数据**。

内置三套完全离线的转录引擎：

- **通用模式**（basic-pitch，ONNX，int8 量化）：适用于人声 / 乐器等通用场景；
- **钢琴模式**（piano-transcription，PyTorch）：钢琴专用，还原力度与踏板；
- **分离模式**（demucs，PyTorch）：先做人声 / 乐器分离，再对分离后的音轨转录。

引擎支持 **GPU 自动检测**（NVIDIA CUDA / AMD·Intel DirectML / CPU 兜底），并提供三档性能模式（quality / balanced / fast），按 CPU 核数与显卡自动推荐档位。

## v1.2.1 新功能

- **MIDI 歌单**：文件 / 文件夹批量导入、收藏、多歌单、拖拽排序，数据存 IndexedDB；
- **编辑器增强**：响度调整、踏板事件、BPM 修改、按轨 / 全局音色、智能配器、原音频波形轨与起音吸附；
- **完整 GM 音色库**：128 个 GM 音色 + 内置 GeneralUser SoundFont（无需外部 SF2/SF3）；
- **乐谱多格式**：五线谱 / 简谱 / 吉他六线谱 / 贝斯四线谱 / 对照；MusicXML 导入；PNG / PDF 导出；
- **批量转录队列**：多文件 / 整个文件夹顺序转录，暂停、继续、重试；
- **插件系统**：自定义视图 / 脚本命令 / 日志；
- **Web MIDI 输出**、**分轨导出**、**智能伴奏**；
- **后台 MP4 导出**：不打断使用、最小化也能继续录制；复用原可视化布局（音符瀑布 + 频谱 / 示波器 / 琴键），H.264 + AAC 音画同步；
- **模型管理**：模型注册表清单，钢琴转录模型官方源一键下载（进度 / 取消 / 失败清理）。

## 功能特性

- **七个视图一体**：演奏 / 编辑 / 可视化 / 分析 / 乐谱 / 转录 / 转换；
- **三引擎离线转录** + **智能修正（refine）**：对齐起音、还原力度、声部平衡、清理杂音；
- **内置预设**：推荐预设可排序、删除、一键恢复，切换引擎自动套用；
- **中英双语界面**、**主题库**、**新手引导**、**完整性一键修复**；
- **内置 Python 运行时**：开箱即用，无需另装 Python / Node / ffmpeg；
- **MIDI 关联**：`.mid` / `.midi` 双击直接打开。

## 安装

支持 **Windows 10+ / macOS / Linux**。到 [GitHub Releases](https://github.com/qdTXTbp/FuFumidi/releases) 下载：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `FuFumidi-Setup-1.2.1.exe` |
| macOS Intel | `FuFumidi-1.2.1.dmg` / `FuFumidi-1.2.1-mac.zip` |
| macOS Apple Silicon | `FuFumidi-1.2.1-arm64.dmg` / `FuFumidi-1.2.1-arm64-mac.zip` |
| Linux x64 | `FuFumidi-1.2.1.AppImage` / `fufumidi_1.2.1_amd64.deb` |

安装包自带内置 Python 运行时与转录模型（basic-pitch int8 量化、piano-transcription、demucs htdemucs）。

## 使用流程

1. **转录**：导入音频，选择引擎模式（通用 / 钢琴 / 分离），加入批量队列或直接转录；
2. **智能修正**（可选）：对齐起音、还原力度、精修 MIDI；
3. **编辑**：钢琴卷帘逐音符精修（响度 / 踏板 / BPM / 音色 / 波形吸附）；
4. **演奏 / 可视化 / 乐谱 / 分析**：查看结果、导出 WAV / MP4 / MIDI / MusicXML / PNG / PDF。

也支持直接导入已有 MIDI 到歌单管理。

## 从源码构建

需要 Node.js 与 npm：

```bash
cd app
npm install
npm run dist:win      # Windows NSIS Setup x64
npm run dist:mac      # macOS DMG + ZIP（x64 / arm64）
npm run dist:linux    # Linux AppImage + deb
```

CI（`.github/workflows/build.yml`）：推送 `v*` 标签自动构建三平台安装包、量化 basic-pitch、精简运行时并发布到 GitHub Releases。

## 开源协议

[MIT License](LICENSE)

---

## English

**FuFumidi** — an offline audio-to-MIDI transcription desktop app (Electron + bundled Python runtime), v1.2.1.

- **100% local**: audio never leaves your machine.
- **Three offline engines**: Universal (basic-pitch / ONNX int8), Piano (piano-transcription / PyTorch), and Separate (demucs voice separation).
- **v1.2.1 highlights**: MIDI playlists, editor enhancements (loudness / pedal / BPM / timbre / waveform), 128 GM instruments + built-in GeneralUser SoundFont, staff / jianpu / guitar & bass TAB scores with PNG/PDF export, batch transcription queue, plugin views, Web MIDI, stem export, background MP4 export, model manager.
- **Install**: Windows 10+ / macOS / Linux installers on [GitHub Releases](https://github.com/qdTXTbp/FuFumidi/releases).
- **Build**: `cd app && npm install`, then `npm run dist:win` / `dist:mac` / `dist:linux`.
- **License**: MIT.

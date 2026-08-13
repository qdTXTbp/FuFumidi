# FuFumidi

**离线音频转 MIDI 一条龙工具** —— 转录、修正、编辑、演奏、可视化、分析、乐谱，全程本地运行，无需联网。

## 项目简介

FuFumidi 是一款基于 Electron 的**纯离线**音频转 MIDI 桌面应用。内置 Python 运行时，音频文件全部在本地处理，**不上传任何数据**。

内置三套完全离线的转录引擎：

- **通用模式**（basic-pitch，ONNX）：适用于人声 / 乐器等通用场景（兼人声分离）；
- **钢琴模式**（piano-transcription，PyTorch）：钢琴专用，还原力度与踏板；
- **分离模式**（demucs，PyTorch）：先做人声 / 乐器分离，再对分离后的音轨转录。

引擎支持 **GPU 自动检测**（NVIDIA CUDA / AMD·Intel DirectML / CPU 兜底），并提供三档性能模式（quality / balanced / fast），按你的 CPU 核数与显卡自动推荐档位，低配置机器也能流畅转录。

## 功能特性

- **七个视图一体**：演奏 / 编辑 / 可视化 / 分析 / 乐谱 / 转录 / 转换，一次导入、全程无缝衔接；
- **三引擎离线转录**：通用、钢琴、人声分离三种模式随切随用，支持**拖放或对话框导入**音频；
- **智能修正（refine）**：转录完成后一键精修 —— 对齐起音、还原力度、声部平衡、清理杂音；
- **内置预设**：内置「人声：最优」「钢琴：最优」两个推荐预设并设为默认，可排序、删除、一键恢复，切换引擎模式自动套用对应预设；
- **高级转录参数**：最短音符、起音判定、音符合并间隔、输出鼓组节奏轨等可调；
- **中英双语界面**：一键切换语言；
- **主题库**：内置深色主题，可切换更多外观；
- **插件系统**：内置插件宿主与示例插件，可扩展功能；
- **新手引导**：首次启动的引导流程，快速上手；
- **完整性一键修复**：启动时后台校验设置、预设、插件清单，误删可一键修复；
- **内置 Python 运行时**：安装包自带免安装 CPython 与全部依赖，开箱即用，无需另装 Python 环境；
- **MIDI 关联**：`.mid` / `.midi` 文件可直接双击打开。

## 界面预览

FuFumidi 采用统一的深色扁平设计语言（窗口底色 `#0a0f18`），以 teal 青绿色 `#00C9B1` 作为强调色贯穿全局。顶栏七个视图标签切换流畅，编辑 / 可视化与播放界面同源一体，离线状态下渲染器零依赖运行。

## 安装

- 支持 **Windows 10 及以上**系统；
- 到 **GitHub Releases** 页面下载安装包（`FuFumidi-Setup-&lt;版本&gt;.exe`）；
- 安装包**自带内置 Python 运行时与转录模型**，无需安装 Python、Node 或任何依赖环境，装完即用；
- 注意：v1.0.1 安装包体积约 **556MB**（内置运行时已做瘦身，由 853MB 缩减而来）。

## 使用流程

1. **转录**：导入音频（拖放或选择文件），选择引擎模式（通用 / 钢琴 / 分离），点击转录；
2. **智能修正**（可选）：转录后点「开始智能修正」，得到对齐起音、还原力度的精修 MIDI；
3. **编辑**：载入编辑器逐音符精修；
4. **演奏 / 可视化 / 乐谱 / 分析**：在其余视图查看结果。

也支持直接**导入已有 MIDI**（资料库按文件名去重），并可通过**预设管理**快速切换引擎参数组合。

## 版本记录

完整的更新日志见 [CHANGELOG.md](CHANGELOG.md)。

当前稳定版：**v1.0.1**（内置 Python 运行时瘦身至 556MB，新增两个推荐预设与预设排序 / 恢复管理）。

## 从源码构建

需要本机安装 **Node.js 与 npm**：

```bash
cd app
npm install
npm run dist:win     # 生成 Windows 安装包（electron-builder + NSIS）
```

构建说明：

- 内置 Python 运行时由 `scripts/bundle-python.js` 下载 python-build-standalone 自包含 CPython 并安装依赖，随后自动调用 `scripts/prune-python.js` 瘦身；
- 转录模型等大体积文件（如 `app/models/`，约 172MB）**不纳入本仓库**，已随安装包 / 源码包在 **Releases** 中分发。

## 开源协议

[MIT License](LICENSE)

---

## English

**FuFumidi** — an offline audio-to-MIDI transcription desktop app (Electron + bundled Python runtime).

- **100% local**: audio never leaves your machine.
- **Three offline engines**: Universal (basic-pitch / ONNX), Piano (piano-transcription / PyTorch), and Separate (demucs voice separation).
- **Auto GPU detection**: CUDA, DirectML, or CPU fallback, with three performance tiers.
- **All-in-one views**: Play / Edit / Visualize / Analyze / Score / Transcribe / Convert, plus smart refine, built-in presets, theme library, plugin system, onboarding, integrity self-check, and a bundled Python runtime — no environment setup needed.
- **Install**: Windows 10+, download `FuFumidi-Setup-&lt;version&gt;.exe` from GitHub Releases (v1.0.1 ≈ 556MB, runtime & models included).
- **Build from source**: `cd app && npm install && npm run dist:win` (requires Node.js + npm).
- **License**: MIT.

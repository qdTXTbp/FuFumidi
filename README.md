# FuFumidi

**离线音频转 MIDI 一条龙工具** —— 转录、修正、编辑、演奏、可视化、分析、乐谱，全程本地运行，无需联网。

FuFumidi 是一款基于 Electron 的纯离线音频转 MIDI 桌面应用，内置 Python 运行时与转录模型，音频文件全部在本地处理，**不上传任何数据**。

## 功能特性

- **七视图一体**：演奏 / 编辑 / 可视化 / 分析 / 乐谱 / 转录 / 转换
- **三引擎离线转录**：通用（basic-pitch, ONNX）、钢琴（piano-transcription, PyTorch，含踏板）、人声分离（demucs, PyTorch）
- **智能修正（refine）**：对齐起音、还原力度、声部平衡、清理杂音
- **MIDI 歌单**：导入单个 / 批量 MIDI 文件或整个文件夹；新建多个歌单、排序、收藏、只看收藏
- **编辑器**：量化、移调、复制 / 粘贴 / 克隆、力度渐强渐弱、响度调整、踏板事件增减、歌曲 BPM 调整
- **音色库**：完整 128 个 GM 音色 + 小提琴、大提琴、竖琴、马林巴、八音盒、合唱、萨克斯等扩展合成音源；支持按轨 / 全局指定音色与智能配器
- **混音台**：每轨音量 / 声像 / 静音 / 独奏，实时生效
- **离线渲染**：MIDI → WAV 分桶渲染 + overlap-add 合成，大文件不卡顿
- **导出**：MIDI / WAV / MusicXML / 工程文件（.fufu）
- **中英双语界面**、深色主题库、插件系统、新手引导、完整性一键修复

## 安装

- 支持 Windows 10 及以上。
- 到 GitHub Releases 下载 `FuFumidi-Setup-<版本>.exe`，安装包自带内置 Python 运行时与转录模型，开箱即用。
- `.mid` / `.midi` 文件可直接双击打开。

## 从源码构建

需要 Node.js 与 npm：

```bash
cd app
npm install
npm run dist:win     # electron-builder + NSIS 生成 Windows 安装包
```

说明：

- 内置 Python 运行时由 `scripts/bundle-python.js` 下载 python-build-standalone 并安装依赖，随后自动调用 `scripts/prune-python.js` 瘦身。
- 转录模型等大文件（`app/models/`，约 172MB）**不纳入本仓库**，随 Releases 安装包 / 源码包分发。

## 项目结构

```
├── AGENTS.md                 # 项目宪法：架构决策 / 编码规范 / 目录
├── CHANGELOG.md              # 更新日志
├── UPDATE.md                 # 版本发布与测试规范
├── docs/                     # 开发者文档
└── app/
    ├── main.js               # Electron 主进程
    ├── preload.js            # fuBridge 上下文桥
    ├── plugin-host.js        # 插件系统宿主
    ├── renderer/FuFumidi.html# 单文件渲染界面
    ├── engine/               # Python 转录引擎（music2midi.py / smart_midi.py）
    ├── scripts/              # Python 运行时捆绑脚本
    └── plugins/              # 内置插件示例
```

## 协议

MIT License。详见 [LICENSE.txt](LICENSE.txt)。

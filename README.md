# FuFumidi

离线 MIDI 播放 / 编辑 / 可视化 / 分析 / 乐谱 / 转录（音频转 MIDI）一体工具。

## 功能简介

- 音频转 MIDI（通用 / 钢琴 / 人声分离）
- 钢琴卷帘编辑器（CC 自动化、Key Switch、逻辑/列表、宏、智能量化、鼓组）
- 演奏可视化、MIDI 分析、五线谱
- 影视配乐辅助（SMPTE、视频轨道、乐谱分屏）
- 完全离线，内置 Python 与模型

## 打包

```bash
npm run pack:full     # 完整包 asar
npm run pack:base     # 基础包 asar
npm run pack:source   # 源码 7z -mx9
```

## CI

`.github/workflows/build.yml` 会在推送 v2.0.0* 标签时于 Windows / macOS / Linux 三平台执行：

1. 安装 Python 依赖
2. `engine/deps.py check`
3. 引擎 probe
4. 打包 asar 并上传产物

## 发布流程

1. 本地验收通过
2. `git add -A && git commit`
3. `git tag v2.0.0`
4. 推送到 GitHub（触发 CI）
5. 下载三平台 CI 产物到本地对应目录
6. 创建 GitHub Release 并上传安装包

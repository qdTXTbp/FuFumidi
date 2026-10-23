# FuFumidi 6.1.4

## 新增可选转录引擎（资源中心下载，不随安装包分发）

- **hFT-Transformer**（钢琴）：Sony ISMIR 2023，MIT License，约 22 MB，CPU 可跑。
- **YourMT3+**（通用）：YPTF+Single 权重 + 独立运行时，CPU 可跑。
- **MIROS**（通用）：2025 AMT Challenge 冠军（MusicFM + YourMT3+ 多通道解码），运行时 + 4.3 GB 权重。

三个引擎都属于“可选安装”：未下载时保持原有 Basic Pitch / 钢琴引擎行为，不增加安装包体积。

## 说明

- 模型从「资源中心 → 转录模型」下载安装。
- 首次使用新引擎会加载对应权重，耗时取决于磁盘/CPU/GPU；日志会显示加载与推理耗时。
- 版本仍包含之前 6.1.3 的自动探测、空 MIDI 保护、文件关联图标自愈等修复。

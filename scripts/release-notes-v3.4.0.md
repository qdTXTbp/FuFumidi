# FuFumidi v3.4.0

本次更新聚焦 **MuScriptor 转录稳定性**，解决了 v3.3.1 升级后部分用户转录必现失败的根因。建议所有用户更新。

## 🎯 关键修复：MuScriptor 转录失败

- **修复根因**：MuScriptor 转录的「节拍网格检测」会从 **JKU 云盘**（`cloud.cp.jku.at`）经 torch.hub 下载 `beat_this-final0.ckpt` 权重。该国外源在部分网络下会被**截断 / 超时**（约 6MB 后断流），且下载落到了系统 `~/.cache/torch`，一旦留下残缺文件便反复报：
  `Could not load the checkpoint given the provided name 'final0'`，导致整首转录失败（v3.3.1 升级后你遇到的现象）。
- **本次方案**：
  1. 权重**纳入资源中心**，走国内镜像 / 多源回退下载，并**统一存放到软件 models 目录内**（不再外泄到系统缓存、不再依赖国外源）；
  2. 节拍网格检测可在转录「高级参数」中**手动开关**；
  3. 权重**未下载或加载失败时自动跳过**，回退为无节拍网格的旧调用——**转录绝不因此失败**。

## ✨ 新增

- **资源中心新增「节拍网格检测（Beat This!）」模型**：MuScriptor 转录时对齐音符时值，时序更稳。
- **「节拍网格检测」开关**（转录 → 高级参数，仅 MuScriptor 显示）：未下载 / 失败时自动跳过，不影响转录。

## 🛠 修复

- 修复 MuScriptor 转录 `Could not load the checkpoint given the provided name 'final0'`（JKU 权重下载截断导致）。

## 📦 安装与更新

- 3.3.1 及以下用户：应用内「检查更新」增量升级（推荐，只下载改动部分）
- 完整安装包：`FuFumidi-Setup-3.4.0.exe`

> 3.3.1 的全部功能（MuScriptor GPU 批量推理 / 低音增强 / 智能音乐库 / 播放模式 / 无缝播放等）保持不变。
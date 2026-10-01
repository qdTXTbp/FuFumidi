# -*- coding: utf-8 -*-
"""`OpenUtau.Classic` 命名空间 —— **照搬** `OpenUtau.Core/Classic/`。

为什么单独开一个子包：C# 那边 Classic 线有 30 来个文件（原音、resampler/wavtool 的
外部进程封装、工具管理器、预设、Flags…），平铺进 `openutau/` 会让目录失去结构。
这里按 C# 的**文件夹边界**划子包，一眼能对上。

已照搬：
  - `resampler_item.py`  单音素的 resampler 调用参数与缓存键（Classic/ResamplerItem.cs）

未照搬（后续）：
  - `IResampler` / `IWavtool`（接口，等具体实现一起搬）
  - `Worldline.cs` + `WorldlineResampler` + `WorldlineRenderer`（**纯 C# 实现，不需要外部 EXE**）
  - `SharpWavtool`（内置 wavtool）
  - `ClassicRenderer` / `ExeResampler` / `ExeWavtool` / `ToolsManager` / `VoicebankFiles`
    （外部工具进程那一整片）
  - `ClassicSinger` / `Presamp` / `OtoWatcher` / `VoicebankConfig` / `Ust` / `Ini`
"""

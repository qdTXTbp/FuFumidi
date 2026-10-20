# YourMT3+ / MIROS 环境与推理记录（2026-10-20）

## YourMT3+ 独立推理：已跑通（离线）

- 代码来源：HuggingFace Space `mimbres/YourMT3`（pre-release 源码，非 GitHub main）。
  - 本地克隆：E:\Midi\_attic\yourmt3\space（含 amt/src、examples）
- 权重（已下载）：
  - YPTF+Single (noPS)：`ptf_all_cross...b100/checkpoints/model.ckpt` 361,050,039 B
  - YPTF.MoE+Multi (noPS)：`...b36_nops/checkpoints/last.ckpt` 561,544,628 B
  - 下载源：hf-mirror.com/spaces/mimbres/YourMT3/resolve/main/...（LFS）
- 环境：conda `ymt3`（Python 3.12）+ GPU 加速包 overlay（torch 2.9.1+cu128）。
  - 依赖：numpy 1.26.4 / transformers 4.45.1 / lightning 2.4.0 / librosa / mido / mir_eval 等。
  - torchaudio 2.9 的 load 需换成 soundfile；wandb 用假模块跳过（推理不需要）。
- 实测（RTX 5070 Ti Laptop 12GB）：
  - YPTF+Single，4.8s 示例音频 → 9.06s，397 notes（单通道输出）。
  - YPTF.MoE+Multi，8s 合成用例 → 2.4s，但输出无音符；官方 4.8s 示例在 bsz=8 时显存打满（约 11.7GB）卡住。
  - 结论：MoE 更适合官方 batch=1 + 长音频分段；当前封装用 YPTF+Single 更稳、显存小。

### 接入 App 的阻塞

App 的 `resources/python` 只有 torch/torchaudio 等基础包，没有 lightning/transformers 4.45 依赖；
资源中心目前只下载权重，不安装 Python 包。要变成可选引擎，需要新增“YourMT3 运行时”下载包
（约数百 MB）或在安装包内置依赖；不能只加一个权重卡片，否则用户下载后仍然跑不起来。

## MIROS

- 2025 AMT Challenge 冠军代码已找到：
  - https://github.com/amt-os/ai4m-miros（YourMT3+ + MusicFM 编码器）
  - https://github.com/mimbres/AMT-challenge（同一作者挑战版）
- 两个仓库都**没有发布训练权重**；只含代码/配置。
- 训练条件（官方 YourMT3+ 说明）：完整 YourMT3 数据集 + MusicFM 预训练，官方 MoE 训练使用 8×A100/H100、
  320K iterations；本机 12GB 单卡无法完成同等训练。
- 已准备：conda ymt3 环境、AMT-challenge 代码、权重下载/数据脚本线索；
  下一步需要选择小数据集（如 MusicNet/Slakh 子集）做微调实验，或向作者申请权重。

## 2026-10-20 晚更新：YourMT3 已进资源中心

- 运行时+权重单包已上传 CNB：`FuFuCloud-mirror/Models` release `yourmt3-v1`，
  asset `yourmt3-runtime-20261020.zip`，453,848,674 B，SHA-256 `82054845789BF380317CD3AB77DEDC6622EE969E58216D7B8289691AE8011C46`。
- 资源中心条目 `yourmt3`；转录页通用模型新增 YourMT3+ 按钮。
- 本地安装后 app 自带 Python 3.12 实测：可用，短用例推理约 0.8s（CPU），MIDI 7 音符。
- 安装版已部署本次验收构建（版本仍 6.1.3，未上传发布）。

## MIROS 最新进展

- 官方 `main.py` 给出了 Google Drive 微调权重 ID（fine-tuned `last.ckpt`）与 MusicFM 预训练权重；
  MusicFM 已下载（1.32 GB），MIROS 微调权重下载中。
- 公开数据：HF `another-blue/YourMT3-dataset` 的 `rwc_pop_yourmt3_16k.tar.gz`（763 MB）已下载并解压。
- 阻塞：MIROS 代码要求 transformers 4.48/flash-attn 与特定包结构，直接 import 报 `relative import beyond top-level`
  以及 T5 StaticCache 兼容问题；尚未完成训练。

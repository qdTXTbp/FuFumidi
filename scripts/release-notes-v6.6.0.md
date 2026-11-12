# FuFumidi 6.6.0

## 内置 Python 运行时：3.11 → 3.12

MIROS（2025 AMT Challenge 冠军）的运行时依赖是按 Python 3.12 构建的，
而应用此前内置的是 3.11 —— ABI 不匹配，MIROS 从接入起就**从未真正跑通过**
（先报「scipy 坏了」，修复 ABI 闸门后是「wandb 不是包」）。本版把内置运行时
统一升级到 3.12：

- 依赖自检六组首次全绿（此前 muscriptor 补丁 / aria / transkun 三组长期缺失或损坏）
- MIROS 首次真正可用：实测 10 秒素材 CPU 29.4 秒、26 音符
- 修 wandb 桩：补齐 `wandb.sdk` / `wandb.wandb_run` 子模块并把 lightning 的
  WandbLogger 换成不联网的 DummyLogger，推理全程不需要安装 wandb

## GPU 增强包

- 增强包改为按 ABI 隔离注入：只用目录联接暴露 torch / torchaudio / onnxruntime，
  不再让它自带的 numpy / transformers / huggingface_hub 顶掉运行时依赖。
- **按 3.11 安装的旧加速包与本版不兼容，会被自动跳过**（界面显示「已安装未启用」）。
  请到「设置 → GPU 增强包」重新安装；未重装前所有引擎走 CPU，功能不受影响。

## 可选引擎更稳

- MIROS / YourMT3+ 的依赖目录与引擎 Python 版本不匹配时，直接报
  「请重新下载匹配版本」，不再伪装成「scipy 坏了」。
- 每个任务结束后还原解释器路径，避免可选引擎污染后续任务。

## 其他

- 诊断信息改用系统 API 取 Windows 版本，不再调用外部命令（受限机器上会永久阻塞）。
- numpy 钉 1.26.4（MIROS 自带 scipy 1.14.1 要求 numpy<2.3）。

SHA256 与资产清单见 release 说明页。

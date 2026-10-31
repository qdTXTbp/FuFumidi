# MIROS 在有 CUDA 的机器上仍走 CPU（诊断报告）

> 状态：**仅诊断，不含修复**。按用户要求提交 PR，请协助者修复。
> 版本：FuFumidi 6.4.2（Windows x64）
> 相关模型：MIROS（MusicFM + YourMT3+ multi-dec，运行时约 5.36GB）

## 症状

机器有可用的 NVIDIA CUDA，GPU 增强包也已安装，但 MIROS 转录日志始终是：

```text
GPU available: False, used: False
```

推理因此走 CPU，5.36GB 模型在 i5-6500 / 8GB 机器上非常慢（实测同一首 3:37 音频成功转录约 186 秒）。

## 环境证据

应用的 CUDA 增强包可以正常使用：

```text
E:\Midi\FuFumidi\FuFumidiData\gpu-enhancements\cuda\site-packages
torch 2.9.1+cu128
torch.cuda.is_available() = True
torch.cuda.device_count() = 1
```

但 MIROS 独立运行时里的 torch 是 CPU 版：

```text
E:\Midi\FuFumidi\FuFumidiData\models\miros\site\torch
torch 2.14.1+cpu
torch.version.cuda = None
torch.cuda.is_available() = False
```

## 根因

`engine/engine_miros.py` 在加载前调用：

```python
TR.prepare_paths(rt, extra_dirs=[repo])
```

`engine/transcribe_runtime.py` 的 `prepare_paths()` 会把运行时目录下的：

```text
<miros_runtime>/site
```

插到 `sys.path[0]`。而应用主进程通过 `engineEnv()` 注入的 GPU 增强包在 `PYTHONPATH` 中，Python 启动后位于 `sys.path` 更靠后的位置。

结果：`import torch` 先命中 MIROS 的 CPU torch，GPU 增强包里的 CUDA torch 被遮蔽。不是机器没有 CUDA，也不是驱动问题。

## 建议修复

在 `transcribe_runtime.prepare_paths()` 增加一个“运行时 site 放最后”的模式，MIROS 调用时启用：

```python
TR.prepare_paths(rt, extra_dirs=[repo], site_last=True)
```

期望路径顺序：

```text
GPU 增强包 site-packages（CUDA torch）
MIROS repo
MIROS 运行时 site（仅补齐缺包）
```

同时建议：

1. 路径准备完成后显式打印 `torch.__version__`、`torch.version.cuda`、`torch.cuda.is_available()`、当前 torch 文件路径，方便诊断。
2. 增加 GPU/CPU 模式日志，不要只依赖 Lightning 的 `GPU available` 行。
3. 校验 torch 与 torchaudio 同版本同构建；当前 MIROS CPU torch 是 2.14.1，GPU 增强包是 2.9.1+cu128，切换后需要确认 MIROS 的 Python 依赖是否兼容。
4. 若 GPU 包缺失或版本不匹配，明确回退 CPU 并提示用户，而不是静默 CPU。

## 验证标准

- 有 CUDA + GPU 增强包：日志出现 `GPU available: True (cuda), used: True`，任务实际使用 GPU。
- 无 CUDA/无 GPU 包：明确日志显示 CPU 回退，不崩溃。
- 相同音频的 MIROS 转录耗时明显低于 CPU 路径（i5-6500 + 8GB 上应从分钟级降到可接受范围）。

## 相关文件

- `engine/engine_miros.py`
- `engine/transcribe_runtime.py`
- `main.js` 的 `engineEnv()`（GPU 增强包 `PYTHONPATH` 注入）
- `main/gpu.js` / `main/gpu-ipc.js`（GPU 增强包安装与 ABI 匹配）

## 备注

- Issue #35 的低内存保护是另一条独立逻辑，不是本次 CPU 回退的原因。
- 本地已验证：把 MIROS 的 `site` 放到 GPU 增强包之后，Lightning 日志变为 `GPU available: True (cuda), used: True`。

# MIROS 有显卡却走 CPU：sys.path 优先级（GitHub PR #37）

> 2026-10-31。上游诊断报告由 qdTXTbp 提供（只含诊断、不含修复代码），这里落修复。

## 现象

有 CUDA 的机器上，MIROS 转录日志是 `GPU available: False, used: False`，整首走 CPU，
比 GPU 慢一个量级；界面没有任何提示，用户只能感觉「MIROS 怎么这么慢」。

## 根因

MIROS 运行时自带 `site/torch`，是**CPU 版**（实测 `2.14.1+cpu`）。
`transcribe_runtime.prepare_paths()` 把整个 `site` 插到 `sys.path[0]`，
而 GPU 增强包（主进程 `engineEnv` 注入到 `PYTHONPATH` 的 cu128 包，`torch 2.9.1+cu128`）
排在它后面 —— **先命中的 CPU torch 赢**，增强包等于没挂。

对照实验（报告里给的）：

| 场景 | torch | cuda |
|---|---|---|
| 单独 import GPU 增强包 | 2.9.1+cu128 | True |
| MIROS 运行时 site 在前 | 2.14.1+cpu | False |
| site 放到增强包之后 | — | Lightning 日志 `GPU available: True (cuda), used: True` |

## 改法

`engine/transcribe_runtime.py`

- `prepare_paths(rt, extra_dirs=(), keep_env_packages=True)`：site 不再无脑插 `sys.path[0]`，
  而是插在「PYTHONPATH 里的增强包目录」**之后**。三个可选引擎（hFT / YourMT3+ / MIROS）
  共用这一个函数，一并修好。
- 没装增强包时行为不变（site 仍最前，压过 App 自带运行时）。
- `keep_env_packages=False` / 环境变量 `FUFUMIDI_RUNTIME_BUNDLED_TORCH=1` 可退回旧顺序，
  留给「新 torch 缺 API」时的排障对照。
- 新增 `torch_info()` / `describe_torch()` / `cpu_fallback_hint()` / `dist_versions()` /
  `torch_compat_warning()`：日志里直接写出**实际加载的 torch 版本、cuda 版本、设备、目录**；
  走 CPU 时分三种情况说清原因（没装包 / 包挂了但 CUDA 不可用 / torch 加载失败）；
  GPU 包与运行时自带 torch 版本不同时提前提醒（并给出退回开关）。

`engine/engine_miros.py` / `engine/engine_yourmt3.py`：调用处接上上面的日志与提示。

## 兼容性（PR 第 2 条建议）

增强包 torch 2.9.1 **低于** MIROS 自带的 2.14.1。报告实测能正常推理，
但版本更高的运行时理论上可能用到新 API —— 所以不静默：`torch_compat_warning()`
会在日志里点明「用的是 2.9.1，自带 2.14.1」，并给出退回方式。退回后是 CPU（但调用面完全对得上）。

## 测试

`engine/tests/test_runtime_path_priority.py`（10 项）：

- 有增强包 → `pack < site < repo < rt`（顺序契约，破了就是回归）；
- 无增强包 → site 最前；
- 排障开关 → 退回旧顺序；
- 幂等（重复调用不重复插入）；
- `dist_versions` 只读 dist-info 不 import（避免两套 torch 撞车）；
- `describe_torch` / `cpu_fallback_hint` 三种分支的文案。

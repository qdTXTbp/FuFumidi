# 全局体检（设置 → 调试工具）计划（2026-10-12）

## 0. 用户原话

> 在设置里添加调试工具，方便 amd 和英特尔显卡的用户反馈报告，干脆把调试工具做成**全局体检**，
> 方便用户反馈 bug 和问题。

## 1. 现状：已经有「诊断包导出」，但它不是体检

| 已有 | 位置 | 做什么 |
|---|---|---|
| `engine/diag.py` | 引擎 | 把 settings.json + diagnostic.json（deps 检查结果）+ 临时目录里的 `*.log` 打成一个 zip |
| `main/diagnostics.js` | 主进程 | `diag:export` IPC，弹保存对话框写 `fufumidi-diagnostic.zip` |

**它和「体检」的差别**：

1. **被动打包，不主动检查** —— 只是把现成的文件塞进 zip，不判断「哪里不对」
2. **要用户先存文件再上传** —— 反馈链路长，很多人到这一步就放弃了
3. **没有显卡结论** —— 而 AMD / Intel 用户最常见的问题恰恰是「装了加速包但不生效」，
   这一点 zip 里看不出来（`is_available()` 为真不代表能用，见 issue #20）
4. **没有脱敏** —— 日志和设置里有完整用户名路径，公开贴出来不合适

所以不是重做，而是**在它上面加一层会下结论、能一键复制、且脱敏的体检**。

## 2. 设计

### 2.1 体检项（每一项都要给「结论」而不是「原始值」）

| # | 分组 | 检查内容 | 结论形态 |
|---|---|---|---|
| 1 | 系统 | OS 版本/构建号、CPU 型号与逻辑核数、内存总量/可用、系统盘与数据盘剩余空间 | 低于阈值给警告 |
| 2 | **显卡与加速** | 厂商/型号、驱动版本、`engine_gpu.detect()` 全量（backend/device/cuda_usable/arch_supported/arch_reason/need_cu128）、torch 版本与 `get_arch_list()`、已装加速包（kind/是否 ABI 匹配/manifest）、onnxruntime providers | **核心项**：显卡在但没装包 → 提示装哪个；装了但算力不匹配 → 明说；可用 → 报出实际设备名 |
| 3 | **加速实跑** | 在检测到的设备上真跑一次矩阵乘并与 CPU 对拍 | 通/不通 + max diff。**这是 AMD/Intel 用户最需要的一项**，比任何版本号都有说服力 |
| 4 | 运行时 | 内置 Python 版本、关键依赖版本与来源（torch/torchaudio/onnxruntime/muscriptor/piano_transcription_inference…） | 缺失/版本异常给警告 |
| 5 | 模型资源 | 各模型权重是否存在与体积（muscriptor small/medium/large、aria_amt、beat_this、Basic Pitch…） | 缺哪个列哪个，不报「全部正常」了事 |
| 6 | 最近错误 | 日志里抓 `Traceback` / `ERROR` / `CUDA error`，取最后 N 条 | 有就给摘要，无则明说没有 |
| 7 | 环境变量 | `FUFUMIDI_*` 与 `PYTHON*` 里会影响引擎的那些 | 列出非默认值 |

### 2.2 三条硬要求

**① 必须能一键复制。** 报告生成一段纯文本，设置里一个「复制报告」按钮。
用户反馈 bug 时直接粘贴，不用先存文件、再找文件、再上传。
（zip 导出保留 —— 需要完整日志时还是有用的。）

**② 必须脱敏。** 用户名、机器名、完整家目录路径要替换掉：
`C:\\Users\\<user>\\...`、`<hostname>`。日志里随处可见这些，不脱敏没人敢贴公开 issue。

**③ 每项都要有结论。** 「torch 2.13.0+cpu」是原始值，「本机有 RTX 5070 Ti 但装的是 CPU 版 torch，
显卡完全没用上，可在设置 → GPU 安装 CUDA 加速包」才是结论。
体检的价值在于**告诉用户下一步做什么**。

### 2.3 落点（按仓库「新能力三处同改」的规矩）

```
engine/health.py          ← 新增：采集 + 判定 + 生成报告文本（纯 Python，可单测）
main/diagnostics.js       ← 加 diag:health IPC（复用 runEngineInline 跑 health.py）
preload.js                ← 暴露 fuBridge.diagHealth()
frontend/src/types/ipc.ts ← 补类型
SettingsPanel.vue         ← 「调试工具」区块：体检按钮 + 结果列表 + 复制报告
core/i18n.js / i18n_ja.js ← 中文文案 EN + JA 同步
```

### 2.4 为什么放在引擎而不是主进程

因为**要看的东西一半在 Python 侧**：torch 的 arch_list、onnxruntime providers、
依赖版本、模型权重路径。主进程只能靠 `spawn` 问它，不如直接写成引擎脚本一次拿全。

## 3. 待办

- [ ] `engine/health.py`：采集 + 判定 + 文本报告（含脱敏）
- [ ] 加速实跑对拍（复用 XPU 自检那段思路，但**对所有后端都做**）
- [ ] 单测：脱敏正确性、无显卡时不崩、结论文案分支
- [ ] IPC 三处 + 界面 + i18n
- [ ] 部署到安装版并用 CDP 实测点一次「体检」能出报告

## 4. 顺带记下的两个待办（不属本计划）

**① GPU 首个测量结果是反直觉的，必须重测。**
同一段 15 秒素材（3 个块）：CPU `推理 8.5s` vs GPU `推理 17.8s` —— **GPU 慢一倍**。
但 3 个块时 GPU 的初始化/权重搬运开销占绝对主导，这个数字**对长音频毫无参考价值**。
要下结论必须用至少 60–120 秒素材（12–24 个块）重测，最好直接拿 1447 块的长音频比。
**在测出有意义的数字之前，不要对外宣称「支持 GPU 加速」，也不要把它做成默认。**

**② venv 试验台里已验证可用的 CUDA 组合**（仅为测试环境，尚未进安装包）：

```
torch 2.13.0+cu130  ·  cuda True  ·  RTX 5070 Ti Laptop  ·  cap (12,0)  ·  archs 含 sm_120
```

来源：`https://mirror.sjtu.edu.cn/pytorch-wheels/cu130/torch-2.13.0%2Bcu130-cp311-cp311-win_amd64.whl`
（**SJTU 镜像实测 7.5 MB/s，而 download.pytorch.org 只有 313 KB/s —— 差 24 倍**；
两者目录页都不可浏览，直接 curl 具体文件即可。）

坑：**pip 要求标准 wheel 文件名**（`torch-2.13.0+cu130-cp311-cp311-win_amd64.whl`），
改名成 `torch-cu130.whl` 会被拒：`ERROR: ... invalid wheel filename`。
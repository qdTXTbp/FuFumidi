# 技术调研与选型报告（P2 交付物）

> 阶段：P2 技术调研 ｜ 目标：为「决策门」提供依据——**集成开源 or 自研（含声库工具）**
> 更新：2026-08-29 ｜ 前置文档：[utau-principles.md](./utau-principles.md)

---

## 1. 调研对象一览

| 项目 | 类型 | 技术栈 | 许可证 | 可复用性 |
|---|---|---|---|---|
| OpenUtau | 完整编辑器 + 引擎 | C#/.NET + C++(worldline) | MIT | 非库，整体嵌入成本高；源码可读（含 worldline 变调思路、simple/convergence wavtool、多语言 phonemizer） |
| UTAU 原版 resampler.exe / wavtool.exe | 合成引擎可执行文件 | 闭源 | freeware（不明） | Windows-only、依赖日文 locale；打包分发授权不明，不建议 |
| utaupy | Python 解析库 | Python 3.9+ | MIT | **直接可用**：oto.ini / .ust / .lab / 罗马音-假名表 / 编码转换（Shift-JIS↔UTF-8） |
| PyUtauCli | Python 渲染管线 | Python（PyRwu + PyWavTool） | MIT | 可作管线参考（resamp + append 两阶段） |
| putao | Python 合成器 | Python + pyworld | MIT | **resampler 参考**：纯 Python WORLD 变调，UNAU 音源直读，.npy 频率缓存 |
| NUTAU | Python 合成器 | numpy | Unlicense | **resampler 参考**：无 STFT 的"重采样 + 循环 + 零交叉对齐"轻量方案 |
| utaufile | ust 解析 | Python | Apache-2.0 | 仅 ust，覆盖窄，优先级低 |
| ScoreDraft | Python 歌声合成 | Python + PSOLA | 开源 | 变调/拼接参考 |
| SetParam | oto 标注工具 | Windows | freeware | 参考其 auto-CV（音量法）/ auto-VCV（BPM 法）标注逻辑 |
| vLabeler | 标注工具 | Compose Multiplatform | Apache-2.0 | 参考其波形可视化标注交互 |
| moresampler | resampler | 闭源 | freeware | auto-oto 思路参考（AI 标注，但有 overlap/cutoff/别名问题） |
| WhisperX | ASR + 强制对齐 | Python (faster-whisper + wav2vec2) | BSD-2-Clause | **上传音频切分候选**：词级时间戳，中文可用；对齐模型需 HF 下载 |
| Montreal Forced Aligner (MFA) | 音素级强制对齐 | Python | MIT | 进阶候选：音素级边界，需各语言声学模型 |

## 2. 三条路线对比

### 路线 A：整体集成 OpenUtau 引擎
- 做法：以子进程/服务方式嵌入 C#/.NET 引擎，或在其上二次开发。
- 优点：引擎成熟、参数齐全、音质有保障；MIT 授权可商用。
- 缺点：**C#/.NET 栈与项目（Python 引擎 + Electron）不匹配**；OpenUtau 是完整应用而非库，没有稳定嵌入 API；需随包携带 .NET 运行时或子进程分发，体积/维护成本高；与现有 `engine/*.py` 架构割裂。
- 结论：**不推荐作为主路线**，仅作为行为/参数参考（MIT 可读源码）。

### 路线 B：调用 UTAU 原版 resampler.exe / wavtool.exe
- 优点：零开发成本，音质与社区一致。
- 缺点：闭源 freeware，**重新分发授权不明**；仅 Windows；依赖日文 locale（文件名/编码）；无源码可维护。
- 结论：**不推荐**。

### 路线 C：自研 Python 引擎（借鉴开源参考）
- 做法：解析层参考/复用 utaupy（MIT）；resampler 参考 NUTAU（重采样+循环+零交叉）起步，后期可升级 pyworld/WORLD 路线（参考 putao / OpenUtau worldline）；wavtool 参考 OpenUtau simple 逻辑（交叉淡化 + 包络 + 颤音）。
- 优点：与 `engine/` 架构完全契合（py-util.js 调用模式、异步任务、ffmpeg_wrap 复用）；许可证干净（MIT/Unlicense 均可商用）；模块化、可控、可逐步迭代；frq/缓存机制可参考。
- 缺点：起步音质弱于成熟引擎，需迭代；变调/拼接细节要自己打磨。
- 结论：**推荐**。

## 3. 决策矩阵（权重 1~5）

| 维度 | 权重 | A 集成 OpenUtau | B 原版 exe | C 自研 Python |
|---|---|---|---|---|
| 技术栈契合度 | 5 | 1（C#/.NET 割裂） | 2（子进程） | 5（同栈） |
| 许可证/分发 | 4 | 4（MIT） | 1（freeware 不明） | 5（MIT/Unlicense） |
| 维护与可控性 | 4 | 2（无嵌入 API） | 1（闭源） | 5（完全可控） |
| 音质/成熟度 | 3 | 5 | 4 | 2（起步）→可迭代 |
| 交付周期 | 3 | 3（集成工作量大） | 5（零开发） | 4（M1 可控） |
| **加权总分** | - | **50** | **37** | **71** |

**结论：自研 Python（路线 C）**，解析层优先复用 utaupy（MIT），合成层参考 NUTAU / putao / OpenUtau 源码。

## 4. 上传音频自动切分与 oto.ini 自动标注方案

按声库类型分层，M3 建议「先易后难」：

| 输入方式 | 切分策略 | 标注策略 | 成熟度 |
|---|---|---|---|
| CV 逐音节录制（静音分隔） | 能量 / VAD 阈值检测静音边界 | 启发式：辅音起点≈onset、元音起点≈峰后稳定段（参考 SetParam auto-CV） | 高，可作为 M3 起步 |
| VCV / CVVC 按 BPM 录制 | 按 BPM 网格 + 能量修正 | 参考 SetParam auto-VCV / mkototemp500（BPM 法） | 中 |
| 上传连续演唱/朗读 | WhisperX：VAD + faster-whisper + wav2vec2 强制对齐 → 词级边界；再按中文拼音/音节映射细化 | 用户确认 + 可视化微调兜底 | 中（对齐模型需 HF 下载；word 粒度≠音节粒度，需二次映射） |
| 进阶（可选） | MFA 音素级强制对齐（中文声学模型） | 音素级 oto 标注 | 低（模型/语言包准备成本高） |

**切分策略总原则**：
1. 用户偏好高精度、有足够引导、功能不支持时要有明显提示 → 自动切分永远配**可视化手动微调**兜底；
2. 先做「静音分隔录音」的自动切分（可靠），上传连续音频的对齐作为进阶能力（P3 阶段再细化选型）；
3. 若引入 WhisperX：只用 ASR + 对齐（BSD-2），**不用 diarization**（pyannote 模型在 HF gated，需 token，且本项目不需要）。

## 5. 推荐技术方案

### 5.1 合成引擎（M1/M2/M4）
- 语言/环境：Python，跟随现有 `engine/` 目录规范（`engine_utau.py`），由主进程通过 py-util 异步调用。
- 解析层：优先复用 **utaupy**（MIT）读 oto.ini / .ust / 音源配置与编码转换；若体积顾虑可摘取其解析逻辑并保留 MIT 声明。
- resampler：自研，参考 **NUTAU**（重采样 + 循环 + 零交叉对齐，纯 numpy，无 STFT 依赖）；预留 `Resampler` 接口便于后续接入 pyworld（参考 putao）。
- wavtool：自研，参考 OpenUtau **simple** 逻辑（overlap 交叉淡化 + 包络 + 颤音 + 时长对齐 + 多轨混音）。
- 频率文件：自研轻量 .frq 等价物（numpy 缓存，参考 putao 的 .npy），提升反复渲染性能。

### 5.2 声库工具（M3）
- 录音引导：自研 UI（参考 recstar 交互），逐音节提示 + 电平检测 + 自动命名。
- 上传切分：能量/VAD 自动切分（起步）+ 可视化波形微调；进阶预留 WhisperX 对齐。
- oto.ini 标注：自动生成（启发式）+ 波形可视化微调（参考 vLabeler/SetParam 交互），导出遵循社区格式（Shift-JIS/UTF-8 双兼容）。

### 5.3 依赖引入清单（建议）
| 依赖 | 用途 | 许可证 |
|---|---|---|
| numpy | 音频处理基础 | BSD |
| utaupy（或自研解析） | oto.ini/.ust 解析、编码转换 | MIT |
| soundfile / wave | WAV 读写（或用现有 audio_io.py） | - |
| scipy | 重采样/滤波（现有环境已含） | BSD |
| （进阶）pyworld | WORLD 变调质量提升 | 修改版 BSD |
| （进阶）whisperx | 上传音频强制对齐 | BSD-2 |

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 自研起步音质弱 | 用户体验 | M1 只打通链路，M2/M4 迭代调声；以成熟音源（如 Teto）为基准试听 |
| 变调伪影（金属感/齿音） | 音质 | 零交叉对齐 + 循环拼接起步，必要时上 pyworld；Y/H flags 已有缓解手段 |
| 上传切分准确率不稳 | 声库工具可用性 | 自动切分仅作初稿，强制可视化微调兜底；引导优先"静音分隔录制" |
| 中文音节↔音素映射复杂 | 声库兼容性 | 先支持中文 CV 式（拼音音节），再扩展 VCV/CVVC |
| 依赖体积（WhisperX/模型） | 包体 | 模型走资源中心按需下载（沿用现有模型下载渠道），不随包内置 |
| 编码（Shift-JIS/UTF-8） | 兼容 | 解析层统一处理编码嗅探与转换（utaupy 已覆盖） |

## 7. 结论（供决策门确认）

> **推荐：自研 Python 引擎（解析层复用 utaupy，合成层参考 NUTAU/putao/OpenUtau），声库工具自动切分 + 可视化微调兜底。** 不整体集成 OpenUtau，不调用闭源原版 exe。

## 8. 参考来源

- OpenUtau（MIT）仓库与 Wiki：https://github.com/openutau/OpenUtau
- NUTAU（Unlicense）：https://github.com/zhaochenhong42/nutau
- putao（MIT，pyworld resampler）：https://github.com/ongyx/putao
- utaupy（PyPI）：https://pypi.org/project/utaupy/
- PyUtauCli（MIT）：https://pypi.org/project/PyUtauCli/
- vLabeler（Apache-2.0）：https://github.com/sdercolin/vlabeler
- WhisperX（BSD-2-Clause，论文 arXiv:2303.00747）：https://github.com/m-bain/whisperX
- UTAU 声库制作指南（录制/标注工具链）：http://ryuune.drayo.eu/utau.php

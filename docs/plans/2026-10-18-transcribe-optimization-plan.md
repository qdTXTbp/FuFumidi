# 转录体验优化方案（2026-10-18）

> 用户反馈的 4 个问题 + 2 个提速/提质诉求。本文只给方案与验证计划，**本轮不动代码**，等确认优先级后再实施。

## 0. 现象与根因速览

| # | 现象 | 根因（代码事实） | 方案归属 |
|---|---|---|---|
| 1 | 日志里有「降噪」，参数里没有选项 | `engine/audio_chain.py` 每次转录都执行并打印「降噪=off · 电平统一…」；2026-10-15 因实测降噪会增加假音符，UI 入口被移除，但日志没跟着改 | §1 |
| 2 | 转录中不能切队列 | `ViewTranscribe.vue` 的 `switchQueue()` 在 `running` 时直接 toast 拦截；且运行读取的是当前激活的 `queue` 响应式数组，设计上不允许中途换 | §2 |
| 3 | 每模型「最优识别片段长度」 | 各模型训练/推理块长写死在各自库/配置里（Basic Pitch 固定 2s 窗、MuScriptor 5s、piano 10s、Transkun 16s、Aria 30s），当前 UI 只有一个统一滑条，预设里没给推荐值 | §3 |
| 4 | 用内存补显存提速度 | Windows + NVIDIA 驱动自 536.40 起**已经**会在显存不足时静默借用系统内存（shared GPU memory），代价是 5–10× 变慢；应用无法把 DDR 变得和 VRAM 一样快，能做的是「避免溢出」+「显式选择可接受的慢」 | §4 |
| 5 | 更多提速/提质方法 | 见 §5 清单（模型/设备/参数/预处理/后处理） | §5 |

## 1. 降噪：日志与参数不一致

### 现状

- 转录前音频链固定执行：高通（默认关）→ 降噪（`denoise_mode` off/light/strong）→ 电平归一（恒定开）。
- `engine/audio_chain.py` 的无条件日志：`[预处理] 降噪=off · 电平统一…`；用户只看到「降噪」二字，找不到入口。
- 2026-10-15 的实测结论（引擎注释留档）：降噪在部分素材上**增加**了噪声引起的假音符；当时把入口从 UI 撤掉，强降噪（UVR 模型）需要下载模型。

### 方案（建议分两步）

**P0（低风险，先消除误解）**
1. 日志按实际档位输出：`off` 时只打印 `[预处理] 电平归一（降噪关闭）`，不再出现「降噪=」字样；`light/strong` 才打印档位与生效项。
2. 高级参数里补一行灰字说明：「转录前会自动做电平归一；降噪默认关闭（实测可能增加假音符）」。

**P1（补选项，默认行为不变）**
3. 新增「转录前降噪」下拉：`关闭（默认）/ 轻降噪（谱减）/ 强降噪（UVR-DeNoise，需下载模型）`。
   - 参数链路按仓库契约三跳补齐：`ViewTranscribe.collectParams` → `main/engine.js` map → `music2midi.py` argparse/worker Namespace/`_resolve_params` → `audio_chain`。
   - 预设/队列快照保存 `denoise_mode`；`strong` 未装模型时明确提示去资源中心，不静默降级。
   - 降噪开关默认 `off`，因此**不改变任何现有输出**（可回归断言）。
4. 文档/提示写清代价：轻降噪可能减少稳态噪声；强降噪对「噪声重」素材可能把假音符翻倍（引擎历史实测），建议 A/B 对比后再用。

### 验收
- `off` 时输出 MIDI 与当前版本逐音符一致（A/B 回归）。
- `light`/`strong` 日志只在选择时出现，且强降噪缺模型时返回明确错误。
- i18n EN/JA、参数契约审计通过。

## 2. 转录中切换队列 + 按队列顺序依次转录

### 现状与限制

- 当前 `runBatch()` 直接遍历激活队列的响应式数组；`switchQueue()`/`removeQueue()` 在运行中被拦截，`addQueue()` 已允许但只入列表不切换。
- 每个队列已自带模型/参数快照和「产物歌单」，这是做顺序转录的良好基础。

### 目标行为

1. **运行中可切换 UI 队列**：切换只改变「正在看/编辑哪个队列」，**不打断**正在转录的队列。
2. **运行队列锁定**：运行中的队列禁止改模型/参数/删条目（避免同一批两套参数）。
3. **顺序转录**：增加「依次转录全部队列」开关；调度器按队列显示顺序，一个队列跑完自动切到下一个，直到所有队列完成；每个队列用各自模型/参数/产物歌单。

### 设计（核心是「调度状态」与「视图状态」分离）

- 新增 `runSession`（组件内或 `core/transcribe_runner.js`）：
  `{ queueId, items[], model/params snapshot, playlistTarget, status, progress, queueOrderIndex, chainMode }`。
- `runBatch()` 改为对 `runSession.items` 操作，不再读 `queue` 这个视图数组；完成项写回对应队列对象并持久化。
- `switchQueue()` 运行中只改 `activeQid`，不调用 `snapshotIntoQueue` 覆盖运行队列；运行队列在 UI 上打「转录中」标记并禁用其设置区。
- 「依次转录」调度：维护 `queueChain = queues.map(q => q.id)`；一个队列全部 pending 完成/失败后，自动 `activeQid = nextId`（视图跟随）并启动下一队列；可随时暂停/取消整条链。
- 边界：运行中新建队列允许（已支持）；删除/重排运行队列延后到批次结束；歌单目标每队列独立，开跑时快照。
- 持久化：`fufumidi_queues_v1` 增加 `chainMode`、`runSession` 的恢复字段（只恢复 pending 状态，运行中重启按未完成处理）。

### 验收
- E2E 新增 `transcribe-queue-switch`：两个小队列、顺序转录开关打开 → 队列 A 跑时点队列 B 只切换 UI、A 继续；A 完自动跑 B；两队列产物分别进各自歌单。
- 断点/暂停/取消、运行中删除按钮禁用、运行队列设置锁定均有断言。

## 3. 每个模型的最优识别片段长度（减少前后音色变化）

### 各模型权威块长（本地安装源码/权重配置核对）

| 模型 | 训练/默认块长 | 依据 | 建议预设值 |
|---|---|---|---|
| Basic Pitch | 模型输入固定 **2s 窗**（`AUDIO_N_SAMPLES=43844`），内部流式滑窗 | basic_pitch/constants.py | **0 = 不分段**（外层切片只在省内存时用；30–60s 起） |
| MuScriptor | 内部 **5.0s** 块（`_SEGMENT_DURATION=5.0`） | muscriptor 源码/引擎留档 | **5s（锁定训练块长）** |
| piano-transcription | 训练块 **10s**（`segment_seconds=10, hop_seconds=1`） | piano_transcription_inference/config.py | **10s** |
| Transkun | 默认 `segmentSizeInSecond=16, segmentHopSizeInSecond=8` | transkun/pretrained/2.0.conf | **16s** |
| Aria-AMT | `LEN_MS=30000`、`STRIDE_FACTOR=3`（块 10s、30s 上下文） | amt/inference/transcribe.py | **30s** |

### 为什么「不是越长越好」
- 这些模型都是**按训练块长**学的局部上下文；把推理块改远离训练值，边界处音色/延音判断会漂移，正好是用户说的「前后音色变化」。
- MuScriptor 多乐器模型还有第二个来源：块边界处模型会重新判乐器 → 同一旋律换音色。解法 priority：
  1. 固定 5s 块（训练值）；
  2. 保留现有 `prelude_forcing/跨块延音缝合`（引擎 2026-10-18b 已改为解码后缝合）；
  3. 增加「稳定音色」预设：转录前用 `instrument_probe` 探测主乐器组 → 硬约束（`muscriptor_instruments`），或对相邻块做轨道主导权平滑（新增后处理，需实验）。
- 其它单乐器模型（piano/aria/transkun）不存在跨块换音色问题，片段长度主要影响边界上下文与速度/显存。

### 落地
- 更新每个内置预设的 `segment_sec`：basic=0（或省内存档 30）、muscriptor=5、piano_pt=10、transkun=16、aria=30；UI 滑条显示「推荐」标记。
- 新预设「音色稳定（建议）」用于 MuScriptor：5s + 缝合开 + 乐器组策略；先跑 A/B 验证再设默认。
- 实验矩阵：每模型 × {训练值, 训练值/2, 训练值×2, 0}，固定 60–120s 素材，指标：耗时、峰值显存、边界重复音、音色切换次数、与参考 MIDI 的 F1；结果进 `docs/plans/...` 后再固化默认。

## 4. 「内存补显存」：事实与可选方案

### 先说事实（避免做错方向）

- Windows（WDDM）本来就把显存和系统内存放在同一套内存管理下；NVIDIA 驱动 **536.40（2023-06）** 起，显存不够时不再直接 OOM，而是**静默借用系统内存**（任务管理器里的“共享 GPU 内存”），代价约 **5–10× 变慢**。
- **546.01+** 在 NVIDIA 控制面板提供每应用开关 **CUDA – Sysmem Fallback Policy / Prefer No Sysmem Fallback**：可以关掉「静默借用」，让 OOM 明确报错，便于定位。
- 因此「用内存补显存来提高速度」在物理上不成立；能做的是：**尽量避免溢出**（更快）或 **允许溢出但明确告知会变慢**（能跑完）。

### 方案

**P0：可视化 + 自动避免溢出（真正提速）**
1. 转录页/设置显示 GPU 面板：显存总量/已用/空闲（`torch.cuda.mem_get_info` 或 NVML）、当前批次/块长、是否检测到共享内存溢出（Windows 性能计数器或 NVML 对比）。
2. 新增「低显存模式（自动）」：按空闲显存自动下调 `_PERF_BATCH`、MuScriptor 批大小、MSST batch/chunk、基本音高 ONNX 线程；目标是**不触发驱动溢出**（这才是实打实提速）。

**P1：显式的「允许借用系统内存」档**
3. 提供 `显存策略` 选项：`自动（推荐）/ 禁止借用（OOM 即报错）/ 允许借用（可能 5–10× 慢）`。
   - 「允许」对应驱动默认行为，应用只需提示；「禁止」需要按应用改 NVIDIA 控制面板策略。
   - 若要应用内一键切换：需要读写 NVIDIA 驱动配置（NVAPI/Profile），属于原生小工具；可先做**检测 + 打开控制面板 + 写操作指引**，后续再评估 NVAPI 助手（不建议为了这个引入不稳定依赖）。
4. 实验其它内存手段（收益有限，先测后上）：
   - `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` 降低碎片（不跨显存/内存）；
   - `torch.cuda.set_per_process_memory_fraction` 限制占用、防止拖垮系统；
   - ONNX Runtime arena/shared allocator（basic-pitch）；
   - 真·统一内存（`cudaMallocManaged`/CUDA Unified Memory）需要自定义 allocator/驱动支持，PyTorch 默认不启用；实验成本高、收益不确定，列 P2。
5. 低显存兜底：CPU 模式（慢但可用）/ 混合 offload（模型部分层放 CPU）——优先给用户「能跑完」而不是「假装快」。

### 验收
- 在低显存机器/人为限制显存下：低显存模式不 OOM、不触发驱动溢出，耗时相对「溢出模式」下降（预期显著）。
- GPU 面板数据与任务管理器一致；策略说明清楚，不承诺「内存=显存速度」。

## 5. 其它提速/提质方法清单（按收益排序）

### 提速
1. **避免显存溢出**（见 §4）：溢出 5–10× 变慢，是最大杠杆。
2. **Basic Pitch 批量取窗**：内部 `get_audio_input` 是逐窗推理；改成一次 N 窗批量（GPU/ORT 利用率↑），需验证输出等价。
3. **Basic Pitch ONNX GPU**：确认 CUDA EP 实际启用（`onnx_provider`），而非退 CPU；对比 CPU 线程数。
4. **MuScriptor 批量**：`prelude_forcing=False + batch>1` 可快 2–4×，但边界质量下降（引擎注释有实测）；保持默认串行，批量作为「速度优先」选项。
5. **钢琴批量前向**：现有按性能档 cap；低显存自动降批、高显存升批。
6. **Aria `-bs` 批大小 / Transkun segment-hop**：在显存允许下增大；CPU 用户降线程。
7. **静音分段**（已有）：长音频跳过静音块；默认关，可按素材开。
8. **解码/预处理只做一次**、模型加载缓存、避免重复 resample。
9. **量化**：Basic Pitch ONNX int8（质量需 A/B）、torch bf16（已有开关，改数值精度）。

### 提质
1. **片段长度=训练值**（§3）+ 边界缝合 + 重复音去重。
2. **电平统一**（已有，恒定开）；可选轻降噪（§1），避免过度降噪。
3. **MuScriptor 乐器组约束/音色稳定**（§3）；`instrument_probe` 预分析可自动给出组。
4. **阈值与后处理**：onset/frame、最短音符、力度归一、合并重叠；每模型单独调优预设。
5. **节拍网格**（Beat This!）改善时值；已可选。
6. **质量评估闭环**：`engine/eval_quality.py` + 固定测试集，记录 F1/边界重复/音色切换次数，任何改动先跑基线再合并。

## 6. 实施顺序与验收（建议）

| 阶段 | 内容 | 风险 | 预估 |
|---|---|---|---|
| P0-1 | 降噪日志修正 + §3 预设块长 + GPU 面板 | 低 | 1 天 |
| P0-2 | 运行中切换队列 + 顺序转录（调度器重构） | 中高（核心流程） | 2–3 天 |
| P1 | 降噪选项上线（默认 off）+ 低显存自动模式 | 中 | 2 天 |
| P1-2 | Basic Pitch 批量取窗/GPU、Aria/Transkun 批参数 | 中 | 2 天 |
| P2 | 显存策略 UI/驱动检测、统一内存/allocator 实验、音色稳定后处理 | 高 | 按实验结论 |

**统一验收门槛**：E2E 队列切换/顺序转录用例全绿；每模型预设块长 A/B 报告（速度/质量/边界）不劣化；降噪默认 off 输出逐音符与旧版一致；低显存模式不 OOM；i18n/参数契约/引擎测试通过。

## 7. 参考

- MuScriptor（块长/多乐器边界）：<https://kyutai.org/blog/2026-07-10-muscriptor/> · <https://arxiv.org/abs/2607.08168>
- Basic Pitch（固定 2s 窗口）：<https://github.com/spotify/basic-pitch>
- piano-transcription（segment_seconds=10）：<https://github.com/bytedance/piano_transcription>
- Transkun（--segmentSize/--segmentHopSize、默认 16/8）：<https://github.com/Yujia-Yan/Transkun>
- Aria-AMT（LEN_MS=30000 / stride 3）：<https://github.com/EleutherAI/aria-amt>
- NVIDIA System Memory Fallback（驱动 536.40 引入、546.01 加开关）：<https://nvidia.custhelp.com/app/answers/detail/a_id/5490>
- Shared GPU Memory 实测与慢速代价：<https://runaihome.com/blog/shared-gpu-memory-slow-local-ai-sysmem-fallback-fix-2026/>
- NVIDIA 配置项（Sysmem Fallback Policy 未在 Profile Inspector 暴露的讨论）：<https://github.com/Orbmu2k/nvidiaProfileInspector/issues/166>
- ONNX Runtime 内存优化（shared arena 等）：<https://onnxruntime.ai/docs/performance/tune-performance/memory.html>
- PyTorch CUDA 内存/`expandable_segments`：<https://docs.pytorch.org/docs/stable/notes/cuda.html>


## 实现记录（6.1.2，2026-10-18）

- §1 降噪：日志修正 + 高级参数 off/light/strong（默认 off）已实现；强降噪缺模型走引擎既有降级并提示。
- §2 队列：运行中可切换视图、顺序转录开关（默认关）、各队列产物歌单与暂停/取消链已实现；E2E `transcribe-queue-chain` 真实跑两队列验证。
- §3 片段长度：内置预设写入训练块长并显示「推荐」；`engine/tests/test_transcribe_options.py` 锁定。
- §4 显存：GPU 面板显存字段 + memory_mode auto/low/allow（钢琴批上限减半已实测）；驱动 Sysmem 策略只做说明，未做 NVAPI 自动切换。
- §5 其它提速/提质：Basic Pitch 批量取窗、量化、音色稳定后处理等仍为后续实验项。
### P2 实现记录（2026-10-18 追加）

- §4 P2：`engine_gpu` 通过 nvidia-smi 检测驱动版本/VRAM/Sysmem Fallback 支持（≥536.40；≥546.01 可控制）；界面显示驱动与回退状态。
- 统一内存实验：`engine/cuda_um_experiment.py` + IPC `gpu:unifiedMemoryExperiment` + 界面按钮；实测 cudaMallocManaged 64MB 成功（分配 ~259ms/主机写入 ~540ms），但 PyTorch 默认分配器不能直接用，未接入转录。
- §3 音色稳定：`engine/timbre_stabilize.py` 把短命孤立乐器轨并入邻近主导轨，MuScriptor 预设默认开；`engine/tests/test_timbre_stabilize.py` 锁定行为。
- §3 音色稳定预设：新增「MuScriptor · 音色稳定」（probe 锁定 + 5s + 缝合 + 短命轨后处理）；A/B 报告见 `docs/plans/2026-10-18-muscriptor-preset-ab.md`，已按结果固化 MuScriptor 默认。
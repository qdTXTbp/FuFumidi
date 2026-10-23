# 取消分块转录 + 统一可选转录引擎（2026-10-21）

> 用户原话：「拉取远端v6.1.5最新代码，取消分块转录功能，分块转录会导致各分块质量参差不齐，
> 完善并且统一新的两个转录引擎，使用统一的下载逻辑和管理逻辑」。

三项确认（2026-10-21 与用户逐条对齐）：

| 问题 | 用户选择 |
|---|---|
| 「两个新的转录引擎」指哪两个 | **三个都统一（hFT + YourMT3+ + MIROS）** |
| 「取消分块转录」撤到哪一层 | **全撤：识别片段长度 + 静音分段 + 分段探测** |
| 「统一下载/管理」统一到什么程度 | **建统一运行时下载 + 管理通道** |

## 1. 撤掉了什么

分块转录在这个仓库里有**三种**形态，全部移除：

| 形态 | 原实现 | 现状 |
|---|---|---|
| 识别片段长度 | `segment_sec`：basic-pitch 按秒切片逐段 predict 再合并；MuScriptor 改 `_SEGMENT_DURATION`；piano 改 `segment_samples`；Aria 改 `LEN_MS`；Transkun 传 `--segmentSize` | 全部删除，模型一律用**原生块长**（= 训练块长） |
| 静音分段 | `engine/segmenter.py`：按「完全空白静音」切核心段逐段推理，事件时间加偏移后合并 | 模块与调用链整体删除 |
| 分段探测乐器组 | MuScriptor「自动探测（分段）」档 + `engine/segment_probe.py` | 档位删除，`probe_segments`/`segments` 旧值按整曲探测兼容 |

**保留**的两样（它们不是分块功能，而是对分块的修补/模型固有）：

- MuScriptor 模型内部固有的 5 s 块（`muscriptor.transcription_model._SEGMENT_DURATION`）—— 这是架构，改不了。
- `_stitch_chunk_boundaries()` 跨块延音缝合 —— 它修的是上面那个固有块的接缝；去掉它延音会被切断、僵尸音变多，质量更差。

为什么撤：块与块之间质量参差不齐（接缝处重复音、换音色、延音被切断）。
分段探测的 A/B 数据见 `2026-10-20-segment-probe-ab.md`（音色切换 4 次、边界重复音 1 个、耗时 +3.6 s，F1 还低于全局探测）。

## 2. 三个新引擎完善 + 统一

新增 `engine/transcribe_runtime.py`，把三个引擎（hFT / YourMT3+ / MIROS）接入时各写一遍的样板收敛成一套：

- `find_runtime` / `available` / `first_existing` / `glob_first` —— 路径发现，**不再写死训练批次目录名**
- `prepare_paths` / `stub_wandb` / `patch_torchaudio_soundfile` —— sys.path / wandb 桩 / torchaudio 2.9 补丁（漏打就是 `ImportError: torchcodec`）
- `select_device` / `limit_threads` —— 设备与线程上限（转录是后台任务，不能把 UI 线程饿死）
- `install_pause` / `pause_points` —— 暂停闸门（这三个引擎以前都没接，界面按暂停它们照跑完）
- `decode` / `read_wav` / `cleanup` / `count_notes` / `log_timing` / `release_gpu` —— 临时文件、音符计数、计时、显存归还

各引擎保留自己的推理逻辑，只把外围换成分装。MIROS 的完善点：

1. `available()` 不再把 `le2bzt53` 焊死 —— 换一批训练「下载完了还说没装」，这种不一致**不报错**，最难查；
2. 补 `num_threads` / 暂停闸门 / 显存归还；
3. `os.chdir(repo)` 改 try/finally 保证还原（中途抛异常会把进程 cwd 留在 repo 里，后续队列的临时文件全落错地方）；
4. 0 音符明确报错，不静默产出空 MIDI。

## 3. 统一下载与管理

主进程 `main/models.js`：

- 新增 `installUnpackEntry(spec, win, ctrl)` —— **一个**安装通道，`spec.parts`（分片）与 `spec.url`（单文件）两条来源共用同一套：
  磁盘预检 → 下载 → 体积/SHA256 校验 → 安全解包 → **unpackMarker 验收** → 清理临时产物。
  hFT / YourMT3+ / MIROS / hnsep 全部改走它。
- 修掉的两个真缺陷：
  - 分片分支（MIROS）解包后**不校验 unpackMarker** —— 包结构不对也报「安装成功」；
  - 失败时 `.parts`（5 GB）与 `.oudep` 不清 —— 一次失败留几个 GB，且 `model:delete` 也清不掉。
- 新增 `removeModelArtifacts(p)` / `unpackEntryState(m, dest)`，`model:delete` 与 `model:list` 的
  「装没装好」判据统一到同一处（marker 优先，体积兜底）。

前端 `ViewModels.vue`：分卷描述不再硬编码「× 25MB」（MIROS 的分片是 ~900 MB/片）；
运行时包条目在详情抽屉标明「运行时包（含依赖 + 权重，解包后即用）」。

## 4. 验证

- 引擎：全量 pytest（`--basetemp` 独立）；改动直接相关的 64 项子集全绿。
- 前端：`npm run build:ui` 绿、`npm run test:ui` 546 项全绿、`npm run test:download` 17 项全绿。
- 回归固化：`engine/tests/test_transcribe_options.py` 反向断言「预设/模块/parse_mode 都不许再出现分块键」；
  `scripts/e2e/cases/transcribe-queue-ui.mjs` 同样反向断言「界面不许再出现片段长度滑条与分段探测档」。

# FuFumidi 更新计划 · 参数暴露 + T4/T5 引擎深拆 + Q4(Hnsep)

> 整合三部分：**① 用户可调参数**（转录质量与速度）**② T4/T5 逐引擎深拆** **③ Q4 Worldline-R1.1 / Hnsep**。
> 本文只做规划，**尚未动任何代码**。执行时在条目前打 `[x]` 并补一行实测结果。
>
> 制定日期：2026-10-13 · 发布线：`release/5.0.0` · 前置方案见 `2026-10-13-rea-teardown-and-upgrade.md`

---

## 0. 三条硬约束（用户已明确，不得违反）

1. **凡影响质量的选项默认关**；`prelude_forcing`、`include_pedal` 属**质量基线，不动**
2. **每个控件下面必须有一行小字写清「开了会怎样、关了什么代价」** —— 不许只给开关不给代价
3. **中文文案必须 EN + JA 同步补**（`core/i18n.js` / `core/i18n_ja.js`）
4. **工具 UI 结构不变**：只在现有「高级参数」可折叠区内增删控件，**不新增页面、不重排布局**

---

## 1. 现状：参数三层（已逐一核对，非凭记忆）

核对来源三处独立对照：`engine/music2midi.py` 的 argparse、`main/engine.js:195` 的白名单 map、`frontend/src/views/ViewTranscribe.vue` 的控件。

### A 层 · 界面已可用（不动）

| 控件 | 引擎参数 | Vue 行 |
|---|---|---|
| 起音阈值 | `onset_threshold` | 1294 |
| 音符判定阈值 | `frame_threshold` | 1298 |
| 最小音符长度 | `min_note_length` | 1303 |
| 合并间隔 | `merge_gap_ms` | 1307 |
| 包含踏板事件 | `no_pedal` | 1310 |
| **低音增强** | **`no_melodia` + `min_freq=40`**（仅 basic） | 1313 / 741 |
| 导出速度 | `tempo` | 1318 |
| 最高音高 | `max_freq` | 1322 |
| 超长音符上限 | `max_note_hold` | 1326 |
| 合并重叠音符 | `no_merge` | 1330 |
| 力度归一化 | `no_velnorm` | 1333 |

> **更正**：先前我把 `melodia_trick` 列为「未暴露」是**错的** —— 它已通过「低音增强」**反向暴露**：
> `bassBoost && umodel==='basic' → cfg.no_melodia = true; cfg.min_freq = 40`（`ViewTranscribe.vue:741`），
> 对应 `engine_basic.py` 的 `melodia_trick=False`。**所以 T4-2 的「质量项」其实已经交付了。**

### B 层 · 引擎支持 + 桥接已通 + **只差界面控件**（WP1 的主战场）

`main/engine.js:195` 的 map 里**已有**这些键 —— 界面加控件即可生效：

| 参数 | 作用 | 默认 |
|---|---|---|
| **`prelude_forcing`** | **边界质量控制** | **开（基线，不给用户关）** |
| `temperature` | 采样温度 | 关 |
| `cfg_coef` | 分类器引导 | 关 |
| `beam_size` | 束搜索宽度 | 关 |
| `precision` | fp32/bf16/fp16 | fp32（**实测不提速**，只省显存） |
| `beat_grid` | 节拍网格 | — |
| `muscriptor_instruments` | 乐器组约束 | — |
| `model_size` | small/medium/large | — |
| `min_freq` | 最低音高（界面只有最高音高） | — |
| `min_note_ms` | 最小音符毫秒（钢琴） | — |
| `muscriptor_batch` | 批量推理 | **用户已否决，不接** |

### C 层 · 引擎支持但**白名单里没有**（要先接线）

| 参数 | 说明 |
|---|---|
| `num_threads` | 钢琴链路线程数 |
| `perf_mode` | 钢琴链路 `_batch_cap` 批量前向上限 |

> ⚠️ **`engine_perf.py` 的 quality/balanced/fast 不是提速档，是降速档**：
> `PERF_MODES = {quality: 0（全部核心）, balanced: 4, fast: 2}` —— 给低配机器限线程用的。
> **用户说的「提速梯队」不能靠这个下拉。**

---

## 2. 工作包

### WP1 · 参数暴露（成本最低，收益立刻可见）

| 任务 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **WP1-1** | **接钢琴批量推理**：`num_threads` / `perf_mode` 进 `engine.js` map + 界面 | 引擎侧**已实现**（`engine_pt.py` 的 `_batch_cap` + `_batched_forward`） | 同一首钢琴曲前后墙钟对比；必须 ≥100 块才采信 |
| **WP1-2** | 暴露 `min_freq`（现在被「低音增强」固定成 40） | — | 界面可调，且与「低音增强」不冲突（明确优先级） |
| **WP1-3** | 暴露 `precision`（fp32/bf16/fp16） | — | **文案必须写明「不提速，只为省显存」**（实测 CPU +0.1%、GPU 0.6%） |
| **WP1-4** | 质量组：`temperature` / `cfg_coef` / `beam_size` | — | 默认关；每个下面写清代价；须有 A/B 数据说明各自影响 |
| **WP1-5** | 「高级参数」区按**质量组 / 速度组**分栏 | — | 折叠区结构不变，只分组 |

### WP2 · T4 转录与分离引擎深拆

方法沿用已验证的那套：**定版 → 漂移扫描 → 能力对照 → 只取可落地项**。
**判据以调用链为准，不以文件存在与否为准。**

| 任务 | 目标 | 现状 | 交付 |
|---|---|---|---|
| **WP2-1** | **pymss / MSST 模型对照** | `engine_msst.py` 支持 bs_roformer / mel_band_roformer / htdemucs / mdx23c / scnet | **一张「哪种素材选哪个模型」的质量/速度对照表** + 界面提示 |
| **WP2-2** | **demucs 死代码清理** | `engine.py:246` 对 `mode=="separate"` 直接 raise；`music2midi.py:330` 由 `engine_msst` 接管 | 确认无残留引用后删除 `engine_separate.py`；`requirements-bundle.txt` 注释已改齐 |
| **WP2-3** | **Aria-AMT 定版** | 从 GitHub 装的 **git 版，无版本号** | 定版；`variant` 要么把 `_find_checkpoint()` 改成按 variant 找（并支持多 variant 下载），要么**明确记录不暴露的理由** |
| **WP2-4** | **Transkun 定版** | 只有 `device`/`weight` | 定版 2.0.1 + 记录「不暴露」的理由 |
| **WP2-5** | **basic-pitch 后处理对照** | 阈值已暴露；melodia 已通过「低音增强」暴露 | 对照上游 `infer_onnx` 后处理，确认无遗漏参数 |

### WP3 · T5 歌声合成与调教链路深拆

| 任务 | 目标 | 现状 | 交付 |
|---|---|---|---|
| **WP3-1** | **DiffSinger 参数面** | 本轮已修 DirectML 原生崩溃 + 声库缓存 | 拆步数 / 说话人 / 语言 / 声码器 / variance；给出可暴露项与默认值 |
| **WP3-2** | **GPT-SoVITS 深拆** | **只做了枚举，未拆** | 定版（多来源：`X-T-E-R/TTS-for-GPT-soVITS` 等）→ 拆音色克隆链路参数与对齐质量 |
| **WP3-3** | **Worldline v20(R2) 理由固化** | 源码注明未搬，理由写在注释里 | 读理由 → **固化成结论**，避免下次重估 |

### WP4 · Q4 = Hnsep / Worldline-R1.1（价值最高、成本也最高）

| 任务 | 内容 | 依赖 |
|---|---|---|
| **WP4-1** | 定版 `hnsep_240512` 权重包（`hnsep.yaml` + ONNX） | — |
| **WP4-2** | 移植 `Analysis/Hnsep.cs`：STFT 复数掩码网络（**帧数须为 32 的倍数**；输入输出 `[1,2(re,im),n_fft/2+1,frames]`） | WP4-1 |
| **WP4-3** | 移植 `SynthContinuousNoise` + `sp_env_harmonic` 传递 + `HnAnalysisF0In` 绑定 | WP4-2 |
| **WP4-4** | 资源中心支持下载 `hnsep_240512` | WP4-1 |
| **WP4-5** | 上游那两行：`RENDERER_OPTIONS` 加 `WORLDLINE-R1.1` + `get_default_renderer` 改 `in CLASSIC_RENDERERS` | **WP4-2/3 完成**（否则用户一选就报错） |
| **WP4-6** | A/B：同一 ustx 工程 v10 vs v11，音质主观 + 客观量（耗时、频谱） | WP4-5 |

**为什么顺序不能颠倒**：现有代码在 v11 上会 `raise NotImplementedError`；先把选项放出去＝给用户一个必然报错的按钮。

---

## 3. 执行顺序（按 收益 ÷ 成本）

```
WP1-1 钢琴批量接界面      ← 代码已存在，收益立刻可见
WP1-3/1-5 precision + 分组
WP2-1 MSST 模型对照表     ← 用户最能直接感知
WP2-2 demucs 清理
WP1-2/1-4 min_freq + 质量组
WP2-3/2-4/2-5 定版与理由固化
WP3-1 DiffSinger 参数面
WP4-1 → WP4-2 → WP4-3 → WP4-4 → WP4-5 → WP4-6   ← Hnsep 全链，独立里程碑
WP3-2 GPT-SoVITS
WP3-3 v20 理由固化
```

**WP4 是唯一需要「立里程碑」的**：它是一个模型 + 一条分析链 + 资源中心下载，不是顺手能做完的。

---

## 4. 每项都必须过的门禁

```
npm run typecheck        = 0
npm run test:ui          = 173
npm run test:plugin      = 6
npm run test:download    = 15
pytest engine/tests      exit 0
                       （含 --ignore=test_openutau_core_matches_source.py；
                         该文件现可用 OPENUTAU_REF 接上游克隆真跑）
```

外加两条本项目踩出来的硬规矩：

- **界面改动必须 `node scripts/deploy-installed.cjs` 装到 `E:\Midi\FuFumidi` 跑冒烟**（构建绿 ≠ 能用）
- **新能力要改 5 处**：`preload.js` → `main/<area>.js` → `main/engine.js` 的 map → `frontend/src/types/ipc.ts` → 界面。
  **map 少一个键，界面设了也到不了引擎**（`max_freq` 与 `muscriptor_instruments` 都栽在这张表上）

---

## 5. 明确不做的（附理由，避免反复重估）

| 项 | 理由 |
|---|---|
| `muscriptor_batch` 批量推理 | **用户已明确否决**，代码已移除 |
| 提速梯队 1（bf16/fp16、惰性 conditions、SDPA） | **三项均被实测否决**（SDPA 上游本来就用了） |
| `perf_mode` 当作提速档 | 它是**降速档**（限线程），语义不是提速 |
| `engine_separate.py` 保留 | 死代码，WP2-2 清理 |
| Aria `variant` | `_find_checkpoint()` 走目录取第一个 `*.safetensors`，**不看 variant**；要做需先支持多 variant 下载 |
| Transkun `weight` | 裸文件路径，「用户自带权重」不是受支持的工作流 |
| 上游 `RenderEngine.cs`(Track Polish) | 含 UI 改版，与「UI 不变」冲突 |
| 上游 `RenderPhrase.cs` / `Worldline.cs` auto gain | 依赖「表达式图」与「hifisampler」，两者均未搬 |

---

## 6. 已知的环境阻塞（本机无法完成）

| 项 | 阻塞 |
|---|---|
| Intel XPU 实机验证 | 本机无 Intel GPU |
| AMD ROCm 实机验证 | 本机无 AMD GPU |
| P3 的 worldline vs 外部 resampler 对照 | 本机 `FuFumidiData\resamplers\` 不存在 |
| ~~Q4 缺声库~~ | 已解除：`voicebanks\` 下有 `ChenZhe_Voice` / `HowHow_CV` / `Iona_Beta` |

---

## 7. 待确认

1. **WP1-2 的优先级冲突**：「低音增强」现在把 `min_freq` 固定成 40。若再给一个独立的 `min_freq` 控件，
   两者同时生效时以谁为准？（建议：显式控件优先，勾选「低音增强」时只设 `no_melodia`）
2. **WP4-1 的权重来源**：`hnsep_240512` 包从哪取？上游 OpenUtau 的资源仓库、还是自建镜像到 CNB？
   这决定 WP4-4 的实现方式。

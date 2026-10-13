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
---

## 8. ★ 勘误（2026-10-14 开工会话）—— 本文 §1 的 B/C 层清单**大部分是错的**

开工前逐行核对 `ViewTranscribe.vue` 全文（先前用了 `.slice(0, 30)` 被截断在 1333 行，
又只读了 `engine.js:195` 的 map 字面量、漏看它上面一行的 `perf`）—— **实际状态如下**：

### 已经做完的（原计划误列为「待做」）

| 参数 | 实际位置 |
|---|---|
| `temperature` / `cfg_coef` / `beam_size` / `prelude_forcing` | **已有控件**：`ViewTranscribe.vue:1337–1352`（**批 B 已完成**） |
| `precision` | **已有**：`msPrec` 选择器 `:1360` |
| `model_size` | **已有**：Small/Medium/Large 按钮 `:1132–1134` |
| `beat_grid` | **已有**：`:1368` |
| `muscriptor_instruments` | **已有**：`:75` |
| `max_note_hold` / `max_freq` / `tempo` / `no_merge` / `no_velnorm` | **已有**：`:1322–1333` |
| `no_melodia` + `min_freq=40`（低音增强） | **已有**：`:1313` / `:741` |
| **`perf` 性能档** | **已有三按钮 + 自动推荐**：`:1283–1285`；`main/engine.js:191` 已接线；`task-queue.js:44` 已传 `--perf` |

**结论：原 `WP1-1`（钢琴批量接界面）、`WP1-3`（precision）、`WP1-4`（质量组）三项**
**开工即发现已完成，直接删除。** 参数暴露这条线**基本已经走完**。

### 仍然真的没做的（更正后的 WP1）

| 任务 | 内容 | 依据 |
|---|---|---|
| **WP1-2** | 独立 `min_freq` 控件（现在只被「低音增强」固定成 40） | `ViewTranscribe.vue:743` |
| **WP1-5** | 「高级参数」区按**质量组 / 速度组**分栏 | 现在是「批 A 段 / 批 B 段」两段注释，`:1315` / `:1335` |
| **WP1-6（新）** | **「高性能」标签语义错误** | 见下 |

### ★ WP1-6：「高性能」这个标签是**反的**

`fast` 档的实际含义（`engine_perf.py:24` + `engine_pt.py:22`）：

| perf_mode | 线程数 | 钢琴批量上限（CUDA/CPU） | 实际是 |
|---|---|---|---|
| `quality`（默认） | **0 = 全部核心** | **32 / 16** | 资源最多、**最快** |
| `balanced` | 4 | 16 / 8 | 中间 |
| **`fast`** | **2** | **8 / 4** | **资源最少、最慢** |

但界面（`ViewTranscribe.vue:335` / `:1285`）把它标成 **「高性能」**，英文 **"Performance"**，日文「高性能」。
**用户为了"快"去点它，得到的是最慢的一档。** 它真正的作用是**给低配/小显存机器防 OOM**。

→ 改法（属文案修正，不动 UI 结构）：标签改为「**低配省资源**」这类**如实描述代价**的说法，
并补一行小字说明「线程与批量都会下调」。**这条符合用户既有原则：「不许只给开关不给代价说明」。**

### 顺带发现的一处**过期注释**（不影响行为，但会误导后来者）

`ViewTranscribe.vue:751–756` 仍写着「均衡/高性能档用批量吞吐（prelude_forcing 关闭）」——
但紧接着 `:757` 写着「批量推理**改成显式开关**」，而项目早已**移除批量推理**（`bca0a55`）。
这段注释描述的是**已不存在的旧行为**，应一并更正。

---

## 9. WP1 执行记录（2026-10-14）

### 已完成并部署

| 任务 | 内容 | 验收 |
|---|---|---|
| **WP1-6** | 「高性能」→「低配省资源」，加常驻代价说明；同时修 `SettingsPanel`「质量越高耗时越长」与 i18n 引导「档位越高越慢但越细腻」两处**同样反向**的文案。共 5 处 | 安装版 `app.asar` 内实测：`低配省资源`×14、旧文案 **0 处** |
| **WP1-7** | 更正 `ViewTranscribe.vue` 里描述「已移除的批量推理」的注释 | — |
| **WP1-2** | 最低音高独立成控件（用户定：**显式控件优先**，勾「低音增强」只设 `no_melodia`） | 独立滑杆 0–2000 Hz |
| 门禁 | typecheck 0 / test:ui 173 / build:ui 0 / deploy exit 0（冒烟 0 异常） | — |

提交：`01ab017`（WP1 实做）、`9eb994e`（§8 勘误）

### WP2-1 勘查结果（MSST 模型对照）

`main/models-msst-catalog.js` 共 **78 条**（multi 9 / vocal 19 / single 21 / vr 29）。
**24 个模型文件名里带 SDR**（客观质量指标），降序前几名：

| SDR | 分类 | 架构 | 模型 |
|---|---|---|---|
| 27.9959 | single | Mel-Band Roformer | `denoise_mel_band_roformer_aufr33_sdr_27.9959` |
| 19.1729 | single | Mel-Band Roformer | `dereverb_mel_band_roformer_anvuew_sdr_19.1729` |
| **12.9755** | **vocal** | **BS-Roformer** | `model_bs_roformer_ep_317_sdr_12.9755` ← **人声分离最高** |
| 11.4700 | multi | Bandit | `model_bandit_plus_dnr_sdr_11.47` |
| 10.8059 | multi | MDX23C | `aufr33-jarredou_DrumSep_..._sdr_10.8059` |

架构分布：`UVR-VR` 27 · `Mel-Band Roformer` 21 · `BS-Roformer` 8 · `HTDemucs` 7 · `MDX23C` 5 · 其余 10。

**★ 勘误（本轮第三次栽在同一处）**：我先前说「`best` 推荐标签没渲染」是**错的** ——
`ViewModels.vue:180` 早就在渲染 `👑 {{ m.best }}` 徽章。原因是 grep 又用了 `.slice(0, 16)` 截断，
`ViewModels.vue` 的命中排在后面被切掉。**「截断的输出不能用来下结论」这条已连犯三次。**

### 本轮发现的真实缺陷（未修，待定）

**`--model` 在两种模式下语义不同，而 help 只写了其中一种**：

- `music2midi.py:427` 的 `--model`，help 写「**子模型**: universal→basic/muscriptor；piano→piano_pt/aria/transkun」
- 但 `cmd_separate:309` 把它当**文件路径**：`"model_path": getattr(args, "model", None)`
- 「音频处理（MSST 分离）参数」组（`:488–494`）有 `--arch`/`--config`，**偏偏没有 `--model`**

**应用侧不受影响**：`main/separate-common.js:69` 传的确实是 `'--model', resolved.modelPath`。
**受影响的只有 CLI 与文档** —— 照 help 字面理解的人（比如我）会传子模型名，然后拿到
「未找到模型文件，请先在模型管理中下载所选模型。」这条**指错方向**的报错。

**★ 更正（同日查明）**：基准其实**不是**被这条缺陷挡住的 —— **是我把模型路径写错了**。

模型不是平铺在 `models/vr/` 下，而是**每人一个子目录**（对应 `models.js:215` 的 `dest = catOf + '/' + key`）：

```
models/vr/1_hp_uvr/1_HP-UVR.pth                     120.9 MB
models/vocal/big_beta5e/big_beta5e.ckpt             1411.2 MB
models/vocal/bs_roformer_large/BS-Roformer_LargeV1.ckpt  706.0 MB
models/vocal/melband_roformer_instvox_duality_v2/….ckpt  1639.5 MB
```

我先前用 `Get-ChildItem -Recurse -File` 列出的是**子目录里面**的文件，
于是把 `models\vr\1_HP-UVR.pth` 当成了路径（少了一层 `1_hp_uvr\`）→ `os.path.isfile` 为假。
**「未找到模型文件」这条报错是准确的，指错方向的是我。**

**上面那条 `--model` 双语义的缺陷仍然成立**（同一个标志在转录/分离两种模式下含义不同，
help 只写了转录那种），只是它**不是**这次基准失败的原因。已按此更正。

**非 VR 架构还需要 config yaml**，位置是 `engine/msst_configs/` + `index.json`
（`models.js:937–955` 按 `outName` 查表）。实测三条：
`big_beta5e.ckpt → big_beta5e.yaml`、
`BS-Roformer_LargeV1.ckpt → config_bsrofoL.yaml`、
`melband_roformer_instvox_duality_v2.ckpt → config_melbandroformer_instvoc_duality.yaml`。
`--arch` 会被 `model_type_for` 归一化（只留字母数字再小写）：`BS-Roformer`→`bsroformer`→`bs_roformer`。

### ★★ 跨架构分离实测（WP2-1 的核心产出）—— 结果是**否定**的

同一段 **30 秒 / 44.1kHz 立体声**切片，4 个模型各跑一次：

| 模型 | 架构 | 体积 | 第 1 次分离耗时 | 第 1 次墙钟 |
|---|---|---|---|---|
| `1_HP-UVR` | UVR-VR | **121 MB** | **23.4 s** | 26.6 s |
| `BS-Roformer_LargeV1` | BS-Roformer | 706 MB | 38.6 s | 42.5 s |
| `big_beta5e` | Mel-Band Roformer | 1411 MB | 16.9 s | 24.6 s |
| `melband_roformer_instvox_duality_v2` | Mel-Band Roformer | **1640 MB** | **13.0 s** | 18.1 s |

**最重的反而最快、最轻的最慢** —— 我原本的假设「Roformer 类更重更慢」当场被证伪。

#### 反序复测：差异是**冷缓存 + 固定启动成本**造成的

| 模型 | 第 1 次（冷） | 第 2 次（热缓存） |
|---|---|---|
| `melband_duality` (1640MB) | 13.0 s | **10.1 s** |
| `1_HP-UVR` (121MB) | **23.4 s** | **10.3 s**（快了 **2.3×**） |

**热缓存后两者几乎持平（10.1 vs 10.3 秒）。** 说明第一轮的差异主要来自
「每次进程都要付的加载/初始化 + 冷盘 I/O」，**不是模型算力**。

#### 结论（这条最重要：**不加**）

1. **不给界面加「速度量级」提示。** 架构假设已证伪，实测又被固定成本污染 ——
   此时写进界面的任何速度标注都是**没有依据的**。宁可没有，也不要一条错的。
2. 30 秒素材**太短**：固定成本与模型算力项同量级，分不开。
   要真正排序，需要**更长的素材**（≥3 分钟，让逐秒项压过固定项）并**固定热缓存**，
   或者干脆在**同一进程内**依次跑各模型（消掉加载项）。
3. 这条同时给 §3 的顺序提了个醒：**WP2-1 的「界面提示」不做了**，
   改成只在文档里留这张表 + 说明「未排序，勿据此选型」。

**基准脚本与日志**：`_attic\_sing_tmp\sep_*.log`、`r2_*.log`（可复跑）。

本机可实测的分离模型（后续补基准用）：`vocal/` 下 `big_beta5e`(1411MB)、
`BS-Roformer_LargeV1`(706MB)、`melband_roformer_instvox_duality_v2`(1640MB)；`vr/` 下 `1_HP-UVR`(121MB)。
**跨架构实测是给界面加「速度量级」提示的前提** —— 不实测就不加，避免又一条无依据的断言。

---

## 10. ★ WP4-1 完成：`hnsep_240512` 包源已找到并**逐字节校验**（2026-10-14）

#### 怎么找到的（可复现路径）

1. `Hnsep.cs:61` 写的是 `PackageManager.Inst.GetInstalledPath("hnsep_240512")`
   —— 包由 OpenUtau 自己的包管理器安装，**源码里没有硬编码下载地址**
2. 读 `OpenUtau.Core/PackageManager.cs:66`，得到唯一注册表：
   `https://openutau.github.io/svs-index/registry/v1/softwares/all.json`
3. 该注册表只有 **5 条**，其中就有 `hnsep_240512`：

```json
{
  "id": "hnsep_240512",
  "names": { "en": "HN-SEP: Harmonic/Noise Separation" },
  "category": "host_extension",
  "developers": ["yxlllc"],
  "homepage_url": "https://github.com/yxlllc/vocal-remover",
  "tags": ["oudep"],
  "versions": [{ "version": "240512", "mirrors": [{
    "url": "https://github.com/stakira/vocal-remover/releases/download/hnsep_240512-oudep/hnsep_240512.oudep",
    "hash": "sha256:8f8c1046d0cacd40363e6f71d48bc1663e06a01d4625af0569055648d771ff92"
  }] }]
}
```

#### 下载与校验

| 项 | 值 |
|---|---|
| 体积 | **52.39 MB** |
| 实得 SHA-256 | `8f8c1046…d771ff92` |
| 官方 SHA-256 | **完全一致** ✓ |
| 通道 | `ghfast.top` 代理，28.2 秒（≈1.9 MB/s） |

#### 包内容（`.oudep` 实为 zip，前 4 字节 `50 4B 03 04`）

| 文件 | 大小 | 说明 |
|---|---|---|
| `hnsep.yaml` | 0.1 KB | 配置 |
| `model.onnx` | **57,663 KB** | 网络本体 |
| `oudep.yaml` | 0.2 KB | `id/name/version/class: Hnsep`，描述写明 **used by Worldline-R1.1** |
| `LICENSE` | 1 KB | **MIT，Copyright (c) 2019 tsurumeso** |

`hnsep.yaml` 与 C# 的 `HnsepConfig` **逐项一致**：

```yaml
model: model.onnx
sample_rate: 44100
n_fft: 2048
hop_length: 512
```

#### ★ 结论

**WP4 的关键未知项全部消除**：包源、固定 URL、官方 SHA-256、内容结构、许可证，五项都落实了。
移植侧因此全是已知量 —— `HnsepConfig` 三项对应 `hnsep.yaml`；ONNX 的输入输出为
`[1, 2(re,im), n_fft/2+1, frames]`（`Hnsep.cs` 注释：**帧数须为 32 的倍数**）；
STFT/ISTFT 必须复刻 torch 的 **periodic Hann + center=True（零填充）** 语义。

**许可证无阻碍**：MIT，分发时随包保留 `LICENSE` 即可，与 `docs/VENDOR.md` 的既有做法一致。

#### WP4-4（镜像部分）已完成 —— 自建镜像到 CNB

按你的决定「自建镜像到 CNB」上传（`scripts/cnb-upload.py`）：

```
创建 CNB release hnsep-v1 (id=2109958363076763648)
  verify hnsep_240512.oudep -> 200
上传成功 hnsep_240512.oudep (52.4 MB, 56s) -> FuFuCloud-mirror/Models@hnsep-v1
```

**公开地址（已独立验证）**：

```
https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/hnsep-v1/hnsep_240512.oudep
  HTTP 200 · content-length 54,934,878 (= 52.39 MB，与本地同体积) · content-type application/zip
```

**踩到的一个坑（记下来）**：`FuFuCloud-mirror/Models` **只有 `main` 分支，没有 `master`** ——
`cnb-upload.py` 的 `--commitish` 默认是 `master`，首次上传因此报
`400 invalid commit revision master`。该仓要用 `--commitish main`。
（对比：`FuFuCloud-mirror/FuFuMIDI` 有 `master` / `release/5.0.0` 等，默认值在那里是对的。）

镜像落在 **`FuFuCloud-mirror/Models`** —— 与 `main/download-source.js:48` 的模型镜像仓一致
（`models: 'FuFuCloud-mirror/Models'`），不是随便找个仓塞进去。

---

## 11. ★ WP4-3 + WP4-5 完成：R1.1 代码链路全通（2026-10-14 续）

### WP4-3 · `SynthContinuousNoise` 全链接通

| 落点 | 改动 |
|---|---|
| `worldline.py` · `SynthSegment` | 补 hnsep 分支：**在未裁剪的原始样本上、带前后各 `fs/5` 上下文**分离再取回本段；谐波分量与 `samples` 乘**同一个**输入增益；分析改走 `HnAnalysisF0In`；`sp_env_harmonic` 按目标帧插值带出 |
| `worldline.py` · `_resample_flat` | 把 `resample_features` 的插值核抽出来给 `sp_harmonic` 复用（照抄一份必然漂移）；重构前后**逐元素一致**有测试对账 |
| `worldline.py` · 异常 | 新增 `HnsepSampleRateError`（对应上游裸的 `NotSupportedException`，**不是** `SynthRequestError` 子类） |
| `worldline.py` · 绑定 | `HnAnalysisF0In` 等 10 个导出**全绑齐**（无需重编 native） |
| `tests/test_openutau_core_matches_source.py` | 新增 `test_worldline_r11_continuous_noise()`：**33 项**断言，含"分离拿到的是上下文+本段（40572 样本，不是裁剪后的 28224）"、"增益两边同乘（恒等分离下逐元素相等）"、"重构前后逐元素一致"、"没有 hnsep 时 `sp_env_harmonic` 保持 None"，外加 7 条 C# 源码一致性 |

**真机端到端（真 `worldline.dll` + 真 `hnsep_240512` 模型）**：

```
分析+分离  0.38 s / 40 帧        模型加载 0.23 s · sample_rate 44100
sp_env[0:3]      = [2.025, 2.028, 2.035]     ← 原样本包络（含噪声能量）
sp_harmonic[0:3] = [0.748, 0.749, 0.752]     ← 谐波半边自己的包络
ap[0:3]          = [0.546, 0.542, 0.536]     ← 低频谱点：那里本来就只有噪声
v11 22051 样本 · 峰值 0.7567 · RMS 0.3605 · 全有限
v10 22051 样本 · 峰值 0.6828 · RMS 0.3360
同一 seed 逐样本相同 = True · 不同 seed max|Δ| = 0.2693（噪声真的由 seed 控制）
v11 vs v10 max|Δ| = 0.9072（与峰值同量级 → v11 不是 v10 的复制）
```

**代价（将来要写进界面提示的数字）**：同机同段 v11 **0.43 s** vs v10 **0.12 s**，约 **3.6×**
（其中分离本身约 0.3 s）。v11 是"更贵换气声/噪声不被脉冲模型抹平"，**不是提速项**。

### WP4-5 · 两处**前向移植**（我们盯的基线比上游旧）

| | 基线 `04c4e61005` | 上游 master | 我们 |
|---|---|---|---|
| `getRendererOptions()` | `{ "WORLDLINE-R", "Classic" }` | `{ WORLDLINE_R, WORLDLINE_R11, CLASSIC }` | 跟 master |
| `GetDefaultRenderer` | `DefaultRenderer == "Classic"` | `classicRenderers.Contains(DefaultRenderer)` | 跟 master |

- 计划里写的"上游那两行"指的是 **master**，不是我们的参考克隆 —— 已核实（取法见 §12）。
- 语义变化：选项名**统一成渲染器 id**，旧的 `"Classic"` 不再匹配、回落 `WORLDLINE-R`；
  换来的是"选过 R1.1 就一直用 R1.1"（跨重启）。
- **没有存量迁移问题**：`Preferences.default_renderer` 默认空串、且当前不落盘。
- 测试改成"**记录**参考克隆是基线版本 + 用功能断言钉住 master 语义"，不假装克隆里有 master 的代码。

### ★★ 最重要的一条：v11 在应用里**还不可达**（新发现，需要你定夺）

- `engine_openutau.py:697` 把 `track.renderer_settings.renderer` **硬编码成 'CLASSIC'**；
  应用实际走 `ClassicRenderer + WorldlineResampler`（逐音素 `worldline.resample()`）。
- `WorldlineRenderer`（v10 / v11 / v20 所在的**乐句级**渲染器）**全仓零调用方**；
  `get_renderer_options()` / `get_default_renderer()` 同样**没有任何调用方**，前端也不读。
- ∴ **WP4-5 不产生任何界面变化**；而 **WP4-4 就算把 52 MB 模型下下来，用户也拿不到东西**。
- 要让 R1.1 真的对用户可用，得新增一个"轨道渲染器"选择入口、并让渲染改走 `WorldlineRenderer`。
  **那是界面/行为改动，与「工具 UI 不变」直接冲突** —— 所以停在这里等决定，不擅自接线。

### 顺带修掉的一个真实测试缺陷（不是这次改出来的，是被暴露的）

- `test_classic_renderer_external_path` 的 `_Host` 替身 `copy_source_temp(self, source, temp)`
  **少一个 `resampler` 形参**（实现自上游 `b30d3347` 起是三个）→ 整条外部路径测试直接
  `TypeError`，**不是断言失败**。这种失败最容易被误读成"环境不行"。已修。
- 补下 `git checkout 04c4e61005 -- OpenUtau.Plugin.Builtin`（61 个 .cs）后，**10 个音素器测试
  从 FileNotFoundError 转为真跑并通过** —— 之前那 11 项失败里 10 项是参考克隆不完整，只剩 1 项是真缺陷。

### 门禁（本次）

```
pytest engine/tests   （OPENUTAU_REF=上游克隆，**不 ignore** 对照文件）  → exit 0
```

---

## 12. 参考克隆的取法（可复现）

上游对照跑不起来时按这个顺序补，别急着下"环境不行"的结论：

```powershell
cd E:\Midi\_attic\openutau-upstream
# OpenUtau.Core（.cs 对照测试读它）
git -c 'url.https://ghfast.top/https://github.com/.insteadOf=https://github.com/' checkout 04c4e61005 -- OpenUtau.Core
# OpenUtau.Plugin.Builtin（10 个音素器测试读它）
git -c 'url.https://ghfast.top/https://github.com/.insteadOf=https://github.com/' checkout 04c4e61005 -- OpenUtau.Plugin.Builtin
```

- 仓库是 `blob:none` 克隆，checkout 会**按需拉 blob 并中途失败** —— **循环重试即可**
  （实测第 2 次就 EXIT=0，拿到 61 个 .cs；第一次失败时也已落下 59 个，别以为全丢了）。
- 想看**比基线更新**的上游代码（例如 WP4-5 那两行），走
  `https://ghfast.top/https://raw.githubusercontent.com/stakira/OpenUtau/master/<path>`，
  别在 blob:none 的克隆里 `git show` —— 实测 `git grep HEAD` 走远程拉取会卡到超时，只能 kill。


---

## 13. WP4-6 · v10 vs v11 真实人声 A/B（2026-10-14）

素材：真声库音素（`Iona_Beta/ka.wav` 4.50 s、`HowHow_CV/shen.wav` 1.01 s），用**安装版**的 engine 副本 +
安装版 python + 真 `worldline.dll` + 真 `hnsep_240512`。可试听文件：`E:/Midi/_attic/ab-v10-v11/{ka,shen}_{v10,v11}.wav`

| 指标 | ka（CV，4.50 s） | shen（擦音重，1.01 s） |
|---|---|---|
| 耗时 v10 | 765 ms（**5.9×** 实时） | 124 ms（**8.1×** 实时） |
| 耗时 v11 | 1971 ms（**2.3×** 实时） | 454 ms（**2.2×** 实时） |
| → v11 倍数 | **2.58×** | **3.65×** |
| 峰值 / RMS | v10 0.581 / 0.118 · v11 0.602 / 0.118 | v10 0.754 / 0.082 · v11 0.758 / 0.083 |
| 相关系数 | 0.9717 | 0.8916 |
| >8 kHz 能量占比 | v10 −33.77 dB · v11 −33.82 dB | v10 −25.82 dB · v11 −26.66 dB |
| 谱质心 | 2555 → 2427 Hz | 3459 → 3411 Hz |
| 谱平坦度（源为基准） | 源 0.0923 · v10 0.0897 · **v11 0.0963** | 源 0.0886 · v10 0.0886 · v11 0.0871 |
| 逐帧相对差异（50 ms） | 中位 **19.2%**，最大 137.6% **在 0.00 s** | 中位 **139.1%**，最大 192.9% |
| 差异的时间分布 | 前 1/4 **41.4%** / 中 1/2 19.4% / 后 1/4 14.6% | 164.8% / 68.3% / 142.3% |

### ★ 怎么读这张表（别读错）

1. **v11 不是「更亮的音色」。** >8 kHz 占比没提升（ka −0.05 dB、shen −0.84 dB），谱质心还略微下降。
   **「谐波半边 + 连续噪声」不等于「更多高频」。**
2. **v11 的噪声是另一次随机实现。** shen 的逐帧相对差异中位 **139%**（>100% = 相位不相关），
   但它的**谱平坦度与谱质心几乎与 v10 相同**（0.0871 vs 0.0886；3411 vs 3459 Hz）。
   同谱不同相位 —— 因为 `WorldSynthesisContinuousNoise` 的噪声分量由 **seed** 决定
   （同一 seed 逐样本可复现，已验证）。**∴「v10 与 v11 逐样本对比」对非周期成分没有意义**，
   只能比包络与统计量。
3. **v11 真正改动最大的是起音/辅音段**：ka 的前 1/4 差异 41.4%、后 1/4 只有 14.6%。
   这与它的设计目标一致（连续噪声模型对非周期段更贴）。
4. **客观指标无法判定「哪个更好听」。** 包络基本没变、差异集中在噪声实现与辅音段 ——
   **这一条必须靠耳朵**。已导出 4 个 wav，等试听结论。

### 与 WP4-5 的关系（这条决定 WP4 要不要继续投入）

v11 的代价是 **2.6～3.7×**（2.2× 实时，已经不是「随便开」的档），而客观收益目前**不明确**；
再加上 §11 那条「v11 在应用里还不可达」——**在听到试听结论之前，不该去接那个界面入口**。
---

## 14. WP2-3 / WP2-4 / WP2-5 完成（2026-10-14 续）

### WP2-3 · Aria-AMT 定版 + 一个**静默跑错模型**的口子

**定版**。两个包从 GitHub 装且**不带 ref**，`pip` 取的是"默认分支当时的 HEAD"；
而两个 dist 的版本号都是没用的 `0.0.1` —— 隔一周装就是两份不同代码，出问题查不出区别。
从**安装版**的 `dist-info/direct_url.json` 读到实际安装的 commit，钉进 `deps.ARIA_PINS`：

| 包 | 定版 commit |
|---|---|
| `EleutherAI/aria-amt` | `a1ab73fc901d1759ec3bc173c146b3c6a3040261` |
| `EleutherAI/aria-utils` | `4ed0749d2d70918610f03a5316bf283479ff9d09` |

同时把 zip 兜底从 `archive/refs/heads/{main,master}.zip` 改成 `archive/<sha>.zip`：
原来的写法会让 **git 可用与不可用的机器装到不同版本**（`ARCHIVE_REFS` 已删）。

**真问题（不只是"没定版"）**：aria 的 CLI 是 `transcribe <model_name> <checkpoint_path>`，
两个位置参数**配对** —— `model_name` 决定读 `site-packages/config/models/{name}.json` 的网络结构，
权重由第二个参数给。包内自带三个配置（`medium-double` / `medium-single` / `medium-triple`），
而 `_find_checkpoint` 原来是"目录里第一个 `*.safetensors`" —— 拿 A 的结构加载 B 的权重
**不会报错**，只会静默跑错。资源中心目前只镜像 `piano-medium-double-1.0`，所以一直没露出来。

→ `_find_checkpoint(model_dir, variant)` 改成**按 variant 匹配**（排序保证稳定，找不到才回退），
并在调用处对"权重名里没有 variant"发一条明确告警。

### WP2-4 · Transkun 定版 + 「不暴露」的理由固化

`transkun>=2.0.1` → `transkun==2.0.1`。它 CLI 一共只有 5 个选项，我们只暴露 2 个：

| transkun 选项 | 我们 | 理由 |
|---|---|---|
| `--device` | ✅ 暴露 | |
| `--weight` | ✅ 暴露 | |
| `--conf` | ❌ | 模型结构配置。改它就是换模型，不是"调参" |
| `--segmentHopSize` | ❌ | 内部滑窗步长，默认值写在模型 conf 里 |
| `--segmentSize` | ❌ | 内部滑窗长度，默认值写在模型 conf 里 |

后两个是"速度/显存"旋钮：调大在长音频上**直接 OOM**，收益只有几十秒，默认值本来就是作者调好的。
归入 §5「明确不做」。钉死版本同时保证这三项默认值不随上游升级漂移。

### WP2-5 · basic-pitch 后处理对照：**已无遗漏参数**（只差一个，且是判断题）

上游 `basic_pitch.inference.predict` 的签名与我们的 `transcribe_basic` 逐项对照：

| 上游参数 | 默认 | 我们 |
|---|---|---|
| `audio_path` | — | ✅（先经内置 ffmpeg 解码成 22050 Hz WAV） |
| `model_or_model_path` | nmp.onnx | ✅ 传 `make_basic_model(num_threads)`（int8 量化版） |
| `onset_threshold` | 0.5 | ✅ 已暴露 |
| `frame_threshold` | 0.3 | ✅ 已暴露 |
| `minimum_note_length` | 127.7 | ✅ 已暴露（我们默认 128.0） |
| `minimum_frequency` | None | ✅ 已暴露（WP1-2 的独立「最低音高」+ 低音增强） |
| `maximum_frequency` | None | ✅ 已暴露 |
| `melodia_trick` | True | ✅ 已暴露（低音增强那条链路） |
| `midi_tempo` | 120 | ✅ 已暴露（且支持自动 BPM） |
| `multiple_pitch_bends` | False | ❌ **唯一没转发的用户可见参数** |
| `debug_file` | None | ❌ 内部诊断文件，不需要 |

**关于 `multiple_pitch_bends`**：它为 True 时同一条音符可以有**多条**弯音曲线
（颤音 / 滑音），对**唱腔**素材有用。下游消费者查过了：
引擎里只有 `midi_edit.py` 会写弯音，`midi_post.apply_post` **不动** `pitch_bends`，
所以开了就会真的落进导出的 MIDI（播放端 js-synthesizer/libfluidsynth 认弯音）。

→ **这是一条待你定的判断题**，不擅自加控件：它是"质量类、零运行时成本"（符合可暴露的门槛），
但会改变导出 MIDI 的内容（多出大量弯音事件），而它算不算「工具 UI 变了」由你定。
记入 §7 待确认。

### 顺带补的测试（这两条此前**零覆盖**）

新增 `engine/tests/test_engine_aria_transkun.py`（6 项）：

- 两个变体同时在目录里时，必须选**与 variant 匹配**的那个（就是上面修掉的那个 bug）
- 无匹配时的回退**必须稳定**（同一目录两次选同一个文件）
- 空目录 / 不存在 / 只有隐藏文件 → `None`
- `ARIA_PINS` 必须是 40 位 commit，且 git+ 与 zip 两条路取**同一个** commit、不含 `refs/heads/`
- `requirements-bundle.txt` 里必须是 `transkun==2.0.1`（不能是 `>=`）
- 两个引擎模块可导入、`available()` 返回布尔



# 转录：模型选项 + 提速 计划（2026-10-12）

> 本文件是**跨会话交接单**：不依赖任何对话上下文，照它就能继续做。
> 执行到哪一步，就在对应条目前打 [x] 并补一行结果。

## 0. 目标（用户原话）

1. 给转录提供**更多模型上的选项**（含「边界质量控制」）—— **五个模型全都要**
2. 钢琴专用模型（piano-transcription / Aria-AMT / Transkun）也要有对应选项
3. **在修好当前问题的前提下**提高转录速度，**特别是超长音频**
4. **影响质量的选项默认关闭**；界面要加这些按钮

## 1. 仓库与流程（照做）

- 仓库：`E:\Midi\FuFumidi-Source`，发布线 **`release/5.0.0`**
- 远端：`origin` = GitHub `qdTXTbp/FuFumidi`（**直连不通，必须走代理**）、`cnb` = `https://cnb.cool/FuFuCloud-mirror/FuFuMIDI.git`
- 推送：
  `~powershell
  git -c 'url.https://ghfast.top/https://github.com/.insteadOf=https://github.com/' push origin release/5.0.0
  git push cnb release/5.0.0
  `~
- 门禁（每次改完必跑）：`npm run typecheck` / `test:ui`(173) / `test:plugin`(6) / `test:download`(15)
- 引擎测试：`venv\Scripts\python.exe -m pytest engine/tests -q --ignore=engine/tests/test_openutau_core_matches_source.py`
  （被 ignore 的那个要读外部 `D:/FuFuMIDI/_ref`，本机没有，属既有失败）
- 部署到安装版：`node scripts/deploy-installed.cjs`（会先关掉应用），产物 `E:\Midi\FuFumidi`
- 常用 Python：`E:\Midi\_attic\_sing_tmp\venv\Scripts\python.exe`（有 pytest / muscriptor / pretty_midi）
- **安装版自带 Python**：`E:\Midi\FuFumidi\resources\python\python.exe`（验证部署产物要用它）

## 2. 已经做完的（勿重做）

| 提交 | 内容 |
|---|---|
| `fa438c4` | 事件流「僵尸音符」上限（默认 15s）+ `[自检]` 日志（音符数/中位数/>2s 占比/最长） |
| `82eab7d` | **上游级补丁** `muscriptor 0.3.0+fufumidi.1`（改 `OpenNoteTracker`）+ 托管到 `monologue82/Models/muscriptor-runtime/` + `deps.py` 改为从这里装 |
| `bb99d0b` | 上传脚本：直连/代理**自动测速选路** |
| `ac2b697` | 修好「取消转录」—— worker 路径与 spawn 路径各记各的账 |
| `1485026` | `package.json` 的 `description` 乱码还原（快捷方式提示就是它） |
| `bca0a55` | **移除批量推理功能**（实测纯损失） |
| 本次 | **① 回放台**：`--dump-tokens` / `--replay-tokens` —— 解码器缺陷不再需要重跑模型（48 分钟 → 1 分钟）+ 8 条回归测试 |

### 已修好的两个用户可见 bug
- **任务栏图标空白 + 悬停乱码**：开始菜单快捷方式指向 `F:\1\FuFumidi\FuFumidi.exe`（旧位置，不存在）→ Windows 按 AUMID 配对后用它取图标。已修两个 .lnk（备份 `E:\Midi\_attic\lnk-backup`）
- **取消转录无效**：`engine:cancel` 只查 `task-queue.js` 的 `convertChildren`（spawn 路径），而转录跑在 `engine.js` 的 worker 路径（`_engineWorkerPending`）→ 恒定返回 `{ok:false}`。已加 `cancelJob()` 并回退查询

## 3. 还没解决的（动手前先看）

**长音频转录第 20–50 分钟仍偏长**（星铁 LIVE 100 分钟那份）：

| 指标 | 实测 | 健康参考 |
|---|---|---|
| 音符数 | 120,404 | 63,165 |
| 中位数 | 0.141 s ✅ | 0.17 s |
| 最长 | 12.500 s ✅（原 4320 s） | <=15 s |
| **20–50 分钟平均** | **1.36–3.58 s** ❌ | 0.17–0.26 s |

**待定性**：需要转录时界面上的两行日志 ——
`超长音符上限 15s：强制收尾 N 个音符` 与 `[自检] …`。
N 大 → 上限在正常工作、模型仍在拖长（要按轨自适应上限）；N=0 → 12.5s 尖峰另有来源。

**已知事实**：库里 `trim_overlapping_notes`（`tokenizer/notes.py:91`）**已经**把每个音截断到「同 (program,pitch) 下一次触发」——
所以文件里的时长都是**截断后**的值，上限触发与否**看不出来**（触发后会被截短）。

## 4. 模型参数勘查结果（已核实，直接照此接界面）

| 模型 | 已实现的参数 | 界面现状 |
|---|---|---|
| **Basic Pitch** | `onset_threshold` `frame_threshold` `melodia_trick` `midi_tempo` `minimum_frequency` `maximum_frequency` `minimum_note_length` `merge_overlap` `merge_gap_ms` | ❌ 只走预设 |
| **piano-transcription** | `onset_threshold` `frame_threshold` `num_threads` **`perf_mode`** `min_note_ms` `merge_gap_ms` `include_pedal` | ❌ 只走预设 |
| **Aria-AMT** | 仅 `device`（+环境变量），其余在它自己的 CLI | ❌ |
| **Transkun** | 仅 `--device`（薄包装） | ❌ |
| **MuScriptor** | 规格/乐器组/节拍网格**已有**；`prelude_forcing` `max_note_hold` `temperature` `cfg_coef` `beam_size` 待暴露 | 部分 |

**重要**：
- `presets.py` 已有一整套调好的参数预设（含 `include_pedal: True`、`melodia_trick`），界面只给了「预设」一个入口 → **批 A 主要是把已有参数暴露出来**
- **piano-transcription 已经实现批量推理**（`engine_pt.py` 的 `_batch_cap(perf_mode, device)` + `_batched_forward`）→ 提速梯队 ②在钢琴链路已做过一半
- Aria / Transkun 是薄包装，能控的只有设备；要加选项得先查它们 CLI 支持什么

## 5. 执行计划

### [x] ① 回放台（**已完成**，提交见下）

**为什么**：bug 在解码器不在模型。`OpenNoteTracker` 吃的是 token 流、纯 Python 无 torch。
没有它，一次 A/B 要重转 100 分钟音频（约 48 分钟）；有它是**几秒**。

- 引擎加 `--dump-tokens <file>`：把 `transcribe()` 的 token 流 + `ChunkBoundary` 落盘（100 分钟约几 MB）
- 引擎加 `--replay-tokens <file> --out x.mid`：直接跑 `decode_model_tokens` → MIDI，**不用模型/音频/GPU**
- 落点：`engine/engine_muscriptor.py`（在 `_generate_token_stream` 的产出处包一层 tee）、`engine/music2midi.py`（argparse + params）
- 配套：`scripts/deploy-installed.cjs` 加**部署后自动冒烟**（启动一次 → CDP 断言 `document.body.innerText.length > 0` + 无未捕获异常），白屏当场抓住
**完成记录**

- 落盘做法：包 `model._generate_token_stream` 的**实例方法**做 tee —— 照常调用 `transcribe()`，
  不复制它内部构造 conditions / seek_times 的私有逻辑（复制过就会随上游静默走偏）。
- 节拍网格随 token 流一起落盘（标量 + `beats` 数组）。两个坑：`asdict()` 会把 `np.ndarray` 带出来让 json 炸；
  而丢掉 `beats`，`notes_to_midi()` 会现算一个不同的 `onset_delay`，回放出来就不是同一个文件了。回放时连节拍检测一起跳过。
- 实测（15 秒样例 / small / CPU）：原始 `transcribe total 8.5s` → 回放 `0.0s`，两边 MIDI **SHA256 完全相同**
  （`79BD3984…`，197 音符）。100 分钟音频因此从约 48 分钟降到约 1 分钟。
- **过程中抓到一个真 bug**：块边界原先用 `%r` 落盘，末块的 `next_seek_time` 是 `None`，写成 `None`（不是合法 JSON）
  → 读回时整行被当坏行丢掉 → 末块边界消失，回放比原始**多 1 个音符**（197→198）。改成 `json.dumps`，
  并在 `test_roundtrip_is_lossless` 里显式钉住 `next_seek_time is None`。**这个 bug 单测抓不到，是端到端跑出来的。**
- 回归测试：`engine/tests/test_muscriptor_token_replay.py`（8 条，不加载模型、不碰 torch）。
- **①还剩一件没做**：`scripts/deploy-installed.cjs` 的部署后自动冒烟断言（白屏 / 未捕获异常）。

### [ ] ② 提速梯队 1（纯提速，零质量风险，默认开，五个模型共用）

- **bf16/fp16 autocast** 包住生成循环（`engine_muscriptor.py` 的 `model.transcribe(...)` + 消费处；`engine_pt.py` / `engine_aria.py` 同层）
- **惰性构建 conditions**：`transcription_model.py:416-427` 现在**一次性建好全部 1206 块**的 conditions 放内存 → 改按块即时构建（省内存 + 长音频少换页）
- **注意力后端**：确认是否走 SDPA/flash，没有就换（纯工程改动）
- 提速效果**必须实测**：跑 120 秒样本对比改动前后耗时（仓库既有记录：RTX 5070 Ti / medium / 120s：串行 57s）

### [ ] ③ 断点续跑（默认开）

- 按块存进度 → 崩了从断点续，失败成本 48 分钟 → 5 秒；对超长音频收益可能大于提速
- 落点：`engine_muscriptor.py` 的分块循环 + 一个进度文件（数据目录内）

### [ ] ④ 选项全量暴露（默认值原则见 §6）

**进度：批 A 已完成并在安装版验证；批 B / 批 C 未做。**

批 A 实际交付（`main/engine.js` + `ViewTranscribe.vue` + `i18n.js` / `i18n_ja.js`）：

| 控件 | 引擎参数 | 默认 | 作用域 |
|---|---|---|---|
| 导出速度 | `tempo` → `midi_tempo` | 0 = 引擎默认 | universal |
| 最高音高 | `max_freq` → `maximum_frequency` | 0 = 不限制 | universal/basic |
| 超长音符上限 | `max_note_hold` | 15（= 原行为） | universal/muscriptor |
| 合并重叠音符 | `no_merge`（取反） | 开 | universal |
| 力度归一化 | `no_velnorm`（取反） | 开 | universal |

**顺手补上一个真漏跳**：`max_freq` 在 worker 那边（`music2midi.py` 的 `maximum_frequency=req.get('max_freq')`）
和 `_resolve_params` 里都写好了，唯独 `engine.js` 的白名单没有它 —— 界面就算传了也到不了引擎。
就是文件里注释警告过的那个坑（`muscriptor_instruments` 当年也是漏在这张表里）。已补。

**批 A 还差**：Basic Pitch 的 `merge_gap_ms`、piano 的 `num_threads` / `perf_mode`（钢琴链路其实已经
实现了批量推理 `_batch_cap` + `_batched_forward`，只是没接界面）—— 这两个属于「提速」范畴，放到 ② 一起做。

**验证方式**（可复用）：构建渲染层 `npm run build:ui`（`electron-builder.yml` 排除了 `frontend/**`，
运行时只吃 `renderer/dist`，所以改 Vue 必须重新构建才进得了安装版）→ `node scripts/deploy-installed.cjs`
（含 [7/7] 冒烟）→ CDP 进 `#/transcode` 展开「高级参数」读控件。注意侧边栏那一项叫**「转译」**不是「转录」，
子模型按钮的 `textContent` 带「已下载/未下载」徽章，匹配要用 `startsWith`。

- **批 A**（工作量小）：Basic Pitch + piano-transcription —— 参数已在，只差界面 + i18n
- **批 B**（工作量中）：MuScriptor —— `prelude_forcing`（边界质量控制）/ `max_note_hold` / `temperature` / `cfg_coef` / `beam_size` + **乐器探测按钮**（对当前音频跑 `instrument_probe.py`，给建议乐器组）
- **批 C**（需先勘查）：Aria-AMT / Transkun —— 先查它们 CLI 支持什么

### [ ] ⑤ 提速梯队 2（MuScriptor 批量 + 跨块乐器归并，用 ① 的 A/B）

- 批量的问题**不在速度，在于关掉 `prelude_forcing` 后模型在每 5 秒边界重新猜乐器** → 跑完批量后做一遍**跨块乐器归并**（相邻块被改判的同一音高序列按多数票统一）
- 预期再 2–3×，质量风险中 → **默认关**，必须 A/B 验证

## 6. 默认值与界面原则（用户明确要求）

**凡影响质量的一律默认关、保持现状**：
- 关：`temperature` / `cfg_coef` / `beam_size` / 批量+归并 / 各种阈值微调
- 开（质量基线，别动）：`prelude_forcing`（边界质量控制）、`include_pedal`
- 纯提速项默认开：bf16、惰性 conditions、断点续跑

界面：现有开关区下加 **「高级选项」可折叠区**，分**质量组 / 速度组**；
每个控件下面一行小字写清「开了会怎样、关了什么代价」——**不许只给开关不给代价说明**。
中文文案必须 **EN + JA 同步补**（`core/i18n.js` / `core/i18n_ja.js`）。

## 7. 本仓库踩过的坑（务必遵守）

1. **脚本化改文件要按 CRLF 匹配** —— 工作区是 CRLF，用反斜杠 n 写的锚点会全部匹配失败（本次踩了两次）
2. **新能力要改 5 处**：`preload.js` → `main/<area>.js` → `main/engine.js` 的 `map` → `frontend/src/types/ipc.ts` → 界面。**`engine.js` 那张 map 少一个键，界面设了也到不了引擎**
3. **删一半比不删更危险** —— 删掉 `batch` 定义后，残留的 `if oom and batch >= 2` 会在 OOM 时抛 `NameError`，而 **`py_compile` 查不出来**。删完必须搜「残留裸变量引用」
4. **两条执行路径**：`engine.js` 的常驻 worker 与 `task-queue.js` 的 spawn，各自记账 —— 任何「取消/进度/状态」都要同时考虑
5. **`py_compile` 只查语法**，NaN/除零/NameError 一律漏；行为改动必须有断言测试
6. Python 的 `f.read()` 只收 int（`MB` 是 float，`2*MB` 会报 argument should be integer）
7. PowerShell 5.1 **没有** 双与号，用分号
8. 写 `.ps1` 必须 **UTF-8 with BOM**
9. `requests` 在 Windows 上会**读注册表系统代理**（本机 `127.0.0.1:10810`）；上传走 `uploads.github.com` 直连，ghfast 只代理下载
10. 门禁绿 ≠ 能用：**界面改动必须部署到 `E:\Midi\FuFumidi` 跑一次冒烟**

## 8. 验证清单（每步做完照打）

- [ ] `npm run typecheck` = 0 · `test:ui` 173 · `test:plugin` 6 · `test:download` 15
- [ ] 引擎测试（见 §1 的 pytest 命令）全绿

## 9. 进行中（下次接手先看这里）

**长音频实跑（后台作业，未完成）** —— 目标要求的「用星铁 LIVE 测速度和质量」：

```
cd E:\Midi\FuFumidi-Source
$env:FUFUMIDI_MODELS_DIR='E:\Midi\FuFumidi\FuFumidiData\models'
$env:PYTHONIOENCODING='utf-8'
& 'E:\Midi\FuFumidi\resources\python\python.exe' engine\music2midi.py convert \
  'C:\Users\qdTXTbp\Music\Hoyo-Mix Music Fair\《崩坏：星穹铁道》「2024星铁LIVE」演唱会官方录播完整版_哔哩哔哩_bilibili1533091283-1-30232.m4s (1).flac' \
  -o E:\Midi\_attic\_sing_tmp\starrail.mid --engine universal --model muscriptor \
  --model-size small --dump-tokens E:\Midi\_attic\_sing_tmp\starrail_tokens.jsonl
```

- 产物：`_attic\_sing_tmp\starrail.mid`（质量）、`starrail_tokens.jsonl`（**回放用，改解码器的燃料**）、`starrail.log`
- 实测音长 **7230.7 s（120.5 分钟）→ 1447 个 5 秒块**；本机 torch 是 **CPU 版**（`2.13.0+cpu`，安装版内置 python 也是），
  实测约 **4 s/块** → 全程约 **95 分钟**。所以这条命令必须后台跑，不要在前台等。
- 跑完要看的正是**一直缺的那两行**：`超长音符上限 15s：强制收尾 N 个音符` 与 `[自检] 音符 … 中位数 … >2s 占 … 最长 …`。
  N 大 → 上限在干活、模型仍拖长；N=0 → 12.5 s 尖峰另有来源。
- 拿到 token 流后，第 20–50 分钟偏长的问题可以**离线反复复现**（① 的回放台，约 1 分钟一次），
  不用再重跑 95 分钟。这就是 ① 存在的意义。

### ④ 批 C 勘查结论：**不暴露，理由如下**（勘查完成）

| 模型 | 源码里确实有的参数 | 结论 |
|---|---|---|
| Aria-AMT | `device` / `variant` / `ARIA_MODEL_DIR` | `device` 由 `engine_gpu` 自动判定，界面再给一个反而容易打架。
| | | **`variant` 不能暴露** —— `engine_aria.py:55` 读它、`:85` 把它当 CLI 位置参数传下去，
| | | 但 `_find_checkpoint()`（:143）是**走目录取第一个 `*.safetensors`**，根本不看 variant。
| | | 目前 `models\aria_amt\` 里只有 `piano-medium-double-1.0.safetensors`，恰好等于默认值所以没暴露问题；
| | | 一旦界面让用户改 variant，权重和 variant 就可能对不上（加载错权重、报错或静默出错）。
| | | → 要做先得把 `_find_checkpoint` 改成按 variant 找，**并且**资源中心支持下载多个 variant。 |
| Transkun | `device` / `weight`（自定义权重路径） | `weight` 是裸文件路径，直接搬进界面要先做存在性/合法性校验，
| | | 而「用户自带 Transkun 权重」目前不是受支持的工作流 → 先不做。 |

**顺带一个结论**：`engine_perf.py` 的 quality/balanced/fast **不是提速档，是降速档**
（`PERF_MODES = {quality: 0（全部核心）, balanced: 4, fast: 2}`）—— 它是给低配机器限线程用的。
所以用户说的「提速 1/2/3 梯队」不能靠现有这个下拉，得靠 ②/⑤。
另：钢琴链路 `piano_pt` 的 `perf_mode`（批量前向上限 `_batch_cap`）**已经**由性能档驱动
（`engine.py:210-212`），`num_threads` 也由它派生 —— 钢琴这块界面无需再加控件。

### ③ 断点续跑：只做到「崩了不白崩」，真正的续跑没做

95 分钟的长跑崩在第 80 分钟，现在不会全部白费：token 流是**边生成边落盘**的，
中断留下的部分 dump 可以直接 `--replay-tokens` 出一份「前 N 个块」的 MIDI（末尾半行会被跳过，
`test_read_tolerates_a_truncated_tail` 钉住了这个行为）。

**但真正的「从第 K 块接着生成」没实现**：`prelude_forcing` 的 tie 段依赖上一块的 tracker 状态，
要续跑就得先把已落盘的 token 重新喂一遍解码器重建 tracker，再从中途接着生成 ——
那要动 muscriptor 内部（tracker 建在 `_generate_token_stream` 里面），风险与 ② 同级。

**还没做**：② 提速梯队 1（bf16 / 惰性 conditions / SDPA，要重打上游 wheel）· ③ 完整续跑 ·
④ 批 C（Aria-AMT / Transkun 先查 CLI）· ⑤ 提速梯队 2。批 A、批 B 已完成并部署验证。
- [ ] 行为改动有**断言测试**（不靠肉眼看）
- [ ] 部署后**在安装版上**重跑同一套测试
- [ ] 界面改动：部署 + 启动 + CDP 断言 DOM 非空 + 截图看一眼
- [ ] 推两个远端并 `ls-remote` 复核 refs
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

### [ ] ① 回放台（**前置，必须先做**）

**为什么**：bug 在解码器不在模型。`OpenNoteTracker` 吃的是 token 流、纯 Python 无 torch。
没有它，一次 A/B 要重转 100 分钟音频（约 48 分钟）；有它是**几秒**。

- 引擎加 `--dump-tokens <file>`：把 `transcribe()` 的 token 流 + `ChunkBoundary` 落盘（100 分钟约几 MB）
- 引擎加 `--replay-tokens <file> --out x.mid`：直接跑 `decode_model_tokens` → MIDI，**不用模型/音频/GPU**
- 落点：`engine/engine_muscriptor.py`（在 `_generate_token_stream` 的产出处包一层 tee）、`engine/music2midi.py`（argparse + params）
- 配套：`scripts/deploy-installed.cjs` 加**部署后自动冒烟**（启动一次 → CDP 断言 `document.body.innerText.length > 0` + 无未捕获异常），白屏当场抓住

### [ ] ② 提速梯队 1（纯提速，零质量风险，默认开，五个模型共用）

- **bf16/fp16 autocast** 包住生成循环（`engine_muscriptor.py` 的 `model.transcribe(...)` + 消费处；`engine_pt.py` / `engine_aria.py` 同层）
- **惰性构建 conditions**：`transcription_model.py:416-427` 现在**一次性建好全部 1206 块**的 conditions 放内存 → 改按块即时构建（省内存 + 长音频少换页）
- **注意力后端**：确认是否走 SDPA/flash，没有就换（纯工程改动）
- 提速效果**必须实测**：跑 120 秒样本对比改动前后耗时（仓库既有记录：RTX 5070 Ti / medium / 120s：串行 57s）

### [ ] ③ 断点续跑（默认开）

- 按块存进度 → 崩了从断点续，失败成本 48 分钟 → 5 秒；对超长音频收益可能大于提速
- 落点：`engine_muscriptor.py` 的分块循环 + 一个进度文件（数据目录内）

### [ ] ④ 选项全量暴露（默认值原则见 §6）

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
- [ ] 行为改动有**断言测试**（不靠肉眼看）
- [ ] 部署后**在安装版上**重跑同一套测试
- [ ] 界面改动：部署 + 启动 + CDP 断言 DOM 非空 + 截图看一眼
- [ ] 推两个远端并 `ls-remote` 复核 refs
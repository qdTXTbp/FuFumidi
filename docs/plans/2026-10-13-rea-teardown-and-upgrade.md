# REA 逆向拆解 → 全面功能升级方案（性能与质量 · UI 不变）

> 目标来源：**「通过 rea 工具对本工具借鉴和学习的所有相关软件（特别是翻唱和调教功能相关的）
> 进行更加深度的拆解，对比与本工具的差异，并尝试直接复制或者改进进入本工具的代码和功能。
> 先给出方案。原来的任务也继续。方案做好后，先把之前的任务完全收尾，备份一份工具文件，
> 然后按照逆向成果和方案对本工具进行全面的功能升级和优化，重点在于性能和质量，工具 UI 不变。」**

状态：**方案（本轮产出）** · 2026-10-13 · 分支 `release/5.0.0`

---

## 一、范围：翻唱/调教链路的软件清单（机械枚举，非记忆）

从 `engine/*.py`（59 个）与 `engine/singing/**`（**127 个 .py**）+ `engine/diffsinger/**`（11 个）枚举：

| 环节 | 本工具模块 | 借鉴/依赖的上游软件 |
|---|---|---|
| **分离** | `engine_separate.py` · `engine_msst.py` | Demucs（htdemucs）· MSST / pymss（bs_roformer 等） |
| **扒谱** | `engine_muscriptor.py` · `engine_basic.py` · `engine_pt.py` · `engine_aria.py` · `engine_transkun.py` | MuScriptor · basic-pitch · piano-transcription-inference · Aria-AMT · Transkun |
| **调教（核心）** | `engine_openutau.py` · `engine_utau.py` · `engine_ustx.py` · **`engine/singing/**`（127 文件）** | **OpenUtau**（C# → Python 逐文件移植）+ **worldline**（原生库） |
| **歌声合成** | `engine_diffsinger.py` · `engine/singing/diffsinger/**` · `engine_gpt_sovits.py` | DiffSinger · GPT-SoVITS |
| **歌词/音素** | `engine_pinyin.py` · `singing/openutau/g2p/**`（21 个）· `plugin_builtin/**`（16 个） | OpenUtau 的 G2P 与 phonemizer 插件体系 |
| **对齐 / 混音** | `gsv_align.py` · `cover_mix.py` · `cover_notes.py` · `engine_cover.py` | —（自有） |

**关键发现**：`engine/singing/openutau/` **不是「调用 OpenUtau」，而是 OpenUtau 的 Python 移植**。
源码里 **101 处**明确标注了对应的 C# 文件（如 `classic/exe_resampler.py` 开头就写
「**照搬** `OpenUtau.Core/Classic/ExeResampler.cs`（141 行）」，并逐条列出
「照搬时保留的语义（别"整理"掉）」）。

→ **这 101 个映射点就是「借鉴和学习」的精确清单，也是深度拆解的主战场。**

---

## 二、已完成的拆解结论（有证据）

### 2.1 ✅ T1 · worldline 原生库 = 上游 `04c4e61005`（VENDOR.md 的缺口已闭合）

`docs/VENDOR.md` 案例 3 原文：「**未记录 tag/commit —— 待补**」。
用 `git clone --filter=blob:none` 拉上游 4640 个 commit，对 6 个二进制做 **blob 比对**：

| 本目录 | 命中上游 commit | 唯一性 |
|---|---|---|
| `win-x64/worldline.dll` 等 **6 个全部** | `04c4e61005`（2026-09-27，PR #2468 "Rebuild Worldline"） | **每个都只有 1 个匹配** |

**这是精确解，不是猜测**：blob 哈希相同即字节相同。移植基线 = **2026-09-27**。

### 2.2 ✅ T1 · MuScriptor 补丁 = 1 个文件（已产出可复现 patch）

3.11（`0.3.0+fufumidi.1`）与 3.12（裸 `0.3.0`）两份产物相减：**唯一差异是 `events.py`**
（12933 vs 10958 B，3 hunk）—— 新增 `DEFAULT_MAX_NOTE_HOLD_SEC = 15.0`、
`OpenNoteTracker(max_note_hold=)`、对仍在 tie 段的超时音符按 `onset + max_note_hold` 强制关闭。
产出 `engine/patches/muscriptor-0.3.0-fufumidi.1.patch`。

### 2.3 ✅ 祖先 AudioMuse v2.6.0 · **零能力缺口**

预设 14 vs 12（AudioMuse 独有 0 个）；它独有的 6 个文件全是 PySide6 GUI，属架构换代。

### 2.4 ★ 上游漂移：基线之后 **16 个 C# 文件被改过**，其中 **3 条是性能提交**

以 `04c4e61005`（2026-09-27）为基线，逐个查 101 个映射文件的最后一次改动：

| 上游日期 | 文件 | 提交主题 | 归类 |
|---|---|---|---|
| 10-09 | `Classic/VoicebankFiles.cs` | Fix NullReferenceException copying voicebank files | **质量·空引用 bug** |
| 10-08 | `Render/Renderers.cs` | Add WORLDLINE-R1.1 to the default renderer preference | **质量·渲染器** |
| 10-07 | `Classic/ResamplerManifest.cs` · `Classic/ClassicRenderer.cs` | Add Resampler Meta Files definable in resampler manifest | 功能 |
| 10-06 | `DiffSinger/DiffSingerRenderer.cs` | Serialize DirectML session creation, inference and disposal | **性能·稳定性** |
| 10-05 | `Ustx/UPhoneme.cs` · `Classic/WorldlineRenderer.cs` · `Classic/SharpWavtool.cs` · `Classic/ResamplerItem.cs` | Relax the preutter override cap to the start of the file | **质量·调教** |
| 10-05 | `Classic/ToolsManager.cs` | Skip external resamplers named like a built-in one | 质量·正确性 |
| 10-03 | `Util/TimeAxis.cs` · `Pipeline/PhraseSource.cs` | **Cut phrase snapshot allocations** | **性能·内存分配** |
| 10-03 | `Render/Worldline.cs` | Use Worldline's auto gain for hifisampler's P flag | 质量 |
| 10-02 | `Render/RenderPhrase.cs` | **even more nodes for the expression graphs (#2477)** | **性能·节点数** |
| 09-28 | `Render/RenderEngine.cs` | Redesign Track Polish as a live, non-modal effects rack | 功能（含 UI，**不跟**） |

**这份表就是「差异清单」**，而且天然分成三类：**性能**（4 条）、**质量**（5 条）、功能/UI（其余）。

---

## 三、升级方案（重点：性能与质量 · UI 不变）

### 3.1 性能方向

**P1 · 跟随上游的「减小分配」提交**（最稳、收益确定、无 UI 影响）
- `TimeAxis.cs` + `PhraseSource.cs` 的 **Cut phrase snapshot allocations** →
  移植到 `singing/openutau/timeaxis.py` 与 `pipeline_source.py`
- `RenderPhrase.cs` 的 **even more nodes for expression graphs** →
  `render_phrase.py` / `real_curve_updater.py`
- 验收：同一 ustx 工程的渲染耗时与分配次数前后对比（用 `engine_perf.py` 的设施）

**P2 · DiffSinger DirectML 会话串行化**
- 上游把 DirectML 的 **创建 / 推理 / 释放串行化** —— 这是**显存与竞态**的修复。
  我们 `openutau/diffsinger/render_priority.py` 已有优先级调度，但**会话生命周期**未必串行。
- 验收：连续渲染多段，无 DirectML 报错、显存不增长。

**P3 · 验证「classic 渲染器」的真实瓶颈**
- `classic/classic_renderer.py:48` 注释称「多线程是有意义的：真正的计算在子进程」，
  而 `exe_resampler.py` 是**每个音符调一次外部 resampler**（UTAU 生态的老瓶颈）。
- **待实测**（不要凭印象）：逐音符子进程 vs `worldline_resampler.py`（进程内原生库）
  在同一工程上的耗时对比。若差距显著，则**扩大 worldline 路径的覆盖面**。
- > 注意：此项是**假设**，必须先量再改 —— 本项目已两次栽在「凭印象宣布提速」上。

### 3.2 质量方向

**Q1 · 移植上游的 preutter 上限放宽**（4 个文件同一 PR）
- 「Relax the preutter override cap to the start of the file」——直接关系**调教手感**。

**Q2 · `VoicebankFiles.cs` 的 NullReferenceException 修复**
- 上游 10-09 刚修。**先查我们有没有同一个空引用** —— 这与用户之前提过的
  「自行检查工具有没有类似的空函数和空引用」是同一件事。

**Q3 · `ToolsManager.cs`「跳过与内置同名的外部 resampler」**
- 免得同名外部工具静默顶掉内置渲染器。

**Q4 · WORLDLINE-R1.1 进默认渲染器偏好**
- 上游 10-08 把新版加进默认偏好 —— 属于**质量默认值**，要评估后再跟。

### 2.5 ✅ T2 · js-synthesizer：补丁是真的，且**无法靠升级去掉**（已闭合）

VENDOR.md 坑 1 说「只有 worklet 那份打过补丁、主文件就是原版 1.13.0」。拉 npm 上 `js-synthesizer@1.13.0`
逐字节核对，**两句都对，但第一句要补一个字**：

| 文件 | 我们 | 上游 1.13.0 | 归一化换行后 |
|---|---|---|---|
| `js-synthesizer.min.js` | 33,086 B `7b3137eb…` | 33,056 B `ea3932ef…` | **★ 完全相同** |
| `js-synthesizer.worklet.min.js` | 30,283 B `a2afdec5…` | 30,300 B `e9d8ba0d…` | **4 处真实差异** |

**主文件那 30 字节差全是 CRLF vs LF**（banner 30 行，每行多 1 字节）—— 代码一个字都没改。
**这点 VENDOR.md 没写**，于是「按 SHA 核对」的人会以为主文件也被打过补丁。已在 VENDOR.md 补注。

**worklet 的补丁是真的**，4 个差异区块，实质是一件事：

```
上游: ,O(this._messaging,e.id,e.method,void 0      ← 丢掉返回值
我们: O(this._messaging,e.id,e.method,             ← 让返回值回传
      另外上游还有两处 void ，我们没有
```

正是 VENDOR.md 坑 1 描述的「把 `doCallFunction(...)` 的返回值回传」，
`frontend/src/core/synth.js` 的 `callFunction('__fuSeqClockStart')` 依赖它。

**★ 关键结论：npm 上 js-synthesizer 的最新版就是 1.13.0** —— **升级这条路根本不存在**，
所以 VENDOR.md 把它从 `frontend/package.json` 移除、只留 vendor 文件的决定**是对的**，
而不是「暂时绕过」。要动它只能手工同步补丁。
### 2.6 ✅ T3 · verovio = npm `verovio@6.3.0`（VENDOR.md 的第二个自陈缺口闭合）

VENDOR.md 原文：「**未标注**（文件里没有 banner、也没有版本串）—— 待补」，唯一基线是一串 SHA-256。

**方法（低成本，值得复用）**：不要盲下 19 个版本各 7 MB —— 先用 jsDelivr 的文件清单 API
一次拿到各版本 `dist/verovio-toolkit-wasm.js` 的**字节数**，按大小筛，只下载命中的那个核哈希。

```
https://data.jsdelivr.com/v1/packages/npm/verovio@<版本>?structure=flat
```

结果：**只有 `6.3.0` 是 7,310,681 B**，下载后 SHA-256
`d794119cd5ea83a3e835849945f0289c91ac2bac427f4aa312c7010a800b46bd` **与我们完全一致**。

**→ 逐字节相同，版本确定为 6.3.0。** 已写进 VENDOR.md。

> 顺带修正一条一般性做法：**「文件里没有版本串」不等于「无法定版」**。
> 上游以包形式发布的东西，用**包清单的尺寸 + 下载核哈希**就能定死，比我原先设想的「从 wasm 里挖构建元数据」可靠得多。
### 2.7 OMR 识谱线（**非翻唱/调教**，按目标要求一并纳入）· 发现一处真实缺口

机械枚举 `engine/` + `main/` 里引用的上游仓库共 **17 个**，除翻唱/调教外的独立能力线主要是 **OMR 识谱**：

| 组件 | 说明 |
|---|---|
| `engine_omr.py`（**1318 行**） | **自研经典识谱**，只依赖 numpy/scipy/Pillow，永远可用。设计注释很实：符头检测用「匹配滤波 + 局部极大值」而非「先去谱线再连通域」，理由是**去线一定会把压在谱线上的符头一起抹掉** |
| `engine_omr_backends.py`（385 行） | 三后端调度：`classical` / **`audiveris`** / 预留 `oemer`。★ 里头记着一条实测坑：低清谱面（谱线间距 ≈6px）直接喂 Audiveris 会在 SCALE 步判「无多行谱表」整页 invalid，`-force` 也绕不过；**3× LANCZOS 上采样 + 二值化 + 3×3 加粗**后才全流程跑通 |
| `main/omr.js` | 资源中心下载/安装 Audiveris（MSI 用 `msiexec /a` 行政安装解包，不写注册表、不需管理员） |

#### 结论 1 · 版本已是最新，**无升级空间**

`main/omr.js:17` 钉的是 **Audiveris 5.11.0**。查上游 release 列表（新→旧）：
`5.11.0`(2026-07-11) → 5.10.2 → 5.10.1 → 5.10.0 → 5.9.0 → 5.8.1 → 5.7.1 → 5.7.0。
**5.11.0 就是最新正式版**，这条线不需要跟。

#### 结论 2 · ★ 81 MB 的 MSI **下载后没有任何完整性校验**

`main/omr.js` 里 grep `sha|hash|integrity|checksum` → **零命中**。也就是说：
**从 GitHub releases 拉一个 85,062,430 字节的安装包，直接 `msiexec /a` 解包执行，中间不校验任何指纹。**
而上游 release **本身也不提供校验文件**（5.11.0 的 8 个资源里只有各平台安装包 + Handbook + Schemas 文档）。

**这和 §5 的缺陷 A / 阶段 0 的 asar 完整性是同一类**：只验「能不能下下来」，不验「是不是对的那个」。
HTTPS 只保护传输过程，不保护「这个发布物本身是不是我们预期的那个」。

#### 结论 3 · ★ 顺带量出一个**用户侧的严重性能问题**，并已修（2026-10-13）

实测同一台机器下这个 81 MB 安装包：

| 通道 | 速率 | 81 MB 预计耗时 |
|---|---|---|
| GitHub 直链 | **0.03 MB/s** | **约 45 分钟** |
| `ghfast.top` 镜像 | **1.12 MB/s** | **73 秒（实测）** |

**37 倍差距。** 而 `main/omr.js` 的 `downloadFast` 调用写的是 `urls: [url]` —— **只传了一条直链**，
没用上仓库里已有的镜像约定；同时那个看门狗「15 秒无数据就放弃」，45 分钟的通道基本注定失败。
（作者其实已经察觉：文件里留着注释「实测某些网络下 Chromium 栈会被限到 1MB/4min」，
所以做了 Chromium→Node→PowerShell 三级回退。但回退解决的是「能不能下」，没解决「快不快」。）

**已实现的两项改动**（`main/omr.js`，+44/−8，`node --check` 通过，`npm run test:download` **15/15 通过**）：

1. **钉指纹**：新增 `MSI_BYTES = 85062430` 与
   `MSI_SHA256 = 5f1b4e96a12c53c7da426814b76e599363c4181e291855996e0a6878dda95f71`，
   下载后先校验大小与 SHA-256 再 `msiexec /a` 解包；不符即删文件并报错。
2. **走镜像**：新增 `MSI_URLS`（直链 + `ghfast.top` / `gh-proxy.com` / `gh.jasonzeng.dev`），
   交给 `downloadFast` 的 `urls` 列表**测速选最快**（这正是该 API 的设计用途），并传 `expectSize`；
   三级回退里 PowerShell 那条（走系统代理）也改为逐镜像尝试。

> **这条最能说明「产物视角」的价值**：源码里 `urls: [url]` 读起来毫无问题，
> 「直链 30 KB/s、镜像 1.12 MB/s」这个事实**只有实际去量才知道**。
> 而这次量它的起因，本来是来查「有没有完整性校验」的。
### 3.4 ✅ P1 已落地 · 移植上游 `f6b0b132`「Cut phrase snapshot allocations」

上游提交 `f6b0b132`（2026-10-03）改了 4 个文件、+34/−30。它做的是**两件事**，而这两件事在 Python 里**价值相反**：

| 上游改动 | C# 里的效果 | Python 里该不该跟 |
|---|---|---|
| ① 把 flag 表达式表**每个快照算一次**（原来每个音素都重算） | 4.6 MB → 1.1 MB / 快照，耗时减半 | **跟** —— 语言无关的算法收益 |
| ② LINQ `Where/Select/FirstOrDefault` 改成 `foreach` | 消除闭包与迭代器分配 | **不跟** —— Python 里列表推导比 `for`+`append` **更快**，照搬只会变慢 |

**只移植 ①。** 落点：

- `pipeline_source.py`：`from_part` 里 `flag_expressions = UPhoneme.get_expression_descriptors(project, track)` **只算一次**，
  传进 `PhonemeSource.of(...)`；快照字段 `flag_expressions` 由 `[]` 改为接上真表
- `PhonemeSource.of`：把逐音素的 `phoneme.get_resampler_flags(project, track)` 换成
  `UPhoneme.build_resampler_flags(flag_expressions, lambda abbr: phoneme.get_expression(...)[0])`
  （`build_resampler_flags` 这个静态方法**我们的移植里本来就有** —— 缺的只是「把它提到循环外」这一步）

#### 实测数字（N = 800 音素，与上游基准同规模）

| 指标 | 移植前 | 移植后 | 改善 |
|---|---|---|---|
| flag 构建耗时 | 5.3 ms | **2.9 ms** | **1.83×** |
| 分配总量（24 个表达式） | 0.20 MB | **0.88 KB** | **230×** |
| 分配总量（96 个表达式） | 0.71 MB | **2.09 KB** | **347×** |

**注意别照抄上游的数字**：上游说的「4.6 MB → 1.1 MB」是 **C#** 的口径（LINQ 闭包 + 迭代器 + 数组开销大，
而且他们的工程表达式更多）。我们这条链原本就用的是列表推导，单次体积更小，
但**比值同样巨大**，且消掉的是**纯粹的分配抖动**（GC 压力），这正是上游说的「拖动时每秒几十次 GC」的来源。

#### 验收

- `ast.parse` 通过；`pytest engine/tests` → **exit 0，243 passed / 1 skipped / 0 failed**
- `get_resampler_flags` **保留未删** —— `classic/ust_note.py:120` 那条路径仍在用
### 3.5 ✅ Q2 已落地 · 空引用「我们没有」，但补回一个被漏掉的功能

上游 `5c3c83bb`（2026-10-09）「Fix NullReferenceException copying voicebank files for built-in resamplers」：

```csharp
- var exeResampler = resampler as ExeResampler;   // ← 硬转型：内置 resampler 得到 null
- if (exeResampler.Manifest != null && ...)       // ← 紧接着就 NRE
+ var files = resampler?.Manifest?.files;         // 修法：空安全取
```

#### 回答：**我们没有这个空引用** —— 但原因不是我们写对了

`grep manifest|ExeResampler voicebank_files.py` → **零命中**。查下去发现：
**上游那段 manifest 支路我们整段都没移植**，所以自然不会 NRE。

**代价是少了一个功能**，而且这个缺口是可验证的：

- 我们的 `ResamplerManifest` 只有 `expressions` / `expression_filter`
  （docstring 自陈「照搬 `ResamplerManifest.cs`（**28 行**）」）—— **没有 `files` 字段**
- `get_meta_files(source, source_temp)` **没有 `resampler` 参数**，manifest 支路无处可跑

→ 即我们停在**上游 2026-10-07 之前**（`files` 是那次「Add Resampler Meta Files definable
in resampler manifest」加进来的）。

#### 已做的移植（直接移植**修好的**写法，不复现中间态）

| 文件 | 改动 |
|---|---|
| `resampler_manifest.py` | 加 `files: List[str]` |
| `voicebank_files.py` | `get_meta_files(source, source_temp, resampler=None)` 追加清单元文件；用 `getattr` 逐级取（`manifest` / `files`），**天然空安全** —— 对应上游 `resampler?.Manifest?.files` |
| `voicebank_files.py` | `copy_source_temp` / `copy_back_meta_files` 透传 `resampler` |
| `resampler_item.py` | 两个同名方法透传 |
| `classic_renderer.py` | 4 处调用点传 `item.resampler` |
| `test_resampler_manifest_files.py` | **新增 6 条回归** |

#### 验收

| 场景 | 结果 |
|---|---|
| 不传 resampler | 13 对，末项 `a.hifi.npz`（**与既有断言一致，没改坏**） |
| 清单 `files=['.myext','_myside']` | **15 对**，新增 `a.myext` / `a_myside` |
| 清单为空 | 13 对 |
| 内置 resampler（连 `manifest` 属性都没有） | 13 对，**不抛** ← 上游 NRE 的场景 |
| `manifest = None` | 13 对，**不抛** |

`pytest engine/tests` → **exit 0，249 passed / 1 skipped**。

#### 顺带澄清一条**不是**漂移的差异

上游的元文件表是 **14 对**（比我们多一个 `noExt + "_hnsep"`）。这**不是漏移植**：
`worldline_renderer.py:34` 明确写着「**v11**：`PhraseSynthV2(use_hnsep: true)` —— 谐波/噪声分离模型
`Hnsep` **未搬**」。没搬 Hnsep 就不需要 `_hnsep` 边车文件，**两者是一致的**。
哪天要跟 Worldline v11，这两个得一起做。
### 3.3 明确不跟的

- `RenderEngine.cs` 的 **Track Polish 改版**（含 UI 改动，与「UI 不变」冲突）
- 任何需要在界面加控件的变化（本目标明令 UI 不变）

---

## 四、执行顺序（严格按用户指定的先后）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **0** | 方案（本文） | ✅ 本轮完成 |
| **1** | **把之前的任务完全收尾** | ⏳ 见 §5 |
| **2** | **备份一份工具文件** | ⏳ 未开始 |
| **3** | 按 §3 做功能升级（性能与质量，UI 不变） | ⏳ 未开始 |
| **4** | 逐项验收 + 在安装版冒烟 | ⏳ 未开始 |

---

## 五、阶段 1 的收尾清单（「原来的任务」）

| # | 事项 | 状态 |
|---|---|---|
| 1 | Python 3.12 装配 | ✅ 完成（3.12.10 / 13.7 min / 6 组自检 ok） |
| 2 | XPU 包 → CNB 上传 | ✅ 完成（1518.4 MB / 1404 s / verify 200） |
| 3 | **缺陷 A**：3.12 的 muscriptor 是裸上游版，补丁没上 | ✅ **已修**（`0df062e`）脚本 `[3b/5]` 打补丁；重跑验收 exit 0，独立复验 `events.py` 12933 B / `75df831b…`、签名含 `max_note_hold=15.0` |
| 4 | **缺陷 B**：注释说收 demucs、正文没有 | ✅ **已修**（注释改成与正文一致：分离走 MSST，不需 demucs） |
| 5 | ~~缺陷 C~~ | ✅ **撤回：不是缺陷**（MSST 才是分离引擎，`deps.py` 本来就是对的）。附带发现 `engine_separate.py` 是**死代码** |
| 6 | **缺陷 D**：`pipAnywhere` 走 `shell:true`，`>=x` 被 cmd 当重定向 | ✅ **已修 + 已验证**（改 argv + `shell:false`；重跑后仓库根垃圾文件 **0 个**，修复前 3 个） |
| 7 | asar integrity 同步（阶段 0 发现） | ✅ 已修（`64219bc`，310 文件 0 不匹配） |
| 7b | **新增守卫**：`deps.py` 校验 muscriptor **补丁身份**（不只 import） | ✅ 已加并实测：3.11 → `ok:true`；裸版 → `ok:false, broken:[缺 FuFumidi 补丁]` |
| 8 | ROCm 加速包 | ✅ **软件侧阻塞已解除**（见下） |
| 9 | 尾部安静段异常（115–120 min，median 0.010s、`>2s` 15.9%） | ⏳ 未查 |
| 10 | 11 个 TODO 桥接方法（接通 or 删除） | ✅ **已定性**：`preload.js` / `main/` 里 **0 个 TODO**；`audit-bridge-contract.cjs` 跑出 **EXIT=0「没有发现契约漂移」**，未接项都在 `ALLOWED_UNUSED` / `ALLOWED_STUBS` 里带理由登记，属**已文档化豁免**，非待办 |
| 11 | Intel XPU 实机验证 | ⛔ **阻塞**：本机无 Intel GPU，只能标注「未经实机验证」 |
| 11b | AMD ROCm 实机验证 | ⛔ **阻塞**：本机无 AMD GPU |

### #8 的实际情况（更正我先前的说法）

我先在 `build-gpu-package.js` 里 grep `rocm` 得到 0 命中，一度以为「构建脚本没有 rocm 模式」。
**错了** —— ROCm 有**独立脚本** `scripts/build-gpu-package-rocm.js`（走 AMD 官方 `repo.radeon.com`
直链，不打 `rocm-sdk-devel` 那 1.37 GB 编译期头文件）。ROCm 包本身也早在 CNB 上（1838 MB）。

**真正的阻塞是运行时**：`main.js:354` 写着「装了 rocm 且有就绪的 3.12 运行时 → 切过去
（ROCm 只有 cp312 轮子）」；`main.js:543` 说明 `KIND_PY` 会把版本不匹配的包从 `PYTHONPATH` 过滤掉，
等价于「已安装但未启用」。**用户看到的「ROCm 显示需要 Python 3.12，但工具只有 3.11」就是这个过滤。**

→ **3.12 运行时现已就绪（含 muscriptor 补丁），软件侧阻塞解除**；剩下的只有实机验证，本机无 AMD GPU。

---

## 六、验收标准

1. 每个改动都有**前后数字**（耗时 / 内存 / 分配次数 / 音符数），不接受「感觉快了」
2. **提速类结论必须 ≥100 个块才采信**（本项目实测教训：小样本把 0.6% 的差异读成 +43%）
3. 界面 **零改动**（`git diff` 里不含 `frontend/**` 的 UI 结构与文案，除非是修复）
4. 引擎测试 + 类型检查 + UI 测试全绿，并**装到 `E:\Midi\FuFumidi` 冒烟**
5. 每次覆盖安装后**复验 asar 完整性**（阶段 0 的教训）

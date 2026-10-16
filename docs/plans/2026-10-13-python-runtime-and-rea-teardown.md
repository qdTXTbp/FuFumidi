# Python 运行时版本 + REA 逆向拆解 方案（2026-10-13）

## 一、Python 版本：**不要上 3.15，用 3.13**

用户指向 https://www.python.org/downloads/release/python-3150/ ，要求「补一套最新版或者兼容和性能最好的 Python，
防止又出现这种版本太低无法安装的情况」。**实测数据不支持 3.15：**

（2026-10-13 查 PyPI 镜像，按 `cp3XX` 统计可用 wheel 数）

| 依赖 | cp312 | **cp313** | cp315 |
|---|---|---|---|
| **onnxruntime** | 135 | **140** | **0** |
| **tokenizers** | 126 | 44 | **0** |
| numba | 134 | 109 | 8 |
| scipy | 272 | 336 | 20 |
| pillow | 130 | 208 | 21 |
| lxml | 405 | 298 | 90 |

**`onnxruntime` 和 `tokenizers` 是编译型依赖，cp315 轮子数为 0。**
onnxruntime 是 FuFumidi 的转录核心（Basic Pitch、DiffSinger 都走它）——
换 3.15 等于**把这个工具装不起来**，恰好是用户想避免的那类事故。

同时 Python 3.15.0 是 **2026-10-09 刚发布**（4 天），生态还没跟上；torch 倒是已有 cp315
（cu130 32 个 / xpu 20 个 / cpu 36 个），但 torch 不是唯一瓶颈。

### 结论与优先级

| 优先级 | 动作 | 理由 |
|---|---|---|
| **P0** | 补 **Python 3.12** 运行时（`scripts/bundle-python312.js`） | ROCm 增强包**只有 cp312 轮子**，这是当前唯一真实被卡住的功能 |
| **P1** | 基础运行时 3.11 → **3.13** | 3.13 覆盖最全（onnxruntime cp313 比 cp312 还多），是「最新且兼容最好」的那个点 |
| **P2** | 3.15 | **现在不做**：onnxruntime / tokenizers 无 cp315 轮子 |

### P1 的代价（为什么不当场做）

基础运行时从 3.11 换到 3.13 会连带：

- `resources/python` 整体替换 + 全部引擎依赖重装
- `main/gpu.js` 的 `KIND_PY`（cuda/directml/xpu 现在都是 `'3.11'`）全部改 `'3.13'`
- **三个 GPU 增强包要按 cp313 重建**（现有包是 cp311，换基础运行时后直接失效，用户得重下 3 GB）

所以 P1 必须和「加速包重建 + 老用户迁移提示」一起做，不能单独动。

---

## 二、REA 逆向拆解方案

### 已装好

`npx -y rea-agents@6.4.0 setup --all-detected --yes` 已执行：

- 给 5 个客户端注册了 REA MCP（Claude Code / Codex / OpenCode / Copilot CLI / VS Code）
- 装了两份 skill：`~/.agents/skills/reverse-engineer-anything`、`~/.claude/skills/reverse-engineer-anything`
- **DSH 侧**：skill 已自动进入本会话目录（`reverse-engineer-anything`）

### ★ 一个必须先说清的限制

skill 原文：**「Installing this skill supplies instructions; it does not register the REA MCP server,
install analysis engines, or add tools to an already-running agent.」**

也就是说：**本会话拿不到 REA 的 MCP 工具**（我的工具集是固定的）。按 skill 自己的指引，
应当走 **`rea` CLI**（`npx -y rea-agents@6.4.0 <command>`）—— 它有 60+ 个子命令，
`analyze` / `analyze-javascript-application` / `compare-application-versions` 等。

### 拆解对象（FuFumidi 借鉴/学习过的软件）

先按「借用方式」分类，避免拆错层次：

| 类别 | 对象 | 拆什么 | 能否直接搬代码 |
|---|---|---|---|
| **已集成的开源引擎** | MuScriptor(MIT) · Basic Pitch · piano-transcription · Aria-AMT · Transkun · MSST | **源码可得，不需要 REA** | 可以（遵守许可证） |
| **同领域竞品** | MuseScore · REAPER · Synthesia · AnthemScore · Melodyne · UVR5 | 交互范式、播放/编辑手感、批量工作流 | ❌ 闭源部分不可搬；只学行为 |
| **Electron 同类工具** | 其它 Electron 音乐/MIDI 应用 | 打包方式、更新链路、GPU 探测、快捷键体系 | ❌ 只学模式 |

### ★ 前置原则（写死，避免越界）

1. **REA 用于「理解行为」，不用于「复制代码」**：闭源软件的输出是*行为证据*，据此**重写**；
   只有明确宽松许可（MIT/Apache/BSD）的开源项目才允许抄实现，且必须记 `THIRD_PARTY_NOTICES.md`
2. 每个结论必须带**证据**（REA 的设计就是产出 Evidence + 局限说明）
3. **优先级由「用户可感知的差距」决定，不由「技术上好拆」决定**

### 分阶段

**阶段 0（半天）· 建立基线**

- 用 `rea analyze-javascript-application` 拆本工具自己的 `app.asar`，产出一份**自画像**：
  真实 IPC 面、资源打包方式、启动路径 —— 作为后续对比的基准
- 与仓库里已有的 `scripts/audit-bridge-contract.cjs` 交叉验证（源码视角 vs 产物视角）
  —— 这一步能立刻发现「源码里认为存在的桥接，产物里没有」这类问题

**阶段 1（1 天）· 竞品行为拆解（挑 3 个，不贪多）**

| 对象 | 具体要回答的问题 | 预期产出 |
|---|---|---|
| **UVR5 / MSST 系** | 分离工作流的默认参数、模型组织、失败回退 | 分离质量与稳定性的改进项 |
| **MuseScore** | 乐谱视图的排版/缩放/翻页交互 | 乐谱页手感改进项 |
| **一个 Electron 音乐工具** | 更新链路、GPU 探测、首启引导 | 分发与首启体验改进项 |

**阶段 2（按产出决定）· 落地**

每条结论必须写成「差异 → 证据 → 改法 → 代价」四段，**先给方案等确认再改代码**。

### ★ 阶段 0 已完成：REA 拆本工具自己的 `app.asar`（实测结果）

命令（`--integrity-policy record-and-continue` 是必需的，原因见下）：

```bash
npx -y rea-agents@6.4.0 analyze-javascript-application \
  'E:\Midi\FuFumidi\resources\app.asar' --integrity-policy record-and-continue --format json
```

产出：**Evidence 对象**（94 MB JSON），`authority: shipped-artifact` / `confidence: derived`，
自带 `limitations` 158 条 —— 它明确列出自己没能确定什么，这正是结论可信的前提。

`statistics`：解析 98 个 JS 文件 / 14.5 MB 文本 / 101.8 万 AST 节点 / 1685 条 findings / **1 个解析失败**。

#### 交叉验证：产物视角 vs 源码视角

| 指标 | 源码侧（`audit-bridge-contract.cjs`） | 产物侧（REA） | 判读 |
|---|---|---|---|
| 渲染端监听数 | `ipcRenderer.on` **26** | `renderer_listeners` **26** | ✅ **完全一致** |
| 渲染端发送数 | `invoke` 177 + `send` 1 = **178** | `renderer_transmissions` **175** | ✅ 基本一致 |
| 暴露的桥接成员 | 顶层 158 + 嵌套 50 = **208** | `exposed_api_members` **213** | ⚠️ 差 5，待查 |
| 主进程 handler | `ipcMain.handle/on` **178** | `main_handlers` **3** | ⚠️ **REA 覆盖不足**，不是 175 个都缺 |

**关键判读**：REA 报 `unpaired_literal_renderer_transmissions: 172`，看着像「172 个 invoke 没有 handler」，
但源码侧明明是 177 invoke 对 178 handler。结合它自陈的 `preload_entrypoints: 0`、
`parse_failures: 1`，可以判定：**REA 没能解析主进程那一侧**，那 172 是**覆盖度限制，不是 172 个 bug**。
skill 里那句「读 limitations，别过度声称」就是防这个。

#### ★ REA 抓到一个我的源码审计**根本看不到**的真问题

`integrity_contradictions` —— **6 个文件的 asar 完整性哈希与产物实际字节不符**：

```
engine/deps.py · engine/engine_aria.py · engine/engine_gpu.py
engine/engine_muscriptor.py · engine/engine_transkun.py · engine/music2midi.py
```

**根因**：`scripts/deploy-installed.cjs` 是「解包基线 asar → 覆盖源码文件 → 重打包」，
它更新了文件内容，但**没更新 asar 头部里 electron-builder 写入的 integrity 哈希**。
换句话说：**我每次覆盖安装版，产出的包完整性元数据都是过期的**。

这正是阶段 0 想要的东西 —— 源码视角（`audit-bridge-contract.cjs`）永远发现不了它，
因为源码里根本没有 asar 头部这层概念。**产物视角价值就在这里。**

⚠️ 风险边界（不要夸大）：Electron 只在启用 `EnableEmbeddedAsarIntegrityValidation` 的
签署构建上强制校验；当前安装版能正常跑，说明**尚未触发强制**。但这是个隐患：
一旦将来开启该校验，或做签署发布，就会**直接拒绝加载**。待办：让 deploy 脚本同步更新 integrity。

### 与「原来的任务」的关系

原任务（XPU 包上传 / Python 3.12 装配 / 尾部安静段异常 / 干净环境重验）**继续跑**，
本方案不阻塞它们；REA 拆解是**并行**的新增工作线。

---

## 三、当前进行中的作业

| 作业 | 状态 |
|---|---|
| XPU 包 → CNB 镜像上传 | 进行中（GitHub 那条已停，因为**应用本来就只从 CNB 读包**） |
| Python 3.12 装配 | **已修复并在跑**：真因是 `basic-pitch` 钉死 `tensorflow<2.15.1`，而 TF 从未出 3.12 的 2.15.x → 改 `--no-deps` 装 basic-pitch，并补 `scikit-learn typing-extensions mir-eval resampy`。当前进程活跃下载中 |

---

## 四、阶段 1 · 祖先与同类拆解（进行中）

### 4.1 AudioMuse —— FuFumidi 的直系祖先（源码版 v2.6.0）

**结论先行：没有能力缺口。FuFumidi 是 AudioMuse 的严格超集。**

拆解对象：`E:\Midi\安装包\AudioMuse\AudioMuse_源码版_v2.6.0.zip` → `E:\Midi\_attic\am_src`。

| 对比项 | AudioMuse 有 | FuFumidi 有 | 判读 |
|---|---|---|---|
| **预设数** | 12 | **14** | ✅ FuFumidi 多出 `人声：最优`、`钢琴：最优`；**AudioMuse 独有 0 个** → 无参数回退 |
| MusicXML 导出 | 有 | 有（engine 27 处 / frontend 82 处） | ✅ 已重实现 |
| 钢琴卷帘 | 有 | 有 | ✅ 已重实现 |
| 频谱图 | 有 | 有 | ✅ 已重实现 |

**AudioMuse 独有文件 = 全部是 PySide6 桌面 GUI**：`gui.py`(104 KB)、`settings_dialog.py`、`guide.py`、
`anim.py`、`dwm_util.py`、`theme_library.py`。

**判读（重要，别读歪）**：这些不是"丢掉的引擎能力"，而是**架构换代**——AudioMuse 用 PySide6 画桌面窗口，
FuFumidi 把同一批功能搬到 Electron + Vue 渲染进程。**GUI 框架不同不等于能力缺失**，
要判断有没有真丢功能，只能逐项对照 *功能*，而不是对照 *文件名*。

### 4.2 阶段 1 拆解目标候选（2026-10-13 从仓库机械枚举，不是凭记忆列的）

来源：`docs/VENDOR.md` + `engine/requirements.txt` + `engine/requirements-bundle.txt`。
共 15 个第三方，按「拆解能换来什么」排序。**每条都附了它在仓库里的自陈依据**。

| 组 | 目标 | 仓库里的自陈依据 | 拆解能换来什么 |
|---|---|---|---|
| **T1 最高** | **MuScriptor** | 装的是 `muscriptor 0.3.0+fufumidi.1`，`docs/plans/2026-10-12-transcribe-options-and-speed.md:34` 记为「**上游级补丁**（改 `OpenNoteTracker`）」commit `82eab7d` | 我们的 wheel vs 上游 0.3.0 release 逐文件比对 → **我们到底改了哪几处**、上游新版有没有已修的同类问题 |
| **T1 最高** | **OpenUtau native** | `docs/VENDOR.md` 案例 3 原文：「**未记录 tag/commit —— 待补**」；`native_lib.py` 只按 RID 取目录 | 从 4.8 MB 产物内部定位上游版本 → 补上 VENDOR.md 的缺口；升级时才知道偏移量 |
| **T2** | **js-synthesizer 1.13.0** | VENDOR.md 坑 1：worklet 那份**本地打过补丁**（回传 `doCallFunction` 返回值），且**已从 `frontend/package.json` 移除** | 对比上游同版本 → 补丁是否已被上游修复？能修就能去掉补丁、回归包管理 |
| **T3** | **verovio wasm** | VENDOR.md：7.3 MB，「**文件里没有 banner、也没有版本串 —— 待补**」 | 从产物内部找构建元数据 → 补版本与来源（现在唯一基线只有 SHA-256） |
| **T4** | 转录/分离引擎：basic-pitch · piano-transcription-inference · transkun · Aria-AMT · pymss/MSST · demucs | `requirements-bundle.txt` 各段注释 | 拆权重与推理代码，找可借鉴的提速/质量点 |
| **T5** | 歌声合成链路：DiffSinger · GPT-SoVITS · pypinyin | `docs/COVER.md` 两条音色通道 | 同上 |
| ~~D~~ | ~~AudioMuse v2.6.0~~ | §4.1 | ✅ **已完成，零缺口** |

**为什么 T1/T2/T3 排在引擎前面**：它们要的是**只有产物视角才给得出的信息**——
「我们改了什么」「上游是哪一版」「补丁还有没有必要」。
T4/T5 是「上游有什么值得我们抄」，源码视角也能查一部分，**REA 的边际收益低一些**。
阶段 0 已经证明过一次这个判断：asar 完整性那条，源码审计**永远看不到**。

**方法论收获**：`docs/plans` 里"祖先对比"这类活儿，**先比数据（预设、参数表、默认值），再比文件名**。
本次先比文件名时看到 6 个"缺失"文件、像是重大缺口；一比预设数字，结论直接反转成"零缺口"。
**文件集差集只能用来生成假设，不能用来下结论**——这与 skill 里"读 limitations，别过度声称"是同一条纪律。

### 4.3 阶段 1 决策（2026-10-13 用户确认）

**全部目标获批**，并附加一条约束：**「先别扩，把手上作业收尾」** → 不新开重活，等手上作业跑完。

执行顺序（用户多选全中，按价值排）：

1. **T1 OpenUtau native** —— 纯本地、不抢网络，可与 py312 下载并行
2. **T1 MuScriptor** —— 需要拉上游 release，等网络空出来
3. **T2 js-synthesizer** → **T3 verovio** —— 都是 VENDOR.md 的自陈缺口
4. **T4 转录/分离引擎** → **T5 歌声合成** —— 边际收益低一档，放最后

**手上作业收尾清单（in flight）**：

| 作业 | 状态 |
|---|---|
| Python 3.12 装配 | ✅ **完成**（13.7 分钟，exit 0，6 组自检 ok）—— 但复验抓到 3 个真缺陷，见 §5 |
| CV 包 → CNB 上传 | ✅ 完成（1518.4 MB / 1404 s，verify → 200） |
| XPU 包实机验证 | **阻塞**：本机无 Intel GPU，只能标注「未经实机验证」 |
| 尾部安静段异常（115–120 min） | 未查 |
| 11 个 TODO 桥接方法 | 未决（接通 or 删除） |
---

## 五、Python 3.12 装配完成 —— 复验抓到三个真缺陷（2026-10-13）

**装配本身成功**：13.7 分钟，`bundle-python312.js` exit 0，`deps.py check` 六组全 ok，
就绪标记 `.fufumidi-engine-ready` 已写；`python.exe --version` = **3.12.10**；torch 2.14.1 / onnxruntime 1.31.0。

**但「自检六组全 ok」是假绿。** 独立复验（不看它自己的输出）抓到三个缺陷：

### 缺陷 A · 3.12 里的 muscriptor 是**裸上游 0.3.0**，我们的补丁没上

| 运行时 | dist-info | `events.py` |
|---|---|---|
| 3.11（现役） | `muscriptor-0.3.0+fufumidi.1` | 12933 B ← **有补丁** |
| 3.12（新装） | `muscriptor-0.3.0` | 10958 B ← **无补丁** |

后果：**长音频「僵尸音符」缺陷在 3.12 上原样复活**。而 `deps.py` 的 `muscriptor` 组照样报 ok ——
因为 `DEEP_PROBE` 只 `import` 一次，**import 成功 ≠ 是对的那个构建**。

**根因**：全仓 `scripts/*.js` **没有任何一行**提到 `fufumidi.1` 或 `muscriptor-runtime` ——
3.11 里那个补丁包是**手工装的**，构建管线从来不知道它的存在，所以 3.12 自然装不到。

### 缺陷 B（已降级为文档问题）· `requirements-bundle.txt` 有一条**过期注释**

- 第 6 行注释：「明确收录人声分离 **demucs**（"人声分离"模式必需，原版默认不装）」
- 正文包列表：**没有 demucs**（只有 `pymss==2.0.1` 那套 MSST）

而 `engine/engine_separate.py` 是**硬依赖 demucs** 的：`MODEL_NAME = "htdemucs"`、
`from demucs import separate as demucs_separate`、`_has_demucs()` 失败即抛
「未检测到 demucs（人声分离引擎）」。`engine/engine.py:18` 也写着 `"separate": ("人声分离", "…（需 demucs）")`。

**实测**：3.11 有 demucs（手工残留），3.12 **没有** → 3.12 的 demucs 人声分离路径不可用。

### ~~缺陷 C~~ · **误判，已撤回** —— `deps.py` 检查 MSST 是**对的**（更正见本节末）

```python
"separate": ["pymss", "pydub", "beartype", "ml_collections", "omegaconf", "einops"],
```

这六个全是 **MSST**（`engine_msst.py`）的依赖，**demucs 一次都没被检查**。
于是自检报 `separate ok`，而 demucs 那条路早已断 —— **校验项和它声称校验的引擎不是同一个**。

### 缺陷 D · `>= x` 在 `shell: true` 下被 cmd 当成重定向 → **版本约束静默丢失**（潜在）

`bundle-python312.js` 第 162/170 行把带约束的 spec 当**内联字符串**传给 `pipAnywhere()`，
而 `pipAnywhere` → `spawnSync(cmd, { shell: true })`（第 72 行）。**cmd.exe 里 `>` 是重定向符。**

```js
pipAnywhere('--no-deps basic-pitch>=0.4.0')
pipAnywhere('scikit-learn>=1.0 typing-extensions>=4.0 mir-eval>=0.6 resampy>=0.4')
```

**实验复刻**（`spawnSync('echo A>=0.4.0', {shell:true})`）：确实产出名为 `0.4.0` 的垃圾文件。
仓库根因此留下 `0.4` / `0.4.0` / `0.6` 三个 **0 字节**文件（0 字节是因为 pip 带 `-q`，没有 stdout 可写）。
已删除。

**定性（不过度声称）**：实测 3.12 里这五个包**都装上了、约束也都满足**——
scikit-learn 1.9.1 / typing-extensions 4.16.0 / mir-eval 0.8.2 / resampy 0.4.3 / basic-pitch 0.4.0。
所以这是**潜在缺陷，不是当下故障**：cmd 把 `>=x` 连约束一起吃掉，**pip 只拿到包名、没拿到约束**，
今天恰好解析到满足约束的版本。**后果是不可复现**（哪天上游出个大版本就会静默越界），不是装不上。

**正确修法**：`pipAnywhere` 改成传 **argv 数组 + `shell: false`**，而不是拼字符串走 shell。
注意 `-r requirements-bundle.txt` 那条路**不受影响**（约束在文件里，不过 shell）。

### ★★ 更正（2026-10-13，查证后）· 缺陷 C **撤回**，缺陷 B 降级

上面 B/C 两段的判读**有一处是错的**，据实更正：

- **C 撤回**：我说 `deps.py:37` 的 `separate` 组「检查的是另一个引擎」。查调用链后否掉了 ——
  `engine.py:246-252` 对 `mode == "separate"` **直接 `raise RuntimeError`**
  （「音频处理（MSST 分离）已不再生成 MIDI。请使用新的「音频处理」面板输出分离音轨」），
  `music2midi.py:330` 的 `separate` 子命令由 **`engine_msst.separate(...)`** 接管，
  `engine.py:94-95` 的可用性判定也是 `engine_msst.available()`。
  → **MSST 才是分离引擎，demucs 链路已废弃。`deps.py` 检查 MSST 完全正确，无需改动。**
  `music2midi.py:228-233` 读 `engine_separate.last_stem_exports` 那段在 `mode == "separate"` 分支里，
  而该分支在 `transcribe()` 就抛错了 → **不可达**（`engine_separate.py` 是死代码）。
- **B 降级**：正文没漏包，是**第 6 行注释写错了**。已改成与正文一致。
  3.12 缺 demucs **不是缺陷**，3.11 里那个 demucs 只是历史残留。

**★ 教训**：我是**先下结论、后查路由**。`deps.py` 的表看起来「查错了引擎」，
但引擎归属要看**调用点**，不是看文件在不在。§4.1 的教训是「文件集差集只能生成假设」，
这次是同一句话的另一面：**静态清单读起来合理，判断仍要回到调用链。**
**「代理指标」不能当结论用 —— 这次是靠回到调用链才没有把一条正确的检查改坏。**

**因此 §5 的收尾清单里，#4 只剩改注释（已做）、#5 取消（不是缺陷）。**
### ★ 缺陷 A 与阶段 0 的 asar 完整性是同一类：**只验「在不在」，不验「是不是对的那个」**

- 缺陷 A：`muscriptor` 在 → ok（**但装的是裸版**）
- **阶段 0 的 asar 完整性**：文件在 → 部署成功（但 integrity 哈希过期）
- （原先还列了「缺陷 C：`separate` 的包在 → ok」，**已撤回** —— 那条其实是正确的检查，见本节更正）

**这是同一类缺陷的第二次出现。** 产物视角的价值再次被证实：源码审视 `deps.py` 时，
`REQUIRED` 表读起来完全合理；只有**把两侧产物摆在一起比**，才看得出「检查项指向的不是要保的东西」。

---

## 六、阶段 1 · T1 MuScriptor ✅ **已得出结论（纯本地，未拉上游）**

原计划要拉上游 release 做比对。**实际上不需要** —— 3.11 有补丁版、3.12 有裸版，
**两份产物相减就是我们的补丁**：

```
只在 3.11 有 / 只在 3.12 有:  仅 __pycache__/*.pyc（字节码本就会因解释器版本不同，非源码差异）
内容不同的文件:                  events.py   12933 B (补丁)  vs  10958 B (上游)   —— 共 1 个
```

**结论：FuFumidi 对上游 muscriptor 0.3.0 的改动 = 1 个文件、1 个函数、3 个 hunk。**

- 新增模块常量 `DEFAULT_MAX_NOTE_HOLD_SEC: float | None = 15.0`
- `OpenNoteTracker.__init__` 增加 `max_note_hold` 参数
- 块边界处理：对**仍在 tie 段里**且 `seek_time - onset > max_note_hold` 的音符，
  按 `onset + max_note_hold` 强制关闭（而不是等一个永远不来的 note-off）
- `max_note_hold=None` 时**关闭该行为，与上游 0.3.0 完全一致** —— 留了退路，这点做得对

补丁注释里记着实测缺陷：**100 条块记录里 4320 秒（约全长七成）被吞掉**。

**产出**：`engine/patches/muscriptor-0.3.0-fufumidi.1.patch`（4193 B，3 hunks，
含上游基线与补丁后 `events.py` 的 SHA-256）—— 让这个**原本手工装、不可复现**的补丁变成可复现的。

### 待办（T1 的收尾）

1. `bundle-python.js` / `bundle-python312.js`：`muscriptor>=0.1`（PyPI 裸版）→ 改为装补丁包
2. ~~`deps.py`：`muscriptor` 组升级为校验补丁身份~~ ✅ **已做**：改查补丁符号 `DEFAULT_MAX_NOTE_HOLD_SEC`（不用文件哈希，因为用户重装后哈希会变、但语义还在就不该报错）。实测 3.11 → `ok:true`；裸版 → `ok:false`
3. `deps.py`：`separate` 组补上 demucs（或明确把 demucs 路径废弃，并从 `engine_separate.py` 与 `engine.py` 的文案里去掉）
4. `requirements-bundle.txt`：第 6 行注释与正文二选一改齐



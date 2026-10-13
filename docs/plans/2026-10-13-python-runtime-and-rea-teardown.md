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
| Python 3.12 装配 | 第 3 步失败：`requirements-bundle.txt 安装失败：所有镜像均不可用`，待查 |

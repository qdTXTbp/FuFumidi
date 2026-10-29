# FuFumidi 后端 / 引擎 / 性能 / 体积 / 代码质量审计

- 审计对象：E:\Midi\FuFumidi-Source（Electron 33.4.11 + Vue3 + Python 3.12 引擎），快照 commit a13c51a「release: 6.2.9」，package.json version 6.2.9
- 审计时间：2026-10-29
- 审计方式：**只读静态审计 + 本机可执行度量**。源码未做任何修改；度量脚本一律写在仓库外（E:\Midi\_attic\audit\bench\，见 §19）。**未启动 GUI**（避免干扰用户数据与正在使用的安装版）；凡是只有跑起来才能确认的结论都标注 **待实测**，并在 §20 给出验收方法。
- 范围：main/**（53 个模块）、main.js、preload.js、engine/**（顶层 69 个 .py）、package.json、6 份 electron-builder 配置、build.js / build-gpu-package.js / scripts/*、依赖与模块体积、worker/GPU/内存、任务队列、下载、缓存、数据根、打包体积、死代码/重复逻辑/兼容分支/日志与错误处理/测试覆盖。
- 代码规模：main/ + main.js + preload.js = **18,702 行 / 55 个 JS 文件**；engine 顶层 .py = **25,009 行**（含子目录 87,446 行）；preload 暴露 **248 个 IPC 通道**。
- 度量口径：体积一律 MiB（1 MiB = 1,048,576 B），文件计数用「不跟随符号链接」的递归 lstat（脚本 sz.js），因此与 du 有差异（du 会把同一 inode 重复计入：同一份 python 目录 du 报 1,548 MiB，逐文件 lstat 为 1,484 MiB / 31,629 文件）。本机为 **CPU-only** 环境（torch 2.14.1+cpu，torch.cuda.is_available()=False），所有 CUDA/VRAM 数字来自代码与仓库自带实测注释，标注 **待实测**。
- 分级：**P0** 默认配置下可观测的坏行为（卡顿/泄漏/体积翻倍）；**P1** 显著浪费或明确风险；**P2** 结构性/一致性问题。

---

## 0. 执行摘要

这个仓库的后端工程化水平**高于同类 Electron 项目**：下载器收敛成单入口并带测速/分段/续传/看门狗（main/fast-download.js）、任务中心有契约与单测、打包排除清单每条都写着「当年怎么炸的」、611 个 pytest 用例、248 个 IPC 通道与 preload **零漂移**（我做了双向比对，见 §4.1）。真正的问题不是"没做"，而是**几处关键路径上"做了但没接到热路径上"**，以及**体积只做了一半**。

五个系统性结论：

1. **体积：内置 Python 运行时 1,484 MiB，占安装体积 73%；其中 296 MiB 是构建脚本本来就会删的产物，却还在包里。** 仓库自带 scripts/prune-python-bundle.cjs 会删 *.pyc / *.lib / *.a / include/ / tests/，但当前 release/win-unpacked 里实测仍有 **251.9 MiB 的 .pyc（13,664 个）和 44.1 MiB 的 .lib（173 个）** —— 说明裁剪没有进门禁（§10.3）。另有 **165 MiB 是引擎从不导入的包**（matplotlib / pandas / sklearn / sympy / tensorboard / grpc / networkx / seaborn / narwhals / pygments），我用"阻断导入"实验验证了默认转录链路完全不碰它们（§2.3）。安装包 6.2.8 = 744,038,308 B ≈ 710 MiB，安装后 2,029 MiB —— 保守可降到 **约 540–570 MiB / 1,570–1,620 MiB**。

2. **主线程有三处"同步大活"，全部在 IPC handler 里同步跑。** storage:report 实测 **3,878 ms** 阻塞（50,111 个文件，main/storage.js:28-67）；保存一次设置会触发 sql.js **61 MiB 全库导出 + 落盘，实测 380 ms**（main/db.js:54-61 + main/settings-ipc.js:53-55，库 60.8 MiB / 1,970 行）；自动保存单份草稿最大 32 MiB 同步写（main/autosave.js:28-48）。这三处都是"用户点一下界面就冻住"的量级。

3. **"看一眼引擎状态"要起一个新 Python，代价 6.5 s / 4.7 s，且资源中心一进去就起两个。** engine:probe 实测 **6.46 s**（冷启动 python + 导入 torch/scipy/basic_pitch），dep:check 实测 **4.70 s**（engine/deps.py:139-161 的 DEEP_PROBE 会真导入 torch）。ViewResources.vue:565-569 的 onMounted 同时调用 refreshModels()（含 depCheck，:476-479）与 loadGpu()（含 probe，:549-551）—— 进入资源中心 = 两个 Python 进程各导入一遍 torch。

4. **常驻 worker 的收益被两头抵消。** 空闲 120 s 就回收（main/engine.js:20），于是"隔两分钟再转一首"要重付一次 Python 冷启动（本机实测整套 import **13.47 s**，其中 torch 6.89 s、scipy 5.26 s）；而退出时 killAll() **只杀 spawn 出来的子进程，不杀 worker 池**（main/engine.js:13/56/266，worker 在 :139 spawn 但从未 activeChildren.add）—— 转录中退出应用会留下孤儿 Python 进程，继续吃 RAM/VRAM。

5. **可观测性缺位。** Paths.logDir() 建了日志目录、存储面板还把它当一类区域（main/paths.js:341、main.js:196），但**全仓库没有任何一处往 logDir 写日志**（仅 1 处引用，即定义本身）；打包版没有控制台，等于线上零日志。同时 main/ + preload 有 **795 处 catch，其中 381 处是空 catch（48%）**，engine/*.py 有 487 处 except，其中 130 处紧跟一句 pass。

### 评分卡（10 分制，横向比较用）

| 维度 | 分数 | 一句话理由 |
|---|---:|---|
| 冷启动 / 首屏 | 6.5 | 主进程 require 仅 60 ms，真正贵的是渲染进程触发的 Python 探测（§3.4） |
| 主线程响应性 | 4.5 | storage 3.9 s、settings 保存 0.38 s、autosave 32 MiB 同步写（§9.6 / §9.4） |
| 安装体积 | 3.5 | 1,484 MiB Python 里 461 MiB 可回收，但裁剪脚本没进门禁（§2.3 / §10.3） |
| 内存 / VRAM | 5.5 | 音频全量驻留（317 MiB/小时）、多 worker 多 CUDA context、无 allocator 调参（§6） |
| 并发与取消 | 6.5 | 取消链路修过两次、有 canceled 标记防回落；但 4 本账、无全局并发上限（§7） |
| 下载 / 缓存 | 8.0 | 单入口 + 测速/分段/续传/看门狗/完整性，实测数据写在注释里；扣分在进度事件不限流（§8） |
| 可观测性 | 3.0 | 有 logDir 但零写入；48% 空 catch；错误只进控制台（§14） |
| 代码结构 / 重复 | 5.5 | 模块边界清楚，但参数表有 3 份手工副本、6 份 builder 配置（§5.4 / §10.1） |
| 死代码 | 6.0 | 34 个导出无外部引用、11 个 db 通道前端从不调用、cpu-fallback 分支永假（§11 / §13） |
| 测试 / CI | 5.0 | 611 个 pytest + 20 个 node 测试脚本，CI 只跑 2 个（§15） |
| 打包工程 | 5.0 | 主配置写满"事故注释"，但 local-dir 副本已漂移，且没有单一事实源（§10） |

---

## 1. 度量口径与可复现

| 指标 | 数值 | 口径 / 证据 |
|---|---:|---|
| 安装目录 win-unpacked | **2,029 MiB** / 31,975 文件 | sz.js 递归 lstat（release/win-unpacked，6.2.9 本地构建） |
| └ resources | 1,791 MiB | 同上 |
| └ resources/python | **1,484 MiB** / 31,629 文件 | 同上；site-packages 1,435 MiB / 30,093 |
| └ resources/models | 212 MiB | extraResources，内置只读模型 |
| └ app.asar / app.asar.unpacked | 28 / 40 MiB | asar 28 MiB 里 renderer 占大头 |
| 安装包 FuFumidi Setup 6.2.8.exe | **744,038,308 B ≈ 710 MiB** | release/ 目录 |
| 主进程 require 全量 main/*.js | **60.3 ms** / 53 模块 | Electron 桩替换后 node 度量（bench/require-main.js） |
| Python 引擎首次 import 全栈 | **13.47 s** / 1,846 模块 | 内置 3.12.10 运行时实测（bench/imp.py） |
| └ torch / scipy | 6.89 s / 5.26 s | 同上（冷页缓存）；torch 二次 import 2.04 s |
| music2midi.py probe | **6.46 s** | 冷启动 python 进程，CPU-only |
| deps.py check | **4.70 s** | 同上 |
| storage:report 等价遍历 | **3,878 ms**，50,111 文件 | bench/stattree.js，按 main/storage.js:28 的算法重现 |
| sql.js 全库 export + 落盘 | 8 ms + **380 ms**（60.8 MiB，1,970 行） | bench/sqlbench.js，读真实 fufumidi.sqlite |
| 10 分钟音频 decode_to_wav(22050) | 1.00 s → 25.2 MiB 临时 WAV | bench/decode.py（599× 实时） |
| 同文件 float32 / float64 常驻 | 50 MiB / **101 MiB** | soundfile.read 默认 float64（engine_basic.py:67 未指定 dtype） |
| IPC 通道 | preload 248 个，ipcMain.handle 248 个，**双向零差集** | grep + comm 比对（§4.1） |
| 空 catch | main+preload **381 / 795（48%）**；engine 130 / 487 | bench/catch2.js |
| 死导出候选 | 34 | bench/dead-exports.js（导出名在仓库内零引用） |

---

## 2. 体积与依赖

### 2.1 发行物实测（P1）

| 层 | 体积 | 说明 |
|---|---:|---|
| resources/python | 1,484 MiB | 31,629 文件 —— **发不动的根因** |
| resources/models | 212 MiB | 内置 basic_pitch / piano_transcription 等 |
| resources/app.asar + unpacked | 68 MiB | renderer/dist 46 MiB（含 soundfonts/wallpapers） |
| resources/g2p | 24 MiB | 13 个 g2p-*.zip（歌词→音素） |
| Chromium/Electron 其余 | 241 MiB | FuFumidi.exe 181 MiB（未剥离）、icudtl 10 MiB 等 |
| 合计 | **2,029 MiB** | 装完 + 数据根另算（本机数据根 31.8 GiB） |

python 运行时的真实构成（单目录 lstat 求和，MiB）：

| 包 | 体积 | 引擎是否导入（静态 + 运行期验证） |
|---|---:|---|
| torch | 463 | 是（piano/separate/muscriptor） |
| llvmlite | 115 | 是 —— **但只在 librosa 首次 resample 时**（实测 2.24 s 加载 numba+llvmlite+resampy） |
| transformers | 102 | 否（engine 无 import；muscriptor 自带实现，实测 import 2.08 s 未拉 transformers） |
| imageio_ffmpeg | 84 | 是（engine/audio_io.py:70 取静态 ffmpeg） |
| scipy | 80 | 是 |
| av.libs | 64 | 是（basic_pitch 导入即拉 PyAV，实测） |
| transkun | 54 | 是（钢琴 transkun 模型） |
| onnxruntime | 46 | 是 |
| sympy | 38 | **否**（阻断后默认链路全通） |
| pandas | 29 | **否** |
| sklearn | 28 | **否** |
| matplotlib | 25 | **否** |
| numpy(.libs+本体) | 37 | 是 |
| PIL / fontTools | 32 | 是（OMR） |
| numba | 14 | 是（librosa 依赖） |
| grpc | 13 | **否** |
| tensorboard | 10 | **否** |
| pip | 11 | 是（GPU 增强包 pip 安装用） |

### 2.2 三类可回收体积（P1，合计约 461 MiB）

1. **prune 脚本本该删掉、但还在包里的 296 MiB**：.pyc 251.9 MiB / 13,664 个；*.lib 44.1 MiB / 173 个；*.a 0.2 MiB；include/ 1.2 MiB；libs/ 0.6 MiB；Lib/ensurepip 1.8 MiB。证据：scripts/prune-python-bundle.cjs:34-42 的 CATEGORIES 覆盖这五类，而当前产物里五类全在（bench/prunecheck.ps1 输出）。
2. **从没被导入的顶层包 165 MiB**：matplotlib 25 + pandas 29 + sklearn 28 + sympy 38 + tensorboard 10 + grpc 13 + networkx 8 + pygments 8 + narwhals 4 + seaborn 2。验证方法见 §2.3。
3. **文档/历史残留**：engine/_render_cherry_pop.py、engine/_render_enemy.py（两份 6–8 KiB 的一次性开发脚本，彼此重复 32 个 10 行窗口，且因 electron-builder.yml:69 的 !_* 只匹配根目录、**它们会被打进包**）；engine/_kana.txt、_kana_all.txt、_rel_pytest.txt、_sf3test.txt、_sync_test.txt、._pt_sf3c/、._pt_sync/、._pt_sync2/（macOS AppleDouble 与临时文本）。

> **重要反例（不要误删）**：pooch 必须留 —— librosa.util.files 顶层 import pooch，我在第一次阻断实验里把它列入可删，结果 basic-pitch 直接 ImportError（记录在此避免复现这个错误）。numba/llvmlite/resampy 也必须留：librosa.resample 首次调用即加载三者（实测 2.24 s），而 decode/audio_chain/audio_tagger/cover 全都用 resample。pip 必须留：main.js:652 的 CPU 回退用内置 pip 安装 wheels。

### 2.3 "未导入包"是怎么验证的（可复现）

两种独立证据，互相印证：

1. **静态**：对 engine/**（排除 vendor/tests）grep import X / from X —— matplotlib / pandas / sklearn / tensorboard / grpc / sympy / networkx / seaborn / narwhals 全部 0 命中。
2. **动态（阻断式）**：在 sys.meta_path 首位插一个 finder，对这些顶层包一律抛 ImportError 并记录，然后：导入 39 个 engine_* 模块 → 0 失败、0 命中；再跑一次完整的 engine.transcribe()（44100 Hz、5 s 合成音、universal/basic）→ **成功出 1 个音符，全程 0 次被阻断**（bench/block.py、bench/smoke.py）。也就是说，默认转录链路、音频链、MIDI 后处理、模型加载都不需要这些包。

残余风险（必须在门禁里覆盖）：OMR（PIL/Audiveris 外部进程）、score2midi、DiffSinger、UTAU、RVC、翻唱这些**非默认链路**我只做了导入级验证（39 个模块全部导入成功），没有做端到端渲染。建议把"删包"与"OMR/翻唱/歌声端到端冒烟"绑在同一条 CI 任务里，任何一条挂就回滚该包。

### 2.4 安装包与更新包（P1）

- 6.2.8 安装包 710 MiB；release/update 目录 3,519 MiB（增量更新器素材，含整份 python），release/ 总计 10.4 GiB —— 本机磁盘占用的最大头其实是**构建产物目录**，不是源码。
- electron-builder.yml:151 compression: maximum（LZMA）是对的：这个项目要下载分发，体积 > 构建时间。但压缩率对 .pyc/.lib 这类高熵文件只有 ~3–4×，所以删 296 MiB 未压缩内容大约值 **70–90 MiB 安装包**；删 165 MiB 未导入包（多为 .py 与 .pyd）大约值 **40–60 MiB**。这是"710 → 540–570"的推算依据，最终以实测为准。

### 2.5 一个容易踩的反向优化（P2）

删 .pyc 会**拖慢首次 import**，而安装到 Program Files 时 python 目录只读，解释器无法把 .pyc 写回去 —— 于是每次启动都重新编译一遍。所以：
- 保留 .pyc（251.9 MiB，压缩后约 70 MiB）可能是**值得的**；先删 .lib/.a/include（45.9 MiB，纯链接期产物、压缩率也差），再评估 .pyc。
- 若确实要删 .pyc，必须同时把 resources/python 的 ACL 设为安装用户可写（或把 PYTHONPYCACHEPREFIX 指到数据根），否则"省体积"会换来每次启动多 1–3 s。

---

## 3. 启动路径

### 3.1 whenReady 时间线（P1）

main.js:136-265 是唯一的启动序列，**窗口在最后一行才创建**（main.js:231）：

| 顺序 | 代码 | 成本 | 可否移出关键路径 |
|---:|---|---|---|
| 1 | 46 个 require（main.js:20-75） | 60.3 ms（本机） | 可懒加载：dawproject 11.6 ms、diffsinger 4.1 ms、cover 3.5 ms、plugins 3.5 ms、ai-generate 3.2 ms 都是"用到才需要" |
| 2 | configureSession + 29 个 register*Ipc | 每个 register 只挂 handler，成本低；但 plugins 会在窗口前 loadAll()（main/plugins.js:36-39） | 插件扫描可延后到首帧后 |
| 3 | **await prepareDataRoot()**（main.js:164） | 正常 <10 ms；**旧数据根迁移时是分钟级 + 进度窗** | 必须保留（正确性） |
| 4 | linkBundledModels / healModelsDir（main.js:166-167） | 对 models 顶层 readdir+stat（本机 ~20 项，<5 ms；junction 断链多时线性增长） | 可懒 |
| 5 | migrateUserModels()（main.js:168） | 首次运行会递归复制内置模型（.migrated_v1 标记后跳过） | 可后台 |
| 6 | registerModelsIpc（main.js:169） | 建立 1,600 行注册表（纯内存）+ 挂 ~40 个 handler | 可懒 |
| 7 | 其余 register（library/db/rust/settings/project/utau/diffsinger/rvc/cover/gpu…） | 挂 handler | 可懒 |
| 8 | createWindow（main.js:231） | loadFile(renderer/dist/index.html) | — |

**结论**：主进程自身的启动开销（require 60 ms + 目录扫描）在 100 ms 量级，**不是首屏瓶颈**；首屏瓶颈在渲染进程启动后立刻发起的重 IPC（§3.4）与首次转录的 Python 冷启动（§5）。所以"启动优化"不该动 main.js 的结构，而该**把 Python 探测移出页面进入路径**。

### 3.2 三个启动定时器（P2）

| 时机 | 代码 | 做了什么 |
|---|---|---|
| +600 ms | main.js:254 | openFileFromArgv 兜底（与 open-file:take 双保险，注释里写了竞态原因） |
| +2.5 s | main.js:696-703 | integrity.check()（读 settings/presets/插件清单） |
| +3 s | main/settings-ipc.js:97-108 | 打包版每次启动 applyFileAssoc(true)：**4 次 reg.exe + 1 次 ie4uinit.exe** 子进程 |

前两个合理。第三个每次启动都改注册表并拉起 5 个系统进程，属于"为了修图标丢失"的高频副作用；建议改为**仅在检测到 ProgID/图标值与期望不一致时写**（比对 reg query 一次，或把上次写入的值记在 settings 里）。

### 3.3 preload 与渲染进程的启动面（P1）

preload.js 463 行、253 个 invoke、248 个通道全量在启动时构造（每个都是一行闭包，成本可忽略），**但桥本身是单文件单体**（§4.2）。渲染进程启动后的重活（不在本次前端审计范围，但决定首屏可交互时间）：

- App.vue:362-389 启动 2.5 s 后自动 updateCheck（GitHub API，超时 12 s）；国内网络下这条会挂满 12 s。
- ViewResources.vue:565-569 一进页面就 depCheck + probe（§3.4）。
- ViewTranscribe.vue:1168 一进转录页就 probe。

---

## 4. 主进程与 IPC

### 4.1 通道零漂移（正面结论，P0 级可信度）

我把 preload 的 248 个 ipcRenderer.invoke('x') 与 main/**+main.js 的 248 个 ipcMain.handle('x') 做了双向差集：

- preload 有、主进程没有：**0**
- 主进程有、preload 没有：**0**

也就是说 docs/FOUNDATION.md 的"新能力三处同改"在这 248 条上是真的守住了。这是这个仓库最值得保留的工程习惯之一。

### 4.2 但桥是单体（P2）

一个 contextBridge.exposeInMainWorld('fuBridge', {...}) 装了 248 个方法（preload.js:6-463），其中 11 个是 db:*（前端零调用，§11）、1 个是 pickSoundFont: null 占位（preload.js:98）。没有命名空间收敛（cover* / rvc* / sfWorkshop.* / omrEngine.* / usermeta.* 混用扁平与嵌套两种风格）。

建议：按域拆 4–6 个 preload 片段（core / engine / download / media / settings），每个 exposeInMainWorld('fuBridge.<domain>')；frontend/src/types/ipc.ts 用同一份 JSON schema 生成，避免 248 条手写类型漂移。

### 4.3 事件通道：10 Hz 全量 + 逐行转发（P1）

| 通道 | 发送方 | 频率与载荷 | 问题 |
|---|---|---|---|
| task:update | main.js:143-149（遍历所有窗口） | taskcenter 节流 10 Hz（main/taskcenter.js:18/48-53），**每次发全量任务列表**，每任务含最多 200 行日志（taskcenter.js:21/31） | 任务多时每秒序列化几十 KB～几 MB；前端只想要增量 |
| engine:log | main/engine.js:169-171（worker 路径）、main/task-queue.js:90/165/225（spawn 路径） | **每行一条 IPC**，无合并/限流 | 引擎日志密集时是 O(行数) 的跨进程消息；worker 路径还额外做了一次中文前缀正则过滤（engine.js:164） |
| model:progress | main/models.js:792-799 | 跟随下载器回调，**单流路径每个 chunk 一次**（§8.2） | 大文件时可达每秒数十～数百条 |
| engine:separate:progress | task-queue.js:226 | 引擎侧进度 | 同上 |

### 4.4 窗口与托盘（P1）

- backgroundThrottling: false（main/window.js:41）+ close_to_tray 默认开（main.js:276）+ 关闭即 win.hide()（main.js:308-310）。结果：**窗口隐藏到托盘后渲染进程仍按满帧跑**（可视化页的 rAF、壁纸视频解码都不降频）。这是一条实打实的"后台耗电/占 GPU"路径。建议隐藏时 webContents.setBackgroundThrottling(true) 并在 hide 时暂停可视化 rAF。
- show: true（window.js:17）与 ready-to-show 再 show（window.js:45）重复；建议 show: false + 一次性 show，避免白底闪一帧。
- GPU 开关（main.js:87-111）写得很有针对性（虚拟显示适配器导致 GPU 进程 0xC0000005 的兜底），disable-gpu-sandbox + disable-gpu-process-crash-limit 是合理的"可退化"策略。**注意**：enable-features 与 disable-features 是两次独立 appendSwitch，Chromium 会各自合并，当前写法安全；但若将来再 append 一次 enable-features 会**覆盖**前一次，建议改成一次性拼接。

---

## 5. 引擎与子进程模型

### 5.1 三条执行路径（结构清晰，P2 维护成本）

| 路径 | 代码 | 进程模型 | 何时用 |
|---|---|---|---|
| 一次性 spawn | main/engine.js:40-114 | 每次任务一个 python，读完即退 | 探测、OMR、分离、翻唱、导出等 |
| worker 池 | main/engine.js:134-246 | 1–4 个常驻 python，stdin JSON 行协议 | 转录（engine:convert 默认路径） |
| 常驻会话 | main/engine.js:277-389 | 一个 python + serve 子命令，请求/响应 | UTAU / DiffSinger 等调参链路 |

三者共用 spawnEngine 的超时/暂停预算逻辑（engine.js:92-112），设计是对的。

### 5.2 worker 池参数（P1）

- 槽位：1..4，cfg.__slots 由渲染端给（main/engine.js:208）；**GPU 环境自动 −1**（:210-212），即最多 3 个 python 进程。
- slot 0 常驻不回收，slot>0 空闲 **120 s** 回收（engine.js:20-32）。
- 负载均衡：按"在途请求数"选最少槽位（:213-224）——**不是按模型/参数亲和**：同一个槽位可能先跑 basic 再跑 muscriptor，两种模型都留在内存里（basic 的 ONNX session 由 engine_perf.py:204 缓存、muscriptor 由 engine_muscriptor.py:19 缓存），进程 RSS 只增不减。
- 收益评估：worker 真正省的只是 **Python 解释器 + torch/scipy 的 import（13.47 s）** 和 basic/muscriptor 模型加载；因为 engine.transcribe() 在 finally 里 gc.collect()+torch.cuda.empty_cache()（engine/engine.py:170-188），**CUDA 分配器缓存每任务被清空**，短任务反而会反复付首次分配开销。建议把 empty_cache() 改成"空闲 60 s 后或显存压力 >85% 时"才调用（**待实测**：连续 10 个短任务的总耗时对比）。

### 5.3 退出清理缺口（P0 风险）

- killAll() 只遍历 activeChildren（main/engine.js:265-267）；而 activeChildren.add 只出现在 spawnEngine（:56）与 createEngineSession（:292），**ensureEngineWorker 的 worker 从未加入**。
- stopEngineWorker() 只被 gpu-ipc 的安装/卸载调用（main/gpu-ipc.js:134/261/386/550），**退出流程（main.js:670-682）没有调用它**。
- 实际后果：正常空闲时 stdin EOF 会让 for line in sys.stdin 结束、worker 优雅退出（engine/music2midi.py:556）；但**正在推理时进程阻塞在读音频/前向**，不会读 stdin —— 此时退出应用，Python 会继续跑到这首结束（可能几十分钟），期间继续占 RAM 和 CUDA context。用户重启应用后 GPU 显存被旧进程占着，正好会撞上"显存不足"的既有报错路径。

**修法（3 行级）**：killAll() 里加 for (const c of _workers.values()) try { c.kill(); } catch {}，并在 before-quit 调一次 stopEngineWorker()；顺手把 worker 也 activeChildren.add（统一账本）。

### 5.4 参数表有三份手工副本（P1，已多次漂移）

同一个"界面参数 → 引擎参数"的映射被写了三遍：

| 位置 | 形态 | 行数 |
|---|---|---|
| main/engine.js:237-242 | worker 请求对象的 key 映射 + 布尔键清单 | ~6 |
| main/task-queue.js:52-88 | --flag 命令行参数表（spawn 回退路径） | ~37 |
| engine/music2midi.py:563-618 | worker 请求 → argparse.Namespace 的手写字段表 | ~56 |

代码注释本身记录了至少 6 次漂移事故：muscriptor_instruments（engine.js:235-236）、segment_sec 五键（engine.js:238-240）、multiple_pitch_bends（music2midi.py:587-589）、beat_grid（:601-603）、max_note_hold（:604-606）、audio_tagger（task-queue.js:62-66）。这是全仓库**最高频的缺陷来源**，且每次都要靠人肉 review 抓。

**修法**：用一份 engine/params.schema.json（key / flag / type / default / 适用模式）作为唯一事实源，三处都在构建时生成：worker 的 Namespace 用 argparse 自身的 parse_args 反推（把 JSON 转 argv 再解析，天然一致），主进程的 map 与回调表从同一份 JSON 生成。工作量约 2–3 人日，收益是"这类 bug 绝迹"。

### 5.5 worker 协议与日志分流（P2）

三种协议前缀（RESULT / PROG / LOG，均带 ### 前缀；engine.js:150-186、music2midi.py:619-665）是合理的轻量协议。两点小问题：

1. _LogTee.write() 对每个 print 的**每一行**都 json.dumps + flush（music2midi.py:629-638），高频日志时是纯 CPU 浪费；如果引擎里有 tqdm 之类 \r 刷新，splitlines() 会把一次进度条拆成多行（MSST 已经把 tqdm 换成 _CaptureBar，见 engine/engine_msst.py:78-166，所以当前风险低）。
2. cmd_worker 每个请求都新建 _LogTee 与 contextlib.redirect_stdout（:640-646），并在结束时把整个 buf.getvalue() 再 split 一遍找 ###RESULT（:649-656）——长任务日志大时是 O(日志量) 的字符串复制。

### 5.6 常驻会话使用面窄（P2）

createEngineSession（engine/engine.js:277-389）只被 utau / diffsinger 用到（main.js:203/205）。它同样**没有超时后的进程回收**：request 超时只是 reject 掉 promise（:345-348），python 仍在跑；下一次 request 复用同一进程 → 超时的任务与新任务在同一 stdin 上交错，结果按 id 匹配不会错，但**上一个任务的算力仍在消耗**。建议超时后强制重启会话（已有 kill() 可复用）。

---

## 6. GPU / VRAM / 内存

### 6.1 显存策略现状（P2）

- 三档 memory_mode（auto/low/allow）只影响**批量上限**（engine/engine_pt.py:28-41）与 **muscriptor 模型是否缓存**（engine_muscriptor.py:720-730），**不影响** torch.cuda.empty_cache() 的调用时机（每任务末尾必调，engine/engine.py:184、engine/engine_msst.py:420、engine_muscriptor.py:1542/1587）。
- OOM 处理：muscriptor 有 oom = "out of memory" in str(e) 的降级重试（engine_muscriptor.py:1519-1545），transcribe_runtime 也有一层（:291）；但没有**全局**的"显存压力 → 降批 → 重试"抽象。
- **缺一个环境变量**：全仓库没有设置 PYTORCH_CUDA_ALLOC_CONF（grep 0 命中）。长音频多段推理最容易撞的是分配器碎片，建议在 engineEnv()（main.js:581-620）里默认注入 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True（torch ≥2.1 支持），并允许设置项覆盖。**待实测**：本机无 CUDA。

### 6.2 多 worker = 多 CUDA context（P1，待实测）

GPU 环境最多 3 个 worker（§5.2），每个 Python 进程独立初始化 CUDA context（通常 200–400 MiB 显存 + 一块驱动/库的常驻内存）。也就是说"并行 3 路转录"在 8 GiB 卡上很可能**因为 context 开销先 OOM，而不是因为模型**。当前 engineWorkerConvert 只看 FUFUMIDI_DISABLE_GPU !== '1' 就减 1 路（engine.js:210-212），**没有读显存容量**。

建议：主进程用 engine_gpu.detect() 的结果（probe 已返回）缓存一份显存总量，按 可用显存 / 单路预估（muscriptor-small ≈ 2.5–3.5 GiB，**待实测**）决定槽位数，并把 __slots 的上限从渲染端收到主进程。

### 6.3 RAM：音频全量驻留（P1）

| 路径 | 代码 | 10 分钟音频实测 | 2 小时推算 |
|---|---|---|---|
| decode_to_wav（写 PCM16 临时文件） | engine/audio_io.py:110-140 | 25.2 MiB 文件 / 1.00 s | **302 MiB 临时文件** |
| load_audio_float32（auto-bpm、钢琴） | audio_io.py:143-161 | 50 MiB 常驻 | **600 MiB** |
| basic-pitch 分段模式 sf.read（默认 float64） | engine/engine_basic.py:67 | **101 MiB** | **1.2 GiB** |
| basic-pitch 正常模式（librosa.load 再解码一次） | basic_pitch/inference.py 的 librosa.load | 第二次全量解码 | 又一次全量 I/O |

两条具体优化：
1. engine_basic.py:67 的 sf.read(wav_path, always_2d=False) 补 dtype='float32'，**直接省一半内存**（101 → 50 MiB/10 min），且下游 do_predict 本来就要 float32。
2. basic-pitch 前置的 decode_to_wav（engine_basic.py:172）之后，get_audio_input 又用 librosa.load 把同一个临时 WAV **完整解码第二遍**。可以给 basic_pitch 传已解码的数组（或把临时 WAV 以 22050/单声道直接喂给 predict 的音频数组接口），**省一次全量解码 + 一次整文件读**（10 分钟素材约 1.0 s + 25 MiB I/O）。

### 6.4 模型缓存只对 CUDA 生效（P2）

engine_muscriptor.py:720-730：只有 torch.cuda.is_available() 且 memory_mode != 'low' 才缓存模型。这导致 **CPU 用户（占多数）每首都要重付 2–3 s 模型加载**，而这恰恰是 CPU 用户最缺的时间。建议：CPU 也缓存（CPU 内存不像显存那么稀缺），low 档才禁用。

---

## 7. 任务队列 / 并发 / 取消

### 7.1 四本账（P2，已经修过两次同类 bug）

| 账本 | 位置 | 键 | 用于 |
|---|---|---|---|
| convertChildren | main/task-queue.js:9 | 渲染端 jobId | engine:cancel 的 spawn 路径 |
| _engineWorkerPending | main/engine.js:18 | 内部 w<N>；渲染端 id 存在 logId | worker 路径的取消/进度/日志 |
| _sessions | main/engine.js:19 | 会话句柄 | 常驻会话取消 |
| taskCenter.tasks | main/taskcenter.js:22 | 任务 id | UI 展示/取消回调 |

cancelJob（engine.js:399-425）已经做了"两本账都查 + 按 logId 反查"，注释里写着这是同一条链路的**第二处漏配**。这正说明"四本账"本身就是缺陷源。建议把任务身份收敛成一个 JobRegistry（id → {kind, child, session, taskHandle, cancel}），所有路径注册/注销同一处。

### 7.2 取消语义（做得好，保留）

- canceled 标记防止"取消后回落重跑"（task-queue.js:120-126 + engine.js:414-418），这是真踩过的坑，注释完整。
- 取消会真的 child.kill()（engine.js:420），不是只 reject Promise。

### 7.3 超时策略（P2）

| 场景 | 总超时 | 空闲看门狗 | 依据 |
|---|---|---|---|
| 默认 spawnEngine | 30 min（engine.js:47） | 关闭（idleTimeoutMs=0） | 长任务用 6 h + 20 min idle 覆盖（task-queue.js:233-234） |
| 分离/翻唱 | 6 h | 20 min | 演唱会 FLAC 实测被 30 min 误杀（注释） |
| 会话 request | 30 min | 无 | — |

暂停期间不计入预算（engine.js:101-105，读 Paths.pauseFlagFile()）—— 这个细节做对了。但代价是**每秒钟对每个子进程做一次 fs.existsSync(pauseFlagFile())，而 pauseFlagFile() 会经过 cacheRoot() → ensure() → mkdirSync**（main/paths.js:325/333）。即：转录期间每秒 1 次同步 mkdir + 1 次 exists（每个子进程）。改成"暂停状态由 IPC 写内存变量 + 仅首次落文件"即可，成本归零。

### 7.4 没有全局并发上限（P1）

可以同时存在的重活：转录 worker 最多 4 个 + 分离 1 个 + 翻唱（分离→变声→混音串行）+ OMR（Audiveris Java 子进程）+ 壁纸缩略图（每个 spawn 一个 python，**Promise.all 并发**，§8.4）。全部没有共享信号量。低配机上这是"越点越卡"的根因之一。建议加一个 heavySlot 信号量（默认上限 = max(1, cores/4)，GPU 机器按显存），所有重 CPU 任务都过它。

---

## 8. 下载与缓存

### 8.1 总体评价（P0 级正面）

main/fast-download.js 是我在这个项目里看到的最成熟的模块：多源测速（:197-233）、分段并发（:366-549）、单流续传（:554-641）、停滞看门狗（:168-194，按"实际收到字节"计）、低速轮换（:585-609）、完整性三重校验（:266-275）、磁盘预检（:250-263）、取消契约（:316-321）。常量都有实测依据（:35-46 的注释写了 26.01 MB/s vs 0.28 MB/s 的对比）。所有 11 个下载点都走它（diffsinger/gpu-ipc/models/omr/soundfonts/update/utau/wallpaper）。

### 8.2 单流路径的进度事件没有限流（P1）

- 分段路径：sendP() 有 250 ms 节流（fast-download.js:387-397）。
- 单流路径：每个 chunk 直接 report({...})（fast-download.js:597），**无节流**。
- 调用方 models.js:792-799 的 onProgress 直接把每条回调转成 webContents.send('model:progress')。

于是走单流（CNB 不支持 Range、或文件 <4 MiB、或分段失败回落）时，一个 500 MiB 文件按 64 KiB chunk 会产生 **约 8,000 条 IPC**，每条都要结构化克隆 + 前端响应式更新。**修法**：在 report 层统一节流（≥100 ms 或 ≥1% 变化），调用方无需改。

### 8.3 已知例外（合理，保留）

models.js:1443-1449 记录了"KB 级配置模板不走 FastDL"的原因（FastDL 的探测+续传会截断 1–5 KiB 文件），并在 docs/DOWNLOADS.md 备案 —— 这是正确的工程判断。

### 8.4 壁纸缩略图：每个缺图 spawn 一个 python（P1）

main/wallpaper.js:62-84 的 ensureLocalThumb 为了拿 ffmpeg 路径，**起一个 Python 进程** 执行 imageio_ffmpeg.get_ffmpeg_exe() + 一次 ffmpeg；:103 用 Promise.all 对所有缺图壁纸并发。用户导入 10 个视频壁纸 = **10 个 Python 解释器同时启动**。
**修法**：主进程直接定位内置 ffmpeg（resources/python/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-*.exe），用 execFile 一次生成缩略图；并把并发限制到 2。

### 8.5 缓存与临时文件（P2）

本机数据根实测：temp **217 MiB / 1,750 文件**、cache 131 MiB。engine/audio_io.py:35-61 的 sweep_stale_temp 只在**启动时**清 6 小时前的 midi_tool_*，且只清 tempfile.gettempdir()（主进程把 TEMP 指到数据根后是同一处）。问题是：
- 转录/分离被强杀留下的 WAV/分轨目录仍然是主要泄漏源（注释自己写了"实测遗留 12 个 1.34 GB"）。
- 建议加"超过总预算（如 2 GiB）就按 mtime 从旧到新删"，并在设置页的清理里把 temp 默认勾上。

### 8.6 下载完成后的同步遍历（P2）

models.js:801-804 在下载完成后用递归 fs.statSync 走整棵目录求总大小；HF 整仓（数 GB / 数千文件）时这是一次秒级同步阻塞。改用 fs.promises 或直接用下载器返回的字节数累加即可。

---

## 9. 数据根与磁盘占用

### 9.1 设计（做得对，保留）

main/paths.js 把模型/缓存/临时/Torch/HF/pip/matplotlib/numba 全部收进数据根，并通过 engineEnv() 注入（paths.js:349-391）——包括 TEMP/TMP/TMPDIR 重定向，这是很多项目漏掉的一步。数据根选择还有 data_root_last 回溯（paths.js:257-281），修的是"换安装位置后找不到旧数据"的真实事故。

### 9.2 C 盘仍占 763 MiB（P1）

| 子目录 | 体积 | 说明 |
|---|---:|---|
| wallpapers | **377 MiB** | 下载的视频壁纸存在 app.getPath('userData')/wallpapers（main/wallpaper.js:88），**绕过数据根** |
| Cache | 258 MiB | Chromium 网络缓存（main.js:115-118 只重定向了 disk-cache-dir） |
| fufumidi/fufumidi.sqlite | **61 MiB** | sql.js 全库（§9.3） |
| WebStorage / IndexedDB | 33 / 11 MiB | 曲库字节（设计如此，不能动） |
| GPUCache | 6 MiB | 可随 disk-cache-dir 一起重定向 |
| FuFumidiData | 10 MiB | **历史残留**：C 盘上还留着一份旧数据根（含 midi/），迁移后没有清理 |

处理建议：壁纸目录改到 Paths.cacheDir('wallpapers')（数据根），启动时迁移一次；GPUCache 建议仅加清理入口；C 盘残留的 FuFumidiData 在"确认新数据根可用且非空"后提示用户删除（不要自动删）。

### 9.3 sql.js：每次写都重写整库（P0）

main/db.js 的持久化模型是"**内存数据库 + 每次变更全库导出落盘**"：

    persist() → db.export()（WASM 复制整个库） → writeFileSync(dbPath)   // db.js:54-61

实测（真实 60.8 MiB 库，1,970 行 songs）：export() 8 ms + writeFileSync **380 ms**。而 settings:save（main/settings-ipc.js:44-58）会**同时**写 settings.json 与 db.kvSet('settings', ...) → 每次改一个设置项 = 一次 61 MiB 全量写 + 主线程 0.39 s 冻结。kvSet 还被 settings:load 的首次迁移调用（:40）。

三个叠加问题：
1. **写放大**：每次写 O(库大小)，SSD 磨损与 I/O 抖动；
2. **主线程阻塞**：writeFileSync 在 IPC handler 里同步；
3. **库体积里 99% 是死数据**：songs 表 1,970 行是历史写入，而 db:songs:* 通道**前端从不调用**（§11）。

**修法（按收益排序）**：
- P0-a：persist() 改为 debounce 合并（1.5 s）+ 退出时 flush（close() 已有队列，可复用）；立即把 380 ms 的阻塞降到"最多每 1.5 s 一次"。
- P0-b：DELETE FROM songs 后 VACUUM（或直接换成一个只存 kv 的小库），库从 61 MiB → <1 MiB，每次写回到毫秒级。
- P0-c（更彻底）：设置只存 settings.json，删掉 sql.js 依赖与 db:* 11 个通道（§11）——前提是确认没有云同步/历史迁移路径在读它（songsAll 已无调用方）。

### 9.4 settings 双写（P1）

settings 同时存在 settings.json（main/settings.js:88-102，同步读、原子写）与 sqlite kv（main/settings-ipc.js:29-41/53-55），读时以 sqlite 优先合并。这带来两个确定性代价：**每次保存 61 MiB 写**（§9.3）与**两份真相可能分叉**（json 写成功、sqlite 写失败时，下次读到的还是旧的 sqlite 值 —— 而 kvSet 的失败被 catch {} 吞掉，:54）。

### 9.5 迁移期的同步体积统计（P1）

main/paths.js:454-480 pendingMigration() 对每个待迁移目录调 dirSize(from)（:477），而 dirSize 是**同步递归 stat**（:405-420）。老用户升级（models 数万文件、数 GB）时，这一步发生在 await prepareDataRoot()（main.js:164）里、**窗口创建之前**，且同时会显示进度窗 —— 实测同类遍历 50k 文件约 3.9 s，冷盘更久。
**修法**：迁移前不需要精确总量，用"文件数 × 平均大小"或直接跳过 size；dirSizeAsync 已经存在（:425-445），直接复用。

### 9.6 storage 面板：3.9 s 主线程阻塞（P0）

main/storage.js:28-46 statTree 同步递归；:52-67 reportStorage 对 **10 个区域**顺序调用。本机实测（50,111 文件）= **3,878 ms**。storage:cleanup（:147-156）**先再跑一遍 reportStorage**（又 3.9 s），再 emptyDir —— emptyDir 里对每个子目录又调一次 statTree 再 rmSync（:107-109），即**三次遍历**。
**修法**：直接换成 paths.js 里已有的 dirSizeAsync（带 3 s 预算与 setImmediate 让出）；缓存 60 s；emptyDir 删掉预统计。

---

## 10. 打包与构建

### 10.1 六份 electron-builder 配置，副本已漂移（P1）

| 文件 | 用途 | 问题 |
|---|---|---|
| electron-builder.yml | 正式出包 | 事实源；files 有 53 条排除，注释记录了大量事故 |
| electron-builder.base.yml | 极简包 | **硬编码 E:/Midi/FuFumidi/resources/python**（:27-28）→ 换机器/CI 直接失效 |
| electron-builder.ci.yml | CI | 与 base 重复；无 electronLanguages 裁剪 |
| electron-builder.local-dir.yml | 本地 win-unpacked | **整份复制了 files 清单**，已与主配置漂移（见下） |
| electron-builder.unpacked.yml / .unpacked-nopython.yml | 测试 | extends 主配置（这两个是对的） |

漂移的具体证据（local-dir vs 主配置）：

| 项 | electron-builder.yml | electron-builder.local-dir.yml |
|---|---|---|
| 合成器资源路径 | renderer/dist/vendor/js-synth/**（:15） | renderer/vendor/jssynth/**（:31-32，**路径已不存在**） |
| netlify / deno / cloud-sync / test 排除 | 有（:48-54） | **无** |
| !*.log、!_* | 有（:68-69） | **无** |
| sql.js 16 个无用 dist 文件排除 | 有（:74-78） | **无** |
| electronLanguages 裁剪 | 4 种（:104-108） | 未配（注释说"默认保留全部"） |

后果：本地测试包会把 netlify/node_modules（注释记录过 17.4 MiB）、根目录日志、sql.js 的 23.4 MiB 变体都打进去 —— 也就是说**本地验证的体积与正式包不是同一个东西**。

**修法**：把 files / asarUnpack 抽到一个 build/files.json（或 JS 模块），6 份配置全部 require 它；base.yml 的资源路径改为相对路径 + 环境变量覆盖。

### 10.2 asar 排除清单的价值（保留）

electron-builder.yml:20-31、62-67、89-96 的注释记录了三类真实事故：release 目录被打进 asar 导致 200 MiB→2 GiB；gpu-package 导致 70 MiB→15 GiB；构建日志在打包期间增长导致 **asar 偏移错位、应用起不来**。这些注释比任何文档都有价值，建议原样保留并向"单一事实源"迁移。

### 10.3 裁剪脚本没进门禁（P0）

scripts/prune-python-bundle.cjs 的存在说明团队知道该删什么，但：
- package.json 的 scripts 里**没有任何入口**调用它（grep 无命中）；
- 当前产物里五类目标全在（§2.2），实测 296 MiB。
**修法**：scripts/bundle-python.js 末尾强制调用 prune（失败即构建失败），并在 CI 加一条断言：resources/python 下 .lib/.a 计数为 0，.pyc 体积低于阈值（若决定保留 pyc 则反过来只允许存在）。

### 10.4 CI 与发布（P1）

- .github/workflows/ci.yml 只跑：py_compile + import presets、test:ui、test:plugin、build.js full、asar 内容校验。**不跑** 611 个 pytest、也不跑 20 个 node 测试脚本里的 18 个（test:download/autosave/storage/taskcenter/…）。而这些恰恰覆盖的是后端最容易回归的部分。
- ci.yml 用 **Python 3.11**（:40），而发布运行时是 **3.12**（实测 python312.dll、probe 报 3.12.10）。ABI 相关的 bug（KIND_PY / fitsPython）在 CI 里永远暴露不出来。
- build.js（10 KiB）与 build-gpu-package.js（10 KiB）无单测、无 schema，属于"一改就靠人眼"的脚本。

---

## 11. 死代码清单（P1/P2）

| # | 位置 | 证据 | 建议 |
|---:|---|---|---|
| 1 | main/db.js 全文 + preload.js:385-396 的 11 个 db:* 通道 | 前端 db:* 调用 **0 次**（grep frontend/src）；主进程 11 个 handler；库 61 MiB 里 99% 是无人读的 songs 表 | 确认云同步不依赖后整块删除；至少先删 songs 表 + VACUUM |
| 2 | main.js:630-662 cpuFallbackWheels / resetBaseToCpu | resources/cpu-fallback **目录不存在**（仓库与发行物都没有），函数必走 return false；但**在此之前已删了 torch_directml / onnxruntime_gpu 目录**（:642-648）。且它找的 wheels 是 **cp311**（:632-633），而运行的是 **3.12** —— 即使补上目录也装不进去 | 删除该分支，或把 cp312 wheels 打进 resources/cpu-fallback 并加存在性/ABI 断言 |
| 3 | preload.js:98 pickSoundFont: null | 空占位，前端若 typeof 判断会误判"存在" | 删 |
| 4 | engine/music2midi.py:380 "demucs" | demucs 已从依赖清单移除（requirements-bundle.txt:6-8 明确写了不需要），probe 里永远 None | 从探测列表删掉，省一次必然失败的 import |
| 5 | main/paths.js 导出 legacyOf(:302)、migrationReport(:576)、clearLegacy(:583)、peekDir(:588)、userDataBase(:62)、discoveredRoots、hfCacheDir | 导出后无任何跨文件引用（bench/dead-exports.js），peekDir 仅内部使用 | 收窄导出面 |
| 6 | main/wallpaper-engine.js:201 导出 scanSync；main/gpu.js:169 导出 packAbi；main/storage.js:44-46 导出 statTree/pruneLogs/emptyDir | 同上（仅内部调用） | 收窄导出面 |
| 7 | engine/_render_cherry_pop.py、engine/_render_enemy.py | 一次性渲染实验脚本，两份彼此重复 32 个 10 行窗口；!_* 只排根目录，**它们会进包** | 移到 scripts/ 或删除 |
| 8 | engine/_kana.txt、_kana_all.txt、_rel_pytest.txt、_sf3test.txt、_sync_test.txt、._pt_sf3c/、._pt_sync/、._pt_sync2/、__pycache__/、.pytest_cache/ | 开发残留（后两者打包已排除，前几项会进包） | 删 |
| 9 | main/diffsinger-ms-catalog.js（2,041 行 / 87 KiB）在 main/diffsinger.js:793 顶层 require | 首次 require 1.53 ms；内容是从官方 API 抽取的静态清单 | 改 JSON + 懒加载 |
| 10 | frontend/src/bridge/tauri.js | 已被 electron-builder.yml:99 排除出包（不打包但仍在源码里维护） | 若 Tauri 路线已放弃则删除 |
| 11 | docs/plans/ 里的历史方案 | 与代码不同步的部分会误导（本次未逐条核对） | 加"已实施/已废弃"状态字段 |

另有 **34 个导出候选**无外部引用（scripts 与 tests 计入检索范围后仍为 0）：data-root-pick.js MAX_UP/samePath、download-source.js SOURCE_LABELS/CNB_WEB/CNB_RELEASES、feedback-format.js AREA_LABEL/slugify、hotkeys.js normalizeMap、omr.js exePath/VERSION、plugin-install.js MAX_DOWNLOAD_BYTES/MAX_UNPACKED_BYTES、project.js cacheDirFor、rvc.js catalogCacheFile/fileState/builtinCatalog、separate-common.js pickOutputDir、update_sign.js UPDATE_PUBKEY 等。

---

## 12. 重复逻辑清单（P1）

| # | 重复内容 | 位置 | 风险 |
|---:|---|---|---|
| 1 | 界面参数 → 引擎参数映射（3 份） | engine.js:237-242、task-queue.js:52-88、music2midi.py:563-618 | **已漂移 6 次**（注释自证），每次表现为"界面设了不生效" |
| 2 | "找 ffmpeg" | engine/audio_io.py:64-74（python）、main/update.js（JS）、main/wallpaper.js:70-76（python -c） | 三条路径三份实现，壁纸那条最贵（起进程） |
| 3 | "Python 解释器候选目录" | main.js:313-328、:362-380、:406-425 | 三套候选表，PY312 已无对应目录（§13） |
| 4 | 目录体积统计 | main/paths.js:405-420（同步）/ :425-445（异步）/ main/storage.js:28-46（同步，另一份） | 三份实现，热路径用的是最慢那份 |
| 5 | 空目录/清理 | storage.emptyDir(:99-118)、paths.dirSize、audio_io.sweep_stale_temp | 语义不同但都在做"递归删+统计" |
| 6 | 资源体积统计 | main/paths.js overview(:597-639) 与 main/storage.js reportStorage | 两套 API 给两个页面，结果可能不一致 |
| 7 | 引擎可用性判断 | engine/engine.py:90-167 与 engine/deps.py:29-51 REQUIRED 表 | 两份"哪些包算就绪"的清单，可能分叉 |
| 8 | 两份一次性渲染脚本 | engine/_render_cherry_pop.py、_render_enemy.py | 见 §11#7 |
| 9 | builder 配置 | 6 份 yml 的 files/extraResources | 见 §10.1 |

---

## 13. 兼容 / 失效分支（P1）

| # | 分支 | 位置 | 判定 |
|---:|---|---|---|
| 1 | Python 3.12 独立运行时（resources/python312 + .fufumidi-engine-ready） | main.js:356-405、electron-builder.yml:112-117 | **失效**：2026-10-18 起 3.12 直接顶替 resources/python，包里没有 python312（实测）；bundledPython312() 永远 null，rocm 切换逻辑（:409-415）成为死路 |
| 2 | CPU 回退 wheels | main.js:630-662 | **失效**（§11#2）且**有害**（先删后失败） |
| 3 | DirectML 相关清理 | main.js:644、main/gpu.js:7 | 保留合理（清理历史残留），但注释应标"仅清理旧安装" |
| 4 | demucs 探测 | engine/music2midi.py:380 | 失效（§11#4） |
| 5 | 旧 engine_separate.py 链路 | requirements-bundle.txt:6-8、engine/engine.py:321-327 | 已废弃，mode=separate 直接抛错引导；保留错误信息是对的 |
| 6 | pickSoundFont: null | preload.js:98 | 失效（§11#3） |
| 7 | frontend/src/bridge/tauri.js | 被 electron-builder.yml:99 排除 | 若不回 Tauri 则死 |
| 8 | score.js 的 cacheDirFor / rvc.js 的 catalogCacheFile | project.js / rvc.js:27 | 未见调用（§11 列表） |
| 9 | xpu 增强包 | main/gpu.js:9-12 注释自承"没有 Intel 显卡实机验证过" | 保留但应在 UI 显著标注（注释已要求） |
| 10 | utau_engine: 'legacy'（engine_utau.py 1,586 行） | main/settings.js:59-61 | 保留为回退；但 1,586 行代码只为回退，建议标注弃用计划 |

---

## 14. 日志与错误处理（P0）

### 14.1 线上零日志

- Paths.logDir() 建目录（main/paths.js:341），storage 面板把它列为可清理区域（main.js:196），但**全仓库仅这一处引用**（grep logDir( 命中 1 次 = 定义）。没有任何 fs.appendFile/createWriteStream 指向它。
- 主进程所有诊断走 console.log/warn/error（26 处直接调用 + 大量注释性输出）。Windows 打包版没有控制台，console.* 进 chromium 的日志文件（默认不开 --enable-logging）→ 等于丢失。
- 用户报障时唯一能拿的是 diag:export（engine/diag.py 打包文件），但**不含运行期日志**，因为根本没有。

**修法（半天工作量）**：main.js 启动时把 console.* 劫持到 <dataRoot>/logs/main-<date>.log（按天滚动 + 保留 5 份，storage.CATEGORY_META 已经写了 logs keepLatest: 5），并在 before-quit 里 flush；引擎侧已有 ###LOG 协议，worker 的日志顺手落同一目录。

### 14.2 错误吞噬的规模

| 范围 | 总数 | 静默 | 占比 |
|---|---:|---:|---:|
| main/ + main.js + preload.js 的 catch | 795 | **381** | 48% |
| engine/*.py 的 except | 487 | **130**（紧跟 pass） | 27% |

抽取几处**有实际后果**的：

| 位置 | 吞掉了什么 | 后果 |
|---|---|---|
| main/settings-ipc.js:54 | db.kvSet 失败 | json 与 sqlite 分叉，下次读到旧设置 |
| main/settings-ipc.js:30-38 | sqlite 读失败 | 静默回退 json（可接受），但**首次迁移**（:40）失败也无提示 |
| main/engine.js:188 | child.stderr.on('data', () => {}) | **worker 的 stderr 全丢** —— Python traceback 在这里，用户只看到"转录失败" |
| main/engine.js:325 | 会话 stderr 全丢 | 同上 |
| main/engine.js:167 | worker 日志解析异常 | 单行日志丢失（可接受） |
| main/fast-download.js:154-163 | abort 监听器异常 | 取消可能失效（低概率） |
| main/models.js:819 | ensureSepConfig 失败 | 分离前自愈失败无提示，用户下一步才看到"缺配置" |

**最小修法**：给 spawnEngine / ensureEngineWorker 的 stderr 加环形缓冲（最近 200 行），失败时附在 onError 的 message 里（或写日志文件）；把 381 处空 catch 中"可能影响状态"的那些（约 30 处，集中在 settings/db/paths/models）改成至少 console.warn 到日志文件。

---

## 15. 测试覆盖（P1）

| 层 | 规模 | 在 CI? | 在 npm test? |
|---|---|---|---|
| engine/tests（pytest） | **106 文件 / 611 个 test 函数** | ❌ | ❌（npm test 无 pytest 入口） |
| scripts/test-*.mjs（node --test） | 20 个 | 仅 test:ui / test:plugin | ✅ 18 个 |
| frontend/tests | 见前端审计 | ✅ test:ui | ✅ |
| e2e（scripts/e2e） | 有 runner，需 build:ui | ❌ | ❌ |

也就是说：**611 个 Python 用例（覆盖 audio_chain、auto_bpm、pause、diffsinger 会话、OMR fixture、质量基线）在 CI 里一次都没跑过**。而这批用例恰好是"引擎行为"的唯一护栏。
**修法**：CI 增加一步 python -m pytest engine/tests -x -q（3.12 运行时，pip 装 requirements-dev.txt），允许先只跑 -k "not slow and not gpu" 的子集；同时把 npm test 里那 18 个脚本按"是否可在无 GPU/无模型的环境跑"分档，把可跑的全部放进 CI。

另外：scripts/test-engine-omr.mjs、scripts/test-cancel-worker.mjs 这类"关键链路"测试没进 npm test 的聚合串（package.json 的 test 脚本列了 22 条，缺 test:cancel 与 test:omr）—— 建议补进或明确注释"手动跑"。

---

## 16. 风险清单（按严重度）

| ID | 严重度 | 风险 | 证据 | 触发条件 | 影响 |
|---|---|---|---|---|---|
| R1 | **P0** | 转录中退出应用 → worker Python 变孤儿，继续占 RAM/VRAM | main/engine.js:13/56/139/266；main.js:670-682 | 长音频转录时点退出 | 下次启动显存不足/风扇狂转；用户以为"关不掉" |
| R2 | **P0** | resetBaseToCpu() 先删 GPU 目录再因缺 wheels 失败（且 wheels 是 cp311 / 运行时 3.12） | main.js:630-636/637-661；resources/cpu-fallback 不存在 | 设置页卸载 GPU 增强包 | 引擎被拆成半残（删了 onnxruntime_gpu/torch_directml，没装回 CPU 版） |
| R3 | **P0** | 保存任意设置 = 61 MiB 全库重写 + 0.38 s 主线程冻结 | main/db.js:54-61、settings-ipc.js:53-55；实测 380 ms | 每次改设置/主题/语言/导出选项 | 界面卡顿、SSD 写放大、json/sqlite 分叉 |
| R4 | **P0** | storage:report 3.9 s 同步阻塞（cleanup 再翻倍） | main/storage.js:28-118；实测 3,878 ms/50k 文件 | 打开存储面板/清理 | 主进程冻结，窗口"未响应" |
| R5 | **P1** | 资源中心一进去起两个重 Python（probe 6.46 s + depCheck 4.70 s） | ViewResources.vue:565-569/476-479/549-551；实测 | 每次进入资源中心 | CPU 峰值、RSS 翻倍、低配机明显卡 |
| R6 | **P1** | worker 空闲 120 s 回收 → 冷启动 13.5 s 反复支付 | main/engine.js:20；实测 import 13.47 s | 用户隔 2 分钟转一首 | "为什么第二首更慢"的体验落差 |
| R7 | **P1** | 安装包 710 MiB / 安装 2,029 MiB，其中 461 MiB 可回收 | §2.1-2.3 | 每次下载/安装/更新 | 分发成本、更新耗时、用户流失 |
| R8 | **P1** | 6 份 builder 配置漂移，本地验证包 ≠ 正式包 | §10.1 | 本地打包验证 | "本地好的，发布挂了"或反之；体积回归发现不了 |
| R9 | **P1** | 参数表 3 份手工副本，已漂移 6 次 | §5.4 | 每次加参数 | 界面设了不生效（历史反复出现） |
| R10 | **P1** | 无持久日志；381 处空 catch；worker stderr 丢弃 | §14 | 线上任何异常 | 无法定位，只能复现 |
| R11 | **P1** | 611 个 pytest 不进 CI | §15 | 每次合并 | 引擎行为回归无人拦 |
| R12 | **P1** | 分段识别模式 RAM 101 MiB/10 min（float64） | engine/engine_basic.py:67 | 长音频 + 分段滑条 | 2 小时素材 1.2 GiB，低内存机 OOM |
| R13 | **P2** | 壁纸缩略图每张起一个 Python，且 Promise.all 并发 | main/wallpaper.js:62-84/103 | 导入多个视频壁纸 | 进程风暴 |
| R14 | **P2** | 下载进度单流路径无节流 → 每 chunk 一条 IPC | main/fast-download.js:597 + models.js:792-799 | 大文件走单流 | 渲染进程消息风暴 |
| R15 | **P2** | 多 worker = 多 CUDA context，槽位数不看显存 | main/engine.js:208-212 | GPU + 并行转录 | 显存先被 context 吃满（待实测） |
| R16 | **P2** | C 盘仍占 763 MiB（壁纸 377 + Cache 258 + sqlite 61） | §9.2 | 长期使用 | 与"不占 C 盘"的产品承诺不符 |
| R17 | **P2** | 暂停标记每秒一次同步 existsSync + mkdir | main/engine.js:102 + paths.js:325/333 | 转录期间 | 微小但持续的同步 I/O |

---

## 17. 分阶段重构方案

> 工作量按 1 名熟悉本仓库的工程师计（人日）；每阶段都有"可量化验收"，未达标不算完成。

### P0：先止血（3–5 人日，不改架构）

| # | 改动 | 文件 | 验收指标 |
|---:|---|---|---|
| 1 | worker 纳入 activeChildren + 退出调 stopEngineWorker() | main/engine.js:13/56/139、main.js:670 | 转录中退出后 3 s 内 tasklist 无 python；GPU 机器显存归零 |
| 2 | 删除/修复 resetBaseToCpu 分支 | main.js:630-662 | 卸载 GPU 包返回 restored:true，或该分支不存在 |
| 3 | persist() debounce 1.5 s + 退出 flush；清空 songs 表并 VACUUM | main/db.js:54-61 | 单次设置保存 <10 ms；库 <1 MiB |
| 4 | storage:report 换 dirSizeAsync + 60 s 缓存；emptyDir 去掉预统计 | main/storage.js:28-118、paths.js:425 | 面板首次渲染 <120 ms 返回，主线程无 >50 ms 长任务 |
| 5 | 日志落盘（console 劫持到 logDir，按天滚动保留 5 份） | main.js + 新 lib/log.js | <dataRoot>/logs/ 出现文件；diag:export 含最近日志 |
| 6 | worker stderr 环形缓冲，失败时附 200 行 | main/engine.js:188/325 | 人为让引擎抛异常，错误信息里能看到 traceback |

### P1：体积与请求路径（8–12 人日）

| # | 改动 | 文件 | 验收指标 |
|---:|---|---|---|
| 7 | prune 进构建门禁；先删 .lib/.a/include/ensurepip，保留 .pyc | scripts/bundle-python.js、prune-python-bundle.cjs | 安装包 −40–50 MiB；CI 断言 .lib 计数 0 |
| 8 | 依赖白名单化 + 删除 10 个未导入包，配端到端冒烟门禁（basic/muscriptor/piano/separate/OMR/翻唱/DiffSinger 各一条） | engine/requirements-bundle.txt、scripts/bundle-python.js | 安装包 −40–60 MiB；6 条冒烟全绿 |
| 9 | 探测缓存：engine:probe / dep:check 做 10 min TTL + single-flight；资源中心改为并发一次 | main/system-ipc.js、main/diagnostics.js | 第二次进资源中心 0 个 Python 进程；首屏可交互 −2~4 s |
| 10 | 单一 builder 事实源（files/asarUnpack 抽 build/files.json），base.yml 去绝对路径 | 6 份 yml | 本地包与正式包 files 差集为空 |
| 11 | 参数表单一来源（params.schema.json → 三处生成） | engine.js / task-queue.js / music2midi.py | 新增一个参数只改 1 个文件；E2E 断言参数穿透 |
| 12 | 进度事件统一节流（≥100 ms 或 ≥1%）；task:update 改增量 | fast-download.js:309、models.js:792、taskcenter.js:46 | 500 MiB 下载产生 <300 条 IPC；任务中心消息量降一个量级 |
| 13 | 音频解码优化：dtype='float32'；basic-pitch 二次解码去掉 | engine_basic.py:67/172、engine.py | 分段模式 RAM −50%；10 min 素材端到端 −1 s |
| 14 | 壁纸缩略图改用内置 ffmpeg（不再起 Python），并发 2 | main/wallpaper.js:62-103 | 10 张壁纸：0 个 python、峰值 <2 进程 |
| 15 | 壁纸目录迁进数据根（一次性迁移） | main/wallpaper.js:88、main/paths.js | C 盘 userData −377 MiB |
| 16 | CI 增跑 pytest（可先 -k "not gpu and not slow"）+ 18 个 node 测试；CI Python 对齐 3.12 | .github/workflows/ci.yml | 611 例中 ≥80% 在 CI 跑；Python 版本与发行版一致 |

### P2：引擎与并发结构（2–3 周）

| # | 改动 | 验收指标 |
|---:|---|---|
| 17 | JobRegistry 统一四本账（id → {child/session/task/cancel}） | 取消路径只剩 1 处；新增任务类型不改取消代码 |
| 18 | 全局重活信号量（转录/分离/翻唱/OMR 共享） | 并发 5 个任务时进程数 ≤ 上限；低配机无"未响应" |
| 19 | worker 空闲期 10 min + 预热（首帧后异步 spawn slot0） | 第二首转录固定开销 −10 s 量级 |
| 20 | GPU：PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True；槽位按显存决定 | 长音频 OOM 率下降（待实测）；并行转录不因 context OOM |
| 21 | muscriptor 模型缓存对 CPU 也生效 | CPU 用户每首 −2~3 s |
| 22 | empty_cache 改为"空闲/压力触发" | 连续 10 首短任务总耗时 −5~10%（待实测） |
| 23 | 常驻会话超时后强制重启 | 超时任务不再与新任务抢算力 |

### P3：长期（可选）

| # | 改动 | 收益 |
|---:|---|---|
| 24 | preload 按域拆分 + 单一 schema 生成 248 条类型 | 契约漂移归零；新能力三处同改变成一处 |
| 25 | worker 池按"模型亲和"分配（同模型复用槽位），RSS 稳定 | 多模型用户不再每进程留两份模型 |
| 26 | 迁移到 node:sqlite/better-sqlite3（真文件库 + WAL），替代 sql.js 全量导出 | 写入 O(1)；但需重写 db.js 并迁移 61 MiB 库（风险中） |
| 27 | 把 build.js / build-gpu-package.js 的不变部分声明化（schema 校验） | 打包事故减少 |

---

## 18. 量化优化点汇总

| 指标 | 现状（实测） | 目标 | 主要手段 | 置信度 |
|---|---:|---:|---|---|
| 安装包体积 | 710 MiB | **540–570 MiB**（−20~24%） | §2.2 三类回收（461 MiB 未压缩） | 高（体积可算），中（压缩后精确值需实测） |
| 安装后体积 | 2,029 MiB | **1,570–1,620 MiB** | 同上 | 高 |
| 单次设置保存卡顿 | **380 ms + 61 MiB 写** | <10 ms（合并写） | debounce + 清 songs | 高（实测） |
| 存储面板阻塞 | **3,878 ms** | <120 ms 首帧 + 后台 | dirSizeAsync + 缓存 | 高（实测） |
| 进入资源中心 | 2 个 Python（6.46 s + 4.70 s CPU） | 0 个（缓存命中） | TTL + single-flight | 高（实测） |
| 首次转录固定开销 | **13.47 s**（python+imports） | 6–8 s（预热后隐藏） | 首帧后预热 worker | 中（取决于磁盘） |
| 空闲回收后再转录 | 13.47 s 重付 | −10 s 量级 | idle 120 s → 10 min | 高 |
| 退出后残留进程 | 可能 1–4 个 python | 0 | 纳入 activeChildren | 高 |
| 分段模式 RAM | 101 MiB/10 min | **50 MiB/10 min** | dtype=float32 | 高（实测） |
| 2 小时素材常驻 | ~1.2 GiB（分段）/ 600 MiB（float32 数组） | 减半或流式 | dtype + 分块 | 中 |
| 下载 IPC 条数（500 MiB 单流） | ~8,000 条 | <300 条 | 节流 | 高（可算） |
| 任务中心消息 | 10 Hz × 全量（含日志） | 增量、≤2 KB/次 | delta 协议 | 高 |
| C 盘占用 | 763 MiB | **~370 MiB** | 壁纸迁移 | 高（实测） |
| 壁纸缩略图进程 | N 个 python 并发 | 0 | 直接调 ffmpeg | 高 |
| 每任务 empty_cache | 每任务 1 次 | 空闲/压力触发 | 改调用时机 | 中（待实测） |
| 长音频 OOM 率 | 未知 | 下降 | expandable_segments + 槽位按显存 | 待实测（本机无 CUDA） |

---

## 19. 附录：可复现测量脚本

全部脚本在仓库外，未修改任何源码：

| 脚本 | 作用 | 关键输出 |
|---|---|---|
| E:\Midi\_attic\audit\bench\require-main.js | 用 electron 桩度量 main/*.js 逐个 require 耗时 | 60.3 ms / 53 模块，top: dawproject 11.58 |
| bench\sz.js | 不跟随 symlink 的确定性体积/文件数统计 | 1,484 MiB / 31,629（python） |
| bench\prunecheck.ps1 | 统计 .pyc/.lib/.a/include 残留 | .pyc 251.9 MiB / 13,664；.lib 44.1 MiB / 173 |
| bench\imp.py / imp2.py | 用内置 3.12 运行时度量 import 成本 | torch 6.89 s、scipy 5.26 s、合计 13.47 s |
| bench\libr.py | 验证 librosa 各调用是否拉 numba | resample 2.24 s（拉 numba+llvmlite+resampy） |
| bench\block.py / smoke.py | 阻断 10 个未导入包后跑完整转录 | 39 模块导入 0 失败；transcribe 成功出 1 音符，0 命中 |
| bench\decode.py | decode_to_wav / float32 / float64 对比 | 1.00 s、50 MiB、101 MiB（10 min） |
| bench\sqlbench.js | sql.js 加载/导出/落盘计时 | export 8 ms、writeFileSync 380 ms（60.8 MiB） |
| bench\stattree.js | 按 storage.js 算法重现报表 | 3,878 ms / 50,111 文件 |
| bench\catch2.js | 空 catch / except pass 计数 | main 381/795；engine 130/487 |
| bench\dead-exports.js | 导出名在全仓零引用 | 34 个 |
| bench\readdir.js | engineEnv 里两次 readdir 的成本 | 0.1 ms 量级（据此判定为微优化，非热点） |

复现命令示例：

    # 引擎 import 成本（内置运行时）
    "E:/Midi/FuFumidi-Source/release/win-unpacked/resources/python/python.exe" "E:/Midi/_attic/audit/bench/imp.py"

    # 探测延迟（等价于 engine:probe）
    cd E:/Midi/FuFumidi-Source/engine && time "…/python.exe" music2midi.py probe

    # 依赖检查（等价于 dep:check）
    time "…/python.exe" deps.py check

    # IPC 通道双向差集
    grep -o "ipcRenderer.invoke('[^']*'" preload.js | sed "s/.*invoke('//;s/'//" | sort -u > inv.txt
    grep -rho "ipcMain\.handle(['\"][^'\"]*" main main.js | sed "s/.*handle(['\"]//" | sort -u > hand.txt
    comm -23 inv.txt hand.txt; comm -13 inv.txt hand.txt

---

## 20. 未覆盖 / 待实测

本次为**只读 + 离线度量**，以下结论需要跑起来才能定论（按优先级）：

| # | 待测项 | 方法 | 预期判据 |
|---:|---|---|---|
| 1 | 真机冷启动到可交互（首帧） | --enable-logging + 主进程加时间戳；或 e2e runner 记录 ready-to-show → did-finish-load | <2.5 s（SSD） |
| 2 | probe/depCheck 缓存后的资源中心内存峰值 | Process Explorer 看 python 进程峰值 RSS | 从 2 个进程降到 0 |
| 3 | 多 worker CUDA context 显存开销 | RTX 机器上 1/2/3 路并行转录，读 nvidia-smi 与 torch.cuda.memory_reserved() | 每路 +200~400 MiB（估） |
| 4 | expandable_segments 对长音频 OOM 的影响 | 30 min+ 素材，开/关各 10 次 | OOM 率下降或不变 |
| 5 | empty_cache 改时机后的连续短任务总耗时 | 10 首 30 s 素材 | −5~10% |
| 6 | 删包后的 6 条端到端链路（basic / muscriptor / piano / separate / OMR / 翻唱） | 按 §2.3 的阻断脚本思路，先删后跑 | 全绿才允许进构建 |
| 7 | 正式包体积（删 461 MiB 后） | npm run dist:win 实测 | 540–570 MiB |
| 8 | .pyc 删除对只读安装目录首启的影响 | 装到 Program Files 后冷启动 3 次取中位数 | 若 +>1 s 则保留 .pyc |
| 9 | 托盘隐藏后的 CPU/GPU 占用 | 隐藏 5 min，对比 backgroundThrottling 开/关 | 关闭后 <1% GPU |
| 10 | 退出时 worker 是否真的变孤儿（现状） | 转录 10 min 素材中途退出，tasklist /fi "imagename eq python.exe" | 现状应能看到残留（用于确认 R1） |

---

## 21. 一句话结论

**这套后端的"工程习惯"（下载单入口、任务中心、排除清单注释、611 个 pytest、248 通道零漂移）比大多数同类项目好；真正的短板是三件具体的事没有接到热路径上——裁剪脚本没进门禁、Python 探测每次重起进程、同步大活在 IPC handler 里跑——以及一个必须马上修的结构缺陷：worker 进程不在退出清理的账本里。**

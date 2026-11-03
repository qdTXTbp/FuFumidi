# 01 · 性能 / 体积 / 启动现状证据（Rust 重写前置调研）

- 采集时间：2026-11-03
- 仓库：`E:\Midi\FuFumidi-Source`，分支 `feat/audio-tagger-auto-probe`，HEAD `99cbe75`（2026-11-01 15:19 +0800），`package.json` version **6.4.2**
- 上一次同类审计：`docs/audit/2026-10-29/`，快照 commit `a13c51a`（version 6.2.9，Electron 33.4.11）。**本文按 HEAD 逐项复核，标注哪些数字已过期。**
- 实测机器：win32 10.0.26200 · 32 核 · 61.7 GB · NVIDIA 12,227 MiB 显存但内置 torch 为 CPU 版（`torch 2.14.1+cpu`，`torch.cuda.is_available()=False`）；数据根已装 GPU 增强包 4.7 GiB。
- 方法：只读源码 + 只读度量。体积用不跟随符号链接的递归 lstat；时间和 import 成本用独立进程实测；**未启动 GUI / 未安装 / 未改任何仓库文件**。度量脚本写在仓库外 `E:/Midi/_attic/audit/rust-bench/`（sz.cjs / metrics.cjs / sqlbench.cjs / imp.py / pytime.cjs / bundles.cjs）。
- 标注约定：**【实测】**本次命令跑出来的数字；**【审计实测】**来自 `docs/audit/2026-10-29`（6.2.9 时点）；**【推断】**从代码/结构推出、未跑；**【待实测】**需要 GUI 或 GPU 才能定论。

---

## 0. 结论速览

1. **体积结论已整体过期，且方向是变好。** 安装包 6.2.9 = 711.7 MiB → 6.4.2 = **606.3 MiB**（−14.8%）；安装目录 2,029 → **1,691.5 MiB**（−16.6%）；`resources/python` 1,484 → **1,099 MiB**（−26%，文件数 31,629 → 15,014）。原因可定位：`scripts/bundle-python.js:168` 已在构建里调用 `prune-python-bundle.cjs`，并新增 `scripts/prune-python-unused.cjs`（2026-10-30）。审计当时“裁剪没进门禁”的判断**在 HEAD 已不成立**。
2. **用户可感知的时间成本几乎全在 Python 一侧，分两类：** (a) 固定开销——解释器+import **10.65 s**【实测】、`probe` **6.07 s**【实测】、`deps check` **5.50 s**【实测】；(b) 模型前向——120.5 分钟音频 CPU **8,880.6 s**、GPU **2,053.3 s**【审计实测，见 2026-10-13 记录】。Rust 能打掉 (a)，打不掉 (b)。
3. **主进程三处“同步大活”只修了一半：** `storage:report` 已改异步（`main/storage.js:48-63`），但**每次仍全量遍历**——同规模 62,453 文件实测 **5.78 s**；`db.persist()` 仍是每次写全库 60.7 MiB（实测 export 11 ms + 落盘 63 ms = **74 ms**）；并且 `close()` 引用了三个**从未声明**的变量（`main/db.js:201-203`），退出冲刷实际从未执行。
4. **前端性能基线全部是旧值：** 820 ms / cold p95 412 ms / 60k 编辑 529 ms / 帧 p95 3.4 ms 记录于 2026-10-17（app 6.2.0、Electron 33），而 HEAD 已升 Electron 37（`0338770`）、加了大工程 LOD（`f62f6b0`）、改了启动可见时序（`4a02736`）。且 `perf:gate` 只在 `package.json:57`，**没进 CI**。
5. **最贵的一次“点击”不是启动、不是体积，而是进资源中心：** `ViewResources.vue:565-570` 的 onMounted 并发触发 `depCheck`（`main/diagnostics.js:8`）与 `probe`（`main/system-ipc.js:9-22`），两个 Python 各导入一遍 torch → **11.6 s 的 CPU**，且无任何缓存。这一项用 Rust 原生探测 + 缓存可以在**同一版 Electron 内**降到 <100 ms。
6. **体积的绝对值已被“模型运行时下载”改写：** 安装包 606 MiB，但数据根 **32,738 MiB / 62,453 文件**（models 21,121、gpu-enhancements 4,737、soundfonts 2,674、diffsinger-voicebanks 2,407、omr 1,369 MiB）【实测】。Rust 重写对“首装体积”是边际收益（推断 <100 MiB），对“总占用”基本为零。

---

## 1. 基线与口径

| 项 | 值 | 来源 |
|---|---|---|
| HEAD / 版本 | `99cbe75` / 6.4.2 | `git log -1`【实测】 |
| Electron | 37.10.3 | `package.json` `"electron": "^37.10.3"`；打包产物 `resources/app.asar` 内同为 37.10.3【实测】 |
| Python | 3.12.10（内置运行时） | `python -c "import sys;print(sys.version)"`【实测】 |
| 生产依赖 | 4 个（adm-zip / sql.js / webwallgl / yauzl） | `package.json`【实测】 |
| 审计快照 | `a13c51a` = release 6.2.9；审计文档写的 Electron 33.4.11 | `docs/audit/2026-10-29/backend-perf.md:3` |

**两套数字不能混用：** 审计里的“2,029 MiB / 710 MiB / python 1,484 MiB / 空 catch 381/795”是 6.2.9 的事实；HEAD 已发生 6.3.0–6.4.2 共 60+ 次提交，含裁剪进门禁、异步 storage、停止 worker、清空 catch 等。本文给出对照表（§2.7）。

---

## 2. 基线表

### 2.1 体积与安装

| 项 | HEAD 实测（2026-11-03） | 6.2.9 审计值 | 结论 |
|---|---:|---:|---|
| 安装包 `FuFumidi Setup 6.4.2.exe` | **606.3 MiB**（635,789,305 B） | 711.7 MiB（6.2.9） | −105.4 MiB（−14.8%），裁剪生效 |
| 安装目录 `release/win-unpacked` | **1,691.5 MiB** / 15,362 文件 | 2,029 MiB / 31,975 | −337 MiB，文件数腰斩 |
| └ `resources` | **1,406.3 MiB** / 15,338 文件 | 1,791 MiB | — |
| └ `resources/python` | **1,099.0 MiB** / 15,014 文件 | 1,484 MiB / 31,629 | **−385 MiB（−26%）** |
| └ `resources/models`（内置只读） | **211.7 MiB** / 9 项（piano_transcription 164） | 212 MiB | 持平 |
| └ `app.asar` | **28.7 MiB**（`renderer/dist` 15.9 MiB） | 28 / 40 MiB | 持平 |
| `FuFumidi.exe` | **195.2 MiB**（未剥离） | 181 MiB | +14 MiB（Electron 37） |
| `resources/g2p` | 24.2 MiB / 13 zip | 24 MiB | 持平 |
| `resources/rust-core` | 0.3 MiB / 1 文件 | — | 已有 Rust 辅助二进制（sha256/manifest + MIDI 统计，`rust-core/src/main.rs` 572 行） |
| python 内 `.pyc` | **1,290 个 / 24.1 MiB** | 13,664 个 / 251.9 MiB | 裁剪脚本确实跑过了 |
| python 内 `.lib` / `.a` | **0** | 173 个 / 44.1 MiB | 已清 |
| python 文件数 | **15,207** | 31,629 | — |

python `site-packages` 前 10 大（HEAD，MiB，【实测】）：torch **382.9**、llvmlite **115.1**、imageio_ffmpeg **83.6**、scipy **66.7**、av.libs **64.1**、transkun **54.0**、transformers **49.7**、onnxruntime **41.7**、numpy.libs 20.2、scipy.libs 19.3。**这 8 项合计 868 MiB，占 python 总体的 79%。** 审计 §2.1 的结论（torch 最大、transformers 引擎不导入）在 HEAD 仍成立——`transformers` 49.7 MiB 仍是最大的“疑似可删未删”项（审计 §2.3 用阻断导入法验证过引擎不 import 它）。

安装包历史（【实测】`release/*.exe` 逐个 stat）：

| 版本 | 6.1.6–6.2.1 | 6.2.7 | 6.2.8 | **6.2.9** | 6.3.0 | 6.3.1 | **6.4.2** |
|---|---:|---:|---:|---:|---:|---:|---:|
| 安装包 MiB | 695.0 | 709.6 | 709.6 | 711.7 | **595.3** | 606.4 | **606.3** |

> 6.3.0 一次性掉 116.4 MiB = 裁剪进门禁 + 删未用包；6.3.1 之后回涨 11 MiB（新增依赖/资源）。**【推断】** 再往下压的空间已经不大：如果只动 python，理论下限 ≈ 1,099 − 115(llvmlite 若真能去) − 50(transformers) − 54(transkun 若改按需下载) ≈ 880 MiB，对应安装包约 500–530 MiB。

### 2.2 启动与交互（渲染进程）

来源：`docs/perf-baseline.json`（`updatedAt: 2026-10-17T18:42`，对应提交 `d93b658` “6.2.0”）、`scripts/perf-baseline.mjs`（口径定义）。

| 指标 | 记录值 | 口径 | HEAD 是否仍成立 |
|---|---:|---|---|
| 启动到可交互 | **820 ms** | `launchApp` 拉起进程 → `window.__fufumidiE2E` 可用（比“用户能点”更早） | **待实测**：6.4.2 主窗口要等渲染层 `app:renderer-ready` 才 show（`main/window.js:61-74`，15 s 兜底），口径与感知都变了 |
| 视图切换 cold p95 | **412 ms** | 4 个视图首次进入，含路由懒加载分包；最贵 `#/resources` 412 ms | **待实测**（Electron 37 + 新增视图代码） |
| 视图切换 warm p95 | **183 ms** | 二次进入；最贵 `#/music` 183 ms | 待实测 |
| 60k 音符首次进编辑页 | **529 ms** | `#/edit` → canvas 出现 | **待实测**；6.3.x 加了“大工程 LOD”（`f62f6b0`），预期应下降 |
| 播放帧间隔 p95 | **3.4 ms**（p50 3.3，180 帧） | 60k 曲目播放时 rAF 间隔 | 待实测；原口径下已远优于 16.7 ms，**不构成成本** |
| JS 堆增长 | 10.5 → 44.7 MB（**+325.7%**） | 首屏 → 载入 60k | 待实测；60k ≈ +34 MB 属正常量级 |
| 启动后自动更新检查 | 首屏后 2.5 s 触发，超时 12 s | `App.vue` 侧；审计 §3.3 | 仍成立（推断，代码未变） |
| 托盘隐藏后仍满帧 | `backgroundThrottling: false` | `main/window.js:41` | 仍成立【代码】 |

**关键缺口：** `package.json:56-57` 有 `perf:baseline` / `perf:gate`，但 `.github/workflows/ci.yml` 里 grep `perf` = 0 命中【实测】。即“性能基线”没有任何自动门禁，数字自 2026-10-17 起无人重记。

### 2.3 引擎固定开销（Python）

| 项 | HEAD 实测 | 6.2.9 审计 | 备注 |
|---|---:|---:|---|
| 解释器空启动 `python -c pass` | **196 / 49 / 43 ms**（3 次，首次冷） | — | 冷页缓存下约 45 ms 起 |
| import numpy / scipy / torch | **1.07 / 0.23 / 9.03 s** | torch 6.89 / scipy 5.26（冷页缓存） | **口径不同不可相减**：本次为温页缓存、且只 import 单模块 |
| 上述 8 个包合计（含 librosa/onnxruntime/soundfile/mido/basic_pitch） | **10.65 s**，1,203 模块 | “全栈 import 13.47 s / 1,846 模块” | 审计口径是“导入 39 个 engine 模块”；HEAD 实际更轻，但仍 >10 s |
| `music2midi.py probe`（等价 `engine:probe`） | **6,068 ms** | 6.46 s | 持平，GPU 探测 + 8 个 import |
| `deps.py check`（等价 `dep:check`） | **5,503 ms** | 4.70 s | **变慢 0.8 s**：HEAD 有 6 个依赖组（universal/piano/separate/muscriptor/aria/transkun），每组都真 import |
| 内置 torch | 2.14.1+cpu，onnxruntime 1.31.0 | 同 | 开箱即 CPU；GPU 需另装 4.7 GiB 增强包 |
| worker 空闲回收 | **120,000 ms**（`main/engine.js:20`） | 120 s | 仍成立 → 隔两分钟再转一首要重付 10.65 s |
| 低内存降级 | ≤8.6 GB 内存强制 1 路（`main/engine.js:229`） | 无 | 新增 |

**触发路径（HEAD 代码事实）**

- 进资源中心：`frontend/src/views/ViewResources.vue:565-570` onMounted → `refreshModels()`（`:476-479` 调 `depCheck`）+ `loadGpu()`（`:549-551` 调 `probe`），另有 10 个 `load*` 一起发。**无缓存、无 single-flight**：`main/system-ipc.js:9-22` 每次 `spawnEngine(['probe'])`，`main/diagnostics.js:8` 每次起 `deps.py check`。
- 进转录页：`ViewTranscribe.vue` 一进页面即 `probe`（审计 §3.3 的 :1168）。
- 首次转录：worker 冷启动 → 10.65 s import 之后才开始推理；空闲 120 s 后重付。

### 2.4 推理吞吐（模型侧，决定上限）

| 场景 | 实测 | 来源 |
|---|---:|---|
| 120.5 分钟音频 / 1,447 块 · **CPU**（torch 2.14.1+cpu） | **8,880.6 s = 148.0 min**（1.23× 实时，6.14 s/块） | `docs/plans/2026-10-12-transcribe-options-and-speed.md` §7.5 |
| 同一素材 · **GPU**（RTX 5070 Ti / torch 2.9.1+cu128） | **2,053.3 s = 34.2 min**（0.29× 实时，1.42 s/块，**4.3×**） | 同上 §7.6 |
| token 回放（不跑模型，只解码） | **19.5 s**（推理 5.8 s，456×） | 同上 §7.5 |
| CPU 模型缓存策略 | 仅 CUDA 才缓存；CPU 每首重付 2–3 s | `engine/engine_muscriptor.py:720-730`（审计 §6.4） |
| 性能档语义 | `quality=0 / balanced=4 / fast=2` 线程上限 → “低配省资源”比 quality **更慢** | `engine/engine_perf.py:29-34` 注释自证 |
| 模型体积（运行时下载，不入安装包） | MIROS 5.0 GB、muscriptor 1.2 GB / 5.2 GB | `main/models.js:82/100/144/159` |

**推论（这三条决定了 Rust 重写的上限）：**

- 转录耗时 = 模型前向（>95%）+ 解码/预处理（<5%）。Rust 只能碰后者；把解码从 5.8 s 压到 1 s，对 120 分钟素材的整体收益是 **0.08%**。
- 真正的 4.3× 来自 GPU 包，不是语言。**“Rust 让转录更快”是伪命题**（见 §6）。
- CPU 用户的 148 min 是“没有 CUDA 运行时”的直接后果；换成 Rust 也不会有 GPU。

### 2.5 主进程同步 IO / 数据根

| 项 | HEAD 实测 | 6.2.9 审计 | 状态 |
|---|---:|---:|---|
| sql.js 库文件 | **60.7 MiB**（63,610,880 B），songs **1,972 行**，kv **4 行**（settings 值 1,477 B），playlists 0 | 60.8 MiB / 1,970 行 | 库几乎全是死数据 |
| 每次写的代价 | export **11 ms** + `writeFileSync` **63 ms** = **74 ms** | export 8 + write **380 ms** = 388 ms | 绝对值变好（SSD/缓存），**O(库大小) 的写放大结构没变**：`main/db.js:54-61` 每次 persist 全量导出 |
| persist 触发 | 每次 kvSet/songPut/…（`main/db.js:74-85`；settings 保存走 `main/settings-ipc.js:53-55`） | 同 | **无 debounce** |
| `close()` 退出冲刷 | **坏**：`main/db.js:201-203` 引用 `persistTimer` / `persistPromise` / `persistNow`，全文件**无声明**（grep 仅这 3 处）→ ReferenceError 被 `main.js:681` 的 try/catch 吞掉 | 曾建议加队列 | **HEAD 新发现的缺陷**；f852109 的 “debounce DB persist” 只加了 close 的调用没加实现 |
| storage:report | 异步化（`main/storage.js:48-63`），但**全量遍历**：同规模 62,453 文件实测 **5,779 ms**（本机 lstat 递归） | 3,878 ms 同步 / 50,111 文件 | 不阻塞 UI 了，**时间还在**；且 `storage:cleanup` 先再跑一遍 report（`:164-172`）、`emptyDir` 再 stat 一遍（`:116-135`）= 3 次遍历 |
| 数据根总占用 | **32,738 MiB / 62,453 文件**（walk 5.78 s） | 31.8 GiB | 持平 |
| └ models / gpu / soundfonts / diffsinger / omr | 21,121 / 4,737 / 2,674 / 2,407 / 1,369 MiB | — | 模型已是体积主体 |
| C 盘 userData | **892.6 MiB / 1,629 文件**（DB 60.7 + wallpapers + Cache） | 763 MiB | 仍与“不占 C 盘”承诺有差 |
| 文件日志 | `<dataRoot>/logs/main.log` 78 KB 存在 | 审计称“零日志” | **已修**（`32ad10c`） |
| 空 catch | main+preload **1,191 catch / 29 空**（2.4%） | 795 / **381（48%）** | **已修**（`dfe58c3`）；代价是 catch 总数 +50%（每个空 catch 变成“log.write + 内层空 catch”） |

### 2.6 代码规模 / IPC / 质量面

| 项 | HEAD 实测 | 6.2.9 审计 | 变化 |
|---|---:|---:|---|
| `main/` + `main.js` + `preload.js` | **58 文件 / 19,063 行** | 55 / 18,702 | +361 行（错误处理补日志带来的膨胀为主） |
| `frontend/src` | **181 文件 / 78,563 行**（23 个 view） | 180 文件；views 33,740 行 | 基本持平 |
| `engine` 顶层 `.py` | **71 文件 / 25,416 行** | 69 / 25,009 | +407 行 |
| `engine` 全部 `.py`（含 tests） | **333 文件 / 92,495 行** | 87,446 行 | +5,049 行 |
| `scripts/` | 135 文件 / 13,934 行 | — | — |
| `rust-core/src` | **1 文件 / 572 行**（sha256 清单 + MIDI 统计 CLI，`sha2` 唯一依赖） | — | 已有 Rust，但只是工具级 |
| `src-tauri/src` | **17 文件 / 3,681 行**（Tauri 2 原型，`Cargo.toml` version 3.1.8） | — | 已有 Tauri 原型，非生产路径（由 task-4 深挖） |
| IPC 通道 | preload **255** 次 invoke / **250** 唯一；主进程 handler **250** 唯一；**双向差集 0** | 248 | +2 通道，零漂移仍保持 |
| engine `except` | **659 处 / 153 处紧跟 pass**（225 个非测试 .py） | 487 / 130 | 涨，但属于新增引擎（aria/transkun/miros/yourmt3） |
| 生产依赖 | 4 个 | 4 个 | 持平 |

### 2.7 审计数字过期对照表（6.2.9 → HEAD 6.4.2）

| 审计结论 | 6.2.9 值 | HEAD 状态 | 依据 |
|---|---|---|---|
| 安装包 710 MiB | 709.6 | **606.3 MiB**，已过期 | `release/FuFumidi Setup 6.4.2.exe`【实测】 |
| 安装目录 2,029 MiB | 2,029 | **1,691.5 MiB**，已过期 | lstat【实测】 |
| python 1,484 MiB / 31,629 文件 | 1,484 | **1,099 MiB / 15,014**，已过期 | lstat【实测】 |
| .pyc 251.9 MiB / .lib 44.1 MiB 仍在 | 有 | **已清**（.pyc 24.1 MiB / .lib 0） | 【实测】 |
| 裁剪脚本没进门禁 | 是 | **已进门禁** `scripts/bundle-python.js:168` | 【实测】 |
| storage:report 3,878 ms 同步阻塞 | 是 | 异步化，但遍历 5.78 s 仍在 | `main/storage.js:48`；【实测】 |
| 保存设置 380 ms + 61 MiB 写 | 是 | **74 ms**（本机），O(库) 结构仍在，close 坏了 | 【实测】`main/db.js` |
| worker 退出成孤儿 | 是 | **已修**：worker 加入 activeChildren（`main/engine.js:144`），killAll（`:301`） | 【代码】 |
| 空 catch 381/795（48%） | 是 | **29/1,191（2.4%）** | 【实测】 |
| 零日志 | 是 | **已修**（logs/main.log） | 【实测】 |
| probe 6.46 s / deps 4.70 s | 是 | probe 6.07 s / deps **5.50 s**（分组变多） | 【实测】 |
| Electron 33.4.11 | 是 | **37.10.3** | `package.json`【实测】 |
| IPC 248 通道 | 是 | 250 | 【实测】 |
| 60k 编辑 529 ms / 启动 820 ms | 6.2.0 基线 | **未知，需重测** | `docs/perf-baseline.json` 2026-10-17 |

---

## 3. 成本中心排行 Top 10

排序公式：**单次可感知秒数 × 每会话触发次数 ≈ 每会话累计秒**。频次为【推断】（依据用户工作流与代码触发路径），秒数凡标【实测】【审计实测】者为硬数字。

| # | 现象 | 根因（文件:行） | 单次成本 | 频次/会话 | 累计 ≈ | 性质 |
|---:|---|---|---:|---|---:|---|
| 1 | 转录本身慢（长音频几十分钟） | 模型前向；`engine_muscriptor.py` 分块推理 | 34.2 min（GPU）/148 min（CPU）/120 min 素材【审计实测】 | 1–5 | **2,000–9,000 s** | 模型受限 |
| 2 | 首次转录前干等 | Python 冷启动 + import 10.65 s【实测】；空闲 120 s 再付（`main/engine.js:20`） | 10.65 s | 1–3 | 10–32 s | 运行时固定成本 |
| 3 | 进资源中心卡一下 | onMounted 并发 probe(6.07 s)+depCheck(5.50 s)，无缓存（`ViewResources.vue:565-570`、`system-ipc.js:9`、`diagnostics.js:8`） | **11.6 s CPU**（两进程并发，墙钟约 8–12 s） | 1–3 | 12–35 s | 运行时固定成本 |
| 4 | 打开存储面板/清理 | 全量遍历 5.78 s【实测】；cleanup 3 次遍历（`storage.js:164/116`） | 5.8 s（cleanup 约 17 s） | 1–2 | 6–29 s | 算法+运行时 |
| 5 | 改设置“点一下卡一下” | 每次 persist 全库 60.7 MiB 导出+写 74 ms【实测】（`db.js:54-61`） | 0.074 s | 10–50 | 0.7–3.7 s | 结构缺陷（可原地修） |
| 6 | 启动到能用 | Electron 启动 + 主进程 require 60 ms（审计）+ 首屏重 IPC；splash 只遮挡感知（`window.js:61-74`） | 0.8 s（旧基线） | 1 | 0.8 s | 框架固定成本 |
| 7 | 视图切换顿一下 | 路由懒加载 + 重视图挂载；12 个重视图常驻（`App.vue:803-809` + 分组 KeepAlive） | cold p95 412 ms（旧基线） | 10–30 | 4–12 s | UI/渲染 |
| 8 | 大工程打开编辑页 | 60k 音符装载 + 画布首绘（旧基线 529 ms，LOD 后待实测） | 0.53 s | 2–5 | 1–2.7 s | UI/渲染 |
| 9 | 每首歌都要重载模型（CPU 用户） | `engine_muscriptor.py:720-730` 只在 CUDA 下缓存 | 2–3 s | 1–5 | 2–15 s | 可原地修 |
| 10 | 导入多个视频壁纸时进程风暴 | 每张缩略图起一个 Python（`main/wallpaper.js:62-84`），`Promise.all` 并发（`:103`） | 0.3–1 s/张 + N 进程 | 0–1 | 0.3–10 s | 可原地修 |

**未进 Top 10 但值得记的“隐形税”：** 引擎日志逐行 IPC（`main/engine.js` 每行一条 `engine:log`）、`task:update` 10 Hz 全量任务表（`main/taskcenter.js:18-53`）、下载单流每 chunk 一条 `model:progress`（`main/models.js:792-799`）。它们不直接表现为“等几秒”，但会在长任务期间持续占用主进程与渲染进程。

**Top 1 的注脚（这是本报告最重要的一条）：** 转录耗时与语言无关。把 120.5 分钟素材从 148 min 压到 34.6 min 的是 GPU 增强包（4.3×），不是代码语言；Rust 重写能覆盖的只有解码/预处理段的 5.8 s（占 0.28%）。

---

## 4. 分类矩阵（A/B/C/D）

- **A = 只能靠换语言/运行时（Rust）解决**：成本写在该语言的执行模型里（解释器 import、JS 单线程/GC、WASM 全量复制、无并发遍历）。
- **B = 原地就能修**：异步/去抖/懒加载/缓存/算法/常驻进程，改动量天级，不需要换语言。
- **C = 受模型推理限制**：换语言不变，只有换设备（GPU）、换模型、换精度有用。
- **D = 受 UI/浏览器渲染限制**：Chromium 布局/绘制/合成、Vue 挂载、WebGL/Canvas 本身是瓶颈，Rust 进不来（进得来也要跨进程）。

| 成本中心 | 归属 | 理由 | 备注/证据 |
|---|---|---|---|
| Python import 10.65 s、probe 6.07 s、depCheck 5.50 s | **A（部分 B）** | 解释器 + CPython 模块系统 + torch 的 `.pyd` 加载是运行时固有成本；Rust 原生探测可 <100 ms。但“每次都重跑”是 B（缓存/常驻） | 实测三组数字；`deps.py` 6 组真 import |
| 模型前向 34.2/148 min | **C** | 纯 GPU/CPU 算力 + 模型结构。Rust 重写解码器对总时长影响 <1% | 4.3× 来自 CUDA 包；token 回放 19.5 s 证明解码占比小 |
| 每首重载模型 2–3 s（CPU） | **B** | 一行条件判断的事：CPU 也缓存 | `engine_muscriptor.py:720-730` |
| storage 遍历 5.78 s | **A（主）+ B（辅）** | 62,453 次 stat 的 IO+syscall 成本，Rust + 并行 + 增量索引能到亚秒；但“缓存 60 s + 异步”（B）就足够让用户不痛 | `main/storage.js:48-63` |
| sql.js 全库导出写 74 ms（O(库)） | **B** | 换 `node:sqlite`（Electron 内置）或 better-sqlite3 + WAL，写入 O(1)；不需要 Rust | `main/db.js:54-61`；库 60.7 MiB 里 99.9% 是死 songs 表 |
| 设置保存卡顿 | **B** | debounce 1.5 s + 退出 flush（且先修 `close()` 的 ReferenceError） | `main/db.js:201-203` |
| 启动 820 ms 量级 | **D + B** | Electron/Chromium 进程启动不可压缩；可做的是 B（懒 require、延后插件扫描、首帧后预热 worker） | splash 只改感知（`main/window.js:61-74`） |
| 视图切换 412/183 ms | **D** | Vue 挂载 + 组件体量（23 视图/78.5k 行）+ 懒加载 chunk；Rust 无法接管 DOM | 12 个重视图常驻（frontend-ux §4.6） |
| 60k 音符首绘 529 ms | **D（主）+ B** | Canvas 2D 绘制 + 布局；可用 LOD/分层/索引优化（B），但底层还是渲染进程 | `EditorCanvas.vue:744-791` 已有二分裁剪 |
| hover 命中 O(全轨)（90k 音符/次移动） | **B** | 建 (tick 区间, pitch) 索引即可；JS 足够快 | `EditorCanvas.vue:1424-1429`、`hitTest` 1227-1242 |
| 编排页播放头 10 fps | **B** | `setInterval 100ms` → rAF + 脏矩形 | `ViewArrange.vue:507` |
| 壁纸缩略图进程风暴 | **B** | 直接调内置 ffmpeg，并发限 2 | `main/wallpaper.js:62-84` |
| 日志/进度 IPC 洪峰 | **B** | 节流/批量/增量 | 审计 §4.3、§8.2 |
| 内存（12 视图常驻、60k 堆 +34 MB） | **D + B** | KeepAlive 收敛（B）收益明确；Rust 数据结构省内存的前提是把数据搬进 Rust，与 UI 层强耦合，收益与风险不匹配 | frontend-ux §4.6 |
| MIDI 解析/编码（1 MB 级文件，几十 ms 量级） | **B（伪 A）** | 文件小、次数少；Rust 收益 <20 ms（见 §6） | 【推断】待实测 |
| sha256 完整性校验 | 已完成 | 已经在 Rust（`rust-core`），启动 +2.5 s 后台跑 | `main.js` 定时器；rust-core 572 行 |

**矩阵的读法（给 Lead 的决策含义）：**

- A 类里真正值钱的只有**“Python 解释器固定成本”**（import + probe + deps），而它有两种解法：Rust 原生探测（A）或常驻/缓存（B）。两者都要，但 **B 的投入产出比高一个数量级**。
- C 类（转录主体）是产品体验的绝对大头，但它是**设备/模型问题**，不是语言问题；把 Rust 当“转录提速方案”会失望。
- D 类（渲染）是第二大头，Rust 只能通过“把计算搬出渲染进程”（WASM/napi/共享内存）间接收益，属于 task-2 的范畴，且必须先有 profile 数据。

---

## 5. 可量化目标建议（6 / 12 / 24 个月）

前提：**保留 Electron + Python 引擎**（是否迁 Tauri 由 task-4 决策）；Rust 以“原生模块 + 探测/遍历/索引”的形式渐进接入，不做整体重写。

### 5.1 可达（建议写进验收门禁）

| 指标 | HEAD 实测/基线 | 6 个月 | 12 个月 | 24 个月 | 手段 |
|---|---:|---:|---:|---:|---|
| 进资源中心（probe+deps） | **11.6 s CPU** | <1 s（缓存命中） | **<100 ms** | <100 ms | B 缓存 + Rust 原生探测（A） |
| Python 首次 import（首任务固定开销） | **10.65 s** | 8 s | **5–6 s** | 3–4 s | 懒导入 + 只 import 需要的 + 预热 worker；剩余部分靠 Rust 探测 |
| 设置保存 | **74 ms**（旧 388） | <10 ms | **<5 ms** | <5 ms | debounce + 换 node:sqlite/WAL + 清 songs |
| 存储面板首屏 | **5.78 s** 遍历 | <1 s | **<200 ms** | <100 ms | 缓存 60 s + 增量索引（Rust） |
| 安装包 | **606.3 MiB** | 590 MiB | **540–560 MiB** | 500–520 MiB | 删 transformers/llvmlite/transkun 或改按需下载；**已无 296 MiB 的“白捡”空间** |
| 安装后 | **1,691.5 MiB** | 1,640 MiB | **1,550 MiB** | 1,480 MiB | 同上 |
| 启动到窗口可交互 | 820 ms（旧基线，口径待定） | 重记基线 | **−15%~−20%** | −20%~−25% | 懒 require / 首帧后预热 / 移出首屏 IPC |
| 60k 编辑页首次进入 | 529 ms（旧基线） | 重记基线 | −20% | −30% | LOD/分层绘制/命中索引 |
| 视图切换 cold p95 | 412 ms（旧基线） | 重记基线 | −15% | −25% | 分包策略 + KeepAlive 收敛 |
| 每首模型加载（CPU） | 2–3 s | 0 | **0** | 0 | CPU 也缓存（一行改动） |
| 文件日志 / 空 catch | 已达标 | 保持 | 保持 | 保持 | 现有门禁 |

### 5.2 不宜承诺（写进去就会失信）

| 指标 | 为什么 |
|---|---|
| “转录快 N 倍” | 受模型限制。GPU 已是 0.29× 实时；CPU 1.23× 是没装 CUDA 运行时。除非换模型/量化，语言无关（§2.4、§6-1） |
| 启动 <300 ms | Electron/Chromium 进程启动 + GPU 初始化是固定成本；splash 只能改感知（`window.js:61-74`） |
| 安装包 <300 MiB | 除非把 Python 运行时整个拿掉（那就是 task-3 的“引擎边界”决策，不属于“Rust 重写收益”） |
| 内存减半 / 消除 60k 堆增长 | 60k ≈ +34 MB 是数据本身；除非把歌曲模型搬进 Rust 并改 UI，工程风险远大于收益 |
| 帧率从 p95 3.4 ms 再提升 | 已远优于 60 fps 预算（16.7 ms），没有用户可感知空间 |
| 播放延迟降低 | Web Audio 在渲染进程，Rust 化要走 IPC，反而增加延迟 |

---

## 6. 伪收益清单（看起来该用 Rust、实际收益很小）

| # | 伪收益点 | 证据 | 真实收益 |
|---:|---|---|---|
| 1 | **转录提速** | 120.5 min 素材：模型 2,053 s（GPU），解码仅 5.8 s（token 回放 19.5 s 中推理 5.8 s）；Rust 重写解码器最多省 4.8 s = **0.2%** | ≈0 |
| 2 | **主进程 require 60 ms**（“用 Rust 写主进程更快”） | 审计实测 53 个模块 60.3 ms；Electron 自身启动 + 窗口 + splash 是数百 ms 量级 | <60 ms，且被启动噪声淹没 |
| 3 | **MIDI 解析/编码**（“60k 音符用 Rust 解析”） | 60k 音符 MIDI 约 1–2 MB；JS 单线程解析这个量级是几十 ms；而“60k 首次进编辑页 529 ms”里大头是 Vue 挂载 + Canvas 首绘 + 懒加载 | <20 ms（【推断】，需实测确认） |
| 4 | **sql.js 写放大**（“Rust sqlite 更快”） | 实测 74 ms/次；换成 Electron 内置 `node:sqlite`（B）即可到毫秒级；且写频率是“改设置时” | Rust 方案与 B 方案收益相同，B 工作量小一个量级 |
| 5 | **完整性校验 sha256** | 已经用 Rust 写了（`rust-core/src/main.rs` 572 行），且在启动 +2.5 s 后台跑 | 已到手，不是新收益 |
| 6 | **体积**（“Rust 重写能减小安装包”） | 安装包 606 MiB 里 python 1,099 MiB（压缩后仍占大头）、Electron 195 MiB exe；Rust 二进制替不掉 torch/scipy/onnxruntime | 首装体积收益 <100 MiB，且与语言无关（裁剪即可） |
| 7 | **视图切换 412 ms** | Vue 组件挂载 + 懒加载 chunk + 重视图初始化（12 个常驻实例）；Rust 无法接管 Vue 渲染 | 只能用 D/B 手段 |
| 8 | **播放/合成热路径** | 帧 p95 3.4 ms 已达标；Web Audio 图在渲染进程，Rust 化 = 每帧 IPC，延迟更差 | 负收益风险 |
| 9 | **日志 IPC / 任务事件**（“Rust 高并发写日志”） | 单行一条 IPC，改批量+节流即可（B） | Rust 无额外收益 |

**反过来说，真正值得 Rust 介入的只有 3 个点：** ① 原生环境探测（替掉 probe/deps 的 11.6 s）；② 目录遍历/索引/哈希（替掉 storage 5.78 s 与未来库索引）；③ 大块二进制处理（音频解码/重采样/导出编码，若 profile 证明是瓶颈）。这三点都属于“小内核、清晰边界”，正好适配 napi-rs/WASM，而不是“重写整个后端”。

---

## 7. 待实测清单（给 Lead 写进验收门禁）

> 每条都给可复现方法。前置：本机可跑 GUI（perf-baseline 需要可见会话，rAF/音频在无头下失真——`docs/backlog.md` C1 已记录这个陷阱）。

| # | 待测项 | 方法 | 判据/预期 |
|---:|---|---|---|
| 1 | **启动到“可交互”真值**（6.4.2 新时序） | 在 `main/window.js` 的 `onRendererReady` 与 `App.vue` 的 `notifyRendererReady` 各打一个 `process.hrtime.bigint()` 时间戳（**临时补丁，测完回滚**），或用 CDP：`node scripts/perf-baseline.mjs --json` 记录 `startupMs`，再与 splash 时长对比 | 现状 `startupMs` 820 ms（6.2.0 口径）→ 6.4.2 待记；若 >1.5 s 则启动优化优先级上调 |
| 2 | **60k 音符编辑页 + hover 命中的真实成本**（LOD 后） | 跑 `node scripts/perf-baseline.mjs`（会导入 60k 并记录 `editColdMs`）；另加 CDP 脚本：进入编辑页后用 `Input.dispatchMouseEvent` 在 90k 音符工程上连续移动 200 次，记录 `performance.now()` 两帧间隔 | `editColdMs` 目标 ≤400 ms；hover 单次 ≤1 ms（现 O(n) 推断 >5 ms） |
| 3 | **probe / depCheck 并发墙钟与峰值内存** | `Get-Process python | Measure-Object WorkingSet64 -Sum`（BG 循环采样 200 ms）同时跑：`python music2midi.py probe` + `python deps.py check`；记录墙钟与 RSS 峰值 | 墙钟 ≤ 单跑之和（≈11.6 s）；RSS 峰值 ≈ 2×（各 ~1.2–2.5 GB 含 torch） |
| 4 | **设置保存端到端（含 IPC 与双写）** | 主进程在 `settings-ipc.js:44-58` 前后打点 `performance.now()`；或 DevTools Performance 录制“改一个主题→保存” | 目标 <10 ms（改后）；现状纯 export+write 74 ms，端到端应 ≤100 ms |
| 5 | **storage:report 异步化后是否仍有 >50 ms 长任务** | CDP `Performance.getMetrics` + Tracing 录制打开存储面板过程；对比 `main/storage.js` 遍历耗时（可临时打点） | 主线程无 >50 ms 任务，但遍历总时长仍 ~5.8 s → 需要缓存/索引 |
| 6 | **12 个重视图常驻的内存代价** | 依次打开 音乐/工作台/创作三组后，CDP 读 `performance.memory.usedJSHeapSize`；再给分组 KeepAlive 加 `:max="2"` 复测 | 变体收益目标 ≥30% 堆（frontend-ux §4.6 的 0.5 人日项） |
| 7 | **Rust 原生探测可行性基准**（决定 A 类投入） | 用 `cargo build --release` 写一个 50 行的探测程序：读 CPU 核数/内存/nvidia-smi/目录存在性，输出 probe JSON；对比现 probe 6.07 s | 目标 <100 ms；若达成，则“进资源中心”从 11.6 s → 亚秒 |

---

## 8. 边界与风险（写方案时别忽略）

1. **本文所有 Python 侧数字都是 CPU 路径。** 应用真实路径会注入 `gpu-enhancements` 的 CUDA torch（本机 4.7 GiB），import 与模型前向成本都不同（CUDA 初始化通常再 +1–3 s）。【待实测】应测“应用真实路径”的 import 时间。
2. **“实测”受页缓存影响。** 本机 sql.js 写 63 ms、遍历 5.78 s 都是热缓存下的数；审计的 380 ms 是冷/慢盘。写门禁时必须规定“冷启动 3 次取中位”。
3. **6.4.2 的启动可见时序变了**（splash → renderer-ready → show），`perf-baseline.mjs` 的 `startupMs`（等测试钩子）与“用户能点”之间存在未知差距，**必须先改口径再谈目标**。
4. **体积已不是安装包问题，是数据根问题**（32.7 GiB vs 606 MiB）。任何“Rust 减小体积”的叙事都应改为“首装体积”或“运行时下载策略”。
5. **`main/db.js:201-203` 的 ReferenceError 是 HEAD 的真 bug**（f852109 只加调用未加实现），会让退出冲刷静默失效；它同时是“原地可修、且必须修”的典型，建议单列一条 issue，不要混进 Rust 方案。
6. **性能门禁缺位**：`perf:gate` 未进 CI，`docs/perf-baseline.json` 停在 6.2.0。任何目标数字都应先把这条补上，否则 6 个月后又是一轮“数字过期”。

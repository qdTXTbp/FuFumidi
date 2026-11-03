# 02 · 渲染进程热路径与 Rust 迁移候选（Vue3 + 原生 JS）

> 任务 task-2。仓库 `E:\Midi\FuFumidi-Source`，分支 `feat/audio-tagger-auto-probe`，版本 6.4.2。
> 只读源码 + Node 侧只读基准；未启动 GUI、未改仓库代码。
> 标注约定：**【实测】** = 本次跑出的数字或仓库内已有实测记录；**【推断】** = 由代码结构与量级推得，未实测；**【待实测】** = 必须装到应用里量。

---

## 0. 结论先行（5 条）

| # | 结论 | 依据 |
|---|---|---|
| 1 | **渲染进程整体不是"普遍卡"**。60k 音符曲目播放时 rAF 帧间隔 p95 **3.4 ms**，编辑页首次进入 529 ms，JS 堆 +34.2 MB。Rust 化不应以"让卷帘更顺"为卖点。 | 【实测】`docs/perf-baseline.json`、`docs/perf-report.md`；`scripts/perf-baseline.mjs:29-33,106-133` |
| 2 | 一次性大块 CPU 集中在四处：**可视化开图**（全曲分块 **238 ms** 最坏）、**可视化每帧编译**（**31 ms/帧**、11.5k 图元，最坏合成工程）、**音频导出后处理**（2 分钟立体声合计约 **0.7 s**）、**MusicXML/工程 JSON**（**67/22 ms**、产物 8.4/7.6 MB）。 | 【实测】本次基准（§7）；【推断】触发频率由调用点确定 |
| 3 | **合成器与乐谱已经跑在 WASM 上**：SF2 = libfluidsynth 2.4.6（js-synthesizer）× AudioWorklet；总谱 = Verovio 6.3.0 WASM 7.31 MB。因此"Rust 写 WASM 合成器/DSP"是重造轮子，**低优先**。 | `core/synth.js:473-660`、`docs/VENDOR.md` 清单、`views/ViewScore.vue:102-135` |
| 4 | **最划算的迁移是"可视化图元编译 + WebGL2 顶点打包 → Rust/WASM"与"导出后处理链 → napi/Worker"**；但前者必须先修 `buildVizBlocks` 的 O(k²) 算法（一行级改动省 200 ms），否则会把算法问题带进 Rust。 | 【实测】§7 第 4/5 行；`core/viz.js:145-165` |
| 5 | **核心数据模型整体进 Rust（激进档）不建议**：Vue 的 `reactive` 代理对象与 Rust 所有权/借用根本冲突，每个拖拽事件都要跨边界；60k 音符的堆开销（+34 MB）可以用 TypedArray arena 在 JS 侧解决，不需要换语言。 | 【推断】依据 `stores/app.ts`、`components/EditorCanvas.vue:850-900` 的编辑热路径结构 |

---

## 1. 范围、口径与已有基线

### 1.1 体量盘点【实测】

`python` 遍历 `frontend/src`：**187 个文件、85,935 行、6.54 MB**。

| 目录/文件 | 行数 | 字节 | 说明 |
|---|---:|---:|---|
| `core/`（76 文件） | 28,647 | 1.98 MB | 纯逻辑层；含 i18n 13,491 行（1.12 MB）、changelog 654 行 |
| `views/`（23 文件） | 21,190 | 1.25 MB | `ViewSing.vue` 3643、`ViewEdit.vue` 3640、`ViewTranscribe.vue` 2981、`ViewScore.vue` 1162 |
| `components/`（24 文件） | 9,535 | 0.54 MB | `EditorCanvas.vue` 2156、`SettingsPanel.vue` 1938、`pianoroll/PianoRoll.vue` 1639 |
| `stores/`（12 文件） | 5,001 | 0.23 MB | `singer.ts` 2045、`app.ts` 1353 |
| `core/viz/`（14 文件） | 2,653 | 0.15 MB | 可视化重做后的全部代码 |
| `App.vue` | 1,077 | 57.9 KB | |
| `styles.css` | 1,956 | 98.0 KB | |
| `core/synth.js` | 1,117 | 70.2 KB | |
| `core/viz.js` | 528 | 30.1 KB | 重做后只剩共享工具（原 1112 行） |

### 1.2 已有实测基线（CDP 驱动真实应用，2026-10-17）【实测】

| 指标 | 实测 | 门禁 |
|---|---:|---:|
| 启动 → 可交互 | 820 ms | ≤ 4000 |
| 视图切换 cold p95 | 412 ms | ≤ 1200 |
| 视图切换 warm p95 | 183 ms | ≤ 100 |
| **编辑页 60k 首次进入** | **529 ms** | ≤ 3000 |
| **播放帧间隔 p50/p95** | **3.3 / 3.4 ms**（180 帧） | ≤ 20 |
| JS 堆（首屏→60k） | 10.5 → 44.7 MB（+325.7%） | ≤ +407% |

出处：`docs/perf-baseline.json`（`updatedAt` 2026-10-17）、`docs/perf-report.md`、采集脚本 `scripts/perf-baseline.mjs`。
**口径警告**（读脚本得出）：`editColdMs` 量到的是"出现第一个 canvas"，**不是**完整首帧绘制完成（`perf-baseline.mjs:115-118`）；帧间隔只覆盖 `#/edit` 播放，**没有覆盖可视化页**。

### 1.3 已有的 WASM / Rust 底座【实测】

| 资产 | 体积 | 位置 | 意义 |
|---|---:|---|---|
| `verovio-toolkit-wasm.js` 6.3.0 | 7,310,681 B | `frontend/public/vendor/`，`ViewScore.vue:102-135` 动态 `<script>` 注入 | 乐谱渲染已是 WASM |
| `libfluidsynth-2.4.6-with-libsndfile.js` | 2,371,528 B | `frontend/public/vendor/js-synth/` | SF2 合成是 C++→WASM |
| `js-synthesizer.worklet.min.js`（本地打过补丁） | 30,283 B | 同上 | 已跑在 **AudioWorklet** 音频线程 |
| `fu-seq-clock.js`（自有） | 4,251 B | 同上 | worklet 内音序时钟 |
| `sql-wasm.wasm`（sql.js） | — | 主进程 `main/db.js:38` `locateFile` | 主进程 WASM 先例 |
| `fufumidi-core`（Rust 边车） | 571 行 | `rust-core/`，`scripts/build-rust.ps1`，产物 `resources/rust-core/fufumidi-core.exe` | **构建链里已有 Rust**（sidecar 形态，非 napi） |

CSP 已允许 WASM：`frontend/index.html:6` 的 `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ...`。
打包已为原生模块留口：`electron-builder.yml:10-12` `asarUnpack: - "**/*.node"`。

---

## 2. 热路径清单（Top 10）

> 排序依据：单位触发成本 × 触发频率 × 是否在主线程。**复杂度**栏按每次调用计。

| # | 位置（文件:行） | 做什么 | 复杂度 / 分配特征 | 触发频率 | 现有实测证据 |
|---|---|---|---|---|---|
| 1 | `core/viz/scene/compile.js:70-393`（内层 215-285、排序 390） | 每帧把状态编译成图元数组 `Primitive[]`：逐可见块算几何、调 `buildNote`（每块 5-8 个对象）、落点光晕、白热线、键盘、粒子 | **每帧 O(可见块)**；每块 5-8 次 `Object.assign` 分配；末帧 **11,561** 个图元；`sortPrims` O(P log P) | **60 fps**（`ViewViz.vue:343` 限流 15 ms） | 【实测】60k 密集工程 60 帧 = **1,864 ms → 31.1 ms/帧**（Node/V8） |
| 2 | `core/viz.js:112-148`（合并回扫 145-165） | 全曲音符按音高合并成块，供每帧二分裁剪 | **最坏 O(k²)/音高**（对每个块从尾向前线性回扫）；60k 音符 → 大量小对象 + 两次 sort | 每次换歌 / `songRef` 变化（`compile.js:158-162`） | 【实测】60k = **238 ms**（median；min 113 ms） |
| 3 | `core/export_audio.js:119/287/325/362`（dither 34，biquad 272） | 导出后处理：16bit WAV 编码 + TPDF 抖动（每样本 2 次 `Math.random`）、K 加权 LUFS、限幅器、响度归一 | 逐样本 O(N)；120 s×48 kHz×2ch = **11.52 M 样本**；多次全量拷贝 | 每次导出音频 1 次 | 【实测】2ch/120 s：encodeWav **234.8**、measureLufs **144.3**、applyLimiter **116.8**、normalizeLoudness **201.4** ms |
| 4 | `core/musicxml_out.js:133-308/309-457` | MusicXML 生成：逐音符切小节线、拼字符串、声部拆分 | O(音符)，**字符串数组 spread + 拼接**（本文件 48 处 `+=`/join） | 每次"导出乐谱/总谱" | 【实测】15k 单轨 **71.8 ms**；60k 全谱 **66.7 ms → 8.43 MB 字符串** |
| 5 | `core/song_project.js:319-383`（逐音符 160-200） | 工程序列化：60k 音符 → 普通对象 → JSON 字符串 | O(音符) 对象分配 + `JSON.stringify` | 保存 / 自动保存 / 切歌 | 【实测】序列化 **22.0 ms**、stringify **15.2 ms**、parse **15.7 ms**，JSON **7.62 MB** |
| 6 | `core/spectrogram.js:61-88`（`fft`）、`89-122` | STFT：加窗 + 基 2 FFT + 归一化到 dB | O(frames × n log n)；10 s@48k/fft2048 = 899 帧×1025 bin | 打开分析/频谱面板 | 【实测】**46.4 ms**（单次，10 s 音频） |
| 7 | `core/analysis.js:307-347`（Krumhansl 滑窗）、`228-292`、`388-437` | 调性检测（24 个调轮廓 Pearson 滑窗）、全曲统计、段落聚类 | O(窗口数 × 12 × 24) + 排序/集合分配 | 分析页 / 自动标注 | 【实测】`detectKeyWindows` 60k = **53.2 ms**；`analyzeSong` = **19.7 ms**；`detectChords` = 2.8 ms |
| 8 | `core/player.js:87-229`（`prepare`） | 播放前把 `song.tracks[*].notes` 展开成播放事件：**每音符 new 一个 10 字段对象**、每音符 2 次二分查通道状态、整体 `sort` | O(N log N) + N 次分配（60k ≈ 7 MB 临时对象） | 载入 / **换音色 / 改 BPM**（`ViewEdit.vue:1774,1781,1806`） | 【实测】60k = **4.2 ms**；`_sched` 100 拍 = **0.02 ms** |
| 9 | `core/curve_engine.js:69-90`（`valueAt`） | 曲线求值：线性插值，但**每次调用都从头线性扫描** | O(points) 线性扫描（无缓存/无二分） | `track_automation.sampleAt`（`core/track_automation.js:152-155`）、`envelope` 256 步 | 【实测】10k 点曲线 100k 次求值 = **37,982 ms → 0.38 ms/次**；实际每帧调用次数【待实测】 |
| 10 | `components/EditorCanvas.vue:850-900`（音符环）+ `2050-2076`（rAF 循环） | 卷帘绘制：**每轨两次二分定位窗口**、LOD、按需重绘 + 15 ms 限流 + 可见性守卫 | O(屏内音符)；`fillRect`/帧 ≈ 屏内音符数；**已无全量扫描** | 播放中 60 fps / 交互时 dirty | 【实测】基线见 §1.2（播放 p95 3.4 ms）；【推断】绘制本身占比小 |

**附带（非 Top10 但影响启动）**：`core/i18n.js`（514 KB）+ `core/i18n_ja.js`（594 KB）在渲染进程**首屏同步 import**。【实测】Node 里 `import 'i18n.js'` = **61.6 ms**（含 `vue` 的 `reactive` 与两张表求值），之后 `midi.js` 只要 4.6 ms。这不是"搬 Rust"能解决的，见 §5 不该搬第 6 条。

### 2.1 热路径与任务要求的六个场景对照

| 场景 | 谁最贵 | 量级 |
|---|---|---|
| **60k 音符工程** | 可视化开图（238 ms）+ 每帧编译（31 ms） | 见 #1/#2 |
| **播放中每帧** | 可视化编译 > 卷帘绘制 > 播放调度（0.02 ms/100 tick，可忽略） | #1/#10 vs #8 |
| **拖拽编辑** | 卷帘重绘（已按需 + 二分）；未发现全量扫描 | 【推断】#10 |
| **导出音频** | 后处理链 **≈0.7 s / 2 min**（尚未计离线合成） | #3 |
| **加载大 MIDI / 乐谱** | MIDI 解析 6.2 ms + buildSong 1.2 ms + prepare 4.2 ms ≈ **11.6 ms**；乐谱另有 Verovio WASM | #4 的邻居，实测见 §7 |
| **可视化渲染** | 编译 31 ms/帧 + 光栅/后处理（真机 1080p 0.5-0.6 ms/0.1 ms，已有实测） | #1 + `2026-10-17-viz-redo.md` §M2/M3 |

---

## 3. 迁移候选表

> 目标形态：**(a)** Rust→WASM（wasm-bindgen，主线程或 Worker）；**(b)** Rust→napi（主进程/utility process）；**(c)** AudioWorklet/WASM DSP；**(d)** 留 JS 优化算法；**(e)** 不可能/不该。

| 候选 | 位置 | 目标形态 | 边界依赖（只能留 JS 的部分） | 数据拷贝/序列化成本 | 预期提速 | 工程量 | 风险 |
|---|---|---|---|---|---|---|---|
| **C1 可视化图元编译 + WebGL 顶点打包** | `core/viz/scene/compile.js` 全文件、`core/viz/raster/webgl2.js:183-255`（`packPrims`，stride 29） | **(a)** WASM；Worker 版可选 | Canvas2D 回退路径、`text` 图元（字形只有 Canvas 能画）、相机/主题数据仍在 JS | 每帧 11.5k 图元 × 29 float × 4 B ≈ **1.33 MB/帧**。可做成 Rust 直接写 `Float32Array` 顶点缓冲 → **一次 1.3 MB 拷贝**；Worker 场景可用 **SharedArrayBuffer 双缓冲**（Electron 需 `crossOriginIsolated`，见 §4） | 【推断】**2-3×**（无 GC、无 11.5k 对象分配；真机光栅/后处理只占 0.5-0.7 ms，编译是主项） | 4-6 周 | 中高：两套光栅器语义漂移（已有像素对齐测试可兜底）、图元结构变更双写 |
| **C2 全曲分块 `buildVizBlocks`** | `core/viz.js:112-148` | **(d) 先修算法**；之后可选 (a) | 无（纯函数） | 一次性 60k 输入/输出；| 【实测依据】把回扫改成"只比最后一块"即 O(k log k)：**238 ms → ~3 ms（推断 ×70）**；Rust 再快也只是在 3 ms 上做减法 | **0.5 天** | 低：有单测（块合并/二分裁剪） |
| **C3 导出后处理链**（WAV 编码 + dither + LUFS + limiter + normalize） | `core/export_audio.js:119-395` | **(b) napi**（跑 utility process）或 **(a) Worker+WASM SIMD** | 离线渲染仍由 `OfflineAudioContext` 出 Float32；文件落盘在主进程 | 120 s 立体声 = **46 MB Float32**；napi 可用外部 `Float32Array` 零拷贝（N-API `napi_create_external_arraybuffer` 语义），或 Worker 传 SharedArrayBuffer；**不建议 JSON/structured clone 逐样本传** | 【推断】**4-8×**（SIMD + 无逐样本 JS + 可多线程）；0.7 s → 0.1-0.2 s | 3-4 周 | 中：ABI/Electron 37 Node 版本、内存峰值 2×46 MB、必须与现有 JS 实现逐样本对拍 |
| **C4 MusicXML 生成** | `core/musicxml_out.js:133-457` | **(a)** WASM；或 **(d)** 预分配 `Uint8Array` 写缓冲 | 结构语义（切小节、声部）必须与现有 XML 对齐；输出最终给主进程写盘 | 输出 8.43 MB 字符串 → 一次跨边界拷贝 ≈ 10 ms 以内 | 【推断】2-3×；67 ms → 25-35 ms | 3 周 | 中：XML 属性顺序/转义必须逐字节对拍 |
| **C5 工程 JSON 序列化/反序列化** | `core/song_project.js:319-549` | (b)/(a) serde_json | 版本迁移、资产路径、`localStorage` 元数据仍在 JS | 7.62 MB 文本；`JSON.parse/stringify` 本身是原生 C++（15 ms 级） | 【推断】序列化 2-3×（22→8 ms），**JSON.parse 不会更快** | 3 周 | 高（schema 双写、老工程兼容）→ **不单独立项** |
| **C6 频谱图 STFT** | `core/spectrogram.js:61-122` | **(a)** WASM（rustfft）+ Worker | 绘制 `drawSpectrogram` 留在 Canvas | 10 s 单声道 1.92 MB；输出 899×1025 Float32 ≈ 3.7 MB | 【推断】3-5×；46 → 10-15 ms | 1 周 | 低；但总收益 <50 ms |
| **C7 调性/段落分析** | `core/analysis.js:228-437` | (a) 可选 | UI 图表绘制在 Canvas | 60k 音符结构化输入（可打包成类型化数组） | 【推断】2-4×；53 → 15-25 ms | 1-2 周 | 低收益 |
| **C8 播放器 prepare/sched** | `core/player.js:87-229,373-467` | **(e)/(d)** 不值得 | Web Audio 节点创建、Router、setInterval | 4.2 ms / 0.02 ms | 无意义 | — | — |
| **C9 SF2 合成器 / DSP** | `core/synth.js:473-660` | **(c)→不建议** | AudioWorklet + Web Audio | — | 已是 WASM（FluidSynth）| 6 月+ | 极高：等价性/音色回归 |
| **C10 卷帘/编辑器绘制** | `components/EditorCanvas.vue:723-1030` | **(e)** | Canvas2D（Skia，本身 GPU 加速）、DOM 事件 | 每帧只传"变更"，不是全量 | 迁移只会更慢 | — | — |

---

## 4. 三档方案

### 4.1 保守档（≈1-2 周）：只搬 2-3 个纯计算库，不动架构

**范围**：C2 算法修（必做）+ C6 STFT 进 Rust/WASM（Worker 内）+ 导出链先做 `(d)` 优化（预分配缓冲、去掉 spread、dither 用预生成噪声表）。
**模块边界**：

```
frontend/src/core/viz.js            ← C2 改为 O(k log k)（纯 JS）
frontend/src/wasm/fft/              ← Rust crate: rustfft + window + db
  pkg/fft_wasm.js + fft_bg.wasm
frontend/src/core/spectrogram.js    ← drawSpectrogram 不动；computeSpectrogram 改成
                                       async: 动态 import pkg → postMessage(sab) → 回填 Float32Array
frontend/src/core/export_audio.js   ← 保持 JS，只做循环与缓冲优化
```

调用示例（伪代码）：

```js
// Worker 内的 wasm 调用：输入/输出都走 SAB，零 structured clone
const { compute } = await import('../../wasm/fft/pkg/fft_wasm.js');
const outDb = new Float32Array(frames * bins);          // 主线程分配，SAB 共享
compute(sabIn, sabOut, { fft: 2048, sr: 48000 });       // Rust 原地写 out
```

**收益**：可视化开图 238 → <10 ms；频谱 46 → 10-15 ms；导出 ~0.7 s → ~0.5 s。
**代价**：新增 1 个 crate、1 条 wasm-pack 构建、CI +1-2 min；无架构变更。
**失败模式**：WASM 加载失败（file:// MIME）→ 必须有 JS 回退（保留旧 `computeSpectrogram`）。

### 4.2 中等档（≈4-8 周，推荐）：WASM 可视化编译/打包 + napi 导出后处理

**范围**：C1（Rust 生成 Flat32 顶点 + 文本图元单独回传）+ C3（napi）+ C4。
**架构草图**：

```
┌──────────── renderer (Vue3) ────────────┐
│ ViewViz.vue  tick()  ── 60fps 限流       │
│   viz/index.js  render(ctx,w,h,song,tick)│
│        │ compile 阶段（昂贵）             │
│        ▼                                 │
│   ┌─ WebGL2 路径 ─────────────────────┐   │
│   │ wasm.compile(songArena, tick, opts)│   │  Rust: 图元生成 + 顶点打包
│   │   → { verts: Float32Array(SAB),    │   │  输出 1.3 MB/帧（可双缓冲）
│   │       n, texts:[...] }             │   │
│   │ gl.draw(verts)  // 主线程只上传     │   │
│   └────────────────────────────────────┘   │
│   ┌─ Canvas2D 回退（不动）──────────────┐   │
│   │ 现有 JS compile.js 原样保留          │   │
│   └────────────────────────────────────┘   │
└──────────────────────────────────────────┘
        │ 导出音频（OfflineAudioContext → Float32）
        ▼
┌── utility process（Node，不阻塞主进程）──┐
│  napi: post_process(channels, sr, opts) │  Rust + rayon + SIMD
│    → Float32Array（external buffer）     │
│  napi: encode_wav(...) → Uint8Array      │
└──────────────────────────────────────────┘
```

**内存所有权**：音符数据在 **Rust 侧一份 arena**（`Vec<Note>`，按 tick 排序），JS 侧保留"只读视图"用于编辑；编译时不复制整首歌，只把"本帧参数 + 视口"传进去 → 每帧跨边界只有几百字节 + 一个顶点缓冲。文本图元（小节号/键名/歌词）仍由 JS 用 Canvas2D 画，**不试图把字形搬进 Rust**。
**收益**：最坏 60k 工程 viz 帧成本 31 → 10-12 ms（【推断】，需实测）；导出后处理 4-8×；MusicXML 2-3×。
**代价**：Rust crate 2-3 个（viz-core / audio-post / musicxml）、双后端维护、像素对齐测试必须两路都跑、CI 需要 Rust 工具链（当前 `npm run build:ui` 不需要）。
**失败模式**：① 顶点缓冲与 Canvas2D 图元语义漂移（用已有逐像素对齐测试，容差 2%）；② SAB 在 Electron 需要 `crossOriginIsolated`，`file://` 下大概率**不可用** → 退化成"每次 1.3 MB 拷贝"（~1 ms，仍可接受）；③ napi 模块漏进 asar → 启动即崩（`asarUnpack` 已配 `**/*.node`，但需验证）。

### 4.3 激进档（3-6 月，不建议）：核心数据模型进 Rust，前端只做视图

**架构草图**：

```
Rust core (wasm-bindgen)                     Vue3 视图层
┌──────────────────────────┐        ┌───────────────────────────┐
│ Song { tracks: Vec<Trk>, │        │ 只读投影：                │
│        notes: Arena<Note>│◄──────►│  get_visible(tick, view)  │
│        tempo: TempoMap   │ 只传    │  → 紧凑 Float32/I32 视图   │
│        edit ops (undo)   │ 视图数据 │  绘制仍是 Canvas2D/WebGL  │
└──────────────────────────┘        └───────────────────────────┘
        ▲ 编辑命令                  Vue reactive 只保留"选中/视图状态"
        └──── EditorCanvas 拖拽 → 命令 → Rust 返回新版本号
```

**收益（推断）**：60k 音符堆 +34 MB → arena 约 6-8 MB；消除 `player.prepare` 的对象复制与 `song_project` 的 7.6 MB 中间态；编辑操作可做 batched diff。
**代价**：`stores/app.ts`（1353 行）与 `views/ViewEdit.vue`（3640 行）里 **几乎所有逻辑** 都要改写调用面；`EditorCanvas.vue` 的 selection 用 `Set<note对象>`（`EditorCanvas.vue:91`）——对象身份是编辑语义的一部分，Rust 侧必须给稳定 id 或句柄表；每次拖拽的 mousemove 都要跨边界（可批量，但延迟敏感）。
**失败模式**：响应式失效（Vue 追踪不到 Rust 内存变化，必须手动 `markRaw`/版本号触发）；调试栈断裂（JS 报错不再指向数据修改点）；wasm 内存增长（4 GB 上限）与 GC 边界问题；**投入产出比在 §3 表格里最差**。

---

## 5. 不该搬的清单

| # | 对象 | 理由 | 证据 |
|---|---|---|---|
| 1 | **编辑器卷帘 / 钢琴卷帘绘制**（`EditorCanvas.vue:723-1030`、`PianoRoll.vue`） | 已经是"按需重绘 + 15 ms 限流 + 可见性守卫 + 每轨二分裁剪 + LOD"（`EditorCanvas.vue:850-870, 2050-2076`）。Canvas2D 本身是 Skia/GPU 加速；把绘制搬走反而要每帧跨边界传 60k 数据 | 实测播放 rAF p95 3.4 ms（§1.2）；`2026-10-17-viz-redo.md` §M2 实测"canvas2d 0.55 ms vs webgl2 0.50 ms" |
| 2 | **播放调度与 Web Audio 节点创建**（`player.js:373-467`、`synth.js` 的节点图） | 必须调用 Web Audio API；每 25 ms 一趟的成本 **0.02 ms/100 趟**；提前量窗口已用 `bumpAhead` 抗主线程阻塞 | 【实测】§7 |
| 3 | **SF2 合成器 / DSP** | 已经是 libfluidsynth 2.4.6 的 WASM 构建 + AudioWorklet 音频线程，且 worklet 文件**本地打过补丁**（升级/重写都会破坏 `__fuSeqClockStart` 返回值） | `docs/VENDOR.md` 坑 1；`core/synth.js:473-660` |
| 4 | **MIDI 解析与批量音符工具** | 60k/480 KB 解析 6.2 ms、buildSong 1.2 ms；移调/量化 15k 音符 0.34-0.39 ms。任何迁移收益 <10 ms，用户不可感 | 【实测】§7 |
| 5 | **Vue 响应式 / DOM 事件 / i18n / 主题切换** | 属于"视图与语言"，Rust 无从下手；i18n 的 61.6 ms 启动成本是**数据体积**问题，靠懒加载 ja 表解决，不靠换语言 | 【实测】§7 模块 import；`core/i18n.js` 514 KB |
| 6 | **乐谱渲染（Verovio）** | 已经是 Verovio 6.3.0 的 WASM 构建（7.31 MB），且上游没有 Rust 等价物；重写=重做一个排版引擎 | `docs/VENDOR.md`；`ViewScore.vue:102-135` |

---

## 6. 与现有构建链的集成

### 6.1 Vite + wasm-pack

- 现状：`frontend/vite.config.js` **没有**任何 WASM 插件，`build.target = 'es2020'`，产物输出 `renderer/dist`。第三方 WASM（verovio/js-synth/sql.js）走 `public/vendor` + 运行时 `fetch/script`，**不走打包器**。
- 建议沿用同一模式：`wasm-pack build --target web` 产物放 `frontend/public/vendor/<crate>/`，由 `core/wasm/<crate>.js` 懒加载（`await init(new URL('./x_bg.wasm', import.meta.url))`）。
- **不要**把 wasm 交给 Rollup 内联：现有 `renderer/dist` 已 16.7 MB（`assets` 6.7 MB + `vendor` 9.5 MB），内联只会让 `index-*.js`（当前 1.45 MB）更难拆包。
- 开发热更：wasm 属于"构建产物"，改 Rust 必须重跑 wasm-pack（秒级到十几秒）→ 建议 `npm run build:wasm` 独立脚本 + `vite` 的 `public` 目录天然热更（改文件即生效，不重启 Vite）。

### 6.2 Electron CSP / 沙箱

- CSP 已允许：`script-src 'self' ... 'wasm-unsafe-eval'`（`frontend/index.html:6`）。**若新增 Worker，需要在 CSP 里显式加 `worker-src 'self' blob:`**（当前没有 worker-src，会回退到 default-src 'self' data: blob:，**推断可用，待实测**）。
- 渲染进程按仓库约定不许碰 fs/net/子进程（`AGENTS.md` 依赖方向）→ napi 方案必须落在主进程/utility process，由 `preload.js` 暴露（"新能力三处同改"）。

### 6.3 asar 内 wasm 的 MIME 问题

- 渲染进程通过 `file://` 加载 asar 内的 `.wasm`：**`WebAssembly.instantiateStreaming(fetch(...))` 会因 Content-Type 不是 `application/wasm` 失败**（Electron 的 file:// 协议不保证 MIME）。**必须** `const buf = await (await fetch(url)).arrayBuffer(); await WebAssembly.instantiate(buf)`。这是 verovio/js-synth 当前能跑的原因（它们用脚本/JS 加载，不依赖 streaming）。
- Electron 对 asar 内的 `.wasm` 读取本身是支持的（sql.js 的 wasm 已随包），**但**如果 wasm 由 napi 模块旁加载（`require('./x.node')` 依赖同目录 `.node`），则必须 `asarUnpack`。`electron-builder.yml:10-12` 已有 `**/*.node`，**wasm 不需要 unpack**。

### 6.4 Worker / AudioWorklet 路径

- **Worker**：`new Worker(new URL('./viz_worker.js', import.meta.url), { type: 'module' })`，Vite 6 支持；wasm 在 worker 内 `fetch` + `instantiate`。SAB 需要 `crossOriginIsolated`（Electron 默认 false）→ **推断不可用**，退化为"每帧一次 1.3 MB 拷贝"或"Worker 只做离线任务（导出/分析）"。
- **AudioWorklet**：只能进音频线程，适合 DSP；本项目已有 js-synth worklet 先例（`core/synth.js:504-535`），但**没有**需要新写的 DSP（见 §5 第 3 条）。
- **napi**：跑在 utility process 最稳（`main/` 已有子进程/任务中心基建，`TaskCenter.vue`/`main/rvc.js` 同型）；渲染进程通过 IPC 拿回 `ArrayBuffer`（structured clone 一次 46 MB ≈ 20-40 ms，**待实测**，可接受但要注意内存峰值）。

### 6.5 CI / 开发成本

- 现状：`npm run build:ui` 不依赖 Rust；`npm run build:rust` 已有（`rust-core` sidecar，GNU 工具链，无需 MSVC）。
- 新增 WASM/napi 后：CI 需要 `rustup target add wasm32-unknown-unknown`（+napi 则需要 Node headers），构建时间 **+1-3 min**（推断）；发布包 `renderer/dist` 体积 **+0.3-3 MB/模块**（wasm-bindgen 基线约 100-300 KB，待实测）。
- 门禁：现有 `npm run perf:gate`（`scripts/perf-baseline.mjs`）+ `npm test`（30 条子任务）已足够卡住回归；需新增"WASM 加载失败回退"用例。

---

## 7. 实测数据附录（可复现）

**环境**：Windows 10.0.26200 · Node v24.16.0（V8）· 32 核 · 61.7 GB。脚本在 `E:\Midi\_attic\bench`（仓库外，只读导入仓库模块）。
**方法**：每组 3-5 次取 median，先 1 次预热；60k 音符工程由与 `scripts/perf-baseline.mjs:35-46` 相同的生成器产出（4 轨 × 15k，division 480）。

| 操作 | 实测 median | min | 备注 |
|---|---:|---:|---|
| `encodeMidi` 60k | **34.2 ms** | 25.8 | 导出/保存路径；480,114 B |
| `parseMidi` 60k | **6.2 ms** | 4.9 | 加载路径 |
| `buildSong` 60k | **1.2 ms** | 1.2 | |
| `Player.prepare` 60k | **4.2 ms** | 3.5 | 60,000 事件、938 s |
| `_sched` × 100 | **0.02 ms** | 0.01 | 期间 noteOn 1,988 次 |
| `buildVizBlocks` 60k | **238.3 ms** | 113.0 | O(k²) 最坏形态 |
| viz `compile` 60 帧 | **1,864.6 ms**（31.1/帧） | 1,803.6 | 末帧 11,561 图元 |
| `songToAbc` 15k | 6.3 ms | 5.3 | |
| `songToMusicXMLTrack` 15k | **71.8 ms** | 58.3 | |
| `songToMusicXML` 全谱 60k | **66.7 ms** | 66.7 | 输出 8.43 MB |
| `serializeProject` 60k | **22.0 ms** | 21.7 | JSON 7.62 MB |
| `JSON.stringify` 同对象 | 15.2 ms | 14.5 | 原生 |
| `JSON.parse` 同文本 | 15.7 ms | 15.6 | 原生 |
| `analyzeSong` 60k | 19.7 ms | 13.5 | |
| `detectKeyWindows` 60k | **53.2 ms** | 51.9 | |
| `detectChords` 60k | 2.8 ms | 2.8 | |
| `computeSpectrogram` 10 s@48k fft2048 | **46.4 ms** | 43.0 | 899 帧 × 1,025 bin |
| `encodeWav` 2ch/120 s/16bit+dither | **234.8 ms** | 230.9 | 11.52 M 样本 |
| `measureLufs` 2ch/120 s | **144.3 ms** | 123.5 | |
| `applyLimiter` 2ch/120 s | **116.8 ms** | 116.8 | |
| `normalizeLoudness` 2ch/120 s | **201.4 ms** | 201.4 | |
| `measurePeak/Rms` 2ch/120 s | 25.8 ms | 25.8 | |
| midi-tool 移调 / 量化 15k | 0.39 / 0.34 ms | 0.15 / 0.28 | |
| `partClusters` 60k | 5.4 ms | 5.4 | |
| `alignLyrics` 2,000 音符 | 0.26 ms | 0.24 | |
| `simplifyPoints` 10k 点 | 5.2 ms | 4.8 | |
| `valueAt` 10k 点 × 100k 次 | **37,981.6 ms** | 36,109 | 0.38 ms/次，线性扫描 |
| `import` `i18n.js`（冷） | **61.6 ms** | — | 含 vue/i18n_ja/zhHant 求值 |
| `import` `midi.js`（i18n 已缓存） | 4.6 ms | — | |
| `import` `viz/index.js` | 11.9 ms | — | |
| `import` `synth.js` / `analysis.js` / `export_audio.js` | 1.4 / 1.2 / 0.8 ms | — | |

> **Node 数字不能直接当应用数字**。仓库自己的记录已经踩过这个坑：离线台 CPU 光栅 28 ms vs 真机 3.3 ms（8×），见 `docs/plans/2026-10-17-viz-redo.md` §M2。上表除明确"纯计算、无 DOM"的项（MIDI/JSON/音频后处理/FFT）外，**都应视为上界或结构证据**，不能当用户可见延迟。

---

## 8. 验收方法（每个候选怎么做 A/B）

| 候选 | A/B 方式 | 指标 | 采样 |
|---|---|---|---|
| C1 viz 编译 | 同一 60k 工程、同一 `tick` 序列、同一主题；A=JS 编译，B=Rust 编译；轮流跑 3 轮消除热漂移 | `window.__fufumidiVizStats`（`core/viz/index.js:209-213`）的 `layers.compile/raster/post` + `prims`；同时用 `window.__fufumidiVizRaster`（:205-208）确认后端 | rAF 采样 ≥300 帧，报 p50/p95；同时抓 `PerformanceObserver` 的 longtask（>50 ms） |
| C2 buildVizBlocks | 纯函数，直接 `node frontend/tests` 里加测；应用侧看"打开可视化到首帧" | 函数耗时 + 首帧时间 + 图元数（必须与旧实现**逐图元一致**） | 30 次 median；输出做 JSON 哈希对拍 |
| C3 导出后处理 | 同一 WAV 输入、同一后处理参数；A=JS，B=napi；输出**字节对拍** | 单次耗时、峰值 RSS、WAV 字节 SHA-256 | 20 次 median + p95；内存用 `process.memoryUsage().rss` |
| C4 MusicXML | 同一工程导出，**字符串逐字节对比**（或用 XML canonicalize） | 耗时 + 输出大小 + diff 行数 | 20 次 median |
| C6 STFT | 同一 10 s PCM；A=JS，B=WASM | 耗时 + 输出 Float32 最大绝对误差（应 <1e-6） | 30 次 median |
| 全局回归 | `npm run perf:baseline`（CDP 真机，含启动/切页/60k 编辑/帧间隔/堆） | 6 项门禁（§1.2） | 沿用现有脚本，基线 +25% 抖动 |
| 可视化观感 | `scripts/viz-lookcheck.py`（键盘区亮度/背景/对比/色数）+ 用户看对照图 | 6 项指标 | 单帧截图 |

**共同的采样纪律**（写进任何一次 A/B）：① 首 2 次预热丢弃；② 同一进程内交替 A/B，避免热漂移；③ 报 median 与 p95，不报 mean；④ 内存用 `--enable-precise-memory-info`（`perf-baseline.mjs:92` 已用）；⑤ 任何"变快"必须同时给出**输出等价性**证据，否则视为不可信。

---

## 9. 风险与待实测清单

| # | 事项 | 类型 | 影响 |
|---|---|---|---|
| 1 | 我的 viz 编译 **31 ms/帧** 与仓库真机记录（应用层 rAF p50 3.3 ms）矛盾 | **待实测** | 可能是"1) 合成工程最坏形态 2) 真机视觉窗口内块数远少。必须在安装版用 `__fufumidiVizStats` 量 60k 工程的可视化页，否则 §4.2 的收益估算不成立 |
| 2 | 可视化 **光栅 + 后处理** 在真机的耗时我没法量（禁止启动 GUI） | **待实测** | 若编译只占 31 ms 中的 1/3，则 C1 收益打折 |
| 3 | SAB / `crossOriginIsolated` 在 Electron `file://` 下是否可用 | **待实测** | 决定 C1 是"零拷贝"还是"每帧 1.3 MB 拷贝" |
| 4 | `worker-src` 未在 CSP 显式声明，Worker 是否被放行 | **待实测** | 放行失败会直接白屏（回退到主线程） |
| 5 | Windows 上 asar + `.wasm` 的 file:// 读取与 MIME | **待实测** | 决定必须 `instantiate(arrayBuffer)`（推断必须） |
| 6 | napi 模块 × Electron 37 的 ABI 与 utility process 生命周期 | **待实测** | C3 的前置条件 |
| 7 | `valueAt`（0.38 ms/次@10k 点）实际调用频次 | **待实测** | 若每帧调用 → 是隐藏热路径；若只在导出 → 忽略 |
| 8 | wasm-bindgen 基线体积 / 双后端维护成本 | **待实测** | 影响发布包体积（当前 renderer/dist 16.7 MB，dist 194 MB） |
| 9 | `detectKeyWindows` / `analyzeSong` 的触发频率（是否在切换视图时全量跑） | **推断**：分析页进入时一次 | 决定 C7 是否值得 |
| 10 | i18n 首屏 61.6 ms 的优化（懒加载 ja 表）不需要 Rust | **待实测**在真机 | 启动 820 ms 里可省 ~50 ms |

---

## 10. 一页纸决策建议

1. **先做 C2（0.5 天）**：`buildVizBlocks` 的 O(k²) → O(k log k)，60k 工程可视化开图 238 → <10 ms，零架构风险。
2. **再做 C3（3-4 周）**：导出后处理进 utility process 的 napi 模块，0.7 s → 0.15 s，用户能感知（导出是"点击后等待"场景）。
3. **C1（4-6 周）放第三**：等真机 `__fufumidiVizStats` 数据确认"编译占帧预算 >50%"再动；否则先做 C1 的 JS 侧分配优化（图元对象池 / 结构体数组化）。
4. **C4/C5/C6/C7 合并成一个"离线批处理 crate"**，只在 C3 的 napi 框架立起来之后顺手做。
5. **C8/C9/C10 明确不做**；激进档（数据模型进 Rust）**不立项**，理由见 §3/§4.3。

# 05 · Rust 生态与同类改造案例调研（检索日 2026-11-03）

> 本文只回答一个问题：**外部 Rust 生态能不能接住 FuFumidi 的现有能力，代价与雷区在哪。**
> 性能基线、前端热路径、Python/ML 边界、外壳决策分别见 01–04 篇，本文不重复。
>
> **证据等级**（全文逐条标注）：
> - **实测**：本次在仓库内只读执行命令 / 调用 crates.io、GitHub API 得到，命令与数字可复核；
> - **文档**：仓库内文档或上游官方文档/许可证原文；
> - **推断**：由实测与文档推导，未单独验证；
> - **待实测**：需要在本仓库跑基准或 POC 才能定论。

## 0. 一页结论

| # | 结论 | 证据 | 等级 |
|---|---|---|---|
| 1 | 外壳换 Tauri **不是新项目，是把 250 个 IPC handler 重写一遍**；本仓库已有该尝试并冻结 | `docs/FOUNDATION.md:101-107`；实测 `ipcMain.handle`=250、Tauri command=76；`src-tauri/Cargo.toml:2` 版本 3.1.8 vs 应用 6.4.2 | 实测/文档 |
| 2 | 换壳的包体收益**上限是 Electron 运行时份额**，而本仓库安装包已被自有 payload 主导 | 实测 `release/FuFumidi Setup 6.4.2.exe`=635,789,305 B；`resources`=1.4G（其中 `resources/python`=1.2G） | 实测 |
| 3 | 已验证可落地的 Rust 增量路径是**独立子进程 rust-core + JSON 协议 + 优雅降级**（已上线 SMF 统计/哈希/量化/移调），扩展它比换壳便宜一个数量级 | `main/rust.js:1-3`；`rust-core/src/main.rs:360-424`；`rust-core/Cargo.toml` 仅依赖 sha2 | 实测/文档 |
| 4 | 音频 Rust 栈齐备（cpal/rubato/symphonia/rustysynth），唯一硬门槛是 **ASIO SDK 非开源**；而项目当前 WebAudio 实测 RTL 10ms（interactive）已达标，"原生"只在独占≤10ms 目标下才值 | `docs/audio-rtl-report.md:11-16`；`frontend/src/core/audio_rt.js:5,16`；cpal README（ASIO 需 SDK） | 实测/文档 |
| 5 | ML 侧 Rust 只能接 **ONNX**（ort 稳定版仍未发布，最新 2.0.0-rc.15）；torch 只波及 3 个 engine 文件，可搬面比想象小 | crates.io：ort stable=null、2.0.0-rc.15；实测 `grep -rln onnxruntime engine/*.py`=11 文件，torch=3 文件 | 实测 |
| 6 | MIDI 生态可用但**分层**：midly（SMF，Unlicense，2023-01 后停更）、wmidi（实时消息）、midir（设备 I/O）；rust-core 已自研 SMF 解析器，替换价值低 | crates.io 实测；`rust-core/src/main.rs` 自研 `parse_smf` | 实测 |
| 7 | 许可证雷区集中在渲染/PDF/UI 三处：**verovio 上游 LGPL-3.0（仓库现标 MIT）**、**MuPDF AGPL-3.0（禁用）**、**Slint GPLv3/署名条款** | `docs/licenses.md:42` 标 MIT；npm `verovio@6.4.0` license=LGPL-3.0-only；MuPDF `COPYING`=AGPL-3.0；Slint README 三许可 | 实测/文档 |
| 8 | 编解码专利：**MP3 核心专利 2017-04-23 全部到期**；**AAC 仍在 Via LA 专利池**（2026-03-09 仍在签约）；Opus/Vorbis/FLAC 专利免费 | Fraunhofer audioblog；Via LA 新闻稿；opus-codec.org/license | 文档 |

**一句话判断**：Rust 生态足以覆盖 FuFumidi 的"计算/IO 内核"，但覆盖不了"Chromium 级别的渲染与打印能力"和"Python 模型生态"；最划算的路线与仓库现状一致——继续做 rust-core 式的进程内/进程外内核替换，而不是整体重写。

## 1. crate 清单

数据来源（**实测**，2026-11-03）：
- crates.io 公开 API：`https://crates.io/api/v1/crates?q=<name>&per_page=5`（取同 id 命中项的 `max_stable_version` / `downloads` / `updated_at`）；
- GitHub 公开 API：`https://api.github.com/repos/<owner>/<repo>`（取 `stargazers_count` / `pushed_at` / `license.spdx_id`）。
- "最近发布"取 crates.io `updated_at`（近似为最近一次版本发布）；星数为 2026-11-03 抓取值。
- 成熟度口径：**1.0?** = 是否发布过 1.0 稳定版；**维护** = 近 12 个月是否有发布；**风险** 只写会让 FuFumidi 卡住的那一条。

### 1.1 GUI 外壳

| crate | 版本 | license | 成熟度 | 替代 FuFumidi 什么 | 能否覆盖现有能力 | 风险 |
|---|---|---|---|---|---|---|
| [tauri](https://crates.io/crates/tauri) | 2.12.5（2026-10-21） | MIT/Apache-2.0 | 112,461★，1.0+，高频 | Electron 外壳 | **部分**：窗口/菜单/托盘/对话框/更新器有；printToPDF、desktopCapturer、完整 Node 生态无 | 迁移=250 个 handler 重写；WebView 能力上限由系统决定 |
| [wry](https://crates.io/crates/wry) | 0.57.1 | Apache-2.0/MIT | 5,039★，<1.0 | Tauri 底层 WebView 封装 | 仅底层，不建议直接用 | API 未 1.0，随 Tauri 大版本漂移 |
| [egui](https://crates.io/crates/egui) | 0.37.0 | MIT/Apache-2.0 | 31,948★，<1.0 | 不替代：它是自绘 GUI | **不覆盖**：75,697 行 Vue 前端要重画 | 重写 UI = 重做产品，非性能改造 |
| [slint](https://crates.io/crates/slint) | 1.18.1 | GPLv3 / Royalty-free / 商业 | 24,369★，1.0+ | 同上（声明式自绘 UI） | 不覆盖；且 Royalty-free 要求 AboutSlint 署名 | 许可证需法务确认（见 §4） |
| [iced](https://crates.io/crates/iced) | 0.14.0 | MIT | 31,899★，<1.0 | 同上 | 不覆盖 | 生态小、控件缺 |

### 1.2 JS ↔ Rust 桥

| crate | 版本 | license | 成熟度 | 替代 FuFumidi 什么 | 能否覆盖现有能力 | 风险 |
|---|---|---|---|---|---|---|
| [napi](https://crates.io/crates/napi)（napi-rs） | 3.16.1 | MIT | 8,006★，1.0+ | 渲染进程热路径做成 N-API 原生模块 | **能**（Electron 下唯一低开销路径；ABI 稳定） | 需按 Electron 的 Node ABI 重编；跨平台预编译矩阵成本 |
| [wasm-bindgen](https://crates.io/crates/wasm-bindgen) | 0.2.130 | Apache-2.0/MIT | 9,216★，0.x 长期 | 浏览器/WASM 侧算法（MIDI 解析、DSP） | **能**（无需原生编译，打包简单） | 每次跨边界调用有开销；wasm 体积（§3.3） |
| [web-sys](https://crates.io/crates/web-sys) | 0.3.107 | Apache-2.0/MIT | 45,177 万下载量级 | Web Audio / Canvas / Worker 绑定 | 能，但只是"从 Rust 调浏览器 API" | 绑定爆炸式增长，编译时间高 |

### 1.3 异步与序列化

| crate | 版本 | license | 成熟度 | 替代 FuFumidi 什么 | 能否覆盖 | 风险 |
|---|---|---|---|---|---|---|
| [tokio](https://crates.io/crates/tokio) | 1.54.1 | MIT | 33,567★，1.0+ | 主进程里的并发下载/队列（现为 Node 事件循环） | 能 | 仅新写 Rust 侧才用得到 |
| [serde](https://crates.io/crates/serde) | 1.0.229 | MIT/Apache-2.0 | 10,931★，1.0+ | 全部 JSON 协议 | 能 | 无 |
| [rmp-serde](https://crates.io/crates/rmp-serde) | 1.3.1 | MIT | 1,425★ | 子进程 JSON 协议换成 MessagePack | 能（协议两端都要改） | 收益主要是大 payload（批量 MIDI 统计） |
| [bincode](https://crates.io/crates/bincode) | 3.0.0 | MIT | 3,060★，**仓库已归档**（pushed 2025-08-15） | 二进制序列化 | 能但**不建议** | 上游归档 = 无安全修复；选 postcard/rmp-serde |

### 1.4 MIDI

| crate | 版本 | license | 成熟度 | 替代 FuFumidi 什么 | 能否覆盖 | 风险 |
|---|---|---|---|---|---|---|
| [midly](https://crates.io/crates/midly) | 0.5.3 | Unlicense | 202★，**2023-01 后无发布** | SMF 读写/事件流 | 能（含 running status 解析） | 停更 3 年+；Unlicense 无担保条款；大文件性能待实测 |
| [wmidi](https://crates.io/crates/wmidi) | 4.0.11 | MIT | 103★，2026-04 有更新 | 实时 MIDI 消息（非 SMF 文件） | 部分（只管消息） | 星少；API 面窄 |
| [rimd](https://crates.io/crates/rimd) | 0.0.1（2016） | MIT | 84★，**2016 年后无发布** | SMF | 不推荐 | 事实死亡 |
| [midir](https://crates.io/crates/midir) | 0.11.1 | MIT | 835★，2026-10 有更新 | 硬件 MIDI 输入/输出（现由 Web MIDI/BASS 侧承担） | 能（原生设备枚举） | 独占端口、驱动差异需真机测 |

**实测补充**：`rust-core/src/main.rs` 已自研 `parse_smf`（支持 running status），且 `midi-stats` / `batch-stats` / `quantize-batch` / `transpose-batch` 都走同一解析器——引入 midly 只省维护，不新增能力。

### 1.5 音频解码 / 重采样 / DSP

| crate | 版本 | license | 成熟度 | 替代 FuFumidi 什么 | 能否覆盖 | 风险 |
|---|---|---|---|---|---|---|
| [symphonia](https://crates.io/crates/symphonia) | 0.6.1 | MPL-2.0 | 3,467★，1.0+ | Python 侧 soundfile/librosa 解码 | 部分：MP3/AAC/FLAC/Vorbis/WAV 解码齐 | MPL 文件级 copyleft；AAC 有专利（§4.3） |
| [cpal](https://crates.io/crates/cpal) | 0.18.2 | Apache-2.0/MIT | 4,009★，1.0+ | WebAudio 播放/录音后端 | **能**（WASAPI/CoreAudio/ALSA），**ASIO 需 Steinberg SDK** | ASIO 构建依赖非开源 SDK（cpal README）；延迟/独占需真机 POC |
| [rubato](https://crates.io/crates/rubato) | 5.0.1 | MIT | 365★，2026-10 有更新 | 采样率转换（现 Python/scipy 或浏览器） | 能 | 小众但 API 稳定；质量对 resampler 选择敏感 |
| [fundsp](https://crates.io/crates/fundsp) | 0.23.0 | Apache-2.0 | 1,231★，<1.0 | 实时 DSP/合成（效果器链） | 部分（自研 DSP 时用） | 0.x，API 变动 |
| [dasp](https://crates.io/crates/dasp) | 0.11.0（**2020-05**） | MIT/Apache-2.0 | 1,199★ | PCM/DSP 基础 trait | 部分 | crate 停更 6 年，慎选 |
| [ebur128](https://crates.io/crates/ebur128) | 0.1.11 | MIT | 133★，2026-10 有更新 | 响度标准化（导出/母带） | 能 | 0.1.x；只做测量不做处理 |
| [rodio](https://crates.io/crates/rodio) / [kira](https://crates.io/crates/kira) | 0.23.0 / 0.12.6 | Apache-2.0/MIT | 2,506★ / 1,076★ | 播放层（替代 WebAudio 调度） | 部分：适合新写播放器，不适合接现成音序器时钟 | 与现有 `fu-seq-clock` AudioWorklet 时钟模型不同 |

### 1.6 SF2 合成

| crate | 版本 | license | 成熟度 | 替代 FuFumidi 什么 | 能否覆盖 | 风险 |
|---|---|---|---|---|---|---|
| [rustysynth](https://crates.io/crates/rustysynth) | 1.3.8 | MIT（README 声明） | 235★，2026-10 有更新 | 现 `js-synthesizer` + `libfluidsynth 2.4.6` wasm | **能**：纯 Rust、SF2、含 reverb/chorus、MIT | 音色兼容/性能未对比 FluidSynth；待实测 |
| [oxisynth](https://crates.io/crates/oxisynth) | 0.1.0（2025-05） | 待核实（GitHub 无 license 识别） | 105★，0.1.0 | 同上 | 部分 | 语义版本 0.1、维护弱；许可证未确认前不可用 |
| （现状）js-synthesizer + libfluidsynth | 1.13.0 + 2.4.6 | MIT + **LGPL-2.1+** | — | 当前实际方案 | 已覆盖 | 见 §4.2 |

### 1.7 乐谱 / MusicXML / PDF

| crate | 版本 | license | 成熟度 | 替代 FuFumidi 什么 | 能否覆盖 | 风险 |
|---|---|---|---|---|---|---|
| [musicxml](https://crates.io/crates/musicxml) | 1.1.2 | MIT | **19★**，2024-11 后无发布 | MusicXML 解析/导出 | 部分：只做数据模型，不做排版 | 星极少、停更；排版仍要靠 verovio |
| [verovio](https://crates.io/crates/verovio)（ro-ag/verovio-rs） | 0.3.6（2026-06 首发） | 待核实 | **0★**，359 次下载 | 现 verovio 6.3.0 wasm（7.31MB） | 部分：C++ 绑定，仍需 CMake 构建 | 实验性；上游 verovio 是 **LGPL-3.0** |
| [pdfium-render](https://crates.io/crates/pdfium-render) | 0.9.5 | MIT/Apache-2.0（PDFium 本体 BSD-3） | 717★，2026-11 有更新 | 现 `pdfjs-dist`（前端渲染 PDF） | 部分：可渲染/栅格化，需分发 PDFium 动态库 | 多 10MB 级原生库；专利/出口条款按 PDFium 处理 |
| [mupdf](https://crates.io/crates/mupdf) | 0.8.0 | **AGPL-3.0** | 215★ | — | **禁用** | AGPL 传染，MIT 分发包不可用 |

### 1.8 机器学习推理

| crate | 版本 | license | 成熟度 | 替代 FuFumidi 什么 | 能否覆盖 | 风险 |
|---|---|---|---|---|---|---|
| [ort](https://crates.io/crates/ort) | **2.0.0-rc.15**（stable=null） | MIT/Apache-2.0 | 2,605★，rc 已 18 个月 | Python `onnxruntime`（11 个 engine 文件在用） | **能**：同一 ORT 引擎，无推理加速，只省 Python 进程 | 无稳定版；ORT 动态库分发与 CPU/GPU provider 组合 |
| [candle-core](https://crates.io/crates/candle) | 0.11.1 | Apache-2.0/MIT | 21,271★，<1.0 | torch 模型（RVC/DiffSinger/MuScriptor） | **不覆盖**：需模型换格式重写前向 | 0.x；算子覆盖不全 |
| [tch](https://crates.io/crates/tch) | 0.26.0 | MIT/Apache-2.0 | 5,517★ | 同上（加载 TorchScript） | 部分：现模型是 Python 类定义，不是 TorchScript | 需先导出 TorchScript；libtorch 体积巨大 |
| [tract-onnx](https://crates.io/crates/tract) | 0.23.9 | MIT/Apache-2.0（待核） | 3,112★，2026-11 有更新 | 纯 Rust ONNX 推理（无 ORT 依赖） | 部分：算子覆盖与量化支持待实测 | 性能/算子覆盖不及 ORT |
| [burn](https://crates.io/crates/burn) / [whisper-rs](https://codeberg.org/tazz4843/whisper-rs) | 0.22.1 / 0.16.0 | Apache-2.0/MIT / 待核 | 16,223★ / 1,030k 下载 | 转录（whisper.cpp 绑定） | 部分 | 换引擎=改模型与后处理，非纯语言迁移 |

### 1.9 数据 / 网络 / 系统 / 其它

| crate | 版本 | license | 成熟度 | 替代 FuFumidi 什么 | 能否覆盖 | 风险 |
|---|---|---|---|---|---|---|
| [rusqlite](https://crates.io/crates/rusqlite) | 0.41.1 | MIT | 4,461★，1.0+ | 现 `sql.js`（WASM SQLite，见 `package.json`） | 能（bundled SQLite） | 需迁移二进制 DB / 双写验证 |
| [redb](https://crates.io/crates/redb) | 4.4.0 | Apache-2.0/MIT | 4,892★，1.0+ | 键值存储（预设/索引） | 能 | 无 SQL，查询要改写 |
| [sled](https://crates.io/crates/sled) | 0.34.7（2024-10） | Apache-2.0/MIT | 9,104★，<1.0 | 键值存储 | 能但**不建议** | 1.0 多年未发；维护节奏慢 |
| [reqwest](https://crates.io/crates/reqwest) | 0.13.5 | MIT/Apache-2.0 | 11,895★，1.0+ | `main/fast-download.js` 的 HTTP 层 | 能（含流式/超时/TLS） | 现有 JS 下载器已有测速/分段/看门狗，重写要重测全部边界 |
| [hyper](https://crates.io/crates/hyper) | 1.12.0 | MIT | 16,393★，1.0+ | 同上（更底层） | 能用但没必要 | 直接用 reqwest 即可 |
| [zip](https://crates.io/crates/zip) / [zstd](https://crates.io/crates/zstd) | 9.3.0 / 0.14.3 | MIT / MIT（GitHub 标 BSD-3） | 328M / 458M 下载 | `adm-zip`/`yauzl`/7z 解包 | 能 | 7z 需另找 crate；zip-slip 防护逻辑要移植 |
| [image](https://crates.io/crates/image) / [resvg](https://crates.io/crates/resvg) / [tiny-skia](https://crates.io/crates/tiny-skia) | 0.25.10 / 0.49.0 / 0.12.0 | MIT/Apache-2.0 / Apache-2.0 / BSD-3 | 主流 | 封面/壁纸缩略图、SVG 渲染 | 能 | 与 Chromium 渲染一致性有差异 |
| [notify](https://crates.io/crates/notify) / [tracing](https://crates.io/crates/tracing) / [sentry](https://crates.io/crates/sentry) | 8.2.1 / 0.1.44 / 0.49.5 | MIT/Apache-2.0 / MIT / MIT | 主流 | 文件监听 / 日志 / 遥测 | 能 | 需替换现有 `main/log.js` 与崩溃上报 |
| [windows](https://crates.io/crates/windows) / [winreg](https://crates.io/crates/winreg-rs) | 0.62.2 / 0.56.0 | MIT/Apache-2.0 / MIT | 12,894★ / 194★ | 注册表文件关联、Windows 专有能力 | 能 | 只在 Windows 生效（与现状一致） |

## 2. 同类改造案例

> 筛选原则：优先一手来源（官方工程博客/仓库/ADR）；个人博客标"未复现"；找不到可信数字的案例宁可不写。

### 2.1 本仓库自己的反例：`src-tauri/` 已冻结（**与本项目最相关**）

- **范围**：Electron 主进程 → Tauri 2 的分阶段移植，含 20 个 `src-tauri/src/*.rs` 模块（db/engine/models/plugins/presets/score/video/wallpaper/updater…）。
- **实测规模**：`grep 'ipcMain.handle'` = **250** 个；`#[tauri::command]` = **76** 条；`preload.js` 中 `ipcRenderer.invoke` = **255** 处；`frontend/src/bridge/tauri.js` = 9,386 B。
- **冻结事实**（文档）：`docs/FOUNDATION.md:101-107` 写明"已冻结，不是备用外壳"，版本停在 `Cargo.toml` 3.1.8 / `tauri.conf.json` 3.1.16（应用 6.4.2），CI/打包引用数为 0（`electron-builder.yml` 明确 `!src-tauri/**`）。
- **教训**：**迁移进度 ~30%（76/250）时被冻结**，因为"每个模块都要重写 + 主进程还在高速演进"两件事叠加。这正是"壳迁移"与"内核替换"的成本差：详见 §2.4。
- **可信度**：仓库内一手证据（实测 + 文档），无需外部复现。

### 2.2 Tauri vs Electron 空应用基准（第三方社区基准）

- 来源：[Elanis/web-to-desktop-framework-comparison](https://github.com/Elanis/web-to-desktop-framework-comparison)（仓库公开源码与测法）。
- **数字（实测抓取该 README）**：Windows x64 构建体积 **Electron ≈373MB vs Tauri ≈3MB**（NW.js ≈572MB、Wails ≈11MB、NodeGui ≈171MB、Neutralino ≈2MB）；macOS arm64 **Electron ≈268MB vs Tauri ≈5MB**。
- **范围/局限**：仅"空应用 + 打包体积"，不含真实依赖、音色库、Python 运行时；**不代表 FuFumidi 的包体会从 606MB 掉到 5MB**。
- **对本项目的意义**：上界收益≈Electron 运行时（约 150–250MB 解压后，压缩后几十~一百多 MB），而本仓库 `resources`=1.4G、安装包 606MB 已由 `resources/python`（1.2G）主导——**换壳对"装完占多大"几乎无感**（推断）。
- **可信度**：社区基准，方法透明、可复跑；作者非 Tauri/Electron 官方。

### 2.3 Paseo：Tauri → Electron 回流（反例，2026-05-28）

- 来源：[getpaseo/paseo · posts/i-was-wrong-about-electron.md](https://github.com/getpaseo/paseo/blob/20d7efc46a316f5a274b9943a5c43b0322269825/packages/website/posts/i-was-wrong-about-electron.md)。
- **故事**：先选 Tauri（理由：Rust、小包体、低内存），Windows 尚可，**Linux 崩在 WebKitGTK 绑定过旧 + Wayland + 布局差异**；通知点击回调桌面端缺失（官方 issues #2150）；Node daemon 用 sidecar 打包"变成了另一个项目"（多目标三元组、权限、升级）。最终回 Electron。
- **数字/耗时**：迁移回 Electron "一周扎实工作"；原文自评 "At some point I had the realization that I was building Electron with extra steps."
- **教训**（对 FuFumidi 直接可用）：① 小包体优势在真实产品里会被"平台差异 + 插件缺口"吃掉；② 一旦有常驻 sidecar（FuFumidi 有 Python 引擎），就把 Node 运行时缺失的成本补回来了；③ 通知/托盘/快捷键这类"桌面能力"是 Tauri 插件成熟度的真实短板。
- **可信度**：项目官方 repo 内文章（个人视角），**未复现**。

### 2.4 Dropbox Nucleus：换内核不换壳（4 年，成功）

- 来源：[Rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)（Dropbox 官方工程博客，2020-10）。
- **范围**：只重写桌面客户端同步引擎（"Nucleus"），UI/外壳/产品形态不变；"over the past four years" 完成并全量发布。
- **原文要点**："Rewriting the sync engine was really hard, and we don't want to blindly celebrate it, because in many environments it would have been a terrible idea. It turned out that this was an excellent idea for Dropbox, but only because we were very thoughtful..."；成功要素 = 干净的数据模型 + 增量交付。
- **对本项目的意义**：与 FuFumidi 的 `rust-core` 同构——**换内核、留外壳、渐进交付**。反过来，整体重写（§2.7、§3.1）风险最高。
- **可信度**：官方一手；具体性能数字原文未给可比指标（团队规模未公开）。

### 2.5 Astral uv：Python 工具链 Rust 化（8–10x / 80–115x）

- 来源：[uv: Python packaging in Rust](https://astral.sh/blog/uv)（Astral 官方博客，2024-02）。
- **数字**：官方基准 "uv is 8-10x faster than pip and pip-tools without caching, and 80-115x faster when running with a warm cache"。
- **范围**：以 Rust 重写一个 Python 工具链（CLI 工具，不是 GUI）。
- **教训**：Rust 化收益最大的是**无状态、CPU/IO 密集、纯逻辑**的部分；与 GUI 无关。uv 还从零设计了新工具，而不是"在旧 Python 代码上打补丁"。
- **可信度**：官方博客 + 公开基准方法；竞争对手未复现。

### 2.6 whisper.cpp：Python 推理 → 原生（>3x，非 Rust）

- 来源：[ggml-org/whisper.cpp README](https://github.com/ggml-org/whisper.cpp)。
- **数字**：README 官方描述 Core ML 编码器推理 "more than x3 faster compared with CPU-only execution"（Apple Silicon）；并移除 Python 运行时依赖。
- **与 Rust 的关系**：同类收益可以由 `whisper-rs` / `ort` 复制，但它证明的是"**模型换运行时**"的收益，不是"Rust 语言更快"。
- **对 FuFumidi**：其转录栈已经是 ONNX Runtime（`engine/requirements-bundle.txt:onnxruntime>=1.16`，11 个文件在用），换成 Rust `ort` **不会让推理变快**（同一引擎）；唯一收益是去掉 Python 进程与启动开销（推断）。
- **可信度**：官方 README；与 Python 原版的端到端对比未在 README 中给出统一口径。

### 2.7 Deno：Rust → JavaScript 的**反向**重构（反例）

- 来源：[denoland/deno PR #32543](https://github.com/denoland/deno/pull/32543) "refactor(core): move timer processing from Rust to JavaScript"。
- **实测补丁规模**（`patch-diff.githubusercontent.com/.../32543.patch`，截断于 100KB）：**15 个 commit、≥34 个文件、+839/−976 行**；提交序列包括 `remove op_timer_queue`、`remove old WebTimers infrastructure` 等。
- **意义**：成熟项目会把部分 Rust 实现**移回 JS**以换取可维护性/一致性——"Rust 一定更好"不成立；方向选择取决于边界成本而不是语言优劣。
- **可信度**：仓库 PR 一手证据（实测补丁统计）。

### 2.8 Tauri 的 print-to-PDF 缺口（与 FuFumidi 直接相关）

- 来源：[Tolaria ADR-0136: macOS Webview PDF Export](https://github.com/refactoringhq/tolaria/blob/8296046f683a6c14df00eaaaae8e39d1c66dbd51/docs/adr/0136-macos-webview-pdf-export.md)。
- **事实**：Tauri 的 webview 原生 print 在 macOS 会弹打印对话框；项目为"直接存 PDF"不得不直接依赖 `objc2`/`objc2-web-kit` 调 `WKWebView`+`NSPrintOperation`；**Windows/Linux 只能回退打印对话框**。
- **对 FuFumidi 的意义（实测前提）**：主进程有 **2 处 `printToPDF`**；若迁移 Tauri，这两条导出路径要么用 WebView2 COM 自行实现、要么换渲染引擎（如嵌入 Typst），都不是"平移"。
- **可信度**：第三方项目 ADR，未在本仓库复现；但"Tauri 无 Chromium 式 printToPDF"与 Tauri 文档一致（推断）。

## 3. 反例与警告

### 3.1 重写陷阱与第二系统效应

- 经典反例：Netscape 6 从零重写（[Joel Spolsky, 2000](https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/) 原文：Netscape "decided to rewrite the code from scratch ... the single worst strategic mistake"）。
- 本项目版本：`src-tauri` 在应用 3.1.x → 6.x 的过程中停在 3.1.8，主进程 handler 从 157 涨到 250——**迁移目标在动，迁移物不动**（文档+实测）。
- 判别法：如果"重写期间的 feature 流速"必须保持不变，重写几乎必然烂尾；Dropbox 做法是**只重写一个边界清晰的内核**并允许增量交付。

### 3.2 FFI 边界成本（napi / wasm）

- napi-rs：跨语言调用是函数调用级开销，但每次都要**编组**（字符串/数组/对象），大 payload（如整首 MIDI 的 note 数组）应传 ArrayBuffer 而非对象树（推断）。
- wasm-bindgen：每次调用有 JS↔wasm 边界成本，且 wasm 内存不能直接被 JS 持有；热路径要"一次调用处理整批"（推断）。
- **待实测**：用 `rust-core` 现有 `batch-stats` 对同一目录做 JS 与 Rust 计时对比（`scripts/test-rust.ps1` 已有测试入口）。

### 3.3 wasm 体积与启动

- 仓库实测：`frontend/public/vendor/verovio-toolkit-wasm.js` = **7,310,681 B**、`libfluidsynth-2.4.6-with-libsndfile.js` = **2,371,528 B**（`docs/VENDOR.md` 清单）。
- 含义：乐谱渲染/合成器这两个"看起来适合 Rust 重写"的模块，**现有 wasm 已经是 MB 级**；Rust 重写不会让体积变小，反而可能因 wasm-bindgen glue 增加（推断）。若做 wasm 方案，必须接受首屏加载 MB 级与编译产物体积。

### 3.4 Tauri WebView 差异（平台风险）

- 官方文档 [Webview Versions](https://v2.tauri.app/reference/webview-versions/)：Windows=WebView2（Chromium，Win11 预装、旧系统由安装器补）、macOS=WKWebView、Linux=**webkit2gtk**；Tauri **不打包** webview。
- 对本项目：`docs/CROSS-PLATFORM.md` 已写明 Windows 是唯一正式发布平台、mac/Linux 仅 dev——换 Tauri 等于把"Windows 单一平台"扩展为"三套 webview 三套渲染差异"，与 Paseo 的 Linux 踩坑同构（§2.3）。
- WebView2 是 Chromium，Windows 下渲染与 Electron 接近，但**生命周期由系统管理**（旧版 WebView2 Runtime 可能被用户锁定），CI 无法固定内核版本（推断）。

### 3.5 哪些场景 Rust 反而更慢/更贵

| 场景 | 为什么 Rust 不划算 | 证据/等级 |
|---|---|---|
| 现有 Vue3 前端（75,697 行、23 个视图） | 重画 UI = 重做产品；egui/slint/iced 都无法复用 CSS/组件生态 | 实测行数（`frontend/src`） |
| Python ML 模型（RVC/DiffSinger/MuScriptor） | 模型是 Python 类定义+自定义算子，不是 ONNX/TorchScript；需换框架+重训验证 | `engine/requirements-bundle.txt`；torch 3 文件（实测） |
| 编译期迭代 | Rust 增量编译显著慢于 Vite HMR；大 crate 图（tauri+web-sys）更明显 | **待实测**（需本机 POC 计时） |
| 乐谱排版/PDF 渲染 | verovio/pdfium 已是成熟 C++；Rust 侧只有实验性绑定，重写等于重做排版引擎 | §1.7 |
| 一次性/低调用频率逻辑（设置、i18n、向导） | 迁移成本 > 运行收益 | 推断 |
| 需要 Chromium 独有能力（printToPDF、desktopCapturer、完整 DevTools） | Tauri/系统 webview 无等价物 | §2.8；实测 printToPDF 2 处 |

## 4. 许可证与合规

### 4.1 关键许可证一览

| 组件 | 许可证 | 对 MIT 分发的影响 | 动作 |
|---|---|---|---|
| Tauri / wry | MIT / Apache-2.0 | 兼容 | 保留版权与许可文本 |
| Electron | MIT | 兼容 | 保留 LICENSE |
| verovio（上游 wasm） | **LGPL-3.0-only** | **弱/强 copyleft 边界**：动态加载的 wasm 通常按 LGPL 处理，需随包提供许可证与"可替换/可重链接"途径 | **先纠正 `docs/licenses.md:42` 的 MIT 标注**；补 LGPL 文本与源码获取说明；考虑仅"按需下载"该 wasm |
| libfluidsynth（wasm） | **LGPL-2.1+** | 同上 | `docs/licenses.md:43-45` 已标 LGPL，需补许可证文本随包分发 |
| MuPDF / mupdf-rs | **AGPL-3.0** | **不可用于 MIT 分发包**（除非商业授权） | 不引入；PDF 一律走 pdfium/pdf.js |
| Slint | GPLv3 / Royalty-free（需 AboutSlint 署名）/ 商业 | Royalty-free 可用但**有署名义务** | 若选 Slint，需在"关于"加 AboutSlint；法务确认 |
| Symphonia | MPL-2.0 | 文件级 copyleft：修改其源文件才需开源 | 不魔改即可；随包附 MPL 文本 |
| rustysynth / midly / wmidi / midir | MIT / Unlicense / MIT / MIT | 兼容 | Unlicense 需注意无担保条款 |
| bincode | MIT（仓库已归档） | 兼容 | 建议换 crate |
| 现有音色库（4 项 GPL-3.0） | **GPL-3.0** | 与 MIT 应用随包分发存在冲突风险（需复核具体库的"音色库例外"） | 见 §4.2 |

### 4.2 仓库已有资产的合规问题（Rust 改造不会自动解决）

| 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|
| verovio 标注错误 | `docs/licenses.md:42` 写 MIT；npm `verovio@6.4.0` `license=LGPL-3.0-only`，上游 GitHub license=LGPL-3.0（实测） | 随包 wasm 的许可证义务未履行 | 改为 LGPL-3.0-only，补 LICENSE 与源码链接 |
| 4 个内置音色库为 GPL-3.0 | `docs/licenses.md:28,30,31,32`（FM/GM 紧凑版、雅马哈 C5、Galaxy 电钢琴、Supersaw） | 随 MIT 应用分发 GPL 素材可能触发传染/再分发义务 | 逐个确认上游条款（部分 SF2 有"音色库例外"）；不能确认的移出内置包、改按需下载 |
| libfluidsynth（wasm）LGPL | `docs/licenses.md:43-45` | LGPL 义务（文本、可替换） | 随包附 LGPL-2.1 文本与来源说明 |
| 打包内的 ffmpeg / Python 运行时 | `engine/requirements.txt` 注释提到内置静态 ffmpeg；`resources/python`=1.2G | ffmpeg 构建的 GPL/LGPL 配置决定整个包的分发义务 | 核对实际内置 ffmpeg 的 `--enable-gpl` 状态并记录进 `docs/licenses.md`（**待实测**） |

### 4.3 音频编解码专利（分发视角）

| 格式 | 专利状态 | 依据 | 对 FuFumidi 的建议 |
|---|---|---|---|
| MP3 | **核心专利 2017-04-23 全部到期**，Fraunhofer/Technicolor 授权项目终止 | [Fraunhofer audioblog, 2017-05-18](https://www.audioblog.iis.fraunhofer.com/mp3-software-patents-licenses) "the last of the core mp3 patents ... expired" | 可安全解码/编码（仅剩商标与旧库存问题） |
| AAC | **仍在专利池**：Via LA 的 AAC 池 2026-03 仍在签约（HONOR 加入，移动市场渗透 >80%） | [Via LA 新闻稿, 2026-03-09](https://www.via-la.com/via-licensing-alliance-welcomes-honor-as-advanced-audio-coding-patent-pool-licensee/) | **不要自带 AAC 解码器分发**；AAC/M4A 走用户自备 ffmpeg 或系统解码，并在文档声明 |
| Opus | 专利免费，BSD 参考实现，自动授权 | [opus-codec.org/license](https://opus-codec.org/license/) | 新功能优先 Opus |
| Vorbis / FLAC | 专利免费（Xiph） | 同上类 | 优先 |
| WAV | 无专利 | — | 导出默认 |

**结论**：Rust 侧的 `symphonia` 支持 AAC 解码，但**专利风险在编解码器而不在 crate**；若改为 Rust 内置解码，AAC 的授权问题会从"用户环境"变成"我们分发"，风险升级。

### 4.4 给 MIT 分发应用的 5 条合规提示

1. 新增任何 crate 前先跑 `cargo license`/人工核对：**AGPL/GPL 一律禁入**（含间接依赖，如 mupdf / 某些 GPL 音频库）。
2. LGPL（verovio/libfluidsynth/ffmpeg）→ 随包附许可证文本 + 提供可替换/源码获取路径；能"按需下载"就不内置。
3. 音色库/模型是**独立授权资产**，不要因为"代码是 MIT"就默认可随包分发。
4. AAC 解码不要内置；MP3 可以（专利已过期），但仍需保留 Fraunhofer 的说明。
5. 每次新增 vendor 二进制/模型，同步更新 `docs/VENDOR.md` 与 `docs/licenses.md`（仓库已有 `npm run check:licenses` 门禁，见 `docs/licenses.md:3`）。

## 5. "不要搬"清单

| # | 不要搬 | 理由 | 替代做法 |
|---|---|---|---|
| 1 | Vue3 前端（75,697 行 / 23 视图）到 egui/slint/iced | 等于重做产品；CSS/组件/i18n/可访问性全部重来 | 保留 Web 前端；用 napi/wasm 只换热路径 |
| 2 | Python ML 推理整体搬 Rust | 模型是 Python 类+自定义算子；ONNX 换 `ort` 不提速；torch 只 3 文件但都是重模型 | 保留 Python 引擎；先做运行时瘦身/按需加载（见 03 篇） |
| 3 | 乐谱排版（verovio wasm）自己重写 | 上游 LGPL + 7.31MB wasm + 多年排版规则积累 | 继续用 verovio；只把调用边界收窄/按需下载 |
| 4 | PDF 渲染/导出换 MuPDF | AGPL 传染，MIT 分发不可用 | 保持 pdfjs-dist + Electron printToPDF；Tauri 路线需先用 WebView2 COM/Pdfium 做 POC |
| 5 | 自研 SMF 解析器换 midly | rust-core 已有经测试的统一解析器（含 running status），midly 2023 后停更 | 保留 `rust-core` 解析器；只在需要更多 SMF 特性时评估 |
| 6 | 现有 `fast-download.js` 下载器 | 测速/分段/续传/看门狗/完整性是多年踩坑产物（见 `docs/DOWNLOADS.md`） | 不重写；若要 Rust 化，先做等价测试集 |
| 7 | 音色库/模型资产格式改造 | 授权与体积都不允许随意重打包 | 保持 SF2/ONNX 原格式 |
| 8 | Tauri 壳整体迁移（当前阶段） | 已冻结一次（76/250）；主进程仍在快速演进；WebView 能力缺口真实存在 | 用 `rust-core` 子进程/未来 napi 模块增量替换；先做 §7 的 POC 再谈拍板 |

## 6. 版本时效与检索方法

- **检索日期：2026-11-03**（本机时间 Asia/Shanghai）。所有版本号/星数为当日 API 返回值，**任何一周后都可能变化**，方案落地前需重查。
- crates.io 查询（实测）：`GET https://crates.io/api/v1/crates?q=<name>&per_page=5`；版本细节用 `GET https://crates.io/api/v1/crates/<name>/versions?per_page=6`。
- GitHub 查询（实测）：`GET https://api.github.com/repos/<owner>/<repo>`（注意未认证限流 60 次/小时；本次分两批抓取）。
- 易过时项（方案里引用时建议带日期）：Tauri 2.12.5、wry 0.57.1、egui 0.37.0、iced 0.14.0、bincode 3.0.0（仓库归档）、ort 2.0.0-rc.15、verovio 上游 6.4.0。
- 反面提醒：本项目分支/版本是 6.4.2；`src-tauri` 停在 3.1.8，**不要把冻结壳的旧结论当成"Tauri 2 现在的能力"**。

## 7. 未解决 / 待实测

1. **rust-core 实测收益**：对同一批 MIDI 目录比较 JS 解析 vs `rust-core batch-stats`/哈希的耗时与内存（待实测；现有 `npm run test:rust` 可扩展成基准）。
2. **napi-rs vs wasm 方案**：以"MIDI 解析 + 波形计算"两个热路径做 POC，量边界开销与打包体积（待实测）。
3. **Tauri printToPDF / desktopCapturer 等价性**：在 Windows WebView2 上能否用 COM 接口无用户交互导出 PDF；若不能，score/PDF 导出功能在 Tauri 路线不可行（待实测，参考 §2.8）。
4. **ASIO 可行性**：cpal 的 ASIO 后端需要 Steinberg ASIO SDK（非开源）与 LLVM/Clang；公司与个人分发条款需核对（待核实）。
5. **rustysynth vs libfluidsynth 音色/性能对比**：同 SF2、同 MIDI 的渲染时延与听感 A/B（待实测）。
6. **torch 模型能否导出 ONNX/TorchScript**：逐个模型（RVC/DiffSinger/MuScriptor）评估导出可行性（见 03 篇，待实测）。
7. **现有 GPL 音色库条款**：4 项 GPL-3.0 内置资产是否真有"音色库例外"（待核实，可能要联系上游）。
8. **AAC 授权**：若未来内置解码，需法务评估 Via LA 池授权成本（待核实）。
9. **编译时间成本**：Rust + tauri/web-sys 依赖图的干净构建/增量构建时间（待实测，需本机 POC）。

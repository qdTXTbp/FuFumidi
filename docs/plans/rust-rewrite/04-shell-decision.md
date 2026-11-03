# 04 · 外壳与打包决策：Electron 保留 / Tauri 2 迁移 / 全原生 UI

> 仓库：`E:/Midi/FuFumidi-Source`（分支 `feat/audio-tagger-auto-probe`，版本 6.4.2，HEAD `99cbe75`，调研日 2026-11-03）。
> 方法：只读源码 + git 历史 + 构建产物度量。**未**运行 GUI、未安装依赖、未改动仓库内任何 app 代码（本文件除外）。
> 证据标注：**实测**＝本次命令/脚本输出；**文档**＝仓库内文档或官方文档原文；**源码**＝文件:行；**推断**＝未实测推理；**待实测**＝必须跑一次才知道。
> 边界：本文件只回答"外壳与打包"。性能基线见 `01-perf-evidence.md`，前端热路径见 `02-frontend-hotpaths.md`，Python/ML 边界见 `03-engine-ml-boundary.md`，生态与案例见 `05-ecosystem.md`。

---

## 0. 结论摘要

| # | 结论 | 一句话依据 |
|---|---|---|
| 1 | **推荐 A：保留 Electron，把 Rust 做成内核（sidecar 优先、napi 备选）** | 加权 402/500（80.4%）；B 与 C 都只有 ~51% |
| 2 | **不推荐 B（迁 Tauri 2），且不建议"边做边看"** | 250 个 IPC 通道里 Tauri 侧只覆盖 76 条（30.4%，实测），剩余 70% 恰好是最贵的 5 个模块 |
| 3 | **不推荐 C（egui/slint/iced 全原生 UI）** | 前端 75,872 行 + 250 通道全部重写，且无障碍/IME/3D 可视化/乐谱排版生态直接归零 |
| 4 | 换外壳**解决不了这个项目的体积问题** | 安装后 1,746 MB 里 Electron 本体约 250 MB（14%），python 运行时 1,101 MB（63%）——省下外壳只换来 14% |
| 5 | 换外壳**也不是当前性能瓶颈** | 仓库自己的审计结论：主进程启动开销约 100 ms 量级，"不是首屏瓶颈"（`docs/audit/2026-10-29/backend-perf.md:155`） |
| 6 | Tauri 路线的真实成本被 2026-08 那次"一次性移植"严重低估 | 76 条命令 = 3,681 行 Rust（实测）；全量 250 条按同密度约 12,100 行，但剩余的是更新链/插件沙箱/下载器/壁纸引擎/printToPDF |
| 7 | 2026-10-06 的冻结决定**是对的吗？——是，但表述不完整** | 冻结理由只有"版本落后 + 覆盖不足"；真正让它回不去的是**更新链与插件沙箱在 Tauri 下没有等价物**（本文件 §2、§5） |
| 8 | 现状有一处**对外表述与事实不符** | 官网仍写"Rust · Tauri 桌面核心"（`docs/pages/index-zh.html:733`、`docs/pages/index-en.html:670`），而 src-tauri 已冻结、覆盖 30% |
| 9 | A 方案的最小可用版本**已经有半成品** | `rust-core`（v0.2.0，7 条命令）+ `main/rust.js`（88 行 sidecar 桥）已随包分发（`electron-builder.yml:131-133`） |
| 10 | 最贵的一件事不是写 Rust，是**保住 250 条 IPC 契约与更新链** | 见 §5 的 5 个最贵模块与 §6 的人日表 |

---

## 1. 口径对齐：76 / 157 / 248 / 250 / 252 到底各是什么

这一节先说清楚数字，否则后面所有比例都是错的。

| 数字 | 出处 | 它数的到底是什么 | 时间 | 现在还算数吗 |
|---:|---|---|---|---|
| **76** | `src-tauri/src/lib.rs:24-100` | `#[tauri::command]` 的注册条数（`invoke_handler(generate_handler![...])` 展开项） | 2026-10-01 | 是（实测 76） |
| **157** | `docs/FOUNDATION.md:102` | "主进程 157 条 `ipcMain.handle`" | 2026-10-06 | **否**（当时快照） |
| **248** | `docs/audit/2026-10-29/backend-perf.md:181` | 同一口径的双向差集结果（preload 248 ↔ main 248） | 2026-10-29 | **接近但不精确** |
| **250** | 本文件实测 | `ipcMain.handle('x')` 唯一通道数（含 `main/autosave.js:118-125` 的 4 条双引号写法） | 2026-11-03 | 是 |
| **252** | 本文件实测 | 250 条 handle + 2 条 `ipcMain.on`（`app:event` / `app:renderer-ready`） | 2026-11-03 | 是 |
| **252** | 本文件实测 | `preload.js` 里 `ipcRenderer.invoke/send` 的唯一通道数 | 2026-11-03 | 是 |
| **28** | 本文件实测 | 主→渲染事件通道（`ipcRenderer.on`） | 2026-11-03 | 是 |

**实测方法（可复现）**：正则扫 `main/**/*.js` + `main.js` 的 `ipcMain.handle(\s*["']([^"']+)["']` 去重；扫 `preload.js` 的 `ipcRenderer.(invoke|send)` 去重；两边做差集。

**实测结论**：

- preload 声明但 main 无 handler：**0**
- main 有 handler 但 preload 未引用：**0**
- 也就是说 `docs/FOUNDATION.md:27-30` 的"新能力三处同改"在 **250 条**上是真的守住了（与 backend-perf §4.1 的结论一致，只是数字从 248 修正到 250/252）。

**口径对齐后的覆盖率**：

| 口径 | Tauri 覆盖 | 覆盖率 | 说明 |
|---|---:|---:|---|
| 按命令数 / 通道数 | 76 / 250 | **30.4%** | 最宽松口径 |
| 按"有对应 .rs 模块"（本文件实测映射） | 111 / 250 | 44.4% | 但含"同名不同功能"的假覆盖 |
| 按"功能等价"（源码逐条核对后） | 约 90 / 250 | **约 36%** | 见 §3.3 的三处明示缺口 |

> 结论：**"76 条命令"这个数字在对外沟通里被当成了进度条，但它其实是"简单 30%"**。剩下的 70% 包含了全部 5 个最贵模块。

---

## 2. 现状盘点：Electron 侧必须保留的系统集成能力清单

前提：这是 6.4.2 的真实现网能力，不是设想。逐项给文件:行、是否 Windows-only、以及 Tauri 2 的等价性判定。

判定图例：**有**＝官方能力或核心 API；**需插件**＝官方插件；**需自研**＝要自己写 Rust/Windows 代码；**不可能**＝语义上无法等价。

| # | 能力 | Electron 实现（文件:行） | Win-only | Tauri 2 等价性 | 证据来源 |
|---:|---|---|:--:|---|---|
| 1 | 主窗口 / 全屏 / 无菜单栏 | `main/window.js:10-43`、`main.js:253`、`main/system-ipc.js:54` | 否 | 有 | 源码 + 官方 WebviewWindow API（文档） |
| 2 | 双段式启动（品牌 splash → 迁移进度窗 → 主窗） | `main/window.js:47-58`、`main/splash.html`（49 KB）、`main.js:462-471` | 否 | 有（官方 Splashscreen 指南），需自研两段式编排 | 文档 |
| 3 | 系统托盘（显示/播放暂停/下一首/退出 + 关闭到托盘） | `main.js:275-314` | 否 | 有（TrayIcon 核心 API） | 文档 |
| 4 | 单实例锁 + second-instance 转发 argv | `main.js:126-135` | 否 | 需插件（`tauri-plugin-single-instance`） | 官方文档 v2.tauri.app/plugin/single-instance |
| 5 | .mid/.midi 文件关联，且**运行期可开关** | `main/settings-ipc.js:63-92`（reg.exe 写 HKCU）、`:97-108`（每次启动 applyFileAssoc） | **是** | **需自研**：`bundle.fileAssociations` 只在安装期写注册表；deep-link 插件明确"运行期不可注册" | 源码 + 官方 deep-linking 文档（"Deep links must be registered in config. Dynamic registration at runtime is not supported."） |
| 6 | 自定义协议 / 深链 | **实测 0 处**（`setAsDefaultProtocolClient` 全仓 0 命中） | — | 不构成需求 | 实测 |
| 7 | 自动更新：双通道 + 10 个下载源 + 增量安装 + 重启守护 | `main/update.js:18-41`、`:302-320`、`:427-...`、`build/kachina.config.json`（85 行，10 源） | **是** | **需插件 + 大量自研**：`tauri-plugin-updater` 强制签名、Windows 只有 passive/basicUi/quiet 三种 installMode、**无增量 patch**、**无多源测速**、**无 ignoreFolderPath 语义** | 源码 + 官方 updater 文档 |
| 8 | 更新包签名（Ed25519 规范串 + 内嵌公钥） | `main/update_sign.js:17-78` | 否 | 需插件（换 minisign 算法），且**老版本只认老公钥**，迁移期必须双签名 | 源码 + `docs/UPDATE-SIGNING.md:45-52` |
| 9 | 线路测速（首字节延迟 + 速率 + "必须是 MZ 头"防镜像劫持） | `main/update.js:55-60`、`:252-320` | 否 | 需自研 | 源码 |
| 10 | 通用下载器（分段并发/续传/看门狗/完整性/多文件/磁盘预检） | `main/fast-download.js`（721 行，`:110` 工厂） | 否 | **需自研**（reqwest + tokio），这是全仓唯一允许取字节的入口（`docs/FOUNDATION.md:40-44`） | 源码 + 文档 |
| 11 | Python 引擎子进程（spawn / worker / inline / 常驻） | `main/engine.js:51`、`:139`、`:288`、`:323` | 否 | 有（`tauri-plugin-shell` 或 std::process::Command） | 文档 |
| 12 | 数据层：sql.js（SQLite in WASM）+ 11 条 `db:*` | `main/db.js:12-13`（路径）、`:36-46`（sql.js 初始化） | 否 | 需插件（`tauri-plugin-sql`/sqlx）**且格式不同**：Tauri 侧现在写的是 JSON（`src-tauri/src/db.rs:1-2`） | 源码 |
| 13 | 原生文件对话框（14 条） | `main/dialogs.js`（206 行） | 否 | 有/需插件（`tauri-plugin-dialog`，src-tauri 已在用） | 源码 |
| 14 | 系统通知 | **实测 main 侧 0 处**（无 `new Notification`） | — | 现状无此能力，不构成迁移项 | 实测 |
| 15 | 操作系统级全局热键（用户录制、可禁用） | `main/hotkeys.js:15`、`:84` | 否 | 需插件（`tauri-plugin-global-shortcut`） | 文档 |
| 16 | 开机自启 | `main/system-ipc.js:106-117`（`setLoginItemSettings`） | **是** | 需插件（`tauri-plugin-autostart`） | 文档 |
| 17 | 设桌面壁纸（SystemParametersInfo） | `main/wallpaper.js:46-57`（PowerShell 内联 P/Invoke） | **是** | 需自研（windows crate 调 SPI） | 源码 |
| 18 | Wallpaper Engine 库扫描 + 回环资源服务 + webwallgl 渲染页 | `main/wallpaper-engine.js:147-181`、`wallpaper-engine-render.html` | 否 | **需自研**（HTTP 服务可用 axum，webwallgl 是前端 bundle 可复用，但 `require.resolve` 取资源路径要重写） | 源码 |
| 19 | 插件沙箱（Node `vm` + `worker_threads` + require 白/黑名单） | `plugin-host.js:44-60`、`:90`、`plugin-worker.js:13-40`、`plugin-sandbox-context.js:12-17` | 否 | **不可能等价**（Tauri 无 Node 运行时）；只能换 WASM/Extism 或外部进程，**现有第三方插件全部失效** | 源码 |
| 20 | GPU 开关与崩溃兜底（Chromium switches：rasterization/zero-copy/HEVC/audio-service/gpu-sandbox/崩溃上限） | `main.js:87-112` | 部分 | **需自研**（WebView2 `AdditionalBrowserArguments`），且部分 flag 未必暴露 | 源码 |
| 21 | 磁盘缓存重定向（不落 C 盘用户目录） | `main.js:116-119`（`disk-cache-dir`） | 否 | 需自研（WebView2 user data folder 可配） | 源码 |
| 22 | 崩溃/异常落盘（uncaughtException / unhandledRejection / render-process-gone / child-process-gone） | `main/log.js:27-38` | 否 | 需插件（`tauri-plugin-log`）+ WebView2 `ProcessFailed` 自研；概念不对等 | 源码 |
| 23 | 完整性校验（settings/presets/插件清单误删修复 + asar 校验） | `integrity.js`（207 行）、`main.js:687-705` | 否 | **需自研**（Tauri 无 asar，校验对象与手段都变了） | 源码 |
| 24 | 乐谱 PDF 导出（`printToPDF` + 注入打印 CSS） | `main/score.js:60-88` | 否 | **需自研**：WebView2 `PrintToPdf`（COM）或 Rust PDF 库 | 源码 |
| 25 | 视频导出（WebCodecs 逐帧编码 + ffmpeg 封装） | `frontend/src/views/ViewConvert.vue:868-878`、`main/video.js`、`preload.js:129-132` | 否 | **待实测**：WebView2 是 Chromium，理论上支持 WebCodecs，但硬件编码器可用性未验证 | 源码 |
| 26 | i18n（中/英/日，13.5 K 行表） | `frontend/src/core/i18n.js`（6,819 行）、`i18n_ja.js`（6,672 行）、`zhHant.js` | 否 | **无关**（纯前端层，换壳 0 改动） | 源码 |
| 27 | 无障碍 / 输入法 | 实测 `aria-*/role=` 命中 319 处 / 33 个文件 | 否 | 取决于 WebView2（同为 Chromium），基本等价 | 实测 |
| 28 | 录屏 / 抓屏 | **实测 0 处**（`desktopCapturer` / screen capture 0 命中） | — | 不构成需求 | 实测 |
| 29 | 数据根迁移（旧 C 盘目录 → 工具目录旁，含进度窗） | `main.js:441-490` + `main/paths.js`（685 行） | 否 | **需自研**（路径基准从 `app.getPath('userData')` 变 `app_data_dir()`） | 源码 |
| 30 | 完整性/端口/驱动脚本（PowerShell + WMI 拉起更新器） | `main/update.js:453-560`（生成 .ps1，`Invoke-CimMethod Win32_Process`） | **是** | **需自研**（同样要绕过 detached 进程树问题） | 源码 |

### 2.1 清单里最扎眼的四条

1. **第 5 项（运行期可开关的文件关联）** 是"看起来简单、实际会翻车"的典型：现在设置页勾一下就能写/删注册表（`main/settings-ipc.js:92`），Tauri 的 `fileAssociations` 是**打包期静态配置**，deep-link 文档明说运行期不可注册。要保住这个开关就得自己写注册表代码——而这条能力的用户可见性并不低（安装引导里就有一项）。
2. **第 7/8/9 项合起来是一条完整的"中国网络环境更新链"**：10 个源、测速、镜像返回 HTML 时用 MZ 头识别劫持（`main/update.js:283-288`）、Ed25519 验签、增量器只跳过 5 个目录（`build/kachina.config.json:74-80` 的 `ignoreFolderPath`）、失败时用 WMI 拉起守护脚本重启。这不是"接个插件"能覆盖的量。
3. **第 19 项（插件沙箱）在 Tauri 下是"不可能等价"**：现在第三方插件是 CommonJS，跑在 Node `vm` + worker 里（`plugin-host.js:44-60`）。Tauri 没有 Node 运行时，只能改 WASM 或子进程，等于让已有插件作者重写一遍。
4. **第 24 项（printToPDF）** 是"乐谱导出 PDF"这条产品线的物理依赖（`main/score.js:76-83`），Tauri 侧目前 `src-tauri/src/score.rs:83` 直接返回"Tauri 版暂不支持 PDF 导出"——这就是当年移植时的真实缺口，不是理论风险。

---

## 3. 历史复盘：src-tauri 到底做了什么、为什么停

### 3.1 时间线（git 实测）

| 日期 | 提交 | 内容 | 规模 |
|---|---|---|---|
| 2026-08-29 | `cd1811b` | **一次性建仓**：26 个文件，含 17 个 .rs、Cargo.lock、icons、gen/schemas | +13,581 行 |
| 2026-08-29 ~ 09-05 | `940b6f8...e52219c`（14 个提交） | **只改 `tauri.conf.json` 的版本号**（每次 +2/-2 行） | 每提交 4 行 |
| 2026-09-05 | `e52219c` | 3.2.0 发布，Tauri conf 版本跟到 3.2.0 | 最后一次版本同步 |
| 2026-09-18 | `17e58fd` | **不是 Tauri**：`rust-core` 统一 SMF 解析器（sidecar 路线） | rust-core/src/main.rs 197 行改写 |
| 2026-10-01 | `11fa36e` | **最后一次功能性提交**：`updater.rs` 对齐主进程（双通道 + CNB 多源 + 原子下载） | +426/−108，`updater.rs` 220→520 行 |
| 2026-10-06 | `2a1fb7f` | 写 `docs/FOUNDATION.md`，其中 §6.2 宣布 **"已冻结，不是备用外壳"** | +N 行文档 |
| 2026-10-06 | `7bcf5e0` | 卫生审计顺带改 `rust-core/Cargo.toml`（**不是** src-tauri） | — |
| 2026-11-03 | 现在 | 距最后一次功能提交 **33 天**，距冻结决定 **28 天** | — |

**实测统计**：`git log -- src-tauri` 共 **16** 个提交，其中 **14** 个只动 `tauri.conf.json`（版本号），**1** 个是建仓，**1** 个是功能性更新（`11fa36e`）。

### 3.2 冻结原因（文档原文）

`docs/FOUNDATION.md:101-108` 原文：

> 2. `src-tauri/` —— **已冻结，不是备用外壳**（2026-10-06 结论）。它是 Electron 主进程的分阶段移植，每个模块头部都写着「移植自 main/x.js」；76 条 Tauri 命令 vs 主进程 157 条 `ipcMain.handle`，版本停在 `Cargo.toml` 的 3.1.8（应用是 5.0.0-beta.2），`models.rs` / `plugins.rs` / `db.rs` 自己声明了未移植的部分，CI、`package.json`、打包流程里对它的引用数为 **0**（`electron-builder.yml` 明确 `!src-tauri/**`）。因此：**不许**在它上面加功能，也**不许**把它的改动当作应用改动；要复活 Tauri 方案，先由人拍板并把版本追上（这是架构决定，见第 4 节）。唯一还在生效的线索是 `frontend/src/bridge/tauri.js`：它按 `window.__TAURI_INTERNALS__` 判断，Electron 下整段不执行，只是白占约 2 KB 的入口 chunk。

后续审计的复述（`docs/audit/2026-10-29/external-research.md:436`，在"不建议做"清单里）：

> **重写 Tauri**：docs/FOUNDATION.md 已冻结该路线，外部也没有证据表明 Tauri 在音频场景更优。

**实测核对：文档里的三个"事实"今天仍成立，但版本数字全部过期**

| 文档说法 | 今天实测 | 结论 |
|---|---|---|
| 76 条 Tauri 命令 | 76（`src-tauri/src/lib.rs` 展开项计数） | 成立 |
| 主进程 157 条 handler | **250**（+2 条 `ipcMain.on`） | **过期 59%** |
| `Cargo.toml` 3.1.8 / 应用 5.0.0-beta.2 | Cargo.toml **3.1.8**（未变）/ `tauri.conf.json` **3.1.16** / 应用 **6.4.2** | 差距从 1.3 个大版本拉到 **3.3 个** |
| CI/package.json/打包引用数 = 0 | `package.json:20-21` 有 `build:rust` / `test:rust`（那是 rust-core，不是 src-tauri）；`electron-builder.yml:98` 有 `!src-tauri/**` | 成立 |

### 3.3 它当年完成了什么（源码实测的"三处明示缺口"）

`src-tauri/src` 共 **17 个 .rs、3,681 行（132,907 B）**，76 条命令分布在 16 个模块。逐条对照后，**未移植部分在代码里是自认的**：

| 位置 | 原文 | 影响 |
|---|---|---|
| `src-tauri/src/models.rs:259` | `HF 整仓下载（{repo}）尚未移植，请先使用 Electron 版` | 资源中心的模型整仓下载不可用 |
| `src-tauri/src/plugins.rs:108-113` | `插件「{}」的命令 {} 暂不可用（Tauri 版插件沙箱待移植）` | **插件系统只有清单/启停，没有执行** |
| `src-tauri/src/score.rs:83` | `Tauri 版暂不支持 PDF 导出，请使用「PNG 分页包」导出` | 乐谱 PDF 主线不可用 |
| `src-tauri/src/db.rs:1-2` | `移植自 main/db.js（JSON 文件模式）… sql.js 依赖后续再移植` | 数据格式与 Electron 不同（sqlite vs JSON） |

也就是说：**76 条命令里有 6 条（plugins.rs）实质是空壳**，26 条（dialogs/score/video/wallpaper/presets/settings/system/diagnostics）是"能跑但缺关键分支"。按功能等价算，真实覆盖约 **90/250 = 36%**，而不是 30.4% 或 44.4%。

### 3.4 为什么停：把"文档写的"和"实际发生的"分开

文档给的是三条理由（版本落后、覆盖不足、零引用）。从 git 与代码看，还叠着四条更硬的：

| # | 真实原因 | 证据 | 性质 |
|---:|---|---|---|
| 1 | **更新链无法等价迁移** | `updater.rs` 已经被重写过一次（`11fa36e` +426/−108），代码量 520 行，而 Electron 侧对应的是 `update.js 584 + update_sign 104 + update_util 23 + kachina 配置 85 + 内嵌 PowerShell 守护脚本约 90 行` —— 仍然只做到"拉起更新器"，拉不起来的分支只能报错 | 结构性 |
| 2 | **插件沙箱在 Tauri 下没有落点** | `plugins.rs` 全文 146 行，invoke 直接返回错误 | 结构性 |
| 3 | **收益不可见**：换壳不改善转录/播放性能 | backend-perf §3.1：主进程启动开销 100 ms 量级、不是首屏瓶颈 | 取舍 |
| 4 | **维护成本翻倍**：每次桥变更要同时改 preload.js + tauri.js | `frontend/src/bridge/tauri.js` 207 行，与 `preload.js` 466 行并行维护 | 持续性 |

**我的判断（标注为推断）**：2026-10-06 的冻结是**对的**，但当时的理由不完整。真正的死因是"更新链 + 插件沙箱"这两块**没有等价物**，而不是"版本落后"。版本落后是结果，不是原因——因为每加一个新功能，桥就要改两遍，而 Tauri 那遍没有收益，自然就不改了。

### 3.5 可复用 vs 沉没成本

| 类别 | 具体内容 | 处置建议 |
|---|---|---|
| **可复用（真金）** | `updater.rs` 的 10 源/双通道/原子下载语义（520 行，是唯一"对齐过主进程"的模块）；`engine.rs`（656 行）的 spawn + 进度解析；`gpu.rs`（506 行）的增强包安装状态机；`wallpaper.rs`（258 行）的库扫描；`dialogs.rs`（251 行）的对话框参数映射 | 作为 **Rust 内核** 的参考实现直接搬；别丢 |
| **半成品（可救）** | `models.rs`（444 行）、`presets.rs`（88 行）、`db.rs`（157 行）、`score.rs`（85 行）、`video.rs`（112 行）、`diagnostics.rs`（52 行） | 逻辑可抄，接口要按 Electron 契约重写 |
| **沉没成本** | `tauri.conf.json`、`Cargo.toml` 的 Tauri 依赖树、`gen/schemas/*.json`（425 KB ACL/桌面 schema）、`icons/`（534 KB）、`Cargo.lock`（122 KB）；以及 14 个只改版本号的提交所代表的"版本追平"努力 | 归档，不删也行（已 `!src-tauri/**` 排除出包，零成本挂着） |
| **负资产** | `frontend/src/bridge/tauri.js`（207 行）：Electron 下不执行，但**每次桥变更都要同步**；且它自身有 3 处明示缺口（`onOpenFile` 空实现、`setFolderWatch` 空实现、`rustStatus` 假成功） | 要么删，要么加 `// FROZEN` 头并写进 FOUNDATION 的"不许改"清单 |

---

## 4. 三方案决策矩阵

### 4.1 方案定义

| 方案 | 一句话 | 边界 |
|---|---|---|
| **A** | **Electron 保留 + Rust 内核**：主进程仍是 Electron；CPU 密集路径下沉到 Rust（sidecar 进程优先，必要时 napi 原生模块）；渲染层用 WASM/napi 覆盖前端热路径 | 不碰 250 条 IPC 契约、不碰 UI、不碰更新链 |
| **B** | **Tauri 2 外壳 + Rust 内核 + 现有 Vue UI 迁移**：用 `src-tauri` 续建到 250 条，前端通过 bridge 适配层切到 Tauri invoke | IPC 语义要重映射；更新链/插件沙箱/printToPDF/壁纸引擎必须重写 |
| **C** | **全原生 UI（egui / slint / iced）重写**：连 UI 层也不用 WebView | 75,872 行前端 + 250 条通道全部重做；乐谱/3D 可视化/编辑器自研 |

### 4.2 评分矩阵（1–5，5 为最优；权重合计 100）

| # | 维度 | 权重 | A | B | C | 评分理由（含证据） |
|---:|---|---:|---:|---:|---:|---|
| 1 | 安装体积 | 8 | 2 | 3 | 4 | 实测安装后 1,746 MB：python 1,101 MB + models 212 MB + Electron 本体约 250 MB（`release/win-unpacked` 实测）。换壳最多省 250 MB（14%），C 再省 WebView 也不影响大头 |
| 2 | 冷启动 | 6 | 3 | 3 | 5 | 实测主进程 require 46 个模块 60.3 ms、不是瓶颈（backend-perf §3.1）；瓶颈在渲染进程首屏 IPC 与 Python 冷启。C 的原生 UI 可做到 <300 ms，但要重写全部页面 |
| 3 | 运行时内存 | 7 | 2 | 4 | 5 | Electron 自带 Chromium（基线高）；WebView2 共享系统运行时；原生 UI 最低。**待实测**：三者在本机（含 30 GB 数据根）的真实 RSS 未测 |
| 4 | UI 性能上限 | 8 | 4 | 3 | 5 | Electron 是完整 Chromium（WebGL2/WebCodecs/OffscreenCanvas 全有，视频导出已用 WebCodecs：`ViewConvert.vue:868`）；WebView2 同为 Chromium 但受 Edge 版本与企业策略约束；原生 UI 上限最高但 3D 可视化/乐谱排版要自研，**现实可达性能反而最低** |
| 5 | 功能对齐成本（250 IPC） | 21 | 5 | 2 | 1 | A 为 0 改动；B 要补 160 条通道并重写最贵的 5 个模块；C 还要再加 75,872 行前端 |
| 6 | 自动更新与签名 | 10 | 5 | 2 | 2 | 现状：10 源 + 测速 + 增量 + Ed25519 + WMI 守护重启，全部跑通（`main/update.js`、`build/kachina.config.json`）。Tauri 侧：插件强制签名但换算法、无增量、无多源、installMode 只有三档 |
| 7 | 插件生态 | 5 | 4 | 1 | 1 | 现状是 Node `vm`+worker 沙箱（`plugin-host.js:44-60`）；Tauri 无 Node，现有 CommonJS 插件全部失效 |
| 8 | 跨平台 | 5 | 3 | 3 | 2 | 现状：Windows 正式 + mac/linux dev 包未签名未公证（`docs/CROSS-PLATFORM.md:3-4`）；Tauri 官方三平台但 python 运行时同样要自备；C 的三平台一致性最好但工作量最大 |
| 9 | 开发迭代速度 | 9 | 5 | 2 | 1 | 现状一周多版（CHANGES 高频）；B 要维护双 bridge（`preload.js 466 + tauri.js 207`）+ Rust 增量编译；C 每次改 UI 都编译 |
| 10 | 招聘/维护 | 4 | 4 | 3 | 2 | JS/Electron 人力池最大；Rust+Web 双栈次之；Rust 图形 UI 人才最少 |
| 11 | 崩溃可观测性 | 4 | 3 | 3 | 3 | 现状仅本地日志（`main/log.js:27-38`，无 `crashReporter`、无上报）；Tauri 有 `tauri-plugin-log` 但 WebView2 的 ProcessFailed 要自己接；C 单进程最可控但要自建崩溃处理 |
| 12 | 无障碍与输入法 | 4 | 5 | 4 | 1 | Chromium 自带完整 a11y/IME，现网 `aria-*/role` 命中 319 处；WebView2 基本等价；egui/slint 的 a11y 与中文 IME 支持是硬伤 |
| 13 | WebView2 依赖 | 3 | 5 | 3 | 5 | A 自带 Chromium 无系统依赖；B 依赖系统 WebView2（Win10+ 预装，但企业环境可被移除；Win7 需 bootstrapper，见官方 Windows Installer 文档）；C 无依赖 |
| 14 | Windows 特定行为（安装位置/权限/杀软/EV 签名） | 6 | 4 | 2 | 2 | 现状：NSIS 用户级安装 + `uacStrategy: prefer-user` + Authenticode **待证书**（`CROSS-PLATFORM.md:23`）；B/C 换新 exe 等于**从零积累杀软信誉**，且文件关联开关要自研注册表 |
| | **加权总分** | **100** | **402** | **255** | **253** | |
| | **归一化** | | **80.4%** | **51.0%** | **50.6%** | |

### 4.3 矩阵读法（三条必须说清的话）

1. **A 赢在"契约"而不是"技术先进"**：权重最高的第 5 项（21 分）A 拿满分，因为它不改契约。B 在这一项上直接丢 63 分，是全部差距的主因（402−255=147，其中 63 来自第 5 项）。
2. **B 与 C 打平（255 vs 253）说明一件事**：如果连 Tauri 迁移都不划算，那么"连 UI 都重写"更不划算——两个方案的成本结构不同（B 花在 IPC/更新链，C 花在 UI/编辑器），但都撞在同一个天花板上：**这个产品的价值在前端那 75,872 行里，不在外壳里**。
3. **换壳的收益集中在第 1/3/4 项（体积/内存/UI 上限），合计权重 23**；而它要牺牲的是第 5/6/7/9 项，合计权重 **45**。**收益-成本比天然小于 1**，这不是执行问题。

### 4.4 如果一定要迁 Tauri：什么条件下才成立

不给"永远不迁"的绝对结论。三个可观测的触发条件，满足**任意两条**再重开 B：

| 触发条件 | 阈值 | 为什么是这个阈值 |
|---|---|---|
| 安装体积成为实际投诉 | 全量包 > 600 MB **且** python 已瘦身到 < 400 MB（见 03 号文件） | 否则省下的 250 MB 占比仍 < 20% |
| 内存成为实际投诉 | 现场 RSS > 1.5 GB 且 Rust 内核已吃掉主进程 90% 的 CPU | 外壳只值 100–200 MB |
| Electron 失去维护窗口 | Electron 官方停止 ABI 支持且 37/45 线无法再升 | 这是唯一"被迫迁移"的情形 |

当前三条**一条也不满足**（实测：全量包 606 MB 但 python 仍是 1,101 MB 主体）。

---

## 5. 工程量估算

### 5.1 计量口径与历史校准

先给基准，避免"拍脑袋人日"：

| 基准 | 数值 | 来源 |
|---|---:|---|
| Electron 主进程规模 | `main/**` 17,888 行 + `main.js` 708 + `preload.js` 467 = **19,063 行** | 实测 |
| 前端规模 | `frontend/src` **75,872 行 / 175 文件** | 实测 |
| Tauri 已完成规模 | `src-tauri/src` **3,681 行 / 76 命令 / 16 模块** | 实测 |
| Tauri 移植密度 | **48.4 行/命令** | 实测（3,681 ÷ 76） |
| Electron 侧密度 | **76.3 行/通道**（含 preload） | 实测（19,063 ÷ 250） |
| 历史投入（可观测） | 2026-08-29 建仓 13,581 行（一次性）；2026-10-01 updater 重写 +426/−108 | `cd1811b`、`11fa36e` |

**校准推算**：若全量按 48.4 行/命令，250 条 ≈ **12,100 行 Rust**。但已完成的那 76 条是**简单子集**（对话框、预设、设置、KV 存储），未完成的 174 条包含更新链、插件沙箱、下载器、壁纸引擎、模型服务——密度至少 ×2。所以真实终态约 **20,000–26,000 行 Rust**，是现有 Tauri 代码的 5–7 倍。

> 这也是"14 个提交只改版本号"的本质：**不是懒，是每加一条命令的成本都在上升，而收益为 0。**

### 5.2 按模块拆的人日表

工作日口径：1 人日 = 1 名熟悉该栈的工程师 1 天；1 人周 = 5 人日；1 人月 = 20 人日。A 列只统计"外壳/打包/基础设施"部分（Rust 内核里真正算法迁移的人日归 01/02 号文件）。

| 模块 | Electron 规模（实测） | A：Rust 内核 | B：Tauri 全量 | 说明 |
|---|---|---:|---:|---|
| IPC 契约（250 通道 + 28 事件） | `preload.js` 467 行 + handler 散布 33 个模块 | 0 | **45–65** | B 要逐条改写成 `#[tauri::command]`，还要处理 28 个事件通道与"退订函数"语义 |
| 自动更新 + 签名 + 多源 + 守护重启 | `update.js` 584 + `update_sign.js` 104 + `update_util.js` 23 + kachina 85 + 内嵌 PS ~90 | 0–2 | **25–35** | 见 §6.1 |
| 插件沙箱 | `plugin-host.js` 473 + `plugin-worker.js` 150 + `ctx` 50 + `plugins.js` 179 = 852 行 / 20 通道 | 0 | **25–35** | 见 §6.2 |
| 通用下载器 | `fast-download.js` 721 行 + `download-source` + `update-speedtest` + 各调用点 | 5–8 | **12–18** | 见 §6.4 |
| 壁纸 + Wallpaper Engine | `wallpaper.js` 452 + `wallpaper-engine.js` 203 + render.html | 0 | **10–15** | 见 §6.3 |
| 模型服务（含 ModelScope 目录） | `models.js` 1,621 + catalog 87.6 KB + 8.2 KB + `rvc.js` 457 | 3–5 | **18–25** | 3 个 catalog + 断点续传 + 安装状态机 |
| 演唱链（UTAU/DiffSinger/RVC/翻唱） | `utau.js` 877 + `diffsinger.js` 1,307 + `cover.js` 177 | 0 | **20–28** | 4 套引擎 + 声库注册表 + oto.ini 读写 |
| 乐谱 / OMR | `score.js` 362 + `omr.js` 621 | 0 | **14–20** | 含 printToPDF 重做、Audiveris 外部进程 |
| Python 引擎桥 | `engine.js` 476 + `task-queue.js` 262 | 6–10 | **12–16** | A 侧是"sidecar 不死锁/可取消"的基础设施 |
| 曲库 / 工程 / 导出 / 存储 | `library.js` 299 + `project.js` 301 + `export.js` 186 + `storage.js` 177 | 2–4 | **12–16** | |
| GPU 增强包 | `gpu-ipc.js` 639 + `gpu.js` 8.4 KB | 3–5 | **12–16** | 4 种包 + 分卷 + Python ABI 匹配 |
| 数据层 / 路径 | `db.js` 214 + `paths.js` 685 + `settings.js` | 2–4 | **10–14** | 含 sqlite↔JSON 数据迁移 |
| 窗口/托盘/热键/自启/文件关联 | `window.js` 151 + `hotkeys.js` + `system-ipc.js` 208 | 0–1 | **8–12** | 含运行期文件关联开关自研 |
| 其余业务（反馈/任务中心/元数据/预设/AI/DAWproject） | 合计约 1,000 行 / 27 通道 | 1–2 | **8–12** | |
| 打包 / 签名 / 发布流水 | 6 份 `electron-builder*.yml` + `build.js` + `build-gpu-package.js` + 签名/上传脚本 | 2–3 | **8–12** | B 还要重建 NSIS + 签名 + 杀软信誉 |
| 回归 / 契约测试 / 冒烟 | `package.json` 的 20+ 测试脚本 + E2E + 装机冒烟 | 5–8 | **20–30** | 250 条契约要逐条验证 |
| **小计** | | **29–52** | **234–336** | |

### 5.3 三档交付（人日 / 人周）

| 方案 | 最小可用版本（MVP） | 功能对齐版本 | 发布可用版本 |
|---|---:|---:|---:|
| **A：Electron + Rust 内核** | **15–22 人日**（3–4.5 人周）<br>sidecar 通道 + `rust-core` 扩到 12 条命令 + `settings.rust_core` 开关 + 打包 | **35–55 人日**（7–11 人周）<br>CPU 密集路径下沉 + 失败回退 + 契约测试 | **45–70 人日**（9–14 人周）<br>+ 签名/多平台产物/回滚开关/灰度 |
| **B：Tauri 2 外壳** | **60–85 人日**（12–17 人周）<br>补齐 60–80 条常用通道，跑通"播放 + 转录 + 导出"主流程 | **235–335 人日**（47–67 人周）<br>250 条全量 + 最贵 5 模块 | **270–380 人日**（54–76 人周）<br>+ 安装器/签名/更新链/数据迁移/双跑 |
| **C：全原生 UI** | **90–130 人日**（18–26 人周）<br>只做播放 + 可视化，不含编辑/乐谱/转录 UI | **900–1,300 人日**（180–260 人周）<br>75,872 行前端 + 250 通道 + 乐谱/编辑器/3D 自研 | **1,000–1,450 人日**（200–290 人周） |

**日历换算（按 2 名全职并行、1 人周 = 5 人日）**：

| 方案 | 到"发布可用" | 风险调整（+30%） |
|---|---:|---:|
| A | 2.3–3.5 个月 | 3–4.5 个月 |
| B | 13.5–19 个月 | 17–25 个月 |
| C | 50–72 个月 | 65–94 个月 |

> C 的数字看起来夸张，但它是算术结果：仅"75,872 行 UI 用 Rust 重画一遍"按 300 行/人日就是 253 人日，而 egui/slint 里没有乐谱排版、没有 WebGL 可视化、没有富文本编辑器——这三块在 Web 生态里是现成库（verovio/abcjs/CodeMirror），在原生 UI 里要自研。

---

## 6. 最贵的 5 个模块（为什么贵）

### 6.1 自动更新与签名（B 侧 25–35 人日）

**为什么最贵**：它不是"调一个 API"，而是**一条带 10 个源的分布式发布链**，且每一环都有历史事故。

| 环节 | 现状（实测） | Tauri 下的缺口 |
|---|---|---|
| 通道 | stable（`releases/latest`）/ beta（固定 tag `beta`），见 `main/update.js:12-41` | 插件支持静态 JSON / 动态服务，但"固定 tag + 同资产名覆盖上传"的语义要自建 |
| 多源 | 3 个 GitHub 镜像 + 官方直连 + CNB，共 10 个 id（`main/update.js:25-30`、`build/kachina.config.json` 10 项） | 插件只有单一 `endpoints` 列表，**无测速、无 MZ 头防劫持、无"最近成功源"记忆** |
| 增量 | kachina 二进制差分/Range 下载，只跳过 `resources/python`、`models`、`wallpapers`、`FuFumidiData`（`build/kachina.config.json:74-80`） | **无增量机制**：每次整包。以 6.4.2 为例，增量包 160.6 MB、全量包 606.3 MB（实测 `release/`），Tauri 下老用户体验直接退化 3.8 倍 |
| 签名 | Ed25519 规范串（`main/update_sign.js:17-78`），失败即删包 | 插件用 minisign 且**强制**；迁移期必须同时保留旧公钥验签逻辑，否则 6.4.x 用户永远升不上来（`docs/UPDATE-SIGNING.md:45-52` 已写明这个约束） |
| 拉起与重启 | 探测源 → 拉起 `FuFumidi.update.exe` → 写 PowerShell 守护脚本 → **WMI `Win32_Process.Create`**（`main/update.js:453-560`，注释解释了"detached PowerShell 起不来、不 detached 又会随主进程死") | 同样的进程树问题要在 Rust 里再解一遍；且 Windows 更新器语义（替换自身 exe）比 Linux/mac 难 |
| 卸载 | 启动 NSIS 卸载器 + 600 ms 后退出（`main/update.js:377-388`） | 需重接 NSIS 卸载器路径 |

**一句话**：这块的代码量不大（约 900 行），但**每一行都是踩过坑之后写下来的**；重写等于把所有坑再踩一遍。

### 6.2 插件沙箱（B 侧 25–35 人日，且"不可能等价"）

- 现状：插件 = 目录 + `plugin.json` + CommonJS 入口（`plugin-host.js:1-26` 的文档注释就是协议）；沙箱 = Node `vm.createContext` + require 白名单（`plugin-host.js:44-60`、`plugin-sandbox-context.js:12-17`）；隔离 = worker 线程（`plugin-worker.js`）。
- **Tauri 没有 Node 运行时**，所以：要么把插件改成 WASM（Extism/wasmtime）——现有作者要重写；要么每个插件跑成独立进程——IPC 协议要重设计，延迟从微秒变毫秒；要么放弃插件系统——产品定位直接受损（插件市场、`plugins:catalog`、`installFromPlatform` 那一整套，见 `preload.js:334-354`）。
- 更要命的是**沙箱边界本身**：代码里已经写明"Node 的 vm 不是安全沙箱，白名单是卫生围栏"（`plugin-sandbox-context.js:9-10`）。换到 Rust 后这个语义要靠 WASM 才能真成立——这不是移植，是重新设计。

### 6.3 壁纸引擎（B 侧 10–15 人日）

- 现状是三层：库扫描（`main/wallpaper-engine.js:44-59`，找 Steam `common/wallpaper_engine`）→ 回环 HTTP 服务（`:147-181`，随机 token + Range 支持）→ 渲染页（`wallpaper-engine-render.html` + `webwallgl.global.min.js`）。
- Tauri 下：HTTP 服务可用 axum 重写（不难）；难的是 `require.resolve('webwallgl/package.json')` 这种"从 Node 模块解析静态资源"的写法（`:166`）在 Tauri 里没有对应物——必须改成 build 期把 bundle 复制进 resources 并改路径。**推论**：能改，但会把 webwallgl 的升级路径从 `npm update` 变成手工同步。
- 另外"设桌面壁纸"是 PowerShell 内联 P/Invoke（`main/wallpaper.js:52-53`），Rust 侧要引 `windows` crate 直接调 `SystemParametersInfoW`——工作量不大，但是 Windows-only，且与 `CROSS-PLATFORM.md:35` 的"非 Windows 明确报不支持"约定要对齐。

### 6.4 下载器（B 侧 12–18 人日）

`main/fast-download.js` 是整个仓库**唯一允许取字节**的入口（`docs/FOUNDATION.md:40-44`），721 行里塞了 8 件事：多源排序、分段并发、多文件并发、断点续传、停滞看门狗、低速轮换、完整性校验、磁盘预检 + 取消契约。它还被 6 处业务复用（模型/音色/壁纸/GPU 包/更新/OMR 语言包）。

Tauri 侧要么用 `tauri-plugin-http`（只做单请求，不够），要么自研 reqwest 版——而自研就意味着**这 8 条行为都要重新验证一遍**（分段边界、`.part` 文件布局、`partsLayoutOk` 的校验逻辑都在 `main/fast-download.js:96-108`）。

### 6.5 IPC 契约（B 侧 45–65 人日）

- 250 条通道 + 28 个事件通道，**平均 76.3 行 Electron 代码/通道**（实测）。
- Tauri 不是"一对一映射"：`frontend/src/bridge/tauri.js:17` 用的是 `'a:b' → 'a_b'` 的机械转换，而真实差异在**载荷形状**（Electron 是 `(e, ...args)` 多参数，Tauri 是单个 `args` 对象）、**事件退订**、**进度回传**（`evt.sender.send` → `emit`）、**同步返回 vs Promise**。
- 已有证据：`frontend/src/bridge/tauri.js:52-55、198-201` 两处**空实现**（文件打开、文件夹监听）就是映射不上的直接后果；`docs/audit/2026-10-29/backend-perf.md:186` 的 32 条"preload 声明但 main 无 handler"里，28 条是事件通道——换成 Tauri 后这 28 条的语义要重新设计。

---

## 7. 迁移与共存

> 前提：**推荐 A**。本章仍完整给出 A→B 的渐进路径，因为它的前半段（Rust 内核）就是 A，且这部分工作无论最终走哪条路都不会浪费。

### 7.1 五阶段渐进路径

| 阶段 | 内容 | 产出 | 人日 | 可回滚 |
|---|---|---|---:|---|
| **P0 收口** | 明确 Tauri 停摆：更新 `docs/FOUNDATION.md:101-108` 的数字（157→250）、修正官网"Rust · Tauri 桌面核心"表述（`docs/pages/index-zh.html:733`）、给 `frontend/src/bridge/tauri.js` 加 `// FROZEN` 头 | 一份事实一致的仓库 | 1–2 | 是（纯文档） |
| **P1 Rust 内核（sidecar）** | 沿用已有 `main/rust.js` 通道（88 行，5 个候选路径、`ping` 探测、JSON stdout），把 `rust-core` 从 7 条命令扩到覆盖 CPU 密集路径 | `resources/rust-core/fufumidi-core.exe`（当前 0.3 MB，实测） | 15–22 | 是（缺失自动降级，`main/rust.js:29` 的 `available()` 已实现） |
| **P2 开关与回退** | `settings.rust_core = off/auto/on`，按能力粒度开关；失败自动回退纯 JS（现有代码路径不删） | 灰度能力 | 5–8 | 是 |
| **P3 复用 main 进程** | 把已迁到 Rust 的逻辑从 Electron 主进程摘掉，主进程只剩"壳 + IPC + 编排" | 主进程瘦身 | 10–15 | 是（git revert） |
| **P4（条件触发）外壳替换** | 若 §4.4 的触发条件满足：用 Tauri 2 重建外壳；此时 250 条通道中已有相当部分由 Rust 内核承载，bridge 层可以从"逐条 invoke"改为"一个 `core:call` 通道 + 命令分发" | 新外壳 | 见 B 表 | 是（双包并行） |

**P4 的关键洞察**：一旦 P1–P3 完成，Tauri 侧的 250 条通道不再需要 250 个 `#[tauri::command]`，而可以是**单个命令 + Rust 内部路由**——这把 §6.5 的 45–65 人日压到 10–15 人日。**A 的每一步都在为 B 降价**，反之不成立。

### 7.2 双跑开关

| 开关 | 位置 | 语义 |
|---|---|---|
| `FUFUMIDI_SHELL=electron|tauri` | 进程级环境变量 | 决定加载哪个 bridge；`frontend/src/bridge/tauri.js:8` 已有 `isTauri()` 探测（`window.__TAURI_INTERNALS__`） |
| `settings.rust_core` | 用户设置 | `off` / `auto`（探测到二进制且 ping 通过）/ `on`（强制） |
| `settings.rust_core_scope` | 用户设置 | 能力粒度，如 `["midi-parse","hash","stats"]`，便于逐能力灰度 |
| `FUFUMIDI_E2E=1` | 已有 | 现状用于跳单实例锁（`main.js:126`），双跑测试复用它 |

**准则**：同一份 `renderer/dist` 产物必须两种外壳都能跑（现状已经满足：`tauri.conf.json:10` 的 `frontendDist` 就是 `../renderer/dist`）。

### 7.3 数据/设置/工程文件兼容

**这是 B 方案最容易翻车、也最少被讨论的地方。实测差异如下**：

| 数据 | Electron 路径/格式（实测） | Tauri 路径/格式（实测） | 兼容结论 |
|---|---|---|---|
| 设置 | `main/settings.js` 的 `SETTINGS_PATH`（数据根下 settings.json） | `src-tauri/src/settings.rs:1` —— `userData/fufumidi` 目录 | **路径不同**，需一次性迁移 + 双写过渡 |
| 数据库 | `userData/FuFumidi/fufumidi.sqlite`（sql.js，`main/db.js:12-13`） | `app_data_dir()/fufumidi/fufumidi-db.json`（JSON，`src-tauri/src/db.rs:22-28`） | **格式不同**：必须写 sqlite→JSON 迁移器，或反过来把 Rust 侧改成 sqlite |
| 工程文件 | `.fufumidi` 自包含包（`docs/FOUNDATION.md:35`） | 不涉及（引擎侧格式） | **兼容**（纯文件格式，与外壳无关） |
| 数据根 | 工具目录旁 `FuFumidiData`（`main/paths.js` 685 行 + `main.js:441-490` 迁移器） | `app_data_dir()` | **不兼容**，且 Tauri 没有"工具目录旁"的概念 → 需重新定义并写迁移 |
| 曲库 MIDI | `<dataRoot>/midi` | 同 | 依赖数据根迁移 |
| 用户模型 | `<dataRoot>/models` | 同 | 依赖数据根迁移 |

**结论**：B 方案的"外壳替换"实质上等价于**一次带数据迁移的主版本升级**（类似 5.x 的数据根迁移，那次已经用了进度窗 + 失败回退，见 `main.js:462-490`）。A 方案完全避开这一层。

### 7.4 回滚方案

| 层 | 回滚手段 | 验证方式 |
|---|---|---|
| Rust 内核 | 设置关闭 → 走原 JS 路径（代码不删） | `npm run test:rust` + `rust:status` 返回 `available:false` 时功能不退化 |
| 打包产物 | Electron 主发布不动；Rust 内核作为 `extraResources` 增量（`electron-builder.yml:131-133` 已有通道） | 删除 `resources/rust-core` 后启动冒烟 |
| 外壳（若走 P4） | 双包并行：Electron 包继续发布，Tauri 包只走 beta 通道（`main/update.js:15-17` 的固定 beta tag 机制现成） | beta 用户可在设置里"回退到稳定版" |
| 数据 | 迁移前整目录备份 + 只读打开旧数据 | 迁移器必须幂等（现状 `paths.js` 的 `useLegacyFor` 就是这个模式） |

### 7.5 灰度策略

1. **能力灰度**（P2 起）：`rust_core_scope` 白名单 → 内部测试 → 5% 用户 → 全量。判据：同一输入的输出与原 JS 路径**逐字节一致**（MIDI 解析/SHA-256/统计都属于可对拍的计算）。
2. **通道灰度**（P4 才有）：beta 通道先行（现有机制），稳定版屏蔽。
3. **不可灰度项**：更新器本体、安装器、文件关联——这三项一旦换就是全量切换，只能在 beta 通道上做长时间验证。

---

## 8. 明确建议与需拍板的决策点

### 8.1 建议

**走 A：保留 Electron，把 Rust 做成内核。** 四条理由按重要性排序：

1. **瓶颈不在外壳**。仓库自己的审计已经定位：主进程启动开销 100 ms 量级、不是首屏瓶颈（backend-perf §3.1）；体积大头是 python 1,101 MB（63%），不是 Electron 的 250 MB（14%）。
2. **成本差一个数量级**。A 到发布可用 45–70 人日；B 是 270–380 人日。同样的投入放在 Rust 内核 + Python 瘦身上，性能收益可见且可测。
3. **契约是资产不是负债**。250 条通道零漂移是这个仓库最值得保留的工程习惯（backend-perf §4.1 的原话是"最值得保留的工程习惯之一"）。换壳是唯一会把这份资产清零的动作。
4. **A 的每一步都在为 B 降价**。sidecar/内核做完之后，如果哪天真的要迁，B 的成本从 234–336 人日降到约 120–160 人日。

**同时做三件"止血"小事**（合计 < 1 人日）：

- 修正 `docs/FOUNDATION.md:102` 的 "157 条" → **250 条**（另 +2 条 `ipcMain.on`），并写清"按功能等价覆盖约 36%"。
- 修正官网"Rust · Tauri 桌面核心"（`docs/pages/index-zh.html:733` / `index-en.html:670`）——现状是对外表述与代码事实不符。
- 给 `frontend/src/bridge/tauri.js` 加 `// FROZEN 2026-10-06` 头，或直接移除（它被 `electron-builder.yml:99` 排除出包，属于"进不了产物但仍要维护"的纯负担）。

### 8.2 需要用户拍板的 4 个决策点

| # | 决策点 | 选项 | 我的建议 | 不拍板的代价 |
|---:|---|---|---|---|
| **D1** | **Tauri 是"归档"还是"保留为未来选项"** | (a) 明确归档：FOUNDATION 写死"不迁"，tauri.js 删除或标死；(b) 保留：继续双维护 bridge | **(a) 归档** | 保留 = 每次桥变更要改两遍（现状已如此），且 30% 的覆盖会持续误导"看起来快成了" |
| **D2** | **Rust 内核的接入形态** | (a) sidecar 进程（已有 `main/rust.js` 通道，跨语言边界清晰，崩溃不拖垮主进程）；(b) napi 原生模块（延迟低，但破坏 asar/ABI，每个 Electron 版本要重编，且 3 平台构建矩阵） | **(a) sidecar 起步**，仅当实测 IPC 开销 > 5 ms/次且调用频率 > 100 Hz 时，对**个别函数**上 napi | 一开始就上 napi = 把 Electron 升级（33→37→45）变成"重编原生模块"的阻塞项 |
| **D3** | **体积指标怎么定** | (a) 接受"换壳省 14%"不够，把 python 瘦身列为体积主战场（归 03 号文件）；(b) 把体积作为硬 KPI 压给外壳改造 | **(a)** | 若把体积 KPI 压给外壳，最后会发现省了 250 MB 但 python 仍 1.1 GB，白干 |
| **D4** | **要不要顺手替换更新器** | kachina 是**第三方二进制、配置编译进 exe、无源码**（`build/kachina.config.json` 被 `scripts/build-updater.js` 烤进 exe）。选项：(a) 继续用；(b) 在 Rust 内核阶段自研一个 Rust updater（增量 + 多源 + Ed25519，约 +15–25 人日） | **(a) 继续用**，但把它登记为 P0 级外部依赖风险（无源码、无法修、只能换版本） | 不登记风险 = 哪天 kachina 上游停更或签名策略变了，整条发布链断掉且无人能修 |

---

## 9. 待实测清单（本文件未验证、但会影响结论的）

| # | 待测项 | 为什么重要 | 建议测法 |
|---:|---|---|---|
| 1 | Tauri 2 + WebView2 下 **WebCodecs H.264 硬件编码**可用性 | 视频导出是现网功能（`ViewConvert.vue:868`），若 WebView2 不支持硬编则 B 方案要额外重做视频管线 | 最小 Tauri 壳 + 同一段编码代码，测 `VideoEncoder.isConfigSupported` 与实测帧率 |
| 2 | WebView2 `PrintToPdf` 与现网 `printToPDF` + 注入打印 CSS 的**分页等价性** | 乐谱 PDF 是产品线；`src-tauri/src/score.rs:83` 目前直接不支持 | 同一份乐谱页两路导出，比对页数/字号/边距 |
| 3 | WebView2 在**装有虚拟显示适配器**机器上的稳定性 | 现网为此专门关了 GPU 沙箱、去掉了崩溃上限（`main.js:106-112`） | 在向日葵/Oray/MuMu 环境各跑 30 分钟 |
| 4 | Rust sidecar 的**单次调用开销**（spawn + JSON 序列化） | 决定 D2 选 sidecar 还是 napi | 实测 `fufumidi-core ping` 1000 次，取 P50/P95 |
| 5 | 三个方案的**真实冷启动与 RSS** | 矩阵第 2/3 项目前是按结构推断的 3/2/4/5 分，无实测 | Windows 性能计数器 + `Measure-Command` 到首帧可交互 |
| 6 | `electron-builder.base.yml / .ci.yml / .local-dir.yml` 仍写 `electronVersion: 33.4.11`（实测 3 份），而 `node_modules/electron` 是 **37.10.3** | 这两份配置**没有** `electronDist`，会去下载 Electron 33.4.11 —— 也就是用 EOL 版本出包（`docs/electron-upgrade.md:5` 明写 33 已 EOL） | 跑一次 `npm run pack:base` 看产物版本；这也是 §5 里"打包/发布 2–3 人日"的一部分 |

---

## 附录 A · 证据索引（本文引用的关键位置）

| 主题 | 位置 |
|---|---|
| 启动序列（46 require → 29 个 register → createWindow） | `main.js:1-75`、`:137-267` |
| GPU/Chromium 开关与崩溃兜底 | `main.js:81-119` |
| 单实例锁与 second-instance | `main.js:123-135` |
| 托盘与"关闭到托盘" | `main.js:273-314` |
| 数据根迁移（进度窗） | `main.js:441-512` |
| 内置模型 junction / 断链自愈 | `main.js:527-557` |
| 引擎子进程环境（PYTHONPATH 清洗、GPU 包 ABI 匹配） | `main.js:583-622` |
| 退出清理与 SQLite 落盘 | `main.js:670-684` |
| 窗口创建与 splash | `main/window.js:9-94` |
| 下载会话（will-download → 原生保存框） | `main/window.js:96-118` |
| .mid 双击打开（含竞态兜底） | `main/window.js:120-148`、`main.js:255-262` |
| 文件关联（reg.exe + ie4uinit） | `main/settings-ipc.js:16-108` |
| 开机自启 | `main/system-ipc.js:106-117` |
| 全局热键 | `main/hotkeys.js:15-106` |
| 更新链（源/通道/测速/签名/拉起/守护） | `main/update.js:12-41`、`:252-320`、`:390-560` |
| 更新器配置（10 源、ignoreFolderPath、uacStrategy） | `build/kachina.config.json:1-85` |
| Ed25519 签名与验签 | `main/update_sign.js:17-101` |
| 更新器自检（未嵌入配置检测） | `main/update_util.js:1-20` |
| 壁纸设置（SPI） | `main/wallpaper.js:46-57` |
| Wallpaper Engine 回环服务 | `main/wallpaper-engine.js:44-59`、`:147-200` |
| 插件沙箱（协议/加载器/白黑名单） | `plugin-host.js:1-90`、`plugin-sandbox-context.js:9-47`、`plugin-worker.js:13-40` |
| 乐谱 PDF（printToPDF + 打印 CSS） | `main/score.js:60-88` |
| 数据库（sql.js / JSON 双模） | `main/db.js:12-61` |
| 下载器唯一入口 | `main/fast-download.js:1-110` |
| 崩溃日志 | `main/log.js:27-38` |
| 完整性与误删修复 | `integrity.js`、`main.js:687-705` |
| Tauri 命令注册 | `src-tauri/src/lib.rs:24-100` |
| Tauri 未移植缺口 | `models.rs:259`、`plugins.rs:108-113`、`score.rs:83`、`db.rs:1-2` |
| Tauri 前端桥（含 3 处空实现） | `frontend/src/bridge/tauri.js:8-55`、`:195-201` |
| 冻结结论原文 | `docs/FOUNDATION.md:101-108` |
| 桥契约口径（157 / 248） | `docs/FOUNDATION.md:27-30`、`docs/audit/2026-10-29/backend-perf.md:179-186` |
| 打包六份配置与漂移 | `docs/audit/2026-10-29/backend-perf.md:420-462` |
| 体积实测表 | `docs/audit/2026-10-29/backend-perf.md:74-108` |
| 跨平台现状 | `docs/CROSS-PLATFORM.md:1-57` |
| 更新签名流程 | `docs/UPDATE-SIGNING.md:1-54` |
| Electron 升级评估（33 EOL） | `docs/electron-upgrade.md:1-28` |
| 对外表述（"Rust · Tauri 桌面核心"） | `docs/pages/index-zh.html:733`、`docs/pages/index-en.html:670` |

## 附录 B · 本次测量方法（全部只读、可复现）

| 指标 | 方法 |
|---|---|
| handler 通道数 | Node 脚本扫 `main/**/*.js` + `main.js` 的 `ipcMain.handle(\s*["']([^"']+)["']` 去重（双引号也要匹配，否则漏掉 `main/autosave.js` 的 4 条） |
| preload 通道数 | 同法扫 `preload.js` 的 `ipcRenderer.(invoke\|send)`；事件通道单独统计 `ipcRenderer.on` |
| Tauri 命令数 | `grep -c '#\[tauri::command\]'` over `src-tauri/src/*.rs`，并与 `lib.rs` 的 `generate_handler![...]` 展开项核对（两者一致：76） |
| 代码行数 | 逐文件 `readFileSync().split('\n').length` 求和（排除 `node_modules`/`target`） |
| 产物体积 | `release/win-unpacked` 递归 `statSync` 求和；安装包取 `release/*.exe` 的字节数 |
| git 历史 | `git log --stat -- src-tauri`、`git show --stat <sha>`、`git log -S` |

> 所有命令均为只读；未构建、未安装依赖、未启动 GUI。唯一写入是本文件。

---

**文档结束**。相关文件：`01-perf-evidence.md`（性能基线）、`02-frontend-hotpaths.md`（前端热路径）、`03-engine-ml-boundary.md`（Python/ML 边界）、`05-ecosystem.md`（Rust 生态与案例）。
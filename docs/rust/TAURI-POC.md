# FuFumidi · Tauri 2 可行性 POC（A 口径）

> A 口径 = Tauri 2 外壳 + Rust 引擎，UI 继续用 Vue 3 跑在 WebView2 里。
> 本文件只记录 **独立原型** 的实测结论，不改主应用一行代码。
> 原型位置：`poc/tauri-poc/`（`main/`、`frontend/`、`engine/`、`package.json` 均未改动，无 commit）。
> 测量时间 2026-11-03 23:17–23:5x（+08:00）· 机器见 §1。

---

## 0. 结论

| 待验证问题 | 结论 | 实测证据 |
|---|---|---|
| `cargo check` 能否成功 | ✅ 成功 | 冷跑 **37 s**，rc=0 |
| `cargo build` 能否成功并出 exe | ✅ 成功 | 冷跑 **44 s**，rc=0，debug exe **12.58 MiB** |
| 增量构建耗时 | ✅ 可接受 | 改 `src/main.rs` **2.96–4.10 s**；无改动空跑 **0.71–0.92 s** |
| 产物体积 | ✅ 壳很小 | debug exe 12.58 MiB / **release 5.87 MiB**；对照现有 Electron 安装包 **606.3 MiB**（`release/FuFumidi Setup 6.4.2.exe` = 635,789,305 B） |
| 能否打开窗口 | ✅ 能 | 从进程启动到窗口句柄可用 **0.73–0.86 s**（3 次），截图 `poc/tauri-poc/artifacts/window.png` |
| WebView2 运行时版本 | ✅ 已装 | 磁盘 **156.0.4314.58**；运行时 UA `Chrome/156.0.0.0 Edg/156.0.0.0` |
| 本地 HTML 加载 + IPC 往返 | ✅ 能 | JS → Rust → JS，首次 26–31 ms（含预热），后续 **1.7–6.2 ms** |
| Tauri 2 updater 支持「多源」 | ✅ 支持（仅**顺序 failover**，无测速） | `config.rs` `endpoints: Vec<Url>`；`updater.rs` `for url in &self.endpoints` |
| Tauri 2 updater 支持「增量」 | ❌ **不支持** | 官方源码全文无 delta/patch/bsdiff/Range/续传；`download()` 整包读进内存 `Vec<u8>` |

**一句话结论：外壳层「可行」，真正的阻塞不在 Tauri 本体，而在更新链与 250 条 IPC 的工程化迁移。**

- **可行**：Tauri 2 在本机可构建、可开窗、可跑 IPC；壳体积相比 Electron 有量级优势（WebView2 由系统提供，不打进包）。
- **阻塞（流程级，不是技术级）**：crates.io 直连拉 407 个 crate 用了 **580 s（9.7 min）**，且期间出现 3 次 `spurious network error: transfer too slow`。首次构建体验与 CI 必须换镜像或预热 vendor 缓存，否则「随便改一行试试」的成本会高到没人愿意试。
- **阻塞（产品级）**：`tauri-plugin-updater` **没有增量更新**，且验签格式是 **minisign + JSON manifest**，与 FuFumidi 现有的 **Ed25519 + `update-manifest.json` + Kachina + CNB/GitHub 多源 + `.part` 原子下载** 不是一回事（见 §4.3）。迁移更新链 = 重做发布管线，不是换个插件。
- **待深挖**：NSIS 打包（本次 `bundle.active=false`，未测）、release 体积（§3.2）、插件宿主（rquickjs）、printToPDF、视频导出、以及 250 条 IPC 的代码生成。

---

## 1. 环境

| 项 | 值 | 来源 |
|---|---|---|
| OS | Windows x64（中文系统） | `rustc -vV` |
| rustc / cargo | **1.97.1**，host `x86_64-pc-windows-msvc` | `rustc --version --verbose` |
| node / npm | v24.16.0 / 11.13.0 | `node -v` / `npm -v` |
| MSVC | Visual Studio **BuildTools 2022**；Windows SDK **10.0.26100.0** | `vswhere` |
| CPU | 32 逻辑核 | `nproc` |
| 磁盘 | C: 301 GB，可用 34 GB（构建后仍够） | `df -h` |
| WebView2 Runtime | **156.0.4314.58** | `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\` |
| DPI | 250%（物理 3840×2400） | 运行时 `devicePixelRatio = 2.5` |
| 依赖版本 | `tauri` **2.12.5** / `wry` 0.57.1 / `tao` 0.37.2 | 解析结果 `Cargo.lock` |
| updater 插件 | `tauri-plugin-updater` **2.14.1**（当前 stable；仓库另有 3.0.0-alpha.3） | crates.io sparse index |
| 仓库状态 | 分支 `feat/audio-tagger-auto-probe`，Electron 6.4.2 | `git branch --show-current` |

> 注：仓库里**已有一份 `src-tauri/`**（tauri 2 + dialog + shell，`lib.rs` 手写 76 个 command，版本号停在 3.1.8/3.1.16，与当前 6.4.2 主应用脱节）。本次 POC **没有碰它**，是全新独立原型。

---

## 2. 原型结构与复现步骤

```
poc/tauri-poc/
├── Cargo.toml                 # tauri 2 + serde，无 tauri-cli、无 npm 依赖
├── build.rs                   # tauri_build::build()
├── tauri.conf.json            # frontendDist = "dist"，withGlobalTauri = true
├── capabilities/default.json  # 最小能力集：core:default
├── src/main.rs                # 2 个 command：poc_ping / poc_echo（证据写盘）
├── dist/index.html            # 自带静态页，开窗即自动跑 IPC 往返
├── icons/icon.ico             # 从 src-tauri/icons 复制（Windows 资源必需）
├── research/                  # updater 插件源码快照（v2 分支，用于 §4 核对）
├── scripts/                   # cold-timing.sh / window-probe.ps1
└── artifacts/window.png       # 开窗截图（证据）
```

**关键点：不依赖 `tauri-cli`、不依赖 npm。** `cargo build` 直接出 exe，`tauri.conf.json` 由 `tauri-build` + `generate_context!` 在编译期读取。这让 POC 的依赖面只有 crates.io。

复现（PowerShell / bash 均可）：

```bash
cd poc/tauri-poc
cargo build                       # 出 target/debug/tauri-poc.exe
./scripts/cold-timing.sh          # 计时（会 rm -rf target）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/window-probe.ps1 \
  -Exe "$(pwd -W)/target/debug/tauri-poc.exe" \
  -ShotPath "$(pwd -W)/artifacts/window.png"
```

`window-probe.ps1` 做的事：启动 exe → 轮询 `MainWindowHandle` 记录**开窗耗时** → 等 4 s 让页面跑完 IPC → 统计进程/WebView2 子进程 → `PrintWindow` 截图 → 杀进程。

---

## 3. 实测数字

### 3.1 构建耗时（32 核，debug profile）

| 阶段 | 耗时 | 备注 |
|---|---:|---|
| **首次依赖下载** `cargo fetch` | **580 s** | 407 个 crate / 411 MB registry；3 次 `transfer too slow` 重试 |
| **冷 `cargo check`**（`rm -rf target` 后） | **37 s** | rc=0，cargo 自报 36.47 s |
| **冷 `cargo build`** | **44 s** | rc=0，cargo 自报 44.07 s；产出 12.58 MiB exe |
| 冷构建合计（**不含下载**） | **81 s** | check + build |
| **空跑 `cargo build`**（无改动） | **0.71–0.92 s** | fingerprint 命中，仅做 freshness 检查 |
| **增量**（改一处 `src/main.rs` 代码） | **2.96–4.10 s** | 只重编 `tauri-poc` 自身 crate，依赖不重编 |

要点：

- **编译本身很快**（407 crate、44 s 出 exe），耗时全在**网络**。
- 冷 check 与冷 build 是两条独立流水（check 只产 `.rmeta`，build 要完整 codegen），所以 81 s 不是「44+37 浪费」，而是两个口径；日常开发只会命中增量档（3–4 s）。
- 本次 `target/` debug 目录 **2,497 MB**（含全部依赖中间产物）。CI 必须缓存 `~/.cargo` 与 `target/`，否则每次 10 分钟网络 + 1.5 分钟编译。

### 3.2 产物

| 产物 | 体积 | 说明 |
|---|---:|---|
| `target/debug/tauri-poc.exe` | **13,190,144 B = 12.58 MiB** | debug + debuginfo |
| `target/release/tauri-poc.exe` | **6,157,824 B = 5.87 MiB** | lto + strip + opt-level="s" |
| `target/`（debug） | 2,497 MB | 中间产物，不入包 |
| **release 构建**（`cargo build --release`，`lto=true` / `codegen-units=1` / `strip=true` / `opt-level="s"`） | **129 s** | rc=0，cargo 自报 2m 08s；产出 **5.87 MiB** exe |
| `target/release/` 目录 | 1,128 MB | 中间产物，不入包 |
| **对照：现有 Electron 安装包** | **635,789,305 B = 606.3 MiB** | `release/FuFumidi Setup 6.4.2.exe` |

> 12.58 MiB 只是**壳**：不含前端资源、不含引擎、不含模型。它证明的是「同样是 WebView 外壳，Tauri 侧基线只有 MB 级」；不等于 FuFumidi 成品会只有 12 MiB（Vue 产物 17 MB、音色库/模型/引擎才是大头）。真正的价值是**去掉 Electron/Node/Chromium 那一份固定开销**，不是把 606 MiB 变成 12 MiB。

（release：129 s → 5.87 MiB，见 §3.2 与文末补记。）

### 3.3 运行时

| 指标 | 实测 |
|---|---|
| 进程启动 → 窗口句柄可用 | **0.73 / 0.83 / 0.86 s**（3 次） |
| 窗口标题 | `FuFumidi Tauri POC`（配置生效） |
| 窗口物理尺寸 | 2282×1588（逻辑 900×600 @ dpr 2.5，含标题栏边框） |
| 主进程内存 | WorkingSet **35.4 MB** / Private **9.9 MB** / 44 线程 |
| WebView2 子进程 | 启动前系统已有 6 个 → 启动后 **12 个**（本应用 +6）；杀掉主进程后回落到 6，**无残留** |
| WebView2 运行时 | UA：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0` |
| 页面视口 | `900x600`，`devicePixelRatio = 2.5` |

**IPC 往返（JS `invoke` → Rust command → 返回）**，同一页面内连续调用：

| 调用 | 耗时 |
|---|---:|
| `poc_ping`（首次，含 webview 预热） | 26.1–30.7 ms |
| `poc_echo`（首个小对象） | 6.2–10.5 ms |
| `poc_echo`（对象：音符/数组） | 2.0–2.6 ms |
| `poc_echo`（含 64 字节数组） | 1.7–2.4 ms |
| `poc_echo`（汇总，含全部 timings） | ~1–2 ms |

结论：**IPC 本身不是瓶颈**；首帧那次 30 ms 是 webview 预热，稳态 2 ms 量级。250 条 command 的迁移成本在**接口设计与代码生成**，不在调用开销。

**踩到并已修正的语义差异（迁移时会批量踩）**：Tauri 的 command 参数是**具名**的。
Electron 是 `ipcRenderer.invoke('chan', a, b)`（位置参数），Tauri 是 `invoke('cmd', { payload: ... })`。
第一版页面直接 `invoke('poc_echo', {sym:'C4'})` → Rust 侧报 `missing required key payload`，只有 `poc_ping`（无参）成功（`ipc-smoke.log` 里当时只有 1 行）。改成 `{ payload }` 后 4 条全部成功。**这条必须在桥接层统一处理，否则 250 条里会错一大片。**

证据文件：`poc/tauri-poc/ipc-smoke.log`（Rust 侧追加写入，JS 无法伪造）；截图 `poc/tauri-poc/artifacts/window.png`。

---

## 4. `tauri-plugin-updater` 的「多源 / 增量」——源码级核对

核对对象：`tauri-apps/plugins-workspace` v2 分支 `plugins/updater`，crate 版本 **2.14.1**；源码快照已存 `poc/tauri-poc/research/`（`updater.rs` / `config.rs` / `lib.rs` / `Cargo.toml`）。以下结论全部来自读源码，不是猜。

### 4.1 多源：支持，但只是「顺序 failover」

- 配置：`config.rs` 的 `Config` 有 `endpoints: Vec<Url>`（数组），运行时可被 `Updater::endpoints(Vec<Url>)` 覆盖（`updater.rs:267–283`）。
- 检查逻辑（`updater.rs` `Updater::check`）：**按数组顺序逐个请求**，`for url in &self.endpoints`，第一个返回「可解析的 manifest」的源胜出；全部失败才报错。
- URL 支持变量替换：`{{current_version}}`、`{{target}}`、`{{arch}}`、`{{bundle_type}}`，便于「一个源里按平台取」。
- **没有**：并发探测、测速、健康度打分、失败源冷却、镜像池调度。慢源在前就会拖慢每次 `check`。
- 端点强制 https（`validate_endpoints`），除非显式打开 `dangerousInsecureTransportProtocol`。

→ 「多源」= ✅ 有；「多源测速 / 就近选源」= ❌ 要自己在应用层做（FuFumidi 的 `pickUpdateSource` / HEAD 探测就是这么干的，见 `src-tauri/src/updater.rs` 的移植注释）。

### 4.2 增量：**不支持**

- 对 `updater.rs` / `lib.rs` / `README.md` 全文 grep `delta|patch|bsdiff|incremental|zstd`：**零命中**。
- `Update::download()`（`updater.rs:819` 起）实现：`reqwest` GET 整个 URL → `bytes_stream()` 逐块读进内存 `Vec<u8>` → `verify()`（minisign 验签）→ 返回字节。**没有 Range 请求、没有 `If-Range`、没有断点续传、没有分块落盘**（大安装包会整包驻留内存）。
- `Update::install(bytes)`：验签通过后**直接运行整包安装器**（Windows：NSIS `/P` 或 MSI `msiexec`，`windows.installMode` 可选 passive/quiet/basicUi），随后**退出应用**。
- 官方能力边界就是「整包下载 + 整包装」。想增量只能自研：差分（bsdiff/zstd patch）+ 自己的安装器 + 自己的验签链，官方插件不提供钩子。

### 4.3 与本仓库现有更新链的差距（迁移成本）

| 维度 | 现有 FuFumidi（Electron/Kachina/Rust 雏形） | `tauri-plugin-updater` |
|---|---|---|
| 元数据 | `update-manifest.json`（`fufumidi-update/v1` 规范串） | JSON manifest：`version` / `pub_date` / `platforms{target:{url,signature}}` |
| 签名 | **自研 Ed25519**，签的是「版本+文件名+sha256」规范串 | **minisign**（`minisign_verify`），签的是产物字节 |
| 安装包 | `FuFumidi.Install.exe`（自定义离线包） | NSIS `-setup.exe` / MSI / AppImage / .app |
| 多源 | CNB + GitHub + 3 个加速镜像，**测速选源 + 逐源回退** | 静态 endpoints 顺序回退 |
| 下载 | 分段/并发/续传/看门狗/完整性校验 + `.part` 原子落盘 | 单流整包内存 |
| 增量 | 无（现有也是整包） | 无 |

→ 切到官方插件 = **重做签名（minisign）、重做产物（NSIS）、重做 manifest、丢掉自研的多源测速与续传**；保留现状 = **继续维护 Kachina（第三方无源码）**。两条路都不免费，这是 P1 必须先拍板的决策，不是 POC 能绕过的。

> 混搭是可行的：`Update::install(bytes)` 可以单独调用，用自研下载器取字节、只借插件的验签+安装。前提是签名换成 minisign、manifest 换成官方格式。

---

## 5. 结论：可行 / 阻塞 / 待深挖

- **可行（已验证）**：Tauri 2 外壳构建、开窗、Vue/任意本地 HTML 加载、IPC 往返、WebView2 复用、体积基线。
- **阻塞（必须先解决才能进全量）**：
  1. **crates.io 网络**：首拉 9.7 min。必须配镜像（如 rsproxy/字节源）或 vendor 缓存 + CI 缓存，否则团队开发体验不可接受。
  2. **更新链**：官方插件无增量、验签格式不兼容（§4）。要做 P1 就必须先定「自研 updater / 继续 Kachina / 换官方插件」。
- **待深挖（本 POC 未覆盖）**：NSIS 打包与安装（本次 `bundle.active=false`）、release 体积、rquickjs 插件宿主、printToPDF、WebCodecs 视频导出、托盘/单实例/全局热键/文件关联、系统缺 WebView2 时的引导安装（Evergreen Bootstrapper）。

---

## 6. 要把 250 条 IPC 迁到 Tauri command，还需要的 5 件事

实测基线（本仓库当前状态）：

| 指标 | 数量 | 来源 |
|---|---:|---|
| `ipcRenderer.invoke` 调用点 | **255** | `preload.js` grep |
| `ipcMain.handle` 注册点 | **247** | `main/*.js`（55 个文件）grep |
| `ipcRenderer.on` 事件订阅 | **29**（28 个事件名） | `preload.js` grep |
| 主进程代码量 | 17,913 行 | `main/*.js` |
| 仓库里 Tauri 手写 command（旧骨架） | 76 | `src-tauri/src/lib.rs` |

### ① 一份契约源 + 代码生成（不做这一步，250 条必然写崩）

Tauri 的 `#[tauri::command]` 是**编译期宏**，不能运行时注册；`generate_handler!` 必须静态列出全部命令。
手写 250+ 个 command 不可维护——仓库里那份 76 个 command 的旧骨架就是证据。
需要：把现有 `params.schema` 扩成 **`bridge.schema.json`（channel → 入参/出参/事件/错误码）**，由它生成三样东西：
Rust 侧注册表（或一个 `bridge_dispatch(channel, args)` 总入口 + 静态分发表）、TS 类型（替换手写的 1,400 行 `frontend/src/types/ipc.ts`）、以及 `window.fuBridge` 适配层。
**验收口径**：新增一个 channel 只改 schema，三处自动生成，`npm run audit:params` 仍绿。

### ② 桥的形状必须保持（渲染层「零改动」是硬约束）

`window.fuBridge` 的 255 个方法名、参数位置、回调形态都不能变，否则 78k 行前端和 13k 行 i18n 都要跟着改。
新写一个 `bridge/tauri.ts`：`fuBridge.xxx(...args) → invoke('bridge_call', { channel: 'xxx', args })`。
同时逐条替换 Electron 专有 API：`webFrame.setZoomFactor/getZoomFactor`（→ WebView2 zoom）、`webUtils.getPathForFile`（→ 拖拽事件自带路径）、`ipcRenderer.on`（→ `listen` / `Channel`）、`clipboard`/`shell`/`tray`（→ 官方插件）。
**注意 §3.3 的具名参数坑**：Electron 是位置参数，Tauri 是具名参数，桥接层必须统一包装。

### ③ 二进制载荷要专门设计（这是最容易翻车的一条）

Electron 的结构化克隆可以直传 `Uint8Array`；Tauri 2 默认把返回值 `serde_json` 序列化（`tauri 2.12.5` `src/ipc/mod.rs`：`impl<T: Serialize> IpcResponse for T`）。
FuFumidi 的 `read_binary` / `read_soundfont` / `save_binary` / 音频块必须走：
`tauri::ipc::Response`（原始字节，2.x 已提供）或自定义协议 / `convertFileSrc`；大文件优先「传路径，Rust 侧读」而不是「传字节」。
进度/日志流（现存 28 个事件里有 `model:progress` / `engine:log` 等）用 `ipc::Channel<T>` 或 `emit`，不要用轮询 invoke。

### ④ 权限与路径模型要重新划

Tauri 2 的 capability/ACL + FS scope 只约束**插件命令**；应用自己的 command 不受 ACL 限制（本次 POC 只给了 `core:default` 就能调自定义 command）。
现有主进程能直接读写任意路径（数据根、模型目录、拖拽文件、`%APPDATA%`），迁移时只有两条路：
**全部收进 Rust command（推荐，不启用 fs 插件）**，或逐条声明 scope。
文件对话框换成 `tauri-plugin-dialog`，注意返回语义要与现有「多选/目录/扩展名过滤」一致。
另外 `withGlobalTauri: true` 才会注入 `window.__TAURI__`（POC 里必须显式打开，默认是关的）。

### ⑤ 长任务、子进程与生命周期必须重新设计

现有 `engine` 是 Python 子进程 + JSON 行协议（`###PROG` / `###RESULT`）+ 取消/暂停。
Tauri 侧需要：job 表（id → 句柄/取消令牌/进度）、sidecar 管理、崩溃看门狗、以及**窗口关闭时任务是否继续**的明确语义（现在 Electron 主进程退出即全杀）。
command 本身要 `async` + 后台线程，不能堵住 IPC；取消要走命令而不是杀进程。
**验收口径**：冒烟脚本能验证「启动→进度→取消→产物清干净」，而不只是「窗口能开」——本次 POC 已经证明「窗口能开」离「能用」还有很远的距离。

---

## 7. 踩坑与卡点（含失败，按发生顺序）

| # | 现象 | 原因 | 处置 |
|---|---|---|---|
| 1 | `cargo fetch` 首轮 580 s 后 **rc=127**，之后 `cargo check` 也 rc=127、`target/` 为空 | 未复现出根因；疑与被 kill 的并发 cargo 抢构建锁 / 网络中断有关。同一条命令重跑均 rc=0 | 重跑后正常；`target/` 清空重来，正式数据取重跑结果 |
| 2 | `cargo fetch` 期间 3 次 `spurious network error: transfer too slow (30s / 0 bytes)` | crates.io 直连慢 | 重试后补齐；建议换镜像（§5） |
| 3 | `cargo check` 报 **proc macro panicked**：`frontendDist "../dist" but this path doesn't exist` | `frontendDist` 相对 **`tauri.conf.json` 所在目录**解析，而本项目 conf 就在 crate 根，`../dist` 指到了外层 | 改成 `"dist"`（也可把 conf 放进 `src-tauri/` 子目录再 `../dist`） |
| 4 | 页面里 `poc_echo` 全部失败，只有 `poc_ping` 成功 | Tauri command 参数是**具名**的，`invoke('poc_echo', {sym})` 缺 `payload` 键 | 改成 `invoke('poc_echo', { payload })`；已写入 §3.3 |
| 5 | 截图拍到别的窗口（浏览器），或画面偏移 | ① 进程无前台权限，窗口没被置前；② 系统 DPI 250%，PowerShell 默认非 DPI-aware，`GetWindowRect` 与 `CopyFromScreen` 用的是不同坐标系 | 脚本加 `SetProcessDPIAware` + `SetWindowPos(TOPMOST)`；最终改用 `PrintWindow(..., 2)` 直接抓窗口位图 |
| 6 | `window-probe.ps1` 报「意外的标记 }」 | PowerShell 5.1 按 ANSI 读**无 BOM** 的 .ps1，中文注释变乱码导致语法错 | 测量脚本改纯 ASCII（仓库规则是 .ps1 必须 UTF-8 with BOM；本次选择更省事的 ASCII） |

**没有发生的**：依赖解析失败、链接失败（MSVC/SDK 齐备）、WebView2 缺失、图标缺失导致构建失败。

---

## 8. 下一步（建议顺序）

1. **先定更新链**（P1 前置）：自研 Rust updater（保留现有 Ed25519 + 多源测速 + 续传 + `.part`）还是换官方插件（minisign + NSIS + 整包）。这一条决定后续所有发布脚本的重写量。
2. **配 cargo 镜像 + CI 缓存**，把「首拉 10 分钟」从开发日常里消掉；用 `cargo vendor` 或镜像源二选一。
3. **做 IPC 代码生成的纵切**：挑 10 条真实 channel（含 1 条二进制、1 条进度事件、1 条取消），跑通「schema → Rust + TS + 桥」全链路，再按域铺开 250 条。
4. **补测**：`tauri build` NSIS 打包 + 安装 + 覆盖升级；release 体积；无 WebView2 机器的引导。
5. 再进 P2（rquickjs 插件宿主）/ P3（printToPDF）/ P4（视频导出）。

---

## 附：本次未测 / 不能作为结论的部分

- `tauri build`（NSIS bundle）未跑：本次 `bundle.active=false`，只验证 `cargo build`；打包体积、安装行为、覆盖升级、卸载残留都未测。
- release profile 的最终体积见下方补记；**不带 `lto` 的 release 或 debug 体积不能直接当产品体积**。
- 多窗口/托盘/单实例/全局热键/文件关联/自启均未测。
- 大文件二进制 IPC（`ipc::Response`）只是读源码确认 API 存在，**没有实测吞吐**。
- 现有 `renderer/dist`（17 MB Vue 产物）在 Tauri 下的加载未测：本次用的是自带静态页；已知缺口是 `window.fuBridge` 不存在，Vue 应用启动即会失败（这是预期的，正对应 §6②）。

---

### §3.2 补记：release 体积

- release exe：**6,157,824 B = 5.87 MiB**，构建 **129 s**（含全量 LTO；32 核）。
- debug → release 从 12.58 MiB 降到 5.87 MiB（`strip` + `lto` + `opt-level="s"`）。
- 这个数字仍然只是**空壳**：没有前端资源、没有引擎、没有模型。它的意义是与 Electron **同一功能层级**（一个能开窗跑 webview 的宿主）对比：**5.87 MiB vs Electron 宿主自身上百 MB**。
- release 二进制已实测可开窗（见 `poc/tauri-poc/artifacts/window-release.png`）。
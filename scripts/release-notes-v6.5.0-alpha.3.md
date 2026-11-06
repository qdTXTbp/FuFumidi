# FuFumidi 6.5.0-alpha.3

日期：2026-11-06
基线：6.5.0-alpha.2（Tauri）

本版完成 S6 剩余分项：插件 JS 宿主、DiffSinger 组件与声库管理，并把音色 / UTAU 声库 / GPU / OMR 的真实下载链跑通。
全部验证均为无头方式，未启动窗口、安装器或弹窗。

## 完成项

### 插件（Tauri JS 宿主）
- 新增前端插件宿主：每个启用插件一个 Web Worker，执行 CommonJS 入口（相对 require、JSON、白名单内置模块 path/util/events/url/querystring/assert/os/crypto/buffer）。
- 支持 `ctx.commands`、`ctx.events`、`ctx.engine.run`（Rust 代执行 Python，日志实时回传）、`ctx.settings`、`ctx.ui.broadcast/notify`、`ctx.log`、`ctx.app.getSongMeta`。
- 插件自带的 Python 脚本可直接调用（脚本路径限制在插件目录内）；清单扫描改为纯 Rust，不再依赖 Python。
- 插件 renderer 脚本按 Electron 语义注入页面；`ctx.ui.broadcast` 派发 `fuplugin:<id>:<name>` 事件。

### DiffSinger 组件与声库
- 组件安装：pip 依赖（onnxruntime / pyyaml）+ NSF-HiFiGAN 声码器（约 50 MB，多源 / 断点 / 取消 / 进度）。
- 声库：公开 Ria 声库一键下载；ModelScope AI 声库下载 / 取消 / 解压 / 安装；本地 zip 导入、删除、列表。
- 进度事件与 Electron 对齐：`diffsinger:runtimeProgress` / `diffsinger:voicebankProgress` / `diffsinger:msProgress`，同时写全局 `model:progress`（dsms: 前缀）。

### 音色 / 声库 / GPU / OMR 实测
- SF2：florestan-subset.sf2 真实下载 531,786 B，RIFF 头校验通过。
- UTAU：陈者（中文单独音）归档 26,440,058 B，解压 833 文件，oto.ini + character.txt 校验通过。
- GPU：GitHub/CNB 发现 gpu-v2 分卷（3 个包），声明体积与两端实测一致，Range 拉取 ZIP 头通过。
- OMR：tessdata eng 23,466,654 B；Audiveris MSI 85,062,430 B 且 SHA-256 与钉死值一致；waifu2x SR 约 35 MB。
- 插件平台：目录正常；插件包下载在部分网络下 curl SSL 失败，改为 PowerShell Invoke-WebRequest 优先 + curl 回退。

### 修复
- Tauri 命令参数统一为 camelCase：修复双击打开、重命名、工程打开、自动保存读取、壁纸导入、DiffSinger 导入等调用因参数名不一致而失败。
- 插件清单不再依赖 `engine/plugin_render.py`，纯 Tauri 环境也能列出已装插件。

## 验证

- `cargo test --offline`：**164 passed / 0 failed / 12 ignored**（含 DiffSinger / resource_extras 单测）
- `cargo clippy --offline -- -D warnings`：0 warning
- `npm run test:ui`：**642 passed / 0 failed**
- `npm run typecheck`：0 错误
- 前端构建：通过
- 真实网络冒烟：`node scripts/tauri/s6-smoke.mjs` **8/8 PASS**（SF2 / UTAU / GPU / OMR×3 / homr / 插件平台，详见 `docs/port/s6-verification.md`）

## 已知限制

- 插件宿主为无头验证（单测 + Edge headless Worker），未在真实 Tauri 窗口内跑端到端；依赖完整 Node API 的插件会降级。
- `plugins_invoke` 由前端 JS 宿主执行；宿主未启动时 Rust 命令返回明确错误。
- 插件应用事件（song-loaded/view-changed 等）暂未接入前端事件源。
- OMR 的 Audiveris MSI 仅验证下载与指纹，未执行 msiexec 解包（按要求不运行安装器）；homr venv 安装未实机执行。
- GPU 分卷下载目前串行。

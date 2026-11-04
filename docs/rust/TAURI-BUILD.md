# Tauri 双构建与 NSIS 安装包

> 2026-11-04 实测记录。目标：与 Electron 版共享同一份 `renderer/dist` 与 resources，逐步替换壳。

## 1. 命令

```powershell
npm run build:ui          # 只构建前端（Tauri 会把 renderer/dist 嵌入 exe）
npm run tauri:build       # debug 壳（cargo build）
npm run tauri:release     # release 壳，不打包（tauri build --no-bundle）
npm run tauri:stage       # 生成 shells/tauri/bundle（802MB，已 gitignore）
npm run tauri:bundle      # build:ui + stage + NSIS 安装包
```

Tauri CLI 固定在 devDependency `@tauri-apps/cli@2.12.4`（crate tauri 2.12.5）。
曲库/设置/歌单直接共享 Electron 的 `fufumidi.sqlite` 与 legacy `settings.json`（rusqlite bundled），
安装版首次启动即可看到老用户曲库；测试用 `FUFUMIDI_DATA_ROOT` / `FUFUMIDI_DB_FILE` 隔离。
原生文件对话框用 `tauri-plugin-dialog 2.8.4`（Rust 侧直接调用，不依赖前端插件权限）。

## 2. 打包内容（与 electron-builder.base.yml 对齐）

| 源 | 目标 | 说明 |
|---|---|---|
| `resources/python`（过滤 torch/demucs/torchvision/torchaudio/piano_transcription_inference 及对应 Scripts） | `python/` | 773 MB → 安装后 764 MB |
| `engine`（排除 tests/__pycache__） | `engine/` | 7.9 MB |
| `renderer/vendor/soundfonts` | `soundfonts/` | 31 MB（GeneralUser.sf2 等） |
| `resources/models/basic_pitch_quant.onnx` | `models/` | 264 KB（其余模型按需下载） |
| `resources/elevate.exe` | `elevate.exe` | 提权辅助 |

安装后资源就在**安装目录根**（与 exe 同级），不是 resources/ 子目录：
`python/ engine/ soundfonts/ models/ elevate.exe FuFumidi.exe`。
`tauri.conf.json` 设 `mainBinaryName: "FuFumidi"`，安装包主程序已是 **FuFumidi.exe**。
Rust 端资源解析因此同时支持 exe 旁与 resources/（debug 才允许回退仓库路径）。

## 3. 实测

| 项 | 结果 |
|---|---|
| 安装包 | `poc/tauri-poc/target/release/bundle/nsis/FuFumidi_6.5.0-beta.1_x64-setup.exe`，**238.38 MiB**（含 rusqlite/dialog） |
| 安装后体积 | **814 MB**（12752 个 Python 文件全部落盘） |
| 安装方式 | `setup.exe /S /D=E:\Midi\_attic\tauri-install-test5`（currentUser） |
| 安装版 smoke | **24/24 全绿**：`node scripts/tauri/smoke.mjs --exe <安装目录>\FuFumidi.exe` |
| 安装版老数据 | 无 env 启动：**1972 首**真实曲目、57 设置键、侧栏「全部曲目 1972」 |
| 资源来源 | host_info 显示 python/engine 均来自**安装目录**（不再回退开发树） |
| 真实推理 | 1 s WAV → Basic Pitch 1 音符，**5.3 s** |
| 窗口/界面 | 真实 renderer 已嵌入 exe；四页路由 + 曲库刷新显示通过 |

## 4. 网络坑（NSIS 工具链）

Tauri 默认从 GitHub 下载 `nsis-3.13.zip`，本机直连超时。已把工具链预置到
`%LOCALAPPDATA%\tauri\NSIS`（SHA1 校验通过，与 Tauri 常量一致）：

- `nsis-3.13.zip`：`DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E`（经 ghfast.top 代理）
- `nsis_tauri_utils.dll` v0.5.3：`75197FEE3C6A814FE035788D1C34EAD39349B860`

## 5. 已知限制（未完成部分）

- 安装包**未签名**：SmartScreen 会拦；正式发布需 Authenticode 证书。
- **Electron 回退基准**：Electron E2E **37/37**；`pack:base` 成功；
  **`npm run dist:win` 已产出 `release/FuFumidi Setup 6.5.0-beta.1.exe`（约 614 MiB）**。
  为修 EBUSY/7.2GB asar，`electron-builder.yml` / base 配置排除了 `shells/**`、`poc/**`、
  `crates/**`、`ci-resources/**`、`**/target/**`（Tauri 产物不再进 Electron 包）。
  安装冒烟未完成：本无头会话里 Electron NSIS 静默安装挂起（Tauri NSIS 同法可装），留待交互桌面手测。
- bundle staging 802MB 不入库，`npm run tauri:stage` 可重建。

## 6. Release 构建验证（无窗口）

- `cargo build --release --offline` 通过（optimized 2m10s）；
- `poc/tauri-poc/target/release/fufumidi-shell.exe` 约 15 MiB；
- 清理未使用的 autosave_root 警告；cargo test 33/33 + 1 ignored 通过；
- 只编译，不启动窗口/安装器。

## 7. 无窗口生产 worker 自检（2026-11-04）

- `fufumidi-shell.exe --engine-self-check` 在 Tauri Builder 之前早退，不创建 WebView 窗口；
- 真实走生产 `spawn_worker`/WorkerPool，发缺文件请求并读取 `###RESULT`，打印 pid/result/warm 后 `pool.shutdown()`；
- 实测 `ok:true, warm:1`，无 Python/壳残留；用于 P1/P2 安装产物验收。

## 8. 2026-11-04 终验（当前源码）

- `cargo build --release --offline` 通过（optimized 2m19s）；
- release `--self-check` 通过：host ok、pythonExists、renderer=`<embedded>`；
- release `--engine-self-check` 通过：真实 spawn_worker / `###RESULT`，warm=1，无窗口/无残留；
- 隐藏全量 E2E **40/40**；`test:ui` **589/589**；typecheck/audit 0；cargo test **102/102 + 1 ignored**。

## 9. 命令注册审计

- `npm run tauri:handler-audit`：扫描所有 `#[tauri::command]` 与 `generate_handler![]`，缺一即退出 1；
- **已并入 `npm run audit`**，普通质量门禁即可拦住漏注册。
- 当前 **136/136** 已注册；本轮修掉 `model_delete` 漏挂（桥 `modelDelete` 原本会运行时失败）。

## 10. 2026-11-04 复验（单实例修复后）

- 修复 `.setup` 未启动 accept 线程后重新 release 构建：2m24s；
- release `--self-check`：host ok / renderer embedded；
- release `--engine-self-check`：真实 worker / warm=1 / 无残留；
- 测试构建已无 unused 警告；隐藏 smoke 1/1；无 Python/壳残留。

## 11. 2026-11-04 当前源码 release（插件安装后）

- 143 命令源码 release 构建：2m21s，**0 warning**；
- host `--self-check`：pythonExists / renderer embedded / version 正确；
- `--engine-self-check`：真实 worker / warm=1 / 无 Python/壳残留；
- 隐藏全量 E2E 40/40、test:ui 589/589、cargo 113/113 (+1 ignored)。

## 12. 2026-11-04 任务中心接线后 release

- run_convert 补 tasks 参数与 ConvertTask guard，release 重新构建 2m18s、**0 warning**；
- engine self-check 真实 worker/warm=1/无残留；任务中心自此才会真实发 `tasks:update`。

## 13. 2026-11-04 146 命令 release（任务取消后）

- release 构建 2m16s、0 warning；
- host `--self-check` 通过（embedded renderer）；
- `--engine-self-check` 通过（真实 worker / warm=1 / 无 Python/壳残留）；
- 任务中心含 tasks_cancel；隐藏 E2E 40/40、test:ui 589/589、cargo 114/114 (+1 ignored)。

## 14. 2026-11-04 150 命令 release（视频导出）

- release 构建 2m11s、0 warning；
- host/engine self-check 通过，无窗口/残留；
- bundled Python 已确认可 import `imageio_ffmpeg` 并返回 ffmpeg 7.1 路径；
- `npm run tauri:video-smoke`（合成 1s H.264 + WAV，按 `video_export_end` 参数封装 MP4）：**ok=true / 15827 bytes**；验证 stream copy + AAC + `-t` + faststart；WebCodecs 编码本身仍未跑。

## 15. WebCodecs 编码验证（hidden E2E）

- 新增 `scripts/e2e/cases/video-webcodecs.mjs`：隐藏窗口内 VideoEncoder 配置 H.264 Annex B，编码 6 帧，要求 chunks/bytes > 0；
- 隐藏全量 **41/41** 通过；
- 覆盖渲染端编码能力（Electron/Chromium）；Tauri WebView2 内同一路径仍需真实窗口验证。

## 16. 2026-11-04 156 命令 release（cover）

- 移除 CoverJob 未使用 id 后，release 构建 2m20s、**0 warning**；
- engine self-check：真实 worker / warm=1 / 无残留；
- 含 cover 后端；真实 engine_cover.py 仍未跑。

## 17. 2026-11-04 156 命令 release（分离解析）

- 去掉 resolver 重复的 best 变量后，release 构建 2m16s、**0 warning**；
- engine self-check：真实 worker / warm=1 / 无残留；
- 含 cover 分离模型解析；真实 engine_cover.py 仍未跑。

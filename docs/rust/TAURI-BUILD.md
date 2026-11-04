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

## 2. 打包内容（与 electron-builder.base.yml 对齐）

| 源 | 目标 | 说明 |
|---|---|---|
| `resources/python`（过滤 torch/demucs/torchvision/torchaudio/piano_transcription_inference 及对应 Scripts） | `python/` | 773 MB → 安装后 764 MB |
| `engine`（排除 tests/__pycache__） | `engine/` | 7.9 MB |
| `renderer/vendor/soundfonts` | `soundfonts/` | 31 MB（GeneralUser.sf2 等） |
| `resources/models/basic_pitch_quant.onnx` | `models/` | 264 KB（其余模型按需下载） |
| `resources/elevate.exe` | `elevate.exe` | 提权辅助 |

安装后资源就在**安装目录根**（与 exe 同级），不是 resources/ 子目录：
`python/ engine/ soundfonts/ models/ elevate.exe fufumidi-shell.exe`。
Rust 端资源解析因此同时支持 exe 旁与 resources/（debug 才允许回退仓库路径）。

## 3. 实测

| 项 | 结果 |
|---|---|
| 安装包 | `poc/tauri-poc/target/release/bundle/nsis/FuFumidi_6.5.0-beta.1_x64-setup.exe`，**237.81 MiB** |
| 安装后体积 | **814 MB**（12752 个 Python 文件全部落盘） |
| 安装方式 | `setup.exe /S /D=E:\Midi\_attic\tauri-install-test2`（currentUser） |
| 安装版 smoke | **24/24 全绿**：`node scripts/tauri/smoke.mjs --exe <安装目录>\fufumidi-shell.exe` |
| 资源来源 | host_info 显示 python/engine 均来自**安装目录**（不再回退开发树） |
| 真实推理 | 1 s WAV → Basic Pitch 1 音符，**4.2 s** |
| 窗口/界面 | 真实 renderer 已嵌入 exe；四页路由 + 曲库刷新显示通过 |

## 4. 网络坑（NSIS 工具链）

Tauri 默认从 GitHub 下载 `nsis-3.13.zip`，本机直连超时。已把工具链预置到
`%LOCALAPPDATA%\tauri\NSIS`（SHA1 校验通过，与 Tauri 常量一致）：

- `nsis-3.13.zip`：`DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E`（经 ghfast.top 代理）
- `nsis_tauri_utils.dll` v0.5.3：`75197FEE3C6A814FE035788D1C34EAD39349B860`

## 5. 已知限制（未完成部分）

- 安装包**未签名**：SmartScreen 会拦；正式发布需 Authenticode 证书。
- exe 名仍是 `fufumidi-shell.exe`（Cargo target）；产品名/窗口/图标已是 FuFumidi；
  正式包前改 `mainBinaryName` 或用 `[[bin]]` 改名并重跑安装冒烟。
- **Electron 回退构建尚未在本轮验证**（Electron E2E 仍 35/35）；T-119 完成前必须双跑。
- bundle staging 802MB 不入库，`npm run tauri:stage` 可重建。

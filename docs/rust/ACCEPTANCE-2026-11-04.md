# Tauri 迁移验收快照（2026-11-04）

> 状态：**未完成，未上传**。目标是 Tauri 替换 Electron 并尽量 Rust 化；Python 仅保留模型推理。
> 用户要求验收前不弹窗、不上传；本文件用于验收前对表，不作为完成声明。

## 1. 当前基线

- 分支：`feat/audio-tagger-auto-probe`
- 最新代码提交：`e24fffa`（验收文档另提交）
- Electron 原版基线：6.5.0-beta.1（`47f6062`）
- Tauri 命令：**158**（handler 注册审计 158/158）
- 前端 bridge 方法：**182 / 265**
- 未映射：**84**
- 前端 invoke 通道：**250**，Tauri 已接 **174**
- 参数审计不一致：**23**（均为已知/兼容项）
- 可见窗口：**0**（自本轮起所有验证走隐藏窗口/无窗口）

## 2. 已可验收的运行时能力

| 能力 | 状态 | 证据 |
|---|---|---|
| Tauri 壳 + 内嵌 renderer | 已做 | `--self-check`：renderer=`<embedded>`、version 正确 |
| 共享 Electron SQLite/settings | 已做 | Rust rusqlite + host 测试；隐藏 E2E 曲库/设置 |
| 转录 worker 池 | P1/P2 已做 | cap 1–4、effective_cap、JobMap 精确取消、status workers；cargo 109 测试 |
| 生产 worker 无窗口自检 | 已做 | `--engine-self-check`：真实 spawn_worker/###RESULT，ok/warm=1 |
| 编辑页撤销/历史 | P-011 已做 | session 单栈；隐藏 E2E 39→40 |
| 编辑↔编排跨页撤销 | P-011 已做 | session 同 doc 引擎；E2E edit-arrange-session |
| 文件关联冷启动 | 已做 | argv → pending → importFiles |
| 第二实例文件/聚焦 | 已做（协议级，监听已真实挂到 setup） | TCP 127.0.0.1:47823；Builder 前退出；Rust 单测路径/FOCUS；真实双实例窗口未跑 |
| UTAU 声库 | 列表/OTO 读写/删除/导入 zip/导出目录/导出 zip | Rust 单测 + bridge |
| RVC 模型 | 列表/删除/文件夹/文件/zip 导入/内置目录/probe；通用 modelDelete 的 rvc: 前缀委托 RVC 删除 | Rust 单测；probe 真实模型未跑 |
| 插件中心 | catalog/platformInfo/installedList/openPlatform；两段式 installFromPlatform→confirmInstall→cancelInstall；离线 manifest 缓存；覆盖安装回滚备份 | Rust 单测：manifest/路径穿越/盘符/回滚代码；真实平台下载/插件执行未跑 |
| 人声分离 | separate_audio 走 music2midi.py，复用分离模型解析，转发日志/进度，sepN 可取消 | Rust args 单测；真实分离未跑 |
| 翻唱 Cover | 歌手/选音频/选目录/打开/取消/run；歌手字段对齐；分离模型解析（HTDemucs/Roformer/MDX/UVR）；cover:progress 事件 | Rust args/歌手映射/分离解析单测；真实 engine_cover.py 未跑 |

## 3. 门禁结果（当前源码）

- 隐藏全量 E2E：**41/41**（含 video-webcodecs、cover、separate/UM 桥接，`show:false`）
- 前端单测：**589/589**（`npm run test:ui`）
- `npm run typecheck`：0
- `npm run audit`：0
- `cargo test --offline`：**114 passed / 0 failed / 1 ignored**
- `npm run tauri:handler-audit`：**158/158** 已注册，并已并入 `npm run audit`
- release build：通过（158 命令，2m32s、0 warning，见 `TAURI-BUILD.md` §28）
- `npm run tauri:video-smoke`：ok=true / 15827 bytes（合成 H.264+WAV 封装）
- `npm run tauri:cover-smoke`：ok=true / status 0，engine_cover.py 参数面存在
- `npm run tauri:cover-engine-smoke`：ok=true / status 0，真实 analyze 合成音频并返回 ###RESULT（不含 RVC/分离/混音）
- `npm run tauri:separate-smoke`：ok=true / status 0，music2midi.py separate 参数面存在（不跑推理）
- GPU 统一内存实验：本机无 cudart，脚本返回 backend-missing（命令已接入）
- hidden `video-webcodecs`：VideoEncoder 实际编码 6 帧 H.264 Annex B，chunks/bytes > 0（Electron/Chromium；WebView2 未直接验证）
- release `--self-check` / `--engine-self-check`：通过（158 命令源码）

## 4. 仍需完成的重型缺口

### 4.1 IPC 主要分组（101）

- DiffSinger：19（catalog/download/render/status 等，依赖 ML 资产）
- OMR：16（Audiveris/Homr 安装、状态、语言包、进度）
- 插件中心：12（catalog/installFromPlatform/platformInfo/installedList/confirmInstall 等）
- Cover/RVC 运行：8（分离/变声/渲染/进度事件）
- 事件与任务：8（tasks、onSeparateLog/Progress、onStemProgress、onVoicebankProgress、onCoverProgress 等）
- 其它：update 下载/安装、project autosave 动态通道、soundfonts 兼容名、presets、storage 嵌套等

### 4.2 外部/环境前置

- 真实 RVC/DiffSinger/转录模型推理的可见/隐藏端到端 smoke（当前只验证 worker 协议）
- 安装包 Authenticode 证书（外部采购）
- 安装/升级下载链（网络 + 签名）
- 双实例真实窗口 smoke（当前只验证 TCP 协议）
- 插件宿主 / VST3 生产化
- PDF/视频导出

## 5. 验收建议（不弹窗）

- 2026-11-04 全量 `npm run tauri:acceptance` 实测 **ok:true**（11 步）；

- 一键：`npm run tauri:acceptance`（完整）或 `npm run tauri:acceptance -- --quick`（低成本）；

```powershell
cd E:\Midi\FuFumidi-Source
node scripts/e2e/run.mjs                    # 隐藏窗口 40/40
npm run test:ui                              # 589/589
npm run typecheck
npm run audit
cd shells/tauri
cargo test --offline                        # 114/114 + 1 ignored
cargo build --release --offline
.\poc\tauri-poc\target\release\fufumidi-shell.exe --self-check
.\poc\tauri-poc\target\release\fufumidi-shell.exe --engine-self-check
```

> release 路径以实际 `CARGO_TARGET_DIR` 为准。

## 6. 已知风险

- P2 默认 `__slots` 缺省 1；GPU 机器并行 2→1、3→2、4→3；CPU 想满 4 需 `FUFUMIDI_DISABLE_GPU=1`。
- 每次 convert 重设 cap，“最后写入者生效”；不同并行度混跑会回收暖 worker。
- 双实例端口固定 47823；若被其它程序占用会退化（当前会尝试转发，失败则继续启动）。
- RVC probe 真实权重未跑；cover 渲染链路未迁移。
- 安装包未签名、未上传。

## 7. 结论

**Tauri 壳、核心编辑/编排/转录 worker、UTAU/RVC 本地管理、文件关联已可用；**
**但 109 个 IPC 方法、真实模型端到端、安装/更新/签名仍未完成，不能宣称整体完成。**
在这些项完成前，目标保持 active，不关闭、不上传。

## 8. 验收决策（2026-11-04）

当前一键无窗口验收 **ok:true（11 步）**；代码规模 158 命令、Bridge 182/265、未映射 84。

| 选项 | 含义 | 前置 |
|---|---|---|
| A. 先验收当前版本 | 不上传，保留 active，等用户逐项体验 | 用户验收 |
| B. 真实模型全链路 | 分离/RVC/cover 实际推理 | 需要本机模型权重与 GPU/CPU 时间 |
| C. DiffSinger | 目录/下载/渲染 | 需要模型资产与训练/推理环境 |
| D. OMR | Audiveris/Homr/语言包安装 | 需要 81MB MSI/网络/msiexec |
| E. 更新/安装链 | 检查/下载/签名/安装 | 需要 Authenticode 证书与安装器发布 |
| F. 真实窗口 smoke | Tauri WebView2 交互/双实例 | 需要允许一次可见窗口验收 |

在你选择前，目标保持 active，代码不推送。

## 9. Release 产物指纹

- 文件：`poc/tauri-poc/target/release/fufumidi-shell.exe`
- 大小：**16,935,936 bytes**
- SHA-256：`cdfd08ad3eb7eaab08aff4b702455f3d2246dfc9820a92d76ae362e0396c3286`
- Authenticode：**NotSigned**（未签名；符合当前外部前置未采购的状态）

## 10. 转录/分轨恢复（2026-11-04 夜间）

- 根因 1：Tauri data_dir 忽略 Electron settings，落到空 AppData；已按 data_root_last/路径反推选择，release 实测 dataDir=E:/Midi/FuFumidi/FuFumidiData、models=13。
- 根因 2：发布版 python 不含 torch，GPU 增强包未进 PYTHONPATH；apply_engine_env 已挂 data_root/gpu-enhancements/*/site-packages，release torch 2.9.1+cu128 可导入，basic-pitch 真实转录 ok（8.9s / 1 note）。
- 根因 3：分离只认模型目录，漏 _configs；补 .th 与 yaml 匹配；CPU half→float32、chunk 收敛到 config；真实 6 轨分离 ok（4.2s）。
- 智能分轨：stem_workflow.rs 真实分轨→逐 stem 转录→合并，release --stem-smoke ok、6 tracks；UI 已接 engine:stem-progress。
- 无窗口验证：--stem-smoke 不创建窗口；仍不上传。

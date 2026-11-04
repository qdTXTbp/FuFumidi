# Tauri 迁移验收快照（2026-11-04）

> 状态：**未完成，未上传**。目标是 Tauri 替换 Electron 并尽量 Rust 化；Python 仅保留模型推理。
> 用户要求验收前不弹窗、不上传；本文件用于验收前对表，不作为完成声明。

## 1. 当前基线

- 分支：`feat/audio-tagger-auto-probe`
- 最新代码提交：`e24fffa`（验收文档另提交）
- Electron 原版基线：6.5.0-beta.1（`47f6062`）
- Tauri 命令：**135**
- 前端 bridge 方法：**157 / 265**
- 未映射：**109**
- 前端 invoke 通道：**250**，Tauri 已接 **151**
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
| 第二实例文件/聚焦 | 已做（协议级） | TCP 127.0.0.1:47823；Builder 前退出；Rust 单测路径/FOCUS |
| UTAU 声库 | 列表/OTO 读写/删除/导入 zip/导出目录/导出 zip | Rust 单测 + bridge |
| RVC 模型 | 列表/删除/文件夹/文件/zip 导入/内置目录/probe | Rust 单测；probe 真实模型未跑 |

## 3. 门禁结果（当前源码）

- 隐藏全量 E2E：**40/40**（`node scripts/e2e/run.mjs`，`show:false`）
- 前端单测：**589/589**（`npm run test:ui`）
- `npm run typecheck`：0
- `npm run audit`：0
- `cargo test --offline`：**109 passed / 0 failed / 1 ignored**
- release build：通过（2m19s，见 `TAURI-BUILD.md` §8）
- release `--self-check` / `--engine-self-check`：通过

## 4. 仍需完成的重型缺口

### 4.1 IPC 主要分组（109）

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

```powershell
cd E:\Midi\FuFumidi-Source
node scripts/e2e/run.mjs                    # 隐藏窗口 40/40
npm run test:ui                              # 589/589
npm run typecheck
npm run audit
cd shells/tauri
cargo test --offline                        # 109/109 + 1 ignored
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

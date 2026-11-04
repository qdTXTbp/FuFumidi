# Tauri 真正外壳（Rust host）—— M1 第一步

> 2026-11-04 用户确认「继续用 Tauri 替换 Electron」，并按「尽量都用 RUST 重写」推进非 ML。
> 本目录是**真正的外壳骨架**（不再是 POC）：Rust host + 现有 Vue renderer + Python 仅推理 sidecar。

## 1. 边界

| 层 | 语言 | 现状 |
|---|---|---|
| 窗口/系统集成/IPC 宿主 | Rust（tauri 2） | 已建骨架：窗口、host_info、python_selfcheck、ping |
| host 业务（文件/设置/曲库/任务/下载/更新） | Rust | **待迁移**（T-117，逐步替换 main/*.js） |
| 非 ML 算法（MIDI/SF2/MusicXML/ustx/UTAU DSP/音频链） | Rust | **待迁移**（R-007/R-008，crates/ 已有 SMF/量化/移调） |
| 模型推理 | Python sidecar | **保留**（ADR-0001/0002）；Rust 只负责启动、健康检查、协议转发（T-118） |
| UI | Vue 3 / WebView2 | 直接加载 `renderer/dist`，沿用 `frontend/src/bridge/tauri.js` |

## 2. 构建与运行

```bash
cd E:/Midi/FuFumidi-Source
npm --prefix frontend run build          # 产出 renderer/dist
cargo build --manifest-path shells/tauri/Cargo.toml --offline
./shells/tauri/target/debug/fufumidi-shell.exe --self-check   # 打印 host/Python/renderer 路径
./shells/tauri/target/debug/fufumidi-shell.exe                 # 开窗加载真实 UI
```

> 首次编译依赖较多；本机可复用 `poc/tauri-poc/target` 作为 CARGO_TARGET_DIR 加速（实测 16.7 s）。
> 正式构建使用本目录自己的 target。

## 3. 已实测（2026-11-04）

- `--self-check`：version 6.5.0-beta.1；python = `resources/python/python.exe`（exists=true）；
  renderer = `renderer/dist`（index.html exists=true）。
- 开窗：**0.66 s**；窗口标题 `FuFumidi`；主进程 RSS 41.4 MB；WebView2 子进程 7 个；
  截图 `shells/tauri/artifacts/window.png`（真实首页 + 新手引导，不是占位页）。
- 与 POC 的区别：POC 只有 `poc_ping/poc_echo`；本壳已带 host_info/python_selfcheck，
  并可作为后续 T-115（IPC 纵切）、T-118（Python sidecar supervisor）的落点。

## 4. 下一步

1. **T-115 IPC 纵切**：从 ipc.schema.json 生成 10 条真实 command + 桥映射（含事件退订），
   替换 `frontend/src/bridge/tauri.js` 中的手写映射。
2. **T-118 Python sidecar supervisor**：Rust 启动/监控 Python，转发 `convert/separate` 等推理请求；
   模型路径/参数契约不变。
3. **T-117 host 业务迁移**：文件/设置/曲库/任务队列先迁，保持 IPC 语义与双跑回归。
4. T-119 双构建 + Electron 回退；T-114 品牌一致性校验（图标复用 build/icon.ico）。

## 5. 风险与约束

- 现有 172 条 IPC 缺口仍在本壳上存在：UI 能渲染 ≠ 所有操作可用；必须逐条迁移并以 E2E 覆盖。
- 更新链仍要自研（官方插件无增量、验签不兼容）。
- Python 保留意味着包体不会降到 ≤250 MiB；本阶段只追求「Electron 被 Tauri 替代 + 非 ML Rust 化」。
- **模型兼容是硬约束**：不得改模型格式/ID/路径/下载源；迁移只换宿主，不换推理。

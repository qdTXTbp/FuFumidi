# FuFumidi 无头回归矩阵 — 最新结果

> 生成时间：2026/11/06 23:13:59（Asia/Shanghai）  
> 生成命令：`node scripts/tauri/regression-matrix.mjs`  
> 安全策略：不启动 GUI / Electron 窗口 / 安装器 / 签名步骤；联网冒烟（model-fetch-smoke）默认跳过，需 --include-network；所有子进程隐藏窗口。

## 环境

| 项 | 值 |
|---|---|
| 仓库 | `E:\Midi\FuFumidi-Source` |
| 分支 / 提交 | `feat/audio-tagger-auto-probe @ c15853f9` |
| 提交说明 | docs(alpha2): record release artifacts and refresh regression baseline |
| 工作区 | 脏（7 个改动） |
| 工具链 | Node v24.16.0 · npm 11.13.0 · cargo 1.97.1 (c980f4866 2026-06-30) · rustc 1.97.1 (8bab26f4f 2026-07-14) |
| 平台 | win32/x64 · 32 核 |

## 总览

- **通过** 11 · **失败** 0 · **警告** 1 · **跳过** 3
- 总耗时：**37.4s**
- 结论：✅ 无失败项（警告/跳过见下）

## 步骤明细

| # | 步骤 | 状态 | 退出码 | 耗时 | 命令 |
|---:|---|---|---:|---:|---|
| 1 | 前端 TypeScript 类型检查 | ✅ PASS | 0 | 1.1s | `npm run typecheck` |
| 2 | 仓库审计（版本/i18n/许可证/参数/死选项/UI token/契约/品牌/handler） | ✅ PASS | 0 | 5.9s | `npm run audit` |
| 3 | 前端单元测试（node --test） | ✅ PASS | 0 | 3.0s | `npm run test:ui` |
| 4 | Tauri command 注册审计 | ✅ PASS | 0 | 89ms | `node scripts\tauri\handler-audit.mjs` |
| 5 | IPC 覆盖静态统计 | ✅ PASS | 0 | 97ms | `node scripts\tauri\ipc-coverage.mjs` |
| 6 | 前端 bridge.* 调用静态审计 | ✅ PASS | 0 | 139ms | `node scripts\tauri\bridge-call-audit.mjs` |
| 7 | 模型规格契约静态检查（允许 WARN） | ⚠️ WARN | 3 | 106ms | `node scripts\tauri\model-contract-check.mjs --json` |
| 8 | Cargo 测试（shells/tauri） | ✅ PASS | 0 | 8.9s | `cargo test --offline` |
| 9 | Cargo Clippy -D warnings（shells/tauri） | ✅ PASS | 0 | 1.5s | `cargo clippy --offline -- -D warnings` |
| 10 | Cargo 测试（Rust core） | ✅ PASS | 0 | 546ms | `cargo test --offline` |
| 11 | 前端生产构建（vite build） | ✅ PASS | 0 | 8.9s | `npm --prefix frontend run build` |
| 12 | 模型下载冒烟（联网，hft_transformer ≈20MB） | ✅ PASS | 0 | 5.7s | `node scripts/tauri/model-fetch-smoke.mjs` |
| 13 | Electron hidden E2E（会启动应用窗口） | ⏭️ SKIP | — | — | `node scripts/e2e/run.mjs` |
| 14 | 安装器打包（electron-builder NSIS） | ⏭️ SKIP | — | — | `npm run dist:win` |
| 15 | 更新签名（tauri:sign） | ⏭️ SKIP | — | — | `npm run tauri:sign` |

## 失败详情

（无）
## 警告（不阻塞）

### `model-contract`（106ms）

- Tauri 侧 2 个条目不在 MODEL_REGISTRY（内置/动态条目属预期）：basic_pitch, htdemucs4_6stems

## 默认跳过（安全策略）

| 步骤 | 命令 | 原因 |
|---|---|---|
| Electron hidden E2E（会启动应用窗口） | `node scripts/e2e/run.mjs` | 默认不执行（需要 --include-gui）：默认跳过：会启动 Electron / GUI 实例（回归矩阵不碰窗口） |
| 安装器打包（electron-builder NSIS） | `npm run dist:win` | 默认不执行（需要 --include-gui）：默认跳过：安装器构建会拉取/签名并可能弹窗 |
| 更新签名（tauri:sign） | `npm run tauri:sign` | 默认不执行（需要 --include-gui）：默认跳过：签名步骤不在无头回归范围 |

## 复现

```powershell
node scripts/tauri/regression-matrix.mjs
node scripts/tauri/regression-matrix.mjs --only typecheck,test-ui --no-write
node scripts/tauri/regression-matrix.mjs --save-logs --verbose
```

## 说明

- 每步的 tail 是输出末尾 40 行；完整日志需加 --save-logs（写入 docs/port/regression-logs/）。
- model-contract 允许 WARN（退出码 3 视为警告，不阻塞）；其结构化结果在 regression-latest.json 的 steps[].details。
- 本矩阵不含 GUI / 安装器 / 签名；Electron E2E 需人工单独执行 npm run test:e2e。
- model-fetch-smoke 是可选联网步骤：需要 --include-network；只下载 <50MB 的 hft_transformer，校验 JSON ok:true 与 unpackMarker，跑完删临时目录。

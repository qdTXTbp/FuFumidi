# docs/port —— Tauri 迁移 / 无头回归报告

本目录存放 S8 无头回归矩阵的产物。

## 文件

| 文件 | 说明 |
|---|---|
| `regression-latest.json` | 最近一次完整矩阵的结构化结果（schema: `fufumidi.regression-matrix/1`） |
| `regression-latest.md` | 同一结果的人工摘要（通过 / 失败 / 警告 / 跳过 + 失败输出 tail） |
| `regression-logs/*.log` | `--save-logs` 生成的完整单步日志（纯生成物，可随时删除后重跑） |

## 运行

```powershell
node scripts/tauri/regression-matrix.mjs
node scripts/tauri/regression-matrix.mjs --only=typecheck,test-ui
node scripts/tauri/regression-matrix.mjs --save-logs --verbose
node scripts/tauri/regression-matrix.mjs --include-network   # 额外跑联网模型下载冒烟（≈20MB）
```

退出码：0 = 无失败；1 = 有失败；2 = 参数错误。警告（如模型契约 WARN）不阻塞。

## 安全策略

默认不执行会启动 GUI 的 `scripts/e2e/run.mjs`、安装器 `npm run dist:win`、签名 `npm run tauri:sign`；
只有显式 `--include-gui` 才会运行。联网的 `model-fetch-smoke` 默认也跳过，只有 `--include-network` 才执行。
所有子进程 `windowsHide: true`，不弹控制台窗口。

## 步骤

1. `npm run typecheck`
2. `npm run audit`（内部 `&&` 串联，首个失败会短路后续子检查）
3. `npm run test:ui`
4. `node scripts/tauri/handler-audit.mjs`
5. `node scripts/tauri/ipc-coverage.mjs`
6. `node scripts/tauri/bridge-call-audit.mjs`
7. `node scripts/tauri/model-contract-check.mjs`（允许 WARN）
8. `cargo test --offline`（`shells/tauri`）
9. `cargo clippy --offline -- -D warnings`（`shells/tauri`）
10. `cargo test --offline`（Rust core；`crates/rust-core` 不存在时回退到 `crates/` workspace，再回退 `rust-core/`）
11. `npm --prefix frontend run build`
12. （可选，需 `--include-network`）`node scripts/tauri/model-fetch-smoke.mjs`：用 `fufumidi-shell.exe --model-fetch hft_transformer` 做端到端下载冒烟，临时 data root，校验 JSON `ok:true` 与 unpackMarker，跑完删临时目录

## 模型规格契约

`node scripts/tauri/model-contract-check.mjs` 静态对比 `main/models.js` 的 `MODEL_REGISTRY`
与 `shells/tauri/src/**` 的模型清单/下载定义（兼容旧的 `push_model` 与新的 `SPECS: &[ModelSpec]`），
输出结构化差异；退出码 3 表示仅有 WARN（迁移进行中属预期，不阻塞）。

## 联网冒烟（可选）

`node scripts/tauri/model-fetch-smoke.mjs` 只允许 <50MB 的小模型（当前仅 `hft_transformer`，约 20.5MB），
要求 `shells/tauri/target/{debug,release}` 下的 `fufumidi-shell.exe` 比 `shells/tauri/src/**` 新
（防止旧 exe 不认 `--model-fetch` 转而启动 GUI）；退出码 0=通过、4=跳过（找不到/过期 exe 或模型不在允许清单）、1=失败。

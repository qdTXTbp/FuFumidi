# S6 验证：音色 / 声库 / GPU / OMR 真实无头冒烟

> 生成时间：2026-11-07 00:05（Asia/Shanghai）
> 版本：`fufumidi-shell 6.5.0-alpha.3`
> 编排命令：`node scripts/tauri/s6-smoke.mjs`（逐个用例可控，见文末复现）
> 安全策略：**不启动 GUI / 安装器，不执行 msiexec 交互**；下载只落系统临时目录，校验后删除；所有子进程隐藏窗口。

## 环境

| 项 | 值 |
|---|---|
| 仓库 | `E:\Midi\FuFumidi-Source` |
| 分支 / 提交 | `feat/audio-tagger-auto-probe @ 50ad6344` |
| 提交说明 | `fix(models): make single-file resume safe; record alpha.2 artifacts` |
| 工具链 | Node v24.16.0 · cargo 1.97.1 · rustc 1.97.1 (2026-07-14) |
| 平台 | win32/x64 · AMD Ryzen 9 9955HX（16C）· 64GB |
| 网络 | 家用宽带，波动大：同类下载 0.2–1.1 MB/s 不等（见「耗时波动」） |

## 总览

- **8/8 用例通过**（7 个 Rust 真实网络测试 + 1 个插件平台下载/包内校验）。
- 全量冒烟墙钟：**20m56s**（2026-11-06 23:43:59 → 00:04:55；网络慢时段，逐用例顺序执行）。
- 另有一轮 23:28–23:41 的首跑（当时发现 3 个问题：1 个测试自身路径 bug、1 个 main.rs 编译中断、1 个插件平台下载通道不稳），均已处理，见「修复」。
- 门禁：`cargo clippy --offline -- -D warnings` = **0**；`cargo test --offline` = **164 passed / 0 failed / 12 ignored**。

## 用例明细（真实网络）

| # | 用例 | 命令（cargo test 过滤名） | 耗时 | 实测字节 | 校验方式 | 结论 |
|---:|---|---|---:|---:|---|---|
| 1 | 音色 SF2 | `--ignored s6_sf_real` | 79.2s | 531,786 B | 注册表 florestan 地址下载；RIFF 头；`minSize 330,000` 下界；`.part` 改名成功 | ✅ PASS |
| 2 | UTAU 声库 | `--ignored s6_utau_real` | 192.6s | 26,440,058 B | chenzhe 归档多源下载 → 按 subdir 解包 → **833 个文件**；`oto.ini` ✓；`character.txt` ✓ | ✅ PASS |
| 3 | GPU 分卷/发现 | `--ignored s6_gpu_sources_real` | 7.3s | 1,048,576 B（Range） | `gpu_list_packages` 发现 tag=`gpu-v2` 的 3 个包（cuda 分卷 ×2、rocm 分卷 ×2、xpu 单文件）；cuda 首卷声明 **1,992,294,400 B**，GitHub 与 CNB 镜像实测长度均完全一致；Range 拉前 1 MiB，`PK\x03\x04` ZIP 头；`gpu_package_url(cuda)` 返回 `split:true` + files | ✅ PASS |
| 4 | OMR 语言包 | `--ignored s6_omr_lang_real` | 21.3s | 23,466,654 B | 完整版 tessdata eng（`LANG_MIN_BYTES=5MiB`，fast 版会被拒）；落在临时目录 | ✅ PASS |
| 5 | OMR 超分 | `--ignored s6_omr_sr_real` | 310.2s | 35,497,352 B | waifu2x zip 下载 → `install_sr_from_zip` → exe **5,094,912 B**、3/3 模型均 >1MB、`sr_status_at.installed=true` | ✅ PASS |
| 6 | OMR 引擎 | `--ignored s6_omr_engine_real` | 166.2s | 85,062,430 B | Audiveris MSI 精确大小 + **SHA-256 = `5f1b4e96a12c53c7da426814b76e599363c4181e291855996e0a6878dda95f71`**（与钉死常量一致）；**未执行 msiexec** | ✅ PASS |
| 7 | homr 权重 | `--ignored s6_homr_weight_real` | 226.1s | 38,770,614 B | 三个权重先 HEAD（53,214,519 / 48,277,621 / 38,770,614），取最小（decoder）真实下载 → 解包出 `.onnx` >1MB | ✅ PASS |
| 8 | 插件平台 | `node scripts/tauri/s6-smoke.mjs`（platform 步骤） | 253.2s | 36,255 B | `GET /api/store/manifest/stable`（channel=stable、1 个插件）→ `GET /api/store/plugins/auto-key-cmajor/download?source=app&version=1.0.0`；PK 头、5 个条目 = catalog `fileCount 5`、`plugin.json` 可解析（id/version/entry/index.js/4 commands）、无 `../`/绝对路径条目；**未安装、未启用** | ✅ PASS |

各用例的机器可读标记（测试内打印 `###S6 {json}`，脚本汇总）：

```json
{ "sf": {"bytes":531786,"riff":true,"min":330000,"urls":1},
  "utau": {"bytes":26440058,"files":833,"characterTxt":true,"name":"陈者（中文单独音）"},
  "gpu": {"tag":"gpu-v2","packages":3,"kinds":["cuda","rocm","xpu"],"parts":2,
           "declared":1992294400,"github":1992294400,"cnb":1992294400,"rangeBytes":1048576,"zipMagic":true},
  "omr-lang": {"bytes":23466654,"min":5242880,"code":"eng"},
  "omr-sr": {"bytes":35497352,"exeBytes":5094912,"installedModels":3,"totalModels":3},
  "omr-engine": {"bytes":85062430,"expected":85062430,"sha256":"5f1b4e96…95f71"},
  "homr-weight": {"weightBytes":38770614,"file":"decoder_pytorch_model_396-…onnx"},
  "plugin": {"bytes":36255,"catalogSize":36255,"entries":5,"fileCount":5,"unsafeEntries":0} }
```

## 离线（无网络）验证：真实安装路径的可复现用例

`cargo test --offline` 里新增 3 个**不依赖外网**的用例（另有 16 个既有单测），覆盖真实产品代码路径（不是 mock）：

| 用例 | 覆盖的产品路径 | 断言 |
|---|---|---|
| `s6_local_resume_keeps_bytes_and_renames_part` | `dl_download`（curl `-C -` 断点续传 + 校验 + 原子改名） | 预置半截 `.part`，`file://` 源续传；**输出与源逐字节一致**，`.part` 改名后消失 |
| `s6_gpu_import_synthetic_zip_installs_and_rejects_traversal` | `gpu_import_local_inner` → 安全解压 → `gpu_install_site_at` → manifest | 合成 zip 装出 `site-packages/torch/__init__.py` + `manifest.json` + `gpu_installed_kinds_at` 命中；**含 `../evil.txt` 的 zip 被拒**且目标外无落文件 |
| `s6_sr_install_from_synthetic_zip` | `install_sr_from_zip` + `sr_status_at`（与 `omr_sr_install` 共用） | exe >1MB、3/3 模型、`installed=true`、临时目录被清理 |
| 其余 16 个单测 | zip 穿越谓词、文件名消毒、GPU kind 推断、分卷排序/命名、语言码过滤、`json_bytes`（Tauri IPC 把 Uint8Array 变成 `{"0":..}`）、候选源排序、百分比、`###RESULT` 解析、`find_subdir`、PNG 分页 ZIP、注册表 URL 完整性、转码参数、更新候选 | 见 `resource_extras.rs` 的 `mod tests` |

## 修复的 bug

1. **`gpu_package_url` 对「只有分卷包」的 Release 永远报未找到。** 当前 `gpu-v2` 的 cuda/rocm 只有 `fufumidi-gpu-cuda.zip.001…` / `…partN`，旧实现只认 `fufumidi-gpu-<kind>.zip` 单文件。现在：单文件优先；缺则返回 `{ok:true, split:true, url, size, files:[…]}`（xpu 仍走单文件）。首次冒烟即暴露，已由 `s6_gpu_sources_real` 覆盖。
2. **下载总长度只探前 2 个候选源，GitHub 归档类会拿不到总长。** codeload.github.com 的归档响应没有 `Content-Length`（分块），旧逻辑只用前两个 URL HEAD，拿不到就把进度百分比恒置 0。现在遍历前 8 个候选（镜像通常带 `Content-Length`：实测 ghfast 对 chenzhe 归档给出 26,440,058 B），任一可用即作为进度总长。
3. **可测性重构（不改变产品行为）**：GPU 安装/manifest 支持注入 root（`gpu_install_site_at` / `write_gpu_manifest_at` / `gpu_import_local_inner(root, temp_base)`）；SR 解包提取为 `install_sr_from_zip` + `sr_status_at`；MSI 候选地址提取为 `omr_msi_urls`。让上面的离线用例能覆盖**真实安装路径**，而不是另写一份模拟逻辑。
4. **验证脚本通道修复**：插件平台下载走 `curl` 在本机实测不稳（一次 `curl: (35) SSL connect error`、一次 180s 只收到 20,513/36,255 B 超时），而 PowerShell `Invoke-WebRequest`（WinINET/系统代理）实测 11.1s 成功。`s6-smoke.mjs` 改为 **PowerShell 优先 + curl 回退**；本轮由 curl 回退成功。
5. **测试自身 bug（非产品）**：`s6_omr_sr_real` 首跑把 root 多套了一层 `waifu2x`（`sr_status_at` 自己会拼 `waifu2x`），导致误判失败；已修正 root 传递，复跑通过（exe 5,094,912 B、模型 3/3）。

## 限制与未覆盖（如实）

- **msiexec 解包未执行**：任务禁止安装器/msiexec 交互，因此 Audiveris 只验证到「下载物大小 + SHA-256 与钉死值一致」；解包逻辑（`msiexec /a … /qn TARGETDIR=`）保持代码审查 + 单元级校验，未实机跑。
- **homr 未建 venv / 未 pip install**：只验证权重下载与解包（三个权重体积 HEAD + 最小者真实下载）；venv 创建/依赖安装属于「安装依赖」，未在无头验证中执行。
- **GPU 未下 1.86 GB 全量包**：改为 ① 真实发现 + 双源（GitHub/CNB）长度与 API 声明逐一核对；② Range 拉 1 MiB 验证分卷是 ZIP；③ 本地合成 zip 走完整 `gpu_import_local`/安装路径（含恶意 zip 拒绝）。全量下载/合并/site-packages 安装未在本次实跑。
- **插件两段式 install 未执行**：`plugins_install_from_platform` / `plugins_confirm_install` 在 `main.rs`（本任务冻结），本次只验证平台 catalog + 下载 + 包内校验（等价于 `plugin-install.js` 的 download/inspect），不写用户插件目录、不启用。
- **耗时波动**：同一用例两次跑差异很大（sf 24.9s→79.2s、utau 25.3s→192.6s、SR 176.8s→310.2s、插件 201s→253s），是网络而非代码；报告取第二轮（全部通过）的数字。
- `plugin` 用例时长包含 PowerShell 失败后的 curl 回退（约 240s）；若平台网络正常应在数秒内完成。

## 建议（不在本任务范围）

- `main.rs:1330` 的 `plugins_install_from_platform` 只用 `curl.exe`；本机实测平台下载通道不稳，建议加 PowerShell/WinINET 回退或重试（S6 验证脚本已用该组合跑通）。
- `gpu_list_packages` / `gpu_package_url` 仍是同步命令（main.rs 未标 async），首次打开设置页会做最多 2 次 HTTP（已加 120s 进程内缓存）；建议后续也标 `#[tauri::command(async)]`。
- GPU 分卷目前串行下载（Electron 为 3 路并发），可在后续提速。

## 复现

```powershell
# 全部用例（约 10–21 分钟，取决于网络）
node scripts/tauri/s6-smoke.mjs

# 只跑某几项
node scripts/tauri/s6-smoke.mjs --only=sf,gpu
node scripts/tauri/s6-smoke.mjs --only=omr-sr,homr-weight --no-plugin

# 只跑测试（--ignored 即真实网络用例；默认 cargo test 不跑它们）
cd shells/tauri
cargo test --offline -- --ignored --test-threads=1 --nocapture s6_sf_real

# 门禁
cargo clippy --offline -- -D warnings
cargo test --offline
```

脚本退出码 = 0 当且仅当所有选中用例通过；每个用例的输出、耗时、字节数、`###S6` 标记都会汇总打印，可直接贴进发布说明。

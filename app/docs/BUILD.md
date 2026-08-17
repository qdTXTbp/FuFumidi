# FuFumidi 三平台构建指南

本文档说明如何为 **Windows / macOS / Linux** 构建一键安装包，并在打包时内置
自包含 Python 运行时（`python-build-standalone` + 全部引擎依赖），让安装后的应用
**开箱即用、完全离线**，不依赖用户机器上的任何 Python / pip / 网络。

---

## 1. 构建产物

| 平台 | 命令 | 产物（`app/dist/`） |
| --- | --- | --- |
| Windows | `npm run dist:win` | `FuFumidi-Setup-<version>.exe`（NSIS） |
| macOS | `npm run dist:mac` | `FuFumidi-<version>.dmg` + `.zip`（x64 / arm64 各一份） |
| Linux | `npm run dist:linux` | `FuFumidi-<version>.AppImage` + `.deb` |

> 原有的 `npm run dist`（仅 Windows NSIS）保持不变，`dist:win` 与其等价但加了
> `--publish never`（不推送自动更新元数据）。

---

## 2. 前置条件

- **Node.js 20+**、npm。
- `app/` 内已执行 `npm install`（开发依赖：electron + electron-builder）。
- 各平台构建需在对应系统上执行（或交给 CI）：
  - Windows 安装包 → 在 Windows 上构建；
  - macOS（`.dmg` / `.zip`，x64 + arm64）→ 在 macOS 上构建；
  - Linux（AppImage / deb）→ 在 Linux 上构建。
- Linux 打包 AppImage 可能需要系统工具（如 `libfuse2`、`desktop-file-utils`）；GitHub
  Actions 的 `ubuntu-latest` 已自带所需环境，本地 Ubuntu/Debian 若缺可
  `sudo apt-get install libfuse2`。

---

## 3. 内置 Python 运行时（关键步骤）

安装包要“开箱即用”，必须先由 `scripts/bundle-python.js` 生成内置运行时：

```bash
# 在 app/ 目录下
npm run bundle:python            # 等价于 node scripts/bundle-python.js，默认 CPU 版 torch
```

- 下载 python-build-standalone 自包含 CPython（免安装、含 pip）→ 解压到 `app/python/`；
- 用内置 pip 安装 `engine/requirements-bundle.txt`（转录引擎全部依赖）；
- 完成后跑 `probe` 自检，并清理测试套件 / `__pycache__` 瘦身；
- 打包时 `build.extraResources` 会把 `app/python/` 复制到安装后的
  `resources/python/`（`main.js` 的 `resolvePython()` 首个候选路径），无需写进 asar。

可选参数：

```bash
node scripts/bundle-python.js --torch cuda       # NVIDIA → CUDA 版 torch（体积更大）
node scripts/bundle-python.js --torch directml   # AMD/Intel → torch-directml
node scripts/bundle-python.js --py 3.11          # 指定 Python 大版本（默认 3.11）
```

若 `app/python/` 已存在，脚本检测到解释器后会直接退出（便于 CI 复用缓存）。

> **打包前必须先生成 `app/python/`**：`build.extraResources` 里配了
> `{ "from": "python", "to": "python" }`，目录不存在时 electron-builder 会报错。

---

## 4. 本地构建命令

```bash
# 1) 先装好内置运行时（只会做一次）
npm run bundle:python

# 2) 再打对应平台包
npm run dist:win      # Windows：app/dist/FuFumidi-Setup-*.exe
npm run dist:mac      # macOS（x64+arm64）：app/dist/*.dmg、*.zip
npm run dist:linux    # Linux：app/dist/*.AppImage、*.deb
```

> 各命令均带 `--publish never`，不会向任何发布通道上传。

---

## 5. CI 云端构建（GitHub Actions）

工作流文件：仓库根目录 `.github/workflows/build.yml`（`F:\NEW\工具测试\Fu\.github\workflows\build.yml`）。

三平台矩阵并行构建：

| 运行器 | 执行脚本 | 上传产物 |
| --- | --- | --- |
| `windows-latest` | `dist:win` | `app/dist/*.exe` |
| `macos-latest` | `dist:mac` | `app/dist/*.dmg`、`*.zip` |
| `ubuntu-latest` | `dist:linux` | `app/dist/*.AppImage`、`*.deb` |

产物以 `installer-<os>` 为名上传为 GitHub Actions Artifact（可在 workflow 运行页下载）。

### 触发方式

- **手动**：Actions 页 → `build-installers` → **Run workflow**（`workflow_dispatch`）。
- **打 tag**：推送任意 `v*` 标签触发，例如：

  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```

### CI 内部流程（顺序很重要）

1. `actions/checkout@v4` + `actions/setup-node@v4`（node 20，npm 缓存）；
2. `npm ci || npm install`；
3. **先恢复内置运行时缓存**（`actions/cache@v4`，`path: app/python`，
   key `fufumidi-python-<os>-20250409`）——命中时 `app/python` 直接就位；
4. 再跑 `node scripts/bundle-python.js`——脚本检测到 `python` 已存在会立即退出，
   跳过下载；未命中缓存时才下载安装（作业成功后自动回写缓存，下次命中）；
5. `npm run <matrix.script>` 构建安装包；
6. 上传产物。

> 缓存 key 里的 `20250409` 与 `bundle-python.js` 的 `FF_PBS_REL` 保持一致；
> 更换 python-build-standalone 发布版本时需同步改这两处（以及 cache key），否则缓存会失效/复用错版本。

---

## 6. 离线与体积预期

- **完全离线**：安装包内置 CPython + torch + 全部引擎依赖，用户装完即可转录，无需
  联网、无需装 Python。应用其余功能（播放/编辑/可视化/乐谱）本就本地完成。
- **体积预期**（随依赖版本浮动）：
  - 未内置运行时：Windows 安装包约 **90 MB**；
  - 内置 CPU 版运行时后：`app/python/` 解压后约 **0.8–1.2 GB**；安装包体积受
    NSIS / AppImage / dmg 压缩策略影响，预计 **Windows 约 0.4–0.7 GB、macOS dmg
    约 0.8–1.2 GB、Linux 约 0.5–0.9 GB**。
  - `--torch cuda / directml` 会显著增大体积，仅按需使用。
- `app/python/` 已在 `.gitignore` 中排除，**不入库**；CI 依赖缓存恢复，本地构建需先
  `npm run bundle:python`。

---

## 7. 注意事项

- **仓库布局**：当前目录树是 `F:\NEW\工具测试\Fu\`（含 `.gitignore`、`AGENTS.md`）
  下挂 `app\`。本工作流假设仓库根即 `F:\NEW\工具测试\Fu`，因此所有步骤在
  `app/` 子目录执行，缓存/上传路径带 `app/` 前缀。若你把 `app/` 单独作为仓库根推送，
  需同步调整 `defaults.run.working-directory` 与相关路径。
- **未初始化 git**：目前目录还没有 `.git`。要跑 CI，先在 `F:\NEW\工具测试\Fu` 下
  `git init` → 提交（含 `app/` 与 `.github/`）→ 推送到 GitHub。
- **图标要求**：mac 需 `build/icon.icns`（≥512，已由 FuFu.png 生成）；Linux AppImage
  需 `build/icon.png` ≥512（已覆盖为 512×512）。
- **`.npmrc` 镜像**：`app/.npmrc` 指向 npmmirror，CI 同样使用；若海外构建下载慢，
  可临时去掉镜像配置或改用官方源。
- **mac 签名**：CI 无签名证书时 `hardenedRuntime: true` 会产生未签名构建（electron-builder
  会警告并跳过签名）。分发需用户在“系统设置→隐私与安全性”中允许打开，或后续配置
  Developer ID 证书 + notarization。

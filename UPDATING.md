# FuFumidi 更新流程

本文档固定 FuFumidi 的**增量更新（客户端侧）**与**版本发布（制作侧）**完整流程。

---

## 1. 整体架构

```
GitHub Releases (qdTXTbp/FuFumidi)
   │  资产：FuFumidi.Install.exe  ← 固定名，releases/latest/download 恒指向最新版
   ▼
ghfast.top 镜像（国内加速）
   ▼
FuFumidi.update.exe（kachina 增量更新器，与主程序 exe 同级）
   │  差分下载：只拉改动部分（Range 请求）
   ▼
主程序 FuFumidi.exe 替换完成 → 守护进程自动重启
```

- 更新器：kachina-installer（BetterGI 同款增量更新器），窗口内显示下载进度。
- 下载源：`https://ghfast.top/https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe`
  - 使用 `releases/latest/download` 固定地址，**自动指向最新版本，无需写死版本号**。
  - 走 ghfast.top 镜像加速，规避 GitHub 直连的 TLS/HTTP2 干扰。

---

## 2. 客户端更新流程（用户视角）

1. 设置 → 更新 → 点击「检查更新」。
2. 主程序请求 GitHub latest 版本（多镜像回退），与当前版本比对。
3. 发现新版本 → 弹窗确认。
4. 确认后主程序：
   a. 启动**独立守护进程**（`powershell` 隐藏窗口，等待更新器退出后自动重启主程序）；
   b. 拉起 `FuFumidi.update.exe -I -O --source ghfast`。
5. 更新器窗口弹出，显示下载进度（差分下载，仅改动部分）。
6. 更新器结束主程序进程 → 替换文件 → 完成。
7. 守护进程检测到更新器退出 → 自动启动新版本主程序。

> 更新完成后**自动打开程序**，无需手动点击。

## 3. 客户端实现要点

### 3.1 主进程（`main/update.js`）

- `update:check`：检查更新，返回 `current`（`app.getVersion()`）与 `latest`。
- `app:getVersion`：前端动态读取版本号（避免硬编码不一致）。
- `update:launchUpdater`：
  1. 写 `fufumidi-restart.ps1` 守护脚本到临时目录并 `spawn`（detached）；
  2. `spawn` 更新器：`-I -O --source ghfast`（非交互、强制在线、指定 ghfast 源）。

### 3.2 守护脚本（`fufumidi-restart.ps1`，运行时生成）

```
轮询等待 FuFumidi.update 进程退出（超时 420s）
→ 等待 3s（文件替换完成）
→ Start-Process 启动主程序 FuFumidi.exe
```

### 3.3 更新器配置（`Build/kachina.config.json`）

- 仅保留一个源：`ghfast`，URI 为 `releases/latest/download` 固定地址。
- **不要**在 URI 中使用 `${version}` 占位符——kachina 对自定义 HTTP 源不会替换该占位符，会请求到带字面 `${version}` 的无效 URL，导致 `Invalid remote index`。

### 3.4 打包（`electron-builder.yml`）

- `extraFiles`：`release/update/FuFumidi.update.exe` → exe 同级，保证 `launchUpdater` 能找到更新器。

---

## 4. 发布新版本流程（制作侧）

### 前置条件

- 代码已合入 `master`，`package.json` 版本号已更新为 `X.Y.Z`。
- 所有版本号一致：`package.json` / 前端 / CI tag。

### 步骤

```powershell
# 1. 构建前端 + 主程序（win-unpacked，含新更新器）
npm --prefix frontend run build
npx electron-builder --win dir --x64

# 2. 生成更新器 + 离线包（旧版目录可选，用于生成差分补丁）
powershell -ExecutionPolicy Bypass -File scripts/build-kachina.ps1 -Version X.Y.Z
#   输出：
#     release/update/FuFumidi.update.exe          更新器（内嵌最新 config）
#     release/update/FuFumidi.Install.X.Y.Z.exe   离线包（上传用）

# 3. 上传离线包到 GitHub Releases（固定名 FuFumidi.Install.exe，覆盖旧版）
python scripts/upload-release-asset.py <GH_TOKEN> qdTXTbp/FuFumidi vX.Y.Z `
    release/update/FuFumidi.Install.X.Y.Z.exe FuFumidi.Install.exe
```

### 发布时上传的资产

| 资产 | 说明 |
|---|---|
| `FuFumidi-Setup-X.Y.Z.exe` | 完整安装包（electron-builder NSIS） |
| `FuFumidi.Install.exe` | **固定名**离线包（`latest/download` 引用，每次发布覆盖） |
| `FuFumidi.Install.X.Y.Z.exe` | 带版本号离线包（留档，可选） |
| `FuFumidi-X.Y.Z-win-x64.zip` | 免安装便携版（可选） |

> `FuFumidi.Install.exe` 必须每次发布覆盖上传，否则 `releases/latest/download` 仍指向旧版。

---

## 5. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `Error: Invalid remote index` | URI 含 `${version}` 占位符未被替换（404） | 改用 `releases/latest/download` 固定地址 |
| 更新器提示「更新器不存在」 | 正式包未随包分发更新器 | 确认 `electron-builder.yml` 的 `extraFiles` 生效，更新器与 exe 同级 |
| 更新完成后程序未自动打开 | 使用旧版（无守护逻辑） | 升级到含守护逻辑的版本（≥3.1.2） |
| 下载卡在 0% | 主程序侧旧逻辑预下载离线包 | 已废弃：改为更新器内下载并显示进度 |
| TLS/证书校验失败（构建/上传） | 本地网络工具干扰 | 构建用 `NODE_TLS_REJECT_UNAUTHORIZED=0`；上传脚本已 `verify=False` |

---

## 6. 相关脚本一览

| 脚本 | 用途 |
|---|---|
| `scripts/build-kachina.ps1` | 生成更新器 + 离线包（差分） |
| `scripts/upload-release-asset.py` | 上传/覆盖 Release 资产（固定名） |
| `Build/kachina.config.json` | 更新器内嵌源配置（ghfast 固定源） |
| `main/update.js` | 主进程更新服务（检查/启动更新器/守护重启） |

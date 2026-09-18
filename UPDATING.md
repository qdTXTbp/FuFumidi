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
  1. 探测可用下载源（HEAD 多镜像，最多约 24s）；**必须在起守护进程之前**——否则守护进程会在更新器还没出现时误判成已结束；
  2. `spawn` 更新器：`-I -O --source <id>`（非交互、强制在线、指定源）；
  3. 用 WMI 拉起守护脚本（原因见 3.2），确认它已写日志后主进程自行退出，释放 exe 映射。

### 3.2 守护脚本（`fufumidi-restart.ps1`，运行时生成）

```
[主进程] 探测可用下载源（HEAD，最多约 24s）
      → 拉起 FuFumidi.update.exe
      → 用 WMI（Win32_Process.Create）拉起守护脚本   ← 不能用 spawn detached，见下
      → 确认守护脚本已写日志 → 主进程自行退出（释放 exe 映射）

[守护]  等更新器出现（最多 90s）
      → 等更新器退出（最多 600s；此时文件替换才结束）
      → 等 app.asar 头部完整（最多 60s）
      → Start-Process 启动新版主程序
```

**为什么必须用 WMI 拉起守护进程**：实测 `detached: true` 的 `powershell.exe -File`
会在 1 秒内退出、退出码 0、脚本一行都不执行（宿主机与虚拟机均可复现）；
而不 detached 的子进程又会随主进程一起结束，活不到「更新器退出」那一刻。
`Win32_Process.Create` 建出来的进程挂在 `WmiPrvSE` 下，既不在调用方进程树里、
也不带 `DETACHED_PROCESS`，才真能活过主进程。

**排查入口**：整条流程都写 `<数据目录>\temp\fufumidi-restart.log`，
主进程的行带 `[main]` 前缀、守护进程的行不带。缺 `[guard] start` 就说明守护没跑起来。

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
- **已在干净 Windows 11 虚拟机中完成全功能测试**（见 `docs/TESTING.md`），
  并产出测试报告 `docs/test-reports/YYYY-MM-DD-vX.Y.Z-vm.md`。

  > 宿主机上的自动化回归（`cdp-*.cjs`）**不能**替代这一步：宿主机是脏环境，
  > 会掩盖内置依赖缺失、首次启动路径、数据迁移、卸载残留等问题。

### 步骤

```powershell
# 1. 构建前端 + 主程序（win-unpacked，含新更新器）
npm --prefix frontend run build
npx electron-builder --win dir --x64

# 2. 生成更新器 + 离线包（旧版目录可选，用于生成差分补丁）
powershell -ExecutionPolicy Bypass -File scripts/build-kachina.ps1 -Version X.Y.Z
#   输出：
#     release/update/FuFumidi.update.exe          更新器（内嵌最新 config；electron-builder 的
#                                                 extraFiles 从这里取，脚本会同步覆盖，别手工删）
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

## 5. 测试版与正式版双通道

两条通道靠 **GitHub 的 prerelease 语义**天然隔离，互不影响：

| 通道 | 版本查询 | 下载锚点 | 谁能拿到 |
|---|---|---|---|
| 正式 stable | `releases/latest`（**自动跳过 prerelease**） | `releases/latest/download/FuFumidi.Install.exe` | 所有人（默认） |
| 测试 beta | `releases` 列表里第一个 prerelease | `releases/download/beta/FuFumidi.Install.exe` | 在「设置 → 更新 → 测试版通道」开启的人 |

通道选择存在 `settings.update_channel`（同时写 localStorage `fufumidi_update_channel`，
保证启动瞬间就能读到），由前端作为参数传给 `update:check` / `update:launchUpdater`。

### 5.1 测试通道为什么必须用固定 tag `beta`

kachina 更新器的下载地址是**编译进 exe 的固定字符串**（`build/kachina.config.json`），
运行时只能通过 `--source <id>` 选源，没法把「带版本号的动态 URL」传进去。所以测试通道
必须有一个**内容会变、地址不变**的锚点：固定 tag `beta` 的 release，每次内测覆盖上传同名资产。

`releases/latest` 会跳过 prerelease，所以这个锚点永远不会影响正式用户。

> 固定 tag `beta` 的 release 只是分发锚点，不对应版本。`main/update.js` 取最新测试版时
> 按 `/^v?\d+\.\d+\.\d+-(beta|rc)\.\d+$/` 过滤，把它排除掉。

**通道生效的前提**：beta 源是新增到 `kachina.config.json` 的，而该配置**编译在更新器 exe 里**。
所以已经装在用户机器上的旧版本（更新器里没有 beta 源）只能走正式通道 —— 它们要能收到测试版，
必须先从正式版升级到「带双通道的版本」。这意味着**第一个测试版通常只能手动分发安装包**
（让测试者装上带双通道的包并在设置里开启），之后的 beta.2 / beta.3 才能自动增量更新。

### 5.2 版本号与列车规则

| 类型 | 版本号 / tag | Release 标记 | 说明 |
|---|---|---|---|
| 内测 | `4.4.0-beta.1` | prerelease | 带版本号留档，供 changelog / 排查引用 |
| 候选 | `4.4.0-rc.1` | prerelease | 功能冻结，只修不填 |
| 正式 | `4.4.0` | 正式 | 发布后 `latest` 指向它，全员可更新 |
| 热修 | `4.4.1` | 正式 | 正式版出问题只能向前修，无法远程回退 |

**列车规则：测试版永远跑在「下一个正式版号」上**（`4.4.0-beta.N` → `4.4.0`）。
若测试版跑到 `4.5.0-beta.1` 而正式线还停在 `4.4.x`，这些用户关掉测试通道后会停在
「无更新」状态 —— 更新器只能向前，回不到更低的正式版号，只能重装。

版本比较必须是语义化的（`4.4.0-beta.1 < 4.4.0-rc.1 < 4.4.0`）。前端统一用
`frontend/src/core/version.js` 的 `cmpVersion()`；**不要**再按数字段比较 ——
`4.4.0-beta.1` 与 `4.4.0` 的数字段完全相同，会被判成同一版本，测试通道用户将永远收不到更新。

### 5.3 发布一个测试版

```powershell
# 1) 版本号升到 4.4.0-beta.1（package.json）
# 2) 构建（与正式版相同）
npm --prefix frontend run build
npx electron-builder --win dir --x64
powershell -ExecutionPolicy Bypass -File scripts/build-kachina.ps1 -Version 4.4.0-beta.1

# 3) 发内测 release（tag 带版本号，prerelease=true）
python scripts/upload-release-asset.py $env:GH_TOKEN qdTXTbp/FuFumidi v4.4.0-beta.1 `
    "release/FuFumidi Setup 4.4.0-beta.1.exe" "FuFumidi-Setup-4.4.0-beta.1.exe" `
    --prerelease --title "FuFumidi v4.4.0-beta.1" --body-file scripts/release-notes-v4.4.0-beta.1.md

# 4) 把离线包覆盖到固定锚点 tag beta（测试通道的下载地址，务必覆盖）
python scripts/upload-release-asset.py $env:GH_TOKEN qdTXTbp/FuFumidi beta `
    "release/update/FuFumidi.Install.4.4.0-beta.1.exe" "FuFumidi.Install.exe" `
    --prerelease --title "测试通道锚点（不要手动删除）"
```

> 第 4 步漏掉的话，测试通道用户检查到的版本会更新、但下载到的仍是上一版离线包。
> 反过来，`--prerelease` 一定不能漏 —— 一旦 `beta` 锚点变成正式 release，
> `releases/latest` 会指向它，所有正式用户都会收到内测包。

### 5.4 转正

1. 版本号改为 `4.4.0`，重新构建（**不要**再夹带功能改动）。
2. 跑完 `docs/TESTING.md` 的完整 L3 + L4 清单并归档报告，必须含「上一个正式版 → 4.4.0」直升级。
3. 发正式 release（不加 `--prerelease`），并覆盖固定名离线包：

```powershell
python scripts/upload-release-asset.py $env:GH_TOKEN qdTXTbp/FuFumidi v4.4.0 `
    "release/FuFumidi Setup 4.4.0.exe" "FuFumidi-Setup-4.4.0.exe"
python scripts/upload-release-asset.py $env:GH_TOKEN qdTXTbp/FuFumidi v4.4.0 `
    "release/update/FuFumidi.Install.4.4.0.exe" "FuFumidi.Install.exe"
```

`releases/latest` 随即指向 4.4.0，正式与测试两条通道的用户都能升上来。

### 5.5 通道隔离回归（每次发版必做）

在正式通道环境下「检查更新」，**看到任何 prerelease 版本号即为失败**。
这条断言用于防止把测试版误发成正式 release。

---

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `Error: Invalid remote index` | URI 含 `${version}` 占位符未被替换（404） | 改用 `releases/latest/download` 固定地址 |
| 更新器提示「更新器不存在」 | 正式包未随包分发更新器 | 确认 `electron-builder.yml` 的 `extraFiles` 生效，更新器与 exe 同级 |
| 更新完成后程序未自动打开 | 守护进程没起来 | 看 `<数据目录>\temp\fufumidi-restart.log`：缺 `[guard] start` = 守护进程没跑（注意 detached 的 PowerShell 不执行脚本，必须用 WMI 拉起，见 `main/update.js`）；有 `[guard]` 但停在 `updater appeared=False` = 更新器没起来 |
| 下载卡在 0% | 主程序侧旧逻辑预下载离线包 | 已废弃：改为更新器内下载并显示进度 |
| TLS/证书校验失败（构建/上传） | 本地网络工具干扰 | 构建用 `NODE_TLS_REJECT_UNAUTHORIZED=0`；上传脚本已 `verify=False` |

---

## 7. 相关脚本一览

| 脚本 | 用途 |
|---|---|
| `scripts/build-kachina.ps1` | 生成更新器 + 离线包（差分） |
| `scripts/upload-release-asset.py` | 上传/覆盖 Release 资产（固定名） |
| `Build/kachina.config.json` | 更新器内嵌源配置（ghfast 固定源） |
| `main/update.js` | 主进程更新服务（检查/启动更新器/守护重启） |

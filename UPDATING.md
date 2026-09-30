# FuFumidi 更新流程

本文档固定 FuFumidi 的**增量更新（客户端侧）**与**版本发布（制作侧）**完整流程。

---

## 1. 整体架构

```
GitHub Releases (qdTXTbp/FuFumidi)              CNB Releases (FuFuCloud-mirror/FuFuMIDI)
   │ 上游：FuFumidi.Install.exe                   │ 镜像：同资产名，两条通道各一个锚点
   │ 正式 releases/latest/download                │ 正式 .../-/releases/latest/download
   │ 测试 固定 tag beta                            │ 测试 固定 tag beta
   └────────────────────┬─────────────────────────┘
                        ▼  按「下载源偏好」+「更新通道」选源（HEAD 探测，失败自动换下一个）
FuFumidi.update.exe（kachina 增量更新器，与主程序 exe 同级）
   │  差分下载：只拉改动部分（Range 请求）
   ▼
主程序 FuFumidi.exe 替换完成 → 守护进程自动重启
```

- 更新器：kachina-installer（BetterGI 同款增量更新器），窗口内显示下载进度。
- 下载源是**两条线路 + 多个镜像**，运行时只能靠 `--source <id>` 选（源地址编译在更新器 exe 里，见 3.3）：
  - `cnb` / `cnb-beta`：CNB 国内镜像（「下载源 = 自动 / 国内」时的首选，见 3.5）
  - `ghfast` / `ghproxy` / `ghproxy-net`：GitHub 加速镜像
  - `github` / `github-beta`：GitHub 官方直连（境外网络首选）
- 两条线路都使用**地址不变**的锚点：正式 `releases/latest/download`、测试固定 tag `beta`，
  自动指向最新版本，无需写死版本号。

---

## 2. 客户端更新流程（用户视角）

1. 设置 → 更新 → 点击「检查更新」。
2. 主程序按「下载源偏好」查最新版本（正式版 + 国内优先时读 CNB 的 `latest.yml`，否则走 GitHub API，
   均多镜像回退，见 §3.5），与当前版本比对。
3. 发现新版本 → 弹窗确认。
4. 确认后主程序：
   a. 启动**独立守护进程**（`powershell` 隐藏窗口，等待更新器退出后自动重启主程序）；
   b. 拉起 `FuFumidi.update.exe -I -O --source <id>`（`<id>` 由「下载源偏好 + 更新通道」决定，见 §3.5）。
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

### 3.3 更新器配置（`build/kachina.config.json`）

声明两条线路、每条线路各带正式与测试两个通道的源，URI 全部是**地址不变**的锚点：

| 源 id | 线路 / 通道 | URI |
|---|---|---|
| `cnb` | 国内 CNB · 正式 | `https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/latest/download/FuFumidi.Install.exe` |
| `cnb-beta` | 国内 CNB · 测试 | `https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/download/beta/FuFumidi.Install.exe` |
| `ghfast` / `ghproxy` / `ghproxy-net` | GitHub 加速镜像 · 正式 | `<镜像前缀>https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe` |
| `ghfast-beta` / `ghproxy-beta` / `ghproxy-net-beta` | GitHub 加速镜像 · 测试 | `<镜像前缀>https://github.com/qdTXTbp/FuFumidi/releases/download/beta/FuFumidi.Install.exe` |
| `github` / `github-beta` | GitHub 官方 · 正式 / 测试 | 同上，前缀为空 |

- **不要**在 URI 中使用 `${version}` 占位符——kachina 对自定义 HTTP 源不会替换该占位符，会请求到带字面 `${version}` 的无效 URL，导致 `Invalid remote index`。
- 改完 `kachina.config.json` **必须重新生成更新器**（`npm run dist:win` 会自动先跑 `scripts/build-updater.js`），否则改动不生效。
- 源是编译进 exe 的：用户机器上已装的旧更新器里没有 `cnb`，得先升到带该源的版本，之后才吃得到（与 §5.1 对 beta 的说明同理）。

### 3.4 打包（`electron-builder.yml`）

- `extraFiles`：`release/update/FuFumidi.update.exe` → exe 同级，保证 `launchUpdater` 能找到更新器。

### 3.5 下载源偏好（国内 CNB / 全球 GitHub）

设置 → 更新 → 「下载源」三选一，存 `settings.download_source`
（同时双写 localStorage `fufumidi_download_source`，保证启动瞬间就能读到）：

| 取值 | 含义 | 源探测顺序 |
|---|---|---|
| `auto`（默认） | 自动（优先国内） | `[CNB, ghfast, gh-proxy, ghproxy.net, GitHub]` |
| `cnb` | 国内优先 | 同上 |
| `github` | 全球优先 | `[GitHub, ghfast, gh-proxy, ghproxy.net, CNB 兜底]` |

- 解析逻辑集中在 `main/download-source.js`（`sourceOf` / `preferCnb` / `cnbLatestUrl` / `cnbTagUrl` /
  `githubMirrorCandidates`），更新、以及后续的模型 / 音色下载共用同一套偏好。
- 主进程侧三处都按偏好排序，**任何一处失败都自动回退到序列中的下一个源，不会因为 CNB 不可用而收不到更新**：
  1. `resolveRelease()` —— 正式版 + 国内优先时先读 CNB 的 `latest.yml` 拿版本号（公开地址、免认证），失败再走 GitHub API；
  2. `pickUpdateSource()` —— HEAD 探测可用源（每个 6s 超时），取第一个可达的；
  3. `downloadInstallPackage()` —— 应用内整包下载的镜像顺序。
- `githubMirrorCandidates()` 只给 GitHub 地址套镜像前缀，CNB 地址原样返回，
  避免拼出 `https://ghfast.top/https://cnb.cool/...` 这类无效 URL。

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

### 发布后同步到 CNB 国内源

GitHub 侧发布完成后，按 **§5.6** 把这批资产镜像一份到 CNB
（`FuFuCloud-mirror/FuFuMIDI` 的同一 tag 下），否则「下载源 = 自动 / 国内」的用户拿不到国内加速。
镜像后按 §5.6 的验证命令确认 `latest` 锚点的 `version:` 已跟上。

---

## 5. 测试版与正式版双通道

两条通道靠 **GitHub 的 prerelease 语义**天然隔离，互不影响；CNB 侧是纯资产镜像，用「`latest` 锚点 / 固定 tag `beta`」对应同一套语义：

| 通道 | 版本查询 | 下载锚点（GitHub） | 下载锚点（CNB 国内源） | 谁能拿到 |
|---|---|---|---|---|
| 正式 stable | `releases/latest`（**自动跳过 prerelease**） | `releases/latest/download/FuFumidi.Install.exe` | `.../cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/latest/download/FuFumidi.Install.exe` | 所有人（默认） |
| 测试 beta | `releases` 列表里第一个 prerelease | `releases/download/beta/FuFumidi.Install.exe` | `.../-/releases/download/beta/FuFumidi.Install.exe` | 在「设置 → 更新 → 测试版通道」开启的人 |

**CNB 两个锚点怎么区分**

- **正式**：`.../-/releases/latest/download/...`。CNB 的 `is_latest` 由平台自动指向**最高 semver 的非预发布 release**
  （实测：把 v4.3.0 → v4.2.2 → … → v4.0.2 按版本降序批量建完 release 后，`latest` 仍指向 4.3.0，
  可排除「按创建时间」这一可能）。**所以正式渠道不需要在 CNB 上手工维护锚点，镜像新版本即可自动跟上。**
- **测试**：`.../-/releases/download/beta/...`，固定 tag `beta`，每次内测覆盖上传同名资产 —— 原因与 §5.1 完全相同
  （kachina 的源地址编译在 exe 里，必须是「内容会变、地址不变」的锚点）。
- **CNB 没有测试版的版本元数据**（`beta` 不是 semver，`latest.yml` 只反映正式版），
  所以**测试通道的版本查询永远走 GitHub Releases API**，CNB 只承担安装包下载。
  这也意味着：只开测试通道 + 只走国内源的用户，检查版本仍需要能访问 GitHub API（通常有镜像兜底）。

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

第 4 步完成后，还要按 **§5.6** 把 `beta` 锚点的资产镜像到 CNB，
否则「下载源 = 自动 / 国内」的测试者探测不到 CNB 锚点，会回退到 ghfast。

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

最后按 **§5.6** 把该 tag 的资产镜像到 CNB（**含 `latest.yml`**，否则国内源查不到版本号）。

### 5.5 通道隔离回归（每次发版必做）

在正式通道环境下「检查更新」，**看到任何 prerelease 版本号即为失败**。
这条断言用于防止把测试版误发成正式 release。

### 5.6 CNB 国内源镜像（每次发版必做）

CNB 仓库 `FuFuCloud-mirror/FuFuMIDI` 是 GitHub Releases 的**资产镜像**，供「下载源 = 自动 / 国内」的用户走国内线路。
它不承载任何独立版本，纯粹是同一批资产换一个下载地址。

**必须镜像的资产**（与 kachina 增量更新相关）：

| 资产 | 用途 | 需镜像到 |
|---|---|---|
| `FuFumidi.Install.exe` | **固定名**离线包，两条锚点都引用它 | 正式锚点 + `beta` 锚点 |
| `FuFumidi.Install.X.Y.Z.exe` | 带版本号离线包（留档，可选） | 对应版本 tag |
| `FuFumidi.update.exe` | 更新器本体（更新器会自更新，漏镜像会退到 GitHub） | 正式锚点 + `beta` 锚点 |
| `latest.yml` | 版本元数据，`fetchCnbRelease()` 读它的 `version:` 字段 | **仅正式锚点** |

**步骤**

```powershell
$env:CNB_TOKEN = '<CNB 访问令牌>'   # 从环境变量读，不要内联进脚本

# 正式版发布后：镜像该 tag 的资产
node <镜像脚本> --tag vX.Y.Z --assets "FuFumidi.Install.exe,FuFumidi.Install.X.Y.Z.exe,FuFumidi.update.exe,latest.yml"

# 测试版发布后：额外把离线包覆盖到固定锚点 tag beta
node <镜像脚本> --tag beta --assets "FuFumidi.Install.exe,FuFumidi.update.exe"
```

镜像走 CNB Release API 三步（脚本即封装这三步）：`POST /-/releases` 建/取 release →
`POST /-/releases/{id}/asset-upload-url` 拿上传地址 → `PUT` 上传资产 → `POST verify_url` 确认。
脚本是**幂等**的：已存在的同名资产会跳过，中断后直接重跑即可续传。

> 一次性补历史 / 补漏的全量脚本在仓库外的 `d:\FuFuMIDI\cnb-mirror-releases.js`
> （遍历 GitHub 全部 release，只挑上述 4 个资产名）。注意它当前把令牌**内联在源码里**，
> 补完历史后应改为读环境变量，且**不要**把带令牌的副本提交进仓库。

**发布后验证（两条锚点各查一次）**

```powershell
# 正式：version 必须等于本次正式版号；安装包必须 200 且 size 合理
curl -sSL https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/latest/download/latest.yml
curl -sSI  https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/latest/download/FuFumidi.Install.exe
```

**注意事项**

- **未发过 beta 时 `beta` 锚点返回 404 是正常的**（`release for tag beta not found`）。
  客户端 `pickUpdateSource()` 探测失败会自动换下一个源，功能不中断。
- **`beta` 锚点不能顶掉 `latest`**：CNB 的 `is_latest` 按最高 semver 计算，`beta` 不是 semver 所以不应被标记。
  但这一点**尚未在真实 `beta` tag 上验证过** —— 第一次发布 beta 后，请再查一次
  `.../releases/latest/download/latest.yml`，若版本号变成了 beta 锚点的内容，
  就把镜像脚本里 `beta` 那条改成 `prerelease: true` 后重建该 release。
- CNB 的 `latest` 是**平台行为**，不是我们写死的：以后若 CNB 改成「按创建时间」决定 latest，
  需要改为在建 release 时显式传 `make_latest`。

---

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `Error: Invalid remote index` | URI 含 `${version}` 占位符未被替换（404） | 改用 `releases/latest/download` 固定地址 |
| 更新器提示「更新器不存在」 | 正式包未随包分发更新器 | 确认 `electron-builder.yml` 的 `extraFiles` 生效，更新器与 exe 同级 |
| 更新完成后程序未自动打开 | 守护进程没起来 | 看 `<数据目录>\temp\fufumidi-restart.log`：缺 `[guard] start` = 守护进程没跑（注意 detached 的 PowerShell 不执行脚本，必须用 WMI 拉起，见 `main/update.js`）；有 `[guard]` 但停在 `updater appeared=False` = 更新器没起来 |
| 下载卡在 0% | 主程序侧旧逻辑预下载离线包 | 已废弃：改为更新器内下载并显示进度 |
| TLS/证书校验失败（构建/上传） | 本地网络工具干扰 | 构建用 `NODE_TLS_REJECT_UNAUTHORIZED=0`；上传脚本已 `verify=False` |
| CNB 源 404（`release for tag beta not found`） | 还没镜像过 `beta` 锚点（本地从未发过 beta） | 正常，客户端会自动回退 ghfast；发 beta 时按 §5.6 镜像 |
| CNB 的 `latest.yml` 版本号落后于 GitHub | 新版本发布后没镜像到 CNB | 按 §5.6 补镜像；补完 `latest` 会自动指向最高的正式版，无需手工改锚点 |
| 「下载源 = 国内」但下载仍走 ghfast | CNB 源探测失败（未镜像 / 网络不通） | 属预期回退；确认 §5.6 已镜像，并 `curl -sSI` 验证 CNB 锚点可达 |

---

## 7. 相关脚本一览

| 脚本 | 用途 |
|---|---|
| `scripts/build-kachina.ps1` | 生成更新器 + 离线包（差分） |
| `scripts/upload-release-asset.py` | 上传/覆盖 Release 资产（固定名） |
| `build/kachina.config.json` | 更新器内嵌源配置（CNB / ghfast / ghproxy / ghproxy-net / GitHub，各带正式与测试源） |
| `main/update.js` | 主进程更新服务（检查/启动更新器/守护重启） |
| `main/download-source.js` | 下载源偏好解析 + CNB / GitHub 地址构造（更新、模型、音色共用） |
| `d:\FuFuMIDI\cnb-mirror-releases.js` | 仓库外的一次性脚本：把 GitHub Release 资产全量镜像到 CNB（幂等、可续跑） |

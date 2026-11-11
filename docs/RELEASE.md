# FuFumidi 完整发版手册（Release）

适用于需要产出安装包 / 更新包 / 新版本的发布。**只改引擎小文件优先走热补丁**，见 [`HOTPATCH.md`](HOTPATCH.md)。

本文以 6.5.0 的实际发布流程为基准整理，所有路径与判据都来自实测。

---

## 0. 速查清单

```text
[ ] 版本号三处一致（根 package.json / frontend/package.json / changelog 条目）
[ ] 发布说明 scripts/release-notes-v<ver>.md 写好
[ ] npm run check:version && npm test 通过
[ ] 提交版本改动
[ ] 挪开旧 win-unpacked，跑 build-release.ps1 -Version <ver>
[ ] 确认 [ok] 更新器已嵌入配置 / [ok] 安装包，安装包 VersionInfo 正确
[ ] 包内 asar / 引擎 / preload 含本版代码
[ ] 组装 release/publish-<ver>/ 8 项资产
[ ] sign-update.mjs 签名 + 验签
[ ] 发布 CNB + GitHub（各 8 项）
[ ] 远端 latest / tag / 清单 sha256 核验
```

---

## 1. 版本与文案

### 1.1 改版本号

```bash
# 两处必须同步
package.json           "version": "6.5.0"
frontend/package.json  "version": "6.5.0"
```

前端显示的版本由构建期注入（`frontend/src/core/version.js`），不需要手改。

### 1.2 更新日志

`frontend/src/core/changelog.js` 顶部按版本追加条目（键不带 `v`）：

```js
const CHANGELOG = {
  '6.5.0': [
    '……面向用户的一句话说明……',
  ],
  '6.4.10': [ ... ],
};
```

写法要求：

- 每条以**用户能看到的结果**开头，再解释原因/代价；
- 已知边界要写进去（例如「镲片偏置是模型上限，本版不解决」）；
- 不在日志里写内部函数名、文件路径、提交号。

### 1.3 发布说明

新建 `scripts/release-notes-v<ver>.md`，会被上传为 release 资产，并作为 GitHub/CNB release 正文。
建议结构：主要改动 → 实测数据 → 已知边界 → 工程状态。

### 1.4 门禁与提交

```bash
npm run check:version     # 四源一致：根/前端/changelog/version.js 注入
npm test                  # 前端 + 引擎 + 下载 + 热补丁
git add package.json frontend/package.json frontend/src/core/changelog.js scripts/release-notes-v<ver>.md
git commit -m "chore(release): <ver>（一句话）"
```

---

## 2. 构建

### 2.1 前置检查

```powershell
# 1) 没有进程占用 release 目录
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like 'D:\FuFuMIDI\FuFumidi\release\*' }

# 2) 磁盘余量（安装包约 0.75 GB，构建中间产物数 GB）
Get-PSDrive D

# 3) 挪开上一次的便携目录（不要直接删，2 GB+ 且可能被占用）
$p='D:\FuFuMIDI\FuFumidi\release\win-unpacked'
if (Test-Path $p) { Rename-Item $p ('_stale-win-unpacked-' + (Get-Date -Format 'HHmmss')) }
```

### 2.2 一键构建

```powershell
Set-Location 'D:\FuFuMIDI\FuFumidi'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 本机工作环境可能设了 1
$env:FUFUMIDI_SKIP_PRUNE='1'                                          # 见 §2.4
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -Version 6.5.0
# 前端已构建过、只想重打安装包时可加 -SkipUi
```

脚本依次做四件事：

| 阶段 | 内容 | 产物 |
| --- | --- | --- |
| 0 | 前端构建（vite → `renderer/dist`） | `renderer/dist/**` |
| 1 | `electron-builder --win dir` | `release/win-unpacked/**` |
| 2 | kachina 生成更新器与离线包 | `release/update/FuFumidi.update.exe`、`FuFumidi.Install.<ver>.exe`、`metadata-<ver>.json` |
| 3 | `electron-builder --win nsis` | `release/FuFumidi Setup <ver>.exe` + `.blockmap` + `latest.yml` |

### 2.3 判成功：不要只看退出码

- **退出码 1 可能是假失败**：basic-pitch 的 `WARNING:root:Coremltools is not installed…` 走 stderr，
  外层 PowerShell 会记成 `NativeCommandError`。
- 真正的判据是日志里出现：

```
[ok] 更新器已嵌入配置： ...\release\update\FuFumidi.update.exe
[ok] 安装包： ...\release\FuFumidi Setup <ver>.exe
```

- 再核对安装包：`(Get-Item ...).VersionInfo.FileVersion` 必须是新版本号。

### 2.4 为什么默认跳过 Python 裁剪

`prune-python-bundle.cjs` 会删 `*.pdb`、`__pycache__`、`include` 等（约 249 MB）。
在部分 Windows 机器上，刚落盘的文件会被内核 minifilter 持有，`fs.unlinkSync` **无限阻塞**
（CPU 0，几分钟不返回），任何重试都无效。

- 设 `FUFUMIDI_SKIP_PRUNE=1` 跳过；功能不受影响，只是包体略大。
- 跳过要在**构建前**设，脚本会在 `[prune]` 段打印跳过原因。
- 另外：即使裁剪成功，第 3 步 NSIS 也会重新整目录复制 `resources/python`，裁剪对最终安装包**不生效**
  —— 想真正瘦身需要改构建结构，不要在发版时临时折腾。

### 2.5 常见构建错误

| 错误 | 原因 | 处理 |
| --- | --- | --- |
| `EPERM: operation not permitted, rmdir ...` | 旧的 `win-unpacked` 被占用/只读 | 先结束占用进程，再 `Rename-Item` 挪开，重跑 |
| `EPERM` 写 `FuFumidi.exe`（asar 完整性回写） | Defender 独占刚落盘的 204 MB exe | 已内置 `scripts/retry-fs-write.cjs` 重试；仍失败就重跑 |
| kachina `pack.rs: PermissionDenied` | staging 里残留旧 `FuFumidi.update.exe` 被占用 | 等 20 秒后单独重跑 `build-kachina.ps1` |
| NSIS 阶段 `EPERM ... narwhals\_pandas_like` | 同上，文件占用 | 脚本会自动挪开半成品重试；不要手动删目录 |
| `cmd /c` 被拒绝 | 安全策略不允许从 PowerShell 工具调 `cmd` | 改用 Bash 跑 `npx electron-builder ...` |

---

## 3. 组装 8 项发布资产

发布目录：`release/publish-<ver>/`。**8 项固定清单**：

| # | 文件名 | 来源 | 说明 |
| --- | --- | --- | --- |
| 1 | `FuFumidi-Setup-<ver>.exe` | `release/FuFumidi Setup <ver>.exe` | 安装包（注意连字符命名） |
| 2 | `FuFumidi-Setup-<ver>.exe.blockmap` | 同上 `.blockmap` | 差分更新 |
| 3 | `FuFumidi.Install.exe` | `release/update/FuFumidi.Install.<ver>.exe` | 离线更新包 |
| 4 | `FuFumidi.update.exe` | `release/update/FuFumidi.update.exe` | 更新器 |
| 5 | `metadata-<ver>.json` | `release/update/metadata-<ver>.json` | 文件哈希清单 |
| 6 | `latest.yml` | `release/latest.yml` | electron-builder 生成 |
| 7 | `update-manifest.json` | 本步签名生成 | Ed25519 签名清单 |
| 8 | `FuFumidi-<ver>-release-notes.md` | `scripts/release-notes-v<ver>.md` | 发布说明 |

组装（硬链接优先，跨盘自动回退为复制）：

```bash
cd release && mkdir -p publish-6.5.0 && cd publish-6.5.0
ln -f "../FuFumidi Setup 6.5.0.exe" "FuFumidi-Setup-6.5.0.exe" || cp "../FuFumidi Setup 6.5.0.exe" .
ln -f "../FuFumidi Setup 6.5.0.exe.blockmap" "FuFumidi-Setup-6.5.0.exe.blockmap" || cp ...
ln -f "../update/FuFumidi.Install.6.5.0.exe" "FuFumidi.Install.exe" || cp ...
ln -f "../update/FuFumidi.update.exe" "FuFumidi.update.exe" || cp ...
ln -f "../update/metadata-6.5.0.json" "metadata-6.5.0.json" || cp ...
ln -f "../latest.yml" "latest.yml" || cp ...
cp "../../scripts/release-notes-v6.5.0.md" "FuFumidi-6.5.0-release-notes.md"
```

签名第 8 项：

```bash
node scripts/sign-update.mjs \
  --exe "release/publish-6.5.0/FuFumidi.Install.exe" \
  --version 6.5.0 --name FuFumidi.Install.exe \
  --key "E:/ed25519-private.pem" \
  --out release/publish-6.5.0/update-manifest.json
```

验签 + 数量自检：

```bash
node -e "
const fs=require('fs'),u=require('./main/update_sign.js');
const m=JSON.parse(fs.readFileSync('release/publish-6.5.0/update-manifest.json','utf8'));
u.verifyManifest({filePath:'release/publish-6.5.0/FuFumidi.Install.exe',manifest:m})
 .then(r=>{console.log(JSON.stringify(r));process.exit(r.ok?0:1)});
"
ls release/publish-6.5.0 | wc -l   # 必须是 8
```

另外核对：

- `latest.yml` 里 `version` 是新版本、`path/url` 是 `FuFumidi-Setup-<ver>.exe`、`size` 与安装包一致；
- `metadata-<ver>.json` 的 `repo_name=qdTXTbp/FuFumidi`、`tag_name=<ver>`（**无 v 前缀**，与历史一致）。

---

## 4. 发布

发布脚本按版本复制上一版模板（`scripts/publish-<prev>-{cnb,github}.js`），替换版本号。
**这两个脚本故意不提交**：CNB 脚本里硬编码了 token。

### 4.1 CNB

```bash
node scripts/publish-6.5.0-cnb.js
```

要点：

- `target_commitish` 必须是 `'master'`（两个远端默认分支都是 master；用本地 HEAD 会指向不存在的提交）；
- `prerelease: false`、`make_latest: 'true'`；
- 713 MB 安装包约 110 秒，161 MB 离线包约 100 秒，总计 3–4 分钟。

### 4.2 GitHub

```bash
F=/c/Users/<you>/.workbuddy/projects/d-FuFuMIDI/<session>.jsonl
TOK=$(grep -o 'ghp_[A-Za-z0-9]\{36\}' "$F" | sort -u | head -1)
GH_TOKEN="$TOK" node scripts/publish-6.5.0-github.js
```

要点：

- 凭据管理器里那份 GitHub 密码可能已失效；有效的是 classic PAT（40 位 `ghp_`）；
- release 创建在默认分支 HEAD（master），`draft: false, prerelease: false`；
- 上传 3–4 分钟；脚本会回读远端资产尺寸并比对。

---

## 5. 发布后核验

### 5.1 CNB

```bash
node -e "
const {execFileSync}=require('child_process'),fs=require('fs');
const T='<cnb-token>';
const r=JSON.parse(execFileSync('curl.exe',['-sS','--ssl-no-revoke','-H','Authorization: Bearer '+T,
 '-H','Accept: application/vnd.cnb.api+json',
 'https://api.cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/tags/v6.5.0'],{encoding:'utf8',maxBuffer:64*1024*1024}));
console.log('tag='+r.tag_name,'is_latest='+r.is_latest,'assets='+r.assets.length);
for(const a of r.assets){const p='release/publish-6.5.0/'+a.name;
 console.log((a.size===fs.statSync(p).size?'OK  ':'BAD ')+a.name);}
"
```

### 5.2 GitHub

- `GET /repos/qdTXTbp/FuFumidi/releases/latest` → `tag_name=v6.5.0`、`prerelease=false`、`assets=8`；
- `GET /repos/qdTXTbp/FuFumidi/git/ref/tags/v6.5.0` 应存在，`object.sha` = 远端 master HEAD。

### 5.3 内容一致性（必做）

把两端的 `latest.yml` 与 `update-manifest.json` 下载回来，与 `release/publish-<ver>/` 里的文件比 sha256：

- CNB：`https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/download/v<ver>/latest.yml`
- GitHub 直链在本机可能 `CONNECT tunnel failed 502`，改走 API：
  `GET /repos/qdTXTbp/FuFumidi/releases/assets/<id>` + `Accept: application/octet-stream`。

```bash
# 期望：size 相同、sha256 相同
sha256sum release/publish-6.5.0/latest.yml
```

### 5.4 包内容抽检（发版前做一次即可）

```bash
node -e "
const a=require('@electron/asar');
const p='release/win-unpacked/resources/app.asar';
console.log('version=',JSON.parse(a.extractFile(p,'package.json').toString()).version);
console.log('hotpatch=',a.listPackage(p).some(x=>x.endsWith('main/hotpatch.js')));
"
grep -c "LEAD_IN_SEC" release/win-unpacked/resources/app.asar.unpacked/engine/engine_muscriptor.py
```

---

## 6. 常见坑（实测）

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| 假失败 | 退出码 1，但产物齐全 | 看 `[ok]` 两行 + VersionInfo |
| `win-unpacked` 删不掉 | `EPERM rmdir ... torch-2.13.0.dist-info\...` | `Rename-Item` 挪开，别硬删 |
| NSIS 重拷 Python | 裁剪成果被冲掉 | 已知；不在发版时处理 |
| `latest.yml` 换行写成字面量 `\n` | 更新器解析失败 | 用数组 `join('\n')` 生成；优先让 electron-builder 生成 |
| 更新器配置未嵌入 | 更新器装到错误目录 | 断言 `FuFumidiData` / `FuFumidi.exe` 字节存在 |
| tag 指向 master 头 | tag 上不含本版源码 | 历史惯例；要带源码需另行 push master |
| beta 锚点缺 metadata | beta 通道装不上 | 发布新 beta 时一并补资产；stable 不受影响 |
| `curl.exe` 写文件报 23 | 传了 POSIX 路径 | 给 `curl.exe` 用 `D:/...` 形式 |
| GitHub 直链 502 | 本机网络/代理 | 走 API 下载资产核验 |

---

## 7. 完整版 vs 热补丁

| 情况 | 选择 |
| --- | --- |
| 只改 `app.asar.unpacked/engine/**` 等白名单文件 | **热补丁**（`docs/HOTPATCH.md`） |
| 改主进程、preload、前端、依赖、资源清单 | 完整发版 |
| 需要用户看到新版本号 / 更新日志 | 完整发版 |
| 修一个紧急引擎 bug，但不想让用户下 700 MB | 热补丁（前提：用户 ≥6.5.0） |

热补丁与完整版的关系：完整更新会覆盖补丁文件，但补丁状态在数据目录，客户端下次启动会自动重放。

---

## 8. 6.5.0 实测参数（参考基线）

| 项目 | 数值 |
| --- | --- |
| 安装包 | 747,675,325 B / 713.04 MB，VersionInfo 6.5.0 |
| SHA256 | `8B6537748E48005B903C789D8444A47DB343C5521BBC86F4955AD5556967F6D6` |
| 离线包 | `FuFumidi.Install.6.5.0.exe` 169,789,494 B |
| 更新器 | `FuFumidi.update.exe` 9,988,508 B |
| metadata | `metadata-6.5.0.json`，359 个文件哈希 |
| 构建耗时 | 前端 ~11 s + dir ~10 min + kachina ~4 min + NSIS ~4 min |
| 上传耗时 | CNB 3m37s / GitHub 3m10s |
| 远端 release id | CNB `2120645756617228288` / GitHub `442263633` |

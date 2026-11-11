# FuFumidi 热补丁（Hot Patch）

给「只改了几个小文件」的修复用的一条独立通道：**不建 release、不 bump 版本号、不让用户下载几百 MB 安装包**。
把两个文件 push 到仓库固定目录即可，客户端启动后自动验签并静默应用。

> **从 6.5.0 起生效。** 6.5.0 是热补丁的 bootstrap 版：更早安装的客户端没有这段代码，收不到任何补丁；
> 之后的引擎小改动才能真正免发版。

与版本更新的分工：

| 改动内容 | 走哪条 |
| --- | --- |
| `resources/app.asar.unpacked/engine/**`（Python 引擎）、已 unpack 的 renderer vendor 资源 | 热补丁 |
| `main.js` / `main/*.js` / `preload.js` / `renderer/dist/**`（封在 `app.asar` 内） | 完整发版 |
| 依赖、`package.json`、模型/资源清单、需要改版本号的功能 | 完整发版 |
| `resources/python/**`、`models/**`（安装器保护目录） | 完整发版 / 资源中心 |

---

## 0. 速查

```bash
# 1) 生成（在仓库根目录）
node scripts/build-hotpatch.mjs \
  --id 2026-11-12-01 \
  --files engine/audio_io.py,engine/engine_muscriptor.py \
  --notes "修 xxx" --min 6.5.0 --max 6.5.99 \
  --key E:/ed25519-private.pem --out release/hotpatch

# 2) 上传：两个仓库的 master 分支 patches/ 目录
#    hotpatch.json + hotpatch-<id>.zip（README.txt 可选）
git add patches/hotpatch.json patches/hotpatch-2026-11-12-01.zip
git commit -m "hotpatch: 2026-11-12-01 修 xxx"
git push cnb master && git push origin master

# 3) 验证地址返回 200 且内容是新清单
curl -sI https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/git/raw/master/patches/hotpatch.json
```

用户侧：设置 → 更新 → 「热补丁」区块可查看已应用 id、上次检查时间、错误，以及 `检查补丁` / `回滚补丁`。
彻底关闭：环境变量 `FUFUMIDI_NO_HOTPATCH=1`。

---

## 1. 能覆盖什么

| 路径 | 能否热补丁 | 说明 |
| --- | --- | --- |
| `resources/app.asar.unpacked/engine/**` | ✅ | 全部 Python 引擎文件，按路径被子进程直接读取 |
| `resources/app.asar.unpacked/renderer/**` | ✅ | js-synth / soundfonts 等已 unpack 的资源 |
| `main.js`、`main/*.js`、`preload.js` | ❌ | 封在单个 `app.asar` 里，改字节会破坏头部 `integrity.hash` 与 exe 内嵌完整性资源 |
| `renderer/dist/assets/*.js`、`index.html` | ❌ | 同上 |
| `resources/python/**`、`models/**` | ❌ | 受 kachina `ignoreFolderPath` 保护、不随更新替换；改动应走完整发版或资源中心 |
| `*.exe` / `*.dll` / `*.node` / `*.pyc` | ❌ | 白名单直接拒绝 |

硬编码在 `main/hotpatch_manifest.js` 的约束：

- 路径必须是 `/` 分隔的相对路径，不含 `..`、盘符、NUL、反斜杠；
- 扩展名白名单：`.py .json .yaml .yml .txt .md .js .css .ini .cfg`；
- 补丁最多 **60 个文件**、单文件 **2 MiB**、解压总量 **12 MiB**、zip **16 MiB**、说明文字 2000 字。

判断口诀：**目标文件在安装目录里能单独看见、且不是可执行文件 → 可热补丁；否则整包发版。**

---

## 2. 发布一个补丁

### 2.1 前置

- 私钥在构建机 `E:\ed25519-private.pem`（与整包更新签名同一把）；也可用 `--key` 或 `FUFUMIDI_UPDATE_KEY` 指定。
- 工作区里的源文件就是「补丁后」的版本；目标安装目录里的同名文件是「补丁前」的版本。

### 2.2 生成

```bash
node scripts/build-hotpatch.mjs \
  --id 2026-11-12-01 \
  --files engine/audio_io.py,engine/engine_muscriptor.py \
  --notes "修边界对齐修正的落盘路径" \
  --min 6.5.0 --max 6.5.99 \
  --key E:/ed25519-private.pem \
  --out release/hotpatch
```

自动映射规则：

| 源路径 | 目标路径 |
| --- | --- |
| `engine/x.py` | `resources/app.asar.unpacked/engine/x.py` |
| `renderer/dist/vendor/js-synth/x.js` | 同名 `unpacked/` 路径 |
| `renderer/vendor/soundfonts/x.js` | 同名 `unpacked/` 路径 |
| 已写全 `resources/app.asar.unpacked/...` | 原样 |

不确定时用 `--map "目标相对路径=源路径"` 显式指定，可重复：

```bash
node scripts/build-hotpatch.mjs --id 2026-11-12-02 \
  --map "resources/app.asar.unpacked/engine/presets.py=engine/presets.py" \
  --key E:/ed25519-private.pem --out release/hotpatch
```

### 2.3 产物

```
release/hotpatch/
├─ hotpatch.json              # 签名清单（客户端唯一入口）
├─ hotpatch-<id>.zip          # 补丁包（只含清单里列出的文件）
└─ README.txt                 # 本次产物说明与固定地址（不参与分发）
```

工具会用**内嵌公钥**自校验一次（`--pub` 仅用于临时密钥的单测/自建密钥场景），签名对不上会直接报错退出。

### 2.4 上传

`patches/` 目录在两个仓库的 **`master`** 分支（`git ls-remote --symref` 实测；写 `main` 会永远 404）：

```
CNB    https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/git/raw/master/patches/hotpatch.json
GitHub https://raw.githubusercontent.com/qdTXTbp/FuFumidi/master/patches/hotpatch.json
       （客户端候选里另有 ghfast.top 加速前缀）
```

两个仓库都放同一份文件，客户端按「设置 → 下载源」排序并自动回落。

```bash
# 在能 push 两个远端的仓库副本里
git add patches/hotpatch.json patches/hotpatch-<id>.zip
git commit -m "hotpatch: <id> <一句话说明>"
git push cnb master
git push origin master
```

上传后自检：

```bash
curl -s https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/git/raw/master/patches/hotpatch.json | head -5
curl -sI https://ghfast.top/https://raw.githubusercontent.com/qdTXTbp/FuFumidi/master/patches/hotpatch.json | head -3
```

> GitHub raw 有几分钟 CDN 缓存，刚 push 完可能仍返回旧清单；CNB 一般立即生效。
> 客户端有多源与本地缓存，短暂不一致不会写坏文件（清单与包都验签/校验哈希）。

### 2.5 版本范围怎么写

`target.min` / `target.max` 是**补丁可应用的客户端版本区间**（含端点，按 `x.y.z` 数值比较，忽略 `-beta.N` 后缀）。

| 场景 | 写法 | 说明 |
| --- | --- | --- |
| 只保证当前大版本可用 | `min=6.5.0, max=6.5.99` | 推荐；6.6 起需要重新确认接口 |
| 向下兼容多个版本 | `min=6.4.0, max=6.5.99` | 只有确认接口未变时才这样写 |
| 不限 | 留空 | 不推荐；接口漂移时会在老版本上写坏 |

**改了函数签名、配置键、文件路径的补丁，必须收紧 `min`**，不要指望老客户端能兼容。

### 2.6 id 与幂等

- `id` 是幂等键，正则 `[A-Za-z0-9._-]{1,80}`，建议 `YYYY-MM-DD-NN`。
- 同一 `id` + 目标文件哈希一致 → 客户端返回 `up-to-date`，不重复写盘。
- 同一 `id` 但目标文件被完整更新换掉 → 自动 `replayed`（从本地缓存重放，不重新下载）。
- 内容变了就必须换新 `id`；不要复用旧 id 改内容。

---

## 3. 清单规范

`hotpatch.json`：

```json
{
  "format": "fufumidi-hotpatch/v1",
  "id": "2026-11-12-01",
  "notes": "修边界对齐修正的落盘路径",
  "target": { "min": "6.5.0", "max": "6.5.99" },
  "package": {
    "name": "hotpatch-2026-11-12-01.zip",
    "size": 16243,
    "sha256": "55275c02...9ed8f"
  },
  "files": [
    {
      "path": "resources/app.asar.unpacked/engine/audio_io.py",
      "size": 13199,
      "sha256": "7cda2898...ef85"
    }
  ],
  "sig": "<Ed25519 base64>"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `format` | ✅ | 固定 `fufumidi-hotpatch/v1` |
| `id` | ✅ | 幂等键，见 §2.6 |
| `notes` | ➖ | 展示用说明，≤2000 字 |
| `target.min/max` | ➖ | 适用版本区间；留空表示不限 |
| `package.name` | ✅ | 必须是 `*.zip` 的文件名（不含路径） |
| `package.size/sha256` | ✅ | zip 字节数与哈希 |
| `files[].path/size/sha256` | ✅ | 目标相对路径与逐文件校验值 |
| `sig` | ✅ | 对规范串的 Ed25519 签名 |

签名规范串（`main/hotpatch_manifest.js` 的 `canonical()`，排序后拼接，绝不依赖 JSON 键顺序）：

```
fufumidi-hotpatch/v1
<id>
<notes>
<min>|<max>
<package.name>|<package.size>|<package.sha256>
<path>\t<size>\t<sha256>      # 按 path 字典序
...
```

客户端校验顺序（任何一步失败都不写盘）：

1. `format` / `id` / `notes` 长度 / 版本区间；
2. `package` 名称、体积、sha256 格式；
3. 每个 `files[]` 的路径白名单、去重、单文件体积、sha256 格式、总量；
4. **Ed25519 验签**（公钥内嵌在 `main/update_sign.js`）；
5. 下载后 zip 的 sha256；
6. 解压前逐条目路径校验 + 逐文件 size/sha256 + 清单外条目数必须为 0。

---

## 4. 客户端行为

### 4.1 触发与串行

- **打包版**启动 `app.whenReady()` 后 **9 秒**延迟检查（不阻塞启动）；开发版不自动检查。
- `hotpatch:check`（界面按钮）会带 `force: true`，即使已应用也会重新比对。
- 所有检查经同一个 Promise 队列串行，启动自动检查与手动点击不会打架。
- `FUFUMIDI_NO_HOTPATCH=1` → 直接返回 `disabled`，不发任何网络请求。

### 4.2 状态机

```
                ┌──────────── 无清单（404） ──────────→ none
                │
fetch manifest ─┼─ 验签/版本/白名单失败 ─────────────→ invalid
                │
                └─ 通过 ─→ 已应用且目标哈希一致 ────────→ up-to-date
                              │
                              ├─ 已应用但被完整更新换掉 ─→ 重放（缓存）→ replayed
                              └─ 未应用 ─→ 下载 zip → 校验 → 备份 → 原子替换 → applied
                                            │
                                            ├─ 体积不符/下载失败 → download-failed
                                            ├─ zip 哈希不符      → corrupt
                                            └─ 写盘失败          → apply-failed（已改文件回滚）
```

### 4.3 返回值

`check()` / `hotpatch:check` 返回 `{ ok, status, id?, files?, error? }`：

| status | ok | 含义 | 界面表现 |
| --- | --- | --- | --- |
| `applied` | ✅ | 首次应用成功 | 已应用热补丁 |
| `replayed` | ✅ | 被完整更新冲掉后自动重放 | 已重新应用热补丁 |
| `up-to-date` | ✅ | 已应用且一致 | 热补丁已是最新 |
| `none` | ✅ | 仓库没有补丁（至少一个源明确 404） | 暂无可用热补丁 |
| `disabled` | ✅ | 环境变量关闭 | 热补丁已关闭 |
| `invalid` | ❌ | 清单格式/签名/版本/路径/内容校验失败 | 显示 `error` |
| `corrupt` | ❌ | 补丁包 sha256 不符 | 显示 `error` |
| `download-failed` | ❌ | 下载失败或体积不符 | 显示 `error` |
| `apply-failed` | ❌ | 写盘失败（已回滚） | 显示 `error` |
| `unreachable` | ❌ | 所有源都失败（无任何 404） | 显示 `error` |

> `none` 与 `unreachable` 的区别很重要：只要有一个源明确回 404，就认为「仓库确实没放补丁」；
> 用户网络里 `raw.githubusercontent.com` 常被墙，不能因此每天记一条错误。

### 4.4 磁盘布局

```
<dataRoot>/hotpatch/
├─ state.json                       # { applied:[{id,at,files}], lastCheck, lastError }
├─ cache/
│  └─ hotpatch-<id>.zip             # 下载缓存，重放时不再联网
└─ backup/<id>/
   ├─ index.json                    # 每个目标文件的 rel 与 absent 标记
   └─ resources/app.asar.unpacked/engine/...   # 原件（absent 的不写）
```

`<dataRoot>` 默认是安装目录旁的 `FuFumidiData/`（`main/paths.js`），受 kachina `ignoreFolderPath` 保护：
完整更新不会删它，所以补丁状态与备份能跨版本存活。

### 4.5 日志

写 `main/log`，分类 `hotpatch`：应用/重放成功记 INFO，备份失败、自动检查异常记 WARN。
日志目录见「设置 → 关于 → 打开日志目录」。

---

## 5. 安全设计

- **信任链**：清单用 Ed25519 签名，公钥编译进应用（`main/update_sign.js`）；私钥只在构建机。
  签名覆盖 id / notes / 版本区间 / 包名+体积+哈希 / 全部文件路径+体积+哈希 —— 改任何一个字节都会验签失败。
- **路径**：拒绝绝对路径、盘符、`..`、反斜杠、NUL；解压**不落盘**，直接在内存里按清单取条目，
  天然不会创建符号链接或目录穿越。
- **可执行文件**：`.exe/.dll/.pyd/.so/.dylib/.node/.asar/.bin/.pyc` 一律拒绝，避免把补丁通道变成代码注入通道。
- **原子性**：逐文件写 `tmp` 再 `rename`；任一文件失败，把本次已替换的文件全部还原（含删除原本不存在的新文件）。
- **完整更新保护**：完整更新会整体替换 `app.asar.unpacked`，但补丁状态在数据目录；
  每次启动比对目标哈希，被换掉就自动重放。
- **可回滚**：每次应用都把原件备份到 `backup/<id>/`，界面可一键回滚（LIFO：先回最近一个）。

---

## 6. 与完整更新/安装器的关系

- kachina 安装器的 `ignoreFolderPath` 保护：`resources/python`、`models`、`wallpapers`、
  `wallpaper-thumbs`、`FuFumidiData`。**`app.asar.unpacked` 不在其中**，所以完整更新会覆盖补丁 —— 这正是需要重放的原因。
- 补丁**不写** `latest.yml`、**不改** `app.getVersion()`、**不参与** asar integrity，
  也不影响 exe 内嵌完整性资源（它改的文件本来就在 asar 外）。
- 完整更新后第一次启动：9 秒后自动比对 → `replayed`；用户无感，不需要重新下载/重新发布。
- 数据目录被用户手动清空：补丁会重新下载一次（缓存没了），仍能恢复。

---

## 7. 界面与开关

设置 → 更新 → 「热补丁」：

- 显示最近一次已应用补丁 id、上次检查时间、失败原因、`healthy`（目标文件是否还在）；
- `检查补丁`：强制检查一次；
- `回滚补丁`：回滚最近一个补丁；
- 收到主进程 `hotpatch:changed` 事件时自动刷新。

桥接（`preload.js`）：`window.fufumidi.hotpatch.{check,status,rollback,onChanged}`。
IPC（`main/hotpatch.js`）：`hotpatch:check` / `hotpatch:status` / `hotpatch:rollback`。

---

## 8. 构建工具参考

`scripts/build-hotpatch.mjs`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--id` | `YYYY-MM-DD-01` | 幂等键 |
| `--files` | 无 | 逗号分隔的源文件（自动映射） |
| `--map` | 无 | `目标相对路径=源路径`，可重复 |
| `--notes` | 空 | 展示说明 |
| `--min` / `--max` | 空 | 适用版本区间 |
| `--out` | `release/hotpatch` | 产物目录 |
| `--key` | `E:/ed25519-private.pem` 或 `FUFUMIDI_UPDATE_KEY` | 私钥 |
| `--pub` | 无 | **仅测试用**：用指定公钥自校验（默认用内嵌公钥） |

行为：

- 逐个校验目标路径白名单、去重、单文件体积，然后打 zip；
- 按路径排序生成 `files[]`，签 `canonical()` 串；
- 用内嵌公钥自校验，失败即退出（不会产出不可用的清单）；
- 包超过 16 MiB 直接报错，提示改用完整发版。

---

## 9. 测试与验证

### 9.1 自动测试（提交前必跑）

```bash
npm run test:hotpatch          # 10 项：签名/白名单/体积/覆盖/回滚/重放/构建工具
npm test                       # 含 test:hotpatch、test:download、前端与引擎测试
```

覆盖点：篡改任一字段验签失败、路径穿越/可执行文件拒绝、版本区间、清单外条目拒绝、
原子覆盖、完整更新后重放（走缓存不重下）、回滚恢复（新增文件被删除）、404 与混合网络错误判定。

### 9.2 端到端（手工，发布前建议做一次）

1. 用真私钥生成补丁；
2. 起一个本地 HTTP 服务托管 `hotpatch.json` 与 zip；
3. 在临时目录造一个模拟安装目录（`resources/app.asar.unpacked/engine/...`），
   把 `net.fetch` 的候选 URL 改写到本地，调用 `check()`；
4. 断言：`applied` → 目标文件哈希 = 源文件、`app.asar` 未变、备份与状态齐全；
5. 把目标文件换回基线 → 再检查应为 `replayed` 且不重新下载；
6. `rollback()` → 基线恢复、新增文件被删除；
7. 篡改清单 / 同长度篡改 zip / 改大 zip / 版本越界 → 分别得到 `invalid` / `corrupt` / `download-failed` / `invalid`。

### 9.3 真实 Electron 验证（改到 IPC/启动逻辑时必做）

最小 Electron 应用 + 隐藏窗口，走真实 `ipcMain.handle` 与 `ipcRenderer.invoke`：

```bash
# 注意：本机工作环境里 ELECTRON_RUN_AS_NODE=1，会让 electron 退化成纯 Node
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe <最小应用目录>
```

验证两条路径：

- 手动：`ipcRenderer.invoke('hotpatch:check' / 'status' / 'rollback')`；
- 自动：`registerHotpatchIpc({ app: { isPackaged: true }, autoCheck: true })` 后不调 IPC，
  约 9–11 秒内 `state.json` 出现 `applied`。

注意测试 app 的 `app.getVersion()` 是它自己的 `package.json` 版本（通常 1.0.0），
必须显式传 `appVersion: '6.5.0'`，否则会被版本区间挡住（这本身也是版本闸门的验证）。

### 9.4 生产地址自检

```bash
node -e "
const HP=require('./main/hotpatch.js'),fs=require('fs'),os=require('os'),path=require('path');
const t=fs.mkdtempSync(path.join(os.tmpdir(),'fuhp-'));
HP.check({net:{fetch:(u,o)=>fetch(u,o)},appVersion:'6.5.0',readSettings:()=>({}),source:'cnb',
  targetRoot:path.join(t,'i'),stateRoot:path.join(t,'d')}).then(r=>console.log(r.status,r.error||''));
"
# 仓库没放补丁时应为 none；若为 unreachable，说明三个候选源全挂（检查网络/分支是否 master）
```

---

## 10. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 界面一直「暂无可用热补丁」 | 仓库 `patches/` 为空；或分支写成了 `main` | 确认两个远端默认分支为 `master`，URL 自检 200 |
| `unreachable` | 三个候选源都失败（断网/代理/仓库私有） | `curl` 逐个试；CNB 与 ghfast 至少一个要通 |
| `invalid` + 「签名验证失败」 | 清单被改过 / 私钥与内嵌公钥不配对 | 重新生成，别手改 JSON |
| `invalid` + 「当前版本低于/高于适用范围」 | `min/max` 写错，或测试 app 没传 `appVersion` | 修正区间；测试时显式传版本 |
| `corrupt` | zip 被替换/截断（同长度篡改也会被 sha256 抓住） | 重新上传 zip，确认与清单同批生成 |
| `download-failed` + 「大小不符」 | 上传截断，或 CDN 返回错误页 | 重新上传；对比 `package.size` 与远端字节数 |
| `apply-failed` | 安装目录不可写（装在 `Program Files` 且无权限） | 改用用户级安装；或手动以管理员运行一次 |
| 已应用但文件是旧的 | 引擎常驻 worker 已加载旧模块 | 重启应用；补丁在启动 9 秒后应用，任务进行中不会热替换 |
| 界面没有「热补丁」区块 | 客户端 < 6.5.0（bootstrap 之前） | 升级到 6.5.0+ |
| 完整更新后补丁没了 | 正常现象，`app.asar.unpacked` 被整体替换 | 下次启动会自动 `replayed`（缓存仍在） |

---

## 11. 发布检查清单

- [ ] 只改了白名单内的文件（`engine/**` 等），没有动 `app.asar` 里的东西
- [ ] 工作区源文件 = 期望的补丁后版本；已在本地跑过 `npm test`
- [ ] `--min/--max` 与接口兼容性匹配（改了签名就收紧下限）
- [ ] `id` 是新的、没复用；`notes` 能让人看懂改了什么
- [ ] 私钥正确，工具自校验通过（输出 `sig ok`）
- [ ] `hotpatch.json` 与 zip **同批**上传到两个仓库 `master:patches/`
- [ ] 两个远端 URL 自检返回 200，且 `id` 是新的
- [ ] 找一台 6.5.0+ 客户端验证：9 秒后 `applied`，目标文件哈希变化，界面显示 id
- [ ] 若补丁有问题：发一个**新 id** 修正，或让用户点「回滚补丁」；不要只删远端清单

---

## 12. 已知限制

- **bootstrap**：只有 ≥6.5.0 的客户端有热补丁模块；老版本收不到。
- **asar 内文件不可热补丁**：主进程、preload、前端 bundle 改动仍要整包发版（安全边界，不做例外）。
- **不改变版本号**：设置页、`latest.yml`、关于页仍显示安装版本；补丁只在热补丁区块可见。
- **运行中的 worker 不会热替换**：补丁在启动 9 秒后应用，若此时已有转录任务在跑，重启后生效。
- **回滚是 LIFO**：只回最近一个补丁；连续多个补丁要按逆序回滚。
- **只分发「最新清单」**：不做补丁链；新清单会覆盖旧的，但已应用过的 id 仍保留在备份里。
- **不做自动撤回**：已应用的用户不会因为远端删文件而自动撤销。
- **CDN 缓存**：GitHub raw 刚 push 后可能短暂返回旧清单；客户端多源 + 校验哈希，不会写坏文件。
- **依赖不能新增**：补丁只覆盖文件，不能安装新的 Python/npm 依赖；需要新依赖请整包发版。

---

## 13. 变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-11-11 | 首次实现：清单签名、白名单、原子覆盖、备份/回滚、完整更新后重放、设置页区块 |
| 2026-11-11 | 测试补齐：单元 10 项 + 机制 E2E 43 项 + 真实 Electron IPC 10 项 + 启动自动检查 4 项 |
| 2026-11-11 | 修：候选源分支由 `main` 改为 `master`（两端默认分支实测）；`none` 判定兼容部分源不可用 |
| 2026-11-12 | 随 **6.5.0** 发布，成为热补丁的 bootstrap 版本 |

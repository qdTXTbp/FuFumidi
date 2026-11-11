# FuFuMIDI 热补丁（Hot Patch）

给「只改了几个小文件」的修复用的一条独立通道：**不建 release、不 bump 版本号、不让用户下载几百 MB 安装包**。
把两个文件 push 到仓库固定目录即可，客户端启动后自动验签并静默应用。

> 与版本更新的分工：改了 `app.asar` 内的代码（主进程 JS、前端产物）、依赖、资源清单 → 必须整包发版；
> 只改 `app.asar.unpacked` 下的真实文件（主要是 Python 引擎）→ 走热补丁。

## 1. 能覆盖什么

| 路径 | 能否热补丁 | 说明 |
| --- | --- | --- |
| `resources/app.asar.unpacked/engine/**` | ✅ | 全部 Python 引擎文件，按路径被子进程直接读取 |
| `resources/app.asar.unpacked/renderer/**` | ✅ | js-synth / soundfonts 等已 unpack 的资源 |
| `main.js`、`main/*.js`、`preload.js` | ❌ | 封在单个 `app.asar` 里，改字节会破坏头部 `integrity.hash` 与 exe 内嵌完整性资源 |
| `renderer/dist/assets/*.js`、`index.html` | ❌ | 同上 |
| `resources/python/**`、`models/**` | ❌ | 受 kachina `ignoreFolderPath` 保护、不随更新替换；改动应走完整发版或资源中心 |
| `*.exe` / `*.dll` / `*.node` / `*.pyc` | ❌ | 白名单直接拒绝 |

额外约束（在 `main/hotpatch_manifest.js` 里硬编码）：路径必须是 `/` 分隔的相对路径、不含 `..`、不含盘符、不带 NUL；
扩展名白名单 `.py/.json/.yaml/.yml/.txt/.md/.js/.css/.ini/.cfg`；最多 60 个文件、单文件 2 MiB、解压总量 12 MiB、zip 16 MiB。

## 2. 清单与签名

固定地址（客户端按「设置 → 下载源」排序，另一端留作回落）：

```
CNB    https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/git/raw/main/patches/hotpatch.json
GitHub https://raw.githubusercontent.com/qdTXTbp/FuFumidi/main/patches/hotpatch.json
       （另有 ghfast.top 加速前缀）
```

`hotpatch.json` 形如：

```json
{
  "format": "fufumidi-hotpatch/v1",
  "id": "2026-11-11-01",
  "notes": "修 lead-in 边界对齐",
  "target": { "min": "6.4.0", "max": "6.4.99" },
  "package": { "name": "hotpatch-2026-11-11-01.zip", "size": 12345, "sha256": "..." },
  "files": [
    { "path": "resources/app.asar.unpacked/engine/audio_io.py", "size": 1234, "sha256": "..." }
  ],
  "sig": "<Ed25519 base64>"
}
```

- 签名规范串见 `main/hotpatch_manifest.js` 的 `canonical()`：id / notes / 版本范围 / 包名+大小+哈希 / 按路径排序的逐文件哈希。
- 公钥内嵌在 `main/update_sign.js`（与整包 `update-manifest.json` 同一把）；私钥在构建机 `E:\ed25519-private.pem`。
- 客户端校验顺序：清单格式 → 版本范围 → 路径白名单 → 体积 → **Ed25519 验签** → zip 的 sha256 → 逐文件 size/sha256 → 清单外条目数。任何一步失败都不写文件。
- 仓库还没有 `patches/` 时（所有源 404）视为「暂无补丁」的正常状态，不记错误。

## 3. 发布一个补丁

```bash
node scripts/build-hotpatch.mjs \
  --id 2026-11-11-01 \
  --files engine/audio_io.py,engine/engine_muscriptor.py \
  --notes "修边界对齐修正的落盘路径" \
  --min 6.4.0 --max 6.4.99 \
  --key E:/ed25519-private.pem \
  --out release/hotpatch
```

源文件会自动映射：`engine/x.py` → `resources/app.asar.unpacked/engine/x.py`；
不确定时用 `--map "目标相对路径=源路径"` 显式指定（可重复）。

产物 `hotpatch.json`、`hotpatch-<id>.zip`、`README.txt` 一起 push 到两个仓库的 `main` 分支 `patches/` 目录。
**不需要 tag、不需要 release、不需要改 package.json 版本号。** 两个仓库内容保持一致即可，客户端会多源回退。

改了新文件就重新生成、改一个新的 `id`（递增即可）。`id` 是幂等键：相同 id 且目标文件哈希一致时不会重复写盘。

## 4. 客户端流程

1. 打包版启动 9 秒后（`FUFUMIDI_NO_HOTPATCH=1` 或开发版不启用）延迟自动检查，不阻塞启动。
2. 多源拉 `hotpatch.json` → 校验 → 若需要则下载 zip（复用 `fast-download.js`），缓存在 `<dataRoot>/hotpatch/cache/`。
3. 备份现有目标文件到 `<dataRoot>/hotpatch/backup/<id>/`（`FuFumidiData` 受 `ignoreFolderPath` 保护）。
4. 逐文件 `tmp + rename` 原子替换；中途失败把已改文件全部还原。
5. 状态写到 `<dataRoot>/hotpatch/state.json`。
6. 每次启动都会重新比对目标文件哈希：**完整版本更新把 `app.asar.unpacked` 整体换掉后，会自动从本地缓存重放补丁**，无需重新下载、也无需重新发布。

设置 → 更新页有「热补丁」区块：显示已应用 id、上次检查、错误，以及「检查补丁」「回滚补丁」按钮。

## 5. 撤回与回滚

- **用户侧**：设置页「回滚补丁」把最近一个补丁的备份写回（补丁新增的文件会删除）。
- **发布侧**：把 `patches/hotpatch.json` 换成上一个 id 的清单即可停止分发新补丁；已应用的用户不会自动撤销（需要用户在界面回滚），所以修出问题时优先发一个新的 `id` 覆盖，而不是撤回。
- 若安装目录不可写（装在 `Program Files` 等），`applyToDisk` 会失败并回滚，状态里记错误；补丁不会生效但应用照常运行。当前 NSIS 是用户级安装（`perMachine: false`），通常可写。

## 6. 已知边界

- 补丁**不会改变应用版本号**，也不会写进 `latest.yml`；它只是把几个文件覆盖到已安装的版本上。
- 补丁不能新增 `import` 一个原本不存在的模块文件之外的依赖；改了接口要同步考虑目标版本范围。
- Python 引擎有常驻 worker（`engine_server.py`）：补丁在启动 9 秒后应用，若此时已有转录任务在跑，已加载的模块不会热更新，**重启应用后生效**。界面文案与日志建议注明。
- 完整更新后重放依赖 `<dataRoot>/hotpatch/` 未被清理；数据目录被用户手动清空时补丁会重新下载一次。
- 补丁文件不参与 asar integrity（它们本来就在 asar 外），但也不覆盖 `app.asar`，因此不影响 exe 内嵌完整性资源。

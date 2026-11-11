# patches/

热补丁分发目录（**不是**完整更新资产）。

- `hotpatch.json`：Ed25519 签名的补丁清单（客户端唯一入口）。
- `hotpatch-<id>.zip`：补丁包，只含清单里列出的文件。

发布方法（不建 release、不改版本号）：

```bash
node scripts/build-hotpatch.mjs --id YYYY-MM-DD-NN \
  --files engine/xxx.py --notes "改了什么" --min 6.5.0 --max 6.5.99 \
  --key E:/ed25519-private.pem --out release/hotpatch
```

把产物里的 `hotpatch.json` 与 zip 提交到本目录，**两个远端（cnb / origin）的 `master` 分支都要推**。
客户端启动 9 秒后自动拉取、验签、校验并应用；设置 → 更新页可查看与回滚。

完整规范见 [`../docs/HOTPATCH.md`](../docs/HOTPATCH.md)；完整发版见 [`../docs/RELEASE.md`](../docs/RELEASE.md)。

> 目录为空或没有 `hotpatch.json` 时，客户端判定为「暂无可用热补丁」，属正常状态。

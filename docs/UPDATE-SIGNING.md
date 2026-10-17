# 更新包签名与验签（P1-8）

> 目标：更新器下载完安装包后先验 Ed25519 签名，验签失败直接删除安装包并拒绝更新。
> 用到两个文件：构建机上的私钥（不入库）与应用内嵌的公钥（`main/update_sign.js`）。

## 签名对象

规范串（换行分隔，签名对象就是它，不是文件本身）：

```
fufumidi-update/v1
<version>
<fileName>
<sha256(安装包)>
```

`fileName` 必须等于更新器实际下载的资产名：kachina 更新器下载的是 **`FuFumidi.Install.exe`**，
所以签名时固定传 `--name FuFumidi.Install.exe`（beta 通道同名覆盖上传）。

## 发布流程（在 build 之后、上传之前）

```powershell
# 1) 签名（私钥默认 E:\Midi\_attic\update-signing\ed25519-private.pem，可用 --key / FUFUMIDI_UPDATE_KEY 指定）
node scripts/sign-update.mjs `
  --exe "release/update/FuFumidi.Install.6.0.0.exe" `
  --version 6.0.0 --name FuFumidi.Install.exe `
  --out release/update-manifest.json

# 2) 归档（archive-release 会把 update-manifest.json 一起复制并进 SHA256SUMS）
node scripts/archive-release.mjs 6.0.0

# 3) 上传：把 update-manifest.json 与安装包一起传（stable → latest；beta → beta tag）
node scripts/fast-upload.mjs --channel gh ... --asset "release/update-manifest.json=update-manifest.json"
```

## 验签（应用内，自动）

`main/update.js` 下载安装包后：

1. 依次从 CNB latest/beta、GitHub latest/beta 及其镜像取 `update-manifest.json`（第一个成功且格式正确的为准）；
2. 校验文件大小 + sha256；
3. 用内嵌公钥验 Ed25519 签名；
4. 失败 → 删除安装包，返回「安装包签名校验失败」；成功 → 才允许启动更新器。

兼容策略：Release 没有 `update-manifest.json`（6.0.0 之前的旧版本）时跳过并打警告，
否则老用户会觉得"更新永远失败"。从 6.0.0 起每次发版都必须带清单。

## 密钥管理

- 私钥：`E:\Midi\_attic\update-signing\ed25519-private.pem`（构建机本地；**绝不入库**，备份丢失则无法再签同一版本，但可以轮换）。
- 公钥：`main/update_sign.js` 里的 `UPDATE_PUBKEY`（SPKI DER base64）。
- 轮换：生成新密钥对 → 更新内嵌公钥 → 发版一次（老版本只认老公钥，所以旧版用户升级到新版后才会用新公钥）。
- 测试：`npm run test:update-sign`（临时密钥对全路径：正常/篡改/错 key/坏清单）。

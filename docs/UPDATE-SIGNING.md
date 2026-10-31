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

---

# 附：Windows 代码签名（Authenticode）

> 这是**两层签名**里的另一层，别和上面的 Ed25519 混了：
> Ed25519 是「应用自己验更新包」的防篡改；Authenticode 是「Windows / SmartScreen 认发布者」。

## 需要什么

- 一张代码签名证书（`.pfx` + 密码，或云签名 / 硬件 token 的签名命令）。
- `signtool.exe`（Windows SDK 自带；electron-builder 的缓存里也有一份）。

## 两条路

**A. 交给 electron-builder 签（不推荐）**

```bash
CSC_LINK=/path/cert.pfx CSC_KEY_PASSWORD=*** npx electron-builder --win nsis --x64
```

它会给包里**每一个 exe** 调一次 signtool —— 本项目的 `resources/python` 里有 100+ 个 exe，
本机实测是**小时级**（这也是 `electron-builder.local-dir.yml` 当年把 python 挪出打包流程的原因）。

**B. 只签关键文件（推荐，几秒钟）**

```bat
:: 1) 先出目录（不压缩、不签名）
npx electron-builder --win --dir -c.directories.output=release-6.4.3 -c.electronDist=D:/FuFuMIDI/_electron-dist

:: 2) 签主程序 + 增量更新器（这两处才是用户双击 / 信任的对象）
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f cert.pfx /p *** ^
  "release-6.4.3\win-unpacked\FuFumidi.exe" "release-6.4.3\win-unpacked\FuFumidi.update.exe"

:: 3) 用**已签名**的目录打安装包（--prepackaged 复用该目录，不再重新拷贝 / 覆盖）
npx electron-builder --win nsis --x64 --prepackaged "release-6.4.3\win-unpacked" -c.directories.output=release-6.4.3

:: 4) 签安装包本身
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f cert.pfx /p *** ^
  "release-6.4.3\FuFumidi Setup 6.4.3.exe"
```

要点：

- **第 2 步必须在第 3 步之前**：安装包是从 `win-unpacked` 里取的，先打后签会得到
  「安装包里装着未签名主程序」。
- 第 4 步之后**不要再改任何字节**：`update-manifest.json` 的 Ed25519 签名对象包含安装包的
  sha256，所以顺序是「签 Authenticode → 再 `node scripts/sign-update.mjs` → 上传」。
- 时间戳（`/tr`）务必带：证书过期后旧安装包仍能验证。

## 校验

```bat
:: Status 期望 Valid；signtool verify 退出码 0
powershell -NoProfile -Command "Get-AuthenticodeSignature 'release-6.4.3\FuFumidi Setup 6.4.3.exe' | Format-List Status,SignerCertificate"
signtool verify /pa /v "release-6.4.3\FuFumidi Setup 6.4.3.exe"
```

## 与打包流程的两个已知坑（2026-10-31 实测）

- 语言包裁剪会被环境守卫拦：electron-builder 要一次删掉 51 个 `locales/*.pak`，触发
  「单轮 ≥50 项删除需确认」。用 `node scripts/prepare-electron-dist.mjs --out <dir>` 生成一份
  **只保留 4 种语言**的 dist，再 `-c.electronDist=<dir>` 指过去（复制时跳过，不删任何文件）。
- `electron-builder.yml` 的 `electronVersion` 必须跟 `package.json` 的 devDependency 同步。
  6.4 升级到 37 时只改了 `package.json` 与 lock，忘了 yml，结果打出来的是 33 的二进制。


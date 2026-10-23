#!/usr/bin/env node
// P1-8：给安装包生成 update-manifest.json（Ed25519 签名，私钥不入库）
// 用法：
//   node scripts/sign-update.mjs --exe "release/update/FuFumidi.Install.6.0.0.exe" --version 6.0.0 --name FuFumidi.Install.exe
//   node scripts/sign-update.mjs --exe ... --version ... --key E:\path\private.pem --out release/update-manifest.json
// 私钥默认路径：E:\Midi\_attic\update-signing\ed25519-private.pem；也可用环境变量 FUFUMIDI_UPDATE_KEY。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { signManifest } = require('../main/update_sign.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const exe = arg('exe') || '';
const version = arg('version') || '';
const out = arg('out') || 'release/update-manifest.json';
// 清单里的 file 必须与"更新器实际下载的资产名"一致（kachina 下载的是 FuFumidi.Install.exe）
const assetName = arg('name') || 'FuFumidi.Install.exe';
const keyPath = process.env.FUFUMIDI_UPDATE_KEY || arg('key') || 'E:/Midi/_attic/update-signing/ed25519-private.pem';
if (!exe || !version) {
  console.error('用法：node scripts/sign-update.mjs --exe <安装包> --version <x.y.z> [--name FuFumidi.Install.exe] [--out release/update-manifest.json] [--key <私钥>]');
  process.exit(2);
}
const absExe = path.isAbsolute(exe) ? exe : path.join(ROOT, exe);
if (!fs.existsSync(absExe)) { console.error('安装包不存在：' + absExe); process.exit(2); }
if (!fs.existsSync(keyPath)) { console.error('私钥不存在：' + keyPath + '\n（构建机路径见 docs/UPDATE-SIGNING.md；可用 --key 或 FUFUMIDI_UPDATE_KEY 指定）'); process.exit(2); }
const pem = fs.readFileSync(keyPath, 'utf8');
const manifest = await signManifest({ filePath: absExe, version, fileName: assetName, privateKeyPem: pem });
const outAbs = path.isAbsolute(out) ? out : path.join(ROOT, out);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
fs.writeFileSync(outAbs, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('已签名：' + path.relative(ROOT, absExe) + ' → ' + path.relative(ROOT, outAbs)
  + '\n  version=' + manifest.version + ' size=' + manifest.size + ' sha256=' + manifest.sha256);

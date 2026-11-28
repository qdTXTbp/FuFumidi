#!/usr/bin/env node
// ============================================================
// 组装发布目录：把 release/ 与 release/update/ 的产物收进
// release/publish-<ver>/，供两个 publish-*.js 上传。
//
// 用法：
//   node scripts/assemble-publish.mjs --version 6.7.3
//   node scripts/assemble-publish.mjs --version 6.7.3 --skip-zip   （复用已有 zip）
//
// 产物（9 项，与两端发布脚本的 FILES 清单一致）：
//   FuFumidi-Setup-<ver>.exe / .exe.blockmap
//   FuFumidi.Install.exe / FuFumidi.Install.<ver>.exe
//   FuFumidi.update.exe / metadata-<ver>.json / latest.yml
//   FuFumidi-<ver>-release-notes.md / update-manifest.json
//   FuFumidi-<ver>-win-x64-unpacked.zip
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = '') => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const ver = (arg('version') || '').trim();
if (!/^\d+\.\d+\.\d+/.test(ver)) { console.error('用法: node scripts/assemble-publish.mjs --version 6.7.3'); process.exit(2); }

const rel = path.join(ROOT, 'release');
const upd = path.join(rel, 'update');
const out = path.join(rel, 'publish-' + ver);
const key = process.env.FUFUMIDI_UPDATE_KEY || 'E:/ed25519-private.pem';
fs.mkdirSync(out, { recursive: true });

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function copy(from, to) {
  if (!fs.existsSync(from)) throw new Error('缺少产物：' + from);
  const dst = path.join(out, to);
  fs.copyFileSync(from, dst);
  const st = fs.statSync(dst);
  console.log(('  ' + to).padEnd(48) + (st.size / 1048576).toFixed(1) + ' MB');
  return { name: to, size: st.size, sha: sha256(dst) };
}

// 1) 安装包（electron-builder 默认文件名带空格）
const setupName = 'FuFumidi Setup ' + ver + '.exe';
const rows = [];
rows.push(copy(path.join(rel, setupName), 'FuFumidi-Setup-' + ver + '.exe'));
rows.push(copy(path.join(rel, setupName + '.blockmap'), 'FuFumidi-Setup-' + ver + '.exe.blockmap'));

// 2) 更新器 / 离线安装包 / 元数据
rows.push(copy(path.join(upd, 'FuFumidi.Install.' + ver + '.exe'), 'FuFumidi.Install.' + ver + '.exe'));
rows.push(copy(path.join(upd, 'FuFumidi.Install.' + ver + '.exe'), 'FuFumidi.Install.exe'));
rows.push(copy(path.join(upd, 'FuFumidi.update.exe'), 'FuFumidi.update.exe'));
rows.push(copy(path.join(upd, 'metadata-' + ver + '.json'), 'metadata-' + ver + '.json'));
rows.push(copy(path.join(rel, 'latest.yml'), 'latest.yml'));

// 3) 更新说明
rows.push(copy(path.join(ROOT, 'scripts', 'release-notes-v' + ver + '.md'), 'FuFumidi-' + ver + '-release-notes.md'));

// 4) 更新清单签名（必须重签：build-release.ps1 不会做这一步）
console.log('\n[签名] update-manifest.json');
execFileSync(process.execPath, [
  path.join(ROOT, 'scripts', 'sign-update.mjs'),
  '--exe', path.join(upd, 'FuFumidi.Install.' + ver + '.exe'),
  '--version', ver, '--name', 'FuFumidi.Install.exe',
  '--key', key, '--out', path.join(rel, 'update-manifest.json'),
], { stdio: 'inherit' });
rows.push(copy(path.join(rel, 'update-manifest.json'), 'update-manifest.json'));

// 5) unpacked 全量包（离线/绿色版；7z 存储模式，与历史产物同构）
const zipName = 'FuFumidi-' + ver + '-win-x64-unpacked.zip';
const zipPath = path.join(out, zipName);
if (has('skip-zip') && fs.existsSync(zipPath)) {
  console.log('  （复用已有）' + zipName);
} else {
  console.log('\n[压缩] ' + zipName + '（约 5 万个文件，需要几分钟）');
  const sevenZip = 'C:/Program Files/7-Zip/7z.exe';
  if (!fs.existsSync(sevenZip)) throw new Error('找不到 7z：' + sevenZip);
  try { fs.unlinkSync(zipPath); } catch (_) {}
  // -mx=1：安装包内已经是压缩过的二进制，再高压只是白烧 CPU
  execFileSync(sevenZip, ['a', '-tzip', '-mx=1', '-bso0', '-bsp0', zipPath, '.'], {
    cwd: path.join(rel, 'win-unpacked'), stdio: ['ignore', 'ignore', 'inherit'],
  });
}
rows.push({ name: zipName, size: fs.statSync(zipPath).size, sha: sha256(zipPath) });
console.log(('  ' + zipName).padEnd(48) + (rows[rows.length - 1].size / 1048576).toFixed(1) + ' MB');

// 6) 自检：两个 Install 命名必须逐字节一致；manifest 的 sha256 必须与 exe 一致
const a = rows.find((r) => r.name === 'FuFumidi.Install.' + ver + '.exe');
const b = rows.find((r) => r.name === 'FuFumidi.Install.exe');
console.log('\nInstall / Install.' + ver + ' 同一份: ' + (a.sha === b.sha));
if (a.sha !== b.sha) throw new Error('两份 Install 不一致');
const man = JSON.parse(fs.readFileSync(path.join(out, 'update-manifest.json'), 'utf8'));
console.log('manifest 版本/大小/哈希与 exe 一致: ' + (man.version === ver && man.size === a.size && man.sha256 === a.sha));
if (!(man.version === ver && man.size === a.size && man.sha256 === a.sha)) throw new Error('update-manifest 与安装包不一致');

const sums = [
  '# FuFumidi ' + ver + ' —— 发布资产校验（SHA-256）',
  '# 生成时间：' + new Date().toISOString().slice(0, 10) + '  上传前/后都用它核对',
  '# FuFumidi.Install.exe 与 FuFumidi.Install.' + ver + '.exe 是同一份文件的两种命名，哈希相同。',
  ...rows.map((r) => r.sha + '  ' + r.name + '  ' + r.size),
  '',
].join('\n');
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums, 'utf8');
console.log('\n组装完成 → ' + out);

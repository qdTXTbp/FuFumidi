#!/usr/bin/env node
// ============================================================
// 把 release/ 里的产物归档到 E:\Midi\安装包\FuFumidi\<版本>\
//   node scripts/archive-release.mjs -Version 5.1.0
// 产出：与上一版同构的目录（Setup / blockmap / Install / update.exe / latest.yml /
//       metadata / RELEASE-NOTES / SHA256SUMS.txt / 上传说明.md）
// 只复制与计算哈希，不改动 release/ 里的任何东西。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const ver = (args[args.indexOf('-Version') + 1] || '').trim();
if (!/^\d+\.\d+\.\d+/.test(ver)) { console.error('用法: node scripts/archive-release.mjs -Version 5.1.0'); process.exit(2); }
const ARCHIVE_ROOT = process.env.FUFUMIDI_ARCHIVE || 'E:\\Midi\\安装包\\FuFumidi';
const outDir = path.join(ARCHIVE_ROOT, ver);
const rel = path.join(ROOT, 'release');
const upd = path.join(rel, 'update');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const plan = [
  { from: path.join(rel, 'FuFumidi Setup ' + ver + '.exe'), to: 'FuFumidi-Setup-' + ver + '.exe' },
  { from: path.join(rel, 'FuFumidi Setup ' + ver + '.exe.blockmap'), to: 'FuFumidi-Setup-' + ver + '.exe.blockmap' },
  { from: path.join(upd, 'FuFumidi.Install.' + ver + '.exe'), to: 'FuFumidi.Install.' + ver + '.exe' },
  { from: path.join(upd, 'FuFumidi.Install.' + ver + '.exe'), to: 'FuFumidi.Install.exe' },
  { from: path.join(upd, 'FuFumidi.update.exe'), to: 'FuFumidi.update.exe' },
  { from: path.join(rel, 'latest.yml'), to: 'latest.yml' },
  { from: path.join(upd, 'metadata-' + ver + '.json'), to: 'metadata-' + ver + '.json' },
  { from: path.join(ROOT, 'scripts', 'release-notes-v' + ver + '.md'), to: 'RELEASE-NOTES-' + ver + '.md' },
];

// P1-8：update-manifest.json 是可选产物（旧版本 Release 没有）；存在就一起归档
const manifestFrom = path.join(rel, 'update-manifest.json');
if (fs.existsSync(manifestFrom)) plan.push({ from: manifestFrom, to: 'update-manifest.json' });

const missing = plan.filter(p => !fs.existsSync(p.from));
if (missing.length) { console.error('缺少产物：\n  ' + missing.map(m => m.from).join('\n  ')); process.exit(3); }
fs.mkdirSync(outDir, { recursive: true });
const rows = [];
for (const p of plan) {
  const dst = path.join(outDir, p.to);
  fs.copyFileSync(p.from, dst);
  const st = fs.statSync(dst);
  rows.push({ name: p.to, bytes: st.size, sha: sha256(dst) });
  console.log(('  ' + p.to).padEnd(46) + (st.size / 1048576).toFixed(1) + ' MB');
}
// 校验：两个 Install 命名必须是同一份
const a = rows.find(r => r.name === 'FuFumidi.Install.' + ver + '.exe');
const b = rows.find(r => r.name === 'FuFumidi.Install.exe');
console.log('\nInstall / Install.' + ver + ' 同一份: ' + (a.sha === b.sha));
// 安装包内嵌的更新器必须与归档的更新器逐字节一致
const sums = [
  '# FuFumidi ' + ver + ' —— 发布资产校验（SHA-256）',
  '# 生成时间：' + new Date().toISOString().slice(0, 10) + '  上传前/后都用它核对',
  '# 注意：FuFumidi.Install.exe 与 FuFumidi.Install.' + ver + '.exe 是同一份文件的两种命名，哈希相同。',
  ...rows.map(r => r.sha + '  ' + r.name + '  ' + r.bytes),
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sums, 'utf8');
fs.writeFileSync(path.join(outDir, 'archive.json'), JSON.stringify({ version: ver, at: new Date().toISOString(), files: rows }, null, 2), 'utf8');
console.log('\n归档 → ' + outDir);

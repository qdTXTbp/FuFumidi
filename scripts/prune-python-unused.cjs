#!/usr/bin/env node
/**
 * 裁剪内置 Python 运行时里**引擎从不导入**的顶层包（2026-10-29 审计 §2.3 实测）。
 * 只移动、不删除：备份到 E:/Midi/_attic/python-site-backup/<name>，可手工移回。
 * 默认只处理明确不在默认转录链路上的包；每个包都有审计依据。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.FUFUMIDI_PY || path.join(__dirname, '..', 'resources', 'python');
const SITE = path.join(ROOT, 'Lib', 'site-packages');
const BACKUP = 'E:/Midi/_attic/python-site-backup';
const DRY = process.argv.includes('--dry-run');
const PACKAGES = ['matplotlib', 'pandas', 'sklearn', 'sympy', 'tensorboard', 'grpc', 'networkx', 'seaborn', 'narwhals', 'pygments'];
if (!fs.existsSync(SITE)) { console.error('site-packages 不存在: ' + SITE); process.exit(1); }
fs.mkdirSync(BACKUP, { recursive: true });
let moved = 0, bytes = 0;
for (const name of PACKAGES) {
  const src = path.join(SITE, name);
  if (!fs.existsSync(src)) continue;
  let size = 0;
  try { for (const e of fs.readdirSync(src, { withFileTypes: true, recursive: true })) { if (e.isFile()) { try { size += fs.statSync(path.join(e.parentPath || src, e.name)).size; } catch (err) {} } } } catch (err) {}
  if (DRY) { console.log(name, Math.round(size / 1048576) + ' MB'); continue; }
  const dst = path.join(BACKUP, name);
  try {
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
    moved += size;
    console.log('moved ' + name + '  ' + Math.round(size / 1048576) + ' MB');
  } catch (err) { console.error('skip ' + name + ': ' + err.message); }
}
console.log('合计移出 ' + Math.round(moved / 1048576) + ' MB；备份 ' + BACKUP);

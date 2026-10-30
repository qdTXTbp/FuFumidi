#!/usr/bin/env node
/** 空 catch 门禁：统计 main/ preload 里的 catch (...) {}，超过基线就失败。 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASELINE = Number(process.env.EMPTY_CATCH_BASELINE || 0);
const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git', 'dist', 'release'].includes(e.name)) walk(p); }
    else if (e.isFile() && p.endsWith('.js') && (p.includes(path.sep + 'main' + path.sep) || p.endsWith('preload.js'))) files.push(p);
  }
}
walk(path.join(ROOT, 'main'));
for (const f of ['preload.js']) { const p = path.join(ROOT, f); if (fs.existsSync(p)) files.push(p); }
let n = 0;
const samples = [];
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /catch\s*\([^)]*\)\s*\{\s*\}/g;
  let m;
  while ((m = re.exec(s))) {
    n++;
    if (samples.length < 8) samples.push(path.relative(ROOT, f) + ':' + (s.slice(0, m.index).split('\n').length));
  }
}
console.log('空 catch: ' + n + ' / 基线 ' + BASELINE);
if (n > BASELINE) { console.error('新增空 catch，请补日志或注释：\n' + samples.join('\n')); process.exit(1); }

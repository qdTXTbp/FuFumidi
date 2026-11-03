#!/usr/bin/env node
/** 空 catch 门禁：统计 main/ preload 里的 catch (...) {}，超过基线就失败。 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
// 存量棘轮：基线来自 scripts/empty-catch-baseline.json（只允许下降）。
// 历史上这个门禁用 EMPTY_CATCH_BASELINE 环境变量、默认 0，但分支上已有 9 个存量空 catch，
// 导致门禁在 HEAD 必红 —— 一个红着的门禁等于没有门禁（见 docs/FOUNDATION.md §7）。
// 现在：文件基线 + --update-baseline 显式重记；环境变量仍可临时覆盖。
const BASELINE_FILE = path.join(__dirname, 'empty-catch-baseline.json');
let fileBaseline = 0;
try { fileBaseline = Number(JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).count) || 0; } catch (e) { fileBaseline = 0; }
const envBaseline = process.env.EMPTY_CATCH_BASELINE;
const BASELINE = envBaseline != null ? Number(envBaseline) : fileBaseline;
const UPDATE = process.argv.includes('--update-baseline');
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
if (UPDATE) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({ count: n, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  console.log('空 catch 基线已更新: ' + n);
  process.exit(0);
}
console.log('空 catch: ' + n + ' / 基线 ' + BASELINE);
if (n > BASELINE) { console.error('新增空 catch，请补日志或注释：\n' + samples.join('\n')); process.exit(1); }

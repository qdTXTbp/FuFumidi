#!/usr/bin/env node
// P0-8 i18n 欠账批量补翻译：把 {en:{zh:en},ja:{zh:ja}} 批量插入两个词典（不覆盖已有键）。
// 用法：node scripts/i18n-apply-batch.mjs path/to/batch.json
// 之后跑：node scripts/check-i18n-coverage.mjs --update-baseline
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const file = process.argv[2];
if (!file) { console.error('用法: node scripts/i18n-apply-batch.mjs <batch.json>'); process.exit(2); }
const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
const targets = [
  { key: 'en', file: path.join(ROOT, 'frontend/src/core/i18n.js'), head: 'export const I18N_MAP = {' },
  { key: 'ja', file: path.join(ROOT, 'frontend/src/core/i18n_ja.js'), head: 'export const I18N_JA = {' },
];
function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n');
}
function existingKeys(text) {
  const set = new Set();
  for (const m of text.matchAll(/^\s*'((?:\\.|[^'\\])*)'\s*:/gm)) set.add(m[1].replace(/\\'/g, "'"));
  return set;
}
let total = 0;
for (const t of targets) {
  const map = batch[t.key] || {};
  const text = fs.readFileSync(t.file, 'utf8');
  const have = existingKeys(text);
  const lines = [];
  for (const [zh, tr] of Object.entries(map)) {
    if (!zh || !tr || have.has(zh)) continue;
    lines.push("  '" + esc(zh) + "': '" + esc(tr) + "',");
  }
  if (!lines.length) { console.log(t.key + ': 无新增（已存在或为空）'); continue; }
  const at = text.lastIndexOf('\n};');
  if (at < 0) { console.error(t.key + ': 找不到词典结尾 };'); process.exit(1); }
  const next = text.slice(0, at) + '\n' + lines.join('\n') + text.slice(at);
  fs.writeFileSync(t.file, next, 'utf8');
  console.log(t.key + ': +' + lines.length + ' 条');
  total += lines.length;
}
console.log('共写入 ' + total + ' 条');

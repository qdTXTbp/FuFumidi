#!/usr/bin/env node
// ============================================================
// 作业参数审计：渲染端每个 `bridge.X({...})` / `const cfg = {...}` 里的键，
// 必须能在主进程里找到（说明有人接）。找不到 = 界面设了也到不了引擎。
//
// 与 audit-param-contract.cjs 的分工：
//   · param-contract 只盯**转录**那条链（四跳逐跳验）；
//   · 这个脚本扫**全部作业**（分离 / 翻唱 / 调教 / OMR / 乐谱…），只验「主进程有没有接」，
//     属于广而浅的兜底网 —— 转录那条已经由前一个脚本逐跳钉死。
// 用法：node scripts/audit-job-params.cjs [--strict]
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(ts|js|vue)$/.test(e.name)) out.push(p);
  }
  return out;
}

/* 主进程可读的全部文本（谁接了这个键） */
let MAIN = '';
for (const d of ['main', 'scripts']) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (/\.(js|ts|mjs|cjs)$/.test(f) && !f.startsWith('audit-')) MAIN += fs.readFileSync(path.join(dir, f), 'utf8') + '\n';
  }
}
MAIN += fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
// ★ 根目录的 main.js 也是主进程（托盘 / 窗口 / 生命周期都在那）—— 第一版漏了它，
//   于是把 close_to_tray 误报成「没人接」。
MAIN += fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

/* 常见键不参与判断：它们是渲染端自用/通用字段，不指望主进程按名字认 */
const IGNORE = new Set(['id', 'audio', 'out', 'name', 'duration', 'mode', 'perf', 'ok', 'items', 'path', 'file', 'files', 'text', 'type', 'kind', 'value']);

const findings = [];
for (const f of walk(path.join(ROOT, 'frontend', 'src'))) {
  const src = fs.readFileSync(f, 'utf8');
  // 抓 `const cfg = { ... }`、`bridge.X({ ... })`、`{ ... }` 作为调用实参的三种常见形态
  const blocks = [];
  // 内联形态：bridge.X({ ... })
  for (const m of src.matchAll(/bridge\.[A-Za-z0-9_]+\(\{([^}]*)\}/g)) blocks.push(m[1]);
  // 具名形态：const cfg = { ... } —— 只认后面真的交给 bridge.X(cfg) 的那些，
  // 否则会把 WebCodecs 的 VideoEncoder.configure 配置之类也当成 IPC 参数（实测误报过）。
  for (const m of src.matchAll(/const (cfg[0-9A-Za-z_]*) = \{([^}]*)\}/g)) {
    const name = m[1];
    if (new RegExp('bridge\\.[A-Za-z0-9_]+\\(\\s*' + name + '\\b').test(src)) blocks.push(m[2]);
  }
  for (const b of blocks) {
    for (const kv of b.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
      const k = kv[1];
      if (IGNORE.has(k)) continue;
      if (MAIN.includes(k)) continue;
      findings.push({ file: path.relative(ROOT, f), key: k });
    }
  }
}

const uniq = new Map();
for (const f of findings) uniq.set(f.file + '|' + f.key, f);
const list = [...uniq.values()];
if (!list.length) {
  console.log('每个作业参数都能在主进程里找到接线。');
} else {
  console.log('候选（渲染端发了、但主进程里没出现过这个键）：');
  for (const f of list) console.log('  ' + f.file + '  →  ' + f.key);
  console.log('');
  console.log('共 ' + list.length + ' 个候选 —— 逐个确认是「主进程用别的方式接的」还是真漏了。');
  if (process.argv.includes('--strict')) process.exit(1);
}
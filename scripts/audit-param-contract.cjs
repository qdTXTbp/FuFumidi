#!/usr/bin/env node
// ============================================================
// 参数契约审计：界面能设的参数，必须真的走完「三跳」到引擎。
//
// 为什么要有这个脚本：转录参数从渲染端到引擎要过四道关 ——
//   ① 前端 collectParams() 组装请求体
//   ② main/engine.js 的 map / 布尔表（常驻 worker 路径）
//   ③ main/task-queue.js 的 map / 布尔表（回退到命令行的路径）
//   ④ engine/music2midi.py：worker 的 Namespace + _resolve_params 进 params
// 任何一跳漏一个键，界面设了也**静默无效** —— 实测踩过两次：
//   · muscriptor_instruments（乐器组约束）漏在 engine.js 的表里，选「人声」完全没效果；
//   · denoise_mode（降噪档位）2026-10-15 首次接入时同样漏了三跳。
// 用法：node scripts/audit-param-contract.cjs [--strict]
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------- ① 前端 collectParams：对象字面量 + 后续 cfg.X = 赋值 ---------- */
function frontendKeys() {
  const src = read('frontend/src/views/ViewTranscribe.vue');
  const i = src.indexOf('function collectParams()');
  if (i < 0) throw new Error('找不到 collectParams()');
  // 到下一个顶层 function 为止
  const rest = src.slice(i);
  const end = rest.indexOf('\nfunction ', 10);
  const body = end > 0 ? rest.slice(0, end) : rest;
  const keys = new Set();
  const lit = body.match(/const cfg = \{([\s\S]*?)\n  \};/);
  if (lit) for (const m of lit[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)) keys.add(m[1]);
  for (const m of body.matchAll(/cfg\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) keys.add(m[1]);
  for (const m of body.matchAll(/Object\.assign\(cfg,\s*\{([\s\S]*?)\}\)/g)) {
    for (const k of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.add(k[1]);
  }
  return [...keys].sort();
}

/* ---------- ② / ③ 主进程两跳：map 对象 + 布尔数组 ---------- */
function mainKeys(file) {
  const src = read(file);
  const keys = new Set();
  // 形如  const map = { a:'a', b:'--b' };  （可能一行也可能多行）
  for (const m of src.matchAll(/const map = \{([\s\S]*?)\};/g)) {
    for (const kv of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.add(kv[1]);
  }
  // 形如  for (const [k, flag] of Object.entries({ a:'--a', ... }))
  for (const m of src.matchAll(/Object\.entries\(\{([\s\S]*?)\}\s*\)/g)) {
    for (const kv of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.add(kv[1]);
  }
  // 形如  for (const k of ['a','b',...])
  for (const m of src.matchAll(/for \(const k of \[([^\]]*)\]\)/g)) {
    for (const s of m[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)) keys.add(s[1]);
  }
  return keys;
}

/* ---------- ④ 引擎两处：worker Namespace 字段 + _resolve_params 落盘 ---------- */
function engineKeys() {
  const src = read('engine/music2midi.py');
  const ns = new Set();
  const m = src.match(/ns = _ap\.Namespace\(([\s\S]*?)\n\s*\)/);
  if (m) {
    for (const kv of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) ns.add(kv[1]);
    // 还认「请求体键名」：有些字段在 Namespace 里换了名字（min_freq → minimum_frequency），
    // 这时判据要落在 req.get('min_freq') 上，否则审计会误报。
    for (const rq of m[1].matchAll(/req\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) ns.add(rq[1]);
  }
  const res = new Set();
  const r = src.indexOf('def _resolve_params');
  const rb = src.slice(r, src.indexOf('\ndef ', r + 10));
  for (const kv of rb.matchAll(/p\["([A-Za-z_][A-Za-z0-9_]*)"\]\s*=/g)) res.add(kv[1]);
  for (const kv of rb.matchAll(/p\['([A-Za-z_][A-Za-z0-9_]*)'\]\s*=/g)) res.add(kv[1]);
  return { ns, res };
}

/* ---------- 引擎是否真的认这个键 ----------
 * 判据故意放宽：引擎里只要**出现过这个字符串字面量**就算认（params.get('x') / p["x"] /
 * args.x / req.get('x') 都算）。因为界面键与引擎键存在**改名**（min_note_length →
 * minimum_note_length / no_merge → merge_overlap 等），逐个建模改名会变成一张永远追不上的表。
 * 这个脚本的目的是「抓漏掉的键」，不是「证明语义正确」——真正的语义由引擎测试与装机实测保证。
 */
const ALIASES = {
  min_note_length: ['minimum_note_length'],
  no_merge: ['merge_overlap'],
  no_velnorm: ['normalize_vel'],
  no_pedal: ['include_pedal'],
  no_melodia: ['melodia_trick'],
  with_drums: ['include_drums'],
  export_stems: ['export_stems'],
  tempo: ['midi_tempo'],
  sep_model: ['sep_model', 'separate_model'],
  min_freq: ['min_freq', 'minimum_frequency'],
  max_freq: ['max_freq', 'maximum_frequency'],
};

// 这些键不属于「转录请求」而是别的作业（分离/翻唱），collectParams 的扫描窗口会顺手带进来 —— 明确排除，
// 否则审计报告里永远挂着几条"看起来是洞、其实是别的功能"的噪声。
const NOT_TRANSCRIBE_REQ = new Set(['sep_model']);

function engineConsumers() {
  const dir = path.join(ROOT, 'engine');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.py'));
  const hit = new Map();
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
      const k = m[1];
      if (!hit.has(k)) hit.set(k, new Set());
      hit.get(k).add(f);
    }
  }
  return hit;
}

function isConsumed(consumers, key) {
  const names = [key].concat(ALIASES[key] || []);
  for (const n of names) {
    const files = consumers.get(n);
    if (files && files.size) return [...files];
  }
  return [];
}

function main() {
  const strict = process.argv.includes('--strict');
  const fe = frontendKeys();
  const worker = mainKeys('main/engine.js');
  const spawn = mainKeys('main/task-queue.js');
  const eng = engineKeys();
  const consumers = engineConsumers();
  const rows = [];
  for (const k of fe) {
    if (NOT_TRANSCRIBE_REQ.has(k)) continue;
    const inWorker = worker.has(k);
    const inSpawn = spawn.has(k);
    const inNs = eng.ns.has(k);
    const inRes = eng.res.has(k);
    const consumed = isConsumed(consumers, k);
    // 判定只看三件事：主进程那跳收了、worker 的 Namespace 收了、引擎里出现过这个键。
    // resolve 一列只作参考（_resolve_params 有改名/条件赋值，正则追不全）。
    const ok = inWorker && inNs && consumed.length > 0;
    rows.push({ k, inWorker, inSpawn, inNs, inRes, consumed, ok: !!ok });
  }
  const w = (s, n) => String(s).padEnd(n);
  console.log(w('参数', 26) + w('engine.js', 10) + w('Namespace', 10) + w('resolve', 9) + w('引擎认', 24) + '判定');
  let bad = 0;
  for (const r of rows) {
    if (!r.ok) bad++;
    const who = r.consumed.length ? (r.consumed[0] + (r.consumed.length > 1 ? ' 等' + r.consumed.length + '处' : '')) : '-';
    console.log(w(r.k, 26) + w(r.inWorker ? 'OK' : '缺', 10) + w(r.inNs ? 'OK' : '缺', 10) + w(r.inRes ? 'OK' : '参考缺', 9) + w(who, 24) + (r.ok ? (r.inSpawn ? 'OK' : 'OK（仅 worker）') : '✗ 到不了引擎'));
  }
  console.log('');
  console.log('共 ' + rows.length + ' 个界面参数，' + bad + ' 个走不完三跳。');
  if (bad && strict) process.exit(1);
}

main();
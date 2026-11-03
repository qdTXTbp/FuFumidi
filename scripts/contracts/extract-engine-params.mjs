#!/usr/bin/env node
// ============================================================
// 引擎参数契约提取 / 校验（M0 / S-002）
// ============================================================
// 背景（审计 §5.4）：同一个「界面参数 → 引擎参数」映射被写了三遍
//   engine/music2midi.py（argparse + worker Namespace）
//   main/engine.js（worker 请求 map）
//   main/task-queue.js（spawn 回退路径的 --flag 表）
// 已漂移 6 次。本脚本把三处抽成一份机器可读 schema，并在 --check 时做
// 「dest 覆盖 / worker key 覆盖 / flag 覆盖」三类差集；不改变运行时行为。
//
// 用法：
//   node scripts/contracts/extract-engine-params.mjs          # 打印摘要
//   node scripts/contracts/extract-engine-params.mjs --write  # 写 docs/contracts/engine-params.schema.json
//   node scripts/contracts/extract-engine-params.mjs --check  # 与入库文件对比 + 三处覆盖检查
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'docs', 'contracts', 'engine-params.schema.json');
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const CHECK = argv.includes('--check');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function unquote(s) { return String(s).replace(/^['"]|['"]$/g, ''); }

/** 扫出所有 add_argument( ... ) 调用（按括号深度截断，忽略字符串里的括号）。 */
function scanAddArguments(src) {
  const out = [];
  const re = /(?:[A-Za-z_][\w.]*)\.add_argument\(/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let depth = 1, i = start, quote = null;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i += 2;
        else { if (ch === quote) quote = null; i += 1; }
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const body = src.slice(start, i - 1);
    out.push(parseArg(body));
  }
  return out;
}
function parseArg(body) {
  const flags = [];
  const fre = /([\"'])(-{1,2}[A-Za-z0-9][\w-]*)\1/g;
  let fm;
  while ((fm = fre.exec(body))) flags.push(fm[2]);
  const field = (name) => {
    const r = new RegExp(name + '\\s*=\\s*([^,]+)');
    const mm = body.match(r);
    return mm ? mm[1].trim() : null;
  };
  const destRaw = field('dest');
  // 位置参数（没有 --flag）用第一个字符串字面量作 dest（例：add_argument("input", nargs="?")）
  const posMatch = body.match(/^\s*([\"'])([A-Za-z_][\w-]*)\1/);
  const dest = destRaw ? unquote(destRaw) : (flags.filter((f) => f.startsWith('--')).map((f) => f.replace(/^--/, '').replace(/-/g, '_'))[0] || (posMatch ? posMatch[2].replace(/-/g, '_') : (flags[0] || '').replace(/^-+/, '').replace(/-/g, '_')));
  const action = (field('action') || '').trim();
  const type = (field('type') || '').trim();
  let choices = null;
  const chRaw = field('choices');
  if (chRaw && chRaw.startsWith('[')) {
    choices = [...chRaw.matchAll(/([\"'])(.*?)\1/g)].map((x) => x[2]);
  }
  return {
    dest,
    flags,
    type: action.includes('store_true') ? 'bool(true)' : action.includes('store_false') ? 'bool(false)' : (type || 'str'),
    default: field('default'),
    choices,
  };
}

// 1) engine/music2midi.py：argparse + worker Namespace（request key -> dest）
const py = read('engine/music2midi.py');
const argparse = scanAddArguments(py);
const workerBlock = py.slice(py.indexOf('_ap.Namespace('));
const workerMap = {};   // dest -> request key
{
  const re = /^\s*([a-z_][a-z0-9_]*)\s*=\s*(?:bool\()?\s*req\.get\(\s*['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(workerBlock))) workerMap[m[1]] = m[2];
}

// 2) main/engine.js：worker 请求 map（界面 cfg key -> worker key）
const engineJs = read('main/engine.js');
const engineMap = {};    // cfgKey -> workerKey
{
  const i = engineJs.indexOf('const map = {');
  if (i >= 0) {
    const block = engineJs.slice(i, engineJs.indexOf('};', i) + 2);
    const re = /([A-Za-z_][\w]*)\s*:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(block))) engineMap[m[1]] = m[2];
  }
}

// 3) main/task-queue.js：spawn 回退路径 flag 表（cfgKey -> --flag）
const tq = read('main/task-queue.js');
const taskQueueMap = {};
{
  const i = tq.indexOf('merge_gap_ms:');
  if (i >= 0) {
    const block = tq.slice(i, tq.indexOf('};', i) + 2);
    const re = /([A-Za-z_][\w]*)\s*:\s*['"](--?[\w-]+)['"]/g;
    let m;
    while ((m = re.exec(block))) taskQueueMap[m[1]] = m[2];
  }
}

// 合并：按 dest 归并 argparse 与 worker 覆盖（argparse 有的以 argparse 为主）
const byDest = new Map();
for (const a of argparse) byDest.set(a.dest, { ...a });
// 特殊：--mode/--engine dest=engine_mode 等已在 argparse dest 中
// worker 里出现但 argparse 没有的键也记下来（说明只支持 worker 协议）
for (const [dest, key] of Object.entries(workerMap)) {
  if (!byDest.has(dest)) byDest.set(dest, { dest, flags: [], type: 'unknown', default: null, choices: null, workerOnly: true });
}
const params = [...byDest.values()].map((p) => ({
  dest: p.dest,
  flags: p.flags,
  type: p.type,
  default: p.default,
  choices: p.choices,
  workerKey: workerMap[p.dest] || null,
  engineMapKey: Object.entries(engineMap).find(([, v]) => v === (workerMap[p.dest] || ''))?.[0] || null,
  taskQueueFlag: p.flags.find((f) => f.startsWith('--')) || null,
  workerOnly: !!p.workerOnly || undefined,
})).sort((a, b) => a.dest.localeCompare(b.dest));

const workerKeys = new Set(Object.values(workerMap));
const argparseDests = new Set(argparse.map((a) => a.dest));
// worker 协议额外字段（不属于 CLI 参数）：input 已由位置参数覆盖，muscriptor_batch 是请求体专用
const WORKER_ONLY_ALLOW = new Set(['muscriptor_batch']);
// argparse 的 --min-freq 等别名：把 flag 归一化后也当作合法 dest
const argparseAliases = new Set(argparse.map((a) => a.dest));
for (const a of argparse) for (const f of a.flags) argparseAliases.add(f.replace(/^--?/, '').replace(/-/g, '_'));
const workerDestsWithoutArgparse = Object.keys(workerMap).filter((d) => !argparseAliases.has(d) && !WORKER_ONLY_ALLOW.has(d));
const engineKeysNotInWorker = Object.keys(engineMap).filter((k) => !workerKeys.has(engineMap[k]));
const engineKeysNotInArgparse = Object.keys(engineMap).filter((k) => !argparseAliases.has(k) && !argparseDests.has(k) && !WORKER_ONLY_ALLOW.has(k));

const schema = {
  format: 'fufumidi-engine-params-schema',
  version: 1,
  sources: {
    argparse: 'engine/music2midi.py build_parser()',
    worker: 'engine/music2midi.py cmd_worker() Namespace',
    engineMap: 'main/engine.js worker request map',
    taskQueue: 'main/task-queue.js spawn fallback flags',
  },
  counts: {
    argparseParams: argparse.length,
    workerKeys: workerMap ? Object.keys(workerMap).length : 0,
    engineMapKeys: Object.keys(engineMap).length,
    taskQueueFlags: Object.keys(taskQueueMap).length,
    params: params.length,
  },
  params,
  drift: {
    workerDestsWithoutArgparse,
    engineKeysNotInWorker,
    engineKeysNotInArgparse,
    taskQueueKeysWithoutEngineMap: Object.keys(taskQueueMap).filter((k) => !(k in engineMap)),
  },
  engineMap,
  taskQueueMap,
};

if (WRITE) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(schema, null, 2) + '\n', 'utf8');
  console.log('[engine-params] wrote ' + path.relative(ROOT, OUT));
}
if (CHECK) {
  if (!fs.existsSync(OUT)) { console.error('[engine-params] FAIL: schema 不存在，先 npm run contracts:write'); process.exit(1); }
  const stored = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const diffs = [];
  if (JSON.stringify(stored.counts) !== JSON.stringify(schema.counts)) diffs.push('参数数量漂移（argparse/worker/map/flag）');
  const a = JSON.stringify(stored.params || []);
  const b = JSON.stringify(schema.params);
  if (a !== b) diffs.push('参数表漂移（dest/flags/type/workerKey）');
  const d = schema.drift;
  const driftCount = Object.values(d).reduce((n, arr) => n + arr.length, 0);
  if (diffs.length) {
    console.error('[engine-params] FAIL: ' + diffs.join(' / '));
    console.error('  若确为有意变更：npm run contracts:write 后提交 docs/contracts/engine-params.schema.json');
    process.exit(1);
  }
  console.log('[engine-params] OK: ' + schema.counts.params + ' params / ' + schema.counts.workerKeys + ' worker keys / ' + schema.counts.engineMapKeys + ' engine map / ' + schema.counts.taskQueueFlags + ' flags；已知漂移 ' + driftCount + ' 项（见 schema.drift）');
  if (driftCount) console.log('  漂移明细: ' + JSON.stringify(d));
}
if (!WRITE && !CHECK) console.log(JSON.stringify(schema.counts, null, 2) + '\n' + JSON.stringify(schema.drift, null, 2));

#!/usr/bin/env node
// ============================================================
// IPC 契约提取与校验（M0 / S-002）
// ============================================================
// 目标：让 252 条 IPC 通道与 28 个事件通道成为**可 diff 的机器事实**。
// 用法：
//   node scripts/contracts/extract-ipc.mjs            # 打印摘要
//   node scripts/contracts/extract-ipc.mjs --write    # 写入 docs/contracts/ipc.schema.json
//   node scripts/contracts/extract-ipc.mjs --check    # 与已入库 schema 对比，漂移则退出 1
// 设计：输出按通道名排序、不含时间戳，保证同一份代码生成同一份文件（可进 git 做 drift gate）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'docs', 'contracts', 'ipc.schema.json');
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const CHECK = argv.includes('--check');

function walk(dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const ent of ents) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.isFile() && ent.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}
function readAll(files) {
  return files.map((f) => { try { return { file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }; } catch (e) { return { file: f, text: '' }; } });
}
function collect(re, files) {
  const map = new Map(); // channel -> files[]
  for (const { file, text } of readAll(files)) {
    let m;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = rx.exec(text))) {
      const ch = m[1];
      if (!ch) continue;
      if (!map.has(ch)) map.set(ch, []);
      const arr = map.get(ch);
      if (!arr.includes(file)) arr.push(file);
    }
  }
  return map;
}

// 1) preload：渲染进程能调用的通道
const preloadFile = path.join(ROOT, 'preload.js');
const preloadText = fs.existsSync(preloadFile) ? fs.readFileSync(preloadFile, 'utf8') : '';
const preloadInvoke = collect(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g, [preloadFile]);
const preloadSend = collect(/ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g, [preloadFile]);
const preloadOn = collect(/ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g, [preloadFile]);

// 2) main：主进程注册的 handler / 监听器
const mainFiles = [path.join(ROOT, 'main.js'), ...walk(path.join(ROOT, 'main'))];
const handle = collect(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g, mainFiles);
const on = collect(/ipcMain\.on\(\s*['"]([^'"]+)['"]/g, mainFiles);
const push = collect(/webContents\.send\(\s*['"]([^'"]+)['"]/g, mainFiles);

const invoke = [...preloadInvoke.keys()].sort();
const send = [...preloadSend.keys()].sort();
const handles = [...handle.keys()].sort();
const ons = [...on.keys()].sort();
const events = [...new Set([...preloadOn.keys(), ...push.keys()])].sort();

const registered = new Set([...handles, ...ons]);
const callable = new Set([...invoke, ...send]);
const missingHandler = [...callable].filter((c) => !registered.has(c)).sort();
const missingPreload = [...registered].filter((c) => !callable.has(c)).sort();

const schema = {
  format: 'fufumidi-ipc-schema',
  version: 1,
  platform: 'win32-x64',
  // 不写生成时间：文件要能进 git 做「零漂移」门禁
  counts: {
    invoke: invoke.length,
    send: send.length,
    handle: handles.length,
    ipcMainOn: ons.length,
    events: events.length,
    missingHandler: missingHandler.length,
    missingPreload: missingPreload.length,
  },
  invoke,
  send,
  handle: handles,
  ipcMainOn: ons,
  events,
  missingHandler,
  missingPreload,
  // 关键通道的证据（文件:行级别由生成脚本按需扩展；这里只记文件）
  evidence: {
    preload: 'preload.js',
    main: mainFiles.map((f) => path.relative(ROOT, f)).sort(),
  },
};

if (WRITE) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(schema, null, 2) + '\n', 'utf8');
  console.log('[contracts] wrote ' + path.relative(ROOT, OUT));
}

if (CHECK) {
  if (!fs.existsSync(OUT)) {
    console.error('[contracts] FAIL: ' + path.relative(ROOT, OUT) + ' 不存在，先跑 npm run contracts:write');
    process.exit(1);
  }
  const stored = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const a = JSON.stringify(stored.invoke || []);
  const b = JSON.stringify(schema.invoke);
  const c = JSON.stringify(stored.handle || []);
  const d = JSON.stringify(schema.handle);
  const e = JSON.stringify(stored.events || []);
  const f = JSON.stringify(schema.events);
  const diffs = [];
  if (a !== b) diffs.push('invoke 通道漂移');
  if (c !== d) diffs.push('ipcMain.handle 通道漂移');
  if (e !== f) diffs.push('事件通道漂移');
  if ((stored.counts && stored.counts.missingHandler || 0) !== missingHandler.length) diffs.push('missingHandler 数量漂移');
  if ((stored.counts && stored.counts.missingPreload || 0) !== missingPreload.length) diffs.push('missingPreload 数量漂移');
  if (diffs.length) {
    console.error('[contracts] FAIL: ' + diffs.join(' / '));
    console.error('  preload invoke: ' + invoke.length + '，handle: ' + handles.length + '，ipcMain.on: ' + ons.length + '，events: ' + events.length);
    console.error('  缺失 handler: ' + (missingHandler.join(', ') || '无'));
    console.error('  缺失 preload: ' + (missingPreload.join(', ') || '无'));
    console.error('  若确为有意变更：npm run contracts:write 后提交 docs/contracts/ipc.schema.json');
    process.exit(1);
  }
  console.log('[contracts] OK: ' + invoke.length + ' invoke / ' + handles.length + ' handle / ' + ons.length + ' ipcMain.on / ' + events.length + ' events，零漂移');
}

if (!WRITE && !CHECK) {
  console.log(JSON.stringify({
    counts: schema.counts,
    missingHandler,
    missingPreload,
  }, null, 2));
}

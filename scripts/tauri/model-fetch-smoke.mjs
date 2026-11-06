#!/usr/bin/env node
// ============================================================================
// 可选联网冒烟（默认不跑）：验证 Tauri 模型下载器端到端。
//
// 做法：用 debug/release 的 fufumidi-shell.exe --model-fetch <id>，
//   FUFUMIDI_DATA_ROOT 指向临时目录，校验：
//     1) 进程退出码 0 且 stdout JSON ok:true
//     2) 解包目录里存在 unpackMarker 文件
//     3) 落盘体积 > 0 且 <= 50MB（只允许小模型，避免大流量）
//   跑完删除临时目录。
//
// 安全：exe 必须比 shells/tauri/src/**.rs 新（否则源码/二进制不同步，跳过而不是冒险
//       用旧 exe —— 旧版本不认 --model-fetch 会直接启动 GUI）。
//
// 用法：
//   node scripts/tauri/model-fetch-smoke.mjs [--model hft_transformer] [--dry-run]
//        [--timeout-ms 300000] [--exe <path>]
// 退出码：0=通过；4=跳过（找不到 exe / 二进制过期 / 模型不在允许清单）；1=失败。
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IS_WIN = process.platform === 'win32';
const EXE_NAME = IS_WIN ? 'fufumidi-shell.exe' : 'fufumidi-shell';
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_CAPTURE = 4 * 1024 * 1024;

// 允许清单：只跑 <50MB 的小模型。marker 必须与 shells/tauri/src/model_service.rs 的 SPECS 一致。
const ALLOWED = {
  hft_transformer: {
    label: 'hFT-Transformer',
    marker: 'checkpoint/MAESTRO-V3/model_016_003.pkl',
    approxBytes: 20540269,
  },
};

const argv = process.argv.slice(2);
function option(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
  }
  return undefined;
}
const model = option('--model') || 'hft_transformer';
const dryRun = argv.includes('--dry-run');
const timeoutMs = Math.max(1000, Number(option('--timeout-ms') || 300000) || 300000);
const explicitExe = option('--exe');

function emit(payload, code) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
function tailOf(text, lines = 20) {
  if (!text) return '';
  return stripAnsi(text).replace(/\r\n/g, '\n').split('\n').slice(-lines).join('\n').trimEnd();
}
function appendCap(buf, chunk) {
  const next = buf + chunk;
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}
function dirSize(p) {
  let total = 0;
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  for (const name of fs.readdirSync(p)) {
    try { total += dirSize(path.join(p, name)); } catch { /* ignore */ }
  }
  return total;
}
function lastJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  return null;
}
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {
    try { child.kill(); } catch { /* ignore */ }
  }
}

/* ------------------------------ 前置检查 ------------------------------- */
const spec = ALLOWED[model];
if (!spec) {
  emit({
    ok: false, skipped: true, model,
    reason: '模型 ' + model + ' 不在允许清单（只允许 <50MB：' + Object.keys(ALLOWED).join(', ') + '）',
  }, 4);
}

function findExe() {
  const cands = [];
  const push = (p) => {
    try {
      if (!p) return;
      const abs = path.resolve(p);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) cands.push({ p: abs, mtime: fs.statSync(abs).mtimeMs });
    } catch { /* ignore */ }
  };
  if (explicitExe) push(explicitExe);
  if (process.env.FUFUMIDI_SHELL_EXE) push(process.env.FUFUMIDI_SHELL_EXE);
  const targetDirs = [];
  if (process.env.CARGO_TARGET_DIR) targetDirs.push(path.resolve(process.env.CARGO_TARGET_DIR));
  targetDirs.push(path.join(ROOT, 'shells', 'tauri', 'target'));
  for (const dir of targetDirs) {
    for (const profile of ['debug', 'release']) push(path.join(dir, profile, EXE_NAME));
  }
  cands.sort((a, b) => b.mtime - a.mtime); // 取最新的一个（debug/release 都行）
  return cands.length ? cands[0] : null;
}
function newestSourceMtime() {
  let newest = 0;
  const srcDir = path.join(ROOT, 'shells', 'tauri', 'src');
  if (fs.existsSync(srcDir)) {
    for (const name of fs.readdirSync(srcDir)) {
      if (!name.endsWith('.rs')) continue;
      try { newest = Math.max(newest, fs.statSync(path.join(srcDir, name)).mtimeMs); } catch { /* ignore */ }
    }
  }
  const manifest = path.join(ROOT, 'shells', 'tauri', 'Cargo.toml');
  try { if (fs.existsSync(manifest)) newest = Math.max(newest, fs.statSync(manifest).mtimeMs); } catch { /* ignore */ }
  return newest;
}

const exe = findExe();
if (!exe) {
  emit({
    ok: false, skipped: true, model,
    reason: '找不到 fufumidi-shell 可执行文件（先 cargo build / cargo test；或设 FUFUMIDI_SHELL_EXE）',
    searched: ['shells/tauri/target/debug', 'shells/tauri/target/release'],
  }, 4);
}
const mainRs = path.join(ROOT, 'shells', 'tauri', 'src', 'main.rs');
let mainSrc = '';
try { mainSrc = fs.readFileSync(mainRs, 'utf8'); } catch { /* ignore */ }
if (!mainSrc.includes('--model-fetch')) {
  emit({
    ok: false, skipped: true, model, exe: exe.p,
    reason: '源码 main.rs 尚未实现 --model-fetch CLI，跳过（避免旧 exe 启动 GUI）',
  }, 4);
}
const srcMtime = newestSourceMtime();
if (exe.mtime + 1000 < srcMtime) {
  emit({
    ok: false, skipped: true, model, exe: exe.p,
    reason: '可执行文件比源码旧（exe=' + new Date(exe.mtime).toISOString() + ' / src=' + new Date(srcMtime).toISOString() + '），先重新构建再跑',
  }, 4);
}

if (dryRun) {
  emit({
    ok: true, dryRun: true, model, exe: exe.p, marker: spec.marker,
    approxBytes: spec.approxBytes, maxDownloadBytes: MAX_DOWNLOAD_BYTES, timeoutMs,
  }, 0);
}

/* ------------------------------ 执行下载 ------------------------------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-model-fetch-'));
const modelsDir = path.join(tmpRoot, 'models');
const startedMs = Date.now();
const env = { ...process.env, FUFUMIDI_DATA_ROOT: tmpRoot, NO_COLOR: '1' };

const run = await new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timedOut = false;
  let spawnError = null;
  let child = null;
  try {
    child = spawn(exe.p, ['--model-fetch', model], {
      cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    resolve({ spawnError: e, stdout, stderr, timedOut, code: null, signal: null });
    return;
  }
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
  child.stdout.on('data', (d) => { stdout = appendCap(stdout, d.toString('utf8')); });
  child.stderr.on('data', (d) => { stderr = appendCap(stderr, d.toString('utf8')); });
  child.on('error', (e) => { spawnError = e; });
  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ code, signal, timedOut, spawnError, stdout, stderr });
  });
});

const durationMs = Date.now() - startedMs;
const parsed = lastJson(run.stdout);
const destPath = parsed && typeof parsed.path === 'string' && parsed.path
  ? parsed.path
  : path.join(modelsDir, model);
const markerPath = path.join(destPath, spec.marker);
let markerExists = false;
try { markerExists = fs.statSync(markerPath).isFile(); } catch { /* ignore */ }
const sizeBytes = dirSize(destPath);
const tooBig = sizeBytes > MAX_DOWNLOAD_BYTES;
const ok = !run.spawnError && !run.timedOut && run.code === 0 &&
  Boolean(parsed && parsed.ok === true) && markerExists && sizeBytes > 0 && !tooBig;

let cleanupError = null;
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch (e) {
  cleanupError = String((e && e.message) || e);
}
const cleanedUp = !fs.existsSync(tmpRoot);

const payload = {
  ok,
  model,
  exe: exe.p,
  timeoutMs,
  durationMs,
  exitCode: run.code,
  signal: run.signal || null,
  timedOut: Boolean(run.timedOut),
  spawnError: run.spawnError ? String(run.spawnError.message || run.spawnError) : null,
  marker: spec.marker,
  markerPath,
  markerExists,
  sizeBytes,
  maxDownloadBytes: MAX_DOWNLOAD_BYTES,
  tooBig,
  download: parsed,
  dataRoot: tmpRoot,
  cleanedUp,
  cleanupError,
  stderrTail: tailOf(run.stderr, 20),
};
if (!ok) {
  if (run.timedOut) payload.reason = '下载超时（' + timeoutMs + 'ms）';
  else if (run.spawnError) payload.reason = '启动 exe 失败：' + payload.spawnError;
  else if (!parsed) payload.reason = 'stdout 不是合法 JSON';
  else if (parsed.ok !== true) payload.reason = '下载失败：' + String(parsed.error || 'ok!=true');
  else if (!markerExists) payload.reason = 'unpackMarker 不存在：' + markerPath;
  else if (tooBig) payload.reason = '下载体积超过 50MB 限制：' + sizeBytes;
  else payload.reason = '未知失败';
}
emit(payload, ok ? 0 : 1);

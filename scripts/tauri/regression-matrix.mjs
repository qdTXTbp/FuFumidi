#!/usr/bin/env node
// ============================================================================
// FuFumidi 无头回归矩阵（S8）
//
// 顺序执行回归门禁，逐步记录耗时 / 退出码 / 输出尾部，产出：
//   docs/port/regression-latest.json   结构化结果（机器可读）
//   docs/port/regression-latest.md     人工摘要（通过 / 失败 / 警告 / 跳过）
//
// 安全策略（默认，且不会因无参数调用而改变）：
//   - 不启动 GUI / Electron 窗口（scripts/e2e/run.mjs 默认 SKIP）
//   - 不执行安装器打包（npm run dist:win 默认 SKIP）
//   - 不执行更新签名（npm run tauri:sign 默认 SKIP）
//   - 所有子进程 windowsHide:true（Windows 上不弹控制台）
//
// 用法：
//   node scripts/tauri/regression-matrix.mjs                  # 全矩阵 + 写报告
//   node scripts/tauri/regression-matrix.mjs --list           # 只看步骤清单
//   node scripts/tauri/regression-matrix.mjs --only typecheck,test-ui
//   node scripts/tauri/regression-matrix.mjs --no-write       # 只跑不落盘
//   node scripts/tauri/regression-matrix.mjs --save-logs      # 额外保存完整日志
//   node scripts/tauri/regression-matrix.mjs --verbose        # 实时透传子进程输出
//   node scripts/tauri/regression-matrix.mjs --include-network # 额外跑联网模型下载冒烟（≈20MB）
//   node scripts/tauri/regression-matrix.mjs --timeout-scale=2
//
// 退出码：0 = 没有失败项（警告 / 跳过不算失败）；1 = 有失败项；2 = 参数错误。
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS_DIR = path.join(ROOT, 'docs', 'port');
const JSON_OUT = path.join(DOCS_DIR, 'regression-latest.json');
const MD_OUT = path.join(DOCS_DIR, 'regression-latest.md');
const LOG_DIR = path.join(DOCS_DIR, 'regression-logs');
const IS_WIN = process.platform === 'win32';
const COMSPEC = process.env.ComSpec || (IS_WIN ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh');
const BT = String.fromCharCode(96);
const code = (s) => BT + String(s == null ? '' : s) + BT;
const FENCE = BT + BT + BT;
const TAIL_LINES = 40;
const TAIL_CHARS = 8000;
const MAX_CAPTURE = 8 * 1024 * 1024;

/* ------------------------------- 参数解析 ------------------------------- */
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.some((a) => a === name);
function option(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
  }
  return undefined;
}
const opts = {
  only: (option('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
  list: hasFlag('--list'),
  write: !hasFlag('--no-write'),
  verbose: hasFlag('--verbose') || hasFlag('-v'),
  saveLogs: hasFlag('--save-logs'),
  printJson: hasFlag('--json'),
  includeGui: hasFlag('--include-gui'),
  includeNetwork: hasFlag('--include-network'),
  timeoutScale: Math.max(0.1, Number(option('--timeout-scale') || 1) || 1),
};

/* --------------------------- 子进程命令包装 ---------------------------- */
// npm 在 Windows 上是 .cmd，Node >=20.12 禁止无 shell 直接 spawn .cmd。
// 用 cmd.exe /d /s /c 显式包一层，既避开 DEP0190，又能稳定拿到退出码。
function npmStep(id, title, npmArgs, timeoutMs) {
  return {
    id, title, kind: 'required', timeoutMs,
    cmd: IS_WIN ? COMSPEC : 'npm',
    args: IS_WIN ? ['/d', '/s', '/c', ['npm', ...npmArgs].join(' ')] : npmArgs,
    cwd: ROOT,
    display: 'npm ' + npmArgs.join(' '),
  };
}
function nodeStep(id, title, scriptArgs, timeoutMs, extra = {}) {
  return {
    id, title, kind: 'required', timeoutMs,
    cmd: process.execPath,
    args: scriptArgs,
    cwd: ROOT,
    display: 'node ' + scriptArgs.join(' '),
    ...extra,
  };
}

/* ------------------------------ 步骤清单 ------------------------------- */
// 选 Rust core 的测试目录：规格写的是 crates/rust-core；本仓库实际布局可能不同，做存在性回退。
function pickCoreCargo() {
  const candidates = [
    { rel: 'crates/rust-core', note: '规格指定路径 crates/rust-core' },
    { rel: 'crates', note: 'crates/rust-core 不存在，回退到 crates/ Rust workspace' },
    { rel: 'rust-core', note: 'crates/ 不可用，回退到旧 rust-core/ 独立 crate' },
  ];
  for (const c of candidates) {
    const dir = path.join(ROOT, c.rel);
    if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return { ...c, dir };
  }
  return null;
}

function buildSteps() {
  const steps = [
    npmStep('typecheck', '前端 TypeScript 类型检查', ['run', 'typecheck'], 300000),
    {
      ...npmStep('audit', '仓库审计（版本/i18n/许可证/参数/死选项/UI token/契约/品牌/handler）', ['run', 'audit'], 900000),
      // npm run audit 用 && 串联，首个子检查失败会短路后续；失败详情里要说明这一点。
      note: 'npm run audit 内部以 && 串联：首个失败（通常是 check:version）会短路后续 i18n/许可证/参数/契约/品牌检查',
    },
    npmStep('test-ui', '前端单元测试（node --test）', ['run', 'test:ui'], 600000),
    nodeStep('handler-audit', 'Tauri command 注册审计', [path.join('scripts', 'tauri', 'handler-audit.mjs')], 120000),
    nodeStep('ipc-coverage', 'IPC 覆盖静态统计', [path.join('scripts', 'tauri', 'ipc-coverage.mjs')], 120000),
    nodeStep('bridge-call-audit', '前端 bridge.* 调用静态审计', [path.join('scripts', 'tauri', 'bridge-call-audit.mjs')], 120000),
    nodeStep('model-contract', '模型规格契约静态检查（允许 WARN）', [path.join('scripts', 'tauri', 'model-contract-check.mjs'), '--json'], 120000, {
      kind: 'warn',
      // 3 = 只有 WARN（允许），不算失败；0 = 完全一致；1 = 结构性错误
      toleratedExitCodes: [3],
      parseJson: true,
    }),
    {
      id: 'cargo-test-shell', title: 'Cargo 测试（shells/tauri）', kind: 'required', timeoutMs: 900000,
      cmd: 'cargo', args: ['test', '--offline'], cwd: path.join(ROOT, 'shells', 'tauri'),
      display: 'cargo test --offline', note: 'cwd=shells/tauri',
      env: { CARGO_TERM_COLOR: 'never' },
    },
    {
      id: 'cargo-clippy-shell', title: 'Cargo Clippy -D warnings（shells/tauri）', kind: 'required', timeoutMs: 900000,
      cmd: 'cargo', args: ['clippy', '--offline', '--', '-D', 'warnings'], cwd: path.join(ROOT, 'shells', 'tauri'),
      display: 'cargo clippy --offline -- -D warnings', note: 'cwd=shells/tauri',
      env: { CARGO_TERM_COLOR: 'never' },
    },
  ];

  const core = pickCoreCargo();
  if (core) {
    steps.push({
      id: 'cargo-test-core', title: 'Cargo 测试（Rust core）', kind: 'required', timeoutMs: 600000,
      cmd: 'cargo', args: ['test', '--offline'], cwd: core.dir,
      display: 'cargo test --offline', note: 'cwd=' + core.rel + '（' + core.note + '）',
      env: { CARGO_TERM_COLOR: 'never' },
    });
  } else {
    steps.push({
      id: 'cargo-test-core', title: 'Cargo 测试（Rust core）', kind: 'required', timeoutMs: 600000,
      skip: 'crates/rust-core、crates/、rust-core/ 均不存在，无法定位 Rust core 测试目录',
    });
  }

  steps.push(npmStep('build-frontend', '前端生产构建（vite build）', ['--prefix', 'frontend', 'run', 'build'], 900000));

  // 可选联网步骤：默认跳过，只有 --include-network 才执行（会真实下载模型）。
  steps.push({
    id: 'model-fetch-smoke',
    title: '模型下载冒烟（联网，hft_transformer ≈20MB）',
    kind: 'network',
    timeoutMs: 600000,
    cmd: process.execPath,
    args: [path.join('scripts', 'tauri', 'model-fetch-smoke.mjs')],
    cwd: ROOT,
    display: 'node scripts/tauri/model-fetch-smoke.mjs',
    skipExitCodes: [4],
    parseJson: true,
    reason: '会联网下载约 20MB 的 hft_transformer，校验输出 JSON ok:true 与 unpackMarker 文件',
  });
  return steps;
}

// 默认永不执行的步骤（除非显式 --include-gui）。保留在报告里，让“跳过什么、为什么跳过”可审计。
const GUI_STEPS = [
  {
    id: 'hidden-e2e', title: 'Electron hidden E2E（会启动应用窗口）', kind: 'gui',
    display: 'node scripts/e2e/run.mjs',
    reason: '默认跳过：会启动 Electron / GUI 实例（回归矩阵不碰窗口）',
  },
  {
    id: 'installer', title: '安装器打包（electron-builder NSIS）', kind: 'gui',
    display: 'npm run dist:win',
    reason: '默认跳过：安装器构建会拉取/签名并可能弹窗',
  },
  {
    id: 'signing', title: '更新签名（tauri:sign）', kind: 'gui',
    display: 'npm run tauri:sign',
    reason: '默认跳过：签名步骤不在无头回归范围',
  },
];

/* ------------------------------ 工具函数 ------------------------------- */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const appendCap = (buf, chunk) => {
  const next = buf + chunk;
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
};
function tailOf(text, lines = TAIL_LINES, chars = TAIL_CHARS) {
  if (!text) return '';
  const stripped = stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let t = stripped.split('\n').slice(-lines).join('\n');
  if (t.length > chars) t = '…' + t.slice(t.length - chars);
  return t.trimEnd();
}
function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m + 'm' + String(s).padStart(2, '0') + 's';
}
const STATUS_LABEL = { passed: 'PASS', failed: 'FAIL', warn: 'WARN', skipped: 'SKIP' };

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}
function gitState() {
  const status = git(['status', '--porcelain']);
  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: git(['rev-parse', '--short', 'HEAD']),
    commitFull: git(['rev-parse', 'HEAD']),
    subject: git(['log', '-1', '--format=%s']),
    dirty: status ? status.split(/\r?\n/).filter(Boolean) : [],
  };
}
function toolVersion(cmd, args, shell = false) {
  try {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, shell });
    return r.status === 0 ? stripAnsi(String(r.stdout || '')).trim().split(/\r?\n/)[0] : null;
  } catch {
    return null;
  }
}
function collectToolchain() {
  return {
    node: process.version,
    npm: IS_WIN
      ? toolVersion(COMSPEC, ['/d', '/s', '/c', 'npm --version'])
      : toolVersion('npm', ['--version']),
    cargo: toolVersion('cargo', ['--version']),
    rustc: toolVersion('rustc', ['--version']),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpus: os.cpus().length,
  };
}

/* ------------------------------ 单步执行 ------------------------------- */
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {
    try { child.kill(); } catch { /* ignore */ }
  }
}

function runStep(step) {
  return new Promise((resolve) => {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    const child = spawn(step.cmd, step.args, {
      cwd: step.cwd || ROOT,
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', ...(step.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (opts.verbose) process.stdout.write('\n---- ' + step.id + ' ----\n');
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.round((step.timeoutMs || 300000) * opts.timeoutScale));

    child.stdout.on('data', (d) => {
      const t = d.toString('utf8');
      stdout = appendCap(stdout, t);
      if (opts.verbose) process.stdout.write(t);
    });
    child.stderr.on('data', (d) => {
      const t = d.toString('utf8');
      stderr = appendCap(stderr, t);
      if (opts.verbose) process.stderr.write(t);
    });
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedMs;
      const details = step.parseJson && stdout.trim() ? tryParseJson(stdout) : null;
      let status;
      if (spawnError || timedOut) status = 'failed';
      else if (exitCode === 0) status = 'passed';
      else if ((step.skipExitCodes || []).includes(exitCode)) status = 'skipped';
      else if ((step.toleratedExitCodes || []).includes(exitCode)) status = 'warn';
      else status = 'failed';

      const result = {
        id: step.id,
        title: step.title,
        kind: step.kind || 'required',
        command: step.display || [step.cmd, ...(step.args || [])].join(' '),
        cwd: step.cwd ? path.relative(ROOT, step.cwd).replace(/\\/g, '/') || '.' : '.',
        status,
        exitCode,
        signal: signal || null,
        timedOut,
        durationMs,
        startedAt,
        finishedAt: new Date().toISOString(),
        tail: { stdout: tailOf(stdout), stderr: tailOf(stderr) },
      };
      if (spawnError) result.error = spawnError.code || String(spawnError.message || spawnError);
      if (step.note) result.note = step.note;
      if (details) result.details = details;
      if (status === 'skipped') {
        result.reason = (details && (details.reason || details.error)) || tailOf(stdout, 5) || '脚本以跳过码退出';
      }
      if (opts.saveLogs && (stdout || stderr)) {
        try {
          fs.mkdirSync(LOG_DIR, { recursive: true });
          const logPath = path.join(LOG_DIR, step.id + '.log');
          const header = [
            '# ' + step.title,
            '# command: ' + result.command,
            '# cwd: ' + (step.cwd || ROOT),
            '# started: ' + startedAt,
            '# exit: ' + String(exitCode) + (timedOut ? ' (timed out)' : ''),
            '',
            '===== stdout =====',
            stripAnsi(stdout).replace(/\r\n/g, '\n'),
            '',
            '===== stderr =====',
            stripAnsi(stderr).replace(/\r\n/g, '\n'),
            '',
          ].join('\n');
          fs.writeFileSync(logPath, header, 'utf8');
          result.logPath = path.relative(ROOT, logPath).replace(/\\/g, '/');
        } catch (e) {
          result.logWriteError = String((e && e.message) || e);
        }
      }
      resolve(result);
    });
  });
}

function tryParseJson(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  return { parseError: 'stdout 不是合法 JSON', head: tailOf(trimmed, 10) };
}

/* --------------------------- Markdown 生成 ----------------------------- */
function statusText(status) {
  if (status === 'passed') return '✅ PASS';
  if (status === 'failed') return '❌ FAIL';
  if (status === 'warn') return '⚠️ WARN';
  return '⏭️ SKIP';
}
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function renderMarkdown(report, orderedResults) {
  const ts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(report.generatedAt));
  const s = report.summary;
  const lines = [];
  lines.push('# FuFumidi 无头回归矩阵 — 最新结果', '');
  lines.push('> 生成时间：' + ts + '（Asia/Shanghai）  ');
  lines.push('> 生成命令：' + code('node scripts/tauri/regression-matrix.mjs') + '  ');
  lines.push('> 安全策略：不启动 GUI / Electron 窗口 / 安装器 / 签名步骤；联网冒烟（model-fetch-smoke）默认跳过，需 --include-network；所有子进程隐藏窗口。', '');
  lines.push('## 环境', '');
  lines.push('| 项 | 值 |', '|---|---|');
  lines.push('| 仓库 | ' + code(report.repo.root) + ' |');
  lines.push('| 分支 / 提交 | ' + code((report.repo.branch || '?') + ' @ ' + (report.repo.commit || '?')) + ' |');
  lines.push('| 提交说明 | ' + mdEscape(report.repo.subject || '—') + ' |');
  lines.push('| 工作区 | ' + (report.repo.dirty.length ? '脏（' + report.repo.dirty.length + ' 个改动）' : '干净') + ' |');
  lines.push('| 工具链 | ' + [
    'Node ' + report.toolchain.node,
    'npm ' + (report.toolchain.npm || '?'),
    report.toolchain.cargo || 'cargo ?',
    report.toolchain.rustc || 'rustc ?',
  ].join(' · ') + ' |');
  lines.push('| 平台 | ' + report.toolchain.platform + '/' + report.toolchain.arch + ' · ' + report.toolchain.cpus + ' 核 |');
  lines.push('');
  lines.push('## 总览', '');
  lines.push('- **通过** ' + s.passed + ' · **失败** ' + s.failed + ' · **警告** ' + s.warned + ' · **跳过** ' + s.skipped);
  lines.push('- 总耗时：**' + fmtDuration(s.durationMs) + '**');
  lines.push('- 结论：' + (report.ok ? '✅ 无失败项（警告/跳过见下）' : '❌ 存在失败项，详见「失败详情」'));
  if (report.repo.changedDuringRun && report.repo.changedDuringRun.length) {
    lines.push('- ⚠️ 运行期间工作区发生变化（可能有其他改动并发）：' + report.repo.changedDuringRun.map((x) => code(x)).join('、'));
  }
  lines.push('');
  lines.push('## 步骤明细', '');
  lines.push('| # | 步骤 | 状态 | 退出码 | 耗时 | 命令 |');
  lines.push('|---:|---|---|---:|---:|---|');
  orderedResults.forEach((r, i) => {
    const exitText = r.status === 'skipped' ? '—' : String(r.exitCode == null ? '?' : r.exitCode);
    lines.push('| ' + (i + 1) + ' | ' + mdEscape(r.title || r.id) + ' | ' + statusText(r.status) + ' | ' + exitText + ' | ' + fmtDuration(r.durationMs) + ' | ' + code(mdEscape(r.command || '')) + ' |');
  });
  lines.push('');
  const failed = orderedResults.filter((r) => r.status === 'failed');
  lines.push('## 失败详情', '');
  if (!failed.length) lines.push('（无）');
  for (const r of failed) {
    lines.push('### ' + code(r.id) + ' — exit ' + (r.exitCode == null ? '?' : r.exitCode) + '（' + fmtDuration(r.durationMs) + '）', '');
    lines.push('- 命令：' + code(r.command || ''));
    if (r.cwd) lines.push('- 工作目录：' + code(r.cwd));
    if (r.note) lines.push('- 备注：' + r.note);
    if (r.timedOut) lines.push('- **超时被终止**');
    if (r.error) lines.push('- 启动错误：' + code(r.error));
    lines.push('');
    const body = r.tail && (r.tail.stderr || r.tail.stdout) ? (r.tail.stderr || r.tail.stdout) : '（无输出）';
    lines.push(FENCE + 'text', body, FENCE, '');
  }
  const warned = orderedResults.filter((r) => r.status === 'warn');
  lines.push('## 警告（不阻塞）', '');
  if (!warned.length) lines.push('（无）');
  for (const r of warned) {
    lines.push('### ' + code(r.id) + '（' + fmtDuration(r.durationMs) + '）', '');
    const d = r.details || {};
    if (Array.isArray(d.warns) && d.warns.length) {
      for (const w of d.warns.slice(0, 40)) lines.push('- ' + mdEscape(typeof w === 'string' ? w : w.message || JSON.stringify(w)));
      if (d.warns.length > 40) lines.push('- …其余 ' + (d.warns.length - 40) + ' 条见 JSON');
    } else {
      const body = r.tail && (r.tail.stderr || r.tail.stdout) ? (r.tail.stderr || r.tail.stdout) : '（无输出）';
      lines.push(FENCE + 'text', body, FENCE);
    }
    lines.push('');
  }
  const skipped = orderedResults.filter((r) => r.status === 'skipped');
  lines.push('## 默认跳过（安全策略）', '');
  if (!skipped.length) lines.push('（无）');
  else {
    lines.push('| 步骤 | 命令 | 原因 |');
    lines.push('|---|---|---|');
    for (const r of skipped) lines.push('| ' + mdEscape(r.title || r.id) + ' | ' + code(mdEscape(r.command || '')) + ' | ' + mdEscape(r.reason || '—') + ' |');
  }
  lines.push('');
  lines.push('## 复现', '');
  lines.push(FENCE + 'powershell');
  lines.push('node scripts/tauri/regression-matrix.mjs');
  lines.push('node scripts/tauri/regression-matrix.mjs --only typecheck,test-ui --no-write');
  lines.push('node scripts/tauri/regression-matrix.mjs --save-logs --verbose');
  lines.push(FENCE);
  lines.push('');
  lines.push('## 说明', '');
  lines.push('- 每步的 tail 是输出末尾 ' + TAIL_LINES + ' 行；完整日志需加 --save-logs（写入 docs/port/regression-logs/）。');
  lines.push('- model-contract 允许 WARN（退出码 3 视为警告，不阻塞）；其结构化结果在 regression-latest.json 的 steps[].details。');
  lines.push('- 本矩阵不含 GUI / 安装器 / 签名；Electron E2E 需人工单独执行 npm run test:e2e。');
  lines.push('- model-fetch-smoke 是可选联网步骤：需要 --include-network；只下载 <50MB 的 hft_transformer，校验 JSON ok:true 与 unpackMarker，跑完删临时目录。');
  lines.push('');
  return lines.join('\n');
}

/* -------------------------------- 主流程 -------------------------------- */
async function main() {
  const steps = buildSteps();
  const matches = (s) => !opts.only.length || opts.only.some((o) => s.id === o || s.id.startsWith(o));
  const planned = [...steps.filter(matches), ...GUI_STEPS.filter(matches)];

  if (opts.list) {
    console.log('可用步骤：');
    for (const s of [...steps, ...GUI_STEPS]) {
      const tag = s.kind === 'gui' ? '[SKIP-GUI]' : s.kind === 'network' ? '[SKIP-NET]' : s.kind === 'warn' ? '[WARN-OK]' : '';
      console.log('  ' + s.id.padEnd(20) + ' ' + (s.display || '').padEnd(46) + ' ' + tag);
    }
    console.log('');
    console.log('默认跳过：' + GUI_STEPS.map((g) => g.id).join(', ') + '（除非显式 --include-gui）');
    return 0;
  }

  if (opts.only.length && planned.length === 0) {
    console.error('[regression] --only 没有匹配到任何步骤：' + opts.only.join(', '));
    return 2;
  }

  const startedAt = Date.now();
  const repoBefore = gitState();
  const toolchain = collectToolchain();

  console.log('[regression] repo: ' + repoBefore.branch + ' @ ' + repoBefore.commit + ' · dirty=' + repoBefore.dirty.length + ' · node ' + toolchain.node + ' · ' + (toolchain.cargo || 'cargo ?'));
  console.log('[regression] plan: ' + planned.length + ' 步 · 安全策略：不启动 GUI/安装器/签名（联网冒烟需 --include-network）');
  console.log('');

  const results = [];
  for (let i = 0; i < planned.length; i++) {
    const step = planned[i];
    const prefix = '[' + String(i + 1).padStart(2, ' ') + '/' + planned.length + '] ' + step.id.padEnd(20);
    const guardReason = step.skip
      ? step.skip
      : step.kind === 'gui' && !opts.includeGui
        ? '默认不执行（需要 --include-gui）：' + step.reason
        : step.kind === 'network' && !opts.includeNetwork
          ? '默认不执行（需要 --include-network）：' + step.reason
          : null;
    if (guardReason) {
      const reasonKind = step.skip ? 'missing-path' : step.kind === 'gui' ? 'gui-guard' : 'network-guard';
      results.push({
        id: step.id, title: step.title, kind: step.kind || 'required',
        command: step.display || '', status: 'skipped', exitCode: null, durationMs: null,
        reason: guardReason, reasonKind,
      });
      console.log(prefix + '... SKIP  ' + guardReason);
      continue;
    }
    process.stdout.write(prefix + '... ');
    const r = await runStep(step);
    results.push(r);
    console.log(STATUS_LABEL[r.status] + '  ' + fmtDuration(r.durationMs) + '  exit=' + (r.exitCode == null ? '?' : r.exitCode));
    if (r.status === 'skipped') console.log('    ' + (r.reason || '已跳过'));
    if (r.status === 'failed' && !opts.verbose) {
      const t = (r.tail && (r.tail.stderr || r.tail.stdout) || '').split('\n').slice(-8).join('\n');
      if (t) console.log('    ' + t.split('\n').join('\n    '));
    }
  }

  const repoAfter = gitState();
  const beforeSet = new Set(repoBefore.dirty);
  const changedDuringRun = repoAfter.dirty.filter((x) => !beforeSet.has(x));
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    warned: results.filter((r) => r.status === 'warn').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    durationMs: Date.now() - startedAt,
  };
  const report = {
    schema: 'fufumidi.regression-matrix/1',
    generatedAt: new Date().toISOString(),
    repo: {
      root: ROOT,
      branch: repoBefore.branch,
      commit: repoBefore.commit,
      commitFull: repoBefore.commitFull,
      subject: repoBefore.subject,
      dirty: repoBefore.dirty,
      changedDuringRun,
    },
    toolchain,
    options: { only: opts.only, includeGui: opts.includeGui, includeNetwork: opts.includeNetwork, saveLogs: opts.saveLogs, timeoutScale: opts.timeoutScale },
    ok: summary.failed === 0,
    summary,
    steps: results,
  };

  if (opts.write) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(MD_OUT, renderMarkdown(report, results), 'utf8');
  }

  console.log('');
  console.log('[regression] total ' + fmtDuration(summary.durationMs) + ' · passed ' + summary.passed + ' · failed ' + summary.failed + ' · warn ' + summary.warned + ' · skipped ' + summary.skipped);
  if (opts.write) {
    console.log('[regression] wrote ' + path.relative(ROOT, JSON_OUT).replace(/\\/g, '/'));
    console.log('[regression] wrote ' + path.relative(ROOT, MD_OUT).replace(/\\/g, '/'));
  }
  if (opts.saveLogs) console.log('[regression] logs: ' + path.relative(ROOT, LOG_DIR).replace(/\\/g, '/'));
  if (opts.printJson) console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.log('[regression] 失败步骤：' + results.filter((r) => r.status === 'failed').map((r) => r.id).join(', '));
  }
  return report.ok ? 0 : 1;
}

main().then((exitCode) => process.exit(exitCode)).catch((e) => {
  console.error('[regression] 未捕获错误：' + ((e && e.stack) || e));
  process.exit(1);
});

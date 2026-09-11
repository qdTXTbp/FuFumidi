// ============================================================
// 主进程 Python 引擎服务
// 负责：一次性脚本执行、常驻 worker、内联 Python、子进程清理
// ============================================================
'use strict';
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function createEngineService({ resolvePython, engineDir, engineEnv }) {
  const activeChildren = new Set();
  // worker 池：slot 0 为常驻主 worker；slot>0 为并行转录临时 worker（空闲自动回收）
  const _workers = new Map();      // slot -> child
  const _workerIdle = new Map();   // slot -> 回收定时器
  let _engineWorkerSeq = 0;
  const _engineWorkerPending = new Map();  // 请求 id -> { resolve, reject, win, logId, child }
  const WORKER_IDLE_MS = 120000;   // 并行 worker 空闲 2 分钟后退出，释放模型内存

  function reapWorker(slot) {
    const t = _workerIdle.get(slot);
    if (t) { clearTimeout(t); _workerIdle.delete(slot); }
    if (slot > 0) {
      _workerIdle.set(slot, setTimeout(() => {
        _workerIdle.delete(slot);
        const child = _workers.get(slot);
        if (child && !workerBusy(child)) { _workers.delete(slot); try { child.kill(); } catch (e) {} }
      }, WORKER_IDLE_MS));
    }
  }

  // 该 worker 是否仍有在途请求
  function workerBusy(child) {
    for (const p of _engineWorkerPending.values()) if (p.child === child) return true;
    return false;
  }

  function spawnEngine(pyArgs, opts = {}) {
    const { script = 'music2midi.py', onLog, onProgress, onDone, onError, timeoutMs = 30 * 60 * 1000 } = opts;
    const py = resolvePython();
    const eng = engineDir();
    const scriptPath = path.isAbsolute(script) ? script : path.join(eng, script);
    const child = spawn(py, [scriptPath, ...pyArgs], {
      cwd: eng,
      windowsHide: true,
      env: engineEnv(),
    });
    activeChildren.add(child);
    try { if (process.platform === 'win32') os.setPriority(child.pid, -1); } catch (e) {}
    let outBuf = '', errBuf = '';
    let result = null;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      try { fn(); } catch {}
    };
    const pumpOut = (d) => {
      outBuf += d.toString('utf8');
      const lines = outBuf.split(/\r?\n/);
      outBuf = lines.pop();
      for (const l of lines) {
        const t = l.trim();
        if (!t) continue;
        const m = t.match(/^###RESULT\s+(\{.*\})\s*$/);
        if (m) { try { result = JSON.parse(m[1]); } catch {} continue; }
        const p = t.match(/^###PROG\s+(\{.*\})\s*$/);
        if (p) { try { onProgress && onProgress(JSON.parse(p[1])); } catch {} continue; }
        try { onLog && onLog(t); } catch {}
      }
    };
    const pumpErr = (d) => { errBuf += d.toString('utf8'); };
    child.stdout.on('data', pumpOut);
    child.stderr.on('data', pumpErr);
    child.on('error', (e) => finish(() => onError && onError(String(e))));
    child.on('close', (code) => {
      activeChildren.delete(child);
      finish(() => onDone && onDone(code, { result, out: outBuf, err: errBuf }));
    });
    const timer = setTimeout(() => finish(() => onError && onError('引擎执行超时，已强制终止')), timeoutMs);
    return child;
  }

  function stopEngineWorker() {
    const olds = [..._workers.values()];
    _workers.clear();
    for (const t of _workerIdle.values()) { try { clearTimeout(t); } catch (e) {} }
    _workerIdle.clear();
    for (const c of olds) { if (c && !c.killed) { try { c.kill(); } catch (e) {} } }
    const err = new Error('engine worker restarted');
    for (const p of _engineWorkerPending.values()) { try { p.reject(err); } catch (e) {} }
    _engineWorkerPending.clear();
    return new Promise((resolve) => {
      const alive = olds.filter(c => c && c.exitCode === null);
      if (!alive.length) { resolve(); return; }
      let left = alive.length;
      const timer = setTimeout(() => resolve(), 5000);
      for (const c of alive) c.once('close', () => { if (--left <= 0) { clearTimeout(timer); resolve(); } });
    });
  }

  function ensureEngineWorker(slot = 0) {
    const cur = _workers.get(slot);
    if (cur && !cur.killed && cur.exitCode === null) return cur;
    const py = resolvePython();
    const eng = engineDir();
    const child = spawn(py, [path.join(eng, 'music2midi.py'), 'worker'], {
      cwd: eng,
      windowsHide: true,
      env: engineEnv(),
    });
    let buf = '';
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const l of lines) {
        const t = l.trim(); if (!t) continue;
        if (t.startsWith('###LOG ')) {
          try {
            const lg = JSON.parse(t.slice(6));
            const logId = lg && lg._id;
            const ent = logId ? _engineWorkerPending.get(logId) : null;
            if (ent && ent.win && !ent.win.isDestroyed() && ent.logId) {
              ent.win.webContents.send('engine:log', { id: ent.logId, line: lg.line || '' });
            }
          } catch (e) {}
          continue;
        }
        if (t.startsWith('###RESULT ')) {
          try {
            const r = JSON.parse(t.slice(10));
            const id = r && r._id;
            if (id && _engineWorkerPending.has(id)) {
              const p = _engineWorkerPending.get(id);
              _engineWorkerPending.delete(id);
              p.resolve(r);
            }
          } catch (e) {}
        }
      }
    });
    child.stderr.on('data', () => {});
    // 池化：子进程异常退出只清理自己的在途请求，不影响其他槽位
    const failOne = (err) => {
      if (_workers.get(slot) !== child) return;
      _workers.delete(slot);
      const t = _workerIdle.get(slot);
      if (t) { clearTimeout(t); _workerIdle.delete(slot); }
      for (const [id, p] of [..._engineWorkerPending.entries()]) {
        if (p.child === child) { _engineWorkerPending.delete(id); try { p.reject(err); } catch (e) {} }
      }
    };
    child.on('error', e => failOne(new Error('engine worker error: ' + e)));
    child.on('close', () => failOne(new Error('engine worker exited')));
    _workers.set(slot, child);
    return child;
  }

  function engineWorkerConvert(cfg) {
    // 并行槽位配额：__slots 为渲染端并行路数（1-4）。GPU 环境显存有限，自动降 1 路；
    // CPU 环境用满配额。在配额内挑选在途请求最少的 worker 槽位，尽量并行不串队。
    let slots = Math.max(1, Math.min(4, parseInt(cfg.__slots, 10) || 1));
    try {
      const env = engineEnv();
      if (env && env.FUFUMIDI_DISABLE_GPU !== '1') slots = Math.max(1, slots - 1); // GPU：自动降 1
    } catch (e) {}
    const load = new Map();
    for (let s = 0; s < slots; s++) load.set(s, 0);
    for (const p of _engineWorkerPending.values()) {
      for (const [s, c] of _workers.entries()) {
        if (p.child === c) load.set(s, (load.get(s) || 0) + 1);
      }
    }
    let best = 0, bestLoad = Infinity;
    for (let s = 0; s < slots; s++) {
      const l = load.get(s) || 0;
      if (l < bestLoad) { bestLoad = l; best = s; }
    }
    const child = ensureEngineWorker(best);
    reapWorker(best);
    const id = 'w' + (++_engineWorkerSeq);
    const req = {
      _id: id,
      audio: cfg.audio,
      out: cfg.out,
      mode: cfg.mode || 'universal',
      perf: cfg.perf || 'quality',
    };
    const map = { onset_threshold:'onset_threshold', frame_threshold:'frame_threshold', min_note_length:'min_note_length', min_note_ms:'min_note_ms', merge_gap_ms:'merge_gap_ms', tempo:'tempo', stem_format:'stem_format', model:'model', model_size:'model_size', muscriptor_batch:'muscriptor_batch', min_freq:'min_freq', beat_grid:'beat_grid' };
    for (const [k, rk] of Object.entries(map)) if (cfg[k] != null) req[rk] = cfg[k];
    for (const k of ['denoise','normalize','auto_bpm','no_merge','no_velnorm','with_drums','export_stems','no_pedal','no_melodia']) if (cfg[k]) req[k] = true;
    const p = new Promise((resolve, reject) => { _engineWorkerPending.set(id, { resolve, reject, win: cfg.__win, logId: cfg.__logId || cfg.id, child }); });
    child.stdin.write(JSON.stringify(req) + '\n');
    return p;
  }

  function runEngineInline(code) {
    const py = resolvePython();
    const eng = engineDir();
    return new Promise((resolve) => {
      const child = spawn(py, ['-c', code], {
        cwd: eng,
        windowsHide: true,
        env: engineEnv(),
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { out += d.toString('utf8'); });
      child.on('error', (e) => resolve({ ok: false, code: -1, out, error: String(e) }));
      child.on('close', (code) => resolve({ ok: code === 0, code, out }));
    });
  }

  function killAll() {
    for (const c of activeChildren) { try { c.kill(); } catch {} }
  }

  return {
    spawnEngine,
    stopEngineWorker,
    engineWorkerConvert,
    runEngineInline,
    killAll,
    activeChildren,
  };
}

module.exports = { createEngineService };

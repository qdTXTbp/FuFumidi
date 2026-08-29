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
  let _engineWorker = null;
  let _engineWorkerSeq = 0;
  const _engineWorkerPending = new Map();

  function spawnEngine(pyArgs, opts = {}) {
    const { script = 'music2midi.py', onLog, onDone, onError, timeoutMs = 30 * 60 * 1000 } = opts;
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
    const old = _engineWorker;
    _engineWorker = null;
    if (old && !old.killed) { try { old.kill(); } catch (e) {} }
    const err = new Error('engine worker restarted');
    for (const p of _engineWorkerPending.values()) { try { p.reject(err); } catch (e) {} }
    _engineWorkerPending.clear();
    return new Promise((resolve) => {
      if (!old || old.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => resolve(), 5000);
      old.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  function ensureEngineWorker() {
    if (_engineWorker && !_engineWorker.killed) return _engineWorker;
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
    const failAll = (err) => {
      if (_engineWorker !== child) return;
      _engineWorker = null;
      for (const p of _engineWorkerPending.values()) p.reject(err);
      _engineWorkerPending.clear();
    };
    child.on('error', e => failAll(new Error('engine worker error: ' + e)));
    child.on('close', () => failAll(new Error('engine worker exited')));
    _engineWorker = child;
    return child;
  }

  function engineWorkerConvert(cfg) {
    const child = ensureEngineWorker();
    const id = 'w' + (++_engineWorkerSeq);
    const req = {
      _id: id,
      audio: cfg.audio,
      out: cfg.out,
      mode: cfg.mode || 'universal',
      perf: cfg.perf || 'quality',
    };
    const map = { onset_threshold:'onset_threshold', frame_threshold:'frame_threshold', min_note_length:'min_note_length', min_note_ms:'min_note_ms', merge_gap_ms:'merge_gap_ms', tempo:'tempo', stem_format:'stem_format', model:'model', model_size:'model_size' };
    for (const [k, rk] of Object.entries(map)) if (cfg[k] != null) req[rk] = cfg[k];
    for (const k of ['denoise','normalize','auto_bpm','no_merge','no_velnorm','with_drums','export_stems','no_pedal']) if (cfg[k]) req[k] = true;
    const p = new Promise((resolve, reject) => { _engineWorkerPending.set(id, { resolve, reject, win: cfg.__win, logId: cfg.__logId || cfg.id }); });
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

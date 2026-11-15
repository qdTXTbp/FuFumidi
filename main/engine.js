// ============================================================
// 主进程 Python 引擎服务
// 负责：一次性脚本执行、常驻 worker、内联 Python、子进程清理
// ============================================================
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const Paths = require('./paths');
const { createSupervisor } = require('./engine_supervisor');

function createEngineService({ resolvePython, engineDir, engineEnv }) {
  const activeChildren = new Set();
  // worker 池：slot 0 为常驻主 worker；slot>0 为并行转录临时 worker（空闲自动回收）
  const _workers = new Map();      // slot -> child
  const _workerIdle = new Map();   // slot -> 回收定时器
  const _workerSupervisors = new Map();  // slot -> 守护（readiness / 退避 / 熔断）
  let _engineWorkerSeq = 0;
  const _engineWorkerPending = new Map();  // 请求 id -> { resolve, reject, win, logId, child }
  const _sessions = new Set();             // 常驻引擎会话（cancelJob 需要逐个问）
  const WORKER_IDLE_MS = 120000;   // 并行 worker 空闲 2 分钟后退出，释放模型内存

  function reapWorker(slot) {
    const t = _workerIdle.get(slot);
    if (t) { clearTimeout(t); _workerIdle.delete(slot); }
    if (slot > 0) {
      _workerIdle.set(slot, setTimeout(() => {
        _workerIdle.delete(slot);
        const child = _workers.get(slot);
        if (child && !workerBusy(child)) {
          // ★ 空闲回收是主动行为，不算崩溃：先告诉守护，别把这笔记进熔断
          const sup = _workerSupervisors.get(slot);
          if (sup) sup.stop();
          _workerSupervisors.delete(slot);
          _workers.delete(slot);
        }
      }, WORKER_IDLE_MS));
    }
  }

  // 该 worker 是否仍有在途请求
  function workerBusy(child) {
    for (const p of _engineWorkerPending.values()) if (p.child === child) return true;
    return false;
  }

  function spawnEngine(pyArgs, opts = {}) {
    // env：允许调用方覆盖环境变量（翻唱工作流要把 FUFUMIDI_MODELS_DIR 指过去，
    // 让 engine_cover / engine_rvc 能找到导入的翻唱模型）。
    // ★ idleTimeoutMs：**无进展**多久就判定卡死（0 = 不启用）。
    //   长音频分离/翻唱动辄几十分钟，用总时长当超时会把正常的长任务当卡死杀掉
    //   （2026-10-17 实测：一场演唱会 FLAC 分离跑过 30 分钟被「引擎执行超时」干掉）。
    //   有 progress/log 输出就刷新计时，只有真的长时间一句话都没有才终止。
    const { script = 'music2midi.py', onLog, onProgress, onDone, onError, timeoutMs = 30 * 60 * 1000, idleTimeoutMs = 0, env: envOverride } = opts;
    const py = resolvePython();
    const eng = engineDir();
    const scriptPath = path.isAbsolute(script) ? script : path.join(eng, script);
    const child = spawn(py, [scriptPath, ...pyArgs], {
      cwd: eng,
      windowsHide: true,
      env: envOverride || engineEnv(),
    });
    activeChildren.add(child);
    try { if (process.platform === 'win32') os.setPriority(child.pid, -1); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    let outBuf = '', errBuf = '';
    let result = null;
    let settled = false;
    let _lastActivity = Date.now();   // 最近一次有输出的时刻（idle 看门狗用）
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      try { fn(); } catch {}
    };
    const pumpOut = (d) => {
      _lastActivity = Date.now();
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
    const pumpErr = (d) => { _lastActivity = Date.now(); errBuf += d.toString('utf8'); };
    child.stdout.on('data', pumpOut);
    child.stderr.on('data', pumpErr);
    child.on('error', (e) => finish(() => onError && onError(String(e))));
    child.on('close', (code) => {
      activeChildren.delete(child);
      finish(() => onDone && onDone(code, { result, out: outBuf, err: errBuf }));
    });
    // ★ 计时与「暂停/继续」配合（用户 2026-10-14 要求转录可暂停）：被暂停的进程还活着、
    //   只是零进展 —— 按真实时钟算，一次长暂停会被误判成「引擎执行超时，已强制终止」。
    //   所以只在**没被暂停**的时间段里扣预算。
    let _left = timeoutMs;
    let _last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const dt = now - _last;
      _last = now;
      let paused = false;
      try { paused = fs.existsSync(Paths.pauseFlagFile()); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      if (!paused) _left -= dt;
      // 暂停期间不算「无进展」：暂停本来就是零输出
      if (paused) _lastActivity = now;
      else if (idleTimeoutMs > 0 && now - _lastActivity >= idleTimeoutMs) {
        const mins = Math.round(idleTimeoutMs / 60000);
        finish(() => onError && onError('引擎已 ' + mins + ' 分钟没有任何进展，判定卡死并终止（长音频建议先裁剪片段再处理）'));
        return;
      }
      if (_left <= 0) finish(() => onError && onError('引擎执行超时，已强制终止'));
    }, 1000);
    return child;
  }

  function stopEngineWorker() {
    const olds = [..._workers.values()];
    // ★ 主动停不算崩溃：先停守护（同时清掉崩溃/退避计数），再统一清池
    for (const sup of _workerSupervisors.values()) { try { sup.stop(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
    _workerSupervisors.clear();
    _workers.clear();
    for (const t of _workerIdle.values()) { try { clearTimeout(t); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
    _workerIdle.clear();
    for (const c of olds) { if (c && !c.killed) { try { c.kill(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } } }
    const err = new Error('engine worker restarted');
    for (const p of _engineWorkerPending.values()) { try { p.reject(err); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
    _engineWorkerPending.clear();
    return new Promise((resolve) => {
      const alive = olds.filter(c => c && c.exitCode === null);
      if (!alive.length) { resolve(); return; }
      let left = alive.length;
      const timer = setTimeout(() => resolve(), 5000);
      for (const c of alive) c.once('close', () => { if (--left <= 0) { clearTimeout(timer); resolve(); } });
    });
  }

  /** worker 单行协议。★ `###READY` 已由守护消费，这里只处理 LOG / RESULT。 */
  function handleWorkerLine(t) {
    if (t.startsWith('###LOG ')) {
      try {
        const lg = JSON.parse(t.slice(6));
        const logId = lg && lg._id;
        const ent = logId ? _engineWorkerPending.get(logId) : null;
        const _line = lg.line || '';
        if (ent && ent.task) {
          try {
            const _pm = /^###PROG\s+(\{.*\})/.exec(String(_line).trim());
            if (_pm) {
              const _d = JSON.parse(_pm[1]);
              const _total = Number(_d.total) || 0;
              const _done = Number(_d.completed) || 0;
              // 单调保护：任务中心的 progress 是直接赋值，引擎的阶段切换
              // （如 MIROS 先打 percent=14，再打 completed:0/total:N）会让它倒退。
              const _push = (v, txt) => {
                const _v = Math.max(0, Math.min(1, Number(v) || 0));
                const _prev = Number(ent._prog) || 0;
                ent._prog = Math.max(_prev, _v);
                ent.task.progress(ent._prog, txt);
              };
              // percent 优先：它是引擎算好的**总进度**（阶段权重已计入）。
              // 只有 completed/total 的老引擎（MuScriptor）走下面的分块比例。
              if (_d.percent != null) {
                const _p = Math.max(0, Math.min(100, Number(_d.percent) || 0));
                const _lab = _d.label ? String(_d.label) : '处理中';
                _push(_p / 100, _lab + ' ' + Math.round(_p) + '%');
              } else if (_total > 0) {
                _push(_done / _total, '推理中 ' + Math.round(_done / _total * 100) + '%');
              }
            } else if (/^\[(预处理|体检|模型|分段探测|推理|音频证据|节拍|收尾|计时|内存)/.test(String(_line).trim()) || String(_line).includes('使用 GPU')) {
              ent.task.log(_line);
            }
          } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
        }
        if (ent && ent.win && !ent.win.isDestroyed() && ent.logId) {
          ent.win.webContents.send('engine:log', { id: ent.logId, line: _line });
        }
      } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      return;
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
      } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    }
  }

  /** 某个 worker 崩了：只清理属于它的在途请求，不影响其他槽位 */
  function failWorker(slot, err, exitedChild) {
    if (_workers.get(slot) !== exitedChild) return;
    _workers.delete(slot);
    const t = _workerIdle.get(slot);
    if (t) { clearTimeout(t); _workerIdle.delete(slot); }
    for (const [id, p] of [..._engineWorkerPending.entries()]) {
      if (p.child === exitedChild) {
        _engineWorkerPending.delete(id);
        try { p.reject(err); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      }
    }
  }

  /**
   * 每个槽位一个守护：readiness / 退避 / 熔断（FLAD-05）。
   * ★ 只守护进程生命周期：崩溃时在途请求照旧 reject，由调用方回退一次性路径，
   *   superviser 不会替用户重放任务（重放会把转录跑两遍）。
   */
  function workerSupervisor(slot) {
    let sup = _workerSupervisors.get(slot);
    if (sup) return sup;
    sup = createSupervisor({
      name: 'worker#' + slot,
      spawnChild: () => {
        const py = resolvePython();
        const eng = engineDir();
        const child = spawn(py, [path.join(eng, 'music2midi.py'), 'worker'], {
          cwd: eng,
          windowsHide: true,
          env: engineEnv(),
        });
        activeChildren.add(child);
        _workers.set(slot, child);
        return child;
      },
      onLine: handleWorkerLine,
      onExit: (err, exited) => {
        activeChildren.delete(exited);
        if (_workers.get(slot) === exited) _workers.delete(slot);
        // err === null：守护被主动 stop（空闲回收 / 取消 / 切换引擎），不算崩溃
        if (!err) return;
        failWorker(slot, err, exited);
      },
      log: (level, msg) => { try { require('./log').write(level, msg); } catch (e) { /* 日志失败不影响引擎 */ } },
    });
    _workerSupervisors.set(slot, sup);
    return sup;
  }

  async function ensureEngineWorker(slot = 0) {
    const sup = workerSupervisor(slot);
    const child = await sup.ensure();
    reapWorker(slot);
    return child;
  }

  async function engineWorkerConvert(cfg) {
    // 并行槽位配额：__slots 为渲染端并行路数（1-4）。GPU 环境显存有限，自动降 1 路；
    // CPU 环境用满配额。在配额内挑选在途请求最少的 worker 槽位，尽量并行不串队。
    let slots = Math.max(1, Math.min(4, parseInt(cfg.__slots, 10) || 1));
    try {
      const env = engineEnv();
      if (env && env.FUFUMIDI_DISABLE_GPU !== '1') slots = Math.max(1, slots - 1); // GPU：自动降 1
    } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
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
    const child = await ensureEngineWorker(best);
    reapWorker(best);
    const id = 'w' + (++_engineWorkerSeq);
    const req = {
      _id: id,
      audio: cfg.audio,
      out: cfg.out,
      mode: cfg.mode || 'universal',
      perf: cfg.perf || 'quality',
    };
    // 注意：这里漏一个键，渲染端设了也到不了引擎 —— 乐器组约束（muscriptor_instruments）
    // 之前就是漏在这张表里，界面选「人声」完全没有效果。
    // ★ 2026-11-07：标签模型 / 探测段长 / 自定义生成参数（batch·temperature·
    //   cfg_coef·beam_size·precision）随回退移除，引擎不认。
    // ★ 2026-11-08：恢复官方 `instruments` 硬约束（对照官方 API 与第三方 --instrument），
    //   它是「跨块鼓组/音色不稳定」的唯一官方杠杆；默认不传 = 官方自动识别。
    // ★ 2026-11-10：加官方解码档位（greedy / sample），默认 greedy 不改变任何行为。
    const map = { denoise_mode:'denoise_mode', onset_threshold:'onset_threshold', frame_threshold:'frame_threshold', min_note_length:'min_note_length', min_note_ms:'min_note_ms', merge_gap_ms:'merge_gap_ms', tempo:'tempo', stem_format:'stem_format', model:'model', model_size:'model_size', min_freq:'min_freq', max_freq:'max_freq', muscriptor_instruments:'muscriptor_instruments', muscriptor_decode:'muscriptor_decode',
      // ★ 2026-10-21 审计抓到：静音分段的五个键在引擎侧全都有（argparse + Namespace + params），
      //   但**这张表里一个都没有** —— 界面上「跳过静音分段（长音频加速）」因此一直是死的。
      segment_sec:'segment_sec', memory_mode:'memory_mode', max_note_hold:'max_note_hold' };
    for (const [k, rk] of Object.entries(map)) if (cfg[k] != null) req[rk] = cfg[k];
    for (const k of ['denoise','normalize','auto_bpm','no_merge','no_velnorm','with_drums','export_stems','no_pedal','no_melodia','multiple_pitch_bends','timbre_stabilize']) if (cfg[k]) req[k] = true;
    const p = new Promise((resolve, reject) => { _engineWorkerPending.set(id, { resolve, reject, win: cfg.__win, logId: cfg.__logId || cfg.id, task: cfg.__task || null, child }); });
    try {
      child.stdin.write(JSON.stringify(req) + '\n');
    } catch (e) {
      // 进程刚好在这一瞬没了：别把请求留在账上（否则取消/统计都会看到幽灵请求）
      _engineWorkerPending.delete(id);
      throw e;
    }
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

  /**
   * 常驻引擎会话：stdin JSON 行驱动引擎的 `serve` 子命令（engine_server.py）。
   *
   * 省 Python 启动 + torch import + 声库/模型加载的固定开销（调参时 3-6s/次）。
   * 协议：请求 `{id, argv}` → `###RESULT {..., id}`；进度 `###PROG {..., id}`。
   * ★ 进程崩溃不重试 —— reject 本次请求，由调用方回退一次性 spawn（功能永远
   *   可用，只是慢）；下一次 request 会自动重启进程。
   */
  function createEngineSession(script, serveArgs) {
    const py = resolvePython();
    const eng = engineDir();
    const scriptPath = path.isAbsolute(script) ? script : path.join(eng, script);
    let child = null;
    let seq = 0;
    let buf = '';
    const pending = new Map();   // 请求 id -> { resolve, reject, timer, onProgress }

    function start() {
      child = spawn(py, [scriptPath, ...serveArgs], {
        cwd: eng,
        windowsHide: true,
        env: engineEnv(),
      });
      activeChildren.add(child);
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) {
          const t = l.trim();
          if (!t) continue;
          let m = t.match(/^###RESULT\s+(\{.*\})\s*$/);
          if (m) {
            let r = null;
            try { r = JSON.parse(m[1]); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
            if (r && r.id != null && pending.has(r.id)) {
              const p = pending.get(r.id);
              pending.delete(r.id);
              clearTimeout(p.timer);
              p.resolve(r);
            }
            continue;
          }
          m = t.match(/^###PROG\s+(\{.*\})\s*$/);
          if (m) {
            try {
              const pr = JSON.parse(m[1]);
              const w = (pr.id != null && pending.get(pr.id)) || null;
              if (w && w.onProgress) w.onProgress(pr);
            } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
            continue;
          }
          // 普通日志：常驻会话的输出按请求粒度投递，独立日志行丢弃
          //（一次性路径才有 onLog 流，避免重复刷屏）
        }
      });
      child.stderr.on('data', () => {});
      child.on('close', () => {
        child = null;
        // 进程死了：所有挂起请求按失败结算（调用方回退一次性路径）
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error('engine session closed'));
        }
        pending.clear();
      });
      child.on('error', () => { /* close 会跟着来，在那里清场 */ });
    }

    function request(argv, opts = {}) {
      const { onProgress, timeoutMs = 30 * 60 * 1000 } = opts;
      return new Promise((resolve, reject) => {
        if (!child) start();
        const id = ++seq;
        const p = {
          resolve, reject, onProgress,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(new Error('engine session request timeout'));
          }, timeoutMs),
        };
        pending.set(id, p);
        try {
          child.stdin.write(JSON.stringify({ id, argv }) + '\n');
        } catch (e) {
          pending.delete(id);
          clearTimeout(p.timer);
          reject(e);
        }
      });
    }

    function kill() {
      _sessions.delete(handle);
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('session killed')); }
      pending.clear();
      const c = child;
      child = null;
      if (c) {
        // 先礼貌要退出（给引擎 flush 的机会），2s 后硬杀
        try { c.stdin.write('{"cmd": "exit"}\n'); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
        setTimeout(() => { try { c.kill(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }, 2000);
      }
    }

    /** 中止该会话里某个在途请求（返回是否命中）。 */
    function cancel(id) {
      const p = pending.get(id);
      if (!p) return false;
      clearTimeout(p.timer);
      pending.delete(id);
      const err = new Error('canceled');
      err.canceled = true;
      try { p.reject(err); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      return true;
    }

    const handle = { request, kill, cancel };
    _sessions.add(handle);
    return handle;
  }

  /**
   * 取消一个在跑的任务（worker 路径 + 常驻会话路径）。
   *
   * ★ 为什么必须在这里做：转录走的是 worker 路径（_engineWorkerPending 记账），
   *   而 engine:cancel 原来只查 task-queue 的 convertChildren（spawn 路径）——
   *   两条路径各记各的账，于是「取消转录」对 worker 路径永远返回 { ok: false }，
   *   前端点了没反应、正在跑的转录照旧跑完。
   */
  function cancelJob(id) {
    let hit = false;
    // ★ 两本账都查：worker 路径按**内部键** 'w<N>' 记 _engineWorkerPending，
    //   而渲染端只知道自己的 jobId（'batch7' 这种），它被记在 logId 里。
    //   只查内部键的话，前端点「取消转录」永远落空 —— 正在跑的转录照旧跑完
    //   （2026-07 修过一次"只查 spawn 路径"，这次是同一条链路上的**第二处漏配**）。
    let key = _engineWorkerPending.has(id) ? id : null;
    if (!key) {
      for (const [k, ent] of _engineWorkerPending) {
        if (ent && (ent.logId === id || String(ent.logId) === String(id))) { key = k; break; }
      }
    }
    if (key) {
      const p = _engineWorkerPending.get(key);
      _engineWorkerPending.delete(key);
      // ★ 必须带 canceled 标记：task-queue 的 worker 回落分支靠它区分
      //   "被取消" 与 "worker 崩了" —— 否则取消会触发回落、另起一个进程重跑。
      const err = new Error('canceled');
      err.canceled = true;
      try { p.reject(err); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      // 杀掉 worker 进程才算真停：python 那边一旦开始解码，只 reject Promise 不会让它停手。
      // ★ 走守护的 stop（主动停止不计崩溃），否则取消会被算成一次引擎崩溃、触发退避/熔断。
      try {
        let slot = -1;
        for (const [s, c] of _workers.entries()) if (c === p.child) { slot = s; break; }
        const sup = slot >= 0 ? _workerSupervisors.get(slot) : null;
        if (sup) sup.stop();
        else if (p.child && !p.child.killed && p.child.exitCode === null) p.child.kill();
      } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      hit = true;
    }
    for (const s of _sessions) { try { if (s.cancel(id)) hit = true; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
    return hit;
  }

  return {
    spawnEngine,
    stopEngineWorker,
    cancelJob,
    engineWorkerConvert,
    runEngineInline,
    createEngineSession,
    killAll,
    activeChildren,
  };
}

module.exports = { createEngineService };

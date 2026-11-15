// ============================================================
// 引擎子进程守护（FLAD-05 骨架）
//
// 解决的问题：引擎子进程崩掉后，原来是「下一次请求自然重启」——没有节奏控制。
// 如果崩溃是必现的（坏模型/坏依赖/权限），用户每点一次就炸一次，日志被刷屏、
// 任务中心堆满同样的失败。这里补上三件事：
//
//   · readiness：等引擎打出 `###READY` 才算"起来了"（带超时兜底旧引擎目录）；
//   · 退避：连续崩溃时按 指数退避（600ms → 1.2s → 2.4s …）再重启；
//   · 熔断：时间窗内崩溃 N 次就暂停重启一段时间，失败要快、原因要说清楚。
//
// ★ 只负责"进程生命周期"，不重放任务：已经发出去的请求在崩溃时由调用方
//   reject/回退——重放可能把转录跑两遍，那是更坏的结果。
//
// ★ 纯逻辑（backoffDelay / circuitState）与进程无关，单独导出给单测用；
//   真实崩溃测试成本高，先用假 spawn + 假时钟把状态机钉住。
// ============================================================
'use strict';

const READY_LINE = '###READY';

const DEFAULT_POLICY = Object.freeze({
  /** 等 `###READY` 的上限；超时按"可用"继续，兼容没有该标记的旧引擎目录 */
  readyTimeoutMs: 15 * 1000,
  /** 第一次崩溃后的等待，之后每次翻倍 */
  restartBaseMs: 600,
  /** 退避上限 */
  restartMaxMs: 8000,
  /** 熔断统计窗口 */
  crashWindowMs: 60 * 1000,
  /** 窗口内崩溃次数达到该值 → 熔断 */
  crashThreshold: 3,
  /** 熔断后暂停重启的时长 */
  openMs: 30 * 1000,
});

/**
 * 第 `attempt` 次连续重启前该等多久（attempt 从 1 开始）。
 * 1 → base，2 → 2·base，3 → 4·base … 上限 restartMaxMs。
 */
function backoffDelay(attempt, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const n = Math.floor(Number(attempt) || 0);
  if (n <= 0) return 0;
  return Math.min(p.restartMaxMs, p.restartBaseMs * Math.pow(2, n - 1));
}

/**
 * 根据崩溃时刻列表判断熔断状态。
 *
 * 窗口从**最后一次**崩溃往前算：半开期再炸一次会重新计一个完整冷却，
 * 不会出现"刚放行马上又炸、马上又放行"的抖动。
 */
function circuitState(crashes, now, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const recent = (crashes || []).filter((t) => now - t < p.crashWindowMs);
  const last = recent.length ? recent[recent.length - 1] : 0;
  const until = recent.length >= p.crashThreshold ? last + p.openMs : 0;
  return { recent, open: until > now, until };
}

function createSupervisor(opts) {
  const {
    name = 'engine',
    spawnChild,
    onLine = () => {},
    onExit = () => {},
    policy = {},
    log = () => {},
    now = Date.now,
    setTimeout: setT = setTimeout,
    clearTimeout: clearT = clearTimeout,
    sleep = (ms) => new Promise((resolve) => setT(resolve, ms)),
  } = opts;
  const p = { ...DEFAULT_POLICY, ...policy };

  let child = null;
  let state = 'idle';        // idle | starting | ready | open | stopped
  let crashes = [];
  let failStreak = 0;        // 连续崩溃次数（ready 后归零）→ 退避档位
  let starts = 0;            // 累计启动次数（诊断用）
  let readyTimer = null;
  let stopFlag = false;
  let buf = '';
  let inflight = null;

  function logLine(level, msg) {
    try { log(level, '[supervisor:' + name + '] ' + msg); } catch (e) { /* 日志绝不反向影响守护 */ }
  }

  function clearReadyTimer() {
    if (readyTimer) { clearT(readyTimer); readyTimer = null; }
  }

  function markReady(why) {
    if (state !== 'starting') return;
    state = 'ready';
    clearReadyTimer();
    failStreak = 0;
    crashes = [];
    logLine('INFO', 'ready' + (why ? ' (' + why + ')' : ''));
  }

  function handleChunk(chunk) {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      if (t === READY_LINE) { markReady(); continue; }
      try { onLine(t, child); } catch (e) {
        logLine('WARN', 'onLine 失败: ' + ((e && e.message) || e));
      }
    }
  }

  function spawnNow() {
    state = 'starting';
    stopFlag = false;
    starts += 1;
    const c = spawnChild();
    child = c;
    buf = '';
    try {
      c.stdout.on('data', handleChunk);
      c.stderr.on('data', () => {});
    } catch (e) {
      logLine('ERROR', '挂接 stdout 失败: ' + ((e && e.message) || e));
    }
    c.on('error', (e) => handleExit(c, 'error: ' + e));
    c.on('close', (code) => handleExit(c, 'close code=' + code));
    readyTimer = setT(() => {
      readyTimer = null;
      if (child !== c || state !== 'starting') return;
      // 旧引擎目录没有 ###READY：stdin 会缓冲，直接发请求也能跑。
      // 这里按"可用"继续，但必须留痕 —— 否则启动异常会变成无声故障。
      logLine('WARN', 'ready 标记 ' + p.readyTimeoutMs + 'ms 未出现，按可用继续（旧引擎目录？）');
      markReady('timeout');
    }, p.readyTimeoutMs);
    return c;
  }

  function handleExit(c, reason) {
    if (child !== c) return;           // 旧进程的迟到事件
    clearReadyTimer();
    const wasStop = stopFlag;
    child = null;
    buf = '';
    if (state === 'stopped') return;
    if (wasStop) {
      state = 'stopped';
      onExit(null, c);
      return;
    }
    state = 'idle';
    const ts = now();
    failStreak += 1;
    crashes.push(ts);
    logLine('WARN', 'exited: ' + reason);
    const cs = circuitState(crashes, ts, p);
    if (cs.open) {
      state = 'open';
      logLine('ERROR', '窗口内崩溃 ' + cs.recent.length + ' 次，熔断 ' + p.openMs + 'ms');
    }
    try { onExit(new Error(reason), c); } catch (e) {
      logLine('WARN', 'onExit 失败: ' + ((e && e.message) || e));
    }
  }

  async function _ensure() {
    if (state === 'stopped') state = 'idle';
    if (child && (state === 'starting' || state === 'ready')) return child;

    if (state === 'open') {
      const cs = circuitState(crashes, now(), p);
      if (cs.open) {
        const err = new Error('引擎连续崩溃，已暂停重启（约 ' + Math.ceil((cs.until - now()) / 1000) + 's 后自动重试）');
        err.code = 'ENGINE_CIRCUIT_OPEN';
        throw err;
      }
      state = 'idle';
      logLine('INFO', '熔断冷却结束，尝试重启');
    }

    // 退避：只等"距上次崩溃还没睡够"的差额，别在用户点了重试后再多等一整个间隔
    if (failStreak > 0 && crashes.length) {
      const wait = backoffDelay(failStreak, p) - (now() - crashes[crashes.length - 1]);
      if (wait > 0) {
        logLine('INFO', '退避 ' + Math.round(wait) + 'ms 后重启');
        await sleep(wait);
      }
    }
    if (state === 'stopped') throw new Error('engine supervisor stopped');
    return spawnNow();
  }

  /**
   * 拿到一个可用的子进程：已就绪/正在启动直接复用；否则按退避/熔断策略启动。
   * 启动失败与熔断都以 reject 结束，错误带 `code` 方便调用方区分。
   */
  function ensure() {
    if (inflight) return inflight;
    inflight = _ensure().finally(() => { inflight = null; });
    return inflight;
  }

  /** 主动停止（空闲回收/切换引擎）：不计入崩溃、不触发熔断 */
  function stop() {
    state = 'stopped';
    stopFlag = true;
    clearReadyTimer();
    const c = child;
    child = null;
    buf = '';
    crashes = [];
    failStreak = 0;
    if (c) { try { c.kill(); } catch (e) { /* 进程可能已经退出 */ } }
  }

  function status() {
    return {
      name,
      state,
      child,
      starts,
      failStreak,
      crashes: crashes.slice(),
      circuit: circuitState(crashes, now(), p),
    };
  }

  return { ensure, stop, status, markReady };
}

module.exports = {
  READY_LINE,
  DEFAULT_POLICY,
  backoffDelay,
  circuitState,
  createSupervisor,
};

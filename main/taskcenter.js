// ============================================================
// C2 TaskCenter 长任务中心（v6.0.0 契约冻结版 · 实现）
// ============================================================
// 主进程：tasks.register({ id, kind, title, cancelable }) -> handle
//         handle.progress(0..1, text?) / handle.log(line) / handle.done(result) / handle.fail(err)
// 前端：window.fuBridge.tasks.list() / cancel(id)；事件 task:update（节流 10Hz）
// 任务模型：{ id, kind, title, status:'running'|'done'|'error'|'canceled', progress,
//            startedAt, endedAt, result?, error?, logs? }
//
// 规则（契约）：长任务必须登记；离开页面不丢（数据在**主进程**）；取消要真的中止
// （onCancel 由任务自己实现：杀子进程 / abort 下载）；完成后可带 jump 参数。
// 纯逻辑与 electron 解耦：createTaskCenter 可在 Node 里单测，registerTaskIpc 才 require electron。
'use strict';

function createTaskCenter(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const emitIntervalMs = Math.max(16, Number(opts.emitIntervalMs) || 100);   // 10Hz
  const retainMs = Number(opts.retainMs) || 24 * 60 * 60 * 1000;
  const maxTasks = Math.max(10, Number(opts.maxTasks) || 200);
  const maxLogs = Math.max(10, Number(opts.maxLogs) || 200);
  const tasks = new Map();
  let seq = 0;
  let dirty = false;
  let flushTimer = null;

  function snapshot(t) {
    return {
      id: t.id, kind: t.kind, title: t.title, status: t.status, progress: t.progress,
      startedAt: t.startedAt, endedAt: t.endedAt,
      result: t.result, error: t.error, logs: t.logs.slice(-maxLogs),
      cancelable: t.cancelable,
    };
  }
  /** 对外只给**可结构化克隆**的快照（内部对象带 onCancel 函数，直接回给 IPC 会报 "could not be cloned"） */
  function list() {
    return [...tasks.values()]
      .map(snapshot)
      .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1)
        || (b.startedAt - a.startedAt));
  }
  function flush() {
    if (!dirty) return;
    dirty = false;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    emit({ type: 'update', tasks: list() });
  }
  function markDirty() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, emitIntervalMs);
    if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
  }
  function prune() {
    const cutoff = now() - retainMs;
    for (const [id, t] of tasks) {
      if (t.status !== 'running' && t.endedAt && t.endedAt < cutoff) tasks.delete(id);
    }
    if (tasks.size <= maxTasks) return;
    const finished = [...tasks.values()].filter((t) => t.status !== 'running')
      .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    let over = tasks.size - maxTasks;
    for (const t of finished) { if (over <= 0) break; tasks.delete(t.id); over--; }
  }

  function register(spec = {}) {
    const id = String(spec.id || (spec.kind || 'task') + '-' + (++seq) + '-' + now());
    const t = {
      id, kind: String(spec.kind || 'task'), title: String(spec.title || id),
      status: 'running', progress: 0,
      startedAt: now(), endedAt: null, result: undefined, error: undefined,
      logs: [], cancelable: !!spec.cancelable, onCancel: typeof spec.onCancel === 'function' ? spec.onCancel : null,
    };
    tasks.set(id, t);
    prune();
    markDirty();
    const done = (status, patch) => {
      if (t.status !== 'running') return;
      t.status = status;
      t.endedAt = now();
      Object.assign(t, patch || {});
      dirty = true;   // 结束事件必须立即广播（不能依赖上一次 progress 留下的 dirty）
      flush();
      prune();
    };
    return {
      id,
      progress(p, text) {
        if (t.status !== 'running') return false;
        const v = Math.max(0, Math.min(1, Number(p) || 0));
        t.progress = v;
        if (text != null) { t.logs.push(String(text)); if (t.logs.length > maxLogs) t.logs.splice(0, t.logs.length - maxLogs); }
        markDirty();
        return true;
      },
      log(line) {
        if (t.status !== 'running') return false;
        t.logs.push(String(line == null ? '' : line));
        if (t.logs.length > maxLogs) t.logs.splice(0, t.logs.length - maxLogs);
        markDirty();
        return true;
      },
      done(result) { t.progress = 1; done('done', { result }); },
      fail(err) { done('error', { error: String((err && err.message) || err || 'unknown') }); },
      cancel() { return cancel(id); },
      snapshot() { return snapshot(t); },
    };
  }

  function cancel(id) {
    const t = tasks.get(String(id));
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'running') return { ok: false, error: '任务已结束' };
    if (!t.cancelable) return { ok: false, error: '该任务不可取消' };
    try { if (t.onCancel) t.onCancel(); } catch (e) { /* 取消回调异常也要把状态标掉 */ }
    t.status = 'canceled';
    t.endedAt = now();
    dirty = true;
    flush();
    prune();
    return { ok: true };
  }
  function get(id) { const t = tasks.get(String(id)); return t ? snapshot(t) : null; }
  function size() { return tasks.size; }
  function clear() { tasks.clear(); flush(); }
  function clearFinished() {
    let n = 0;
    for (const [id, t] of [...tasks]) {
      if (t.status !== 'running') { tasks.delete(id); n++; }
    }
    if (n) flush();
    return { ok: true, removed: n };
  }

  return { register, cancel, list, get, size, clear, clearFinished, flush };
}

/** 单例（主进程用）：main.js 创建并注入 emit（Electron 窗口广播） */
let _center = null;
function getTaskCenter(opts) {
  if (!_center) _center = createTaskCenter(opts || {});
  return _center;
}

/**
 * 注册 IPC（由 main.js 调用）。
 * E2E 模式额外注册 tasks:demo：造一个 2 秒的假任务（每秒 progress），用于自动化验证
 * 「进度 → 完成 / 取消」整条链路，不触碰真实业务。
 */
function registerTaskIpc({ ipcMain, center, e2e = false } = {}) {
  if (!ipcMain || !center) return;
  ipcMain.handle('tasks:list', () => center.list());
  ipcMain.handle('tasks:cancel', (_e, id) => center.cancel(id));
  ipcMain.handle('tasks:clearFinished', () => center.clearFinished());
  if (e2e) {
    const timers = new Map();
    ipcMain.handle('tasks:demo', (_e, opts) => {
      const o = opts || {};
      const h = center.register({ kind: 'demo', title: 'E2E 演示任务', cancelable: true, onCancel: () => {
        const tm = timers.get(h.id); if (tm) { clearInterval(tm); timers.delete(h.id); }
      } });
      let p = 0;
      const steps = Math.max(2, Number(o.steps) || 8);
      const tm = setInterval(() => {
        p += 1 / steps;
        if (p >= 1) {
          clearInterval(tm); timers.delete(h.id);
          h.done({ demo: true });
        } else h.progress(p, '演示进度 ' + Math.round(p * 100) + '%');
      }, Math.max(50, Number(o.intervalMs) || 250));
      if (typeof tm.unref === 'function') tm.unref();
      timers.set(h.id, tm);
      return { id: h.id };
    });
  }
}

module.exports = { createTaskCenter, getTaskCenter, registerTaskIpc };

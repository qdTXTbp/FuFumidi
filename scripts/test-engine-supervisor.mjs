// 引擎子进程守护（FLAD-05 骨架）。
//
// ★ 真实崩溃测试成本高、也不稳定，这里全部用「假 spawn + 假时钟」把状态机钉住：
//   · readiness 握手与超时兜底
//   · 连续崩溃的指数退避
//   · 窗口内崩溃 N 次的熔断 / 冷却后半开
//   · 主动 stop（取消、空闲回收）不能被误记成崩溃
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { backoffDelay, circuitState, createSupervisor, DEFAULT_POLICY } = require('../main/engine_supervisor.js');

function makeChild() {
  const ee = new EventEmitter();
  const child = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    exitCode: null,
    on: (ev, cb) => ee.on(ev, cb),
    kill() {
      if (this.killed) return;
      this.killed = true;
      setImmediate(() => { this.exitCode = 0; ee.emit('close', 0); });
    },
    line(t) { this.stdout.emit('data', Buffer.from(t + '\n')); },
    ready() { this.line('###READY'); },
    crash(code = 1) { this.exitCode = code; ee.emit('close', code); },
  };
  return child;
}

function harness(opts = {}) {
  let clock = 1000000;
  const children = [];
  const sleeps = [];
  const logs = [];
  const timers = [];
  const sup = createSupervisor({
    name: 'test',
    spawnChild: () => { const c = makeChild(); children.push(c); return c; },
    onLine: opts.onLine || (() => {}),
    onExit: opts.onExit || (() => {}),
    policy: { readyTimeoutMs: 5000, restartBaseMs: 600, restartMaxMs: 8000, crashWindowMs: 60000, crashThreshold: 3, openMs: 30000, ...(opts.policy || {}) },
    log: (level, msg) => logs.push([level, msg]),
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  });
  return {
    sup, children, sleeps, logs, timers,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    lastTimer: () => timers.filter((t) => !t.cleared && !t.fired).slice(-1)[0],
    fireReadyTimeout() { const t = this.lastTimer(); assert.ok(t, '没有待触发的 ready 定时器'); t.fired = true; t.fn(); },
  };
}

test('backoffDelay：指数退避并封顶', () => {
  assert.equal(backoffDelay(0), 0);
  assert.equal(backoffDelay(1), DEFAULT_POLICY.restartBaseMs);
  assert.equal(backoffDelay(2), DEFAULT_POLICY.restartBaseMs * 2);
  assert.equal(backoffDelay(3), DEFAULT_POLICY.restartBaseMs * 4);
  assert.equal(backoffDelay(99), DEFAULT_POLICY.restartMaxMs);
  assert.equal(backoffDelay(2, { restartBaseMs: 100, restartMaxMs: 150 }), 150);
});

test('circuitState：窗口内达到阈值才熔断，且从最后一次崩溃起算冷却', () => {
  const policy = { crashWindowMs: 10000, crashThreshold: 3, openMs: 5000 };
  let s = circuitState([0, 100], 300, policy);
  assert.equal(s.open, false);

  s = circuitState([0, 100, 200], 300, policy);
  assert.equal(s.open, true);
  assert.equal(s.until, 200 + 5000);

  // 冷却结束 = 半开
  s = circuitState([0, 100, 200], 5300, policy);
  assert.equal(s.open, false);

  // 窗口外的旧崩溃不再计数
  s = circuitState([0], 20000, policy);
  assert.equal(s.recent.length, 0);
  assert.equal(s.open, false);
});

test('就绪握手：收到 ###READY 才算 ready，并复用同一个子进程', async () => {
  const h = harness();
  const c1 = await h.sup.ensure();
  assert.equal(h.sup.status().state, 'starting');
  c1.ready();
  assert.equal(h.sup.status().state, 'ready');
  assert.equal(h.sup.status().failStreak, 0);

  const c2 = await h.sup.ensure();
  assert.equal(c2, c1, 'ready 后必须复用，不能再 spawn');
  assert.equal(h.children.length, 1);
});

test('ready 超时：旧引擎目录没有标记时按可用继续（留 WARN）', async () => {
  const h = harness({ policy: { readyTimeoutMs: 1234 } });
  await h.sup.ensure();
  const t = h.lastTimer();
  assert.equal(t.ms, 1234);
  h.fireReadyTimeout();
  assert.equal(h.sup.status().state, 'ready');
  assert.ok(h.logs.some(([lv, m]) => lv === 'WARN' && m.includes('ready 标记')));
});

test('崩溃后退避重启；ready 之后崩溃计数归零', async () => {
  const exits = [];
  const h = harness({ onExit: (err) => exits.push(err) });
  const c1 = await h.sup.ensure();
  c1.ready();
  assert.equal(exits.length, 0);

  h.advance(10);
  c1.crash(2);
  h.advance(40);   // 崩溃后已经过去 40ms，退避只需再等差额
  assert.equal(exits.length, 1);
  assert.match(exits[0].message, /close code=2/);

  const c2 = await h.sup.ensure();
  assert.notEqual(c2, c1);
  assert.deepEqual(h.sleeps, [600 - 40], '第二次启动前应退避（扣除已过去的时间）');

  c2.ready();
  assert.equal(h.sup.status().failStreak, 0, 'ready 后连续崩溃计数归零');

  // 再崩一次：又从 base 开始退避，而不是继续翻倍
  c2.crash(1);
  h.advance(5);
  await h.sup.ensure();
  assert.equal(h.sleeps.at(-1), 600 - 5);
});

test('熔断：窗口内 3 次崩溃 → 暂停重启并给出 code；冷却结束后半开放行', async () => {
  const h = harness();
  let c = await h.sup.ensure();
  c.crash(1);
  h.advance(10);

  c = await h.sup.ensure();
  c.crash(1);
  h.advance(10);

  c = await h.sup.ensure();
  c.crash(1);
  assert.equal(h.sup.status().state, 'open');

  await assert.rejects(() => h.sup.ensure(), (e) => e.code === 'ENGINE_CIRCUIT_OPEN');

  // 冷却 30s 后允许再试（半开）
  h.advance(30000);
  c = await h.sup.ensure();
  assert.equal(h.children.length, 4);
  assert.equal(h.sup.status().state, 'starting');
});

test('主动 stop（取消/空闲回收）不计入崩溃，重启也不退避', async () => {
  const exits = [];
  const h = harness({ onExit: (err) => exits.push(err) });
  const c1 = await h.sup.ensure();
  c1.ready();

  h.sup.stop();
  assert.equal(h.sup.status().state, 'stopped');
  assert.deepEqual(exits, [], '主动停止不应回调 onExit(错误)');
  assert.deepEqual(h.sup.status().crashes, []);

  const c2 = await h.sup.ensure();
  assert.equal(h.children.length, 2);
  assert.deepEqual(h.sleeps, [], '主动停止后的首次启动没有退避');
  assert.notEqual(c2, c1);
});

test('onLine 只收到非 READY 行，且单行解析不丢数据', async () => {
  const lines = [];
  const h = harness({ onLine: (t) => lines.push(t) });
  const c = await h.sup.ensure();
  c.line('###LOG {"_id":"w1","line":"hi"}');
  c.ready();
  c.line('###RESULT {"_id":"w1","ok":true}');
  // 分块到达：同一行被拆成两次 data
  c.stdout.emit('data', Buffer.from('###LOG {"_id":"w1",'));
  c.stdout.emit('data', Buffer.from('"line":"split"}\n'));

  assert.deepEqual(lines, [
    '###LOG {"_id":"w1","line":"hi"}',
    '###RESULT {"_id":"w1","ok":true}',
    '###LOG {"_id":"w1","line":"split"}',
  ]);
});

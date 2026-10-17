// C2 TaskCenter 单测（纯逻辑，不依赖 Electron）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTaskCenter } = require('../main/taskcenter.js');

function makeCenter(opts = {}) {
  let clock = 1000;
  const emits = [];
  const c = createTaskCenter({
    now: () => clock,
    emit: (ev) => emits.push(ev),
    ...opts,
  });
  return { c, emits, advance: (ms) => { clock += ms; }, clock: () => clock };
}

test('C2 注册/列表/进度/日志：running 排前，progress 夹取 0..1', () => {
  const { c } = makeCenter();
  const a = c.register({ kind: 'transcribe', title: '转录 A', cancelable: true });
  const b = c.register({ kind: 'download', title: '下载 B' });
  assert.ok(a.id && b.id && a.id !== b.id);
  assert.deepEqual(c.list().map((t) => t.title), ['转录 A', '下载 B']);
  a.progress(0.4, '解码中');
  a.progress(2, '超上限');
  a.progress(-1);
  const t = c.get(a.id);
  assert.equal(t.progress, 0, '最后一次 -1 被夹到 0');
  assert.equal(t.logs.length, 2);
  a.log('更多日志');
  assert.equal(c.get(a.id).logs.at(-1), '更多日志');
});

test('C2 完成/失败：状态、结果、错误、endedAt 正确', () => {
  const { c, advance } = makeCenter();
  const a = c.register({ kind: 'export', title: '导出' });
  advance(500);
  a.done({ path: 'C:/x.wav' });
  const t = c.get(a.id);
  assert.equal(t.status, 'done');
  assert.deepEqual(t.result, { path: 'C:/x.wav' });
  assert.equal(t.progress, 1);
  assert.equal(t.endedAt, 1500);
  const b = c.register({ kind: 'export', title: '导出2' });
  b.fail(new Error('磁盘满'));
  assert.equal(c.get(b.id).status, 'error');
  assert.match(c.get(b.id).error, /磁盘满/);
  // 结束后再 progress/log 无效
  assert.equal(b.progress(0.9), false);
  assert.equal(b.log('x'), false);
});

test('C2 取消：可取消任务调用 onCancel 并标 canceled；不可取消/未知 id 明确报错', () => {
  const { c } = makeCenter();
  let canceled = 0;
  const a = c.register({ kind: 'download', title: '下载', cancelable: true, onCancel: () => { canceled++; } });
  assert.deepEqual(c.cancel(a.id), { ok: true });
  assert.equal(canceled, 1);
  assert.equal(c.get(a.id).status, 'canceled');
  assert.equal(c.cancel(a.id).ok, false, '已结束不能再取消');
  const b = c.register({ kind: 'x', title: '不可取消', cancelable: false });
  assert.equal(c.cancel(b.id).ok, false);
  assert.equal(c.cancel('不存在').ok, false);
});

test('C2 事件广播：progress 节流，flush 后一次 update；done 立即广播', () => {
  const { c, emits } = makeCenter({ emitIntervalMs: 100 });
  const a = c.register({ kind: 'x', title: 'x' });
  emits.length = 0;
  a.progress(0.1); a.progress(0.2); a.progress(0.3);
  assert.equal(emits.length, 0, '未到节流窗口不发');
  c.flush();
  assert.equal(emits.length, 1);
  assert.equal(emits[0].type, 'update');
  assert.equal(emits[0].tasks.length, 1);
  emits.length = 0;
  a.done();
  assert.equal(emits.length, 1, 'done 立即广播');
  assert.equal(emits[0].tasks[0].status, 'done');
});

test('C2 保留策略：超过 retainMs 的已结束任务在下次 prune 时清掉，running 不动', () => {
  const { c, advance } = makeCenter({ retainMs: 1000 });
  const old = c.register({ kind: 'x', title: '旧任务' });
  old.done();
  const running = c.register({ kind: 'x', title: '进行中' });
  advance(2000);
  const fresh = c.register({ kind: 'x', title: '新任务' });
  const titles = c.list().map((t) => t.title);
  assert.ok(!titles.includes('旧任务'), '旧任务被清掉');
  assert.ok(titles.includes('进行中'));
  assert.ok(titles.includes('新任务'));
  void fresh;
});

test('C2 数量上限 maxTasks：优先淘汰最早结束的', () => {
  const { c, advance } = makeCenter({ maxTasks: 10 });
  for (let i = 0; i < 12; i++) { const h = c.register({ kind: 'x', title: 't' + i }); advance(1); h.done(); advance(1); }
  assert.equal(c.size(), 10);
  const titles = c.list().map((t) => t.title);
  assert.ok(!titles.includes('t0') && !titles.includes('t1'), '最早结束的被淘汰');
});

test('C2 logs 上限与 clear', () => {
  const { c } = makeCenter({ maxLogs: 10 });
  const a = c.register({ kind: 'x', title: 'x' });
  for (let i = 0; i < 30; i++) a.log('L' + i);
  assert.equal(c.get(a.id).logs.length, 10);
  assert.equal(c.get(a.id).logs.at(-1), 'L29');
  c.clear();
  assert.equal(c.size(), 0);
  assert.deepEqual(c.list(), []);
});

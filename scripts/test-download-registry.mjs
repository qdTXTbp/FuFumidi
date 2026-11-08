// 统一下载任务层回归：进度归一化、任务登记/完成/失败、事件桥接。
// 不联网、不依赖 Electron：taskcenter 的 createTaskCenter/getTaskCenter 是纯逻辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DL = require('../main/download-registry.js');
const TC = require('../main/taskcenter.js');

// 先建一个带 emit 的单例，DL.peekTaskCenter() 才能取到（真实进程里由 main.js 建）
const emits = [];
TC.getTaskCenter({ emit: (ev) => emits.push(ev), emitIntervalMs: 16 });
const center = TC.peekTaskCenter();
assert.ok(center);

function reset() {
  center.clear();
  DL.reset();
  emits.length = 0;
}

test('进度归一化：percent 0..100 / progress 0..1 / received+total / done', () => {
  assert.equal(DL.normalize({ percent: 62 }), 0.62);
  assert.equal(DL.normalize({ progress: 0.62 }), 0.62);
  assert.equal(DL.normalize({ progress: 62 }), 0.62);   // 有些模块又把 0..100 塞进 progress
  assert.equal(DL.normalize({ received: 25, total: 100 }), 0.25);
  assert.equal(DL.normalize({ percent: 10, done: true }), 1);
  assert.equal(DL.normalize({ percent: 500 }), 1);
  assert.equal(DL.normalize({ percent: -3 }), 0);
  assert.equal(DL.normalize(undefined), 0);
});

test('start：登记任务，进度/日志/完成，重复收口只生效一次', () => {
  reset();
  const h = DL.start({ domain: 'model', key: 'muscriptor_medium', title: 'Medium' });
  let t = center.get(h.id);
  assert.equal(t.kind, 'model');
  assert.match(t.title, /模型 · Medium/);
  assert.equal(t.cancelable, true);
  h.progress({ percent: 30, text: '国内源' });
  h.progress({ percent: 30, text: '国内源' });      // 同文本不重复写 log
  h.progress({ percent: 60, text: '换源重试' });
  t = center.get(h.id);
  assert.equal(t.progress, 0.6);
  assert.deepEqual(t.logs, ['国内源', '换源重试']);
  h.done({ size: 123 });
  h.done({ size: 999 });                            // 重复收口不覆盖
  assert.equal(center.get(h.id).status, 'done');
  assert.equal(center.get(h.id).result.size, 123);
});

test('finish：吃各模块现有返回值 {ok, canceled, paused, error}', () => {
  reset();
  const ok = DL.start({ domain: 'soundfont', key: 'a' });
  ok.finish({ ok: true, existed: true });
  assert.equal(center.get(ok.id).status, 'done');

  const bad = DL.start({ domain: 'soundfont', key: 'b' });
  bad.finish({ ok: false, error: 'SHA256 校验失败' });
  assert.equal(center.get(bad.id).status, 'error');
  assert.match(center.get(bad.id).error, /SHA256/);

  const stopped = DL.start({ domain: 'soundfont', key: 'c' });
  stopped.finish({ ok: false, paused: true });
  assert.equal(center.get(stopped.id).status, 'canceled');
});

test('取消：abort ctrl + isUserAbort，并调用模块自己的 onCancel', () => {
  reset();
  let cancelled = 0;
  const h = DL.start({ domain: 'model', key: 'x', onCancel: () => { cancelled += 1; } });
  assert.equal(h.ctrl.signal.aborted, false);
  center.cancel(h.id);
  assert.equal(h.ctrl.signal.aborted, true);
  assert.equal(h.isUserAbort.aborted, true);
  assert.equal(cancelled, 1);
  assert.equal(center.get(h.id).status, 'canceled');
});

test('observe：模型进度事件自动登记 / 更新 / 完成', () => {
  reset();
  DL.observe('model:progress', { id: 'muscriptor_medium', percent: 0, total: 100, received: 0 });
  assert.equal(DL.activeCount(), 1);
  const id = center.list()[0].id;
  assert.equal(center.list()[0].kind, 'model');
  DL.observe('model:progress', { id: 'muscriptor_medium', percent: 55, received: 55, total: 100 });
  assert.equal(center.get(id).progress, 0.55);
  DL.observe('model:progress', { id: 'muscriptor_medium', percent: 100, done: true });
  assert.equal(center.get(id).status, 'done');
  assert.equal(DL.activeCount(), 0);
});

test('observe：多模块并行、失败收口、无关通道不登记', () => {
  reset();
  DL.observe('gpu:progress', { percent: 10, received: 1, total: 10 });
  DL.observe('update:progress', { percent: 20, received: 2, total: 10 });
  DL.observe('wallpaper:downloadProgress', { name: 'aurora.mp4', progress: 0.3 });
  assert.equal(DL.activeCount(), 3);
  assert.deepEqual(new Set(center.list().map((t) => t.kind)),
    new Set(['download', 'update', 'download']));
  DL.observe('omr:progress', { phase: 'error', error: '下载失败' });
  assert.equal(center.list().find((t) => t.title.includes('识谱组件')).status, 'error');
  DL.observe('task:update', { tasks: [] });          // 任务中心自己的广播，绝不能递归
  DL.observe('engine:log', { line: 'x' });
  assert.equal(DL.activeCount(), 3);
});

test('observe：canceled/paused 收口后同一 id 可重新开一单（换源重试）', () => {
  reset();
  DL.observe('model:progress', { id: 'a', percent: 10 });
  const first = center.list()[0].id;
  DL.observe('model:progress', { id: 'a', percent: 10, canceled: true });
  assert.equal(center.get(first).status, 'canceled');
  DL.observe('model:progress', { id: 'a', percent: 20 });
  assert.equal(DL.activeCount(), 1);
  assert.notEqual(center.list().find((t) => t.status === 'running').id, first);
});

test('observe：非对象 / 未知通道一律忽略', () => {
  reset();
  DL.observe('model:progress', null);
  DL.observe('whatever', { percent: 10 });
  assert.equal(DL.activeCount(), 0);
  assert.equal(center.size(), 0);
});

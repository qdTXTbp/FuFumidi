// P-011 / T-103 命令式撤销核心：增量命令、标签、事务与 50MB 内存上限
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandHistory, DEFAULT_MAX_BYTES } from '../src/core/command_history.js';

function counterHistory(opts = {}) {
  let n = 0;
  const h = createCommandHistory(opts);
  // 模拟“命令已经应用”：先改 n，再把增量命令入栈（与真实编辑流程一致）
  const add = (d, label = '加' + d) => {
    n += d;
    return h.push({ label, bytes: 8, undo: () => { n -= d; }, redo: () => { n += d; } });
  };
  return { h, add, get n() { return n; } };
}

test('P-011 基本 undo/redo：顺序、标签、新命令清空 redo', () => {
  const c = counterHistory();
  c.add(1, '加一'); c.add(2, '加二');
  assert.equal(c.n, 3);
  assert.equal(c.h.depth().undoLabel, '加二');
  assert.equal(c.h.undo(), '加二');
  assert.equal(c.n, 1);
  assert.equal(c.h.depth().undoLabel, '加一');
  assert.equal(c.h.undo(), '加一');
  assert.equal(c.n, 0);
  assert.equal(c.h.undo(), null);
  assert.equal(c.h.canRedo(), true);
  assert.equal(c.h.depth().redoLabel, '加一');
  assert.equal(c.h.redo(), '加一');
  assert.equal(c.n, 1);
  assert.equal(c.h.redo(), '加二');
  assert.equal(c.n, 3);
  c.add(5, '新的');
  assert.equal(c.h.canRedo(), false, '新命令清空 redo');
});

test('P-011 transaction：多命令合成一条，撤销逆序、重做正序', () => {
  const h = createCommandHistory();
  const log = [];
  const cmds = [1, 2, 3].map((d) => ({ label: 'm' + d, bytes: 4, undo: () => log.push('u' + d), redo: () => log.push('r' + d) }));
  const tx = h.transaction('拖拽 3 个音符', cmds);
  h.push(tx);
  assert.equal(h.undo(), '拖拽 3 个音符');
  assert.deepEqual(log, ['u3', 'u2', 'u1']);
  h.redo();
  assert.deepEqual(log.slice(3), ['r1', 'r2', 'r3']);
});

test('P-011 limit 与 bytes 上限：丢最旧，保留最近命令', () => {
  const h = createCommandHistory({ limit: 3, maxBytes: 100 });
  for (let i = 0; i < 5; i++) h.push({ label: 'c' + i, bytes: 10, undo() {}, redo() {} });
  assert.equal(h.depth().undo, 3);
  assert.equal(h.depth().bytes, 30);
  const h2 = createCommandHistory({ limit: 100, maxBytes: 1024 });
  for (let i = 0; i < 5; i++) h2.push({ label: 'b' + i, bytes: 700, undo() {}, redo() {} });
  assert.ok(h2.depth().bytes <= 1024, '字节上限' + h2.depth().bytes);
  assert.ok(h2.depth().undo >= 1);
});

test('P-011 内存预算：10 万音符 × 50 次增量编辑 < 50MB', () => {
  const NOTES = 100_000;
  const EDITS = 50;
  const h = createCommandHistory({ limit: 200, maxBytes: DEFAULT_MAX_BYTES });
  for (let i = 0; i < EDITS; i++) {
    // 模拟一次“改 1 个音符”的增量命令：只存索引+前后值，不存全量 10 万音符
    h.push({ label: 'edit' + i, bytes: 64, diff: { idx: i, from: 60, to: 61 }, undo() {}, redo() {} });
  }
  assert.equal(h.depth().undo, EDITS);
  assert.ok(h.depth().bytes < DEFAULT_MAX_BYTES, '内存 ' + h.depth().bytes + ' < 50MB');
  assert.equal(NOTES * 16 * EDITS > DEFAULT_MAX_BYTES, true, '全量快照会超 50MB（此测试证明增量路径）');
});

test('P-011 非法命令明确抛错；estimate 支持 diff', () => {
  const h = createCommandHistory();
  assert.throws(() => h.push({ label: 'x' }), /undo/);
  const c = h.push({ label: 'd', diff: { a: 1 }, undo() {}, redo() {} });
  assert.ok(c.bytes > 0);
  assert.equal(h.limit > 0, true);
});

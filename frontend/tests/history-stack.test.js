// P1-13 B2 撤销/重做栈
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryStack } from '../src/core/history_stack.js';

test('P1-13 历史栈：push/undo/redo 基本往返，快照是深拷贝', () => {
  const h = createHistoryStack();
  const state = { v: 1, nested: { x: 1 } };
  h.push(state);
  state.nested.x = 99;                 // push 之后的修改不应污染已存快照
  const back = h.undo({ v: 2, nested: { x: 2 } });
  assert.equal(back.nested.x, 1);
  assert.equal(h.canRedo(), true);
  const redo = h.redo({ v: 1, nested: { x: 1 } });
  assert.deepEqual(redo, { v: 2, nested: { x: 2 } });
  assert.equal(h.canUndo(), true);
});

test('P1-13 历史栈：空栈 undo/redo 返回 null', () => {
  const h = createHistoryStack();
  assert.equal(h.undo({}), null);
  assert.equal(h.redo({}), null);
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
});

test('P1-13 历史栈：新操作清空 redo', () => {
  const h = createHistoryStack();
  h.push({ v: 0 });
  h.undo({ v: 1 });
  assert.equal(h.canRedo(), true);
  h.push({ v: 1 });
  assert.equal(h.canRedo(), false);
});

test('P1-13 历史栈：limit 丢最旧，但保留最近 N 步', () => {
  const h = createHistoryStack({ limit: 3 });
  for (let i = 0; i < 5; i++) h.push({ v: i });
  assert.equal(h.depth().undo, 3);
  assert.deepEqual(h.undo({ v: 5 }), { v: 4 });
  assert.deepEqual(h.undo({ v: 4 }), { v: 3 });
  assert.deepEqual(h.undo({ v: 3 }), { v: 2 });
  assert.equal(h.canUndo(), false, '最旧的 0/1 已被丢弃');
});

test('P1-13 历史栈：clear 清空两边', () => {
  const h = createHistoryStack();
  h.push({ a: 1 });
  h.undo({ a: 2 });
  h.clear();
  assert.deepEqual(h.depth(), { undo: 0, redo: 0 });
});

test('P1-13 历史栈：可注入 clone（用于 Map/Set 等 JSON 装不下的状态）', () => {
  const h = createHistoryStack({ clone: (v) => ({ size: v.size }) });
  h.push({ size: 3 });
  assert.deepEqual(h.undo({ size: 5 }), { size: 3 });
});

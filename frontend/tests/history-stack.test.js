// P1-13 B2 撤销/重做栈
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryStack, createTabbedHistoryRegistry } from '../src/core/history_stack.js';

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

test('P1-13 分标签历史栈：不同曲目 id 互相隔离，切回保留撤销/重做', () => {
  const reg = createTabbedHistoryRegistry({ limit: 10 });
  const a = reg.forTab('song-a');
  const b = reg.forTab('song-b');
  a.push({ v: 1 });
  a.push({ v: 2 });
  b.push({ v: 10 });
  assert.deepEqual(a.depth(), { undo: 2, redo: 0 });
  assert.deepEqual(b.depth(), { undo: 1, redo: 0 });
  assert.deepEqual(a.undo({ v: 3 }), { v: 2 });
  assert.deepEqual(reg.forTab('song-a').depth(), { undo: 1, redo: 1 }, '同一 key 返回同一个栈');
  assert.deepEqual(reg.forTab('song-b').depth(), { undo: 1, redo: 0 }, '另一个标签不受影响');
  assert.equal(reg.size(), 2);
  assert.ok(reg.keys().includes('song-a') && reg.keys().includes('song-b'));
});

test('P1-13 分标签历史栈：LRU 上限、drop 清理', () => {
  const reg = createTabbedHistoryRegistry({ maxTabs: 2 });
  reg.forTab('a').push({ v: 1 });
  reg.forTab('b').push({ v: 2 });
  reg.forTab('c').push({ v: 3 });
  assert.equal(reg.size(), 2, '最多保留 maxTabs 个');
  assert.ok(!reg.keys().includes('a'), '最久未用的 a 被丢弃');
  assert.ok(reg.keys().includes('c'));
  reg.drop('b');
  assert.ok(!reg.keys().includes('b'));
  reg.clearAll();
  assert.equal(reg.size(), 0);
});

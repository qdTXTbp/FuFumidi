// P-011 末项：session 文档级历史引擎（混合快照/命令）与旧接口兼容
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../src/core/session.js';

test('session 历史：同 doc 引擎稳定、跨 doc 隔离、关闭即释放', () => {
  const s = createSessionStore({ maxUndo: 10 });
  s.open({ docId: 'a' }); s.open({ docId: 'b' });
  const ha = s.history('a'), hb = s.history('b');
  assert.ok(ha && hb && ha !== hb);
  let v = 0;
  s.pushUndo('a', { undo: () => { v--; }, redo: () => { v++; }, label: 'a' });
  assert.equal(s.depth('a').undo, 1);
  assert.equal(s.depth('b').undo, 0);
  assert.equal(s.history('a'), ha, '同一 doc 实例稳定');
  assert.equal(s.close('a'), true);
  assert.equal(s.history('a'), null);
  const a2 = s.open({ docId: 'a' });
  assert.ok(a2);
  assert.equal(s.depth('a').undo, 0, '关闭后重开是空栈');
});

test('session 历史：undo/redo/新编辑清 redo/标签与 dirtySeq', () => {
  const s = createSessionStore();
  s.open({ docId: 'a' });
  let v = 0;
  s.pushUndo('a', { label: '加一', undo: () => { v--; }, redo: () => { v++; } });
  v = 1;
  assert.equal(s.undo('a'), true); assert.equal(v, 0);
  assert.equal(s.depth('a').redo, 1);
  assert.equal(s.depth('a').undoLabel, '');
  assert.equal(s.redo('a'), true); assert.equal(v, 1);
  s.pushUndo('a', { label: '加二', undo: () => { v--; }, redo: () => { v++; } }); v = 2;
  s.undo('a');
  assert.equal(s.depth('a').redo, 1);
  s.pushUndo('a', { label: '新编辑', undo: () => {}, redo: () => {} });
  assert.equal(s.depth('a').redo, 0, '新 push 清空 redo');
});

test('session 历史：markDirty/markSaved 不再误清 redo', () => {
  const s = createSessionStore();
  s.open({ docId: 'a' });
  s.pushUndo('a', { undo: () => {}, redo: () => {} });
  s.undo('a');
  assert.equal(s.depth('a').redo, 1);
  s.markDirty('a', '保存相关');
  s.markSaved('a', 1);
  assert.equal(s.depth('a').redo, 1, '保存/脏标记不应清 redo');
});

test('session 历史：抛错保留条目并返回 false；clearUndo 清空但不影响 redo？', () => {
  const s = createSessionStore();
  s.open({ docId: 'a' });
  s.pushUndo('a', { undo: () => {}, redo: () => {} });
  s.pushUndo('a', { undo: () => { throw new Error('boom'); }, redo: () => {} });
  assert.equal(s.undo('a'), false);
  assert.equal(s.depth('a').undo, 2, '抛错条目必须保留，不能丢历史');
  assert.equal(s.clearUndo('a'), true);
  assert.equal(s.depth('a').undo, 0);
  assert.equal(s.depth('a').redo, 0);
});

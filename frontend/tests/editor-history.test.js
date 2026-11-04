// P-011 混合撤销栈 + 命令索引纪律回归（无 DOM，node --test）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandHistory } from '../src/core/command_history.js';
import { createEditorHistory, makeSnapshotEntry } from '../src/core/editor_history.js';
import { makeAddNotesCommand, makeDeleteNotesCommand, makeUpdateNotesCommand } from '../src/core/note_commands.js';

const cmd = (label, up, down) => ({ label, bytes: 8, undo: down, redo: up });
const mk = (id, start, midi = 60, vel = 100) => ({ id, start, end: start + 480, midi, vel });
const sortNotes = (notes) => notes.sort((a, b) => (a.start - b.start) || (a.midi - b.midi));

test('P-011 混合栈：快照与命令共用一条 LIFO，undo/redo 顺序正确', () => {
  let v = 0;
  const capture = () => ({ v, bytes: 10, at: 1, noteCount: v });
  const restore = (st) => { v = st.v; };
  const h = createEditorHistory({ limit: 10, maxBytes: 1000 });
  v = 1; h.push(cmd('cmd1', () => { v += 1; }, () => { v -= 1; }));
  h.pushSnapshot({ label: 'snap1', ti: 2, capture, restore });
  v = 2;
  v = 12; h.push(cmd('cmd2', () => { v += 10; }, () => { v -= 10; }));
  assert.deepEqual(h.entries().map((e) => [e.kind, e.label]), [['command', 'cmd1'], ['snapshot', 'snap1'], ['command', 'cmd2']]);
  assert.equal(h.undo(), 'cmd2'); assert.equal(v, 2);
  assert.equal(h.undo(), 'snap1'); assert.equal(v, 1);
  assert.equal(h.undo(), 'cmd1'); assert.equal(v, 0);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), 'cmd1'); assert.equal(v, 1);
  assert.equal(h.redo(), 'snap1'); assert.equal(v, 2);
  assert.equal(h.redo(), 'cmd2'); assert.equal(v, 12);
});

test('P-011 快照 entry：after 惰性捕获，往返两轮不丢状态', () => {
  let v = 1;
  const entry = makeSnapshotEntry({
    label: 'snap', capture: () => ({ v, bytes: 4 }), restore: (st) => { v = st.v; },
  });
  v = 2;
  entry.undo(); assert.equal(v, 1);
  entry.redo(); assert.equal(v, 2);
  entry.undo(); assert.equal(v, 1);
  entry.redo(); assert.equal(v, 2);
  assert.equal(entry.kind, 'snapshot');
});

test('P-011 redo 清空：命令与快照 push 都清空 redo', () => {
  let v = 0;
  const h = createEditorHistory();
  v = 1; h.push(cmd('a', () => { v += 1; }, () => { v -= 1; }));
  h.undo();
  assert.equal(h.canRedo(), true);
  const c = { label: 'b', bytes: 1, undo() {}, redo() {} };
  h.push(c);
  assert.equal(h.canRedo(), false);
  h.undo();
  h.pushSnapshot({ label: 's', capture: () => ({ v }), restore: (st) => { v = st.v; } });
  assert.equal(h.canRedo(), false);
});

test('P-011 redo 也受 maxBytes 约束（旧实现只裁 undo）', () => {
  const h = createCommandHistory({ limit: 10, maxBytes: 1200, hugeBytes: 100000 });
  for (let i = 0; i < 5; i++) h.push({ label: 'c' + i, bytes: 400, undo() {}, redo() {} });
  for (let i = 0; i < 5; i++) h.undo();
  assert.ok(h.depth().redoBytes <= 1200, 'redoBytes=' + h.depth().redoBytes);
  assert.ok(h.depth().redo >= 1);
});

test('P-011 dropLast：不动 redo、seq 不回退、bytes 归零', () => {
  const h = createCommandHistory({ limit: 10, maxBytes: 1000 });
  h.push({ label: 'x', bytes: 10, undo() {}, redo() {} });
  const before = h.seq();
  assert.equal(h.dropLast(), 'x');
  assert.equal(h.depth().undo, 0);
  assert.equal(h.depth().bytes, 0);
  assert.equal(h.canRedo(), false);
  assert.equal(h.seq(), before);
  assert.equal(h.dropLast(), null);
});

test('P-011 索引纪律：新增命令先建后排序，undo 只删新增音符', () => {
  const a = mk(1, 0, 60), b = mk(2, 0, 64), c = mk(3, 0, 62);
  const track = { notes: [a, b] };
  track.notes.push(c);
  const command = makeAddNotesCommand(track, [c], '添加音符');
  sortNotes(track.notes); // afterEdit 的重排发生在命令构造之后
  assert.deepEqual(track.notes.map((n) => n.id), [1, 3, 2]);
  command.undo();
  assert.deepEqual(track.notes.map((n) => n.id), [1, 2]);
  command.redo();
  assert.deepEqual(track.notes.map((n) => n.id).sort(), [1, 2, 3]);
});

test('P-011 索引纪律：修改命令按引用回滚，不因重排改错对象', () => {
  const a = mk(1, 0, 60, 100), b = mk(2, 480, 64, 90);
  const track = { notes: [a, b] };
  Object.assign(a, { start: 960, vel: 40 });
  const command = makeUpdateNotesCommand(track, [{ idx: 0, note: a, before: { start: 0, vel: 100 }, after: { start: 960, vel: 40 } }], '移动');
  sortNotes(track.notes); // 现在 idx0 是 b
  assert.equal(track.notes[0], b);
  command.undo();
  assert.equal(a.start, 0); assert.equal(a.vel, 100);
  assert.equal(b.start, 480); assert.equal(b.vel, 90);
  command.redo();
  assert.equal(a.start, 960); assert.equal(a.vel, 40);
});

test('P-011 索引纪律：删除命令 redo 按引用删除，不误删重排后的邻居', () => {
  const a = mk(1, 0, 60), b = mk(2, 480, 64), c = mk(3, 960, 62);
  const track = { notes: [a, b, c] };
  track.notes.splice(1, 1);
  const command = makeDeleteNotesCommand(track, [{ idx: 1, note: b }], '删除');
  command.undo();
  assert.deepEqual(track.notes.map((n) => n.id), [1, 2, 3]);
  track.notes.reverse(); // 撤销与重做之间顺序变化
  command.redo();
  assert.deepEqual(track.notes.map((n) => n.id).sort(), [1, 3]);
});

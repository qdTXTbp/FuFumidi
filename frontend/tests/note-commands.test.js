// P-011 增量音符命令：新增/删除/修改/与事务栈组合
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandHistory } from '../src/core/command_history.js';
import { makeAddNotesCommand, makeDeleteNotesCommand, makeUpdateNotesCommand, removeNotesWithCommand } from '../src/core/note_commands.js';

const mk = (id, start, midi = 60) => ({ id, start, end: start + 480, midi, vel: 100 });

test('P-011 新增音符：undo 删除、redo 放回', () => {
  const track = { notes: [mk(1, 0)] };
  const n = mk(2, 480);
  track.notes.push(n); // 已应用
  const cmd = makeAddNotesCommand(track, [n], '画一个音符');
  const h = createCommandHistory();
  h.push(cmd);
  h.undo();
  assert.deepEqual(track.notes.map((x) => x.id), [1]);
  h.redo();
  assert.deepEqual(track.notes.map((x) => x.id), [1, 2]);
});

test('P-011 删除音符：undo 逆序插回原位置', () => {
  const track = { notes: [mk(1, 0), mk(2, 480), mk(3, 960)] };
  const removed = [track.notes[0], track.notes[2]];
  track.notes = [track.notes[1]];
  const cmd = makeDeleteNotesCommand(track, [{ idx: 0, note: removed[0] }, { idx: 2, note: removed[1] }], '删除两个');
  cmd.undo();
  assert.deepEqual(track.notes.map((x) => x.id), [1, 2, 3]);
  cmd.redo();
  assert.deepEqual(track.notes.map((x) => x.id), [2]);
});

test('P-011 修改音符：before/after 精确回滚（移动+力度）', () => {
  const track = { notes: [mk(1, 0)] };
  const before = { start: 0, end: 480, vel: 100 };
  const after = { start: 960, end: 1440, vel: 64 };
  Object.assign(track.notes[0], after);
  const cmd = makeUpdateNotesCommand(track, [{ idx: 0, before, after }], '拖动音符');
  cmd.undo();
  assert.deepEqual({ start: track.notes[0].start, end: track.notes[0].end, vel: track.notes[0].vel }, before);
  cmd.redo();
  assert.deepEqual({ start: track.notes[0].start, end: track.notes[0].end, vel: track.notes[0].vel }, after);
});

test('P-011 批量删除工具 + 事务栈：一次操作只占一条历史', () => {
  const track = { notes: [mk(1, 0), mk(2, 480), mk(3, 960), mk(4, 1440)] };
  const cmd = removeNotesWithCommand(track, [track.notes[1], track.notes[2]], '框选删除');
  const h = createCommandHistory();
  h.push(cmd);
  assert.deepEqual(track.notes.map((x) => x.id), [1, 4]);
  h.undo();
  assert.deepEqual(track.notes.map((x) => x.id), [1, 2, 3, 4]);
  assert.equal(h.depth().undo, 0);
  assert.ok(h.depth().bytes < 1024);
});

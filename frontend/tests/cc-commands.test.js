// P-011 CC 命令：延音踏板增删（无 DOM）
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAddCcsCommand, makeDeleteCcsCommand, makeReplaceCcStateCommand, snapshotCcState } from '../src/core/cc_commands.js';

const cc = (tick, cv) => ({ tick, cc: 64, cv });

test('P-011 CC 新增：undo 按引用删除，redo 放回', () => {
  const track = { ccs: [cc(0, 127)] };
  const a = cc(480, 0);
  track.ccs.push(a);
  track.ccs.sort((x, y) => x.tick - y.tick);
  const cmd = makeAddCcsCommand(track, [a], '延音踏板');
  cmd.undo();
  assert.deepEqual(track.ccs.map((x) => x.tick), [0]);
  cmd.redo();
  assert.deepEqual(track.ccs.map((x) => x.tick), [0, 480]);
});

test('P-011 CC 删除：undo 插回、redo 按引用删除，重排不误删', () => {
  const a = cc(0, 127), b = cc(240, 127), c = cc(480, 0);
  const track = { ccs: [a, b, c] };
  track.ccs = [a, c];
  const cmd = makeDeleteCcsCommand(track, [{ idx: 1, cc: b }], '删除控制器');
  cmd.undo();
  assert.deepEqual(track.ccs.map((x) => x.tick), [0, 240, 480]);
  track.ccs.reverse();
  cmd.redo();
  assert.deepEqual(track.ccs.map((x) => x.tick).sort((x, y) => x - y), [0, 480]);
});

test('P-011 CC 整段拖拽替换：undo/redo 用快照副本，外部修改不污染', () => {
  const track = { ccs: [{ tick: 0, cc: 11, cv: 20 }], events: [] };
  const before = snapshotCcState(track);
  track.ccs.push({ tick: 120, cc: 11, cv: 80 });
  track.ccs.sort((a, b) => a.tick - b.tick);
  const after = snapshotCcState(track);
  const cmd = makeReplaceCcStateCommand(track, before, after, 'CC');
  cmd.undo();
  assert.deepEqual(track.ccs.map((c) => c.cv), [20]);
  track.ccs[0].cv = 99; // 外部修改不应影响命令内部副本
  cmd.redo();
  assert.deepEqual(track.ccs.map((c) => c.cv), [20, 80]);
  cmd.undo();
  assert.deepEqual(track.ccs.map((c) => c.cv), [20]);
});

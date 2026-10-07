// 编辑历史栈（song_history）测试 —— 纯逻辑，快照/恢复用普通对象注入。
//
// ★ 要验的四件事：
//   1. **基本往返** —— push 后改动，undo 回到改动前，redo 回到改动后
//   2. **新编辑清空 redo** —— undo 后走了新分支，redo 必须失效（标准语义）
//   3. **上限** —— 默认 50，最早的快照被挤掉
//   4. **clear** —— 换工程时清栈
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../src/core/song_history.js';

function mkHistory(state) {
  let cur = state;
  return {
    hist: createHistory({
      snapshot: () => JSON.parse(JSON.stringify(cur)),
      restore: (s) => { cur = s; },
    }),
    get cur() { return cur; },
    set cur(v) { cur = v; },
  };
}

test('基本往返：undo 回到 push 前，redo 回到 push 后', () => {
  const w = mkHistory({ beats: [1, 2] });
  w.hist.push();
  w.cur = { beats: [1, 2, 3] };
  assert.equal(w.hist.canUndo, true);
  assert.equal(w.hist.undo(), true);
  assert.deepEqual(w.cur, { beats: [1, 2] });
  assert.equal(w.hist.canRedo, true);
  assert.equal(w.hist.redo(), true);
  assert.deepEqual(w.cur, { beats: [1, 2, 3] });
});

test('连续 undo/redo 与边界（空栈返回 false）', () => {
  const w = mkHistory({ v: 0 });
  assert.equal(w.hist.undo(), false, '空栈不能 undo');
  assert.equal(w.hist.redo(), false);
  w.hist.push(); w.cur = { v: 1 };
  w.hist.push(); w.cur = { v: 2 };
  w.hist.push(); w.cur = { v: 3 };
  w.hist.undo(); w.hist.undo();
  assert.deepEqual(w.cur, { v: 1 });
  w.hist.redo();
  assert.deepEqual(w.cur, { v: 2 });
});

test('新编辑分支清空 redo', () => {
  const w = mkHistory({ v: 0 });
  w.hist.push(); w.cur = { v: 1 };
  w.hist.undo();
  w.hist.push(); w.cur = { v: 9 };     // 新分支
  assert.equal(w.hist.canRedo, false, 'undo 后的新编辑要废掉 redo');
  assert.equal(w.hist.redo(), false);
  w.hist.undo();
  assert.deepEqual(w.cur, { v: 0 });
});

test('上限 50：最早的快照被挤掉', () => {
  const w = mkHistory({ v: 0 });
  for (let i = 1; i <= 60; i++) { w.hist.push(); w.cur = { v: i }; }
  for (let i = 0; i < 50; i++) w.hist.undo();
  assert.equal(w.hist.canUndo, false, '挤掉最早快照后只能回到第 10 步');
  assert.equal(w.cur.v, 10);
});

test('clear 清栈（换工程用）', () => {
  const w = mkHistory({ v: 0 });
  w.hist.push(); w.cur = { v: 1 };
  w.hist.clear();
  assert.equal(w.hist.canUndo, false);
  assert.equal(w.hist.undo(), false);
});

test('快照必须是深拷贝（后续原地改动不能污染栈）', () => {
  const w = mkHistory({ notes: [{ startBeat: 0 }] });
  w.hist.push();
  w.cur.notes[0].startBeat = 5;        // 原地改
  w.hist.undo();
  assert.deepEqual(w.cur, { notes: [{ startBeat: 0 }] }, '栈里的快照不能被原地改动影响');
});

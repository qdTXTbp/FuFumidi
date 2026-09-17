// removeNotes（批量移除音符）的回归护栏。
//
// 背景：编辑页的「删除短音 / 清除鼓点 / 逻辑编辑器删除」此前都是逐个 indexOf + splice，
// 音符上万时合计 O(N²)，表现为点一下卡很久。这里钉住语义（就地修改、跨轨道、返回值），
// 并用一个明显超线性的输入规模守住「不会退化回逐个 splice」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { removeNotes } from '../src/core/util.js';

const note = (id, start) => ({ id, start, end: start + 10, midi: 60, vel: 90 });

test('移除一批音符并返回移除数，且是就地修改（数组引用不变）', () => {
  const notes = [note(1, 0), note(2, 10), note(3, 20), note(4, 30)];
  const tr = { notes };
  const n = removeNotes([tr], new Set([notes[1], notes[3]]));
  assert.equal(n, 2);
  assert.equal(tr.notes, notes, '必须就地修改，不能换数组引用（外部持有同一引用）');
  assert.deepEqual(tr.notes.map(x => x.id), [1, 3]);
});

test('可以跨多条轨道一次性移除', () => {
  const a = [note(1, 0), note(2, 10)];
  const b = [note(3, 0), note(4, 10)];
  const n = removeNotes([{ notes: a }, { notes: b }], new Set([a[0], b[1]]));
  assert.equal(n, 2);
  assert.deepEqual(a.map(x => x.id), [2]);
  assert.deepEqual(b.map(x => x.id), [3]);
});

test('集合里的音符不属于任何轨道时不报错、不计入', () => {
  const a = [note(1, 0)];
  const n = removeNotes([{ notes: a }], new Set([note(99, 0)]));
  assert.equal(n, 0);
  assert.equal(a.length, 1);
});

test('空集合 / 空轨道都是空操作', () => {
  assert.equal(removeNotes([], new Set([note(1, 0)])), 0);
  assert.equal(removeNotes([{ notes: [] }], new Set()), 0);
});

test('全部移除时不漏不重', () => {
  const notes = Array.from({ length: 500 }, (_, i) => note(i, i * 10));
  const n = removeNotes([{ notes }], new Set(notes));
  assert.equal(n, 500);
  assert.equal(notes.length, 0);
});

test('大输入下保持线性（守住「不要退化回逐个 splice」）', () => {
  // 2 万音符全删：逐个 indexOf + splice 在这种规模下是数亿次操作、明显超时；
  // 倒序单趟 splice 应当是个位数毫秒。这里给一个宽松上界，只在真退化时才会挂。
  const notes = Array.from({ length: 20000 }, (_, i) => note(i, i * 10));
  const doomed = new Set(notes);
  const t0 = process.hrtime.bigint();
  const n = removeNotes([{ notes }], doomed);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(n, 20000);
  assert.equal(notes.length, 0);
  assert.ok(ms < 300, '2 万音符批量删除耗时 ' + ms.toFixed(1) + 'ms，疑似退化回超线性实现');
});

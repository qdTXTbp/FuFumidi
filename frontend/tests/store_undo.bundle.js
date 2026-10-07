// singer store 撤销/重做集成冒烟 —— node 下 setActivePinia 直接实例化。
//
// ★ 这层是 store 集成（快照 = tracks 的 notes/curves/pitchCurve），上面
//   song_history.test.js 只测了栈语义；这里验「真的接到编辑器模型上」：
//   泳道写曲线 → undo → pitchCurve 镜像回滚；moveNotes → undo 恢复。
//
// api.ts 顶层读 `window.fuBridge`，node 下先放一个空 window 兜底。
globalThis.window = globalThis.window || {};

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const { useSingerStore } = await import('../src/stores/singer.ts');

function freshStore() {
  setActivePinia(createPinia());
  const s = useSingerStore();
  s.activeTrackId = s.tracks[0].id;   // fresh store 的 activeTrackId 默认为空
  return s;
}

test('undo/redo：泳道曲线写入可回滚（PIT 镜像同步恢复）', () => {
  const s = freshStore();
  const tr = s.tracks[0];
  s.pushUndo();
  s.setCurve(tr.id, 'PIT', [{ beat: 0, value: 100 }, { beat: 2, value: -50 }]);
  const t0 = s.tracks.find(x => x.id === tr.id);
  assert.equal(t0.curves.some(c => c.abbr === 'PIT'), true, '写入成功');
  assert.equal(t0.pitchCurve.length, 2, 'pitchCurve 镜像同步');
  s.undo();
  assert.equal(s.tracks.find(x => x.id === tr.id).curves.some(c => c.abbr === 'PIT'), false, 'undo 回滚曲线');
  assert.equal(s.tracks.find(x => x.id === tr.id).pitchCurve.length, 0, '镜像一起回滚');
  s.redo();
  assert.equal(s.tracks.find(x => x.id === tr.id).pitchCurve.length, 2, 'redo 恢复');
});

test('moveNotes / selectAll / undo 恢复音符', () => {
  const s = freshStore();
  const tr = s.tracks[0];
  const id = s.addNote(4, 60);
  s.pushUndo();
  s.moveNotes([id], 1, 2);
  const moved = s.tracks.find(x => x.id === tr.id).notes.find(n => n.id === id);
  assert.equal(moved.startBeat, 5);
  assert.equal(moved.pitch, 62);
  s.undo();
  const back = s.tracks.find(x => x.id === tr.id).notes.find(n => n.id === id);
  assert.equal(back.startBeat, 4, 'undo 恢复位置');
  assert.equal(back.pitch, 60, 'undo 恢复音高');

  s.selectAll();
  assert.deepEqual(s.selectedIds, [id], 'selectAll 选中当前轨全部音符');
});

test('clearHistory：换工程语义（undo 不跨工程）', () => {
  const s = freshStore();
  s.pushUndo();
  s.addNote(1, 60);
  s.clearHistory();
  assert.equal(s.canUndo(), false);
});

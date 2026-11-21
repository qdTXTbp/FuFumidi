// 「卷帘」页签的纯逻辑护栏（core/roll_preview.js）。
//
// 语义对齐 CodePen《midi可视化》(Vencent-Bill / xbGayxZ)：
//   纵轴按 127 键全键盘定位（top = (127-midi) × 行距）、音符条固定 6px、
//   最短高亮兜住短音符、BPM 覆盖只改预览倍率。
// 这些算式错 1px 肉眼很难发现，所以钉在这里。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLL_LIMITS, NOTE_H, KEY_COUNT, collectNotes, durationOf, rollWidth, rollHeight,
  noteRect, isNoteActive, followScroll, centerScrollTop, tempoFactorOf,
} from '../src/core/roll_preview.js';

const song = {
  tracks: [
    { notes: [{ start: 0, end: 1, midi: 60, vel: 0.8 }, { start: 2, end: 2.5, midi: 64, vel: 0.5 }] },
    { notes: [{ start: 1, end: 3, midi: 48 }] },
    { notes: [{ start: 0, end: 1 }] }, // 缺 midi：跳过，不能让 NaN 进坐标
  ],
};

test('collectNotes：拍平各轨、保留轨号、跳过残缺音符', () => {
  const out = collectNotes(song);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((n) => n.track), [0, 0, 1]);
  assert.equal(out[1].vel, 0.5);
  assert.equal(out[2].vel, 0.8, '缺 vel 给默认值');
  assert.deepEqual(collectNotes(null), []);
  assert.deepEqual(collectNotes({}), []);
});

test('collectNotes：end < start 的坏音符夹平，不会画成负宽', () => {
  const out = collectNotes({ tracks: [{ notes: [{ start: 5, end: 4, midi: 60 }] }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].end, 5);
});

test('durationOf / rollWidth：按最后一个音符的结束时间铺开（含末尾留白）', () => {
  const notes = collectNotes(song);
  assert.equal(durationOf(notes), 3);
  assert.equal(rollWidth(notes, 60, 100), 3 * 60 + 100);
  assert.equal(rollWidth([], 60, 100), 100, '空曲目只剩留白，不能是 NaN');
});

test('rollHeight：128 个键 × 行距（不按当前音域裁切）', () => {
  assert.equal(rollHeight(8), KEY_COUNT * 8);
  assert.equal(rollHeight(2), KEY_COUNT * 2);
});

test('noteRect：横轴按时间、纵轴按 127 键全键盘、高度固定 6px', () => {
  const r = noteRect({ start: 2, end: 3, midi: 60 }, { pxPerSec: 50, rowPx: 8 });
  assert.equal(r.x, 100);
  assert.equal(r.w, 50);
  assert.equal(r.y, (127 - 60) * 8, '音高越高越靠上；C4 在 127 键里的固定位置');
  assert.equal(r.h, NOTE_H);
  // 同一音符换一首曲子（音域不同）位置不变 —— 这是"全键盘定位"的意义
  const again = noteRect({ start: 2, end: 3, midi: 60 }, { pxPerSec: 50, rowPx: 8 });
  assert.deepEqual(again, r);
});

test('noteRect：极短音符仍有 2px 宽，否则等于没画', () => {
  const tiny = noteRect({ start: 0, end: 0.001, midi: 60 }, { pxPerSec: 20, rowPx: 8 });
  assert.equal(tiny.w, 2);
});

test('isNoteActive：窗口内高亮，右端开区间', () => {
  const n = { start: 1, end: 1.5 };
  assert.equal(isNoteActive(0.99, n, 0), false);
  assert.equal(isNoteActive(1, n, 0), true);
  assert.equal(isNoteActive(1.49, n, 0), true);
  assert.equal(isNoteActive(1.5, n, 0), false);
});

test('isNoteActive：最短高亮把一闪而过的短音符拉长到可见', () => {
  const staccato = { start: 2, end: 2.02 };
  assert.equal(isNoteActive(2.03, staccato, 0), false);
  assert.equal(isNoteActive(2.03, staccato, 0.2), true);
  assert.equal(isNoteActive(2.21, staccato, 0.2), false);
});

test('followScroll：播放头居中，两端夹住', () => {
  assert.equal(followScroll(500, 400, 4000), 300);
  assert.equal(followScroll(0, 400, 4000), 0, '开头不能负滚动');
  assert.equal(followScroll(3900, 400, 4000), 3600, '结尾不能滚过内容');
  assert.equal(followScroll(100, 800, 600), 0);
});

test('centerScrollTop：按音域居中，且夹在 [0, 内容高-视口]', () => {
  const notes = [{ midi: 36 }, { midi: 84 }];
  // 中心键位 = ((127-36)+(127-84))/2 = 67 → 67*8 + 3 = 539，减半个视口 200
  assert.equal(centerScrollTop(notes, 8, 400), 339);
  assert.equal(centerScrollTop(notes, 8, 5000), 0, '视口比内容还高时回到 0');
  assert.equal(centerScrollTop([], 8, 400), 0);
});

test('tempoFactorOf：BPM 覆盖只改预览倍率，缺省按 120 兜底', () => {
  assert.equal(tempoFactorOf(120, 0), 1);
  assert.equal(tempoFactorOf(120, 240), 2);
  assert.equal(tempoFactorOf(90, 180), 2);
  assert.equal(tempoFactorOf(0, 0), 1, 'BPM 缺失按 120');
  assert.equal(tempoFactorOf(undefined, undefined), 1);
});

test('ROLL_LIMITS：与参考稿的滑块范围一致', () => {
  assert.deepEqual(
    [ROLL_LIMITS.pxPerSec.min, ROLL_LIMITS.pxPerSec.max, ROLL_LIMITS.pxPerSec.def],
    [20, 300, 60],
  );
  assert.deepEqual(
    [ROLL_LIMITS.rowPx.min, ROLL_LIMITS.rowPx.max, ROLL_LIMITS.rowPx.def],
    [2, 20, 8],
  );
  assert.equal(ROLL_LIMITS.minHighlight.def, 0.2);
});

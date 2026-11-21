// 「卷帘」页签的纯逻辑护栏（core/roll_preview.js）。
//
// 两件事必须钉住，都是真机上踩过的：
//   ① 音符时间是 **tick 域**，要经 song.baseSec(tick) 转秒（当成秒读会得到一张空图）；
//   ② 多轨曲目要能按勾选过滤，且"一轨都没选"不等于"全选"。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLL_LIMITS, NOTE_H, KEY_COUNT, secMapper, collectTracks, collectNotes,
  durationOf, rollWidth, rollHeight, noteRect, isNoteActive, followScroll,
  centerScrollTop, tempoFactorOf,
} from '../src/core/roll_preview.js';

// 960 tick = 1 秒，方便断言
const song = {
  tpb: 480,
  initialBpm: 120,
  baseSec: (tick) => tick / 960,
  tracks: [
    { name: 'Lead', notes: [{ start: 0, end: 960, midi: 60, vel: 0.8 }, { start: 1920, end: 2400, midi: 64, vel: 0.5 }] },
    { name: 'Bass', notes: [{ start: 960, end: 2880, midi: 48 }] },
    { name: 'Bad', notes: [{ start: 0, end: 960 }] }, // 缺 midi：跳过
    { name: 'Empty', notes: [] },
  ],
};

test('secMapper：优先用曲目自带的 baseSec（变速地图已展开）', () => {
  const toSec = secMapper(song);
  assert.equal(toSec(0), 0);
  assert.equal(toSec(960), 1);
  assert.equal(toSec(2880), 3);
});

test('secMapper：没有 baseSec 时按 tpb + BPM 匀速兜底', () => {
  const toSec = secMapper({ tpb: 480, initialBpm: 120 }); // 480 tick/拍，120bpm → 一拍 0.5s
  assert.equal(toSec(0), 0);
  assert.equal(toSec(480), 0.5);
  assert.equal(toSec(960), 1);
  assert.equal(secMapper({})(960), 1, '全缺时按 480/120 兜底');
});

test('collectTracks：列出所有轨（含空轨），带名字与音符数', () => {
  const list = collectTracks(song);
  assert.deepEqual(list.map((t) => t.index), [0, 1, 2, 3]);
  assert.equal(list[0].name, 'Lead');
  assert.equal(list[0].count, 2);
  assert.equal(list[2].count, 1);
  assert.equal(list[3].count, 0, '空轨要能看见（置灰），不能凭空消失');
  assert.deepEqual(collectTracks(null), []);
});

test('collectNotes：tick → 秒，跳过缺字段的音符，带轨号', () => {
  const out = collectNotes(song);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((n) => n.track), [0, 0, 1]);
  assert.deepEqual([out[0].start, out[0].end], [0, 1]);
  assert.deepEqual([out[1].start, out[1].end], [2, 2.5]);
  assert.deepEqual([out[2].start, out[2].end], [1, 3]);
  assert.equal(out[2].vel, 0.8, '缺 vel 给默认值');
});

test('collectNotes：按勾选的轨过滤；空集合 = 一轨都不选（不是全选）', () => {
  const onlyBass = collectNotes(song, new Set([1]));
  assert.equal(onlyBass.length, 1);
  assert.equal(onlyBass[0].midi, 48);
  assert.equal(collectNotes(song, new Set([0, 1])).length, 3);
  assert.equal(collectNotes(song, new Set()).length, 0, '全取消勾选后应该是空的');
  assert.equal(collectNotes(song, null).length, 3, 'null = 全选');
});

test('collectNotes：end < start 的坏音符夹平，不会画成负宽', () => {
  const out = collectNotes({ baseSec: (t) => t / 960, tracks: [{ notes: [{ start: 960, end: 480, midi: 60 }] }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 1);
  assert.equal(out[0].end, 1);
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

test('noteRect：横轴按秒、纵轴按 127 键全键盘、高度固定 6px', () => {
  const r = noteRect({ start: 2, end: 3, midi: 60 }, { pxPerSec: 50, rowPx: 8 });
  assert.equal(r.x, 100);
  assert.equal(r.w, 50);
  assert.equal(r.y, (127 - 60) * 8);
  assert.equal(r.h, NOTE_H);
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
  assert.equal(followScroll(0, 400, 4000), 0);
  assert.equal(followScroll(3900, 400, 4000), 3600);
  assert.equal(followScroll(100, 800, 600), 0);
});

test('centerScrollTop：按音域居中，且夹在 [0, 内容高-视口]', () => {
  const notes = [{ midi: 36 }, { midi: 84 }];
  assert.equal(centerScrollTop(notes, 8, 400), 339);
  assert.equal(centerScrollTop(notes, 8, 5000), 0);
  assert.equal(centerScrollTop([], 8, 400), 0);
});

test('tempoFactorOf：BPM 覆盖只改预览倍率，缺省按 120 兜底', () => {
  assert.equal(tempoFactorOf(120, 0), 1);
  assert.equal(tempoFactorOf(120, 240), 2);
  assert.equal(tempoFactorOf(90, 180), 2);
  assert.equal(tempoFactorOf(0, 0), 1);
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

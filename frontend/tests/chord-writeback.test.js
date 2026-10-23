// P1-2b 和弦轨写回 MIDI（marker 元事件）测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chordMarkersOf, mergeChordMarkers, keySpecLabel, detectChordTrack,
} from '../src/core/analysis.js';

const chords = [
  { tick: 0, name: 'C' }, { tick: 1920, name: 'C' }, { tick: 3840, name: 'F' },
  { tick: 5760, name: 'F' }, { tick: 7680, name: 'G7' },
];

test('P1-2b chordMarkersOf：默认合并相邻同名和弦，生成 chordGen marker', () => {
  const ms = chordMarkersOf(chords);
  assert.deepEqual(ms.map((m) => [m.tick, m.text]), [[0, 'C'], [3840, 'F'], [7680, 'G7']]);
  assert.ok(ms.every((m) => m.type === 'marker' && m.chordGen === true));
});

test('P1-2b chordMarkersOf：collapse=false 保留每个小节；空输入/坏数据安全', () => {
  const ms = chordMarkersOf(chords, { collapse: false });
  assert.equal(ms.length, 5);
  assert.deepEqual(chordMarkersOf([]), []);
  assert.deepEqual(chordMarkersOf(null), []);
  assert.deepEqual(chordMarkersOf([{ tick: 0 }, { tick: 1, name: '' }]), []);
  assert.equal(chordMarkersOf([{ tick: -5, name: 'C' }])[0].tick, 0, '负 tick 夹到 0');
});

test('P1-2b mergeChordMarkers：只替换上一轮生成的 marker，保留用户手写事件', () => {
  const events = [
    { tick: 0, type: 'marker', text: '用户手写 Intro' },
    { tick: 100, type: 'marker', text: 'C', chordGen: true },
    { tick: 200, type: 'text', text: '备注' },
  ];
  const merged = mergeChordMarkers(events, chordMarkersOf(chords));
  const markers = merged.filter((e) => e.type === 'marker');
  assert.deepEqual(markers.map((m) => m.text), ['用户手写 Intro', 'C', 'F', 'G7']);
  assert.ok(!merged.some((e) => e.chordGen && e.tick === 100), '旧生成 marker 被清掉');
  assert.ok(merged.some((e) => e.type === 'text' && e.text === '备注'), '其他事件保留');
  assert.deepEqual(merged.map((e) => e.tick), merged.map((e) => e.tick).slice().sort((a, b) => a - b), '按 tick 排序');
  assert.equal(events.length, 3, '不改入参');
});

test('P1-2b mergeChordMarkers：连续重写不累积（幂等）', () => {
  const first = mergeChordMarkers([], chordMarkersOf(chords));
  const second = mergeChordMarkers(first, chordMarkersOf(chords));
  assert.equal(second.filter((e) => e.chordGen).length, first.filter((e) => e.chordGen).length);
});

test('P1-2b keySpecLabel：调性显示名', () => {
  assert.equal(keySpecLabel({ root: 0, mode: 'major' }), 'C 大调');
  assert.equal(keySpecLabel({ root: 9, mode: 'minor' }), 'A 小调');
  assert.equal(keySpecLabel(null), '');
});

test('P1-2b 与 detectChordTrack 串起来：C→F 生成两个 marker', () => {
  const song = {
    tpb: 480, sigMap: [{ tick: 0, num: 4, den: 4 }], totalTicks: 4 * 1920,
    tracks: [{ notes: [
      { start: 0, end: 1920, midi: 60, vel: 100 }, { start: 0, end: 1920, midi: 64, vel: 100 }, { start: 0, end: 1920, midi: 67, vel: 100 },
      { start: 1920, end: 3840, midi: 60, vel: 100 }, { start: 1920, end: 3840, midi: 64, vel: 100 }, { start: 1920, end: 3840, midi: 67, vel: 100 },
      { start: 3840, end: 5760, midi: 65, vel: 100 }, { start: 3840, end: 5760, midi: 69, vel: 100 }, { start: 3840, end: 5760, midi: 72, vel: 100 },
      { start: 5760, end: 7680, midi: 65, vel: 100 }, { start: 5760, end: 7680, midi: 69, vel: 100 }, { start: 5760, end: 7680, midi: 72, vel: 100 },
    ] }],
  };
  const track = detectChordTrack(song);
  const ms = chordMarkersOf(track);
  assert.deepEqual(ms.map((m) => m.text), ['C', 'F']);
  assert.deepEqual(ms.map((m) => m.tick), [0, 3840]);
});

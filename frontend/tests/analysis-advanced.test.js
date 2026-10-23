// P1-2 分析升级测试：转调滑窗 / 段落聚类 / 罗马数字 / 和弦名解析
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKeyWindows, detectModulations, detectSegments, parseChordName, romanNumeralOf, detectChordTrack,
} from '../src/core/analysis.js';

const TPB = 480;
function mkSong(bars, notes) {
  return {
    tpb: TPB, sigMap: [{ tick: 0, num: 4, den: 4 }], totalTicks: bars * 1920,
    tracks: [{ notes }],
  };
}
function chordBar(startBar, midis, vel = 100) {
  const tick = startBar * 1920;
  return midis.map((m) => ({ start: tick, end: tick + 1920, midi: m, vel }));
}
function scaleNotes(startTick, beats, pcs, vel = 100) {
  const out = [];
  for (let i = 0; i < beats; i++) out.push({ start: startTick + i * TPB, end: startTick + (i + 1) * TPB, midi: 60 + pcs[i % pcs.length], vel });
  return out;
}

test('P1-2 detectKeyWindows：C 大调音阶窗口应判 C 大调，窗口数与 hop 一致', () => {
  const notes = scaleNotes(0, 32, [0, 2, 4, 5, 7, 9, 11, 12]);
  const wins = detectKeyWindows(notes, { tpb: TPB, windowBeats: 8, hopBeats: 4, minNotes: 4 });
  assert.ok(wins.length >= 4, '窗口数 ' + wins.length);
  const first = wins[0];
  assert.equal(first.root, 0);
  assert.equal(first.mode, 'major');
  assert.ok(first.score > 0.4, 'K-S 相关度 > 0.4，实际 ' + first.score);
  assert.ok(first.margin > 0, 'margin > 0');
  assert.equal(wins[1].startTick - wins[0].startTick, 4 * TPB, 'hop 4 拍');
});

test('P1-2 detectKeyWindows：空输入 / 音符太少返回空', () => {
  assert.deepEqual(detectKeyWindows([], {}), []);
  assert.deepEqual(detectKeyWindows([{ start: 0, end: 100, midi: 60 }], { minNotes: 6 }), []);
});

test('P1-2 detectModulations：C 大调前段 + G 大调后段 → 两个转调段', () => {
  const cMajor = scaleNotes(0, 24, [0, 2, 4, 5, 7, 9, 11, 12]);
  const gMajor = scaleNotes(24 * TPB, 24, [7, 9, 11, 12, 14, 16, 18, 19], 100);
  const segs = detectModulations(cMajor.concat(gMajor), { tpb: TPB, windowBeats: 12, hopBeats: 6, threshold: 0.02 });
  assert.ok(segs.length >= 2, '至少两段：' + JSON.stringify(segs.map((s) => [s.root, s.mode])));
  assert.equal(segs[0].root, 0, '前段 C');
  const roots = segs.map((s) => s.root);
  assert.ok(roots.includes(7), '后段出现 G（实际 ' + JSON.stringify(roots) + '）');
});

test('P1-2 detectSegments：C 四小节 + F 四小节 → 和弦驱动切段', () => {
  const notes = [];
  for (let b = 0; b < 4; b++) notes.push(...chordBar(b, [60, 64, 67]));
  for (let b = 4; b < 8; b++) notes.push(...chordBar(b, [65, 69, 72]));
  const song = mkSong(8, notes);
  const segs = detectSegments(song, { minBars: 2 });
  assert.ok(segs.length >= 2, '段数 ' + segs.length + '：' + JSON.stringify(segs.map((s) => s.label)));
  assert.equal(segs[0].startBar, 1);
  assert.ok(segs[0].chords.some((c) => c.name === 'C'), '首段含 C：' + JSON.stringify(segs[0].chords));
  assert.ok(segs.some((s) => s.chords.some((c) => c.name === 'F')), '有段含 F');
});

test('P1-2 detectSegments：能量突变也会切段（和弦不变）', () => {
  const notes = [];
  for (let b = 0; b < 4; b++) notes.push(...chordBar(b, [60, 64, 67], 20));   // 弱
  for (let b = 4; b < 8; b++) notes.push(...chordBar(b, [60, 64, 67], 120));  // 强
  const segs = detectSegments(mkSong(8, notes), { minBars: 2 });
  assert.ok(segs.length >= 2, '能量突变切段，实际 ' + segs.length);
  assert.ok(segs.some((s) => s.energy > 0));
});

test('P1-2 detectSegments：空曲目安全返回', () => {
  assert.deepEqual(detectSegments(null), []);
  assert.deepEqual(detectSegments(mkSong(1, [])), []);
});

test('P1-2 parseChordName：根音/后缀/转位', () => {
  assert.deepEqual(parseChordName('Am7'), { root: 9, suffix: 'm7', bass: -1 });
  assert.deepEqual(parseChordName('G7/B'), { root: 7, suffix: '7', bass: 11 });
  assert.deepEqual(parseChordName('C'), { root: 0, suffix: '', bass: -1 });
  assert.deepEqual(parseChordName('F#dim'), { root: 6, suffix: 'dim', bass: -1 });
  assert.equal(parseChordName('H7'), null);
  assert.equal(parseChordName(''), null);
});

test('P1-2 romanNumeralOf：大调级数 / 大小写 / 圈外音升降号', () => {
  const C = { root: 0, mode: 'major' };
  assert.equal(romanNumeralOf('C', C), 'I');
  assert.equal(romanNumeralOf('Dm7', C), 'ii7');
  assert.equal(romanNumeralOf('Em', C), 'iii');
  assert.equal(romanNumeralOf('F', C), 'IV');
  assert.equal(romanNumeralOf('G7', C), 'V7');
  assert.equal(romanNumeralOf('Am', C), 'vi');
  assert.equal(romanNumeralOf('Bdim', C), 'viidim');
  assert.equal(romanNumeralOf('Bb', C), 'bVII');
  assert.equal(romanNumeralOf('F#dim', C), '#ivdim');
  assert.equal(romanNumeralOf('C', { root: 7, mode: 'major' }), 'IV', 'G 大调里的 C = IV');
  assert.equal(romanNumeralOf('不合法', C), '');
});

test('P1-2 detectChordTrack 回归：逐小节返回 C / F', () => {
  const notes = [];
  for (let b = 0; b < 2; b++) notes.push(...chordBar(b, [60, 64, 67]));
  for (let b = 2; b < 4; b++) notes.push(...chordBar(b, [65, 69, 72]));
  const track = detectChordTrack(mkSong(4, notes));
  assert.deepEqual(track.map((c) => c.name), ['C', 'C', 'F', 'F']);
  assert.equal(track[0].tick, 0);
  assert.equal(track[1].tick, 1920);
});

// 延音踏板收尾：文件里「按下不抬起」必须补一条 CC64=0。
//
// 根因：FluidSynth 的 sustain 是通道级状态。CC64≥64 时所有 note-off 只把声部标记为
// sustained、不释放；文件缺少 CC64=0 就一直挂着，声部越积越多、声音永不消失 ——
// 用户听到的就是「某个音一直响不停」。大量真实 MIDI（尤其是导出/转换而来的）都有这个缺陷。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/core/player.js';

function preparePlayer(ccs, notes = [{ start: 0, end: 1000, midi: 60, vel: 80 }]) {
  const song = {
    tpb: 480,
    totalTicks: 10000,
    totalSec: 10,
    baseSec: (t) => t / 1000,
    secToTick: (s) => Math.round(s * 1000),
    tracks: [{ name: 'p', index: 0, ch: 0, program: 0, notes, ccs, events: [] }],
    chanStateAt: () => ({ program: 0, bank: 0 }),
  };
  const p = Object.create(Player.prototype);
  p.song = song;
  p.ctx = { currentTime: 0 };
  p.syn = { midiEvent() {}, allStop() {}, sweepStuckNotes() {} };
  p.prepare();
  return p;
}

test('踏板按下但没抬起 → 曲尾补一条 CC64=0', () => {
  const p = preparePlayer([{ tick: 0, cc: 64, cv: 127, ch: 0 }]);
  const close = p.ctlEvents.filter((c) => c.kind === 'cc' && c.cc === 64 && c.val === 0 && c.ch === 0);
  assert.equal(close.length, 1, '必须补一条踏板抬起');
  assert.equal(close[0].start, 10000, '补在曲尾（totalTicks）');
  assert.ok(p.ctlEvents.every((c, i, a) => i === 0 || a[i - 1].start <= c.start), '补完仍按时间有序');
  // ★ 未抬起的踏板不能把音符本身延长到曲尾 —— 否则整首都在响，等于人为制造卡音
  assert.equal(p.events[0].end, 1000, '音符保持自己的时值');
});

test('踏板正常抬起 → 不重复补', () => {
  const p = preparePlayer([
    { tick: 0, cc: 64, cv: 127, ch: 0 },
    { tick: 2000, cc: 64, cv: 0, ch: 0 },
  ]);
  const close = p.ctlEvents.filter((c) => c.kind === 'cc' && c.cc === 64 && c.val === 0 && c.ch === 0);
  assert.equal(close.length, 1);
  assert.equal(close[0].start, 2000, '用文件自己的抬起');
});

test('踏板正常抬起 → 音符延长到抬起点（原有延音语义不变）', () => {
  const p = preparePlayer([
    { tick: 0, cc: 64, cv: 127, ch: 0 },
    { tick: 3000, cc: 64, cv: 0, ch: 0 },
  ], [{ start: 0, end: 1000, midi: 60, vel: 80 }]);
  assert.equal(p.events[0].end, 3000, '琴键抬起后由踏板托住，到 CC64=0 才结束');
});

test('多通道各自独立收尾', () => {
  const p = preparePlayer([
    { tick: 0, cc: 64, cv: 127, ch: 0 },
    { tick: 0, cc: 64, cv: 100, ch: 3 },
    { tick: 500, cc: 64, cv: 0, ch: 3 },
  ]);
  const c0 = p.ctlEvents.filter((c) => c.kind === 'cc' && c.cc === 64 && c.val === 0 && c.ch === 0);
  const c3 = p.ctlEvents.filter((c) => c.kind === 'cc' && c.cc === 64 && c.val === 0 && c.ch === 3);
  assert.equal(c0.length, 1);
  assert.equal(c0[0].start, 10000);
  assert.equal(c3.length, 1);
  assert.equal(c3[0].start, 500);
});

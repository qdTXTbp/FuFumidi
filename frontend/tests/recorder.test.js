import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecorder, quantizeGridTicks, quantizeTick, trimSamePitchOverlaps, applyTake, calibrateLatency, recordStartPlan,
} from '../src/core/recorder.js';

// tpb=480 / 120BPM → 1 tick = 1.0417ms；480 tick = 1 拍 = 500ms
const MS = (ticks) => ticks * (60000 / (120 * 480));

function rec(opts = {}) {
  return createRecorder(Object.assign({ tpb: 480, bpm: 120, preRollBars: 0, quantize: 'off', mode: 'overdub' }, opts));
}

test('P0-3 量化网格：off / 1/4 / 1/8 / 1/16 / 1/32 / 直接给 tick', () => {
  assert.equal(quantizeGridTicks('off', 480), 0);
  assert.equal(quantizeGridTicks('1/4', 480), 480);
  assert.equal(quantizeGridTicks('1/8', 480), 240);
  assert.equal(quantizeGridTicks('1/16', 480), 120);
  assert.equal(quantizeGridTicks('1/32', 480), 60);
  assert.equal(quantizeGridTicks(960, 480), 960);
  assert.equal(quantizeGridTicks('??', 480), 0);
  assert.equal(quantizeTick(100, 240), 0);
  assert.equal(quantizeTick(140, 240), 240);
  assert.equal(quantizeTick(140, 0), 140);
});

test('P0-3 基础录音：时间戳 → tick → note on/off', () => {
  const r = rec();
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: 7680 });
  assert.equal(r.phase(), 'recording', '无预备拍直接录');
  r.noteOn(60, 100, MS(480));
  r.noteOff(60, MS(960));
  const take = r.stop(MS(1500));
  assert.equal(take.notes.length, 1);
  assert.deepEqual([take.notes[0].start, take.notes[0].end, take.notes[0].midi, take.notes[0].vel], [480, 960, 60, 100]);
  assert.equal(take.takeStartTick, 0);
  assert.equal(take.passes, 1);
});

test('P0-3 预备拍：准备期间松开的音不算，按住到正式录音的从 0 算', () => {
  const r = rec({ preRollBars: 1 });   // 1 小节 4/4 = 1920 tick = 2000ms
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: 7680 });
  assert.equal(r.phase(), 'preroll');
  r.noteOn(60, 90, MS(500));       // 准备期间按下
  r.noteOff(60, MS(900));          // 准备期间松开 → 丢弃
  r.noteOn(62, 90, MS(1500));      // 准备期间按下并一直按着
  r.noteOff(62, MS(2400));         // 记录开始（2000ms）后才松开
  const take = r.stop(MS(3000));
  assert.equal(r.phase(), 'stopped');
  assert.equal(take.notes.length, 1, '准备期间松开的键不算，跨过边界的键要保留');
  assert.deepEqual([take.notes[0].midi, take.notes[0].start, take.notes[0].end], [62, 0, 480]);
});

test('P0-3 预备拍中途停止：返回 null（没有 take）', () => {
  const r = rec({ preRollBars: 1 });
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: 7680 });
  r.noteOn(60, 100, MS(100));
  assert.equal(r.stop(MS(500)), null);
  assert.equal(r.phase(), 'stopped');
});

test('P0-3 量化：1/8 吸附起止，且不会把音吸没', () => {
  const r = rec({ quantize: '1/8' });
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: 7680 });
  r.noteOn(64, 100, MS(528));   // 528 → 吸到 480
  r.noteOff(64, MS(816));       // 816 → 吸到 720（≥ 480+240）
  const take = r.stop(MS(900));
  assert.deepEqual([take.notes[0].start, take.notes[0].end], [480, 720]);
  assert.equal(take.gridTicks, 240);
});

test('P0-3 同音重复按下：先收掉上一个音', () => {
  const r = rec();
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: 7680 });
  r.noteOn(60, 80, MS(100));
  r.noteOn(60, 90, MS(300));
  const take = r.stop(MS(400));
  assert.equal(take.notes.length, 2);
  assert.deepEqual([take.notes[0].start, take.notes[0].end], [100, 300]);
  assert.deepEqual([take.notes[1].start, take.notes[1].end], [300, Math.round(MS(400) / MS(1))]);
});

test('P0-3 录音停止时还按着的音：自动在停止点收尾', () => {
  const r = rec();
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: 7680 });
  r.noteOn(60, 100, MS(100));
  const take = r.stop(MS(1100));
  assert.equal(take.notes.length, 1);
  assert.equal(take.notes[0].end, 1100);
});

test('P0-3 循环 take：overdub 保留所有圈，replace 只留最后一圈', () => {
  const loopLen = 1920;
  const overdub = rec({ mode: 'overdub' });
  overdub.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: loopLen });
  overdub.noteOn(60, 100, MS(100));
  overdub.noteOff(60, MS(200));
  overdub.advanceLoop();
  overdub.noteOn(64, 100, MS(loopLen + 300));
  overdub.noteOff(64, MS(loopLen + 400));
  const takeA = overdub.stop(MS(loopLen + 500));
  assert.equal(takeA.passes, 2);
  assert.deepEqual(takeA.notes.map((n) => [n.midi, n.start]), [[60, 100], [64, 300]], '第二圈相对本圈起点计 tick');

  const replace = rec({ mode: 'replace' });
  replace.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: loopLen });
  replace.noteOn(60, 100, MS(100));
  replace.noteOff(60, MS(200));
  replace.advanceLoop();
  replace.noteOn(64, 100, MS(loopLen + 300));
  replace.noteOff(64, MS(loopLen + 400));
  const takeB = replace.stop(MS(loopLen + 500));
  assert.deepEqual(takeB.notes.map((n) => n.midi), [64], 'replace 只保留最后一圈');
});

test('P0-3 跨圈按住的音：在圈尾收尾，不会出现同音高叠音', () => {
  const loopLen = 1920;
  const r = rec();
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: loopLen });
  r.noteOn(60, 100, MS(100));
  r.advanceLoop();
  r.noteOff(60, MS(loopLen + 300));
  const take = r.stop(MS(loopLen + 400));
  assert.equal(take.notes.length, 1, '跨圈按住只保留一个音（圈尾收尾）');
  assert.deepEqual([take.notes[0].start, take.notes[0].end], [100, loopLen]);
});

test('P0-3 输入延迟补偿：所有事件时间先减去 inputOffsetMs', () => {
  const r = rec({ inputOffsetMs: 20 });
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: 7680 });
  r.noteOn(60, 100, MS(500) + 20);
  r.noteOff(60, MS(1000) + 20);
  const take = r.stop(MS(1500) + 20);
  assert.deepEqual([take.notes[0].start, take.notes[0].end], [500, 1000]);
});

test('P0-3 applyTake replace：只替换 take 窗口内的旧音', () => {
  const existing = [
    { start: 1000, end: 1200, midi: 60, vel: 80 },
    { start: 3000, end: 3100, midi: 62, vel: 80 },
  ];
  const take = { mode: 'replace', takeStartTick: 960, loopEndTick: 2000, loopLen: 1040, notes: [{ start: 0, end: 240, midi: 64, vel: 90 }] };
  const out = applyTake(existing, take);
  assert.deepEqual(out.map((n) => [n.start, n.end, n.midi]), [[960, 1200, 64], [3000, 3100, 62]]);
  assert.equal(existing.length, 2, '不改入参');
});

test('P0-3 applyTake overdub：同音高重叠的旧音被截断，异音高保留', () => {
  const existing = [
    { start: 1000, end: 1400, midi: 60, vel: 80 },
    { start: 1000, end: 1400, midi: 62, vel: 80 },
    { start: 500, end: 800, midi: 60, vel: 80 },
  ];
  const take = { mode: 'overdub', takeStartTick: 960, loopEndTick: 2000, loopLen: 1040, notes: [{ start: 100, end: 300, midi: 60, vel: 90 }] };
  const out = applyTake(existing, take);
  const old60 = out.find((n) => n.midi === 60 && n.start === 1000);
  assert.deepEqual([old60.start, old60.end], [1000, 1060], '旧 60 号音被新音起点截断');
  assert.ok(out.some((n) => n.midi === 62 && n.start === 1000 && n.end === 1400), '异音高不受影响');
  assert.ok(out.some((n) => n.midi === 60 && n.start === 1060), '新音落在正确绝对位置');
});

test('P0-3 trimSamePitchOverlaps：同音高重叠的后音截断前音', () => {
  const out = trimSamePitchOverlaps([
    { start: 0, end: 500, midi: 60, vel: 80 },
    { start: 300, end: 700, midi: 60, vel: 80 },
    { start: 800, end: 900, midi: 62, vel: 80 },
  ]);
  assert.deepEqual(out.filter((n) => n.midi === 60).map((n) => [n.start, n.end]), [[0, 300], [300, 700]]);
});

test('P0-3 延迟校准：中位偏移 + 稳定性判定', () => {
  const clicks = [1000, 2000, 3000, 4000];
  const stable = calibrateLatency(clicks, [1020, 2021, 3019, 4022]);
  assert.equal(stable.count, 4);
  assert.ok(Math.abs(stable.medianMs - 20) <= 1.5, '中位偏移≈20ms，实际 ' + stable.medianMs);
  assert.ok(stable.ok, '稳定敲击应判 ok（跨度≤5ms），实际 ' + stable.spreadMs);
  const noisy = calibrateLatency(clicks, [1000, 2060, 3000, 4100]);
  assert.equal(noisy.ok, false, '抖动大不通过');
  assert.equal(calibrateLatency([], []).ok, false);
  assert.equal(calibrateLatency(clicks, [1000]).count, 1);
  assert.equal(calibrateLatency(clicks, [1000]).ok, false, '样本不足不通过');
});

test('P0-3 非法事件保护：没 start 不录、noteOff 无对应 on 返回 false', () => {
  const r = rec();
  assert.equal(r.noteOn(60, 100, MS(100)), false);
  assert.equal(r.stop(MS(200)), null);
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: 7680 });
  assert.equal(r.noteOff(60, MS(100)), false);
  assert.equal(r.noteOn(200, 500, MS(100)), true, '非法音高/力度会被夹到合法范围');
  const take = r.stop(MS(200));
  assert.equal(take.notes[0].midi, 127);
  assert.equal(take.notes[0].vel, 127);
});


test('P0-3b recordStartPlan：预备拍让播放从「起点 − 预备拍」开始，结束时正好在起点', () => {
  const noPre = recordStartPlan({ startTick: 4800, barTicks: 1920, preRollBars: 0, bpm: 120, tpb: 480 });
  assert.equal(noPre.seekTick, 4800);
  assert.equal(noPre.preRollMs, 0);
  const one = recordStartPlan({ startTick: 4800, barTicks: 1920, preRollBars: 1, bpm: 120, tpb: 480 });
  assert.equal(one.seekTick, 2880);
  assert.equal(one.preRollTicks, 1920);
  assert.ok(Math.abs(one.preRollMs - 2000) < 1e-6, '4/4 120BPM 一小节 = 2000ms，实际 ' + one.preRollMs);
  const two = recordStartPlan({ startTick: 4800, barTicks: 1920, preRollBars: 2, bpm: 60, tpb: 480 });
  assert.equal(two.seekTick, 960);
  assert.ok(Math.abs(two.preRollMs - 8000) < 1e-6, '60BPM 两小节 = 8000ms');
});

test('P0-3b recordStartPlan：起点靠前时 seek 夹到 0，预备拍最多 4 小节', () => {
  const p = recordStartPlan({ startTick: 500, barTicks: 1920, preRollBars: 2, bpm: 120, tpb: 480 });
  assert.equal(p.seekTick, 0, '不能 seek 到负数');
  assert.equal(recordStartPlan({ startTick: 0, barTicks: 1920, preRollBars: 9 }).preRollBars, 4);
});

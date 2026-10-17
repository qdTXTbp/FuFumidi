import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTimeline, secOfTick, tickOfSec, barBeatOf, tickOfBarBeat, barTicksOf,
  iterBars, snapStep, snapTick, rulerMarks, timelineOfSong, cloneTimeline, playheadSec,
} from '../src/core/timeline.js';
import { buildSong } from '../src/core/midi.js';

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, (msg || "") + " 期望 " + b + "，实际 " + a);

test("normalize：空输入给默认（tpb 480 / 120BPM / 4/4 / 首项 tick0）", () => {
  const tl = normalizeTimeline({});
  assert.equal(tl.tpb, 480);
  assert.deepEqual(tl.tempoMap, [{ tick: 0, us: 500000 }]);
  assert.deepEqual(tl.sigMap, [{ tick: 0, num: 4, den: 4 }]);
  assert.equal(tl.smpte, null);
  assert.deepEqual(tl.loop, { a: 0, b: 0 });
});

test("normalize：乱序/同 tick 去重/缺首项补齐", () => {
  const tl = normalizeTimeline({
    tpb: 960,
    tempoMap: [{ tick: 960, us: 250000 }, { tick: 0, us: 400000 }, { tick: 960, us: 300000 }],
    sigMap: [{ tick: 1920, num: 6, den: 8 }],
  });
  assert.deepEqual(tl.tempoMap.map((e) => [e.tick, e.us]), [[0, 400000], [960, 300000]], "同 tick 后者覆盖、按 tick 排序");
  assert.deepEqual(tl.sigMap.map((e) => [e.tick, e.num, e.den]), [[0, 4, 4], [1920, 6, 8]], "缺 tick0 时补默认 4/4");
});

test("secOfTick / tickOfSec：恒定速度互为反函数", () => {
  const tl = normalizeTimeline({ tpb: 480, tempoMap: [{ tick: 0, us: 500000 }] });
  near(secOfTick(tl, 480), 0.5);
  near(secOfTick(tl, 960), 1.0);
  near(tickOfSec(tl, 1.0), 960);
  near(tickOfSec(tl, secOfTick(tl, 777)), 777, 1e-6);
});

test("secOfTick：变速分段积分（前段 120BPM，后段 240BPM）", () => {
  const tl = normalizeTimeline({ tpb: 480, tempoMap: [{ tick: 0, us: 500000 }, { tick: 960, us: 250000 }] });
  near(secOfTick(tl, 960), 1.0);
  near(secOfTick(tl, 1440), 1.25);
  near(secOfTick(tl, 1920), 1.5);
  near(tickOfSec(tl, 1.25), 1440);
  near(tickOfSec(tl, 0.5), 480);
  near(tickOfSec(tl, 2.0), 2880);
});

test("多拍号：小节/拍换算与反函数（4/4 → 6/8 → 3/4）", () => {
  const tl = normalizeTimeline({
    tpb: 480,
    sigMap: [{ tick: 0, num: 4, den: 4 }, { tick: 7680, num: 6, den: 8 }, { tick: 12000, num: 3, den: 4 }],
  });
  assert.equal(barTicksOf({ num: 4, den: 4 }, 480), 1920);
  assert.equal(barTicksOf({ num: 6, den: 8 }, 480), 1440);
  assert.equal(barTicksOf({ num: 3, den: 4 }, 480), 1440);

  let bb = barBeatOf(tl, 0);
  assert.deepEqual([bb.bar, bb.beat, bb.num, bb.den], [0, 0, 4, 4]);
  bb = barBeatOf(tl, 1920);
  assert.deepEqual([bb.bar, bb.beat], [1, 0]);
  bb = barBeatOf(tl, 7680);
  assert.deepEqual([bb.bar, bb.beat, bb.num, bb.den], [4, 0, 6, 8]);
  bb = barBeatOf(tl, 9120);
  assert.deepEqual([bb.bar, bb.beat], [5, 0]);
  bb = barBeatOf(tl, 12000);
  assert.deepEqual([bb.bar, bb.beat, bb.num, bb.den], [7, 0, 3, 4]);
  bb = barBeatOf(tl, 12480);
  assert.deepEqual([bb.bar, bb.beat], [7, 1]);

  assert.equal(tickOfBarBeat(tl, 0, 0), 0);
  assert.equal(tickOfBarBeat(tl, 1, 2), 2880);
  assert.equal(tickOfBarBeat(tl, 4, 0), 7680);
  assert.equal(tickOfBarBeat(tl, 6, 0), 10560);
  assert.equal(tickOfBarBeat(tl, 7, 0), 12000);
  assert.equal(tickOfBarBeat(tl, 7, 2), 12960);
  assert.equal(tickOfBarBeat(tl, 8, 0), 13440);
  // 反函数往返
  for (const tick of [0, 480, 1920, 7680, 8400, 9120, 12000, 12480, 13440]) {
    const b = barBeatOf(tl, tick);
    assert.equal(tickOfBarBeat(tl, b.bar, b.beat), tick, "tick=" + tick);
  }
});

test("iterBars / rulerMarks：跨拍号逐小节、bar 从 1 显示", () => {
  const tl = normalizeTimeline({
    tpb: 480,
    sigMap: [{ tick: 0, num: 4, den: 4 }, { tick: 7680, num: 6, den: 8 }],
  });
  const bars = iterBars(tl, 0, 11000);
  assert.deepEqual(bars.slice(0, 3).map((b) => [b.bar, b.tick]), [[0, 0], [1, 1920], [2, 3840]]);
  assert.deepEqual([bars[4].bar, bars[4].tick, bars[4].num, bars[4].den], [4, 7680, 6, 8]);
  assert.equal(bars[5].tick, 9120);
  const marks = rulerMarks(tl, 0, 2000);
  assert.deepEqual(marks.map((m) => m.label), ["1", "2"]);
});

test("snapStep / snapTick：bar、beat、等分、强度、frame", () => {
  const tl = normalizeTimeline({ tpb: 480, sigMap: [{ tick: 0, num: 4, den: 4 }] });
  assert.equal(snapStep(tl, "beat"), 480);
  assert.equal(snapStep(tl, "bar"), 1920);
  assert.equal(snapStep(tl, "eighth"), 240);
  assert.equal(snapStep(tl, "sixteenth"), 120);
  assert.equal(snapStep(tl, "off"), 0);
  assert.equal(snapTick(tl, 700, { grid: "beat" }), 480);
  assert.equal(snapTick(tl, 700, { grid: "beat", strength: 0.3 }), 700, "不够近就不吸");
  assert.equal(snapTick(tl, 1900, { grid: "bar" }), 1920);

  const tlS = normalizeTimeline({ tpb: 480, smpte: { fps: 25, ticksPerFrame: 2 } });
  assert.equal(snapStep(tlS, "frame"), 2);
  assert.equal(snapTick(tlS, 3, { grid: "frame" }), 4);
});

test("SMPTE 模式：tick 是时间码刻度（tempoMap 不参与换算）", () => {
  const tl = normalizeTimeline({ tpb: 480, smpte: { fps: 25, ticksPerFrame: 2 } });
  near(secOfTick(tl, 50), 1.0);
  near(tickOfSec(tl, 1.0), 50);
  near(tickOfSec(tl, secOfTick(tl, 1234)), 1234, 1e-6);
});

test("时间轴与歌曲模型桥接：timelineOfSong 读 song 的 tpb/tempoMap/sigMap", () => {
  const mid = {
    format: 1, ticksPerBeat: 480,
    tracks: [{ name: "t", program: 0, ch: 0, notes: [], events: [
      { tick: 0, type: "tempo", us: 500000 },
      { tick: 1920, type: "sig", num: 3, den: 4 },
      { tick: 3840, type: "tempo", us: 400000 },
    ], ccs: [] }],
  };
  const song = buildSong(mid);
  const tl = timelineOfSong(song);
  assert.equal(tl.tpb, 480);
  assert.deepEqual(tl.sigMap.map((e) => [e.tick, e.num, e.den]), [[0, 4, 4], [1920, 3, 4]]);
  near(secOfTick(tl, song.totalTicks), song.totalSec, 1e-6, "总时长与 song.totalSec 一致");
});

test("cloneTimeline / playheadSec：深拷贝 + 播放头秒数", () => {
  const tl = normalizeTimeline({ tpb: 480, tempoMap: [{ tick: 0, us: 500000 }], playheadTick: 960 });
  const copy = cloneTimeline(tl);
  copy.tempoMap[0].us = 123;
  copy.sigMap[0].num = 3;
  assert.equal(tl.tempoMap[0].us, 500000, "改副本不影响原时间轴");
  assert.equal(tl.sigMap[0].num, 4);
  near(playheadSec(tl), 1.0);
});

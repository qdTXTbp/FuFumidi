import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, encodeMidi, buildSong } from '../src/core/midi.js';
import { timelineOfSong, secOfTick, barBeatOf, tickOfBarBeat, iterBars, formatBarBeat } from '../src/core/timeline.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `期望 ${b}，实际 ${a}`);

function noteTrack() {
  return [{ name: "t", ch: 0, program: 0, notes: [{ start: 0, end: 40, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [] }];
}

test("P0-6 SMPTE：encode→parse 保留 fps / ticksPerFrame / division 字节", () => {
  const bytes = encodeMidi(noteTrack(), { division: 480, smpte: { fps: 25, ticksPerFrame: 40 } });
  // header division 必须是 0xE728（负 fps 二补码 + ticks/frame）
  assert.equal(bytes[12], 0xe7);
  assert.equal(bytes[13], 0x28);
  const mid = parseMidi(bytes);
  assert.deepEqual(mid.smpte, { fps: 25, ticksPerFrame: 40 });
  assert.equal(mid.ticksPerBeat, 40);
  assert.equal(mid.divisionRaw, 0xe728);
});

test("P0-6 SMPTE：buildSong 的时间换算按帧走（tempoMap 不参与）", () => {
  const bytes = encodeMidi(noteTrack(), { division: 480, smpte: { fps: 25, ticksPerFrame: 40 } });
  const song = buildSong(parseMidi(bytes));
  assert.deepEqual(song.smpte, { fps: 25, ticksPerFrame: 40 });
  near(song.baseSec(40), 40 / (25 * 40));
  near(song.baseSec(1000), 1.0);
  near(song.secToTick(0.1), 100);
  near(song.secToTick(song.baseSec(777)), 777);
  assert.equal(song.totalTicks, 80, "总长 = 最后音符 end + tpb");
  near(song.totalSec, 80 / 1000);
  const tl = timelineOfSong(song);
  near(secOfTick(tl, 250), 0.25);
});

test("P0-6 SMPTE + 拍号：拍号元事件仍进 sigMap（小节网格可用）", () => {
  const bytes = encodeMidi(noteTrack(), {
    division: 480,
    smpte: { fps: 30, ticksPerFrame: 100 },
    sigMap: [{ tick: 0, num: 4, den: 4 }, { tick: 400, num: 3, den: 4 }],
  });
  const song = buildSong(parseMidi(bytes));
  assert.deepEqual(song.sigMap.map((e) => [e.tick, e.num, e.den]), [[0, 4, 4], [400, 3, 4]]);
  assert.equal(song.smpte.fps, 30);
  const tl = timelineOfSong(song);
  assert.equal(barBeatOf(tl, 0).bar, 0, "SMPTE 下 tpb=ticksPerFrame，4/4 一小节 = 4*100 tick");
  assert.equal(barBeatOf(tl, 400).bar, 1);
  assert.equal(barBeatOf(tl, 800).bar, 2);
});

test("P0-6 多拍号：encode→parse→buildSong 保留全部拍号（不再只取第一条）", () => {
  const sigMap = [{ tick: 0, num: 4, den: 4 }, { tick: 1920, num: 6, den: 8 }, { tick: 4800, num: 3, den: 4 }];
  const bytes = encodeMidi(noteTrack(), { division: 480, sigMap });
  const song = buildSong(parseMidi(bytes));
  assert.deepEqual(song.sigMap.map((e) => [e.tick, e.num, e.den]), sigMap.map((e) => [e.tick, e.num, e.den]));
  const tl = timelineOfSong(song);
  assert.deepEqual([barBeatOf(tl, 0).bar, barBeatOf(tl, 1920).bar, barBeatOf(tl, 4800).bar], [0, 1, 3]);
  assert.deepEqual([barBeatOf(tl, 1920).num, barBeatOf(tl, 1920).den], [6, 8]);
  assert.deepEqual([barBeatOf(tl, 4800).num, barBeatOf(tl, 4800).den], [3, 4]);
  assert.equal(tickOfBarBeat(tl, 3, 0), 4800);
  assert.equal(tickOfBarBeat(tl, 4, 0), 6240);
  assert.equal(formatBarBeat(tl, 0), "1:1");
  assert.equal(formatBarBeat(tl, 4800), "4:1", "第 4 小节第 1 拍（1 基）");
  // iterBars 也按分段推进：4 个 4/4 小节 + 2 个 6/8 小节 + 后面 3/4
  const bars = iterBars(tl, 0, 7000);
  assert.deepEqual(bars.slice(0, 4).map((b) => b.tick), [0, 1920, 3360, 4800]);
  assert.deepEqual([bars[1].num, bars[1].den], [6, 8]);
  assert.deepEqual([bars[3].num, bars[3].den], [3, 4]);
});

test("P0-6 多拍号：小节线数量 = 各段小节数之和（不按第一拍号一刀切）", () => {
  const bytes = encodeMidi(noteTrack(), {
    division: 480,
    sigMap: [{ tick: 0, num: 4, den: 4 }, { tick: 1920, num: 6, den: 8 }],
  });
  const song = buildSong(parseMidi(bytes));
  const tl = timelineOfSong(song);
  const bars = iterBars(tl, 0, 1920 + 1440 * 3 - 1);
  assert.equal(bars.length, 4);
  assert.deepEqual(bars.map((b) => b.tick), [0, 1920, 3360, 4800]);
  assert.equal(bars[3].num, 6);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, encodeMidi } from '../src/core/midi.js';

const normNotes = (ns) => ns.map((n) => [n.start, n.end, n.midi, n.vel, n.ch]).sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
const normCCs = (cs) => cs.map((c) => [c.tick, c.cc, c.cv, c.ch]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const evOfType = (tr, type) => ((tr && tr.events) || []).filter((e) => e.type === type);

function baseTracks() {
  return [
    { name: "钢琴", ch: 0, program: 0, notes: [
      { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
      { start: 480, end: 960, midi: 64, vel: 90, ch: 0 },
    ], ccs: [], events: [] },
    { name: "弦乐", ch: 1, program: 48, notes: [
      { start: 240, end: 1200, midi: 72, vel: 80, ch: 1 },
    ], ccs: [], events: [] },
  ];
}

test("P0-1 头部：单轨 format 0、多轨 format 1、opts.format 可覆盖", () => {
  const one = parseMidi(encodeMidi([baseTracks()[0]], { division: 480 }));
  assert.equal(one.format, 0);
  assert.equal(one.ntrks, 1);
  const two = parseMidi(encodeMidi(baseTracks(), { division: 480 }));
  assert.equal(two.format, 1, "多轨必须写 format 1（旧实现写死 format 0）");
  assert.equal(two.ntrks, 2);
  const forced = parseMidi(encodeMidi(baseTracks(), { division: 480, format: 0 }));
  assert.equal(forced.format, 0, "opts.format 显式覆盖");
});

test("P0-1 音符/轨名/音色/通道 round-trip", () => {
  const out = parseMidi(encodeMidi(baseTracks(), { division: 480 }));
  assert.equal(out.ticksPerBeat, 480);
  assert.equal(out.tracks.length, 2);
  assert.equal(out.tracks[0].name, "钢琴");
  assert.equal(out.tracks[1].name, "弦乐");
  assert.equal(out.tracks[1].program, 48);
  assert.deepEqual(normNotes(out.tracks[0].notes), [[0, 480, 60, 100, 0], [480, 960, 64, 90, 0]]);
  assert.deepEqual(normNotes(out.tracks[1].notes), [[240, 1200, 72, 80, 1]]);
});

test("P0-1 CC 全量 round-trip（含 bank CC0/CC32 与 CC7）", () => {
  const src = baseTracks();
  src[0].ccs = [
    { tick: 0, cc: 0, cv: 0, ch: 0 },
    { tick: 0, cc: 32, cv: 5, ch: 0 },
    { tick: 120, cc: 7, cv: 100, ch: 0 },
    { tick: 240, cc: 64, cv: 127, ch: 0 },
    { tick: 240, cc: 1, cv: 64, ch: 1 },
  ];
  const out = parseMidi(encodeMidi(src, { division: 480 }));
  assert.deepEqual(normCCs(out.tracks[0].ccs), [
    [0, 0, 0, 0], [0, 32, 5, 0], [120, 7, 100, 0], [240, 1, 64, 1], [240, 64, 127, 0],
  ]);
});

test("P0-1 bend / 复音触后 / 通道触后 / 中途 program round-trip", () => {
  const src = baseTracks();
  src[0].events = [
    { tick: 0, type: "bend", val: 0, ch: 0 },
    { tick: 120, type: "bend", val: 8192, ch: 0 },
    { tick: 240, type: "bend", val: 16383, ch: 0 },
    { tick: 120, type: "polytouch", note: 60, val: 77, ch: 0 },
    { tick: 240, type: "chaintouch", val: 55, ch: 0 },
    { tick: 0, type: "program", program: 0, ch: 0 },
    { tick: 960, type: "program", program: 8, ch: 0 },
  ];
  src[0].program = 0;
  const out = parseMidi(encodeMidi(src, { division: 480 }));
  assert.deepEqual(evOfType(out.tracks[0], "bend").map((e) => [e.tick, e.val]), [[0, 0], [120, 8192], [240, 16383]]);
  assert.deepEqual(evOfType(out.tracks[0], "polytouch").map((e) => [e.tick, e.note, e.val]), [[120, 60, 77]]);
  assert.deepEqual(evOfType(out.tracks[0], "chaintouch").map((e) => [e.tick, e.val]), [[240, 55]]);
  assert.deepEqual(evOfType(out.tracks[0], "program").map((e) => [e.tick, e.program]), [[0, 0], [960, 8]]);
  assert.equal(evOfType(out.tracks[0], "program").length, 2, "中途 program 与轨首 program 不能重复写");
});

test("P0-1 歌词 / 文本 / marker / cue 分类型 round-trip（UTF-8）", () => {
  const src = baseTracks();
  src[0].events = [
    { tick: 0, type: "lyric", text: "你好，世界" },
    { tick: 480, type: "lyric", text: "第二句" },
    { tick: 0, type: "marker", text: "Intro" },
    { tick: 1920, type: "marker", text: "副歌" },
    { tick: 0, type: "cue", text: "Cue A" },
    { tick: 0, type: "text", text: "备注" },
  ];
  const out = parseMidi(encodeMidi(src, { division: 480 }));
  assert.deepEqual(evOfType(out.tracks[0], "lyric").map((e) => [e.tick, e.text]), [[0, "你好，世界"], [480, "第二句"]]);
  assert.deepEqual(evOfType(out.tracks[0], "marker").map((e) => [e.tick, e.text]), [[0, "Intro"], [1920, "副歌"]]);
  assert.deepEqual(evOfType(out.tracks[0], "cue").map((e) => e.text), ["Cue A"]);
  assert.deepEqual(evOfType(out.tracks[0], "text").map((e) => e.text), ["备注"]);
  assert.equal(evOfType(out.tracks[0], "marker").length, 2, "marker 不能被记成普通 text");
});

test("P0-1 tempo / 拍号 / 调号：显式传入与事件兜底都 round-trip，且只写在 0 号轨", () => {
  const opts = {
    division: 480,
    tempoMap: [{ tick: 0, us: 500000 }, { tick: 960, us: 400000 }],
    sigMap: [{ tick: 0, num: 4, den: 4 }, { tick: 1920, num: 6, den: 8 }],
    keySig: { sf: -2, mi: 1 },
  };
  const out = parseMidi(encodeMidi(baseTracks(), opts));
  const all = (t) => out.tracks.flatMap((tr) => evOfType(tr, t));
  assert.deepEqual(all("tempo").map((e) => [e.tick, e.us]), [[0, 500000], [960, 400000]]);
  assert.deepEqual(all("sig").map((e) => [e.tick, e.num, e.den]), [[0, 4, 4], [1920, 6, 8]]);
  assert.deepEqual(all("key").map((e) => [e.tick, e.sf, e.mi]), [[0, -2, 1]]);
  assert.equal(evOfType(out.tracks[1], "tempo").length, 0, "全局 meta 只写在 0 号轨");

  const src2 = baseTracks();
  src2[0].events = [
    { tick: 0, type: "tempo", us: 428571 },
    { tick: 0, type: "sig", num: 3, den: 4 },
    { tick: 0, type: "key", sf: 3, mi: 0 },
  ];
  const out2 = parseMidi(encodeMidi(src2, { division: 480, tempoMap: [], sigMap: [] }));
  const all2 = (t) => out2.tracks.flatMap((tr) => evOfType(tr, t));
  assert.deepEqual(all2("tempo").map((e) => e.us), [428571]);
  assert.deepEqual(all2("sig").map((e) => [e.num, e.den]), [[3, 4]]);
  assert.deepEqual(all2("key").map((e) => [e.sf, e.mi]), [[3, 0]]);
});

test("P0-1 同 tick 排序：note-off 在 note-on 之前（相邻同音高不粘连）", () => {
  const src = [{ name: "t", ch: 0, program: 0, ccs: [], events: [], notes: [
    { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
    { start: 480, end: 960, midi: 60, vel: 100, ch: 0 },
  ] }];
  const out = parseMidi(encodeMidi(src, { division: 480 }));
  assert.deepEqual(normNotes(out.tracks[0].notes), [[0, 480, 60, 100, 0], [480, 960, 60, 100, 0]],
    "同 tick 的 note-off 必须先于 note-on，否则会解析成一个 960 的长音");
});

test("P0-1 tempoMap 同 tick 去重（后者覆盖）", () => {
  const out = parseMidi(encodeMidi(baseTracks(), {
    division: 480,
    tempoMap: [{ tick: 0, us: 500000 }, { tick: 0, us: 400000 }],
  }));
  const tempo = out.tracks.flatMap((tr) => evOfType(tr, "tempo"));
  assert.equal(tempo.filter((e) => e.tick === 0).length, 1);
  assert.equal(tempo.find((e) => e.tick === 0).us, 400000);
});

test("P0-6（原 P0-1 拒绝项）：SMPTE 时间码文件现在能解析", () => {
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe7, 0x28,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0x00,
  ]);
  const mid = parseMidi(bytes);
  assert.deepEqual(mid.smpte, { fps: 25, ticksPerFrame: 40 });
  assert.equal(mid.ticksPerBeat, 40);
  assert.equal(mid.divisionRaw, 0xe728);
});

// M2 参数化 MIDI 工具：注册表契约 + 既有工具行为快照 + 新增 operator（翻转/三连音/键位限制）
//
// 快照测试的用法：
//   正常跑 = 锁行为；改动了工具实现导致结果变化时，先确认识别是有意的，再用
//   $env:UPDATE_SNAPSHOT=1; node --test tests/midi-tools.test.js 更新快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MIDI_TOOLS, TOOL_GROUPS, toolById, defaultParams } from '../src/core/midi-tools.js';

const SNAPSHOT = new URL('./midi-tools.snapshot.json', import.meta.url);
const UPDATE = process.env.UPDATE_SNAPSHOT === '1';

/** 固定素材：8 个选中音符 + 1 个未选中的后继音（给 legato 用） */
function fixture() {
  return [
    { start: 0, end: 240, midi: 60, vel: 80 },
    { start: 240, end: 480, midi: 64, vel: 90 },
    { start: 480, end: 720, midi: 67, vel: 100 },
    { start: 735, end: 960, midi: 71, vel: 70 },
    { start: 960, end: 1200, midi: 63, vel: 60 },
    { start: 1200, end: 1440, midi: 59, vel: 110, muted: true },
    { start: 1500, end: 1680, midi: 52, vel: 40 },
    { start: 1800, end: 1801, midi: 76, vel: 127 },
  ];
}
function ctxOf(notes) {
  return {
    tpb: 480,
    scalePcs: [0, 2, 4, 5, 7, 9, 11],
    track: { notes: notes.concat([{ start: 1920, end: 2100, midi: 60, vel: 80 }]) },
  };
}
function norm(notes) {
  return notes.map((n) => ({ start: n.start, end: n.end, midi: n.midi, vel: n.vel, muted: !!n.muted }));
}

/** 每条工具一组非默认参数，保证快照里能看到真实变换（默认参数大多恒等） */
const SCENARIOS = {
  transpose: { semitones: 3 },
  scaleSnap: { dir: 'up' },
  mirror: { axis: 60 },
  flip: { mode: 'time' },
  keyLimit: { low: 55, high: 72, mode: 'clip' },
  randomWalk: { range: 3, seed: 7, scaleOnly: true },
  velOffset: { amount: -10 },
  velScale: { factor: 0.8 },
  velFixed: { value: 90 },
  velCompress: { center: 80, strength: 50 },
  velHumanize: { amount: 8, seed: 11 },
  lenScale: { factor: 1.5 },
  lenOffset: { beats: 0.25 },
  legato: { amount: 100 },
  staccato: { ratio: 50 },
  quantize: { grid: '1/16', strength: 100 },
  triplet: { grid: '1/16T', strength: 100 },
  slice: { mode: 'grid', grid: '1/16' },
  swing: { grid: '1/8', amount: 33 },
  strum: { step: 20, fromTop: false },
  arp: { rate: '1/16', dir: 'up' },
  flam: { count: 2, spacing: 20, decay: 40, jitter: 0, seed: 5 },
  thin: { keep: 50, seed: 3 },
};

test('工具注册表：id 唯一、分组合法、参数默认值合法', () => {
  const ids = new Set();
  for (const tool of MIDI_TOOLS) {
    assert.ok(tool.id, '工具有 id');
    assert.ok(!ids.has(tool.id), '重复的工具 id：' + tool.id);
    ids.add(tool.id);
    assert.ok(TOOL_GROUPS.includes(tool.group), tool.id + ' 的分组不在 TOOL_GROUPS 里');
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.hint, 'string');
    assert.equal(typeof tool.apply, 'function');
    const p = defaultParams(tool);
    for (const def of tool.params) {
      assert.ok(def.k && def.label && def.type, tool.id + ' 的参数缺字段');
      assert.ok(def.def !== undefined, tool.id + '.' + def.k + ' 缺默认值');
      if (def.type === 'int' || def.type === 'float') {
        assert.ok(def.def >= def.min && def.def <= def.max, tool.id + '.' + def.k + ' 默认值越界');
      } else if (def.type === 'enum') {
        assert.ok((def.options || []).some((o) => o[0] === def.def), tool.id + '.' + def.k + ' 默认值不在选项里');
      }
      assert.equal(p[def.k], def.def);
    }
  }
});

test('快照：全部工具在固定素材上的结果（含新增工具）', () => {
  const actual = {};
  for (const tool of MIDI_TOOLS) {
    const notes = fixture();
    const params = { ...defaultParams(tool), ...(SCENARIOS[tool.id] || {}) };
    const res = tool.apply(notes, params, ctxOf(notes));
    let changed;
    if (res && typeof res === 'object') {
      const add = Array.isArray(res.add) ? res.add : [];
      notes.push(...add);
      changed = Number.isFinite(res.changed) ? res.changed : add.length;
    } else changed = res || 0;
    actual[tool.id] = { params, changed, notes: norm(notes) };
  }
  if (UPDATE) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + '\n', 'utf8');
    return;
  }
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  assert.deepEqual(actual, expected);
});

test('随机类工具：固定 seed 可复现，且不改音符数量', () => {
  for (const id of ['randomWalk', 'velHumanize', 'thin']) {
    const tool = toolById(id);
    const params = { ...defaultParams(tool), ...(SCENARIOS[id] || {}) };
    const a = fixture(); const b = fixture();
    tool.apply(a, params, ctxOf(a));
    tool.apply(b, params, ctxOf(b));
    assert.deepEqual(norm(a), norm(b), id + ' 同 seed 结果不一致');
    assert.equal(a.length, fixture().length, id + ' 改变了音符数量');
  }
});

test('翻转（水平）：以选区中心镜像，两次翻转回到原状', () => {
  const tool = toolById('flip');
  const params = { ...defaultParams(tool), mode: 'time' };
  const notes = fixture();
  const before = norm(notes);
  assert.ok(tool.apply(notes, params, ctxOf(notes)) > 0);
  assert.deepEqual(norm(notes)[0], { start: 1561, end: 1801, midi: 60, vel: 80, muted: false });
  assert.deepEqual(norm(notes)[7], { start: 0, end: 1, midi: 76, vel: 127, muted: false });
  tool.apply(notes, params, ctxOf(notes));
  assert.deepEqual(norm(notes), before);
});

test('翻转（垂直）：围绕轴音翻转音高，两次翻转回到原状', () => {
  const tool = toolById('flip');
  const params = { ...defaultParams(tool), mode: 'pitch', axis: 60 };
  const notes = fixture();
  const before = norm(notes);
  tool.apply(notes, params, ctxOf(notes));
  const after = norm(notes);
  assert.equal(after[0].midi, 60, '轴音上的音不动');
  assert.equal(after[1].midi, 56, '64 → 56');
  assert.equal(after[7].midi, 44, '76 → 44');
  tool.apply(notes, params, ctxOf(notes));
  assert.deepEqual(norm(notes), before);
});

test('三连音：起点落在三连音网格上，长度不变；强度 0 = 恒等', () => {
  const tool = toolById('triplet');
  const notes = fixture();
  const lens = notes.map((n) => n.end - n.start);
  const params = { ...defaultParams(tool), grid: '1/8T', strength: 100 };
  assert.ok(tool.apply(notes, params, ctxOf(notes)) > 0);
  notes.forEach((n, i) => {
    assert.equal(n.start % 160, 0, '1/8T = 160 tick：' + n.start);
    assert.equal(n.end - n.start, lens[i], '长度应保持不变');
  });

  const zero = fixture();
  const zeroParams = { ...defaultParams(tool), strength: 0 };
  assert.equal(tool.apply(zero, zeroParams, ctxOf(zero)), 0);
  assert.deepEqual(norm(zero), norm(fixture()));
});

test('键位限制：clip 夹到边界，mute 只静音范围外的音', () => {
  const tool = toolById('keyLimit');
  const clipNotes = fixture();
  const clipParams = { ...defaultParams(tool), low: 55, high: 72, mode: 'clip' };
  assert.equal(tool.apply(clipNotes, clipParams, ctxOf(clipNotes)), 2);
  for (const n of clipNotes) assert.ok(n.midi >= 55 && n.midi <= 72, 'clip 后越界：' + n.midi);

  const muteNotes = fixture();
  const muteParams = { ...defaultParams(tool), low: 55, high: 72, mode: 'mute' };
  assert.equal(tool.apply(muteNotes, muteParams, ctxOf(muteNotes)), 2);
  assert.equal(muteNotes[6].midi, 52, 'mute 不改音高');
  assert.equal(!!muteNotes[6].muted, true);
  assert.equal(!!muteNotes[7].muted, true);
  assert.equal(!!muteNotes[0].muted, false);
});

test('键位限制：上下界写反时自动交换', () => {
  const tool = toolById('keyLimit');
  const notes = fixture();
  const params = { ...defaultParams(tool), low: 72, high: 55, mode: 'clip' };
  tool.apply(notes, params, ctxOf(notes));
  for (const n of notes) assert.ok(n.midi >= 55 && n.midi <= 72);
});

test('装饰音：按数量生成、长度继承、力度衰减、固定 seed 可复现', () => {
  const tool = toolById('flam');
  const params = { ...defaultParams(tool), count: 3, spacing: 20, decay: 40, jitter: 0, seed: 5 };
  const a = fixture();
  const before = norm(a);
  const res = tool.apply(a, params, ctxOf(a));
  assert.equal(res.changed, before.length * 3);
  assert.equal(res.add.length, before.length * 3);

  // 原音符不动；新增音符起点按 spacing 递增、长度与力度符合衰减公式
  assert.deepEqual(norm(a), before);
  const firstAdded = res.add[0];
  assert.equal(firstAdded.start, before[0].start + 20);
  assert.equal(firstAdded.end - firstAdded.start, before[0].end - before[0].start);
  assert.equal(firstAdded.vel, Math.round(before[0].vel * 0.6));
  assert.equal(res.add[2].start, before[0].start + 60);
  assert.equal(res.add[2].vel, Math.round(before[0].vel * 0.216));

  const b = fixture();
  const resB = tool.apply(b, params, ctxOf(b));
  assert.deepEqual(resB.add, res.add, '同 seed 的装饰音结果必须一致');
});

test('切片（网格）：切段首尾相接、总时值不变、无重叠', () => {
  const tool = toolById('slice');
  const params = { ...defaultParams(tool), mode: 'grid', grid: '1/16' };
  const notes = fixture();
  const total = notes.reduce((s, n) => s + (n.end - n.start), 0);
  const res = tool.apply(notes, params, ctxOf(notes));
  const all = notes.concat(res.add);
  const after = all.reduce((s, n) => s + (n.end - n.start), 0);
  assert.equal(after, total, '总时值必须不变');
  assert.ok(res.add.length > 0);

  const byPitch = new Map();
  for (const n of all) byPitch.set(n.midi, (byPitch.get(n.midi) || []).concat(n));
  for (const arr of byPitch.values()) {
    arr.sort((x, y) => x.start - y.start);
    for (let i = 1; i < arr.length; i++) assert.equal(arr[i].start, arr[i - 1].end, '切段必须首尾相接');
  }
});

test('切片（播放头）：只切包含播放头的音符，播放头恰在边界不动', () => {
  const tool = toolById('slice');
  const params = { ...defaultParams(tool), mode: 'playhead' };
  const notes = fixture();
  const res = tool.apply(notes, params, { ...ctxOf(notes), playhead: 1000 });
  // 覆盖 1000 的音符：960–1200（第 5 个）
  assert.equal(res.add.length, 1);
  assert.deepEqual([notes[4].start, notes[4].end], [960, 1000]);
  assert.deepEqual([res.add[0].start, res.add[0].end], [1000, 1200]);

  const edge = fixture();
  const resEdge = tool.apply(edge, params, { ...ctxOf(edge), playhead: 1200 });
  assert.equal(resEdge.add.length, 0, '边界上的播放头不应切开音符');
});

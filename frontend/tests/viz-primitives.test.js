// 可视化重做 · 场景层单测：断言**图元列表**，而不是"猜哪条 roundRect 是音符"。
// 这是重做的核心收益之一：层顺序、每块一次、层开关、预算裁剪、确定性 全是纯数据断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiler } from '../src/core/viz/scene/compile.js';
import { LAYERS, LAYER_INDEX, countBy } from '../src/core/viz/scene/primitives.js';

const TPS = 1000;
const song = {
  initialBpm: 120,
  tempoMap: [{ sec: 0, us: 500000 }],
  sigMap: [{ tick: 0, num: 4, den: 4 }],
  tracks: [{ index: 0, notes: [
    { midi: 60, start: 100000, end: 100500, vel: 90 },
    { midi: 64, start: 102000, end: 103000, vel: 70 },
    { midi: 67, start: 104000, end: 105000, vel: 80 },
  ], color: '#4f9dff' }],
  baseSec: (tk) => tk / TPS,
};
const tick = 100 * TPS;
const base = { w: 800, h: 400, zoom: 1, colorScheme: 0, activeNotes: [], energy: 0.4, theme: 'studio' };

test('图元层顺序固定：background < notes < impact < keyboard < particles < overlay', () => {
  const r = createCompiler().compile(song, tick, { ...base, fx: {} });
  const idx = r.prims.map((p) => LAYER_INDEX[p.layer]);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] >= idx[i - 1], '层顺序必须单调');
  const layers = new Set(r.prims.map((p) => p.layer));
  for (const l of ['background', 'notes', 'keyboard', 'overlay']) assert.ok(layers.has(l), '缺少层 ' + l);
});

test('每个屏内音符块恰好一个 capsule（旧实现靠"填充类型"猜，现在直接数图元）', () => {
  const r = createCompiler().compile(song, tick, { ...base, fx: {} });
  const caps = r.prims.filter((p) => p.k === 'capsule' && p.layer === 'notes');
  assert.equal(caps.length, 3, '三个音高各一块在屏内');
  // 音符盒必须带四段渐变（内芯），不是纯色 —— 这是"质感"的数据表达
  for (const c of caps) assert.ok(c.fill && Array.isArray(c.fill.stops) && c.fill.stops.length === 4);
});

test('琴键层可由数据关掉/调透明（★用户点名的那一项，不再靠补乘全局 alpha）', () => {
  const on = createCompiler().compile(song, tick, { ...base, fx: {} });
  assert.ok(on.prims.some((p) => p.layer === 'keyboard'), '默认应有琴键图元');
  const off = createCompiler().compile(song, tick, { ...base, fx: { keysOn: false } });
  assert.equal(off.prims.filter((p) => p.layer === 'keyboard').length, 0, 'keysOn:false 必须一块琴键都不产生');
  const half = createCompiler().compile(song, tick, { ...base, fx: { keysAlpha: 0.4 } });
  const ks = half.prims.filter((p) => p.layer === 'keyboard');
  // 键面/前脸/高光的 alpha 必须**都以 keysA 为上限**（按压光与闪光按各自强度再乘一次），
  // 并且至少有一批等于 keysA —— 这就是"层属性"的含义：整层跟着一个数走。
  assert.ok(ks.length > 0, 'keysAlpha=0.4 时仍应有琴键图元');
  assert.ok(ks.every((p) => p.alpha <= 0.4 + 1e-6), '不得有超过 keysA 的琴键图元');
  assert.ok(ks.some((p) => Math.abs(p.alpha - 0.4) < 1e-6), '键面 alpha 必须等于 keysA');
  const zero = createCompiler().compile(song, tick, { ...base, fx: { keysAlpha: 0 } });
  assert.equal(zero.prims.filter((p) => p.layer === 'keyboard').length, 0, 'alpha=0 也不该产生琴键图元');
});

test('粒子按预算裁剪（对标 MIDViz 的 per-node Max Items）', () => {
  const c = createCompiler();
  let r = null;
  for (let i = 0; i < 40; i++) r = c.compile(song, 100 * TPS + i * 16, { ...base, fx: {} });
  const sparks = r.prims.filter((p) => p.k === 'glow' && p.layer === 'particles').length;
  assert.ok(sparks <= 420, '火花不得超过预算上限，实测 ' + sparks);
});

test('确定性：同一编译器同一 tick 连编两次，图元签名一致', () => {
  const sig = (prims) => prims.map((p) => [p.k, p.layer, Math.round(p.x || 0), Math.round(p.y || 0), Math.round(p.w || 0), Math.round(p.h || 0)].join(',')).join('|');
  const a = createCompiler();
  for (let i = 0; i < 30; i++) a.compile(song, 100 * TPS + i * 16, { ...base, fx: {} });
  const one = sig(a.compile(song, 100 * TPS + 30 * 16, { ...base, fx: {} }).prims);
  const b = createCompiler();
  for (let i = 0; i < 30; i++) b.compile(song, 100 * TPS + i * 16, { ...base, fx: {} });
  const two = sig(b.compile(song, 100 * TPS + 30 * 16, { ...base, fx: {} }).prims);
  assert.equal(one, two, '同一输入必须产生同一份图元（禁止 Math.random）');
});

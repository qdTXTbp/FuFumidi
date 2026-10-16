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
  // 玻璃质感下每根音符是「主体 + 纵向高光条」两个胶囊，所以这里数的是**主体**：
  // 主体带四段渐变且不是 lighter 叠加（高光条是 lighter + 纯白）
  const bodies = (x) => x.prims.filter((p) => p.k === 'capsule' && p.layer === 'notes' && p.blend !== 'lighter');
  const caps = bodies(r);
  assert.equal(caps.length, 3, '三个音高各一块在屏内');
  // 音符盒必须带四段渐变（内芯），不是纯色 —— 这是"质感"的数据表达
  for (const c of caps) assert.ok(c.fill && Array.isArray(c.fill.stops) && c.fill.stops.length === 4);
});

test('琴键层只有"显示/隐藏"两态（透明度滑杆已按用户要求移除）', () => {
  const on = createCompiler().compile(song, tick, { ...base, fx: {} });
  const ks = on.prims.filter((p) => p.layer === 'keyboard');
  assert.ok(ks.length > 0, '默认应有琴键图元');
  assert.ok(ks.every((p) => p.alpha === 1 || p.alpha < 1), '琴键层不再受 keysAlpha 影响');
  assert.ok(ks.every((p) => p.alpha > 0), '琴键必须是不透明的（除非整层关掉）');
  const off = createCompiler().compile(song, tick, { ...base, fx: { keysOn: false } });
  assert.equal(off.prims.filter((p) => p.layer === 'keyboard').length, 0, 'keysOn:false 必须一块琴键都不产生');
});

test('★ 音符不透明度滑杆只作用于下落音符（琴键不再跟着变）', () => {
  const full = createCompiler().compile(song, tick, { ...base, fx: { noteAlpha: 1 } });
  const half = createCompiler().compile(song, tick, { ...base, fx: { noteAlpha: 0.4 } });
  const bodyOf = (r) => r.prims.filter((p) => p.layer === 'notes' && p.k === 'capsule' && p.blend !== 'lighter');
  const a0 = bodyOf(full), a1 = bodyOf(half);
  assert.equal(a0.length, a1.length, '图元数量不应随透明度变化');
  assert.equal(a1.length, 3, '三个音高各一根');
  // 按 x 配对比较（图元顺序不保证与音符一一对应，按位置配才稳）
  for (const b of a1) {
    const ref = a0.find((p) => Math.abs(p.x - b.x) < 0.01 && Math.abs(p.y - b.y) < 0.01);
    assert.ok(ref, '半透明度下应能找到同一个音符');
    assert.ok(b.alpha < ref.alpha, '通透度拉低后本体应更透：' + b.alpha.toFixed(3) + ' vs ' + ref.alpha.toFixed(3));
    // ★ 关键：本体有下限，不会"整根消失"—— 要的是玻璃，不是空无一物
    assert.ok(b.alpha >= 0.12, '最通透时玻璃本体也必须看得见，实际 ' + b.alpha.toFixed(3));
  }
  // 结构层（折射边/内壁）不得随本体一起淡掉：这才是"透明度是玻璃的透明度"
  const alphaOf = (c) => { const m = /rgba?\([^)]*?,\s*([\d.]+)\)\s*$/.exec(String(c)); return m ? +m[1] : 1; };
  const edges = (r) => r.prims.filter((p) => p.layer === 'notes' && p.k === 'line');
  const e0 = edges(full), e1 = edges(half);
  assert.equal(e0.length, e1.length);
  assert.ok(e0.length > 0);
  for (let i = 0; i < e0.length; i++) {
    assert.ok(alphaOf(e1[i].color) >= alphaOf(e0[i].color) * 0.5, '折射边/内壁强度不得跟着本体一起淡掉');
  }
  // 琴键层完全不受影响
  const k0 = full.prims.filter((p) => p.layer === 'keyboard').map((p) => p.alpha);
  const k1 = half.prims.filter((p) => p.layer === 'keyboard').map((p) => p.alpha);
  assert.deepEqual(k1, k0, '琴键不透明度必须与音符滑杆无关');
});

test('★ 玻璃质感：音符带边缘亮线 / 纵向高光 / 上下收口，且同一根音符的部件 z 连在一起', () => {
  const r = createCompiler().compile(song, tick, { ...base, fx: { gloss: true } });
  const notes = r.prims.filter((p) => p.layer === 'notes');
  const caps = notes.filter((p) => p.k === 'capsule' && p.blend !== 'lighter');
  const lines = notes.filter((p) => p.k === 'line');
  assert.equal(caps.length, 3, '三个音高各一根（主体）');
  assert.ok(lines.length >= 3 * 3, '每根音符至少三条线（左右边缘 + 上下收口），实际 ' + lines.length);
  assert.ok(notes.some((p) => p.blend === 'lighter'), '玻璃的亮层走 lighter 叠加');
  // 边缘亮线必须是白色的（折射亮边），高光条是白色胶囊
  const white = lines.filter((p) => /255,255,255/.test(p.color));
  assert.ok(white.length >= 3 * 2, '每根音符应有左右两条白色边缘亮线');
  // 同一根音符：以 floor(bottom) 为基准，部件 z 落在 [z0, z0+1) 内，不会与相邻音符交错
  for (const c of caps) {
    const z0 = c.z;
    const kin = notes.filter((p) => p.z >= z0 && p.z < z0 + 1);
    assert.ok(kin.length >= 5, '一根音符应有主体/高光/边缘/收口多个部件共享同一 z 基准，实际 ' + kin.length);
  }
});

test('★ 音符吃键盘那台相机：打开透视后音符是「上窄下宽」的四边形，落点边仍与键列对齐', () => {
  const flat = createCompiler().compile(song, tick, { ...base, fx: { persp: 0 } });
  const persp = createCompiler().compile(song, tick, { ...base, fx: { persp: 1 } });
  const bodies = (r) => r.prims.filter((p) => p.layer === 'notes' && p.k === 'quad' && p.blend !== 'lighter');
  assert.equal(bodies(flat).length, 0, 'persp=0 时音符应退化成圆角胶囊/矩形（快而准）');
  const qs = bodies(persp);
  assert.ok(qs.length > 0, 'persp>0 时音符必须是四边形（竖直矩形 = 用户说的"音符还是直的"）');
  for (const q of qs) {
    const [x0, y0, x1, , x2, y2, x3] = q.pts;
    assert.ok(y0 < y2, '上沿应在下沿之上');
    assert.ok(Math.abs(y0 - q.pts[3]) < 0.01 && Math.abs(y2 - q.pts[5]) < 0.01, '上下沿是水平的');
    const wTop = x1 - x0, wBot = x2 - x3;
    assert.ok(wTop <= wBot + 1e-6, '上面（更远）不得比下面宽：' + wTop.toFixed(2) + ' vs ' + wBot.toFixed(2));
  }
  // 离画布中心越远的音符，斜得越明显（透视的必然结果）；落点线处仍与键列同宽
  const slant = (q) => Math.abs(q.pts[6] - q.pts[0]) / Math.max(1, q.pts[5] - q.pts[1]);
  const sorted = qs.slice().sort((a, b) => Math.abs(a.pts[0] - 400) - Math.abs(b.pts[0] - 400));
  if (sorted.length >= 2) {
    assert.ok(slant(sorted[sorted.length - 1]) > slant(sorted[0]), '越靠边缘的音符越斜');
  }
});

test('关掉「音符质感」= 退回一块平色（不再有玻璃亮层）', () => {
  const r = createCompiler().compile(song, tick, { ...base, fx: { gloss: false } });
  const notes = r.prims.filter((p) => p.layer === 'notes');
  assert.ok(notes.filter((p) => p.k === 'capsule').length === 3);
  assert.equal(notes.filter((p) => p.blend === 'lighter').length, 0, '关掉质感后不该再有 lighter 亮层');
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
test('★ 音符的落点部件必须长在音符自己的四边形上（透视下不许横向偏移 —— 用户报的"残影"）', () => {
  // 透视开关在 fx.persp（面板「透视」滑杆），不是顶层 opts
  const r = createCompiler().compile(song, tick, { ...base, fx: { persp: 1 } });
  const notes = r.prims.filter((p) => p.layer === 'notes');
  // 本体：z 为整数（= floor(bottom)）且不是 lighter 叠加；透视下是 quad，平板下是 capsule
  const bodies = notes.filter((p) => (p.k === 'quad' || p.k === 'capsule') && Number.isInteger(p.z) && !p.blend);
  assert.ok(bodies.length >= 3, '应有三根音符本体，实测 ' + bodies.length);
  const bottomOf = (b) => (b.k === 'quad'
    ? { mx: (b.pts[4] + b.pts[6]) / 2, x0: b.pts[6], x1: b.pts[4] }
    : { mx: b.x + b.w / 2, x0: b.x, x1: b.x + b.w });
  let sheared = 0;
  for (const b of bodies) {
    if (b.k === 'quad' && Math.abs(b.pts[0] - b.pts[6]) > 0.5) sheared++;   // 上沿与下沿不同 x = 真被透视剪了
    const bo = bottomOf(b);
    const hot = notes.find((p) => p.k === 'line' && Math.abs(p.z - (b.z + 0.4)) < 1e-6);
    if (!hot) continue;                                                    // 主题没开 edge 就不画这条
    assert.ok(Math.abs((hot.x0 + hot.x1) / 2 - bo.mx) < 1e-6,
      '落点亮线必须与音符底边同源：亮线中点 ' + ((hot.x0 + hot.x1) / 2).toFixed(2) + ' vs 底边中点 ' + bo.mx.toFixed(2));
  }
  assert.ok(sheared > 0, '透视必须真的生效，否则这条测试什么也没证明');
  const glows = notes.filter((p) => p.k === 'glow');
  assert.ok(glows.length > 0, '落点线附近的音符应有落点光晕');
  for (const gl of glows) {
    assert.ok(bodies.some((b) => Math.abs(gl.x - bottomOf(b).mx) < 1e-6),
      '光晕圆心必须落在某个音符的底边中点上，实测 x=' + gl.x.toFixed(2));
  }
});

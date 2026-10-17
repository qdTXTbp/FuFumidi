// 键盘层单测（2026-10-17 推倒重做）：几何不变量必须是**结构保证**，而不是调参调出来的。
// 上一次的三个实锤缺陷都在这里被钉住：落点错位、键被拆成两半、数组圆角退化成药丸。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKeyboardProjection, buildKeyboard, BLACK_T, PRESS_DIP } from '../src/core/viz/scene/keyboard.js';
import { createCompiler } from '../src/core/viz/scene/compile.js';
import { WHITE_MIDI, BLACK_PC } from '../src/core/viz.js';
import * as P from '../src/core/viz/scene/primitives.js';

const CAM = { w: 1600, wN: 700, faceH: 86 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, a + ' != ' + b);

test('t=0（音符落点线）恒等：再大的透视也不许让键离开音符列', () => {
  for (const persp of [0, 0.25, 0.5, 1]) {
    const cam = makeKeyboardProjection(Object.assign({}, CAM, { persp }));
    for (const u of [0, 137, 800, 1463, 1600]) {
      near(cam.px(u, 0), u, 1e-9);
      near(cam.py(0, 0), CAM.wN, 1e-9);
    }
  }
});

test('persp=0 时整台相机退化成恒等：键面是精确矩形（可随时退回平板观感）', () => {
  const cam = makeKeyboardProjection(Object.assign({}, CAM, { persp: 0 }));
  const q = cam.quad(100, 150, 0, 1, 0);
  near(q[0], 100); near(q[1], CAM.wN);
  near(q[2], 150); near(q[3], CAM.wN);
  near(q[4], 150); near(q[5], CAM.wN + CAM.faceH);
  near(q[6], 100); near(q[7], CAM.wN + CAM.faceH);
});

test('纵向透视缩短：近端占的像素多于远端（相机在斜上方，不是反过来）', () => {
  const cam = makeKeyboardProjection(Object.assign({}, CAM, { persp: 1 }));
  const farHalf = cam.py(0.5, 0) - cam.py(0, 0);
  const nearHalf = cam.py(1, 0) - cam.py(0.5, 0);
  assert.ok(nearHalf > farHalf, '近半段应更长：近 ' + nearHalf.toFixed(1) + ' vs 远 ' + farHalf.toFixed(1));
  assert.ok(Math.abs(nearHalf + farHalf - CAM.faceH) < 1e-6, '总长仍等于 faceH');
});

test('横向扇形是克制的：滑块拉满时，最边缘的黑键倾斜也不超过 30°', () => {
  const cam = makeKeyboardProjection(Object.assign({}, CAM, { persp: 1 }));
  const u0 = 2, u1 = 2 + 13;                     // 最左边一根黑键
  const dx = cam.px(u0, BLACK_T) - cam.px(u0, 0);
  const dy = cam.py(BLACK_T, 0) - cam.py(0, 0);
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  assert.ok(deg < 30, '最边缘黑键倾斜 ' + deg.toFixed(1) + '°（上一版 0.16 系数实测约 65°）');
});

test('相邻白键共享边（共用同一条投影线，不留发丝缝）', () => {
  const cam = makeKeyboardProjection(Object.assign({}, CAM, { persp: 0.6 }));
  const g = 20;
  const a = cam.quad(0 * g, 1 * g, 0, 1, 0);
  const b = cam.quad(1 * g, 2 * g, 0, 1, 0);
  near(a[2], b[0], 1e-9); near(a[4], b[6], 1e-9);
});

const CTX = {
  w: 1600, wN: 700, faceH: 86, frontH: 34, g: 20, wk0: 0, wk1: 30, persp: 0.5,
  keysA: 0.8,
  kp: { wkTop: '#9aa0a8', wkBot: '#7d838b', wkFrontTop: '#6b717a', wkFrontBot: '#565c65', wkEdge: 'rgba(255,255,255,0.3)', wkLine: 'rgba(0,0,0,0.3)', bkTop: '#23262b', bkBot: '#14171b', bkFrontTop: '#12151a', bkFrontBot: '#0a0c0f', ink: '#fff' },
  WHITE_MIDI, BLACK_PC, fx: { flash: 0.7, beams: true, keyNames: false },
  shade: (c) => c,
  state: () => ({ gv: 0, fv: 0, color: '#fff' }),
};

test('黑键 = 抬高面 + 竖直前脸，前脸高度恰好等于抬升量（不会浮空、不会断开）', () => {
  const { prims } = buildKeyboard(P, CTX);
  const cam = makeKeyboardProjection({ w: CTX.w, wN: CTX.wN, faceH: CTX.faceH, persp: CTX.persp });
  // 矩形与四边形都要认：竖直的四边形会被 isRect 判成 rect（更省也画得更准）
  const box = (p) => (p.k === 'rect'
    ? { top: p.y, bot: p.y + p.h, l: p.x, r: p.x + p.w }
    : { top: Math.min(p.pts[1], p.pts[3], p.pts[5], p.pts[7]), bot: Math.max(p.pts[1], p.pts[3], p.pts[5], p.pts[7]), l: Math.min(p.pts[0], p.pts[2], p.pts[4], p.pts[6]), r: Math.max(p.pts[0], p.pts[2], p.pts[4], p.pts[6]) });
  const keys = prims.filter((p) => p.layer === 'keyboard' && (p.k === 'quad' || p.k === 'rect')).map(box);
  const wallTop = cam.py(BLACK_T, 1), wallBot = cam.py(BLACK_T, 0);
  const wall = keys.find((b) => Math.abs(b.top - wallTop) < 0.6 && Math.abs(b.bot - wallBot) < 0.6);
  assert.ok(wall, '黑键前脸必须从抬高面下沿一直落到键床上（高度 = 抬升量）');
  near(wall.bot - wall.top, cam.raise, 0.6);
  // 抬高面：上沿在抬高后的远端，下沿正是前脸的上沿 —— 两者共享边，不会浮空
  const faceTop = cam.py(0, 1);
  assert.ok(keys.some((b) => Math.abs(b.top - faceTop) < 0.6), '应有黑键抬高面');
});

test('黑键落在所属白键的横向范围内', () => {
  const { prims } = buildKeyboard(P, CTX);
  const cam = makeKeyboardProjection({ w: CTX.w, wN: CTX.wN, faceH: CTX.faceH, persp: CTX.persp });
  const blacks = prims.filter((p) => p.k === 'quad' && p.layer === 'keyboard' && Math.abs(p.pts[1] - cam.py(0, 1)) < 0.01).slice(0, 3);
  assert.ok(blacks.length > 0);
  for (const b of blacks) {
    const u0 = (b.pts[0] - cam.px(0, 0)) / (cam.px(1, 0) - cam.px(0, 0));
    assert.ok(u0 >= 0 && u0 < CTX.w, '黑键横向位置应在键盘内: ' + u0.toFixed(1));
  }
});

test('整层带 keysA：琴键透明度是层属性（关闭/变淡不需要逐个补乘）', () => {
  const { prims } = buildKeyboard(P, CTX);
  assert.ok(prims.length > 0);
  for (const p of prims) assert.ok(Math.abs(p.alpha - CTX.keysA) < 1e-9, p.k + ' 的 alpha 应等于 keysA');
  const off = buildKeyboard(P, Object.assign({}, CTX, { keysA: 0 }));
  for (const p of off.prims) assert.ok(p.alpha === 0);
});
const byZ = (prims, z) => prims.filter((p) => p.z === z);

test('★ 按压：白键远端不动、近端下沉（旧版是键面缩短，方向反了）', () => {
  const at = (gv) => buildKeyboard(P, Object.assign({}, CTX, {
    persp: 0,
    state: (p) => ({ gv: p === WHITE_MIDI[3] ? gv : 0, fv: 0, color: '#f0f' }),
  })).prims;
  const off = byZ(at(0), 103);   // [键面, 前脸]
  const on = byZ(at(1), 103);
  assert.equal(off.length, 2);
  assert.equal(on.length, 2);
  assert.equal(on[0].y, off[0].y, '远端（落点线）绝不许动');
  assert.ok(Math.abs((on[0].h - off[0].h) - PRESS_DIP) < 1e-9, '近端应下沉 ' + PRESS_DIP + 'px，实测 ' + (on[0].h - off[0].h));
  assert.ok(on[1].h < off[1].h, '前脸要同比变矮');
  const bo = off[0].y + off[0].h + off[1].h;
  const bn = on[0].y + on[0].h + on[1].h;
  assert.ok(bn > bo && bn - bo < PRESS_DIP * 0.25, '整键下沿只许微降（不然会顶穿下一排）：' + (bn - bo).toFixed(2));
});

test('★ 按压：黑键的抬起高度落下去，键面与前脸仍共享同一条边', () => {
  const at = (gv) => buildKeyboard(P, Object.assign({}, CTX, {
    persp: 0,
    state: (p) => ({ gv: p === WHITE_MIDI[0] + 1 ? gv : 0, fv: 0, color: '#f0f' }),
  })).prims;
  const off = byZ(at(0), 1000);
  const on = byZ(at(1), 1000);
  assert.ok(on[0].y > off[0].y, '按下时抬高面必须下降：' + off[0].y + ' -> ' + on[0].y);
  assert.equal(on[0].h, off[0].h, '键面长度不变（只落高度，不缩键）');
  assert.ok(Math.abs(on[1].y - (on[0].y + on[0].h)) < 1e-9, '前脸与抬高面共享同一条边（不断开、不浮空）');
  assert.ok(on[1].h < off[1].h, '落下去后前脸变矮');
});

test('平板模式（keys3d 关）：黑键停在白键面上，不浮空', () => {
  const prims = buildKeyboard(P, Object.assign({}, CTX, {
    persp: 0, fx: { flash: 0.7, beams: true, keyNames: false, keys3d: false },
  })).prims;
  const bk = byZ(prims, 1000);
  assert.equal(bk.length, 1, '平板模式没有前脸与侧面');
  assert.equal(bk[0].y, CTX.wN, '抬高量 0 → 键面顶边落在落点线上');
});

test('★ 按压是弹簧动画：逐帧下沉、轻过冲后回稳（不是一步到位）', () => {
  const comp = createCompiler();
  const kbSong = {
    initialBpm: 120,
    tempoMap: [{ sec: 0, us: 500000 }],
    sigMap: [{ tick: 0, num: 4, den: 4 }],
    tracks: [{ index: 0, notes: [{ midi: 60, start: 0, end: 200000, vel: 100 }], color: '#4f9dff' }],
    baseSec: (tk) => tk / 1000,
  };
  // 每帧前进 1/60 秒，取"下沉最深的那条底边"当观测量
  // 观测量取**键面**的底边：同一个 z 上有"键面"和"前脸"两条矩形，键面 y 更小。
  // （整键下沿只降 0.15*dip —— 前脸同比变矮是为了不顶穿下一排，所以不能拿它当观测量）
  const bottomOf = (tick) => {
    const r = comp.compile(kbSong, tick, { w: 800, h: 400, zoom: 1, colorScheme: 0, activeNotes: [], energy: 0, theme: 'studio', fx: { persp: 0 } });
    const byZ = new Map();
    for (const p of r.prims) {
      if (p.layer !== 'keyboard' || p.k !== 'rect' || p.blend) continue;
      const cur = byZ.get(p.z);
      if (!cur || p.y < cur.y) byZ.set(p.z, p);
    }
    return Math.max(...[...byZ.values()].map((p) => p.y + p.h));
  };
  const seq = [];
  for (let f = 0; f <= 18; f++) seq.push(bottomOf((f * 1000) / 60));
  const rest = seq[0];
  const dips = seq.map((b) => +(b - rest).toFixed(2));
  const peak = Math.max(...dips);
  assert.ok(dips[1] < peak * 0.5, '第一帧就该只走一半不到（否则是"一步到位"）：' + dips.slice(0, 4).join(','));
  assert.ok(peak > PRESS_DIP * 0.9, '峰值要够明显（≈' + PRESS_DIP + 'px 起）：' + peak);
  assert.ok(peak > PRESS_DIP * 1.02, '弹簧应有一点过冲：峰 ' + peak + ' vs 稳态 ' + PRESS_DIP);
  const settle = dips[dips.length - 1];
  assert.ok(Math.abs(settle - PRESS_DIP) < 1.2, '末尾应回稳到 PRESS_DIP 附近：' + settle);
  assert.ok(settle < peak, '过冲后要回落');
});

/* ---------------- 相机一致性（2026-10-18：音符"完全符合透视"的结构保证） ---------------- */

test('★ 坡道平面与键床平面是**同一台相机**：落点线处两个平面必须重合', () => {
  for (const persp of [0, 0.25, 0.5, 1]) {
    const cam = makeKeyboardProjection(Object.assign({}, CAM, { persp }));
    // 坡道距离 0 == 落点线 == 键床远端
    near(cam.yOf(0), CAM.wN, 1e-9);
    near(cam.sOf(CAM.wN), 0, 1e-9);
    // 横向缩放一致：落点线上 S=1（音符正好落在它那一列键上，对齐是结构保证）
    near(cam.sN(CAM.wN), 1, 1e-9);
    for (const u of [10, 400, 1200]) near(cam.pxN(u, CAM.wN), u, 1e-9);
  }
});

test('★ 坡道映射单调、可逆：yOf/sOf 互为反函数，音符的上下沿不会翻面', () => {
  const cam = makeKeyboardProjection(Object.assign({}, CAM, { persp: 1 }));
  for (const s of [0, 30, 120, 400, 700]) {
    near(cam.sOf(cam.yOf(s)), s, 1e-6);
  }
  let lastY = Infinity;
  for (let s = 0; s <= 800; s += 40) {
    const y = cam.yOf(s);
    assert.ok(y < lastY, '坡道距离越大屏幕 y 必须越小：s=' + s + ' y=' + y.toFixed(1));
    lastY = y;
  }
});

test('★ 音符越往上越窄、且左右对称地朝消失点收拢（不是只把某一边推走）', () => {
  const cam = makeKeyboardProjection(Object.assign({}, CAM, { persp: 1 }));
  const uL = 760, uR = 840;   // 跨过画布中心（w=1600 → 消失点在 x=800）
  const q0 = cam.noteQuad(uL, uR, cam.yOf(0), cam.yOf(0));
  const q1 = cam.noteQuad(uL, uR, cam.yOf(300), cam.yOf(320));
  const w0 = q0[2] - q0[0], w1 = q1[2] - q1[0];
  assert.ok(w1 < w0, '高处必须更窄：' + w1.toFixed(2) + ' vs ' + w0.toFixed(2));
  // 收拢是朝画布中心（消失点在 x 方向正中）：左端点右移、右端点左移
  assert.ok(q1[0] > q0[0], '左端点应向中心移');
  assert.ok(q1[2] < q0[2], '右端点应向中心移');
  // 下沿（落点线）必须与键列 1:1
  near(q0[0], uL, 1e-9); near(q0[2], uR, 1e-9);
});

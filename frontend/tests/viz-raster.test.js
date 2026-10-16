// 可视化重做 · 光栅层（M2）：packPrims 是纯函数，所以"顶点数据对不对"可以在 Node 里直接断言，
// 不用开浏览器。WebGL2 与 Canvas2D 的像素对齐由 Electron 验证台负责（离线台无 WebGL2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { packPrims, sampleFill, GL_STRIDE, GL_KINDS } from '../src/core/viz/raster/webgl2.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg ? msg + ': ' : '') + a + ' != ' + b);

test('每个可画图元恰好一个实例；text 与 alpha<=0 被跳过', () => {
  const prims = [
    { k: 'rect', layer: 'background', x: 0, y: 0, w: 10, h: 10, fill: '#fff' },
    { k: 'text', layer: 'keyboard', str: 'C4', x: 1, y: 1, color: '#fff' },
    { k: 'capsule', layer: 'notes', x: 1, y: 1, w: 4, h: 8, fill: '#f00', alpha: 0 },
    { k: 'rect', layer: 'notes', x: 2, y: 2, w: 4, h: 4, fill: '#0f0', alpha: 0.5 },
  ];
  const pk = packPrims(prims, 100, 100, 1);
  assert.equal(pk.count, 2, 'text 与 alpha=0 不进 GPU');
  assert.equal(pk.data.length, 4 * GL_STRIDE);
});

test('矩形四角落在约定槽位（TL/TR/BR/BL），与顶点着色器的 uv 推导一致', () => {
  const pk = packPrims([{ k: 'rect', layer: 'notes', x: 10, y: 20, w: 30, h: 40, r: 0, fill: '#ff0000', alpha: 1 }], 200, 200, 1);
  const d = pk.data;
  assert.deepEqual(Array.from(d.slice(0, 8)), [10, 20, 40, 20, 40, 60, 10, 60], 'TL TR BR BL');
  assert.deepEqual(Array.from(d.slice(8, 12)), [1, 0, 0, 1], '纯色 → 四个采样色相同');
  near(d[24], GL_KINDS.rect);
  near(d[27], 0, 'dir=0 表示纵向渐变');
  near(d[28], 1, 'alpha 在最后一槽');
});

test('坐标按 scale 放大（超采样/DPR 都靠它，图元本身保持 CSS 单位）', () => {
  const pk = packPrims([{ k: 'rect', layer: 'notes', x: 10, y: 20, w: 30, h: 40, fill: '#fff', alpha: 1 }], 400, 400, 2);
  assert.deepEqual(Array.from(pk.data.slice(0, 8)), [20, 40, 80, 40, 80, 120, 20, 120]);
});

test('按混合模式切分 run —— 顺序与 count 必须与原图元序列一致', () => {
  const mk = (blend) => ({ k: 'rect', layer: 'notes', x: 0, y: 0, w: 1, h: 1, fill: '#fff', alpha: 1, blend });
  const pk = packPrims([mk(), mk('lighter'), mk('lighter'), mk()], 10, 10, 1);
  assert.deepEqual(pk.runs, [
    { blend: 'normal', start: 0, count: 1 },
    { blend: 'lighter', start: 1, count: 2 },
    { blend: 'normal', start: 3, count: 1 },
  ]);
});

test('4 段渐变被精确采样（canvas 的分段线形在片元里逐段还原）', () => {
  const stops = ['#ff0000', '#00ff00', '#0000ff', '#ffffff'];
  const f = sampleFill({ stops, dir: 'v' });
  assert.equal(f.stops.length, 4);
  assert.equal(f.dir, 0);
  near(f.stops[0][0], 1); near(f.stops[0][1], 0);
  near(f.stops[1][1], 1); near(f.stops[1][2], 0);
  near(f.stops[2][2], 1); near(f.stops[2][0], 0);
  near(f.stops[3][0], 1); near(f.stops[3][1], 1); near(f.stops[3][2], 1);
  const h = sampleFill({ stops, dir: 'h' });
  assert.equal(h.dir, 1, 'dir=h → 横向，由片元的 vShape.w 决定');
  const two = sampleFill({ stops: ['#000000', '#ffffff'], dir: 'v' });
  assert.ok(Math.abs(two.stops[1][0] - 1 / 3) < 1e-5, '两停点渐变在 ⅓ 处应为三分之一亮度');
  near(two.stops[3][0], 1);
});

test('rgba() 里的 alpha 进入采样色（网格线就是靠它变淡的）', () => {
  const f = sampleFill('rgba(255,255,255,0.05)');
  assert.ok(Math.abs(f.stops[0][3] - 0.05) < 1e-6, 'parseColor 必须解析 rgba 的 alpha');
  assert.ok(Math.abs(f.stops[3][3] - 0.05) < 1e-6);
});

test('径向光：外半径解析与 canvas2d 一致；内外半径相等时按 canvas 规范不画', () => {
  const g = packPrims([{ k: 'glow', layer: 'notes', x: 50, y: 60, r0: 0, r1: 30, color: '#ff0000', alpha: 1 }], 100, 100, 1);
  assert.equal(g.count, 1);
  const d = g.data;
  assert.deepEqual(Array.from(d.slice(0, 8)), [20, 30, 80, 30, 80, 90, 20, 90], 'bbox = 外半径的正方形');
  assert.equal(d[24], GL_KINDS.glow);
  near(d[26], 0, '内半径比率 r0/r1');
  const only = packPrims([{ k: 'glow', layer: 'notes', x: 50, y: 60, r0: 30, r1: 0, color: '#f00', alpha: 1 }], 100, 100, 1);
  assert.equal(only.count, 0, 'r0==r1 → 退化渐变，canvas 规定什么都不画');
});

test('线展成垂直方向加宽的四边形，线宽进 shape（片元据此做 AA）', () => {
  const pk = packPrims([{ k: 'line', layer: 'background', x0: 10, y0: 0, x1: 10, y1: 100, lw: 2, color: '#ffffff', alpha: 1 }], 100, 100, 1);
  const d = pk.data;
  // P0..P3 = (起点+法线, 终点+法线, 终点-法线, 起点-法线)：uv.x 沿线、uv.y 垂直方向
  near(d[0], 8.5); near(d[1], 0);
  near(d[2], 8.5); near(d[3], 100);
  near(d[24], GL_KINDS.line);
  near(d[25], 2, '线宽（设备像素）');
});

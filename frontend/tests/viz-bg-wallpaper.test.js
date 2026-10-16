// 音符瀑布背景的「动态壁纸」档（2026-10-19 新增）绘制契约。
// 这一档有两个**只看代码看不出来**的坑，用测试钉住：
//   ① 视频逐帧都在变 → 绝不能走 paintVizBg 的离屏位图缓存（BG_CACHE 的键里没有时间），
//      否则用户选了动态壁纸、画面却永远停在第一帧；
//   ② 模糊只能逐帧做 → 必须落在**受限尺寸**的帧上（4K 全分辨率一次 blur 实测 80~150ms）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { paintVizBg } from '../src/core/viz.js';
import { drawVizWaterfallPost } from '../src/core/viz/index.js';

const VIDEO = { videoWidth: 1920, videoHeight: 1080, readyState: 4, currentTime: 0 };

function recCtx() {
  const calls = []; const filters = [];
  const o = {
    calls, filters, fillStyle: '', _f: 'none',
    get filter() { return o._f; },
    set filter(v) { o._f = v; filters.push(v); },
    getTransform: () => ({ a: 1 }),
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    scale() { /* 缓存路径会缩一次，这里不需要真缩放 */ },
    setTransform() { /* 帧画布每次重画前重置变换 */ },
    clearRect(...a) { calls.push(['clearRect', ...a]); },
    fillRect(...a) { calls.push(['fillRect', o.fillStyle, ...a]); },
    drawImage(_img, ...a) { calls.push(['drawImage', a.length, ...a]); },
    createLinearGradient() { calls.push(['createLinearGradient']); return { addColorStop() {} }; },
  };
  return o;
}
function fakeCanvas() {
  const cv = { width: 0, height: 0, ctx: null };
  cv.getContext = () => (cv.ctx || (cv.ctx = recCtx()));
  return cv;
}
const drawOf = (ctx) => ctx.calls.find((c) => c[0] === 'drawImage');
const withDoc = (fn) => {
  const saved = globalThis.document;
  const canvases = [];
  globalThis.document = { createElement() { const cv = fakeCanvas(); canvases.push(cv); return cv; } };
  try { return fn(canvases); } finally { globalThis.document = saved; }
};

test('动态壁纸：按 cover 铺满（不拉伸变形），暗化尺寸等于整幅画布', () => {
  const ctx = recCtx();
  paintVizBg(ctx, 800, 600, { mode: 'wallpaper', video: VIDEO, blur: 0, dim: 0.4 });
  const di = drawOf(ctx);
  assert.ok(di, '应画出视频当前帧');
  const [, , dx, dy, dw, dh] = di;
  // 1920x1080 → 800x600：scale = max(800/1920, 600/1080) = 0.5556 → 1066.67 x 600，左右各裁 1/6
  assert.equal(Math.round(dw), 1067);
  assert.equal(Math.round(dh), 600);
  assert.equal(Math.round(dx), -133);   // (800-1066.67)/2 = -133.33
  assert.equal(dy, 0);
  const dim = ctx.calls.find((c) => c[0] === 'fillRect' && c[1] === 'rgba(0,0,0,0.4)');
  assert.ok(dim, '暗化应按整幅画布铺一层');
  assert.deepEqual(dim.slice(2), [0, 0, 800, 600]);
});

test('动态壁纸不走位图缓存（否则画面永远停在第一帧）', () => {
  withDoc((canvases) => {
    const v = { ...VIDEO, currentTime: 0 };
    const c1 = recCtx(); paintVizBg(c1, 800, 600, { mode: 'wallpaper', video: v, blur: 0, dim: 0 });
    v.currentTime = 1.5;
    const c2 = recCtx(); paintVizBg(c2, 800, 600, { mode: 'wallpaper', video: v, blur: 0, dim: 0 });
    assert.equal(canvases.length, 0, '不模糊时不该建任何离屏画布');
    assert.ok(drawOf(c1) && drawOf(c2), '两帧都要真的画一次');
  });
});

test('对照：图片档仍然走位图缓存（失效的只是动态壁纸这一档）', () => {
  withDoc((canvases) => {
    const img = { width: 1920, height: 1080, src: 'bg-test.png' };
    paintVizBg(recCtx(), 800, 600, { mode: 'image', image: img, blur: 0, dim: 0 });
    assert.equal(canvases.length, 1, '图片档要建一张位图缓存');
    paintVizBg(recCtx(), 800, 600, { mode: 'image', image: img, blur: 0, dim: 0 });
    assert.equal(canvases.length, 1, '同一套参数第二次应命中缓存');
  });
});

test('动态壁纸的模糊落在受限尺寸帧上（≤1280 宽），且帧画布逐帧复用', () => {
  withDoc((canvases) => {
    const ctx = recCtx();
    paintVizBg(ctx, 3840, 2160, { mode: 'wallpaper', video: VIDEO, blur: 12, dim: 0.2 });
    assert.equal(canvases.length, 1);
    assert.equal(canvases[0].width, 1280);
    assert.equal(canvases[0].height, 720);            // 等比：1280 x 2160/3840
    assert.ok(canvases[0].ctx.filters.includes('blur(4px)'), '模糊半径要按帧/画布比例缩小：12 x 1280/3840');
    assert.deepEqual(drawOf(ctx).slice(2), [0, 0, 3840, 2160], '帧再放大铺满整幅');
    paintVizBg(recCtx(), 3840, 2160, { mode: 'wallpaper', video: VIDEO, blur: 12, dim: 0.2 });
    assert.equal(canvases.length, 1, '同一尺寸的帧画布应复用，不每帧新建');
  });
});

test('视频还没出帧时退回主题底，不留一块黑屏', () => {
  const ctx = recCtx();
  paintVizBg(ctx, 800, 600, { mode: 'wallpaper', video: { videoWidth: 0, videoHeight: 0, readyState: 0 }, blur: 0, dim: 0 });
  assert.ok(ctx.calls.some((c) => c[0] === 'createLinearGradient'), '应退回主题渐变');
  assert.ok(!drawOf(ctx), '没帧就不该画视频');
});
/* 全功能假 2D 上下文：实时门面会把整帧（背景 + 键盘 + 音符 + 文字）都画过去，
   所以任何属性都要取得到、任何方法都要能调，只把 drawImage 记下来。 */
const CTX_RET = {
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  createPattern: () => null,
  getTransform: () => ({ a: 1 }),
  measureText: () => ({ width: 8 }),
};
function anyCtx() {
  const calls = [];
  const base = { calls, filter: 'none', fillStyle: '', strokeStyle: '', font: '', lineWidth: 1,
    globalAlpha: 1, globalCompositeOperation: 'source-over', textAlign: 'left', textBaseline: 'alphabetic',
    shadowBlur: 0, shadowColor: '' };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (k in CTX_RET) return CTX_RET[k];
      return (...a) => { calls.push([k, ...a]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

test('实时门面也要认动态壁纸档（背景实现只许有一份）', () => {
  // 回归：core/viz/index.js 里曾经另有一份 paintStage 拷贝，只认 theme/solid/image/transparent。
  // 新增动态壁纸档时漏改那一份 → 实时画面「背景整块哑火」（导出侧却是好的）。
  const ctx = anyCtx();
  drawVizWaterfallPost(ctx, 800, 600, null, 0, {
    bg: { mode: 'wallpaper', video: VIDEO, blur: 0, dim: 0.18 },
    fx: {}, theme: 'studio', raster: 'canvas2d',
  });
  const di = ctx.calls.find((c) => c[0] === 'drawImage');
  assert.ok(di, '动态壁纸档必须真的把视频帧铺上去');
  assert.equal(Math.round(di[4]), 1067, '与 paintVizBg 同一套 cover 算法');
  assert.equal(Math.round(di[5]), 600);
});

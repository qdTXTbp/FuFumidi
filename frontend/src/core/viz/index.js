// ============================================================
// 可视化门面（可视化重做 · 唯一入口）
//
// 实时（ViewViz）与视频导出（ViewConvert）**只能**从这里进 —— 这是"预览与成片一致"的结构保证：
// 同一个 renderer、同一份主题/参数（stores/vizbg）、同一份图元、同一条后处理链。
//
// 兼容：旧的 `drawVizWaterfall(ctx,w,h,song,tick,opts)` / `drawVizWaterfallPost(...)` 名字保留，
// 所以两个消费点只改 import 路径。opts 字段（zoom/colorScheme/fx/bg/energy/activeNotes/
// showLyrics/lyricAt/state）全部继续接受。
// ============================================================
import { createCompiler } from './scene/compile.js';
import { drawCanvas2D } from './raster/canvas2d.js';
import { getGLRaster } from './raster/webgl2.js';
import { resolveTheme } from './state/themes.js';
import { bloomPass, ensureScene } from './post/bloom2d.js';
import { LAYERS } from './scene/primitives.js';
// ★ 背景实现只有一份（core/viz.js）—— 详见下面 paintStage 的注释
import { paintVizBgDirect } from '../viz.js';

const RENDERERS = new WeakMap();
const DEFAULT_KEY = {};
let lastStats = { total: 0, layers: {} };

function rendererFor(opts) {
  const key = (opts && opts.state) || DEFAULT_KEY;
  let r = RENDERERS.get(key);
  if (!r) { r = createVizRenderer(); RENDERERS.set(key, r); }
  return r;
}

function pixelScale(ctx) {
  try { const m = ctx.getTransform ? ctx.getTransform() : null; return (m && m.a > 0) ? m.a : 1; } catch (e) { return 1; }
}

/** 舞台预铺：只处理"主题之外"的档位（透明 / 纯色 / 图片 / 动态壁纸 / keep）；
 *  主题底色来自 background 层的图元（所以 theme 档返回 false = 没铺底）。
 *
 *  ★ 这里**必须**转调 core/viz.js 的 paintVizBgDirect —— 早先这张函数是它的第二份拷贝，
 *    只认 theme/solid/image/transparent。2026-10-19 新增「动态壁纸」档时漏改了这一份，
 *    后果不是"画得不好看"而是**整块背景哑火**：本函数在 wallpaper 档下任何分支都不命中，
 *    却仍返回 true（= "我铺好了"），于是编译器也不再发 background 层图元 ——
 *    用户看到的是"选了动态壁纸，背景什么都没有"。现在实现只有一份。 */
function paintStage(ctx, w, h, bg = {}) {
  const mode = bg.mode || 'theme';
  if (mode === 'theme') return false;     // 主题底由 background 层图元画
  if (mode === 'keep') return true;       // 调用方已经自己铺过一整帧（导出模板用）
  if (mode === 'transparent') { ctx.save(); ctx.clearRect(0, 0, w, h); ctx.restore(); return true; }
  paintVizBgDirect(ctx, w, h, bg);
  return true;
}

function drawLayers(ctx, prims, wantsStats) {
  if (!wantsStats) { drawCanvas2D(ctx, prims); lastStats = { total: 0, layers: {} }; return; }
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const stats = { total: 0, layers: {} };
  for (const layer of LAYERS) {
    const chunk = prims.filter((p) => p.layer === layer);
    if (!chunk.length) continue;
    const a = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    drawCanvas2D(ctx, chunk);
    stats.layers[layer] = +(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - a).toFixed(2));
  }
  stats.total = +(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2));
  lastStats = stats;
}

export function createVizRenderer() {
  const compiler = createCompiler();
  return {
    state: compiler.state,
    /**
     * @param ctx 2D 上下文（调用方已设好 dpr 缩放；w/h 是 CSS 像素）
     * @param opts { theme, fx, bg, zoom, colorScheme, energy, activeNotes, showLyrics, lyricAt, state, stats }
     */
    render(ctx, w, h, song, tick, opts = {}) {
      const fx = opts.fx || {};
      const bg = opts.bg || {};
      const sc = pixelScale(ctx) || 1;
      const wantBloom = (typeof document !== 'undefined' && document.createElement && (Number(fx.bloom) || 0) > 0.001);
      // 超采样（对标 Pianola 的 "any resolution / supersampling"）：先按 ssaa 倍渲染到离屏，
      // 合成时缩回目标尺寸 —— 抗锯齿与细节都更好，代价是可离线跑（导出不需要实时）。
      const ssaa = Math.max(1, Math.min(3, Number(opts.ssaa) || 1));
      // 光栅后端：GPU（WebGL2）优先，跑不了就回退 Canvas2D —— 两条路吃同一份图元。
      // 调试开关 window.__fufumidiVizForceCanvas2D 用于真机 A/B（不改设置项，避免给用户加开关）。
      const force2d = typeof window !== 'undefined' && window.__fufumidiVizForceCanvas2D;
      const gl = (opts.raster === 'canvas2d' || force2d) ? null : getGLRaster();
      const needScene = !!gl || wantBloom || ssaa > 1;
      const stageIsPrim = !(bg.mode && bg.mode !== 'theme');
      const compileOpts = Object.assign({}, opts, {
        w, h, theme: opts.theme || 'studio', fx, stage: stageIsPrim,
        transparent: bg.mode === 'transparent',
      });
      const out = compiler.compile(song, tick, compileOpts);

      if (!needScene) {
        ctx.save();
        paintStage(ctx, w, h, bg);
        drawLayers(ctx, out.prims, !!opts.stats);
        ctx.restore();
        return out;
      }
      // 场景先画进离屏（泛光/超采样的输入必须是"场景"而不是"背景+场景"）
      const tw = Math.max(1, Math.round(w * sc)), th = Math.max(1, Math.round(h * sc));   // 目标设备尺寸
      const pw = Math.max(1, Math.round(w * sc * ssaa)), ph = Math.max(1, Math.round(h * sc * ssaa));
      let scene = null;
      let texts = null;
      let gpuPost = false;   // 泛光已在 GPU 链里做完，就不必再走 canvas 版 bloomPass
      if (gl) {
        gl.resize(pw, ph);
        texts = out.prims.some((p) => p.k === 'text') ? out.prims.filter((p) => p.k === 'text') : null;
        const mat = (opts.theme && resolveTheme ? resolveTheme(opts.theme) : null) || {};
        const material = (mat && mat.material) || {};
        gl.draw(out.prims, sc * ssaa, {
          post: wantBloom ? {
            enabled: true,
            bloom: Math.max(0, Number(fx.bloom) || 0) * 1.5,
            thr: Math.max(0, Math.min(1, Number(fx.bloomThr) == null ? (material.bloomThr == null ? 0.55 : material.bloomThr) : Number(fx.bloomThr))),
            knee: 0.26,
            exposure: material.grade == null ? 1 : material.grade,
          } : null,
        });   // text 图元被 WebGL 跳过，留给下面叠字
        scene = gl.canvas;
        gpuPost = !!(wantBloom && fx && Number(fx.bloom) > 0.001);
      } else {
        scene = ensureScene(pw, ph);
        if (!scene) { ctx.save(); paintStage(ctx, w, h, bg); drawLayers(ctx, out.prims, !!opts.stats); ctx.restore(); return out; }
        const sctx = scene.getContext('2d');
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(0, 0, pw, ph);
        sctx.save(); sctx.scale(sc * ssaa, sc * ssaa);   // 图元是 CSS 单位，这里一次性放大到超采样分辨率
        drawLayers(sctx, out.prims, false);
        sctx.restore();
      }
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.save(); ctx.scale(sc, sc); paintStage(ctx, w, h, bg); ctx.restore();
      ctx.drawImage(scene, 0, 0, tw, th);   // 超采样在这里缩回目标尺寸（降采样 = 抗锯齿）
      if (wantBloom && !gpuPost) {
        bloomPass(ctx, scene, tw, th, Math.max(0, Number(fx.bloom) || 0), Math.max(0, Math.min(1, Number(fx.bloomThr) == null ? 0.5 : Number(fx.bloomThr))));
      }
      // 文字层：GPU 后端不画字（字形质量），统一用 Canvas2D 叠在最上，实时与导出同一条路
      if (texts) { ctx.save(); ctx.scale(sc, sc); drawCanvas2D(ctx, texts); ctx.restore(); }
      ctx.restore();
      lastStats = { total: +(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2)), layers: { post: lastStats.total } };
      return out;
    },
    stats() { return lastStats; },
  };
}

/** 兼容旧名：不带后处理（导出仪表盘模板会自己控背景时用） */
export function drawVizWaterfall(ctx, w, h, song, tick, opts = {}) {
  const fx = Object.assign({}, opts.fx);
  delete fx.bloom;
  return rendererFor(opts).render(ctx, w, h, song, tick, Object.assign({}, opts, { fx }));
}

/** 主入口（实时与导出都用它）：场景 + 后处理 */
export function drawVizWaterfallPost(ctx, w, h, song, tick, opts = {}) {
  return rendererFor(opts).render(ctx, w, h, song, tick, opts);
}

export function vizStats() { return lastStats; }

/**
 * 诊断：当前光栅后端与显卡名。
 * 真机验收（"我的机器现在到底跑 GPU 还是 CPU"）和问题排查都靠它，挂到 window 上便于 CDP/控制台直查。
 */
export function vizRasterInfo() {
  const g = getGLRaster();
  return g ? { backend: 'webgl2', renderer: g.renderer } : { backend: 'canvas2d', renderer: 'cpu' };
}
if (typeof window !== 'undefined') window.__fufumidiVizRaster = vizRasterInfo;

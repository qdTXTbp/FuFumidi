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
import { bloomPass, ensureScene } from './post/bloom2d.js';
import { LAYERS } from './scene/primitives.js';

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

/** 舞台预铺：只处理"主题之外"的三档（透明/纯色/图片）；主题底色来自 background 层的图元 */
function paintStage(ctx, w, h, bg = {}) {
  const mode = bg.mode || 'theme';
  if (mode === 'theme') return false;
  ctx.save();
  if (mode === 'transparent') {
    ctx.clearRect(0, 0, w, h);
  } else if (mode === 'solid') {
    ctx.fillStyle = bg.color || '#0b1020';
    ctx.fillRect(0, 0, w, h);
  } else if (mode === 'image' && bg.image && bg.image.width) {
    const blur = Math.max(0, Number(bg.blur) || 0), dim = Math.max(0, Math.min(0.9, Number(bg.dim) || 0));
    const pad = blur > 0 ? blur * 3 : 0;
    const s = Math.max((w + pad * 2) / bg.image.width, (h + pad * 2) / bg.image.height);
    const dw = bg.image.width * s, dh = bg.image.height * s;
    ctx.filter = blur > 0 ? 'blur(' + blur + 'px)' : 'none';
    ctx.drawImage(bg.image, (w - dw) / 2, (h - dh) / 2, dw, dh);
    ctx.filter = 'none';
    if (dim > 0) { ctx.fillStyle = 'rgba(0,0,0,' + dim + ')'; ctx.fillRect(0, 0, w, h); }
  }
  ctx.restore();
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
      const stageIsPrim = !(bg.mode && bg.mode !== 'theme');
      const compileOpts = Object.assign({}, opts, { w, h, theme: opts.theme || 'studio', fx, stage: stageIsPrim });
      const out = compiler.compile(song, tick, compileOpts);

      if (!wantBloom) {
        ctx.save();
        paintStage(ctx, w, h, bg);
        drawLayers(ctx, out.prims, !!opts.stats);
        ctx.restore();
        return out;
      }
      // 有泛光：场景先画进离屏，再叠回主画布（后处理的输入必须是"场景"而不是"背景+场景"）
      const pw = Math.max(1, Math.round(w * sc)), ph = Math.max(1, Math.round(h * sc));
      const scene = ensureScene(pw, ph);
      if (!scene) { ctx.save(); paintStage(ctx, w, h, bg); drawLayers(ctx, out.prims, !!opts.stats); ctx.restore(); return out; }
      const sctx = scene.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, pw, ph);
      sctx.save(); sctx.scale(sc, sc);
      drawLayers(sctx, out.prims, false);
      sctx.restore();
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.scale(sc, sc); paintStage(ctx, w, h, bg); ctx.restore();
      ctx.drawImage(scene, 0, 0);
      bloomPass(ctx, scene, pw, ph, Math.max(0, Number(fx.bloom) || 0), Math.max(0, Math.min(1, Number(fx.bloomThr) == null ? 0.5 : Number(fx.bloomThr))));
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

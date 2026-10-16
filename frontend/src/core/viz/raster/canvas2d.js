// ============================================================
// Canvas2D 光栅器（可视化重做 · 光栅层）
//
// 职责只有一个：**把 Primitive[] 画出来**。它不知道"琴键""音符"是什么，
// 也就没有"某一层忘了补乘 alpha"这类 bug 的土壤。
// WebGL2 光栅器（M2）会吃**同一份图元**，两者用像素对齐测试互相约束。
// ============================================================

function fillOf(ctx, fill, x, y, w, h) {
  if (typeof fill === 'string' || !fill) { ctx.fillStyle = fill || '#fff'; return; }
  const stops = fill.stops || [];
  const gr = fill.dir === 'h' ? ctx.createLinearGradient(x, y, x + w, y) : ctx.createLinearGradient(x, y, x, y + h);
  for (let i = 0; i < stops.length; i++) gr.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), stops[i]);
  ctx.fillStyle = gr;
}

function roundRectPath(ctx, x, y, w, h, r) {
  let q = r;
  if (typeof q === 'number') q = [q, q, q, q];
  else if (!Array.isArray(q)) q = [0, 0, 0, 0];
  const lim = Math.min(Math.abs(w), Math.abs(h)) / 2;
  q = q.slice(0, 4).map((v) => Math.max(0, Math.min(v || 0, lim)));
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, q); return; }
  ctx.beginPath();
  ctx.moveTo(x + q[0], y);
  ctx.lineTo(x + w - q[1], y); ctx.arcTo(x + w, y, x + w, y + q[1], q[1]);
  ctx.lineTo(x + w, y + h - q[2]); ctx.arcTo(x + w, y + h, x + w - q[2], y + h, q[2]);
  ctx.lineTo(x + q[3], y + h); ctx.arcTo(x, y + h, x, y + h - q[3], q[3]);
  ctx.lineTo(x, y + q[0]); ctx.arcTo(x, y, x + q[0], y, q[0]);
  ctx.closePath();
}

export function drawCanvas2D(ctx, prims) {
  let blend = 'source-over';
  const setBlend = (b) => {
    const n = b === 'lighter' ? 'lighter' : b === 'multiply' ? 'multiply' : 'source-over';
    if (n !== blend) { ctx.globalCompositeOperation = n; blend = n; }
  };
  ctx.save();
  ctx.textBaseline = 'middle';
  for (const p of prims) {
    const a = p.alpha == null ? 1 : p.alpha;
    if (a <= 0) continue;
    setBlend(p.blend);
    ctx.globalAlpha = a;
    switch (p.k) {
      case 'rect': {
        fillOf(ctx, p.fill, p.x, p.y, p.w, p.h);
        roundRectPath(ctx, p.x, p.y, p.w, p.h, p.r);
        ctx.fill();
        break;
      }
      case 'capsule': {
        fillOf(ctx, p.fill, p.x, p.y, p.w, p.h);
        roundRectPath(ctx, p.x, p.y, p.w, p.h, p.r == null ? Math.min(p.w, p.h) / 2 : p.r);
        ctx.fill();
        break;
      }
      case 'quad': {
        const pts = p.pts;
        fillOf(ctx, p.fill, pts[0], pts[1], pts[4] - pts[0], pts[5] - pts[1]);
        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'glow': {
        const r1 = Math.max(0.1, p.r1 || p.r0 || 1), r0 = Math.max(0, p.r0 || 0);
        const gr = ctx.createRadialGradient(p.x, p.y, r0, p.x, p.y, r1);
        gr.addColorStop(0, withA(p.color, 0.85));
        gr.addColorStop(0.45, withA(p.color, 0.32));
        gr.addColorStop(1, withA(p.color, 0));
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(p.x, p.y, r1, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'ring': {
        ctx.strokeStyle = p.color; ctx.lineWidth = p.lw || 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, p.r), 0, Math.PI * 2); ctx.stroke();
        break;
      }
      case 'beam': {
        // 三层嵌套：canvas 渐变只能沿一个轴，单层左右是硬边（离线台实测像纸条）
        for (let i = 0; i < 3; i++) {
          const k = i / 2, wwx = p.w * (0.42 + 0.58 * k);
          const gr = ctx.createLinearGradient(0, p.y, 0, p.y - p.h);
          gr.addColorStop(0, withA(p.color, (0.40 - 0.13 * i) * (p.alpha == null ? 1 : p.alpha)));
          gr.addColorStop(1, withA(p.color, 0));
          ctx.globalAlpha = 1;
          ctx.fillStyle = gr;
          ctx.fillRect(p.x - wwx / 2, p.y - p.h, wwx, p.h);
        }
        break;
      }
      case 'line': {
        ctx.strokeStyle = p.color; ctx.lineWidth = p.lw || 1;
        ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.lineTo(p.x1, p.y1); ctx.stroke();
        break;
      }
      case 'text': {
        ctx.fillStyle = p.color;
        ctx.font = (p.bold ? '600 ' : '') + (p.size || 10) + 'px system-ui, "Microsoft YaHei", sans-serif';
        ctx.textAlign = p.align || 'left';
        ctx.fillText(p.str, p.x, p.y);
        ctx.textAlign = 'left';
        break;
      }
      case 'overlay': {
        if (p.kind === 'vignette') {
          const cx = p.cx == null ? 0.5 : p.cx, cy = p.cy == null ? 0.46 : p.cy;
          const R = Math.max(ctx.canvas.width, ctx.canvas.height) * 0.78;
          const gr = ctx.createRadialGradient(ctx.canvas.width * cx, ctx.canvas.height * cy, R * 0.35,
            ctx.canvas.width * cx, ctx.canvas.height * cy, R);
          gr.addColorStop(0, 'rgba(0,0,0,0)');
          gr.addColorStop(1, 'rgba(0,0,0,' + (p.strength == null ? 0.55 : p.strength) + ')');
          ctx.fillStyle = gr;
          ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        }
        break;
      }
      default: break;
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

/** '#rrggbb' → rgba(...)，认不出就原样返回 */
export function withA(c, a) {
  const s = String(c == null ? '' : c).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) { const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16); return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'; }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) { const r = parseInt(m[1][0] + m[1][0], 16), g = parseInt(m[1][1] + m[1][1], 16), b = parseInt(m[1][2] + m[1][2], 16); return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'; }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) { const q = m[1].split(',').map(Number); return 'rgba(' + q[0] + ',' + q[1] + ',' + q[2] + ',' + a + ')'; }
  return s;
}

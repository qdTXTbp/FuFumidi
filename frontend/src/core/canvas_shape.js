// -*- coding: utf-8 -*-
/**
 * Canvas 连续曲率路径（squircle）。
 *
 * DOM 侧靠 CSS `corner-shape: squircle`（Chromium 139+）；Canvas 没有这个属性，
 * 这里用四阶超椭圆 |u|^4 + |v|^4 = 1 采样角部，再用 Catmull-Rom 转三次贝塞尔。
 * 相比 arcTo 的圆弧，切线过渡是连续的（曲率不突变），观感与 DOM 圆角一致。
 *
 * 只负责路径生成，不碰样式；调用方保持原来的 beginPath/fill/stroke 习惯。
 */

const EXPONENT = 4;       // 超椭圆指数：4 ≈ squircle
const CORNER_SAMPLES = 4; // 每个角 4 点 → 2 段三次贝塞尔

/** 超椭圆参数点（相对角中心；theta=0 指向 +x，-π/2 指向 -y）。 */
function superellipsePoint(cx, cy, r, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const p = 2 / EXPONENT;
  const px = Math.sign(c) * Math.pow(Math.abs(c), p) * r;
  const py = Math.sign(s) * Math.pow(Math.abs(s), p) * r;
  return [cx + px, cy + py];
}

/** Catmull-Rom → 三次贝塞尔（端点用自身近似切线）。 */
function curveThrough(ctx, pts) {
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1],
    );
  }
}

function corner(ctx, cx, cy, r, a0, a1) {
  const pts = [];
  for (let i = 0; i < CORNER_SAMPLES; i++) {
    const t = a0 + ((a1 - a0) * i) / (CORNER_SAMPLES - 1);
    pts.push(superellipsePoint(cx, cy, r, t));
  }
  curveThrough(ctx, pts);
}

/**
 * 生成连续曲率圆角矩形路径（闭合）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x 左上角 x
 * @param {number} y 左上角 y
 * @param {number} w 宽
 * @param {number} h 高
 * @param {number|number[]} r 圆角半径；数组按 [左上, 右上, 右下, 左下]
 */
export function squirclePath(ctx, x, y, w, h, r) {
  const width = Math.max(0, w);
  const height = Math.max(0, h);
  const lim = Math.min(width, height) / 2;
  const raw = Array.isArray(r) ? r : [r, r, r, r];
  const [tl, tr, br, bl] = [0, 1, 2, 3].map((i) => {
    const v = Number(raw[i]);
    return Number.isFinite(v) ? Math.max(0, Math.min(v, lim)) : 0;
  });
  ctx.beginPath();
  if (!tl && !tr && !br && !bl) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.lineTo(x + width, y + height);
    ctx.lineTo(x, y + height);
    ctx.closePath();
    return;
  }
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + width - tr, y);
  if (tr) corner(ctx, x + width - tr, y + tr, tr, -Math.PI / 2, 0);
  ctx.lineTo(x + width, y + height - br);
  if (br) corner(ctx, x + width - br, y + height - br, br, 0, Math.PI / 2);
  ctx.lineTo(x + bl, y + height);
  if (bl) corner(ctx, x + bl, y + height - bl, bl, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + tl);
  if (tl) corner(ctx, x + tl, y + tl, tl, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

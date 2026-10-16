// ============================================================
// 落键效果（场景层 · 受同一台相机影响）
//
// 用户要求：「粒子光效、落键光带、击键光柱也要受透视影响」。
// 这些效果都锚在键盘上，但会**往上飘**（粒子/光柱）—— 一旦离开落点线，就该跟着键列一起
// 朝消失点收拢，否则会出现"键是斜的、光柱是直的"这种穿帮。
//
// 做法：把屏幕坐标当成键盘坐标（落点线上两者恒等），再按该点所在高度取深度投影；
// 光柱用**三层嵌套四边形**换横向软收（旧 canvas 版的三层矩形思路，只是改吃相机）。
// ============================================================
import { withAlpha } from '../state/palette.js';

/** 屏幕 x → 按该点深度投影后的 x（persp=0 时恒等） */
export function projectX(cam, ps, x, y) {
  return ps > 0.001 ? cam.px(x, cam.depthAt(y)) : x;
}
/** 该高度处的横向缩放（尺寸类效果跟着缩，才与位置一致） */
export function depthScale(cam, ps, y) {
  return ps > 0.001 ? 1 + cam.kz * cam.depthAt(y) : 1;
}

/** 一根会随透视倾倒的光柱：外层宽而淡 → 内层窄而亮，纵向由渐变收口 */
export function beamQuads(P, o) {
  const { cam, ps, x, yBottom, w, h, color, alpha } = o;
  const pr = [];
  // ★ 横向柔化：原先 3 层（宽度 1.0/0.66/0.38、透明度 0.36/0.56/0.78）——
  //   相邻两层的透明度差到 0.2，在深底上能看出**阶梯**（用户："上游有生硬的转折"）。
  //   改 4 层并压平相邻差（0.22/0.33/0.47/0.64），阶梯感消失；总数不变，绘制成本一样。
  const layers = [[1.0, 0.22], [0.78, 0.33], [0.56, 0.47], [0.34, 0.64]];
  // ★ 层归属：默认 'fx'（在 keyboard 之后）—— 光柱必须压在琴键之上，
  //   否则键面会在半截处把它切出一条横边。见 primitives.js 的 LAYERS 注释。
  const layer = o.layer || 'fx';
  for (const [wid, k] of layers) {
    const ww = Math.max(1.5, w * wid);
    const bx0 = projectX(cam, ps, x - ww / 2, yBottom), bx1 = projectX(cam, ps, x + ww / 2, yBottom);
    const tx0 = projectX(cam, ps, x - ww / 2, yBottom - h), tx1 = projectX(cam, ps, x + ww / 2, yBottom - h);
    pr.push(P.quad(layer, [tx0, yBottom - h, tx1, yBottom - h, bx1, yBottom, bx0, yBottom],
      { stops: [withAlpha(color, 0), withAlpha(color, alpha * k)], dir: 'v' }, { blend: 'lighter', z: o.z }));
  }
  return pr;
}

/* ============================================================
   键缘闪光（2026-10-17 用户："键盘边缘处的波动闪光可以添加更多的样式"）
   ============================================================
   原先只有一种：落点线上一个软光晕。这里给 5 种，并且**按下标确定性轮换**
   （pitch + 力度档）——不用随机数：随机会让同一次按键在相邻帧换样式，看着像抖动。
     soft  软光晕（原来的）
     ring  单圈冲击波
     dual  双圈 + 芯
     streak 竖向光带（短促）
     bar   键缘亮条（贴着键面的一条横光）
   ============================================================ */
export function keyRipple(P, o) {
  const { x, y, w, color, life, velN } = o;
  const idx = ((o.index | 0) % 5 + 5) % 5;
  const a = Math.max(0.05, Math.min(1, o.alpha == null ? 0.34 : o.alpha)) * (0.5 + 0.5 * velN);
  const half = Math.max(2.5, w * 0.5);
  const pr = [];
  const z = o.z == null ? 0 : o.z;
  if (idx === 0) {
    pr.push(P.glow('fx', x, y, 1, Math.max(4, Math.min(half * 0.84, 9)), color, { alpha: a, blend: 'lighter', z }));
  } else if (idx === 1) {
    pr.push(P.ring('fx', x, y, 3 + 16 * life, 1.6, color, { alpha: a * 0.9, blend: 'lighter', z }));
  } else if (idx === 2) {
    pr.push(P.ring('fx', x, y, 2 + 20 * life, 1.4, color, { alpha: a * 0.75, blend: 'lighter', z }));
    pr.push(P.ring('fx', x, y, 1 + 10 * life, 1.2, color, { alpha: a * 0.55, blend: 'lighter', z: z + 1 }));
    pr.push(P.glow('fx', x, y, 1, Math.max(3, half * 0.5), color, { alpha: a * 0.5, blend: 'lighter', z: z + 2 }));
  } else if (idx === 3) {
    pr.push(P.beam('fx', x, y - 34 - 26 * life, Math.max(2, w * 0.5), 34 + 26 * life, color, { alpha: a * 0.8, blend: 'lighter', z }));
  } else {
    pr.push(P.capsule('fx', x - half, y - 2, half * 2, 4, color, { alpha: a * 0.95, blend: 'lighter', z }));
    pr.push(P.glow('fx', x, y, 1, Math.max(3, half * 0.6), color, { alpha: a * 0.4, blend: 'lighter', z: z + 1 }));
  }
  return pr;
}

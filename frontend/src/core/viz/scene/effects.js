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
  const layers = [[1.0, 0.36], [0.66, 0.56], [0.38, 0.78]];
  for (const [wid, k] of layers) {
    const ww = Math.max(1.5, w * wid);
    const bx0 = projectX(cam, ps, x - ww / 2, yBottom), bx1 = projectX(cam, ps, x + ww / 2, yBottom);
    const tx0 = projectX(cam, ps, x - ww / 2, yBottom - h), tx1 = projectX(cam, ps, x + ww / 2, yBottom - h);
    pr.push(P.quad('impact', [tx0, yBottom - h, tx1, yBottom - h, bx1, yBottom, bx0, yBottom],
      { stops: [withAlpha(color, 0), withAlpha(color, alpha * k)], dir: 'v' }, { blend: 'lighter', z: o.z }));
  }
  return pr;
}

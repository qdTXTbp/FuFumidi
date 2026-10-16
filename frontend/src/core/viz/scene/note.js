// ============================================================
// 下落音符（可视化重做 · 场景层 · 玻璃质感）
//
// 用户要求：「把下落的音符长条做成玻璃质感」。
// 玻璃不是"调半透明"就够了 —— 真实玻璃的读法靠三件事：
//   ① **明亮的边缘**：光在玻璃里折射，边沿比内部亮（这是它区别于"果冻/塑料块"的关键）
//   ② **一条纵向高光**：柱面上的镜面反射，位置略偏左（光从左上来的默认假设）
//   ③ **顶部受光 + 底部增厚**：顶部是光进入的面，底部是厚度累积，压暗一档
// 所以一根音符 = 主体胶囊 + 左右边缘亮线 + 高光条 + 顶/底收口，亮层全部走 lighter 叠加，
// 再交给后处理的泛光去发光（"发光"这件事只由后处理做，图元层不自己画糊）。
//
// 所有部件的 z 用**同一基准 + 小数偏移**，保证一根音符的部件永远连在一起，
// 不会被相邻音符的某一部分插进来（sortPrims 是先层后 z）。
// ============================================================
import { noteStops, withAlpha } from '../state/palette.js';

/** 玻璃主体的不透明度：留一点通透，但不至于看不清（剩下的靠边缘亮线撑住"玻璃"读法） */
const GLASS_BODY = 0.82;

/**
 * 产出**一根**下落音符的全部图元。
 * @param P 图元构造器（scene/primitives.js 的命名空间）
 * @param o { x, y, w, h, color, alpha, radius, depth, velN, gloss, hitY }
 *   x/y/w/h 屏幕像素 · alpha 该音符的不透明度（= 用户滑杆 × 纵深淡出）· hitY 落点线 y（可空）
 */
export function buildNote(P, o) {
  const { x, y, w, h, color } = o;
  const a = Math.max(0, Math.min(1, o.alpha == null ? 1 : o.alpha));
  if (a <= 0.002 || w <= 0 || h <= 0) return [];
  const z0 = o.z || 0;
  const glow = o.gloss !== false;
  const r = Math.max(1.5, Math.min(o.radius == null ? 5 : o.radius, w / 2, h / 2));
  const pr = [];
  // ① 主体：四段渐变（顶部受光 → 中段本色 → 底部增厚压暗）
  pr.push(P.capsule('notes', x, y, w, h, { stops: noteStops(color, { velN: o.velN, gloss: glow }), dir: 'v' },
    { r, alpha: a * GLASS_BODY, z: z0 }));
  if (!glow) return pr;
  // ② 边缘亮线：玻璃最重要的一笔。用 1px 竖线贴着左右边，lighter 叠加 → 边缘比内部亮
  const edgeA = 0.46 + 0.18 * (o.velN == null ? 0.7 : o.velN);
  pr.push(P.line('notes', x + 0.75, y + 1.5, x + 0.75, y + h - 1.5, withAlpha('#ffffff', edgeA * a), { lw: 1.1, blend: 'lighter', z: z0 + 0.1 }));
  pr.push(P.line('notes', x + w - 0.75, y + 1.5, x + w - 0.75, y + h - 1.5, withAlpha('#ffffff', edgeA * 0.78 * a), { lw: 1.1, blend: 'lighter', z: z0 + 0.1 }));
  // ③ 纵向高光条：偏左的镜面反射；宽度随音符宽度走，窄音符就不画（否则整根发白）
  const sw = Math.max(1.2, w * 0.16);
  if (w >= 7) {
    pr.push(P.capsule('notes', x + w * 0.13, y + Math.min(3, h * 0.12), sw, Math.max(2, h - Math.min(6, h * 0.24)),
      withAlpha('#ffffff', 0.22 * a), { r: sw / 2, blend: 'lighter', z: z0 + 0.2 }));
  }
  // ④ 顶部收口（光进入的面，最亮）+ 底部收口（厚度，压暗）
  if (h >= 6) {
    pr.push(P.line('notes', x + r * 0.4, y + 0.8, x + w - r * 0.4, y + 0.8, withAlpha('#ffffff', 0.5 * a), { lw: 1.3, blend: 'lighter', z: z0 + 0.3 }));
    pr.push(P.line('notes', x + r * 0.4, y + h - 1, x + w - r * 0.4, y + h - 1, withAlpha('#000000', 0.26 * a), { lw: 1.2, z: z0 + 0.3 }));
  }
  return pr;
}

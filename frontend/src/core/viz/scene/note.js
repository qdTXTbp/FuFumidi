// ============================================================
// 下落音符（可视化重做 · 场景层 · 玻璃管材质）
//
// 两条线一起管这根音符：
//   ① **透视**：键盘那台相机的横向投影延伸到落点线上方（t<0 = 更远），
//      于是音符上窄下宽、两条侧边与键列方向一致 —— 用户原话「音符还是直的，但是倾斜地下落」，
//      说的就是"键列斜了、音符还是竖直矩形"。现在音符吃同一台相机，落地那条边仍是恒等映射，
//      所以它永远正好落在自己的键列上。
//   ② **玻璃质感**：参考用户给的示例（PianiCast / 霓虹管那类）—— 玻璃管不是"半透明色块"，而是：
//      · 外面一圈柔和光晕（管子在发光）
//      · 亮而清晰的侧边（折射边，最亮的一笔）
//      · 内部一条纵向高光 + 另一侧压暗（圆柱的体积感）
//      · 顶面受光最亮、底面收暗（厚度）
//      亮度层次靠 lighter 叠加，最终由后处理泛光统一发光。
// 所有部件都从**同一个四边形**用双线性插值取点，所以透视怎么变都不会错位。
// ============================================================
import { noteStops, withAlpha, mix } from '../state/palette.js';

/** 玻璃本体的不透明度区间：滑杆（通透度）在这两端之间调 —— 下限是"清玻璃"，上限是"厚玻璃" */
const GLASS_BODY_MIN = 0.16;
const GLASS_BODY_MAX = 0.62;
/** 折射边的颜色：**带音符色调的白**（纯白会是卡通描边，微带本色的白才像玻璃的亮边） */
const rimColor = (c, a) => withAlpha(mix(c, '#ffffff', 0.62), a);

/** 四边形上按 (横比, 纵比) 取点：0..1 在内部，<0 / >1 是向外扩 */
function pt(q, s, t) {
  const xt = q[0] + (q[2] - q[0]) * s, yt = q[1] + (q[3] - q[1]) * s;
  const xb = q[6] + (q[4] - q[6]) * s, yb = q[7] + (q[5] - q[7]) * s;
  return [xt + (xb - xt) * t, yt + (yb - yt) * t];
}
const isAxisAligned = (q) => Math.abs(q[1] - q[3]) < 0.01 && Math.abs(q[5] - q[7]) < 0.01 && Math.abs(q[0] - q[6]) < 0.01 && Math.abs(q[2] - q[4]) < 0.01;
/**
 * 把 pt() 返回的点**摊平**成图元要的 [x0,y0,x1,y1,...]。
 * ★ 踩过的坑：pt() 返回 [x,y]，直接塞进 P.quad 会得到嵌套数组 → 光栅器读到 NaN →
 *   那几个四边形被静默丢弃（表现是"玻璃只剩主体和描边"，光晕/高光全不见）。
 */
const flat4 = (...ps) => ps.reduce((acc, p) => (acc.push(p[0], p[1]), acc), []);

/**
 * 产出一根下落音符的全部图元。
 * @param P 图元构造器（scene/primitives.js 的命名空间）
 * @param o { quad, width, height, color, alpha, radius, velN, gloss, z }
 *   quad = [TLx,TLy, TRx,TRy, BRx,BRy, BLx,BLy]（屏幕像素）；width/height 是**屏幕**上的宽高
 */
export function buildNote(P, o) {
  const q = o.quad;
  // ★ 这里的 alpha 是**玻璃本体的通透度**（滑杆），不是"整根音符的透明度"：
  //   结构层（折射边/高光/顶底收口/光晕）只随它**轻微**减弱，永远不会跟着一起消失 ——
  //   否则滑杆一拉低，画面上就什么都不剩（用户："拉高后整个琴键都不见了，要像玻璃一样"）。
  const a = Math.max(0, Math.min(1, o.alpha == null ? 1 : o.alpha));
  const structA = 0.42 + 0.58 * a;          // 结构层强度：实心时 1.0，最通透时仍有 0.42
  if (!q || a <= 0.002) return [];
  const z0 = o.z || 0;
  const glow = o.gloss !== false;
  const w = o.width, h = o.height;
  if (w <= 0.5 || h <= 0.5) return [];
  const pr = [];
  const flat = isAxisAligned(q);
  const velN = o.velN == null ? 0.7 : o.velN;

  // ① 外光晕：管子周围的柔光。两个要点（都是实测）：
  //   · 要**宽而淡**，窄而浓就成了厚描边；
  //   · 要**两层**才有衰减 —— 单层矩形光晕的边界是硬的，看得出一圈"方框"。
  if (glow) {
    const halo = (grow, alpha, dz) => {
      if (flat) {
        pr.push(P.capsule('notes', q[0] - w * (grow - 1) / 2, q[1] - grow * 1.2, w * grow, h + grow * 2.4,
          withAlpha(o.color, alpha * structA), { r: Math.min(w, h) / 2, blend: 'lighter', z: z0 + dz }));
      } else {
        const gx = (grow - 1) / 2, gy = grow * 0.015;
        pr.push(P.quad('notes', flat4(pt(q, -gx, -gy), pt(q, 1 + gx, -gy), pt(q, 1 + gx, 1 + gy), pt(q, -gx, 1 + gy)),
          withAlpha(o.color, alpha * structA), { blend: 'lighter', z: z0 + dz }));
      }
    };
    halo(1.62, 0.05, -0.06);
    halo(1.28, 0.075, -0.05);
  }
  // ② 主体：**真的透**（透明度滑杆调的就是这个）—— 背景能透过来，才叫玻璃。
  //    玻璃的"实心感"由下面 ③ 的菲涅尔边缘 + 高光撑，而不是靠把本体刷厚。
  const stops = noteStops(o.color, { velN, gloss: glow });
  const bodyA = Math.min(1, GLASS_BODY_MIN + (GLASS_BODY_MAX - GLASS_BODY_MIN) * a);
  if (flat) {
    pr.push(P.capsule('notes', q[0], q[1], w, h, { stops, dir: 'v' },
      { r: Math.max(1.5, Math.min(o.radius == null ? 5 : o.radius, w / 2, h / 2)), alpha: bodyA, z: z0 }));
  } else {
    pr.push(P.quad('notes', q, { stops, dir: 'v' }, { alpha: bodyA, z: z0 }));
  }
  if (!glow) return pr;

  // ②b **菲涅尔边缘环**：这是"玻璃"的核心一笔 —— 光在掠射角处反射最强，所以边缘比中间亮得多。
  //     用横向渐变 [亮, 透, 透, 亮] 一次画出来（中间那两段是透明的），沿左右两侧各一道。
  //     之前几版都是在实心块上叠一条亮线，怎么调都不像玻璃，问题就出在"中间没有真的透"。
  const fres = (0.34 + 0.12 * velN) * structA;
  const fresStops = [withAlpha('#ffffff', fres), withAlpha('#ffffff', 0), withAlpha('#ffffff', 0), withAlpha('#ffffff', fres)];
  if (flat) {
    pr.push(P.rect('notes', q[0], q[1], w, h, { stops: fresStops, dir: 'h' }, { blend: 'lighter', z: z0 + 0.06 }));
  } else {
    pr.push(P.quad('notes', q, { stops: fresStops, dir: 'h' }, { blend: 'lighter', z: z0 + 0.06 }));
  }

  // ③ 内部右侧压暗 + 纵向高光：一暗一亮的两个面 → 圆柱的体积感（参考图里管子的"圆"就是这么来的）
  const shadeA = 0.17 * structA;
  if (flat) pr.push(P.rect('notes', q[0] + w * 0.68, q[1], w * 0.32, h, withAlpha('#000000', shadeA), { z: z0 + 0.05 }));
  else pr.push(P.quad('notes', flat4(pt(q, 0.66, 0), pt(q, 1, 0), pt(q, 1, 1), pt(q, 0.66, 1)), withAlpha('#000000', shadeA), { z: z0 + 0.05 }));
  const hiA = (0.26 + 0.12 * velN) * structA;
  if (flat) pr.push(P.capsule('notes', q[0] + w * 0.1, q[1] + 2, Math.max(1.4, w * 0.26), Math.max(2, h - 4), withAlpha('#ffffff', hiA),
    { r: Math.max(0.6, w * 0.13), blend: 'lighter', z: z0 + 0.1 }));
  else pr.push(P.quad('notes', flat4(pt(q, 0.1, 0.035), pt(q, 0.36, 0.035), pt(q, 0.36, 0.965), pt(q, 0.1, 0.965)), withAlpha('#ffffff', hiA), { blend: 'lighter', z: z0 + 0.1 }));

  // ④ 折射边：玻璃最要紧的一笔，但要**细而克制**（1.1px / 微带本色），
  //    浓白 2px 会变成卡通描边 —— 这是上一版实测的失败点
  // 内壁暗线：玻璃管是有壁厚的 —— 紧贴折射边往里 1px 压一道暗，管子立刻"立"起来
  const wallA = 0.22 * structA;
  const wL0 = pt(q, 0.07, 0.03), wL1 = pt(q, 0.07, 0.97);
  const wR0 = pt(q, 0.93, 0.03), wR1 = pt(q, 0.93, 0.97);
  pr.push(P.line('notes', wL0[0], wL0[1], wL1[0], wL1[1], withAlpha('#000000', wallA), { lw: 1, z: z0 + 0.14 }));
  pr.push(P.line('notes', wR0[0], wR0[1], wR1[0], wR1[1], withAlpha('#000000', wallA), { lw: 1, z: z0 + 0.14 }));
  const edgeA = (0.42 + 0.16 * velN) * structA;
  const eL0 = pt(q, 0.015, 0.015), eL1 = pt(q, 0.015, 0.985);
  const eR0 = pt(q, 0.985, 0.015), eR1 = pt(q, 0.985, 0.985);
  pr.push(P.line('notes', eL0[0], eL0[1], eL1[0], eL1[1], rimColor(o.color, edgeA), { lw: 1.1, blend: 'lighter', z: z0 + 0.15 }));
  pr.push(P.line('notes', eR0[0], eR0[1], eR1[0], eR1[1], rimColor(o.color, edgeA * 0.75), { lw: 1.1, blend: 'lighter', z: z0 + 0.15 }));

  // ⑤ 顶面受光 / 底面收暗（厚度）
  if (h >= 6) {
    const t0 = pt(q, 0.06, 0), t1 = pt(q, 0.94, 0);
    const b0 = pt(q, 0.06, 1), b1 = pt(q, 0.94, 1);
    pr.push(P.line('notes', t0[0], t0[1] + 0.8, t1[0], t1[1] + 0.8, withAlpha('#ffffff', 0.6 * structA), { lw: 1.6, blend: 'lighter', z: z0 + 0.2 }));
    pr.push(P.line('notes', b0[0], b0[1] - 0.8, b1[0], b1[1] - 0.8, withAlpha('#000000', 0.3 * structA), { lw: 1.4, z: z0 + 0.2 }));
  }
  return pr;
}

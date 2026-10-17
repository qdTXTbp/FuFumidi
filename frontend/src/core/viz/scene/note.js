// ============================================================
// 下落音符（可视化重做 · 场景层 · 玻璃管材质 / 2026-10-18 三维玻璃块）
//
// 两条线一起管这根音符：
//   ① **透视**：吃键盘那台相机（scene/keyboard.js）。四边形的每个角都由相机投影产生，
//      两条侧边正好落在键列线的延长线上 —— 用户 2026-10-18：「让下落的音符完全符合透视」。
//      （上一版横向用 1+kz·t、纵向用 1/z，两套公式不是同一台相机，侧边与键列线对不上。）
//   ② **玻璃质感**：参考用户给的示例（PianiCast / 霓虹管那类）—— 玻璃管不是"半透明色块"，而是：
//      · 外面一圈柔和光晕（管子在发光）
//      · 亮而清晰的侧边（折射边，最亮的一笔）
//      · 内部一条纵向高光 + 另一侧压暗（圆柱的体积感）
//      · 顶面受光最亮、底面收暗（厚度）
//      2026-10-18「让 3D 的音符更有玻璃质感」在此之上再加四个**立体**的部件：
//      · 底部斜切面（吸光/暗玻璃）：方块朝向键盘的那一面
//      · 内侧键壁（朝消失点那一侧）：厚度可见，玻璃块才不是一张纸
//      · 顶面高光带 + 顶部亮棱：方块的上表面被灯照到
//      · 横向镜面反光带：真实玻璃的掠射反光，一条横过正面的软亮带
// 所有部件都从**同一个四边形**用双线性插值取点，所以透视怎么变都不会错位。
// ============================================================
import { noteStops, withAlpha, mix, shade } from '../state/palette.js';

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
/** 四边形参数空间里的一块矩形区域 → 顶点数组 */
const band = (q, s0, s1, t0, t1) => flat4(pt(q, s0, t0), pt(q, s1, t0), pt(q, s1, t1), pt(q, s0, t1));

/** 单色渐变（Canvas/WebGL 都支持）：四段同色，避免"一段渐变"在 WebGL 采样里走形 */
const solidStops = (c) => [c, c, c, c];

/**
 * 产出一根下落音符的全部图元。
 * @param P 图元构造器（scene/primitives.js 的命名空间）
 * @param o { quad, width, height, color, alpha, radius, velN, gloss, z, mode3d, vpX }
 *   quad = [TLx,TLy, TRx,TRy, BRx,BRy, BLx,BLy]（屏幕像素）；width/height 是**屏幕**上的宽高
 *   mode3d：开「3D 键盘」+ 透视时才有的三维玻璃块路径（平板模式走原来的玻璃管路径）
 */
export function buildNote(P, o) {
  const q = o.quad;
  const a = Math.max(0, Math.min(1, o.alpha == null ? 1 : o.alpha));
  if (!q || a <= 0.002) return [];
  const w = o.width, h = o.height;
  if (w <= 0.5 || h <= 0.5) return [];
  if (o.mode3d) return buildNote3D(P, o, q, w, h, a);
  return buildNoteFlat(P, o, q, w, h, a);
}

/* ============================================================
 * 三维玻璃块（3D 键盘开启时）
 * ============================================================ */
function buildNote3D(P, o, q, w, h, a) {
  // 这里的 a 是**玻璃本体的通透度**（滑杆）：结构层只随它轻微减弱，永远不会一起消失
  const structA = 0.42 + 0.58 * a;
  const z0 = o.z || 0;
  const glow = o.gloss !== false;
  const velN = o.velN == null ? 0.7 : o.velN;
  const color = o.color;
  const vpX = o.vpX == null ? q[0] : o.vpX;
  const cxq = (q[0] + q[2] + q[4] + q[6]) / 4;
  // 朝消失点的那一侧是"内侧"（厚度看得见的那一面）：键列越往远处越向中心收，所以内侧 = 朝中心那一侧
  const innerS = cxq <= vpX;              // 音符在消失点左边 → 内侧是右边
  const pr = [];

  /* ① 外光晕：玻璃周围的一圈柔光（两层才有衰减，单层矩形的边界是硬的） */
  if (glow) {
    const halo = (grow, alpha, dz) => {
      const gx = (grow - 1) / 2, gy = grow * 0.012;
      pr.push(P.quad('notes', band(q, -gx, 1 + gx, -gy, 1 + gy),
        withAlpha(color, alpha * structA), { blend: 'lighter', z: z0 - 0.06 + dz }));
    };
    halo(1.62, 0.05, 0);
    halo(1.28, 0.075, 0.01);
  }

  /* ② 主体：真的透（透明度滑杆调的就是这个）—— 背景能透过来，才叫玻璃。
     与平板玻璃管共用同一套四段渐变材质，保证"3D 打开"不会把音符变成另一种东西。 */
  const stops = noteStops(color, { velN, gloss: glow });
  const bodyA = Math.min(1, GLASS_BODY_MIN + (GLASS_BODY_MAX - GLASS_BODY_MIN) * a);
  pr.push(P.quad('notes', q, { stops, dir: 'v' }, { alpha: bodyA, z: z0 }));

  let bxF = 0, byF = 0;
  if (glow) {
    /* ③ **倒角（chamfer）**：3D 建模读得出来的关键一笔。四条梯形压在轮廓内侧：
         上/左受光（亮、带本色）· 右/下背光（暗）—— 音符再窄也看得出是一块有厚度的玻璃。
        （先画主体、再把倒角压上去：倒角只覆盖轮廓边缘，所以中间那块仍然透亮，不会发闷。） */
    // ★ 倒角宽度要**跟着音符的尺寸收**：窄音符（十几像素宽）上用 3.4px 倒角，倒角就占了半条音符，
    //   读出来是"一条白框"而不是玻璃。所以既限像素（2.2 / 2.6px）又限比例（<=16% / <=14%）。
    bxF = Math.max(0.055, Math.min(0.16, 2.2 / Math.max(3, w)));
    byF = Math.max(0.03, Math.min(0.14, 2.6 / Math.max(6, h)));
    const sideDark = shade(color, -0.55);
    // 上倒角：受光斜切面（带本色的亮，不用纯白）
    pr.push(P.quad('notes', band(q, 0, 1, 0, byF),
      { stops: [withAlpha(mix(color, '#ffffff', 0.34), 0.52 * structA), withAlpha(mix(color, '#ffffff', 0.12), 0.20 * structA)], dir: 'v' },
      { blend: 'lighter', z: z0 + 0.02 }));
    // 左倒角：次亮（光从左上来）
    pr.push(P.quad('notes', band(q, 0, bxF, byF, 1),
      { stops: [withAlpha(mix(color, '#ffffff', 0.20), 0.26 * structA), withAlpha(color, 0.08 * structA)], dir: 'v' },
      { blend: 'lighter', z: z0 + 0.02 }));
    // 右倒角：背光（压暗）
    pr.push(P.quad('notes', band(q, 1 - bxF, 1, byF, 1), solidStops(withAlpha(sideDark, 0.34 * structA)), { z: z0 + 0.02 }));
    // 下倒角：朝向键盘那一面（最暗，吸光）
    pr.push(P.quad('notes', band(q, 0, 1, 1 - byF, 1),
      { stops: [withAlpha(sideDark, 0.28 * structA), withAlpha(shade(color, -0.72), 0.54 * structA)], dir: 'v' },
      { z: z0 + 0.02 }));
    // 上棱：上倒角与正面的交界线（玻璃的硬亮边）
    const tc0 = pt(q, 0.02, byF), tc1 = pt(q, 0.98, byF);
    pr.push(P.line('notes', tc0[0], tc0[1], tc1[0], tc1[1], withAlpha('#ffffff', 0.32 * structA), { lw: 1, blend: 'lighter', z: z0 + 0.03 }));
  }

  if (!glow) return pr;

  /* ④ 横向镜面反光带（掠射反光）：一条横过正面上部的软亮带 —— 玻璃最有说服力的一笔 */
  const spA = (0.11 + 0.06 * velN) * structA;
  pr.push(P.quad('notes', band(q, 0.05, 0.95, 0.07, 0.26), {
    stops: [withAlpha('#ffffff', 0), withAlpha('#ffffff', spA), withAlpha('#ffffff', spA * 0.6), withAlpha('#ffffff', 0)],
    dir: 'h',
  }, { blend: 'lighter', z: z0 + 0.05 }));

  /* ⑤ 菲涅尔边缘环：光在掠射角反射最强 —— 只亮**边缘**，中间必须真的是透的 */
  const fres = (0.22 + 0.10 * velN) * structA;
  pr.push(P.quad('notes', q, {
    stops: [withAlpha('#ffffff', fres), withAlpha('#ffffff', 0), withAlpha('#ffffff', 0), withAlpha('#ffffff', fres)],
    dir: 'h',
  }, { blend: 'lighter', z: z0 + 0.06 }));

  /* ⑥ 内侧压暗 + 纵向高光：一暗一亮两个面 → 玻璃块也有这种明暗秩序 */
  const shadeA = 0.18 * structA;
  pr.push(P.quad('notes', band(q, innerS ? 0.64 : 0, innerS ? 1 : 0.36, 0, 1),
    solidStops(withAlpha('#000000', shadeA)), { z: z0 + 0.07 }));
  const hiA = (0.20 + 0.10 * velN) * structA;
  pr.push(P.quad('notes', band(q, 0.14, 0.34, 0.03, 0.97), solidStops(withAlpha('#ffffff', hiA)), { blend: 'lighter', z: z0 + 0.08 }));

  /* ⑦ 内芯：玻璃里透出来的光（带本色的白，不是纯白 —— 纯白会把音符推成灯管） */
  const coreA = (0.09 + 0.07 * velN) * structA;
  pr.push(P.quad('notes', band(q, 0.32, 0.68, 0.06, 0.94),
    { stops: [withAlpha(mix(color, '#ffffff', 0.4), 0), withAlpha(mix(color, '#ffffff', 0.4), coreA), withAlpha(mix(color, '#ffffff', 0.4), 0)],
      dir: 'v' }, { blend: 'lighter', z: z0 + 0.09 }));

  /* ⑧ 折射边 + 内壁暗线：玻璃最要紧的一笔，细而克制（1px / 微带本色）。
     浓白 2px 会变成卡通描边 —— 上一版实测的失败点。 */
  const wallA = 0.24 * structA;
  const wL0 = pt(q, 0.08, 0.03), wL1 = pt(q, 0.08, 0.97);
  const wR0 = pt(q, 0.92, 0.03), wR1 = pt(q, 0.92, 0.97);
  pr.push(P.line('notes', wL0[0], wL0[1], wL1[0], wL1[1], withAlpha('#000000', wallA), { lw: 1, z: z0 + 0.10 }));
  pr.push(P.line('notes', wR0[0], wR0[1], wR1[0], wR1[1], withAlpha('#000000', wallA), { lw: 1, z: z0 + 0.10 }));
  const edgeA = (0.44 + 0.14 * velN) * structA;
  const eL0 = pt(q, 0.01, 0.01), eL1 = pt(q, 0.01, 0.99);
  const eR0 = pt(q, 0.99, 0.01), eR1 = pt(q, 0.99, 0.99);
  pr.push(P.line('notes', eL0[0], eL0[1], eL1[0], eL1[1], rimColor(color, edgeA), { lw: 1, z: z0 + 0.11 }));
  pr.push(P.line('notes', eR0[0], eR0[1], eR1[0], eR1[1], rimColor(color, edgeA * 0.65), { lw: 1, z: z0 + 0.11 }));

  /* ⑨ 下棱（撞击面上沿）：光从键面反上来的一条亮线 */
  const b0 = pt(q, 0.04, 1 - byF), b1 = pt(q, 0.96, 1 - byF);
  pr.push(P.line('notes', b0[0], b0[1], b1[0], b1[1],
    withAlpha(mix(color, '#ffffff', 0.32), 0.34 * structA), { lw: 1.1, z: z0 + 0.12 }));
  return pr;
}

/* ============================================================
 * 平板玻璃管（persp=0 / 3D 键盘关掉时）—— 与上一版逐笔一致，保证"关掉就回到旧观感"
 * ============================================================ */
function buildNoteFlat(P, o, q, w, h, a) {
  // ★ 这里的 alpha 是**玻璃本体的通透度**（滑杆），不是"整根音符的透明度"：
  //   结构层（折射边/高光/顶底收口/光晕）只随它**轻微**减弱，永远不会跟着一起消失 ——
  //   否则滑杆一拉低，画面上就什么都不剩（用户："拉高后整个琴键都不见了，要像玻璃一样"）。
  const structA = 0.42 + 0.58 * a;          // 结构层强度：实心时 1.0，最通透时仍有 0.42
  const z0 = o.z || 0;
  const glow = o.gloss !== false;
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
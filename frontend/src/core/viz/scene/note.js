// ============================================================
// 下落音符（可视化重做 · 场景层 · 玻璃管材质 / 2026-10-17 三维玻璃块重构）
//
// 两条线一起管这根音符：
//   ① **透视**：吃键盘那台相机（scene/keyboard.js）。四边形的每个角都由相机投影产生，
//      两条侧边正好落在键列线的延长线上 —— 用户 2026-10-18：「让下落的音符完全符合透视」。
//   ② **玻璃质感**：玻璃管不是"半透明色块"，而是：
//      · 外面一圈柔和光晕（管子在发光）
//      · 亮而清晰的侧边（折射边，最亮的一笔）
//      · 横向的受光/背光渐变（体积感）
//      · 顶面 / 底面（3D 键盘 + 透视时才有：块子的"厚度"）
//
// ★ 2026-10-17 三维玻璃块重构（用户三连：「音符的光影并没有随着透视角度变化」
//   「白色的反光还是太强烈了，喧宾夺主」「音符立体感还不够」）：
//   · **光影跟着相机走**：俯视角 look / 场景光带 bar / 坡道深度 depthT 全部由 compile 从
//     相机算好传进来（见 compile.js 的「光带」段）。顶面高度、底面高度、镜面高光沿音符的
//     位置都随 look 变化 —— 拉「键盘透视」时明暗是真的在表面上滑动，不是形状被拉伸。
//   · **白高光减半**：亮面 = mix(本色,白,0.34)，棱线 = mix(本色,白,0.55)，不再有一大条纯白；
//     玻璃的"亮"来自窄棱 + 小面积高光点（纯白会盖掉音符自己的颜色，喧宾夺主）。
//   · **立体感靠"面"**：顶面（受光梯形，左亮右暗）· 底面（朝键盘，暗）· 左受光面 ·
//     右背光面（横向渐变读出圆角块的体积）· 顶棱/下棱亮线。
// 所有部件都从**同一个四边形**用 pt()/band() 取点，所以透视怎么变都不会错位。
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
/** 单色填充（四段同色）→ **{stops, dir} 对象**。
 * ★ 2026-10-17 修的真 bug：这里以前直接返回数组 [c,c,c,c]，而光栅器只认 fill.stops ——
 *   Canvas2D 那边得到一个没有色标的渐变（等于不画），WebGL2 那边 sampleFill 把"没有 stops"
 *   当白色不透明（[1,1,1,1]）→ 本该是"内侧压暗"的那条夜色四边形被画成**整条纯白**。
 *   用户看到的「白色的反光太强烈了，喧宾夺主」有一半是它。 */
const solidFill = (c) => ({ stops: [c, c, c, c], dir: 'v' });

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
 * 三维玻璃块（3D 键盘 + 透视时）
 *
 * 这一版把"光"从**贴图**变成了**视角相关**的量。compile.js 每帧算好三个数传进来：
 *   look   = 相机俯视角（= 键盘透视 0..1）：越大 = 越从斜上方看
 *   bar    = 场景里一条光带的强度：光带落在坡道上的位置由相机高度决定，
 *            透视滑块一动，光带就沿坡道扫过（被扫到的音符整体更亮、棱更亮）
 *   depthT = 音符在坡道上的深度（0 = 落点线 / 1 = 屏幕最远）
 *
 * 由 look 推出的三个**看得见**的变化（拉滑杆时一眼能看出来）：
 *   · 顶面（端面）越高：越俯视，块子的上表面看得越多  → capH 随 look 变大（0.32 → 1.30 倍）
 *   · 底面越矮：越俯视，朝向键盘的那一面越看不见      → botH 随 look 变小（0.92 → 0.34 倍）
 *   · 镜面高光条在横截面上滑动：hiX 随 look 从 0.22 移到 0.46
 *
 * ★ 立体感 = **面**（不是描边）：四个面各有自己的亮度，而且**面上有硬边界**：
 *     顶面（受光，最亮）> 左受光面 > 正面（玻璃，透）> 右背光面 > 底面（最暗）
 *   透明度按菲涅尔分层：正面中心是透的（玻璃），侧面/端面是"厚料"，几乎不透明 ——
 *   物理上也是如此（掠射角看到更多材料），而且只有这样才能读出"块"的轮廓。
 * ★ 所有亮色都**带本色**（mix(本色,白,0.3~0.6)），不再出现一大条纯白：
 *   上一版 17 层纯白 lighter 叠起来把音符刷成白条（用户：「白色的反光还是太强烈了，喧宾夺主」）。
 * ============================================================ */
function buildNote3D(P, o, q, w, h, a) {
  // 这里的 a 是**玻璃本体的通透度**（滑杆）：结构层只随它轻微减弱，永远不会一起消失
  const structA = 0.42 + 0.58 * a;
  // ★ 三维结构随「键盘透视」平滑淡入（用户 2026-10-18：「从平面状态动一下就会变为高光，没有过渡」）。
  //   ps 0→0.25 之间淡入，之后满强度；flat 态本来就走平板玻璃管，所以这里 0 的时候这些部件全为 0。
  const k3 = Math.max(0, Math.min(1, o.k3d == null ? 1 : Number(o.k3d)));
  if (k3 <= 0.001) return buildNoteFlat(P, o, q, w, h, a);
  // ★ 三维结构整体随 k3d 淡入：滑杆刚离开 0 时只是"微微有厚度"，不是"啪"地变高光
  const fade = k3;
  const clamp01 = (v, d) => { const n = Number(v == null || !isFinite(v) ? d : v); return n < 0 ? 0 : n > 1 ? 1 : n; };
  const z0 = o.z || 0;
  const glow = o.gloss !== false;
  const velN = o.velN == null ? 0.7 : o.velN;
  const color = o.color;
  const pr = [];

  /* ---------- ① 视角（全部由相机算出，见 compile.js） ---------- */
  const look = clamp01(o.look, 0.5);        // 俯视角：0 平视 / 1 从斜上方
  const bar = clamp01(o.bar, 0);            // 光带强度：0 没被照到 / 1 正被扫到
  const depthT = clamp01(o.depthT, 0);      // 坡道深度：0 落点线 / 1 屏幕最远
  // 这条音符吃到的光：被光带扫到更亮、越远越暗
  const lit = (0.86 + 0.34 * bar) * (1 - 0.20 * depthT);
  const ga = structA * lit * fade;

  /* ---------- ② 材质色（亮面/棱线全部带本色） ---------- */
  const cRim = mix(color, '#ffffff', 0.62);     // 棱线（折射亮边）
  const cLit = mix(color, '#ffffff', 0.34);     // 左侧受光面
  const cTop = mix(color, '#ffffff', 0.40);     // 顶面（最亮的面）
  const cGlint = mix(color, '#ffffff', 0.70);   // 镜面高光
  const cDark = shade(color, -0.52);            // 右侧背光面
  const cDeep = shade(color, -0.76);            // 最暗（底棱/背光边）

  /* ---------- ③ 面的几何：端面（上下）+ 侧面（左右），全部视角相关 ---------- */
  const xTL = q[0], xTR = q[2], xBL = q[6], xBR = q[4], yTop = q[1], yBot = q[5];
  const bw = Math.max(3, xBR - xBL);                                    // 屏幕上音符的底宽
  const thMax = Math.max(3, Math.min(12, 0.20 * bw));                   // 端面基准厚度（像素）
  const capH = Math.min(h * 0.30, thMax * (0.32 + 0.98 * look) * (0.92 + 0.18 * bar));
  const botH = Math.min(h * 0.26, thMax * (0.92 - 0.58 * look) * (0.92 + 0.18 * bar));
  const capIn = Math.min(2.4, bw * 0.11);                               // 顶面远端内收
  // 侧面：相机横向扇形（fan ∝ 透视）决定看得到多少侧壁；离画面中心越远，内侧壁越宽
  const cxq = (q[0] + q[2] + q[4] + q[6]) / 4;
  const off = Math.min(1, Math.abs(cxq - (o.vpX == null ? q[0] : o.vpX)) / Math.max(30, w * 4));
  const sideF = Math.min(0.30, Math.max(0.13, 0.13 + 0.12 * look + 0.06 * off));
  const sideW = sideF * bw;                                            // 侧壁宽（像素）
  const sideA = Math.min(1, 0.90 * structA * fade);                     // 侧壁是"厚料"，近乎不透明

  /* ---------- ④ 外光晕：只留一圈很淡的柔光（太强会把硬边糊掉） ---------- */
  if (glow) {
    const halo = (grow, alpha, dz) => {
      const gx = (grow - 1) / 2, gy = grow * 0.012;
      pr.push(P.quad('notes', band(q, -gx, 1 + gx, -gy, 1 + gy),
        withAlpha(color, alpha * structA), { blend: 'lighter', z: z0 - 0.06 + dz }));
    };
    // 强度从"平板玻璃管"那一档线性过渡到三维这一档：ps 刚离开 0 时不会闪一下
    halo(1.62, 0.050 - 0.028 * fade, -0.06);
    halo(1.28, 0.075 - 0.041 * fade, -0.05);
  }

  /* ---------- ⑤ 正面（玻璃本体，真的透） ---------- */
  const stops = noteStops(color, { velN, gloss: glow });
  // 三维路径下正面的玻璃比平板稍实一点：侧面/端面已经是厚料（近乎不透明），
  // 正面太透会让整块读成"雾"而不是"玻璃块"（远端透一点，近端实一点）。
  // 同样随 fade 过渡，保证 ps 从 0 抬起来时观感连续。
  const bodyBase = Math.min(1, GLASS_BODY_MIN + (GLASS_BODY_MAX - GLASS_BODY_MIN) * a);
  const bodyA = Math.min(0.94, bodyBase + 0.14 * fade);
  pr.push(P.quad('notes', q, { stops, dir: 'v' }, { alpha: bodyA, z: z0 }));

  if (!glow) return pr;

  /* ---------- ⑥ 光带扫过的整体提亮（透视滑块一动，这条光带沿坡道扫） ---------- */
  if (bar > 0.03) {
    pr.push(P.quad('notes', q, {
      stops: [withAlpha(mix(color, '#ffffff', 0.30), 0.07 * bar * structA * fade), withAlpha(mix(color, '#ffffff', 0.30), 0.03 * bar * structA * fade)],
      dir: 'v',
    }, { blend: 'lighter', z: z0 + 0.01 }));
  }

  /* ---------- ⑦ 正面明暗：左受光 → 中间透 → 右背光（横向渐变，给正面一点体积） ---------- */
  pr.push(P.quad('notes', band(q, 0.42, 1, 0, 1), {
    stops: [withAlpha(cDark, 0), withAlpha(cDark, 0.16 * ga), withAlpha(cDeep, 0.34 * ga)],
    dir: 'h',
  }, { z: z0 + 0.02 }));

  /* ---------- ⑦b 正面的纵向明暗：上端被顶面反下来的光照亮、下端近键面收紧 ----------
     两个很淡的四边形（一亮一暗），让正面自己也有上下方向的光，而不是一块平色。 */
  pr.push(P.quad('notes', band(q, sideF, 1 - sideF, 0.02, 0.42), {
    stops: [withAlpha(cLit, 0.10 * ga), withAlpha(cLit, 0)],
    dir: 'v',
  }, { blend: 'lighter', z: z0 + 0.035 }));
  pr.push(P.quad('notes', band(q, sideF, 1 - sideF, 0.55, 0.99), {
    stops: [withAlpha(cDeep, 0), withAlpha(cDeep, 0.18 * ga)],
    dir: 'v',
  }, { z: z0 + 0.036 }));

  /* ---------- ⑧ 左侧面（受光）：一道有厚度的亮面 + 硬边界 ---------- */
  pr.push(P.quad('notes', band(q, 0, sideW / bw, 0, 1), {
    stops: [cLit, shade(cLit, -0.30)],
    dir: 'h',
  }, { alpha: sideA, z: z0 + 0.05 }));
  // 正面与侧面的交界棱：块的"转折线"，最亮的一笔（细、带本色、不过曝）
  pr.push(P.line('notes', ...pt(q, sideW / bw, 0.01), ...pt(q, sideW / bw, 0.99),
    withAlpha(cRim, Math.min(1, (0.42 + 0.16 * bar) * ga)), { lw: 1.1, blend: 'lighter', z: z0 + 0.07 }));

  /* ---------- ⑨ 右侧面（背光）：暗面 + 深色收边 ---------- */
  pr.push(P.quad('notes', band(q, 1 - sideW / bw, 1, 0, 1), {
    stops: [cDark, cDeep],
    dir: 'h',
  }, { alpha: sideA, z: z0 + 0.05 }));
  pr.push(P.line('notes', ...pt(q, 1 - sideW / bw, 0.01), ...pt(q, 1 - sideW / bw, 0.99),
    withAlpha(cDeep, Math.min(1, 0.42 * structA * fade)), { lw: 1, z: z0 + 0.06 }));

  /* ---------- ⑩ 镜面高光条：竖直的一条窄光，**横向位置随俯视角滑动**（0.22 → 0.46） ----------
     玻璃管的高光沿管子走；相机高度一变，反射点就在横截面上滑过去 —— 这是"光影随透视变化"最直观的一笔。 */
  const hiX = Math.min(1 - sideW / bw - 0.02, 0.22 + 0.24 * look);
  const hiW = Math.min(0.10, Math.max(0.045, 1.8 / Math.max(4, w)));
  const hiA = (0.26 + 0.12 * bar) * ga;
  pr.push(P.quad('notes', band(q, hiX - hiW, hiX + hiW, 0.03, 0.97), {
    stops: [withAlpha(cGlint, 0), withAlpha(cGlint, hiA), withAlpha(cGlint, 0)],
    dir: 'h',
  }, { blend: 'lighter', z: z0 + 0.08 }));

  /* ---------- ⑪ 内芯：玻璃里透出来的光（低强度、带本色、沿纵向衰减） ---------- */
  const coreC = mix(color, '#ffffff', 0.30);
  const coreA = (0.05 + 0.03 * velN) * ga;
  pr.push(P.quad('notes', band(q, sideW / bw, 1 - sideW / bw, 0.06, 0.94), {
    stops: [withAlpha(coreC, 0), withAlpha(coreC, coreA), withAlpha(coreC, 0)],
    dir: 'v',
  }, { blend: 'lighter', z: z0 + 0.09 }));

  /* ---------- ⑫ 顶面（端面，受光梯形）+ 顶棱 / 交界棱 ----------
     顶面在音符**上沿之外**：轮廓真的变了，才读得出"厚度"。 */
  if (capH > 0.6) {
    const capQ = [xTL + capIn, yTop - capH, xTR - capIn, yTop - capH, xTR, yTop, xTL, yTop];
    pr.push(P.quad('notes', capQ, {
      stops: [cTop, shade(cTop, -0.10), mix(color, '#000000', 0.18), cDark],
      dir: 'h',
    }, { alpha: Math.min(1, (0.94 + 0.06 * bar) * structA * fade), z: z0 + 0.10 }));
    // 顶棱：块子的最高棱，接光最亮的一条线
    pr.push(P.line('notes', xTL + capIn + 0.5, yTop - capH + 0.6, xTR - capIn - 0.5, yTop - capH + 0.6,
      withAlpha(cRim, Math.min(1, (0.52 + 0.18 * bar) * ga)), { lw: 1.2, blend: 'lighter', z: z0 + 0.11 }));
    // 顶面与正面的交界：一道暗棱（倒角的阴影），把"顶面"和"正面"分成两个面
    pr.push(P.line('notes', xTL + 0.5, yTop + 0.4, xTR - 0.5, yTop + 0.4,
      withAlpha(cDeep, Math.min(1, 0.50 * structA * fade)), { lw: 1, z: z0 + 0.105 }));
  }

  /* ---------- ⑬ 底面（朝键盘那一面，最暗） ---------- */
  if (botH > 0.5) {
    const out = Math.min(2.4, bw * 0.11);
    const botQ = [xBL, yBot, xBR, yBot, xBR + out, yBot + botH, xBL - out, yBot + botH];
    pr.push(P.quad('notes', botQ, {
      stops: [cDark, cDeep],
      dir: 'v',
    }, { alpha: Math.min(1, (0.86 + 0.10 * bar) * structA * fade), z: z0 + 0.10 }));
    // 底棱：撞到键面的那条边，光从键面反上来（细亮线）
    pr.push(P.line('notes', xBL - out + 0.5, yBot + botH - 0.6, xBR + out - 0.5, yBot + botH - 0.6,
      withAlpha(cRim, Math.min(1, 0.40 * ga)), { lw: 1.1, blend: 'lighter', z: z0 + 0.12 }));
  }

  /* ---------- ⑭ 正面左右轮廓：细，只负责把块从背景里"切"出来 ---------- */
  pr.push(P.line('notes', ...pt(q, 0.008, 0.02), ...pt(q, 0.008, 0.98),
    withAlpha(cRim, Math.min(1, (0.34 + 0.14 * bar) * ga)), { lw: 1, blend: 'lighter', z: z0 + 0.13 }));
  pr.push(P.line('notes', ...pt(q, 0.992, 0.02), ...pt(q, 0.992, 0.98),
    withAlpha(cDeep, Math.min(1, 0.55 * structA * fade)), { lw: 1, z: z0 + 0.13 }));
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
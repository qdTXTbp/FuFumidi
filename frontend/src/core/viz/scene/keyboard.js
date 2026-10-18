// ============================================================
// 键盘层（可视化重做 · 场景层 · 2026-10-17 推倒重做 / 2026-10-18 三维化）
//
// 这一版的做法：**一台相机**（真正的针孔投影）。
//   场景里每个点用 (u, t, h) 三个量描述：
//     u = 沿键盘的横向位置（像素，与音符列同一个坐标系）
//     t = 深度参数：0 = 远端（音符落点那条边）、1 = 近端（朝向观众）；
//         t<0 = 落点线上方（音符所在的那段"坡道"）
//     h = 抬高（0 = 白键面，1 = 黑键面抬一层）
//   投影：
//     S(t)  = 1 + fan·u(t)           —— 透视缩放（t=0 恒等，越大越近）
//     x     = cx + (u-cx)·S(t)       —— 横向收拢（越远越向消失点靠）
//     y     = wN + faceH·u(t) - h·raise  —— 纵向 1/z 缩短（近端每单位深度占的像素更多）
//   · t=0 恒等：notes 落在哪一列，键就一定在哪一列 —— 对齐是**结构保证**。
//   · u(t) 与 S(t) 来自**同一台相机**：键列线、音符侧边、网格竖线全都收敛到同一个消失点
//     （用户 2026-10-18：「让下落的音符完全符合透视」）。上一版横向用 1+kz·t（线性）、
//     纵向用 1/z（非线性），两者不是同一台相机 —— 音符侧边与键列线对不上。
//   · t<0 段由同一族公式**解析外推**（u(t) 在 t→-∞ 时 → -1/(r-1)，S→0），所以落点线上方
//     的坡道与键盘段 C¹ 连续，且共用同一个消失点，不会出现折角 / 两条不同的透视。
//   · persp=0（或「3D 键盘」关掉）时 fan=0、u(t)=t → 整台相机退化成恒等映射：平板键盘。
//
// 三维化（2026-10-18 用户：「让下落的音符和键盘有 3D 建模」）：
//   · 白键 = 键面 + 前脸（厚度） + 前脸顶棱受光 + 前脸竖向缝；
//   · 黑键 = 抬高面 + 竖直前脸 + 两侧面 + 顶面高光 + 远端亮棱（一个真正的立体键）；
//   · 键面整体再过一层远处压暗 + 近端受光（明度也是深度线索）。
// ============================================================

import { beamQuads } from './effects.js';
import { withAlpha } from '../state/palette.js';

/** 黑键占据白键深度的比例（黑键只铺前半段） */
export const BLACK_T = 0.62;
/** 抬高的黑键在屏幕上抬起的像素（persp 会再放大一点）。
 *  ★ 2026-10-17：3.2 → 9。原来只有 3.2px 厚，黑键看起来是「贴在白键上的一块黑片」
 *  ——用户实测「3D 键盘黑键明显没有侧面」，而且白键的分割线会在键的边缘透出来。
 *  有厚度之后，前脸 + 两侧面把黑键的轮廓完整盖住，才像一排立起来的键。 */
const RAISE_RATIO = 0.075;   // 黑键高出白键的比例（真实钢琴：白键可见长 ~150mm、黑键高出 ~12mm ≈ 8%）
/** 按下时近端下沉的像素（2026-10-17 用户："键盘按键没按压效果"）。
 *  真实琴键是**近端下沉、远端不动**（绕远端转一点点），所以这里改成近端往下。 */
export const PRESS_DIP = 16;
/** 相邻白键之间的防缝重叠（半像素级，避免共享边出现发丝缝） */
const SEAM = 0.35;
/** 透视拉满时，键盘近端相对远端的横向放大比例。
 *  ★ 这个数**不能大**：它同时决定"消失点离画面多远"。fan 一旦接近 faceH/wN（约 0.16），
 *    屏幕顶端就跨过消失点，音符会翻转。0.07 实测：两侧键倾斜约 11°、音符顶部收窄到 0.6 宽，
 *    看得出来是 3D 但不夸张（用户否掉过 0.16 那版的"粗暴拉伸"）。 */
export const PERSP_FAN = 0.07;
/** 坡道外倾角（弧度，透视拉满时）。决定音符"往上走越远"的程度：
 *  0.60 rad ≈ 34° 实测：屏幕顶端音符收窄到 ~0.77、纵向压缩约 12%（看得出纵深，又不至于把
 *  上游音符挤成一堆 —— 之前用"键床平面向上外推"那版到 0.36，顶部密到看不清）。 */
const LEAN_MAX = 0.60;
/** 相机到落点线的深度（相对 wN 的倍数，透视拉满时）。越小 = 广角，坡道收敛越强 */
const Z0_FACTOR = 1.6;
/* ★ 2026-10-18i（用户明确要求）：**键盘不再画任何阴影**。
   之前几版的黑键接触阴影/白键凹槽暗面/键床 AO 全部删除 —— 用户判定为"渲染错误的贴图/光照"。
   只保留：键面本体的明暗渐变（几何受光）、前脸亮棱、极淡的分隔缝。
   统一光源约定仍作用于**键的侧面明暗**（左亮右暗），但不产生任何投影。 */

/**
 * 造一台**针孔相机**。整幅画面（键床 + 落点线上方的坡道）都由它投影。
 *
 * 世界坐标（像素）：
 *   X = u - cx（横向，落点线处与屏幕 1:1）
 *   Y = 高度（0 = 键面，向上为正）
 *   z = 深度（相机在 z=0，落点线在 z=z0）
 * 投影：
 *   S = z0 / z          —— 透视缩放（落点线处恒等）
 *   x = cx + X·S
 *   y = (wN - H) + (H - Y)·S      （H = 相机高度）
 *
 * 三块几何：
 *   ① 键床：水平面 Y=0，z 从 z0（远端/落点线）到 z0-D（近端）→ 深度 t∈[0,1]
 *   ② 音符坡道：从落点线往上、并向外倾斜 lean 角的斜面（所以越高的音符越远、越窄、纵向越压缩）
 *   ③ 抬高（琴键 h）：在键床平面上方
 *
 * ★ 为什么坡道是"倾斜的斜面"而不是"竖直墙"：竖直墙上的音符在针孔相机里**完全不收敛**
 *   （同一 z，S 恒定）—— 上一版为了让它看起来有纵深，只好在横向硬塞一个 1+kz·t 的假投影，
 *   于是音符侧边和键列线收敛到两个不同的消失点（用户 2026-10-18：「让下落的音符完全符合透视」）。
 *   倾斜坡道是**同一个相机**下的真实几何：S 随高度变小，纵向也真的被压缩。
 *
 * @param {{w:number, wN:number, faceH:number, persp:number}} o
 *   w 画布宽 · wN 落点线 y（键盘远端）· faceH 键面长度（像素）· persp 0..1
 */
export function makeKeyboardProjection(o) {
  const { w, wN, faceH } = o;
  const persp = Math.max(0, Math.min(1, Number(o.persp) || 0));
  const cx = w / 2;
  const flat = persp <= 1e-6;
  const fan = PERSP_FAN * persp;              // 键床近端的横向放大比例
  const r = 1 + fan;
  // ★ 2026-10-17（用户：「黑键有点太高了,要符合现实的高度」）：以前固定 10px、透视再加到 18px，
  //   比真实钢琴夸张一倍多。改成按**键面长度**取比例（~7.5%，透视再加一点），
  //   黑键只比白键高薄薄一层 —— 和真实三角钢琴的比例一致。
  const raise = Math.max(3.5, Math.min(11, faceH * RAISE_RATIO)) * (1 + 0.18 * persp);
  // 相机高度：键床在屏幕上正好占 faceH → H·(r-1) = faceH
  const H = flat ? 0 : faceH / fan;
  // 相机到落点线那一层的深度：决定镜头"长焦还是广角"（坡道收敛强度）。
  // 与分辨率绑定（wN 是屏内像素），所以换分辨率观感一致。
  const z0 = flat ? 0 : (Z0_FACTOR * Math.max(1, wN)) / persp;
  const lean = LEAN_MAX * persp;              // 坡道外倾角（0 = 竖直墙）
  const cosL = Math.cos(lean), sinL = Math.sin(lean);
  const kL = flat ? 0 : sinL / z0;            // 坡道：S(s) = 1/(1 + s·kL)
  const horizonY = flat ? -Infinity : wN - H; // 消失点（z→∞）的 y
  const D = flat ? 0 : z0 * fan / r;          // 键床深度（世界像素）

  /** 键床深度 t∈[0,1] → 透视缩放 S（1 = 落点线） */
  const S = (t) => (flat ? 1 : z0 / (z0 - t * D));
  /** 键床深度 t → 归一化深度 u（0=远端, 1=近端），py0 = wN + faceH·u */
  const uOf = (t) => (flat ? t : (S(t) - 1) / fan);
  /** 归一化深度 u → 键床深度 t（u 可以 <0：落点线上方，解析外推） */
  const tOfU = (u) => (flat ? u : (u * r) / (1 + u * fan));
  const px0 = (u, t) => cx + (u - cx) * S(t);
  const py0 = (t) => wN + faceH * uOf(t);

  /** 坡道距离 s（px，落点线以上为正）→ { y, S } */
  const ramp = (s) => {
    if (flat) return { y: wN - s, S: 1 };
    const Ss = 1 / (1 + s * kL);
    return { y: (wN - H) + (H - s * cosL) * Ss, S: Ss };
  };
  /** 屏幕 y → 坡道距离 s（closed form：ramp() 的反函数） */
  const sOf = (y) => {
    if (flat) return wN - y;
    const B = y - wN + H;
    return (H - B) / (cosL + B * kL);
  };

  return {
    persp, fan, r, raise, hCam: H, horizonY, cx, faceH, wN, flat, z0, lean,
    // ---------- 键床平面（键盘层） ----------
    /** 横向：u（键盘坐标，与音符同系）→ 屏幕 x */
    px: px0,
    /** 纵向：键床深度 t 与抬高 h（单位 = raise 的倍数）→ 屏幕 y */
    py: (t, h) => py0(t) - (h || 0) * raise,
    /** 键床深度 t 处的透视缩放（1 = 落点线处恒等） */
    S, uOf,
    /** 键面上一块矩形区域 → 屏幕四边形 [x0,y0, x1,y1, x2,y2, x3,y3]（TL,TR,BR,BL） */
    quad(u0, u1, t0, t1, h) {
      const hh = (h || 0) * raise;
      const yy0 = py0(t0), yy1 = py0(t1);
      return [
        px0(u0, t0), yy0 - hh,
        px0(u1, t0), yy0 - hh,
        px0(u1, t1), yy1 - hh,
        px0(u0, t1), yy1 - hh,
      ];
    },
    /** 竖直面（前脸）：从抬高面下沿落到更低一层，x 与 t 都不变 → 严丝合缝 */
    wall(u0, u1, t, hTop, hBot) {
      const yy = py0(t);
      return [
        px0(u0, t), yy - hTop * raise,
        px0(u1, t), yy - hTop * raise,
        px0(u1, t), yy - hBot * raise,
        px0(u0, t), yy - hBot * raise,
      ];
    },
    /** 远端（落点线）某区间的两个端点 */
    farEdge(u0, u1) { return [px0(u0, 0), py0(0), px0(u1, 0), py0(0)]; },
    nearY: py0(1),
    /** 屏幕 y → 键床深度 t（键床平面的反解；y 越高 t 越负） */
    depthAt(y) { return tOfU((y - wN) / Math.max(1, faceH)); },
    // ---------- 坡道平面（音符 / 网格 / 光效） ----------
    /** 坡道距离 s → 屏幕 y */
    yOf(s) { return ramp(s || 0).y; },
    /** 屏幕 y → 坡道距离 s */
    sOf,
    /** 音符平面在屏幕 y 处的横向缩放（光柱/粒子/网格竖线共用） */
    sN(y) { return ramp(Math.max(-1e6, sOf(y))).S; },
    /** 音符平面上的横向投影：屏幕坐标 x 在高度 y 处 → 投影后的 x */
    pxN(u, y) { return cx + (u - cx) * this.sN(y); },
    /**
     * 下落音符的四边形（TL,TR,BR,BL）。
     * 上下沿就是传入的屏幕 y（横向按该高度的坡道缩放收敛），persp=0 时退化成精确矩形。
     */
    noteQuad(u0, u1, top, bottom) {
      const a = this.sN(top), b = this.sN(bottom);
      return [
        cx + (u0 - cx) * a, top, cx + (u1 - cx) * a, top,
        cx + (u1 - cx) * b, bottom, cx + (u0 - cx) * b, bottom,
      ];
    },
  };
}

/** 屏幕四边形是否退化成一个矩形（用于选择更省更快也更精确的 rect 图元） */
function isRect(q) {
  return Math.abs(q[1] - q[3]) < 0.01 && Math.abs(q[5] - q[7]) < 0.01 && Math.abs(q[0] - q[6]) < 0.01 && Math.abs(q[2] - q[4]) < 0.01;
}

/** 矩形 → rect 图元；否则 → quad 图元。两者用同一组角点，形状完全一致 */
function face(P, layer, q, fill, o) {
  if (isRect(q)) return P.rect(layer, q[0], q[1], q[2] - q[0], q[5] - q[1], fill, o);
  return P.quad(layer, q, fill, o);
}

/**
 * 产出键盘层的全部图元。
 * ctx = { w, wN, faceH, frontH, g, wk0, wk1, persp, kp, keysA, WHITE_MIDI, BLACK_PC,
 *         state: {gv, fv, color} 回调 · fx · ink · shade }
 */
export function buildKeyboard(P, ctx) {
  const { g, wk0, wk1, kp, keysA, WHITE_MIDI, BLACK_PC, fx } = ctx;
  // 相机可以由调用方传入（编译器的音符层要用**同一台**），否则就地新建一台
  const cam = ctx.cam || makeKeyboardProjection({ w: ctx.w, wN: ctx.wN, faceH: ctx.faceH, persp: ctx.persp });
  // 远端压暗 + 近端受光：深度感的一半来自明度（远处更暗），只靠几何是"斜着的平面"
  const lit = (c, t) => {
    if (!ctx.shade || cam.persp <= 0.001) return c;
    return ctx.shade(c, -0.30 * cam.persp * (1 - Math.max(0, Math.min(1, t))));
  };
  const pr = [];
  const bottomY = ctx.wN + ctx.faceH + ctx.frontH;
  // ★ ctx.state(pitch) 有副作用（推进按压弹簧、衰减高亮），**每个 pitch 每帧只能调用一次**，
  //   这里做一层按 pitch 的缓存（白键/黑键各取一次）。
  const stateCache = new Map();
  const stateOf = (pitch) => {
    if (!stateCache.has(pitch)) stateCache.set(pitch, ctx.state(pitch));
    return stateCache.get(pitch);
  };
  /* ★ 2026-10-18j（用户："制作真实光影，而不是像之前一样生硬的"）：
     只用线性渐变画不出"半影"，硬边/单段渐变就是"生硬"的来源。
     这里用 **5 层同心 quad** 叠出近似高斯的衰减：内层小而实、外层大而淡，
     每一层自己再用 4 段 stop（a → 0.55a → 0.18a → 0）做二次软化。
     总不透明度保持在 0.18–0.22 的"淡"区间 —— 真实接触阴影本来就该很淡。 */
  const softShadow = (camS, uu0, uu1, tt, spanT, dx0, dx1, coreA, dy) => {
    const LAYERS = 5;
    const vy = dy || 0;
    for (let k = 0; k < LAYERS; k++) {
      const fr = k / (LAYERS - 1);                       // 0 = 核心, 1 = 最外
      const spread = g * 0.095 * fr;
      const sp = spanT * (0.55 + 0.85 * fr);
      const a = coreA * (1 - 0.80 * fr) / (1 + 1.5 * fr);
      const q = camS.quad(uu0 - spread, uu1 + spread,
        Math.max(0, tt - 0.014 * fr), Math.min(0.97, tt + sp), 0);
      const s0 = dx0 * (0.55 + 0.45 * fr), s1 = dx1 * (0.55 + 0.45 * fr);
      q[0] += s0; q[2] += s0; q[4] += s1; q[6] += s1;
      // ★ 整团影子随键体一起下移（用户："按下去影子要跟着下去，不是压缩"）
      if (vy) { q[1] += vy; q[3] += vy; q[5] += vy; q[7] += vy; }
      pr.push(face(P, 'keyboard', q, {
        stops: [withAlpha('#000000', a), withAlpha('#000000', a * 0.55),
          withAlpha('#000000', a * 0.18), withAlpha('#000000', 0)],
        dir: 'v',
      }, { alpha: keysA, z: 986 + k }));
    }
  };
  // ★ fx.keys3d（面板「3D 键盘」）：管"厚度/侧面/受光"与"按压下沉"。
  //   关掉 = 只要键面的一排平板键，而且**透视也一起关掉**（用户 2026-10-18：
  //   「让键盘透视只在 3D 键盘开启时生效」—— 平板键配倾斜透视本来就是自相矛盾的）。
  const solid = !(ctx.fx && ctx.fx.keys3d === false);
  // 键面顶层的统一受光：远处的键面暗、靠近观众的一侧亮（一块整幅梯形，1 个图元）
  const topFaceAll = cam.quad(-ctx.w * 0.25, ctx.w * 1.25, 0, 1, 0);

  // ---------- 键面整体受光（画在键面之上、黑键之下） ----------
  if (solid) {
    pr.push(face(P, 'keyboard', topFaceAll, {
      stops: [withAlpha('#ffffff', 0), withAlpha('#ffffff', 0.05), withAlpha('#ffffff', 0.12)],
      dir: 'v',
    }, { blend: 'lighter', alpha: keysA, z: 900 }));
  }

  // ---------- 白键 ----------
  for (let i = wk0; i < wk1; i++) {
    const pitch = WHITE_MIDI[i];
    const u0 = (i - wk0) * g - SEAM, u1 = (i - wk0 + 1) * g + SEAM;
    const s = stateOf(pitch);
    /* ★ 按压：远端（t=0，落点线）**绝不许动**，近端往下 dip，前脸同比变矮 ——
       整块键像绕远端转了一点，这才是"按下去"（旧写法是键面缩短，方向反了且只有 3px）。 */
    // ★ 按下量取编译器的**弹簧值 s.prs**（攻 35ms / 松 110ms、略过冲，见 scene/compile.js）：
    //   位移跟着弹簧走才是"按下去"的动画，而不是"啪"地一步到位。
    const pressIn = s.prs == null ? s.gv : s.prs;
    const prs = solid ? Math.max(0, Math.min(1.25, pressIn)) : 0;
    const dip = PRESS_DIP * prs;
    const faceH2 = Math.max(6, ctx.faceH + dip);            // 近端下沉 → 键面变长
    const wallH = Math.max(3, ctx.frontH - dip * 0.85);     // 前脸补偿：整键下沿只降 0.15*dip

    const cam2 = makeKeyboardProjection({ w: ctx.w, wN: ctx.wN, faceH: faceH2, persp: ctx.persp });
    pr.push(face(P, 'keyboard', cam2.quad(u0, u1, 0, 1, 0),
      { stops: [lit(kp.wkTop, 0), kp.wkBot], dir: 'v' }, { alpha: keysA, z: 100 + i }));
    // 前脸：键面近端再往下 frontH（近端最宽，与键面下沿共享同一条边）
    if (solid) {
      const qNear = cam2.quad(u0, u1, 1, 1, 0);
      const wall = [qNear[0], qNear[1], qNear[2], qNear[3], qNear[2], qNear[3] + wallH, qNear[0], qNear[1] + wallH];
      pr.push(face(P, 'keyboard', wall, { stops: [kp.wkFrontTop, kp.wkFrontBot], dir: 'v' }, { alpha: keysA, z: 100 + i }));
      // ★ 三维感的三个小笔触（都是键盘层、都吃同一台相机，所以与键面严丝合缝）：
      //   ① 前脸顶棱受光：白键那条"前沿"亮起来，键才有厚度（平板模式下没有前脸，也就不画）
      pr.push(P.line('keyboard', wall[0], wall[1] + 0.6, wall[2], wall[3] + 0.6,
        withAlpha('#ffffff', 0.34), { lw: 1.4, alpha: keysA, z: 120 + i }));
      /* ★ 2026-10-18d：前脸不再用两条硬黑线 —— 用户指出「白键左侧亮、右边邻键左边缘却突然
         一条黑带，阴影像凭空出现」。改成按统一左上光推导的**两条窄渐变**：
           左侧受光（左壁被照亮）、右侧入暗（右壁背光 + 凹槽遮挡）。 */
      const w3 = Math.max(2, (wall[2] - wall[0]) * 0.22);
      pr.push(face(P, 'keyboard', [wall[0], wall[1], wall[0] + w3, wall[1], wall[0] + w3, wall[5], wall[0], wall[5]], {
        stops: [withAlpha('#ffffff', 0.14), withAlpha('#ffffff', 0.05), withAlpha('#ffffff', 0)],
        dir: 'h',
      }, { alpha: keysA, z: 121 + i, blend: 'lighter' }));
      // 前脸顶棱的软 AO：键面与立面相接处一条 12% 高的极淡渐暗（真实接触暗部，不是硬线）
      const waoH = Math.max(1, (wall[5] - wall[1]) * 0.16);
      pr.push(face(P, 'keyboard', [wall[0], wall[1], wall[2], wall[1], wall[2], wall[1] + waoH, wall[0], wall[1] + waoH], {
        stops: [withAlpha('#000000', 0.10), withAlpha('#000000', 0.03), withAlpha('#000000', 0)],
        dir: 'v',
      }, { alpha: keysA, z: 121 + i }));
      // 按下的那一瞬，前脸（键的立面）亮一档 —— 与下沉同一个弹簧值，所以是渐亮而不是"闪"
      if (prs > 0.02) {
        pr.push(face(P, 'keyboard', wall, '#ffffff', { alpha: 0.10 * prs * keysA, blend: 'lighter', z: 101 + i }));
      }
    }
    // 远端高光：落在音符落点线上，与音符列严格对齐（t=0 恒等）
    const fe = cam.farEdge(u0, u1);
    pr.push(P.line('keyboard', fe[0] + 0.5, fe[1] + 0.5, fe[2] - 0.5, fe[3] + 0.5, kp.wkEdge, { lw: 1, alpha: keysA, z: 200 + i }));
    /* ★ 2026-10-18d：键面之间的凹槽。统一左上光 → 每根键**右缘**是暗面（右邻键挡光），
       左缘是受光亮边；全部用渐变，不用硬线（硬线正是用户说的"凭空出现的黑带"）。
       旧的 wkLine 保留成一条非常淡的中性缝，只负责"看得出是一排键"。 */
    /* ★ 2026-10-18j：键面凹槽的**软 AO**（真实光影，不是硬灰带）。
       左上光 → 左缘受光（几乎看不见的一层亮），右缘被右邻键遮挡（4 段渐变的淡暗）。
       宽度 10% 键宽、最大 0.11 alpha，衰减用 4 段 —— 观感是"边缘渐渐暗下去"，不是一条带。 */
    const gw = Math.max(1.8, g * 0.10);
    pr.push(face(P, 'keyboard', cam.quad(u0, u0 + gw * 0.5, 0.01, 1, 0), {
      stops: [withAlpha('#ffffff', 0.06), withAlpha('#ffffff', 0.03), withAlpha('#ffffff', 0)],
      dir: 'h',
    }, { alpha: keysA, z: 205 + i, blend: 'lighter' }));
    pr.push(face(P, 'keyboard', cam.quad(u1 - gw, u1, 0.01, 1, 0), {
      stops: [withAlpha('#000000', 0), withAlpha('#000000', 0.03),
        withAlpha('#000000', 0.07), withAlpha('#000000', 0.11)],
      dir: 'h',
    }, { alpha: keysA, z: 206 + i }));
    if (kp.wkLine) {
      const xa = cam.px(u0, 0), ya = cam.py(0, 0);
      const xb = cam.px(u0, 1), yb = cam.py(1, 0);
      pr.push(P.line('keyboard', xa, ya + 1, xb, yb, withAlpha(kp.wkLine, 0.45), { lw: 1, alpha: keysA, z: 210 + i }));
    }
    if (s.gv > 0.02) {
      // 光柱从落点线往上洒 → 往上即进入更远的深度，必须跟着键列收拢
      for (const q of beamQuads(P, { cam: cam2, ps: ctx.persp, x: (fe[0] + fe[2]) / 2, yBottom: ctx.wN, w: (fe[2] - fe[0]) * 1.35, h: 40 + 92 * s.gv, color: s.color, alpha: 0.26 * s.gv, z: 0 })) pr.push(q);
      // ★ 白键点亮也必须留在**黑键之下**：黑键立在前排，白键的高光不可能盖住它
      pr.push(face(P, 'keyboard', cam2.quad(u0, u1, 0, 1, 0), s.color, { alpha: s.gv * keysA * 0.85, z: 300 + i }));
    }
    /* ★ 按压阴影（2026-10-18c 用户第二次反馈「阴影问题没有解决」）：
       之前只让**黑键的投影**跟着承影面平移，按下的键本身没有任何阴影变化 ——
       视觉上蓝键像"贴"在键床上，没有陷下去。这里给按下的白键补两层内凹阴影：
         ① 两侧缝：键沉下去后与邻键之间出现暗缝（越深越暗）；
         ② 近端接触阴影：前脸顶棱处一圈暗（键面与立面交接的 AO）。
       都用 prs 做强度，和下沉弹簧同一根曲线，所以是"跟着按"而不是"啪一下"。 */
    /* ★ 2026-10-18h（用户第四次反馈）：**删掉按下键上的灰色渐变**。
       用户原话：「只有被按下的琴键才有影子，形状和位置像渲染错误的贴图和光照」——
       那些内凹渐变被读成瑕疵，不是阴影。按下的反馈改回：下沉几何 + 高亮色 + 前脸微亮。 */
    if (s.fv > 0.02) pr.push(face(P, 'keyboard', cam2.quad(u0, u1, 0, 1, 0), '#ffffff', { alpha: Math.min(0.72, s.fv * (fx.flash || 0)) * keysA, z: 31000 + i }));
    if (pitch % 12 === 0) {
      pr.push(P.text('keyboard', 'C' + (pitch / 12 - 1), cam.px((u0 + u1) / 2, 1) - 12, bottomY - 5, kp.ink, { size: 10, alpha: keysA, z: 4000 + i }));
    }
  }

  // ---------- 黑键（抬高一层：键面 + 竖直前脸 + 两侧面 → 一个立体的键） ----------
  if (fx.blackKeys !== false) {
    for (let i = wk0; i < wk1; i++) {
      const pitch = WHITE_MIDI[i] + 1;
      if (!BLACK_PC.includes(pitch % 12)) continue;
      const u0 = (i - wk0 + 1) * g - 0.35 * g, u1 = u0 + 0.7 * g;
      const s = stateOf(pitch);
      /* ★ 黑键的按压 = **抬起的高度落下去**（它是立在前排的键，不是贴在白键上的黑片）：
         hTop 从 1 落到 1-0.72*prs，键面 / 前脸 / 两侧面全用同一个 hTop，怎么按都不会断开。
         平板模式（keys3d 关）没有厚度可落，就停在白键面上（h=0）。 */
      const pressIn = s.prs == null ? s.gv : s.prs;
      const prs = solid ? Math.max(0, Math.min(1.25, pressIn)) : 0;
      const hTop = solid ? Math.max(0, 1 - 0.72 * prs) : 0;
      const t1 = BLACK_T;
      /* ★ 2026-10-18j：软接触阴影（真实光影版）。黑键抬起的"底面"离白键面有高度，
         光从左上 → 影子落向右下，靠近键底最实、往外迅速散开成半影。
         抬起越高影子越长越淡；按下去（hTop↓）影子收紧、变实。 */
      if (solid) {
        const wL = WHITE_MIDI[i];
        const wR = i + 1 < wk1 ? WHITE_MIDI[i + 1] : null;
        const wLp = stateOf(wL), wRp = wR == null ? null : stateOf(wR);
        const prsW = Math.max(0, Math.min(1.25,
          Math.max(wLp && wLp.prs != null ? wLp.prs : 0, wRp && wRp.prs != null ? wRp.prs : 0)));
        const kk = Math.min(1, Math.max(0, hTop));
        const raise = cam.raise || 6;
        const lean = (0.55 + 0.45 * (1 - kk)) * raise;
        const dx0 = 0.18 * lean;
        const dx1 = dx0 + 0.16 * lean;
        /* ★ 2026-10-18l（用户澄清："应该是压缩而不是跟着下去"）：
           阴影**锚在接触处**（不整体平移）。黑键自己按下去 → 键底离白键面更近，
           影子**变短、变窄、变实**（压缩）；下面的白键按下去 → 承影面远离黑键，
           影子**变长一点点、更淡**（半影变大）。
           两种变化都只动长度/浓度，不动锚点 —— 这就是真实接触阴影的读法。 */
        const frac = 0.16 * (0.62 + 0.38 * kk) * (1 + 0.22 * prsW);
        const alpha = (0.10 + 0.07 * (1 - kk)) * (1 - 0.14 * prsW);
        softShadow(cam, u0, u1, t1, frac, dx0, dx1, alpha, 0);
      }
      // ★ 黑键整层抬到**白键所有元素之上**（白键面 100 / 白键高光 300 / 白键闪光 310）。
      //   黑键是立在前排的键，白键的高光或闪光都不该盖住它 —— 用户实测反馈过这一条。
      pr.push(face(P, 'keyboard', cam.quad(u0, u1, 0, t1, hTop),
        { stops: [lit(kp.bkTop, 0), kp.bkBot], dir: 'v' }, { alpha: keysA, z: 1000 + i }));
      if (solid) {
        // 前脸（近端竖直面：从抬高面落到白键面）
        pr.push(face(P, 'keyboard', cam.wall(u0, u1, t1, hTop, 0),
          { stops: [kp.bkFrontTop, kp.bkFrontBot], dir: 'v' }, { alpha: keysA, z: 1000 + i }));
        /* ★ 两侧面（2026-10-17 用户："黑键明显没有侧面"）：
           相机横向收敛（fan>0），偏离画布中心的键一定看得见朝中心那一侧的键壁。
           没有这两面，黑键只是一块贴在白键上的黑片 —— 白键的分割线也会从它的边缘透出来。
           两侧面的几何都用 cam.py(t, 1)/cam.py(t, 0)：正好落在抬高面下沿与白键面之间，
           与键面、前脸共享同一条边，不会浮空也不会断开。 */
        /* ★ 2026-10-18d：侧壁明暗按**统一光源**（左上入射）分：左侧壁受光、右侧壁入暗。
           旧写法按「朝画布中心」选亮面 —— 那是按相机位置推的，和黑键投影/白键凹槽的光向
           对不上，画面里就会出现互相打架的明暗（用户实测反馈）。 */
        for (const ue of [u0, u1]) {
          const sideQ = [
            cam.px(ue, 0), cam.py(0, hTop),
            cam.px(ue, t1), cam.py(t1, hTop),
            cam.px(ue, t1), cam.py(t1, 0),
            cam.px(ue, 0), cam.py(0, 0),
          ];
          const fill = ue === u0 ? { stops: [kp.bkTop, kp.bkFrontBot], dir: 'v' } : kp.bkFrontBot;
          pr.push(face(P, 'keyboard', sideQ, fill, { alpha: keysA, z: 1040 + i }));
        }
        // 顶面受光：左上光 → 顶面左侧亮、右侧衰减（与影子落向右下一致）
        pr.push(face(P, 'keyboard', cam.quad(u0, u1, 0, t1, hTop), {
          stops: [withAlpha('#ffffff', 0.15), withAlpha('#ffffff', 0.10), withAlpha('#ffffff', 0.02)],
          dir: 'h',
        }, { blend: 'lighter', alpha: keysA, z: 1020 + i }));
        // 远端亮棱：抬高面与落点线相接的那条边（键的"后沿"），一条亮线把键从背景里拔起来
        const feB = [cam.px(u0, 0), cam.py(0, hTop), cam.px(u1, 0), cam.py(0, hTop)];
        pr.push(P.line('keyboard', feB[0] + 1, feB[1] + 0.6, feB[2] - 1, feB[3] + 0.6,
          withAlpha('#ffffff', 0.22), { lw: 1.1, alpha: keysA, z: 1021 + i }));
        // 受光侧壁亮边：左壁与白键面交接处的受光亮边（有它侧面才不是一块死黑）
        pr.push(P.line('keyboard', cam.px(u0, 0), cam.py(0, hTop), cam.px(u0, t1), cam.py(t1, hTop),
          withAlpha('#ffffff', 0.12), { lw: 1, alpha: keysA, z: 1041 + i }));
      }
      if (s.gv > 0.02) pr.push(face(P, 'keyboard', cam.quad(u0, u1, 0, t1, hTop), s.color, { alpha: s.gv * keysA, z: 1100 + i }));
      if (s.fv > 0.02) pr.push(face(P, 'keyboard', cam.quad(u0, u1, 0, t1, hTop), '#ffffff', { alpha: Math.min(0.6, s.fv * (fx.flash || 0)) * keysA, z: 1110100 + i }));
      if (fx.keyNames && (u1 - u0) >= 14) {
        const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        pr.push(P.text('keyboard', NN[pitch % 12] + (Math.floor(pitch / 12) - 1),
          (cam.px(u0, t1) + cam.px(u1, t1)) / 2, bottomY - 20, kp.ink, { size: 9, align: 'center', alpha: keysA, z: 4100 + i }));
      }
    }
  }
  return { prims: pr, cam };
}

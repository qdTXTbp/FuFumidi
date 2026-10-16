// ============================================================
// 键盘层（可视化重做 · 场景层 · 2026-10-17 推倒重做）
//
// 上一版为什么被否（用户原话：「粗暴的拉伸」「一塌糊涂，被割裂了」）：
//   ① 透视只作用在**键面的上边**（音符落点那条边），下边和前脸不动 ——
//      越靠画布边缘，键面越窄于音符列，键与音符错位；而前脸还是方矩形，一块键被拆成两半。
//   ② 高亮/闪光叠加层用**矩形**画，键面在透视下是四边形 —— 叠加层盖不住键，缝隙更明显。
//   ③ 数组圆角 r:[0,0,4,4] 在 WebGL 路径被打包成 NaN，SDF 退化成整块"药丸"（上下都圆），
//      与下方的方前脸彻底断开 —— 这是"割裂"最直接的来源（已在光栅层修掉）。
//
// 这一版的做法：**一台相机**。
//   键盘被建模成"键床平面 + 键的抬高"，任何几何都过同一个 project(u, t, h)：
//     u = 沿键盘的横向位置（像素，与音符列同一个坐标系）
//     t = 深度 0..1（0 = 远端/音符落点那条边，1 = 近端/朝向观众）
//     h = 抬高（0 = 白键面，1 = 黑键面抬高一层）
//   · t=0 恒等：notes 落在哪一列，键就一定在哪一列 —— 对齐是**结构保证**，不是调参调出来的。
//   · 近大远小：横向放大因子 (1 + kz·t)，纵向用 1/z 插值做透视缩短（远端更密）。
//   · 黑键 = 同一条 t 上的抬高面 + 一条竖直的前脸（高度恰好是抬升量）→ 永远不会浮空。
//   · 高亮/闪光/标签全部复用同一个 quad()，因此与键面**逐像素重合**。
// persp=0 时整台相机退化成恒等映射 → 平面键盘（与旧观感完全一致，可随时退回）。
// ============================================================

import { beamQuads } from './effects.js';

/** 黑键占据白键深度的比例（黑键只铺前半段） */
export const BLACK_T = 0.62;
/** 抬高的黑键在屏幕上抬起的像素（persp 会再放大一点）。
 *  ★ 2026-10-17：3.2 → 9。原来只有 3.2px 厚，黑键看起来是「贴在白键上的一块黑片」
 *  ——用户实测「3D 键盘黑键明显没有侧面」，而且白键的分割线会在键的边缘透出来。
 *  有厚度之后，前脸 + 两侧面把黑键的轮廓完整盖住，才像一排立起来的键。 */
const RAISE_BASE = 9;
/** 按下时近端下沉的像素（2026-10-17 用户："键盘按键没按压效果"）。
 *  旧实现是 `faceH - 3*s.gv`：① 幅度太小（键面 86px 时只占 3.5%）
 *  ② **方向反了** —— 近端上移 = 键"变短了"，读起来不像被按下去。
 *  真实琴键是**近端下沉、远端不动**（绕远端转一点点），所以这里改成近端往下。 */
export const PRESS_DIP = 11;
/** 相邻白键之间的防缝重叠（半像素级，避免共享边出现发丝缝） */
const SEAM = 0.35;
/** 音符能取到的最大深度（再高就截住，避免收拢过度变成一根线） */
const DEPTH_MAX = 8;

/**
 * 造一台键盘相机。返回的 px/py/quad 就是全部几何来源。
 * @param {{w:number, wN:number, faceH:number, persp:number}} o
 *   w 画布宽 · wN 落点线 y（键盘远端）· faceH 键面长度（像素）· persp 0..1
 */
export function makeKeyboardProjection(o) {
  const { w, wN, faceH } = o;
  const persp = Math.max(0, Math.min(1, Number(o.persp) || 0));
  const cx = w / 2;
  // 横向放大要**克制**：它是"扇形张开"，放大了两侧的键会被推得极斜（第一版 1.15×persp 实测就是这样，
  // 用户读成"粗暴的拉伸"）。真正的深度感主要来自**纵向透视缩短**与远端压暗，所以两者分开：
  // 横向扇形必须很小：它是"整块平面朝画布中心张开"，单键虽窄、位移却是"到中心的距离×kz"，
  // 0.30 实测仍让两侧黑键斜成 45°（用户读成"粗暴的拉伸"）。真实相机的横向收敛在这个尺寸下就该是几度。
  const kz = persp * 0.07;              // 横向收敛：位移 = (到画布中心的距离)×kz。键深只有 ~50px，
                                        // 0.04 时键只斜 5°、240px 高的音符几乎看不出收拢（用户："音符还是直的"）；
                                        // 0.07 对应键约 11°、音符剪切约 28px —— 看得出来但不夸张。
                                        // （0.16 那次之所以"粗暴"，主因是纵向映射写反了，不是这个系数）
  const raise = RAISE_BASE + 5 * persp;
  // 纵向透视缩短：**近端占的像素多、远端少**（相机在斜上方俯视）。
  // 用 1/z 的精确形式：u(t) = (1 - 1/(1+(r-1)t)) / (1 - 1/r)，u(0)=0、u(1)=1、近端导数更大。
  // ★ 上一版写成 t*(1+k)/(1+k*t) 恰好是反的（远端被拉长、近端被压扁）—— 记一次。
  // t=0 是**远端**（落点线）、t=1 是近端；深度 z 从 r（远）线性变到 1（近），
  // 屏幕位置 ∝ 1/z → 近端每单位 t 占的像素更多（这才是俯视相机）。
  const r = 1 + persp * 0.9;
  const uOf = (t) => {
    if (r <= 1.001) return t;
    const z = r - (r - 1) * t;
    return (1 / z - 1 / r) / (1 - 1 / r);
  };
  const py0 = (t) => wN + faceH * uOf(t);
  const px0 = (u, t) => cx + (u - cx) * (1 + kz * t);
  return {
    persp, kz, raise,
    /** 横向：u（键盘坐标，与音符同系）→ 屏幕 x */
    px: px0,
    /** 纵向：深度 t 与抬高 h → 屏幕 y */
    py: (t, h) => py0(t) - (h || 0) * raise,
    /** 键面上一块矩形区域 → 屏幕四边形 [x0,y0, x1,y1, x2,y2, x3,y3]（TL,TR,BR,BL） */
    quad(u0, u1, t0, t1, h) {
      const hh = h || 0;
      return [
        px0(u0, t0), py0(t0) - hh * raise,
        px0(u1, t0), py0(t0) - hh * raise,
        px0(u1, t1), py0(t1) - hh * raise,
        px0(u0, t1), py0(t1) - hh * raise,
      ];
    },
    /** 竖直面（前脸）：从抬高面下沿落到更低一层，x 与 t 都不变 → 严丝合缝 */
    wall(u0, u1, t, hTop, hBot) {
      return [
        px0(u0, t), py0(t) - hTop * raise,
        px0(u1, t), py0(t) - hTop * raise,
        px0(u1, t), py0(t) - hBot * raise,
        px0(u0, t), py0(t) - hBot * raise,
      ];
    },
    /** 远端（落点线）某区间的两个端点 */
    farEdge(u0, u1) { return [px0(u0, 0), py0(0), px0(u1, 0), py0(0)]; },
    nearY: py0(1),
    /**
     * 音符所在深度：落点线（t=0）以上为负，越高越远。
     * 用**线性深度**而不是 1/z 反解 —— 1/z 在落点线上方约 2.1 个键长处就会出现 z≤0 的奇点，
     * 而屏幕上大部分音符都超过那个距离。线性深度在那里仍然良定义，且与键盘 t∈[0,1] 段完全一致。
     */
    /**
     * 音符所在深度：落点线（t=0）以上为负，越高越远。
     * ★★ 落点线上方**不能线性外推再截断**（2026-10-17 用户实测）：
     *   旧写法把 t 夹在 [-8, 1]，于是距落点线 8 个键长（约 400px）处斜率**突然归零** ——
     *   画面上就是「上游音符直着落下、往下突然变成斜的」那道折角。
     *   现在改成**渐近**：t(d) = -FAR_D·(1 - e^{d/FAR_D})（d = 屏幕距离/键长，上方为负）。
     *   · d=0 处 t=0、导数=1 —— 与键盘段 t=d（0..1）**斜率连续**，交界处看不出接缝；
     *   · d 越负越接近 -FAR_D（-4），横向缩放最低 1+kz·(-4)=0.72，永不反转、也不会收成一根线；
     *   · 全程 C¹ 连续，所以音符两侧的斜度随高度平滑变化，没有折角。
     */
    depthAt(y) {
      const d = (y - wN) / Math.max(1, faceH);
      if (d >= 0) return Math.min(1, d);
      const FAR_D = 4;
      return -FAR_D * (1 - Math.exp(d / FAR_D));
    },
    /**
     * 下落音符的四边形（TL,TR,BR,BL）：横向按深度收拢向消失点，纵向就是屏幕上下沿。
     * persp=0 时 px 恒等 → 退化成精确的竖直矩形（与旧观感一致）。
     */
    noteQuad(u0, u1, top, bottom) {
      const tT = this.depthAt(top), tB = this.depthAt(bottom);
      return [
        px0(u0, tT), top, px0(u1, tT), top,
        px0(u1, tB), bottom, px0(u0, tB), bottom,
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
  const kz = cam.kz;
  // 远端压暗：深度感的一半来自明度（远处更暗），只靠几何是"斜着的平面"
  const farDark = (c) => (cam.persp > 0.001 && ctx.shade ? ctx.shade(c, -0.22 * cam.persp) : c);
  const pr = [];
  const bottomY = ctx.wN + ctx.faceH + ctx.frontH;
  // ★ fx.keys3d（面板「3D 键盘」）：管"厚度"与"按压下沉"。关掉 = 只要键面的一排平板键
  //   （上一版这个开关在渲染层根本没人读 —— 和 gloss 一样是死控件，实测过）
  const solid = !(ctx.fx && ctx.fx.keys3d === false);

  // ---------- 白键 ----------
  for (let i = wk0; i < wk1; i++) {
    const pitch = WHITE_MIDI[i];
    const u0 = (i - wk0) * g - SEAM, u1 = (i - wk0 + 1) * g + SEAM;
    const s = ctx.state(pitch);
    /* ★ 按压：远端（t=0，落点线）**绝不许动**，近端往下 dip，前脸同比变矮 ——
       整块键像绕远端转了一点，这才是"按下去"（旧写法是键面缩短，方向反了且只有 3px）。 */
    // ★ 起手要软（2026-10-17 用户："按压效果太生硬"）：直接跟 gv 线性走，按下瞬间就"啪"地沉 11px。
    //   pow(1.6) 让下压由轻到重（松手时 gv 本身平滑衰减），幅度也不再是瞬间到位。
    const prs = solid ? Math.pow(Math.max(0, Math.min(1, s.gv)), 1.6) : 0;
    const dip = PRESS_DIP * prs;
    const faceH2 = Math.max(6, ctx.faceH + dip);            // 近端下沉 → 键面变长
    const wallH = Math.max(3, ctx.frontH - dip * 0.85);     // 前脸补偿：整键下沿只降 0.15*dip

    const cam2 = makeKeyboardProjection({ w: ctx.w, wN: ctx.wN, faceH: faceH2, persp: ctx.persp });
    pr.push(face(P, 'keyboard', cam2.quad(u0, u1, 0, 1, 0),
      { stops: [farDark(kp.wkTop), kp.wkBot], dir: 'v' }, { alpha: keysA, z: 100 + i }));
    // 前脸：键面近端再往下 frontH（近端最宽，与键面下沿共享同一条边）
    if (solid) {
      const qNear = cam2.quad(u0, u1, 1, 1, 0);
      pr.push(face(P, 'keyboard', [
        qNear[0], qNear[1], qNear[2], qNear[3], qNear[2], qNear[3] + wallH, qNear[0], qNear[1] + wallH,
      ], { stops: [kp.wkFrontTop, kp.wkFrontBot], dir: 'v' }, { alpha: keysA, z: 100 + i }));
    }
    // 远端高光：落在音符落点线上，与音符列严格对齐（t=0 恒等）
    const fe = cam.farEdge(u0, u1);
    pr.push(P.line('keyboard', fe[0] + 0.5, fe[1] + 0.5, fe[2] - 0.5, fe[3] + 0.5, kp.wkEdge, { lw: 1, alpha: keysA, z: 200 + i }));
    // 白键分隔线：沿投影方向从远端拉到近端（主题里的 wkLine 之前一直是死数据）
    // 有了它，键盘才"是一排键"而不是一块灰板 —— 尤其在透视下。
    if (kp.wkLine) {
      const xa = cam.px(u0, 0), ya = cam.py(0, 0);
      const xb = cam.px(u0, 1), yb = cam.py(1, 0);
      pr.push(P.line('keyboard', xa, ya + 1, xb, yb, kp.wkLine, { lw: 1, alpha: keysA, z: 210 + i }));
    }
    if (s.gv > 0.02) {
      // 光柱从落点线往上洒 → 往上即进入更远的深度，必须跟着键列收拢（用户："击键光柱也要受透视影响"）
      for (const q of beamQuads(P, { cam: cam2, ps: ctx.persp, x: (fe[0] + fe[2]) / 2, yBottom: ctx.wN, w: (fe[2] - fe[0]) * 1.35, h: 40 + 92 * s.gv, color: s.color, alpha: 0.26 * s.gv, z: 0 })) pr.push(q);
      // ★ 白键点亮也必须留在**黑键之下**：黑键立在前排，白键的高光不可能盖住它
      //   （用户实测「亮起的白键特效压住了黑键」—— 旧 z=2000 越过了黑键的 z=100）。
      pr.push(face(P, 'keyboard', cam2.quad(u0, u1, 0, 1, 0), s.color, { alpha: s.gv * keysA * 0.85, z: 300 + i }));
    }
    if (s.fv > 0.02) pr.push(face(P, 'keyboard', cam2.quad(u0, u1, 0, 1, 0), '#ffffff', { alpha: Math.min(0.72, s.fv * (fx.flash || 0)) * keysA, z: 31000 + i }));
    if (pitch % 12 === 0) {
      pr.push(P.text('keyboard', 'C' + (pitch / 12 - 1), cam.px((u0 + u1) / 2, 1) - 12, bottomY - 5, kp.ink, { size: 10, alpha: keysA, z: 4000 + i }));
    }
  }

  // ---------- 黑键（抬高一层：键面 + 竖直前脸，两者共享边） ----------
  if (fx.blackKeys !== false) {
    for (let i = wk0; i < wk1; i++) {
      const pitch = WHITE_MIDI[i] + 1;
      if (!BLACK_PC.includes(pitch % 12)) continue;
      const u0 = (i - wk0 + 1) * g - 0.35 * g, u1 = u0 + 0.7 * g;
      const s = ctx.state(pitch);
      /* ★ 黑键的按压 = **抬起的高度落下去**（它是立在前排的键，不是贴在白键上的黑片）：
         hTop 从 1 落到 1-0.8*prs，键面 / 前脸 / 两侧面全用同一个 hTop，怎么按都不会断开。
         平板模式（keys3d 关）没有厚度可落，就停在白键面上（h=0）——
         这里原先恒为 1，于是平板模式下黑键会浮在白键上方 9px。 */
      // 与白键同一条软化曲线；黑键落 55% 的抬起量（原来 80% 太"砸"）
      const prs = solid ? Math.pow(Math.max(0, Math.min(1, s.gv)), 1.6) : 0;
      const hTop = solid ? 1 - 0.55 * prs : 0;
      const t1 = BLACK_T;
      // ★ 黑键整层抬到**白键所有元素之上**（白键面 100 / 白键高光 300 / 白键闪光 310）。
      //   黑键是立在前排的键，白键的高光或闪光都不该盖住它 —— 用户实测反馈过这一条。
      pr.push(face(P, 'keyboard', cam.quad(u0, u1, 0, t1, hTop),
        { stops: [kp.bkTop, kp.bkBot], dir: 'v' }, { alpha: keysA, z: 1000 + i }));
      if (solid) {
        // 前脸（近端竖直面：从抬高面落到白键面）
        pr.push(face(P, 'keyboard', cam.wall(u0, u1, t1, hTop, 0),
          { stops: [kp.bkFrontTop, kp.bkFrontBot], dir: 'v' }, { alpha: keysA, z: 1000 + i }));
        /* ★ 两侧面（2026-10-17 用户："黑键明显没有侧面"）：
           相机横向收敛（kz>0），偏离画布中心的键一定看得见朝中心那一侧的键壁。
           没有这两面，黑键只是一块贴在白键上的黑片 —— 白键的分割线也会从它的边缘透出来。
           两侧面的几何都用 cam.py(t, 1)/cam.py(t, 0)：正好落在抬高面下沿与白键面之间，
           与键面、前脸共享同一条边，不会浮空也不会断开。
           看得见的那面（朝画布中心）走 bkTop→bkFrontBot 渐变当受光侧壁，背面用最暗色收边。 */
        const faceCenter = (u0 + u1) / 2;
        const near = faceCenter < ctx.w / 2 ? u1 : u0;
        for (const ue of [u0, u1]) {
          const sideQ = [
            cam.px(ue, 0), cam.py(0, hTop),
            cam.px(ue, t1), cam.py(t1, hTop),
            cam.px(ue, t1), cam.py(t1, 0),
            cam.px(ue, 0), cam.py(0, 0),
          ];
          const fill = ue === near ? { stops: [kp.bkTop, kp.bkFrontBot], dir: 'v' } : kp.bkFrontBot;
          pr.push(face(P, 'keyboard', sideQ, fill, { alpha: keysA, z: 1040 + i }));
        }
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

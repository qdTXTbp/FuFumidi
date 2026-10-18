// ============================================================
// 每帧编译：状态 → Primitive[]（可视化重做 · 场景层）
//
// 旧实现把这六件事写在一个 520 行函数里，任何"整层"的需求（琴键透明、只显按键、
// 按层调强度）都只能靠逐个补乘 globalAlpha 打补丁。这里改成**先出图元、再交给光栅器**：
//   · 每一层（background/notes/impact/keyboard/particles/overlay）自己生成图元
//   · 层的开关与透明度是**数据**（opts.layers / fx.keysAlpha…）
//   · 每类图元带 budgetKey，按类别设上限（对标 MIDViz 的 per-node Max Items）
//
// 几何与裁剪沿用 core/viz.js（timeline/layout 的唯一来源），不重复实现：
//   buildVizBlocks / visibleRange / ensurePm / WHITE_MIDI / pitchGeom / whiteIndexOf / noise
// ============================================================
import { buildVizBlocks, visibleRange, ensurePm, WHITE_MIDI, whiteIndexOf, pitchGeom, noise, BLACK_PC } from '../../viz.js';
import { resolveTheme } from '../state/themes.js';
import { noteColorOf } from '../state/colors.js';
import { withAlpha, noteStops, shade } from '../state/palette.js';
import * as P from './primitives.js';
import { buildNote } from './note.js';
import { projectX, depthScale, beamQuads, keyRipple } from './effects.js';
import { buildKeyboard, makeKeyboardProjection } from './keyboard.js';
import { rampLight, lightAt } from './light.js';

const DEFAULT_BUDGET = { spark: 420, ring: 60, beam: 90 };

export function createCompiler() {
  const state = {
    songRef: null, byPitch: new Map(), centerPitch: 60,
    lastD: -1, seed: 0, hitPulse: 0,
    parts: [], keyGlow: new Map(), keyFlash: new Map(),
    press: new Map(),        // 每键"按下量"包络（见下面 state()）——琴键下沉/落高度跟它走
  };

  /** 粒子更新（物理），返回存活的粒子；预算按 kind 裁剪 */
  function stepParts(prims, budget, cam, ps) {
    const alive = [];
    let spark = 0, ring = 0, beam = 0;
    for (const p of state.parts) {
      if (p.kind === 1) { p.r += p.vr; p.vr *= 0.94; p.life -= p.decay; }
      else if (p.kind === 2) { p.y -= 2.6; p.life -= p.decay; }
      else { p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy += 0.16; p.life -= p.decay; }
      if (p.life <= 0) continue;
      // ★ 粒子会往上飘 → 位置与尺寸都要按所在高度取深度投影，否则"键斜了、粒子还是直的"（用户点名）
      const pxs = projectX(cam, ps, p.x, p.y);
      const kd = depthScale(cam, ps, p.y);
      if (p.kind === 1) { if (++ring > budget.ring) continue; prims.push(P.ring('particles', pxs, p.y, p.r * kd, (1 + 2 * p.life) * kd, p.color, { alpha: p.life * 0.5, blend: 'lighter' })); }
      else if (p.kind === 2) {
        if (++beam > budget.beam) continue;
        for (const q of beamQuads(P, { cam, ps, x: p.x, yBottom: p.y, w: p.w * kd, h: p.h, color: p.color, alpha: 0.4 * p.life, z: 0 })) prims.push(q);
      } else {
        if (++spark > budget.spark) continue;
        /* ★ 用户决策三②：粒子运动模糊拖尾。沿速度反方向留 2 段更淡的残影，
           60–100ms 内随 life 一起消散 —— 单个光点是"闪光"，带拖尾才是"喷射"。 */
        for (let ti = 2; ti >= 1; ti--) {
          const bx = p.x - p.vx * ti * 2.6;
          const by = p.y - p.vy * ti * 2.6;
          const bpx = projectX(cam, ps, bx, by);
          const bkd = depthScale(cam, ps, by);
          prims.push(P.glow('particles', bpx, by, 0,
            p.size * (0.30 + p.life * 0.35) * bkd * (1 - 0.22 * ti),
            p.color, { alpha: p.life * (ti === 1 ? 0.34 : 0.16), blend: 'lighter' }));
        }
        prims.push(P.glow('particles', pxs, p.y, 0, p.size * (0.45 + p.life * 0.55) * kd, p.color, { alpha: p.life, blend: 'lighter' }));
      }
      alive.push(p);
    }
    state.parts = alive;
    return prims;
  }

  function compile(song, tick, opts = {}) {
    const w = opts.w || 960, h = opts.h || 540;
    const theme = resolveTheme(opts.theme || 'studio');
    const fx = opts.fx || {};
    const pr = [];
    const keysOn = fx.keysOn !== false;
    // 琴键不再有独立的不透明度滑杆（用户要求去掉）：要么整层显示，要么整层不显示。
    // 音符的不透明度改由 fx.noteAlpha 管（见下），两者不再互相牵连。
    const keysA = keysOn ? 1 : 0;
    const noteAlpha = Math.max(0, Math.min(1, fx.noteAlpha == null ? 1 : Number(fx.noteAlpha)));
    const parts = Object.assign({}, DEFAULT_BUDGET, opts.budget || {});

    // ---------- 几何 ----------
    // ★ 用户决策三①：落点线（判定线）放在屏幕底部往上 **14%**（规范 10–15%），
    //   给玩家留出视觉反应空间；键盘区就是这 14%。
    const x = Math.min(110, Math.round(0.14 * h));
    const wN = h - x;                        // 键线 y
    let d = 0, tempo = (song && song.initialBpm) || 120, sig = { num: 4 };
    if (song) {
      d = song.baseSec ? song.baseSec(tick) : 0;
      const tm = song.tempoMap || [], sm = song.sigMap || [];
      let ti = tm.length - 1; while (ti > 0 && tm[ti].sec > d) ti--;
      if (tm.length) tempo = 60e6 / tm[ti].us;
      let si = sm.length - 1; while (si > 0 && sm[si].tick > tick) si--;
      if (sm.length) sig = sm[si];
    }
    /* ★ 用户决策三①：音频延迟补偿。蓝牙/缓冲让声音比画面慢 20–100ms 是常态，
       这里的 ms 直接平移视觉时间轴：正 = 画面**提前**（音符更早到落点线），负 = 延后。
       只动可视化，不动音频时钟/播放进度。 */
    d += Math.max(-0.2, Math.min(0.2, Number(fx.latencyMs || 0) / 1000));
    /* ★ 时间 → 空间换算（2026-10-18e，按用户给的 PPB 规范实现）：
       速度(px/s) = PPB × (BPM/60)，PPB = 每个**四分音符**在坡道上的像素长度。
         · 这样不管 BPM 快慢，音符之间的"空间频率"恒定（大脑不用重新适应慢歌/快歌）；
         · 音符长度(px) = 时值(秒) × 速度 = PPB × 时值/四分时值 —— 时值即长度，天然成立；
         · 玩家滑块只改 PPB（fx.scrollSpeed），不碰 BPM 本身：拖慢 = 整体变小变慢。
       默认 PPB=30 与原实现（一小节 120px / 4 拍）在 4/4 下完全等价，旧观感不变。 */
    const scrollSpeed = Math.max(0.25, Math.min(4, Number(fx.scrollSpeed == null ? 1 : fx.scrollSpeed) || 1));
    const ppb = 30 * scrollSpeed;                       // px / 四分音符
    const barBeats = Math.max(0.25, (sig.num * 4) / (sig.beatType || 4));   // 一小节 = 几个四分音符
    const barPx = ppb * barBeats;                       // 一小节占多少坡道像素
    const v = ppb * tempo / 60;                         // px/s
    const j = d * v;
    const zoom = opts.zoom || 1;
    const WHITE_TOTAL = WHITE_MIDI.length;
    const span = Math.max(12, Math.min(WHITE_TOTAL, Math.round(WHITE_TOTAL / zoom)));
    const centerWk = whiteIndexOf(state.centerPitch);
    const wk0 = Math.max(0, Math.min(WHITE_TOTAL - span, Math.round(centerWk - span / 2)));
    const wk1 = wk0 + span;
    const g = w / span;
    const loMidi = WHITE_MIDI[wk0], hiMidi = WHITE_MIDI[wk1 - 1] + 1;
    // ★ 透视只在「3D 键盘」开启时生效（用户 2026-10-18：「让键盘透视只在 3D 键盘开启时生效」）。
    //   平板键配倾斜透视是自相矛盾的：没有厚度、没有侧面、音符也没有体积，却把整幅画面斜过来。
    const keys3dOn = fx.keys3d !== false;
    const ps = keys3dOn ? Math.max(0, Math.min(1, fx.persp == null ? 0 : Number(fx.persp))) : 0;
    // ★ 键盘与音符**共用一台相机**：键盘在 t∈[0,1] 段，音符在 t<0（落点线上方 = 更远）。
    //   两边各写一套投影必然会漂移（上一版音符只是"朝中心缩一下"，所以读起来是"倾斜地下落"）。
    const keyFaceH = Math.max(10, Math.round(x * 0.72));
    const cam = makeKeyboardProjection({ w, wN, faceH: keyFaceH, persp: ps });
    // ★ 一屏能看到多少秒，由**相机**决定（坡道距离 s 从落点线到屏幕顶端）。
    //   透视下纵向会被压缩：屏幕顶端对应的时间更远，仍然按 wN/v 算会**漏掉上游的音符**。
    const sTop = wN > 0 ? cam.sOf(0) : 0;
    const visSec = wN > 0 && v > 0 ? sTop / v : 0;
    const energy = Math.max(0, Math.min(1, opts.energy || 0));
    /* ★ 用户决策三③：复合拍重音。数据源不是"每 3 个音符"而是**小节内的拍位置**：
       · 6/8、9/8、12/8：每小节按 3 个八分一组，强拍落在每组第 1 个（第 1、第 4 个八分）；
       · 4/4、3/4、2/4：每 2 拍一个强拍（第 1、第 3 拍）。
       重音只放大**瞬时特效**（光柱/粒子/脉冲），不改音符长度与颜色底色。 */
    const tpb = Math.max(1, (song && song.tpb) || 480);
    const beatTicks = Math.max(1, tpb * 4 / (sig.den || sig.beatType || 4));
    const accentOf = (startTick) => {
      if (startTick == null) return 0;
      const rel = startTick - (sig.tick || 0);
      const bi = Math.floor(rel / beatTicks);
      const num = Math.max(1, sig.num || 4);
      const b = ((bi % num) + num) % num;
      const compound = (sig.den || 4) === 8 && num % 3 === 0;
      const per = compound ? 3 : Math.max(1, Math.round(num / 2));
      return b % per === 0 ? 1 : 0;
    };

    // ---------- 场景光带（2026-10-17）：光影随「键盘透视」变化的来源 ----------
    // 坡道上方一条"棚灯"光带；它经坡道反射进相机的深度由**相机高度**决定 ——
    // 相机越高压（透视越大），反射点越往观众这边移，拖滑杆时光带就沿坡道扫过去。
    // 音符层吃的 look / bar / depthT 全部从这里出，见 scene/note.js 的三维玻璃块。
    const look = ps;
    const light = rampLight(sTop, ps);

    // ---------- 歌曲块（沿用旧引擎的构建与裁剪） ----------
    if (song && state.songRef !== song) {
      const built = buildVizBlocks(song);
      state.byPitch = built.byPitch; state.centerPitch = built.centerPitch; state.songRef = song;
      state.parts.length = 0; state.lastD = -1;
    }

    // ============================================================
    // 1) background —— 舞台（底色梯度 + 地面反光 + 网格 + 小节线/编号）
    //    参考实现的背景一律是"深且平"的，元素往上面叠；旧实现直接吃壁纸，才会发灰。
    // ============================================================
    if (opts.layers !== false) {
      // opts.stage===false（纯色/图片/透明背景）时**不发舞台底色与地面反光** ——
      // 否则透明导出会得到一整幅不透明的深蓝底（实测过：alpha 全 255），叠加模式直接废掉。
      // 网格线/小节线保留：它们是叠加层里有意保留的"谱面"装饰。
      if (opts.stage !== false) {
        pr.push(P.rect('background', 0, 0, w, h, { stops: [theme.stage.top, theme.stage.bottom], dir: 'v' }, { z: -100 }));
        if (wN > 0) pr.push(P.rect('background', 0, wN - h * 0.18, w, h * 0.18,
          { stops: [withAlpha(theme.stage.floor, 0), theme.stage.floor], dir: 'v' }, { z: -90 }));
      }
      // ★ fx.grid（面板「网格线」）：键位竖线 + 小节线 + 小节编号一起开关。
      //   想要干净的画面、或把画面当叠加层导出时，这一层是最该关掉的"辅助线"。
      const showGrid = fx.grid !== false;
      const grid = withAlpha('#ffffff', 0.05), gridStrong = withAlpha('#ffffff', 0.10);
      // 键位竖线也是**透视线**：落点线处恒等、往上跟着音符坡道一起收拢（与音符侧边同源）
      for (let i = wk0; showGrid && i <= wk1; i++) {
        if ((i - 2) % 7 !== 0) continue;
        const uu = (i - wk0) * g;
        pr.push(P.line('background', uu, wN, cam.pxN(uu, 0), 0, grid, { z: -80 }));
      }
      const M = Math.floor(j / barPx), Sx = Math.floor((j + Math.max(0, sTop)) / barPx) + 1;
      for (let e = showGrid ? M : 1; e <= Sx; e++) {
        if (!showGrid) break;                       // 关掉网格时连小节编号一起收走
        const ty = cam.yOf(barPx * e - j);
        if (ty < -20 || ty > wN + 20) continue;
        pr.push(P.line('background', 30, ty, w, ty, gridStrong, { z: -70 }));
        if (e > 0) pr.push(P.text('background', String(e), 24, ty, withAlpha('#ffffff', 0.42), { align: 'right', size: 10, z: -60 }));
      }
    }

    // ============================================================
    // 2) notes —— 音符（胶囊 + 四段渐变"内芯"）
    // ============================================================
    const sounding = new Map();
    const hits = [];
    const forward = state.lastD >= 0 && d >= state.lastD;
    if (song) {
      for (const [pitch, arr] of state.byPitch) {
        // ★ 可视音域之外的音符不再直接丢掉（用户："鼓的音符就直接隐藏没有显示出来"）：
        //   鼓组集中在低音区，缩放后音域一变窄就整批消失。现在把它们**夹到最近的可见键**上，
        //   并降一档亮度表示"它其实在画面外" —— 至少看得见"那儿有东西在响"。
        const outOfView = pitch < loMidi || pitch > hiMidi;
        const pitchSrc = outOfView ? Math.max(loMidi, Math.min(hiMidi, pitch)) : pitch;
        const outA = outOfView ? 0.55 : 1;
        const rng = visibleRange(arr, d, visSec);
        if (rng.from >= arr.length) continue;
        const head = arr[rng.from];
        if (head.start <= d) sounding.set(pitchSrc, noteColorOf(fx, head));
        for (let k = rng.from; k < rng.to; k++) {
          const b = arr[k];
          const { sx: sxB, cw: cwB } = pitchGeom(pitchSrc, ensurePm(), g, wk0);
          // ★ 屏幕位置由**相机**投影坡道距离得到（不是直接线性 wN - 秒数·v）：
          //   透视下越高的音符纵向越压缩，这样它们才与键列、小节线落在同一套透视里。
          const bottom = cam.yOf((b.start - d) * v);
          const top = Math.max(-h, cam.yOf((b.end - d) * v));
          const depth = Math.max(0, Math.min(1, (wN - bottom) / Math.max(1, wN)));
          // 平板模式保留老的「越远越窄」内缩（没有相机，靠它制造远近感）；
          // 开了透视就**不许**再内缩：宽度必须严格等于键列宽度 × S(t)，否则侧边会离开键列线。
          const inset = ps > 0.001 ? 0 : Math.round(cwB * 0.12 * depth / 2);
          const cw = Math.max(2, Math.floor(cwB) - inset * 2);
          const sx = sxB + inset;
          // 透视：音符的横截面按"所在高度对应的深度"收拢向消失点 —— 上窄下宽、侧边与键列同向。
          // 落点线处 t=0 是恒等映射，所以音符永远正好落在自己那一列键上（对齐是结构保证）。
          const velN = Math.max(0, Math.min(1, (b.vel == null ? 90 : b.vel) / 127));
          const color = noteColorOf(fx, b);
          const near = Math.max(0, 1 - Math.abs(wN - bottom) / Math.max(1, wN * 0.16));
          const bh = Math.max(bottom - top, 5);
          // ★ 视角相关量（由**相机**算出，不是写死的贴图位置）：
          //   sMid   = 这条音符在坡道上的距离（落点线以上多少像素）
          //   depthT = 坡道深度 0..1（0 落点线 / 1 屏幕最远）
          //   lightBar = 它被那条光带照到的强度 0..1（光带位置 barS 随透视移动）
          const sMid = ps > 0.001 ? cam.sOf(Math.max(-h, Math.min(wN, (top + bottom) / 2))) : 0;
          const depthT = sTop > 0 ? Math.max(0, Math.min(1, sMid / sTop)) : 0;
          const lightBar = ps > 0.001 ? lightAt(light, sMid) : 0;
          // ★ fx.gloss（面板「音符质感」）必须真的接上：上一版它只是个没人读的开关（实测死控件）。
          //   接上后它管三件事：落点光晕、白热内芯、边缘高光。
          const gloss = fx.gloss !== false;
          /* ★★ 这两个部件**必须从四边形取点**（2026-10-17 用户："残影"，并给了关键描述：
             「和音符的间隙一一对应，从上往下走到底时和音符汇合」）。
             原先它们画在**未剪切**的列中心 sx/cw 上，而本体吃 cam.noteQuad 的透视：
             透视把音符越往高处推得越斜，于是每颗音符下沿都挂着一道横向偏移的亮线 ——
             它落在音符与下一颗音符的间隙里（"和间隙一一对应"），越高偏得越多，
             到落点线处 t=0 是恒等映射、两者重合（"走到底时和音符汇合"）。这就是残影。
             现在两处都改成取 quad 的**落点边**（底边），与本体严格同源。 */
          // 音符本体：玻璃质感（主体 + 边缘亮线 + 纵向高光 + 上下收口），见 scene/note.js
          // 不透明度受「音符不透明度」滑杆控制，再乘纵深淡出（越远越淡）
          const quad = ps > 0.001
            ? cam.noteQuad(sx, sx + cw, top, bottom)
            : [sx, top, sx + cw, top, sx + cw, bottom, sx, bottom];
          // ★ 落点边：下面两个"落点部件"都从这里取点（必须在 quad 之后）
          const bmx = (quad[4] + quad[6]) / 2;
          const bmy = Math.min((quad[5] + quad[7]) / 2, wN);
          if (gloss && near > 0.02) {                     // 落点光晕
            pr.push(P.glow('notes', bmx, bmy, 0, Math.max(7, cw * 0.9),
              color, { alpha: 0.5 * near * (0.5 + 0.5 * velN), blend: 'lighter' }));
          }
          const parts = buildNote(P, {
            quad, width: cw, height: bh, color, radius: theme.note.radius,
            alpha: noteAlpha * (1 - 0.5 * depth) * outA, velN, gloss, z: Math.floor(bottom),
            // ★ 三维玻璃块路径（只有「3D 键盘」打开 + 有透视时才走）：方块底切面/内侧键壁/顶面受光
            mode3d: ps > 0.001, vpX: w / 2,
            // ★ 视角相关（2026-10-17）：俯视角 / 光带强度 / 坡道深度 —— 光影随透视变化
            look, bar: lightBar, depthT,
            // ★ 三维结构随「键盘透视」淡入（0→0.25 走完）：滑杆刚离开 0 时不会"啪"地变高光
            k3d: Math.min(1, ps / 0.25),
          });
          for (const q of parts) pr.push(q);
          // 落点处的那道白热横线（"音符砸到键上"的瞬间），仍归主题的 edge 强度管
          if (gloss && theme.note.edge > 0) {
            // 沿 quad 的底边（BL→BR）画，两端各内缩 2px；透视下这条边本身就是斜的，跟着斜才对
            pr.push(P.line('notes', quad[6] + 2, bmy - 1, quad[4] - 2, bmy - 1,
              withAlpha('#ffffff', theme.note.edge * (1 - depth) * (0.5 + 0.5 * velN)), { lw: 1.4, z: Math.floor(bottom) + 0.4 }));
          }
        }
        if (forward) {
          let k2 = 0; while (k2 < arr.length && arr[k2].start <= state.lastD) k2++;
          while (k2 < arr.length && arr[k2].start <= d) { hits.push(arr[k2]); k2++; }
        }
      }
    }

    // ============================================================
    // 3) 击键光效 —— 击键线光带、波纹、闪光、光柱、粒子（按预算裁剪）
    //    ★ 光效应画在 **fx 层**（在 keyboard 之后）：它们压在键面上，若留在 impact 层会被键面切出硬边。
    // ============================================================
    state.hitPulse = Math.max(0, state.hitPulse - 0.06);
    if (wN > 0) {
      pr.push(P.rect('fx', 0, wN - 46, w, 48,
        { stops: ['rgba(0,0,0,0)', withAlpha('#7fb6ff', 0.04 + 0.2 * Math.max(state.hitPulse, energy * 0.6))], dir: 'v' }, { z: -5 }));
      pr.push(P.line('fx', 0, wN, w, wN, withAlpha('#9cc4ff', 0.1 + 0.5 * state.hitPulse + 0.2 * energy), { lw: 1 + state.hitPulse * 1.6, z: -4 }));
    }
    const partScale = Math.max(0.2, Math.min(2, fx.partScale == null ? 1 : Number(fx.partScale)));
    if (forward) {
      for (const b of hits) {
        const { sx: sxB, cw: cwB } = pitchGeom(b.pitch, ensurePm(), g, wk0);
        const velN = Math.max(0, Math.min(1, (b.vel == null ? 90 : b.vel) / 127));
        const color = noteColorOf(fx, b);
        const cx = sxB + cwB / 2;
        const acc = accentOf(b.start);          // 1 = 本小节强拍（6/8 的第 1、4 个八分）
        state.hitPulse = Math.max(state.hitPulse, 1 + 0.4 * acc);
        if (fx.flash > 0) state.keyFlash.set(b.pitch, acc ? 1.25 : 1);
        if (fx.particles !== false) {
          const n = Math.max(1, Math.round((3 + velN * 6) * partScale * (1 + 0.65 * acc)));
          for (let i = 0; i < n; i++) {
            const s1 = noise(state.seed++), s2 = noise(state.seed++), s3 = noise(state.seed++);
            state.parts.push({ kind: 0, x: cx + (s1 - 0.5) * cwB, y: wN, vx: (s1 - 0.5) * 3.4, vy: -(0.6 + s2 * 3.6) - velN * 1.2, life: 1, decay: 0.016 + s3 * 0.02, size: 5 + s3 * 9 + velN * 8, color });
          }
          state.parts.push({ kind: 1, x: cx, y: wN, r: 2 + acc * 1.5, vr: (2.4 + velN * 2.8) * (1 + 0.5 * acc), life: 1, decay: 0.042, color });
          if (fx.beams !== false) state.parts.push({ kind: 2, x: cx, y: wN, w: cwB * (1.5 + velN * 0.5), h: (84 + velN * 150) * (1 + 0.5 * acc), life: 1, decay: 0.032, color });
        }
      }
    }
    stepParts(pr, parts, cam, ps);

    // ============================================================
    // 4) keyboard —— 琴键层（★不透明度/隐藏/只显按键都在这里，是层属性而不是补丁）
    // ============================================================
    const kp = theme.keys;
    if (keysA > 0.001 && wN > 0 && opts.layers !== false) {
      const faceH = keyFaceH;
      const frontH = Math.max(6, x - faceH);
      const liveSet = new Set((opts.activeNotes || []).map((m) => m.midi));
      const decay = (map, k, step) => { const v0 = map.get(k) || 0; const nv = Math.max(0, v0 - step); if (nv > 0.02) map.set(k, nv); else map.delete(k); return nv; };
      // 键盘整体交给 scene/keyboard.js：一台相机产出全部几何，
      // 高亮/闪光/标签与键面共用同一个 quad → 透视下也严丝合缝（旧版这里用矩形叠，必然错位）
      const kb = buildKeyboard(P, {
        w, wN, faceH, frontH, g, wk0, wk1, persp: ps, cam, kp, keysA, WHITE_MIDI, BLACK_PC, fx, shade,
        state: (pitch) => {
          const act = sounding.get(pitch);
          const on = act !== undefined || liveSet.has(pitch);
          const gv = on ? 1 : decay(state.keyGlow, pitch, 0.09);
          const fv = (fx.flash || 0) > 0 ? decay(state.keyFlash, pitch, 0.14) : 0;
          /* ★ 按下量包络（2026-10-17 用户："按压效果不够丝滑和明显"）。
             gv 是**开关量**：命中瞬间就是 1、之后线性衰减 —— 琴键下沉直接跟它，必然"一步到位"，
             所以看起来是"啪"地跳下去而不是按下去。
             这里给每个键单独一条**时间常数**包络：攻 35ms、松 110ms，按 dt 指数趋近。
             起手有 2~3 帧的过渡、回弹更慢，两帧之间不会跳；键盘层优先读它（读不到退回 gv，
             所以纯几何单测里传 {gv:1} 仍然成立）。 */
          const target = on ? 1 : 0;
          const prevD = state.lastD < 0 ? d : state.lastD;
          const frameDt = d - prevD;
          let pp = state.press.get(pitch);
          if (!pp) { pp = { p: 0, v: 0 }; state.press.set(pitch, pp); }
          // ★ 只在"时间真的前进了"时积分：同一 tick 连编两次（确定性单测）必须给出同样的图元
          if (frameDt > 0.0008) {
            const sdt = Math.min(0.05, frameDt);
            const steps = sdt > 0.02 ? 2 : 1;          // 掉帧时拆子步，弹簧不会炸
            const h = sdt / steps;
            for (let si = 0; si < steps; si++) {
              const acc = 900 * (target - pp.p) - 26 * pp.v;   // 刚度 900 / 阻尼 26 → ζ≈0.43
              pp.v += acc * h;
              pp.p += pp.v * h;
            }
          }
          if (!target && pp.p < 0.003 && Math.abs(pp.v) < 0.01) state.press.delete(pitch);
          const prs = Math.max(0, Math.min(1.25, pp.p));   // 允许一点过冲 → 按下时"dig"一下再回稳
          return { gv, fv, prs, color: act !== undefined ? act : withAlpha('#ffffff', 0.5) };
        },
      });
      for (const q of kb.prims) pr.push(q);
    }

    // 键缘闪光：5 种样式按下标（音高 + 力度档）确定性轮换 —— 见 effects.js 的 keyRipple
    if (fx.hitLine !== false && wN > 0) {
      for (const [pitch, color] of sounding) {
        const pi = ensurePm()[pitch]; if (!pi) continue;
        const { sx: sxB, cw: cwB } = pitchGeom(pitch, ensurePm(), g, wk0);
        const velN = Math.max(0, Math.min(1, (pi.vel == null ? 90 : pi.vel) / 127));
        // 样式下标：音高 + 力度档（不用随机数 —— 随机会让同一次按键在相邻帧换样式，看着像抖动）
        const idx = pitch + Math.round(velN * 7);
        for (const q of keyRipple(P, {
          x: projectX(cam, ps, sxB + cwB / 2, wN), y: wN, w: cwB, color, life: pi.life, velN, index: idx, alpha: 0.34,
        })) pr.push(q);
      }
    }

    if (opts.showLyrics && opts.lyricAt) {
      pr.push(P.rect('overlay', 0, 4, w, 24, 'rgba(0,0,0,0.55)', { z: 1 }));
      pr.push(P.text('overlay', String(opts.lyricAt), w / 2, 16, '#fff', { size: 14, align: 'center', bold: true, z: 2 }));
    }
    // 透明模式（叠加到别的视频上）不发暗角：一块半透明黑会把底下的画面整体压暗
    if (!opts.transparent) pr.push(P.overlay('vignette', { strength: theme.material.vignette, z: 9 }));

    P.sortPrims(pr);
    state.lastD = d;
    return { prims: pr, sounding, hits, d, wN, x, geom: { g, wk0, wk1 }, theme, hitPulse: state.hitPulse };
  }

  return { compile, state };
}

// C 标签/键名的基线（键面高度）——抽出来避免在内层循环里重复算
function kh0(_kp, x) { return Math.max(10, Math.round(x * 0.72)); }

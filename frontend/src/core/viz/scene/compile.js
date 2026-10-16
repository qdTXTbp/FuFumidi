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
import { resolveTheme, noteColor } from '../state/themes.js';
import { withAlpha, noteStops, shade } from '../state/palette.js';
import * as P from './primitives.js';

const DEFAULT_BUDGET = { spark: 420, ring: 60, beam: 90 };

export function createCompiler() {
  const state = {
    songRef: null, byPitch: new Map(), centerPitch: 60,
    lastD: -1, seed: 0, hitPulse: 0,
    parts: [], keyGlow: new Map(), keyFlash: new Map(),
  };

  /** 粒子更新（物理），返回存活的粒子；预算按 kind 裁剪 */
  function stepParts(prims, budget, at) {
    const alive = [];
    let spark = 0, ring = 0, beam = 0;
    for (const p of state.parts) {
      if (p.kind === 1) { p.r += p.vr; p.vr *= 0.94; p.life -= p.decay; }
      else if (p.kind === 2) { p.y -= 2.6; p.life -= p.decay; }
      else { p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy += 0.16; p.life -= p.decay; }
      if (p.life <= 0) continue;
      if (p.kind === 1) { if (++ring > budget.ring) continue; prims.push(P.ring('particles', p.x, p.y, p.r, 1 + 2 * p.life, p.color, { alpha: p.life * 0.5, blend: 'lighter' })); }
      else if (p.kind === 2) { if (++beam > budget.beam) continue; prims.push(P.beam('impact', p.x, p.y, p.w, p.h, p.color, { alpha: 0.4 * p.life, blend: 'lighter' })); }
      else { if (++spark > budget.spark) continue; prims.push(P.glow('particles', p.x, p.y, 0, p.size * (0.45 + p.life * 0.55), p.color, { alpha: p.life, blend: 'lighter' })); }
      alive.push(p);
    }
    state.parts = alive;
    return at;
  }

  function compile(song, tick, opts = {}) {
    const w = opts.w || 960, h = opts.h || 540;
    const theme = resolveTheme(opts.theme || 'studio');
    const fx = opts.fx || {};
    const pr = [];
    const keysOn = fx.keysOn !== false;
    const keysA = keysOn ? Math.max(0, Math.min(1, fx.keysAlpha == null ? 1 : Number(fx.keysAlpha))) : 0;
    const parts = Object.assign({}, DEFAULT_BUDGET, opts.budget || {});

    // ---------- 几何 ----------
    const x = Math.min(120, Math.round(0.2 * h));
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
    const barSec = sig.num * 60 / tempo;
    const v = 120 / barSec, j = d * v;
    const visSec = wN > 0 ? wN / v : 0;
    const zoom = opts.zoom || 1;
    const WHITE_TOTAL = WHITE_MIDI.length;
    const span = Math.max(12, Math.min(WHITE_TOTAL, Math.round(WHITE_TOTAL / zoom)));
    const centerWk = whiteIndexOf(state.centerPitch);
    const wk0 = Math.max(0, Math.min(WHITE_TOTAL - span, Math.round(centerWk - span / 2)));
    const wk1 = wk0 + span;
    const g = w / span;
    const loMidi = WHITE_MIDI[wk0], hiMidi = WHITE_MIDI[wk1 - 1] + 1;
    const ps = Math.max(0, Math.min(1, fx.persp == null ? 0 : Number(fx.persp)));
    const vpX = w / 2, kB = 1 - 0.42 * ps;
    const perspX = (px) => (ps > 0 ? vpX + (px - vpX) * kB : px);
    const energy = Math.max(0, Math.min(1, opts.energy || 0));

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
      pr.push(P.rect('background', 0, 0, w, h, { stops: [theme.stage.top, theme.stage.bottom], dir: 'v' }, { z: -100 }));
      if (wN > 0) pr.push(P.rect('background', 0, wN - h * 0.18, w, h * 0.18,
        { stops: [withAlpha(theme.stage.floor, 0), theme.stage.floor], dir: 'v' }, { z: -90 }));
      const grid = withAlpha('#ffffff', 0.05), gridStrong = withAlpha('#ffffff', 0.10);
      for (let i = wk0; i <= wk1; i++) {
        if ((i - 2) % 7 !== 0) continue;
        pr.push(P.line('background', Math.floor((i - wk0) * g), 0, Math.floor((i - wk0) * g), wN, grid, { z: -80 }));
      }
      const M = Math.floor(j / 120), S = Math.floor((j + wN) / 120) + 1;
      for (let e = M; e <= S; e++) {
        const ty = wN - (120 * e - j);
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
        if (pitch < loMidi || pitch > hiMidi) continue;
        const rng = visibleRange(arr, d, visSec);
        if (rng.from >= arr.length) continue;
        const head = arr[rng.from];
        if (head.start <= d) sounding.set(pitch, noteColor(theme, fx.colorBy, head, opts.colorScheme || 0));
        for (let k = rng.from; k < rng.to; k++) {
          const b = arr[k];
          const { sx: sxB, cw: cwB } = pitchGeom(pitch, ensurePm(), g, wk0);
          const bottom = wN - (b.start - d) * v;
          const top = wN - (b.end - d) * v;
          const depth = Math.max(0, Math.min(1, (wN - bottom) / Math.max(1, wN)));
          const inset = Math.round(cwB * 0.12 * depth / 2);
          let cw = Math.max(2, Math.floor(cwB) - inset * 2);
          let sx = sxB + inset;
          if (ps > 0) {                                   // 纵深向消失点收拢
            const dk = 1 - 0.42 * ps * depth;
            const cxx = vpX + (sx + cw / 2 - vpX) * dk;
            cw = Math.max(2, cw * dk); sx = cxx - cw / 2;
          }
          const velN = Math.max(0, Math.min(1, (b.vel == null ? 90 : b.vel) / 127));
          const color = noteColor(theme, fx.colorBy, b, opts.colorScheme || 0);
          const near = Math.max(0, 1 - Math.abs(wN - bottom) / Math.max(1, wN * 0.16));
          const bh = Math.max(bottom - top, 5);
          if (near > 0.02) {                              // 落点光晕
            pr.push(P.glow('notes', sx + cw / 2, Math.min(bottom, wN), Math.max(7, cw * 0.9), 0,
              color, { alpha: 0.5 * near * (0.5 + 0.5 * velN), blend: 'lighter' }));
          }
          pr.push(P.capsule('notes', sx, top, cw, bh,
            { stops: noteStops(color, { velN }), dir: 'v' },
            { r: Math.max(2, Math.min(theme.note.radius, cw / 2, bh / 2)), alpha: 1 - 0.5 * depth, z: Math.floor(bottom) }));
          if (theme.note.edge > 0) {
            pr.push(P.line('notes', sx + 2, Math.min(bottom, wN) - 1, sx + cw - 2, Math.min(bottom, wN) - 1,
              withAlpha('#ffffff', theme.note.edge * (1 - depth) * (0.5 + 0.5 * velN)), { lw: 1.4, z: Math.floor(bottom) + 1 }));
          }
        }
        if (forward) {
          let k2 = 0; while (k2 < arr.length && arr[k2].start <= state.lastD) k2++;
          while (k2 < arr.length && arr[k2].start <= d) { hits.push(arr[k2]); k2++; }
        }
      }
    }

    // ============================================================
    // 3) impact —— 击键线光带、波纹、闪光、光柱、粒子（按预算裁剪）
    // ============================================================
    state.hitPulse = Math.max(0, state.hitPulse - 0.06);
    if (wN > 0) {
      pr.push(P.rect('impact', 0, wN - 46, w, 48,
        { stops: ['rgba(0,0,0,0)', withAlpha('#7fb6ff', 0.04 + 0.2 * Math.max(state.hitPulse, energy * 0.6))], dir: 'v' }, { z: -5 }));
      pr.push(P.line('impact', 0, wN, w, wN, withAlpha('#9cc4ff', 0.1 + 0.5 * state.hitPulse + 0.2 * energy), { lw: 1 + state.hitPulse * 1.6, z: -4 }));
    }
    const partScale = Math.max(0.2, Math.min(2, fx.partScale == null ? 1 : Number(fx.partScale)));
    if (forward) {
      for (const b of hits) {
        const { sx: sxB, cw: cwB } = pitchGeom(b.pitch, ensurePm(), g, wk0);
        const velN = Math.max(0, Math.min(1, (b.vel == null ? 90 : b.vel) / 127));
        const color = noteColor(theme, fx.colorBy, b, opts.colorScheme || 0);
        const cx = sxB + cwB / 2;
        state.hitPulse = 1;
        if (fx.flash > 0) state.keyFlash.set(b.pitch, 1);
        if (fx.particles !== false) {
          const n = Math.max(1, Math.round((3 + velN * 6) * partScale));
          for (let i = 0; i < n; i++) {
            const s1 = noise(state.seed++), s2 = noise(state.seed++), s3 = noise(state.seed++);
            state.parts.push({ kind: 0, x: cx + (s1 - 0.5) * cwB, y: wN, vx: (s1 - 0.5) * 3.4, vy: -(0.6 + s2 * 3.6) - velN * 1.2, life: 1, decay: 0.016 + s3 * 0.02, size: 5 + s3 * 9 + velN * 8, color });
          }
          state.parts.push({ kind: 1, x: cx, y: wN, r: 2, vr: 2.4 + velN * 2.8, life: 1, decay: 0.042, color });
          if (fx.beams !== false) state.parts.push({ kind: 2, x: cx, y: wN, w: cwB * (1.5 + velN * 0.5), h: 84 + velN * 150, life: 1, decay: 0.032, color });
        }
      }
    }
    stepParts(pr, parts, null);

    // ============================================================
    // 4) keyboard —— 琴键层（★不透明度/隐藏/只显按键都在这里，是层属性而不是补丁）
    // ============================================================
    const kp = theme.keys;
    if (keysA > 0.001 && wN > 0 && opts.layers !== false) {
      const topH = Math.max(10, Math.round(x * 0.72));
      const bkH = Math.floor(0.6 * topH), bkFront = Math.round(x * 0.34);
      const liveSet = new Set((opts.activeNotes || []).map((m) => m.midi));
      const decay = (map, k, step) => { const v0 = map.get(k) || 0; const nv = Math.max(0, v0 - step); if (nv > 0.02) map.set(k, nv); else map.delete(k); return nv; };
      for (let i = wk0; i < wk1; i++) {
        const pitch = WHITE_MIDI[i];
        const px = Math.floor((i - wk0) * g), pw = Math.floor(g);
        const act = sounding.get(pitch);
        const on = act !== undefined || liveSet.has(pitch);
        const gv = on ? 1 : decay(state.keyGlow, pitch, 0.09);
        const fv = fx.flash > 0 ? decay(state.keyFlash, pitch, 0.14) : 0;
        const kh = Math.max(6, topH - Math.round(4 * gv));
        const bx0 = perspX(px), bx1 = perspX(px + pw);
        if (ps > 0) pr.push(P.quad('keyboard', [bx0, wN, bx1, wN, px + pw, wN + kh, px, wN + kh], { stops: [kp.wkTop, kp.wkBot], dir: 'v' }, { alpha: keysA, z: i }));
        else pr.push(P.rect('keyboard', px, wN, pw, kh, { stops: [kp.wkTop, kp.wkBot], dir: 'v' }, { alpha: keysA, r: [0, 0, 4, 4], z: i }));
        pr.push(P.rect('keyboard', px, wN + kh, pw, x - kh, { stops: [kp.wkFrontTop, kp.wkFrontBot], dir: 'v' }, { alpha: keysA, z: i }));
        pr.push(P.line('keyboard', px + 0.5, wN + 0.5, px + pw - 0.5, wN + 0.5, kp.wkEdge, { lw: 1, alpha: keysA, z: 1000 + i }));
        if (gv > 0.02) {
          const keyColor = act !== undefined ? act : withAlpha('#ffffff', 0.5);
          if (fx.beams !== false) pr.push(P.beam('impact', px + pw / 2, wN, pw, 40 + 92 * gv, keyColor, { alpha: 0.26 * gv, blend: 'lighter' }));
          pr.push(P.rect('keyboard', px, wN, pw, kh, keyColor, { alpha: gv * keysA * 0.85, r: [0, 0, 4, 4], z: 2000 + i }));
        }
        if (fv > 0.02) pr.push(P.rect('keyboard', px, wN, pw, kh, '#ffffff', { alpha: Math.min(0.72, fv * fx.flash) * keysA, r: [0, 0, 4, 4], z: 3000 + i }));
        if (pitch % 12 === 0) pr.push(P.text('keyboard', 'C' + (pitch / 12 - 1), px + 4, h - 5, kp.ink, { size: 10, alpha: keysA, z: 4000 + i }));
      }
      for (let i = wk0; i < wk1; i++) {
        const pitch = WHITE_MIDI[i] + 1;
        if (!BLACK_PC.includes(pitch % 12)) continue;
        const bx = Math.floor((i - wk0 + 1) * g - 0.35 * g), bw = Math.floor(0.7 * g);
        const act = sounding.get(pitch);
        const on = act !== undefined || liveSet.has(pitch);
        const gv = on ? 1 : decay(state.keyGlow, pitch, 0.09);
        const fv = fx.flash > 0 ? decay(state.keyFlash, pitch, 0.14) : 0;
        const bh = Math.max(6, bkH - Math.round(4 * gv));
        if (ps > 0) pr.push(P.quad('keyboard', [perspX(bx), wN, perspX(bx + bw), wN, bx + bw, wN + bh, bx, wN + bh], { stops: [kp.bkTop, kp.bkBot], dir: 'v' }, { alpha: keysA, z: 100 + i }));
        else pr.push(P.rect('keyboard', bx, wN, bw, bh, { stops: [kp.bkTop, kp.bkBot], dir: 'v' }, { alpha: keysA, r: [0, 0, 2, 2], z: 100 + i }));
        pr.push(P.rect('keyboard', bx, wN + bh, bw, bkFront, { stops: [kp.bkFrontTop, kp.bkFrontBot], dir: 'v' }, { alpha: keysA, z: 100 + i }));
        if (gv > 0.02) pr.push(P.rect('keyboard', bx, wN, bw, bh, act !== undefined ? act : '#0a0a0a', { alpha: gv * keysA, r: [0, 0, 2, 2], z: 2100 + i }));
        if (fv > 0.02) pr.push(P.rect('keyboard', bx, wN, bw, bh, '#ffffff', { alpha: Math.min(0.6, fv * fx.flash) * keysA, r: [0, 0, 2, 2], z: 3100 + i }));
        if (fx.keyNames && bw >= 14) {
          const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
          pr.push(P.text('keyboard', NN[pitch % 12] + (Math.floor(pitch / 12) - 1), bx + bw / 2, wN + kh0(kp, x) + 9, kp.ink, { size: 9, align: 'center', alpha: keysA }));
        }
      }
    }

    // 波纹（半圆鼓包简化成键线上的小发光）
    if (fx.hitLine !== false && wN > 0) {
      for (const [pitch, color] of sounding) {
        const pi = ensurePm()[pitch]; if (!pi) continue;
        const { sx: sxB, cw: cwB } = pitchGeom(pitch, ensurePm(), g, wk0);
        pr.push(P.glow('impact', sxB + cwB / 2, wN, 1, Math.max(4, Math.min(cwB * 0.42, 9)), color, { alpha: 0.3, blend: 'lighter' }));
      }
    }

    if (opts.showLyrics && opts.lyricAt) {
      pr.push(P.rect('overlay', 0, 4, w, 24, 'rgba(0,0,0,0.55)', { z: 1 }));
      pr.push(P.text('overlay', String(opts.lyricAt), w / 2, 16, '#fff', { size: 14, align: 'center', bold: true, z: 2 }));
    }
    pr.push(P.overlay('vignette', { strength: theme.material.vignette, z: 9 }));

    P.sortPrims(pr);
    state.lastD = d;
    return { prims: pr, sounding, hits, d, wN, x, geom: { g, wk0, wk1 }, theme };
  }

  return { compile, state };
}

// C 标签/键名的基线（键面高度）——抽出来避免在内层循环里重复算
function kh0(_kp, x) { return Math.max(10, Math.round(x * 0.72)); }

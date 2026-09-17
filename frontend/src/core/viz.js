// 共享可视化渲染：从 ViewViz.vue 抽离，供 ViewConvert 视频导出复用
import { TRACK_COLORS } from './util.js';
import { t } from './i18n.js';

function cssVar(name, fb) {
  try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch (e) { return fb; }
}
function ensurePm() {
  if (ensurePm._pm) return ensurePm._pm;
  const pm = {}; let wk = 0;
  for (let m = 21; m <= 108; m++) { const pb = [1, 3, 6, 8, 10].includes(m % 12); pm[m] = { isBlack: pb, wkCount: wk }; if (!pb) wk++; }
  ensurePm._pm = pm;
  return pm;
}
// 一个八度内的黑键半音偏移（以 C 为 0）
const BLACK_PC = [1, 3, 6, 8, 10];

// 52 个白键的 midi（升序）。原来每帧都要用 while 循环把音高换算成白键序号，
// 这里预计算成数组，音频几何与琴键绘制直接查表。
const WHITE_MIDI = (() => {
  const out = [];
  for (let m = 21; m <= 108; m++) if (!BLACK_PC.includes(m % 12)) out.push(m);
  return out;
})();
const WHITE_TOTAL = WHITE_MIDI.length; // 52

const LIGHT_KEYS = { wkTop: '#f2f3f5', wkBot: '#e2e4e8', wkLine: 'rgba(10,10,10,0.12)', bkTop: '#3a3d42', bkBot: '#1c1e22' };
const DARK_KEYS = { wkTop: '#2b303a', wkBot: '#20242c', wkLine: 'rgba(255,255,255,0.10)', bkTop: '#0c0e12', bkBot: '#04050a' };

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// 判断 CSS 颜色是否偏暗（相对亮度 < 0.5）。琴键配色据此在浅/深两套间切换。
// 认不出来的写法按浅色处理 —— 与历史观感一致，不会把浅色主题误判成深色。
function isDarkColor(s) {
  const str = String(s || '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
  if (hex) {
    let hx = hex[1];
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    const r = parseInt(hx.slice(0, 2), 16), g = parseInt(hx.slice(2, 4), 16), b = parseInt(hx.slice(4, 6), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(str);
  if (rgb) {
    const p = rgb[1].split(',').map(x => parseFloat(x));
    if (p.length >= 3 && p.every(x => isFinite(x))) return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) < 128;
  }
  return false;
}

// 琴键配色跟随主题：深色基底（studio / hc / 深色模式）下不再是一块亮白板。
// 结果按解析出的 --canvas 缓存，主题切换后自动失效重算。
function keyPalette(state) {
  const canvas = cssVar('--canvas', '#ffffff');
  if (state._keyFor !== canvas) {
    state._keyFor = canvas;
    state._key = isDarkColor(canvas) ? DARK_KEYS : LIGHT_KEYS;
  }
  return state._key;
}

// 音符块配色：colorScheme=0 用轨道色，1/2/3 用按音高推导的 HSL（与原实现同公式）
function blockColor(b, cs) {
  if (!cs) return b.color;
  return 'hsl(' + (((b.pitch * (cs === 1 ? 7 : cs === 2 ? 13 : 17)) + (cs === 2 ? 30 : 0)) % 360) + ',' +
    (cs === 3 ? 75 : cs === 2 ? 80 : 70) + '%,' + (cs === 3 ? 65 : 60) + '%)';
}

// 音高 → 所在（黑键取紧邻下方）白键索引，供音域居中与几何计算
function whiteIndexOf(pitch) {
  const pi = ensurePm()[pitch];
  if (!pi) return 0;
  const i = pi.isBlack ? pi.wkCount - 1 : pi.wkCount;
  return Math.max(0, Math.min(WHITE_TOTAL - 1, i));
}

// 音符块横向几何：白键占 0.9 格，黑键占 0.6 格并骑在两个白键之间。
// cw 不取整（纵深收窄要按比例算），sx 已取整。
function pitchGeom(pitch, pm, g, wk0) {
  const pi = pm[pitch];
  if (!pi) return { sx: 0, cw: 0.9 * g };
  if (pi.isBlack) {
    const cw = 0.6 * g;
    return { sx: Math.floor((pi.wkCount - wk0) * g - cw / 2), cw };
  }
  const cw = 0.9 * g;
  return { sx: Math.floor((pi.wkCount - wk0) * g + 0.05 * g), cw };
}

/**
 * 把全曲音符压成「按音高分组的合并块」，全曲只算一次，供每帧复用。
 *
 * - 同音高上首尾相接 / 重叠的音符并成一条长条（Synthesia 式观感）
 * - 每个音高内的块按 start 升序且互不重叠，因此 end 也单调不减
 *   → 每帧可二分跳到「第一个还没结束的块」，整段已划过的历史不再参与绘制与合并
 * - vel 取合并组内的最大值，供发光强度使用
 * - centerPitch：按音符数加权的平均音高，缩放时用它选可视音域中心
 */
export function buildVizBlocks(song) {
  const byPitch = new Map();
  if (!song || !song.tracks) return { byPitch, centerPitch: 60, total: 0 };
  const items = [];
  let pitchSum = 0, count = 0;
  song.tracks.forEach((tr, ti) => {
    const color = TRACK_COLORS[(tr.index != null ? tr.index : ti) % TRACK_COLORS.length];
    (tr.notes || []).forEach(n => {
      items.push({ trackIndex: ti, pitch: n.midi, start: song.baseSec(n.start), end: song.baseSec(n.end), color, vel: n.vel });
      pitchSum += n.midi; count++;
    });
  });
  items.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  for (const it of items) {
    let arr = byPitch.get(it.pitch);
    if (!arr) { arr = []; byPitch.set(it.pitch, arr); }
    let merged = false;
    for (let k = arr.length - 1; k >= 0; k--) {
      const b = arr[k];
      if (it.start <= b.end + 0.01 && it.end >= b.start - 0.01) {
        if (it.start < b.start) b.start = it.start;
        if (it.end > b.end) b.end = it.end;
        if (it.vel > b.vel) b.vel = it.vel;
        merged = true;
        break;
      }
    }
    if (!merged) arr.push(it);
  }
  // 显式再排一次：下面的二分依赖「start 与 end 同时单调」这一不变量
  for (const arr of byPitch.values()) arr.sort((a, b) => a.start - b.start);
  return { byPitch, centerPitch: count ? Math.round(pitchSum / count) : 60, total: count };
}

// 每帧两次二分（每个音高各一次）：
//   firstEndGE   —— 第一个「还没结束」的块，跳过整段已划过的历史
//   firstStartGT  —— 第一个起点晚于上次绘制的块，用来识别这一帧刚跨过击键线的音符
function firstEndGE(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].end < t) lo = m + 1; else hi = m; }
  return lo;
}
function firstStartGT(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].start <= t) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * 某个音高在当前时刻「一屏之内」需要绘制的块区间 [from, to)。
 *
 * 依赖 buildVizBlocks 保证的不变量：arr 按 start 升序且互不重叠，因此 end 也单调。
 * 于是可以二分跳到第一个「还没结束」的块（整段已划过的历史直接跳过），
 * 再向上走到越过屏顶为止 —— 屏外的块完全不进绘制循环。
 */
export function visibleRange(arr, d, winSec) {
  const from = firstEndGE(arr, d);
  let to = from;
  while (to < arr.length && arr[to].start <= d + winSec) to++;
  return { from, to };
}

// 粒子散射用的确定性伪随机：导出画面必须可复现，不能用 Math.random()
function noise(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// 帧间状态归一化：实时视图与视频导出各持一份，导出侧的对象字面量不一定带全部字段
function vizState(state) {
  const s = state || (drawVizWaterfall._state = drawVizWaterfall._state || {});
  if (!s.parts) s.parts = [];
  if (!s.byPitch) s.byPitch = new Map();
  if (typeof s.centerPitch !== 'number') s.centerPitch = 60;
  if (typeof s.lastD !== 'number') s.lastD = -1;
  if (typeof s.seed !== 'number') s.seed = 0;
  return s;
}

// 老 Chromium 没有 roundRect：补一个等价实现（只在首次调用时打一次补丁）
function patchRoundRect() {
  if (typeof CanvasRenderingContext2D === 'undefined' || CanvasRenderingContext2D.prototype.roundRect) return;
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (typeof r === 'number') r = [r, r, r, r];
    const q = [0, 0, 0, 0];
    (r || []).slice(0, 4).forEach((v, i) => { q[i] = Math.max(0, Math.min(v || 0, Math.min(w, h))); });
    this.moveTo(x + q[0], y);
    this.lineTo(x + w - q[1], y); this.arcTo(x + w, y, x + w, y + q[1], q[1]);
    this.lineTo(x + w, y + h - q[2]); this.arcTo(x + w, y + h, x + w - q[2], y + h, q[2]);
    this.lineTo(x + q[3], y + h); this.arcTo(x, y + h, x, y + h - q[3], q[3]);
    this.lineTo(x, y + q[0]); this.arcTo(x, y, x + q[0], y, q[0]);
    this.closePath(); return this;
  };
}

const MAX_PARTS = 260; // 粒子总量上限：每帧要逐个更新+绘制，不设上限会拖垮大曲目

// 纵向坐标吸附到「设备像素」，只用于文字这类必须清晰、又不随播放移动的内容。
//
// 关于移动内容为什么**不**吸附：滚动速度是 0.933 CSS 像素/帧，而 dpr=2.5 时设备像素粒度
// 是 0.4 CSS 像素 —— 一帧要走 2.33 个设备像素，吸附后只能走 2 或 3 个，于是每帧的位移在
// 2/3 之间跳，观感就是轻微闪烁。实测（同一场景、同一时刻、各 40 帧）逐帧变化量的波动系数：
//   吸附到 CSS 像素 24.6% ／ 吸附到设备像素 21.6% ／ 完全不吸附 15.8%
// 所以移动中的音符块与小节线一律按精确坐标绘制（由画布自身做亚像素抗锯齿），
// 只有小节线编号这种静态文字才吸附，避免字发虚。
function pixelScale(ctx) {
  try {
    const m = ctx.getTransform ? ctx.getTransform() : null;
    return (m && m.a > 0) ? m.a : 1;
  } catch (e) { return 1; }
}

// 抽离自 ViewViz.drawRoll：绘制竖向音符瀑布到 ctx（w x h）
export function drawVizWaterfall(ctx, w, h, song, tick, opts = {}) {
  patchRoundRect();
  const pm = ensurePm();
  const state = vizState(opts.state);
  if (song && state.songRef !== song) {
    const built = buildVizBlocks(song);
    state.byPitch = built.byPitch;
    state.centerPitch = built.centerPitch;
    state.songRef = song;
    state.parts.length = 0;
    state.lastD = -1;
  }
  const x = Math.min(120, Math.round(0.2 * h));
  const wN = Math.floor(h - x); // 卷帘区高度；击键线在 y = wN
  // 纵向吸附到设备像素：所有会随播放移动的纵向坐标都过它，保证整场滚动步进一致、边缘不忽清忽虚
  const sc = pixelScale(ctx);
  const snapY = (yv) => Math.round(yv * sc) / sc;
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, cssVar('--canvas', '#ffffff'));
  bg.addColorStop(1, cssVar('--surface', '#f7f8fa'));
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

  let d = 0, curTempo = (song && song.initialBpm) || 120, curSig = { num: 4 };
  if (song) {
    d = song.baseSec ? song.baseSec(tick) : 0;
    const tm = song.tempoMap || [], sm = song.sigMap || [];
    let ti = tm.length - 1; while (ti > 0 && tm[ti].sec > d) ti--;
    if (tm.length) curTempo = 60e6 / tm[ti].us;
    let si = sm.length - 1; while (si > 0 && sm[si].tick > tick) si--;
    if (sm.length) curSig = sm[si];
  }
  const barSec = curSig.num * 60 / curTempo;
  const v = 120 / barSec, j = d * v;      // px/秒：一小节恒为 120px
  const visSec = wN > 0 ? wN / v : 0;     // 一屏覆盖的时间跨度（秒）

  // ---- 可视音域：zoom 缩放的是音域宽度，不是琴键宽度 ----
  // zoom = 1 时 span = 52 且 wk0 = 0，几何退化成「88 键铺满画布」，与旧版逐像素一致。
  const zoom = opts.zoom || 1;
  const span = Math.max(12, Math.min(WHITE_TOTAL, Math.round(WHITE_TOTAL / zoom)));
  const centerWk = whiteIndexOf(state.centerPitch);
  const wk0 = Math.max(0, Math.min(WHITE_TOTAL - span, Math.round(centerWk - span / 2)));
  const wk1 = wk0 + span;                 // 白键索引区间 [wk0, wk1)
  const g = w / span;                     // 白键宽度
  // 该音域之外音高的块横向已在画布外，连遍历都省掉（zoom=1 时覆盖 21..108 全部音高，
  // 与旧版行为一致）
  const loMidi = WHITE_MIDI[wk0];
  const hiMidi = WHITE_MIDI[wk1 - 1] + 1;

  // ---- 音乐能量驱动的背景光晕（能量由调用方传入，实时与导出同算法）----
  const energy = clamp01(opts.energy || 0);
  if (energy > 0.01 && wN > 0) {
    const glow = ctx.createLinearGradient(0, wN, 0, 0);
    glow.addColorStop(0, cssVar('--accent', '#4f94e0'));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.05 + 0.16 * energy;
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, wN);
    ctx.globalAlpha = 1;
  }

  const grid = cssVar('--hairline', 'rgba(10,10,10,0.10)');
  const gridStrong = cssVar('--border-strong', 'rgba(10,10,10,0.18)');
  const text = cssVar('--ink', '#0a0a0a');
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  for (let i = wk0; i <= wk1; i++) {
    if ((i - 2) % 7 !== 0) continue;      // 只描 C 键左沿
    const tx = Math.floor((i - wk0) * g);
    ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, wN); ctx.stroke();
  }
  const M = Math.floor(j / 120), S = Math.floor((j + wN) / 120) + 1;
  ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  // 滚动小节线：音符竖直下落，小节线应为水平线随音符一同向下滚动（1 像素 = 1 tick）
  for (let e = M; e <= S; e++) {
    const ty = wN - (120 * e - j);
    if (ty < -20 || ty > wN + 20) continue;
    ctx.strokeStyle = gridStrong; ctx.beginPath(); ctx.moveTo(30, ty); ctx.lineTo(w, ty); ctx.stroke();
    // 线随音符一起按精确坐标移动（见 pixelScale 处的说明）；编号是静态文字，吸附住避免发虚
    if (e > 0) { ctx.fillStyle = gridStrong; ctx.fillText(String(e), 24, snapY(ty)); }
  }
  const liveNotes = opts.activeNotes || [];
  const live = new Set(liveNotes.map(m => m.midi));
  const cs = opts.colorScheme || 0;

  // ---- 可见音符块 ----
  // 每个音高只做一次二分：跳过整段已划过的历史（i0 之前的块都已结束），
  // 再向上遍历到屏外为止。窗口外的块不进绘制循环 —— 这是大 MIDI 不掉帧的关键。
  const sounding = new Map();   // 正压在击键线上的音高 → 配色（供琴键高亮）
  const hits = [];              // 本帧刚跨过击键线的块（用于生成粒子）
  const forward = state.lastD >= 0 && d >= state.lastD;
  for (const [pitch, arr] of state.byPitch) {
    if (pitch < loMidi || pitch > hiMidi) continue;  // 横向在画布外
    const { from, to } = visibleRange(arr, d, visSec);
    if (from >= arr.length) continue;               // 该音高已全部走完
    const head = arr[from];
    if (head.start <= d) sounding.set(pitch, blockColor(head, cs));
    for (let k = from; k < to; k++) {
      const b = arr[k];
      const { sx: sxBase, cw: cwBase } = pitchGeom(pitch, pm, g, wk0);
      const bottom = wN - (b.start - d) * v;        // 起点：最先落到击键线的边
      const top = wN - (b.end - d) * v;
      // 纵深：0 = 正压在击键线上，1 = 屏顶。越远越淡、越窄、越不发亮
      const depth = clamp01((wN - bottom) / wN);
      const inset = Math.round(cwBase * 0.12 * depth / 2);
      const cw = Math.max(2, Math.floor(cwBase) - inset * 2);
      const sx = sxBase + inset;
      const velN = clamp01((b.vel == null ? 90 : b.vel) / 127);
      // 发光强度：只看「起音边到击键线的距离」，越近越亮，越过击键线后沿同一条曲线衰减。
      // 全程连续 —— 此前是「正在发声(9+13*vel) / 即将击键(0→9)」两段拼接，音头处会有一次
      // 最高 13px 的光晕阶跃，密集音符下观感就是一片片地在闪。
      const near = Math.max(0, 1 - Math.abs(wN - bottom) / (wN * 0.16));
      const blur = 20 * near * (0.55 + 0.45 * velN);
      ctx.fillStyle = blockColor(b, cs);
      ctx.globalAlpha = 1 - 0.5 * depth;
      if (blur > 0) { ctx.shadowBlur = blur; ctx.shadowColor = ctx.fillStyle; }
      // 按精确坐标绘制（不吸附）——理由见 pixelScale 处的说明
      ctx.beginPath();
      ctx.roundRect(sx, top, cw, Math.max(bottom - top, 5), 4);
      ctx.fill();
      if (blur > 0) ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
    if (forward) {
      let k2 = firstStartGT(arr, state.lastD);
      while (k2 < arr.length && arr[k2].start <= d) { hits.push(arr[k2]); k2++; }
    }
  }

  // ---- 击键粒子：音符跨过击键线时从键面迸出 ----
  // 方向用确定性伪随机（noise）而非 Math.random，导出画面才能逐帧复现。
  if (forward) {
    for (const b of hits) {
      if (state.parts.length >= MAX_PARTS) break;
      const { sx: sxBase, cw: cwBase } = pitchGeom(b.pitch, pm, g, wk0);
      const velN = clamp01((b.vel == null ? 90 : b.vel) / 127);
      const n = 2 + Math.round(velN * 3);
      const color = blockColor(b, cs);
      const cx = sxBase + cwBase / 2;
      for (let i = 0; i < n; i++) {
        const s1 = noise(state.seed++), s2 = noise(state.seed++);
        state.parts.push({
          x: cx, y: wN,
          vx: (s1 - 0.5) * 1.8,
          vy: -(0.5 + s2 * 1.9),
          life: 1, color,
        });
      }
    }
  }

  // ---- 琴键 ----
  const kp = keyPalette(state);
  // 琴键余辉：按下即亮，松开后在约 0.18s 内淡出。此前是硬开硬关并直接挂 20px 发光，
  // 密集音符下琴键会一片片地闪。高亮层改为叠在底色上按余辉强度渐入渐出。
  const keyGlow = state.keyGlow || (state.keyGlow = new Map());
  const KEY_DECAY = 0.09;
  const glowOf = (pitch, on) => {
    const prev = keyGlow.get(pitch) || 0;
    const gv = on ? 1 : Math.max(0, prev - KEY_DECAY);
    if (gv > 0.02) keyGlow.set(pitch, gv); else keyGlow.delete(pitch);
    return gv;
  };
  const whiteLiveColor = cssVar('--ink', '#0a0a0a');
  // 琴键底色渐变按「纵向」定义，颜色只取决于 y；每个白键/黑键的 y 区间完全一致，
  // 因此整屏琴键可以共用两个渐变对象，而不是每个键各建一个（实测 90 个/帧 → 4 个/帧）。
  // 横向平移不改变纵向渐变的着色（着色由 y 在轴上的投影决定），渲染结果逐像素一致。
  const grWk = ctx.createLinearGradient(0, wN, 0, wN + x);
  grWk.addColorStop(0, kp.wkTop); grWk.addColorStop(1, kp.wkBot);
  const bkH = Math.floor(0.6 * x);
  const grBk = ctx.createLinearGradient(0, wN, 0, wN + bkH);
  grBk.addColorStop(0, kp.bkTop); grBk.addColorStop(1, kp.bkBot);
  for (let i = wk0; i < wk1; i++) {
    const pitch = WHITE_MIDI[i];
    const px = Math.floor((i - wk0) * g), pw = Math.floor(g);
    const act = sounding.get(pitch);
    const gv = glowOf(pitch, act !== undefined || live.has(pitch));
    ctx.fillStyle = grWk;
    ctx.beginPath(); ctx.roundRect(px, wN, pw, x, [0, 0, 4, 4]); ctx.fill();
    if (gv > 0.02) {
      ctx.globalAlpha = gv;
      ctx.fillStyle = act !== undefined ? act : whiteLiveColor;
      ctx.shadowBlur = 18 * gv; ctx.shadowColor = ctx.fillStyle;
      ctx.beginPath(); ctx.roundRect(px, wN, pw, x, [0, 0, 4, 4]); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
    ctx.beginPath(); ctx.moveTo(px + pw, wN); ctx.lineTo(px + pw, wN + x - 4);
    ctx.strokeStyle = kp.wkLine; ctx.stroke();
    if (pitch % 12 === 0) { ctx.fillStyle = text; ctx.font = '10px system-ui, sans-serif'; ctx.fillText('C' + (pitch / 12 - 1), px + 4, h - 5); }
  }
  // 黑键骑在两个白键之间：i 号白键右上方各有一个（B/C 与 E/F 之间没有）
  for (let i = wk0; i < wk1; i++) {
    const pitch = WHITE_MIDI[i] + 1;
    if (!BLACK_PC.includes(pitch % 12)) continue;
    const bx = Math.floor((i - wk0 + 1) * g - 0.35 * g), bw = Math.floor(0.7 * g), bh = bkH;
    const act = sounding.get(pitch);
    const gv = glowOf(pitch, act !== undefined || live.has(pitch));
    ctx.fillStyle = grBk;
    ctx.beginPath(); ctx.roundRect(bx, wN, bw, bh, [0, 0, 2, 2]); ctx.fill();
    if (gv > 0.02) {
      ctx.globalAlpha = gv;
      // 黑键上「仅合成器在响」用深色压暗（浅色主题下 --ink 也是深色，深色主题下则不然，
      // 这里保持与改动前一致的语义）
      ctx.fillStyle = act !== undefined ? act : '#0a0a0a';
      ctx.shadowBlur = 18 * gv; ctx.shadowColor = ctx.fillStyle;
      ctx.beginPath(); ctx.roundRect(bx, wN, bw, bh, [0, 0, 2, 2]); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
  }
  for (let e = state.parts.length - 1; e >= 0; e--) {
    const p = state.parts[e];
    p.x += p.vx; p.y += p.vy; p.vy += .2; p.life -= .02;
    if (p.life <= 0) { state.parts.splice(e, 1); continue; }
    ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, 2 * Math.PI); ctx.fill();
    ctx.globalAlpha = 1;
  }
  state.lastD = d;
  if (opts.showLyrics && opts.lyricAt) {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 4, w, 24);
    ctx.fillStyle = '#fff'; ctx.font = '600 14px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(opts.lyricAt, w / 2, 16);
  }
  return { active: liveNotes.filter(n => n.start <= tick && n.end >= tick) };
}

/* ---------------- 音乐能量：实时视图与视频导出共用同一套算法 ---------------- */

const ENERGY_WIN_SEC = 0.04;   // 40ms 窗口：短到能跟上音符起落，长到不会被单周期波形带偏
const ENERGY_FLOOR = 0.01;     // 低于此 RMS 视为静音（底噪/混响尾巴）
const ENERGY_GAIN = 4.2;       // 音乐 RMS 大致落在 0.02~0.35，映射到 0..1

// RMS 软归一化到 0..1
function normalizeRms(rms) {
  return clamp01((rms - ENERGY_FLOOR) * ENERGY_GAIN);
}

// 导出侧：从解码后的 PCM 取 sec 处的能量
export function rmsAt(audioBuf, sec, winSec = ENERGY_WIN_SEC) {
  if (!audioBuf || typeof audioBuf.getChannelData !== 'function') return 0;
  const data = audioBuf.getChannelData(0), sr = audioBuf.sampleRate || 44100;
  const n = Math.max(1, Math.floor(sr * winSec));
  const i0 = Math.max(0, Math.floor(sec * sr));
  const i1 = Math.min(data.length, i0 + n);
  if (i1 <= i0) return 0;
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += data[i] * data[i];
  return normalizeRms(Math.sqrt(sum / (i1 - i0)));
}

// 实时侧：从 AnalyserNode.getByteTimeDomainData 的字节波形取能量。
// 与 rmsAt 是同一个信号上的同一个度量，差别仅在字节量化（128 为静音中点）。
export function rmsFromBytes(td) {
  if (!td || !td.length) return 0;
  let sum = 0;
  for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; sum += v * v; }
  return normalizeRms(Math.sqrt(sum / td.length));
}

// 能量包络平滑：起音快、收音慢，避免逐帧抖动导致的背景闪烁
export function smoothEnergy(prev, target, attack = 0.5, release = 0.06) {
  const p = (typeof prev === 'number' && isFinite(prev)) ? prev : 0;
  const k = target > p ? attack : release;
  return p + (target - p) * k;
}

export function drawVizSpectrum(ctx, w, h, audioBuf, nowSec) {
  if (!audioBuf) return;
  const data = audioBuf.getChannelData(0), sr = audioBuf.sampleRate;
  const bars = 72, rowH = Math.max(2, Math.round(h / 44));
  const windowSec = 2, step = Math.max(1, Math.floor(sr * 0.02));
  for (let r = 0; r < Math.floor(h / rowH); r++) {
    const t = nowSec - (windowSec * (Math.floor(h / rowH) - 1 - r) / Math.floor(h / rowH));
    if (t < 0) continue;
    const si = Math.max(0, Math.floor(t * sr)), si2 = Math.min(data.length, si + step);
    let sum = 0;
    for (let j = si; j < si2; j++) sum += data[j] * data[j];
    const rms = Math.min(1, Math.sqrt(sum / Math.max(1, si2 - si)) * 3);
    const bw = w / bars;
    for (let i = 0; i < bars; i++) {
      const v = rms * (0.4 + 0.6 * (i / bars));
      const hue = 210 + 40 * (i / bars);
      ctx.fillStyle = 'hsla(' + hue + ',85%,50%,' + (0.2 + v * 0.8) + ')';
      ctx.fillRect(i * bw, r * rowH, bw, rowH);
    }
  }
}

export function drawVizScope(ctx, w, h, audioBuf, nowSec) {
  if (!audioBuf) return;
  const data = audioBuf.getChannelData(0), sr = audioBuf.sampleRate;
  const win = Math.floor(sr * 0.05);
  const i0 = Math.max(0, Math.floor(nowSec * sr));
  ctx.strokeStyle = 'rgba(20,86,240,0.9)'; ctx.lineWidth = 1.6; ctx.beginPath();
  const n = Math.min(win, data.length - i0);
  for (let i = 0; i < n; i += 2) {
    const x = i / Math.max(1, n) * w;
    const y = h / 2 + data[i0 + i] * h * 0.45;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

export function drawVizChord(ctx, w, h, activeNotes) {
  const pcs = [...new Set(activeNotes.map(n => ((n.midi % 12) + 12) % 12))].sort((a, b) => a - b);
  const KEY_NAME = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  let chord = null;
  if (pcs.length >= 3) {
    let best = null;
    for (let r = 0; r < 12; r++) for (const [mi, set] of [[0,[0,4,7]],[1,[0,3,7]]]) {
      let sc=0; for (const d of set) if (pcs.includes((r+d)%12)) sc++;
      if (!best || sc > best.sc) best = { r, mi, sc };
    }
    if (best && best.sc >= 3) chord = { name: KEY_NAME[best.r] + (best.mi ? 'm' : ''), pcs };
  }
  ctx.fillStyle = cssVar('--canvas', '#ffffff'); ctx.fillRect(0,0,w,h);
  ctx.textAlign='center'; ctx.textBaseline='middle';
  if (chord) {
    ctx.fillStyle='#ff5530'; ctx.font='700 '+Math.max(18,Math.round(h*.3))+'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(chord.name, w/2, h*.34);
    ctx.fillStyle=cssVar('--stone','rgba(10,10,10,.55)'); ctx.font='10px Consolas, monospace';
    ctx.fillText(chord.pcs.map(p=>KEY_NAME[p]).join(' · '), w/2, h*.62);
    ctx.fillStyle=cssVar('--slate','rgba(10,10,10,.75)'); ctx.font='12px "Microsoft YaHei", sans-serif';
    ctx.fillText(t('播放中'), w/2, h*.8);
  } else {
    ctx.fillStyle=cssVar('--slate','rgba(10,10,10,.75)'); ctx.font='12px "Microsoft YaHei", sans-serif';
    ctx.fillText(pcs.length ? pcs.map(p=>KEY_NAME[p]).join(' · ') : t('播放时显示实时和弦'), w/2, h*.45);
  }
}

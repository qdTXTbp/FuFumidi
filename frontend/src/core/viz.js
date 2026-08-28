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
function buildBlocks(song) {
  const out = [];
  if (!song || !song.tracks) return out;
  const items = [];
  song.tracks.forEach((tr, ti) => {
    const color = TRACK_COLORS[(tr.index != null ? tr.index : ti) % TRACK_COLORS.length];
    (tr.notes || []).forEach(n => {
      items.push({ trackIndex: ti, pitch: n.midi, start: song.baseSec(n.start), end: song.baseSec(n.end), color });
    });
  });
  items.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const byPitch = new Map();
  for (const it of items) {
    if (!byPitch.has(it.pitch)) byPitch.set(it.pitch, []);
    const arr = byPitch.get(it.pitch); let merged = false;
    for (let k = arr.length - 1; k >= 0; k--) {
      const b = arr[k];
      if (it.start <= b.end + 0.01 && it.end >= b.start - 0.01) { b.start = Math.min(b.start, it.start); b.end = Math.max(b.end, it.end); merged = true; break; }
    }
    if (!merged) arr.push(it);
  }
  for (const [, arr] of byPitch) out.push(...arr);
  return out;
}

// 抽离自 ViewViz.drawRoll：绘制竖向音符瀑布到 ctx（w x h）
export function drawVizWaterfall(ctx, w, h, song, tick, opts = {}) {
  if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
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
  const o = ensurePm();
  const state = opts.state || drawVizWaterfall._state || (drawVizWaterfall._state = { pm: null, blocks: null, songRef: null, parts: [], keys: new Set(), lastD: 0 });
  if (song && state.songRef !== song) { state.blocks = buildBlocks(song); state.songRef = song; }
  const g = w / 52 * (opts.zoom || 1);
  const x = Math.min(120, Math.round(0.2 * h));
  const wN = Math.floor(h - x);
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, cssVar('--canvas', '#ffffff'));
  bg.addColorStop(1, cssVar('--surface', '#f7f8fa'));
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  const grid = cssVar('--hairline', 'rgba(10,10,10,0.10)');
  const gridStrong = cssVar('--border-strong', 'rgba(10,10,10,0.18)');
  const text = cssVar('--ink', '#0a0a0a');
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
  const v = 120 / barSec, j = d * v;
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  for (let e = 0; e <= 52; e++) if ((e - 2) % 7 === 0) { const tt = Math.floor(e * g); ctx.beginPath(); ctx.moveTo(tt, 0); ctx.lineTo(tt, wN); ctx.stroke(); }
  const M = Math.floor(j / 120), S = Math.floor((j + wN) / 120) + 1;
  ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  // 滚动小节线：音符竖直下落，小节线应为水平线随音符一同向下滚动（1 像素 = 1 tick）
  for (let e = M; e <= S; e++) {
    const ty = Math.floor(wN - (120 * e - j));
    if (ty < -20 || ty > wN + 20) continue;
    ctx.strokeStyle = gridStrong; ctx.beginPath(); ctx.moveTo(30, ty); ctx.lineTo(w, ty); ctx.stroke();
    if (e > 0) { ctx.fillStyle = gridStrong; ctx.fillText(String(e), 24, ty); }
  }
  const E = new Map();
  const blocks = state.blocks || [];
  for (const e of blocks) {
    if (!E.has(e.pitch)) E.set(e.pitch, []);
    const arr = E.get(e.pitch); let merged = false;
    for (let k = arr.length - 1; k >= 0; k--) {
      const b = arr[k];
      if (e.start <= b.end + 0.01 && e.end >= b.start - 0.01) { b.start = Math.min(b.start, e.start); b.end = Math.max(b.end, e.end); b.color = e.color; merged = true; break; }
    }
    if (!merged) arr.push(e);
  }
  const B = new Map(), P = [];
  for (const [, arr] of E) for (const tt of arr) { P.push(tt); if (tt.start <= d && tt.end >= d) B.set(tt.pitch, tt.color); }
  for (const e of P) {
    const tt = wN - (e.start - d) * v, aa = wN - (e.end - d) * v, l = Math.max(tt - aa, 5), n = Math.floor(aa), i = Math.floor(l);
    const pi = o[e.pitch], cw = pi ? (pi.isBlack ? 0.6 * g : 0.9 * g) : 0.9 * g;
    const sx = Math.floor(pi ? (pi.isBlack ? pi.wkCount * g - cw / 2 : pi.wkCount * g + 0.05 * g) : 0);
    const cs = opts.colorScheme || 0;
    ctx.fillStyle = cs ? 'hsl(' + (((e.pitch * (cs === 1 ? 7 : cs === 2 ? 13 : 17)) + (cs === 2 ? 30 : 0)) % 360) + ',' + (cs === 3 ? 75 : cs === 2 ? 80 : 70) + '%,' + (cs === 3 ? 65 : 60) + '%)' : e.color;
    if (e.start <= d && e.end >= d) { ctx.shadowBlur = 15; ctx.shadowColor = e.color; } else ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.roundRect(sx, n, Math.floor(cw), i, 4); ctx.fill();
    ctx.shadowBlur = 0;
  }
  const liveNotes = opts.activeNotes || [];
  const live = new Set(liveNotes.map(m => m.midi));
  const soft = '#f2f3f5', hair2 = '#e2e4e8';
  for (let e = 0; e < 52; e++) {
    const tt = Math.floor(e * g), aa = Math.floor(g);
    let l = 21, i2 = 0;
    while (i2 < e) { const ni = o[++l]; if (!(ni && ni.isBlack)) i2++; }
    const act = B.get(l), isAct = act !== undefined, isLive = live.has(l), on = isAct || isLive;
    const gr = ctx.createLinearGradient(tt, wN, tt, wN + x);
    gr.addColorStop(0, soft); gr.addColorStop(1, hair2);
    if (on) { ctx.fillStyle = isAct ? act : cssVar('--ink', '#0a0a0a'); ctx.shadowBlur = 20; ctx.shadowColor = ctx.fillStyle; }
    else ctx.fillStyle = gr;
    ctx.beginPath(); ctx.roundRect(tt, wN, aa, x, [0, 0, 4, 4]); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.moveTo(tt + aa, wN); ctx.lineTo(tt + aa, wN + x - 4);
    ctx.strokeStyle = 'rgba(10,10,10,0.12)'; ctx.stroke();
    if (l % 12 === 0) { ctx.fillStyle = text; ctx.font = '10px system-ui, sans-serif'; ctx.fillText('C' + (l / 12 - 1), tt + 4, h - 5); }
  }
  for (let e = 0; e < 51; e++) {
    let tt = 21, a = 0;
    while (a < e) { const s2 = o[++tt]; if (!(s2 && s2.isBlack)) a++; }
    const ni = o[tt + 1];
    if (ni && ni.isBlack) {
      const bP = tt + 1, bx = Math.floor((e + 1) * g - .35 * g), bw = Math.floor(.7 * g), bh = Math.floor(.6 * x);
      const act = B.get(bP);
      if (act !== undefined) ctx.fillStyle = act;
      else { const gr = ctx.createLinearGradient(bx, wN, bx, wN + bh); gr.addColorStop(0, '#3a3d42'); gr.addColorStop(1, '#1c1e22'); ctx.fillStyle = gr; }
      if (live.has(bP)) { ctx.fillStyle = '#0a0a0a'; ctx.shadowBlur = 20; ctx.shadowColor = '#0a0a0a'; }
      ctx.beginPath(); ctx.roundRect(bx, wN, bw, bh, [0, 0, 2, 2]); ctx.fill(); ctx.shadowBlur = 0;
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
  if (opts.showLyrics && opts.lyricAt) {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 4, w, 24);
    ctx.fillStyle = '#fff'; ctx.font = '600 14px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(opts.lyricAt, w / 2, 16);
  }
  return { active: liveNotes.filter(n => n.start <= tick && n.end >= tick) };
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

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { currentSong } from '../store.js';
import { getSynth, ensureAudio, getPlayer } from '../audio.js';
import { TRACK_COLORS } from '../core/util.js';
import { t } from '../core/i18n.js';

const mode = ref('dash'); // 'dash' | 'waterfall'
const wfZoom = ref(1);
const colorScheme = ref(0);

function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}

let raf = null;
let cvs = null; // { roll, spec, scope, chord }
let pm = null;  // 音高几何表
let blocks = [];
let songRef = null;
let parts = [];
let keys = new Set();
let lastD = 0;
let spec = [];

function ensurePm() {
  if (pm) return pm;
  pm = {}; let wk = 0;
  for (let m = 21; m <= 108; m++) { const pb = [1, 3, 6, 8, 10].includes(m % 12); pm[m] = { isBlack: pb, wkCount: wk }; if (!pb) wk++; }
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

function clearCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 200, h = cv.clientHeight || 120;
  const W = Math.floor(w * dpr), H = Math.floor(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawSpectrum(cv, syn) {
  const { ctx: ctx2d, w, h } = clearCanvas(cv);
  const a = syn.analyser;
  const freq = new Uint8Array(a.frequencyBinCount);
  a.getByteFrequencyData(freq);
  const bars = 72, binPer = a.frequencyBinCount / bars, bw = w / bars;
  const rowH = Math.max(2, Math.round(h / 44));
  const row = new Uint8Array(bars);
  for (let i = 0; i < bars; i++) {
    let v = 0;
    for (let k = Math.floor(i * binPer); k < Math.floor((i + 1) * binPer); k++) if (freq[k] > v) v = freq[k];
    row[i] = v;
  }
  spec.unshift(row);
  const maxRows = Math.floor(h / rowH);
  if (spec.length > maxRows) spec.length = maxRows;
  for (let r = 0; r < spec.length; r++) {
    const rr = spec[r];
    const y = r * rowH;
    const fade = 1 - (r / spec.length) * 0.55;
    for (let i = 0; i < bars; i++) {
      const v = rr[i] / 255;
      if (v < 0.05) continue;
      const hue = 210 + 40 * (i / bars);
      ctx2d.fillStyle = `hsla(${hue},85%,50%,${(0.2 + v * 0.8) * fade})`;
      ctx2d.fillRect(i * bw, y, bw, rowH);
    }
  }
  ctx2d.fillStyle = cssVar('--stone', 'rgba(10,10,10,0.4)'); ctx2d.font = '10px Consolas, monospace'; ctx2d.textAlign = 'right';
  ctx2d.fillText('20k', w - 6, h - 6); ctx2d.fillText('40', w - 6, h - 6 - Math.min(40, h / 3));
}

function drawScope(cv, syn) {
  const { ctx: ctx2d, w, h } = clearCanvas(cv);
  const a = syn.analyser;
  const td = new Uint8Array(a.fftSize);
  a.getByteTimeDomainData(td);
  ctx2d.strokeStyle = 'rgba(20,86,240,0.9)'; ctx2d.lineWidth = 1.6; ctx2d.beginPath();
  for (let i = 0; i < td.length; i++) {
    const x = i / td.length * w, y = h / 2 + (td[i] - 128) / 128 * (h / 2 - 6);
    i ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y);
  }
  ctx2d.stroke();
  ctx2d.strokeStyle = cssVar('--hairline', 'rgba(10,10,10,0.08)');
  ctx2d.beginPath(); ctx2d.moveTo(0, h / 2); ctx2d.lineTo(w, h / 2); ctx2d.stroke();
}

function drawChord(cv, syn) {
  const { ctx: ctx2d, w, h } = clearCanvas(cv);
  const acts = syn.activeNow();
  const pcs = [...new Set(acts.map(x => ((x.midi % 12) + 12) % 12))].sort((a, b) => a - b);
  const KEY_NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  let chord = null;
  if (pcs.length >= 3) {
    let best = null;
    for (let r = 0; r < 12; r++) {
      for (const [mi, set] of [[0, [0, 4, 7]], [1, [0, 3, 7]]]) {
        let sc = 0;
        for (const d of set) if (pcs.includes((r + d) % 12)) sc++;
        if (!best || sc > best.sc) best = { r, mi, sc };
      }
    }
    if (best && best.sc >= 3) chord = { name: KEY_NAME[best.r] + (best.mi ? 'm' : ''), pcs };
  }
  const bgc = cssVar('--canvas', '#ffffff');
  const stone = cssVar('--stone', 'rgba(10,10,10,.55)');
  const slate = cssVar('--slate', 'rgba(10,10,10,.75)');
  ctx2d.fillStyle = bgc; ctx2d.fillRect(0, 0, w, h);
  ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle';
  if (chord) {
    ctx2d.fillStyle = '#ff5530';
    ctx2d.font = '700 ' + Math.max(18, Math.round(h * 0.3)) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx2d.fillText(chord.name, w / 2, h * 0.34);
    ctx2d.fillStyle = stone;
    ctx2d.font = '10px Consolas, "Microsoft YaHei", sans-serif';
    ctx2d.fillText(chord.pcs.map(p => KEY_NAME[p]).join(' · '), w / 2, h * 0.62);
    ctx2d.fillStyle = stone;
    ctx2d.font = '10px "Microsoft YaHei", sans-serif';
    ctx2d.fillText(t('播放中'), w / 2, h * 0.8);
  } else if (pcs.length) {
    ctx2d.fillStyle = slate;
    ctx2d.font = '600 ' + Math.max(14, Math.round(h * 0.16)) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx2d.fillText(pcs.map(p => KEY_NAME[p]).join(' · '), w / 2, h * 0.4);
    ctx2d.fillStyle = stone;
    ctx2d.font = '10px "Microsoft YaHei", sans-serif';
    ctx2d.fillText(t('未形成完整三和弦'), w / 2, h * 0.68);
  } else {
    ctx2d.fillStyle = stone;
    ctx2d.font = '12px "Microsoft YaHei", sans-serif';
    ctx2d.fillText(t('播放时显示实时和弦'), w / 2, h * 0.45);
  }
}

function drawRoll(ctx2d, c, u, syn, song, player) {
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
  if (song && songRef !== song) { blocks = buildBlocks(song); songRef = song; }
  const g = c / 52 * (wfZoom.value || 1);
  const x = Math.min(120, Math.round(0.2 * u)); // 键盘高度
  const wN = Math.floor(u - x); // 音符区高度
  // 背景（跟随主题）
  const bg = ctx2d.createLinearGradient(0, 0, 0, u);
  bg.addColorStop(0, cssVar('--canvas', '#ffffff'));
  bg.addColorStop(1, cssVar('--surface', '#f7f8fa'));
  ctx2d.fillStyle = bg; ctx2d.fillRect(0, 0, c, u);
  const grid = cssVar('--hairline', 'rgba(10,10,10,0.10)');
  const gridStrong = cssVar('--border-strong', 'rgba(10,10,10,0.18)');
  const text = cssVar('--ink', '#0a0a0a');
  const soft = '#f2f3f5';       // 琴键保持标准浅色，不随主题变色
  const hair2 = '#e2e4e8';

  // 时间源（秒）
  let d = 0, curTempo = (song && song.initialBpm) || 120, curSig = { num: 4 };
  if (player && song) {
    const cur = player.currentTick();
    d = song.baseSec(cur);
    if (d < lastD - 0.05) { keys.clear(); parts.length = 0; }
    lastD = d;
    const tm = song.tempoMap || [], sm = song.sigMap || [];
    let ti = tm.length - 1; while (ti > 0 && tm[ti].sec > d) ti--;
    if (tm.length) curTempo = 60e6 / tm[ti].us;
    let si = sm.length - 1; while (si > 0 && sm[si].tick > cur) si--;
    if (sm.length) curSig = sm[si];
  }
  const barSec = curSig.num * 60 / curTempo;
  const v = 120 / barSec, j = d * v;

  // C 音列线
  ctx2d.strokeStyle = grid; ctx2d.lineWidth = 1;
  for (let e = 0; e <= 52; e++) if ((e - 2) % 7 === 0) { const tt = Math.floor(e * g); ctx2d.beginPath(); ctx2d.moveTo(tt, 0); ctx2d.lineTo(tt, wN); ctx2d.stroke(); }
  // 滚动小节线 + 序号
  const M = Math.floor(j / 120), S = Math.floor((j + wN) / 120) + 1;
  ctx2d.font = '10px system-ui, sans-serif'; ctx2d.textAlign = 'right'; ctx2d.textBaseline = 'middle';
  for (let e = M; e <= S; e++) {
    const tt = Math.floor(wN - (120 * e - j));
    if (tt >= -20 && tt <= wN + 20) {
      ctx2d.beginPath(); ctx2d.moveTo(30, tt); ctx2d.lineTo(c, tt); ctx2d.stroke();
      if (e > 0) { ctx2d.fillStyle = grid; ctx2d.fillText(e.toString(), 25, tt); }
    }
  }

  const R = blocks.filter(e => e.end > d - 1 && e.start < d + wN / v + 2);
  // 音符发声 → 琴键迸发粒子
  const cap = 220;
  if (keys.size > 20000) keys.clear();
  for (const e of R) if (e.start <= d && e.end >= d && parts.length < cap) {
    const k = e.trackIndex + '-' + e.pitch + '-' + e.start.toFixed(3);
    if (!keys.has(k)) {
      keys.add(k);
      const pi = o[e.pitch], cw = pi ? (pi.isBlack ? 0.6 * g : 0.9 * g) : 0.9 * g;
      const sx = Math.floor(pi ? (pi.isBlack ? pi.wkCount * g - cw / 2 : pi.wkCount * g + 0.05 * g) : 0);
      if (parts.length < cap) parts.push({ x: sx + Math.floor(cw) / 2, y: wN, vx: (Math.random() - .5) * 2, vy: (Math.random() - 1) * 5 - 2, life: 1, color: e.color });
    }
  }

  // 同音高重叠合并
  const E = new Map();
  for (const e of R) {
    if (!E.has(e.pitch)) E.set(e.pitch, []);
    const arr = E.get(e.pitch); let merged = false;
    for (const b of arr) if (e.start <= b.end + .01 && e.end >= b.start - .01) { b.start = Math.min(b.start, e.start); b.end = Math.max(b.end, e.end); merged = true; break; }
    if (!merged) arr.push({ pitch: e.pitch, start: e.start, end: e.end, color: e.color, trackIndex: e.trackIndex });
  }
  const P = [], B = new Map();
  for (const [, arr] of E) for (const tt of arr) { P.push(tt); if (tt.start <= d && tt.end >= d) B.set(tt.pitch, tt.color); }

  // 音符块
  for (const e of P) {
    const tt = wN - (e.start - d) * v, aa = wN - (e.end - d) * v, l = Math.max(tt - aa, 5), n = Math.floor(aa), i = Math.floor(l);
    const pi = o[e.pitch], cw = pi ? (pi.isBlack ? 0.6 * g : 0.9 * g) : 0.9 * g;
    const s = Math.floor(pi ? (pi.isBlack ? pi.wkCount * g - cw / 2 : pi.wkCount * g + 0.05 * g) : 0);
    const cs = colorScheme.value;
    ctx2d.fillStyle = cs ? 'hsl(' + (((e.pitch * (cs === 1 ? 7 : cs === 2 ? 13 : 17)) + (cs === 2 ? 30 : 0)) % 360) + ',' + (cs === 3 ? 75 : cs === 2 ? 80 : 70) + '%,' + (cs === 3 ? 65 : 60) + '%)' : e.color;
    if (e.start <= d && e.end >= d) { ctx2d.shadowBlur = 15; ctx2d.shadowColor = e.color; } else ctx2d.shadowBlur = 0;
    ctx2d.beginPath(); ctx2d.roundRect(s, n, Math.floor(cw), i, 4); ctx2d.fill();
    ctx2d.shadowBlur = 0;
  }

  // 正在发声的音（琴键高亮）
  const live = new Set(syn.activeNow().map(m => m.midi));
  for (let e = 0; e < 52; e++) {
    const tt = Math.floor(e * g), aa = Math.floor(g);
    let l = 21, i2 = 0;
    while (i2 < e) { const ni = o[++l]; if (!(ni && ni.isBlack)) i2++; }
    const act = B.get(l), isAct = act !== undefined, isLive = live.has(l), on = isAct || isLive;
    const gr = ctx2d.createLinearGradient(tt, wN, tt, wN + x);
    gr.addColorStop(0, soft);
    gr.addColorStop(1, hair2);
    if (on) { ctx2d.fillStyle = isAct ? act : cssVar('--ink', '#0a0a0a'); ctx2d.shadowBlur = 20; ctx2d.shadowColor = ctx2d.fillStyle; }
    else ctx2d.fillStyle = gr;
    ctx2d.beginPath(); ctx2d.roundRect(tt, wN, aa, x, [0, 0, 4, 4]); ctx2d.fill(); ctx2d.shadowBlur = 0;
    ctx2d.beginPath(); ctx2d.moveTo(tt + aa, wN); ctx2d.lineTo(tt + aa, wN + x - 4);
    ctx2d.strokeStyle = 'rgba(10,10,10,0.12)'; ctx2d.stroke();
    if (l % 12 === 0) { ctx2d.fillStyle = text; ctx2d.font = '10px system-ui, sans-serif'; ctx2d.fillText('C' + (l / 12 - 1), tt + 4, u - 5); }
  }
  for (let e = 0; e < 51; e++) {
    let tt = 21, a = 0;
    while (a < e) { const s2 = o[++tt]; if (!(s2 && s2.isBlack)) a++; }
    const ni = o[tt + 1];
    if (ni && ni.isBlack) {
      const bP = tt + 1, bx = Math.floor((e + 1) * g - .35 * g), bw = Math.floor(.7 * g), bh = Math.floor(.6 * x);
      const act = B.get(bP);
      if (act !== undefined) ctx2d.fillStyle = act;
      else { const gr = ctx2d.createLinearGradient(bx, wN, bx, wN + bh); gr.addColorStop(0, '#3a3d42'); gr.addColorStop(1, '#1c1e22'); ctx2d.fillStyle = gr; }
      if (live.has(bP)) { ctx2d.fillStyle = '#0a0a0a'; ctx2d.shadowBlur = 20; ctx2d.shadowColor = '#0a0a0a'; }
      ctx2d.beginPath(); ctx2d.roundRect(bx, wN, bw, bh, [0, 0, 2, 2]); ctx2d.fill(); ctx2d.shadowBlur = 0;
    }
  }
  // 粒子
  for (let e = parts.length - 1; e >= 0; e--) {
    const p = parts[e];
    p.x += p.vx; p.y += p.vy; p.vy += .2; p.life -= .02;
    if (p.life <= 0) { parts.splice(e, 1); continue; }
    ctx2d.globalAlpha = p.life; ctx2d.fillStyle = p.color;
    ctx2d.beginPath(); ctx2d.arc(p.x, p.y, 2, 0, 2 * Math.PI); ctx2d.fill();
    ctx2d.globalAlpha = 1;
  }
}

function tick() {
  raf = requestAnimationFrame(tick);
  const syn = getSynth();
  const song = currentSong.value && currentSong.value.song;
  if (!syn || !song) return;
  const player = getPlayer();
  if (cvs.spec.clientWidth) drawSpectrum(cvs.spec, syn);
  if (cvs.scope.clientWidth) drawScope(cvs.scope, syn);
  if (cvs.chord.clientWidth) drawChord(cvs.chord, syn);
  if (cvs.roll.clientWidth) {
    const { ctx, w, h } = clearCanvas(cvs.roll);
    drawRoll(ctx, w, h, syn, song, player);
  }
}

onMounted(() => {
  try { ensureAudio(); } catch (e) { /* 不支持 Web Audio 时仅渲染瀑布 */ }
  cvs = {
    roll: document.getElementById('vizRoll'),
    spec: document.getElementById('vizSpectrum'),
    scope: document.getElementById('vizScope'),
    chord: document.getElementById('vizChord'),
  };
  raf = requestAnimationFrame(tick);
});
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  parts = [];
  keys = new Set();
  spec = [];
});
</script>

<template>
  <div class="page viz-page" :class="{ 'waterfall': mode === 'waterfall' }">
    <div class="viz-col">
      <div class="viz-hero card">
        <div class="vc-head">
          <span class="dot" style="background:var(--brand-coral)"></span><b>音符瀑布</b>
          <button class="chip-btn" :class="{ 'active': mode === 'dash' }" @click="mode = 'dash'">仪表盘</button>
          <button class="chip-btn" :class="{ 'active': mode === 'waterfall' }" @click="mode = 'waterfall'">瀑布流</button>
          <button class="chip-btn" @click="colorScheme = (colorScheme + 1) % 4" title="切换瀑布流配色">配色</button>
          <span style="flex:1"></span>
          <button class="chip-btn" @click="wfZoom = Math.max(0.4, +(wfZoom - 0.1).toFixed(2))">−</button>
          <span class="vc-zoom">{{ Math.round(wfZoom * 100) }}%</span>
          <button class="chip-btn" @click="wfZoom = Math.min(3, +(wfZoom + 0.1).toFixed(2))">+</button>
          <span class="muted small" style="margin-left:10px">Synthesia · 播放同步</span>
        </div>
        <div class="vc-body"><canvas id="vizRoll"></canvas></div>
      </div>

      <div class="viz-grid" v-if="mode === 'dash'">
        <div class="viz-card card">
          <div class="vc-head"><span class="dot" style="background:var(--brand-blue)"></span><b>频谱瀑布</b><span class="muted small" style="margin-left:auto">竖直下落</span></div>
          <div class="vc-body"><canvas id="vizSpectrum"></canvas></div>
        </div>
        <div class="viz-card card">
          <div class="vc-head"><span class="dot" style="background:var(--brand-purple)"></span><b>波形示波器</b><span class="muted small" style="margin-left:auto">时域</span></div>
          <div class="vc-body"><canvas id="vizScope"></canvas></div>
        </div>
        <div class="viz-card card">
          <div class="vc-head"><span class="dot" style="background:var(--brand-magenta)"></span><b>实时和弦</b><span class="muted small" style="margin-left:auto">播放同步</span></div>
          <div class="vc-body"><canvas id="vizChord"></canvas></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viz-page { display: flex; flex-direction: column; }
.viz-col { display: flex; flex-direction: column; gap: 14px; height: 100%; }
.viz-hero { display: flex; flex-direction: column; }
.viz-hero .vc-body { height: 46vh; min-height: 260px; }
.viz-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
@media (max-width: 900px) { .viz-grid { grid-template-columns: 1fr; } }
.viz-card .vc-body { height: 160px; }
.vc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 13px; font-weight: 600; color: var(--ink); }
.vc-head b { letter-spacing: -0.2px; }
.vc-head .vc-zoom { font-size: 11px; min-width: 44px; text-align: center; font-weight: 500; }
.vc-body canvas { width: 100%; height: 100%; display: block; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--canvas); }
.chip-btn.active { background: var(--btn-bg); color: var(--btn-fg); }
.viz-page.waterfall .viz-grid { display: none; }
.viz-page.waterfall .viz-hero { flex: 1; }
.viz-page.waterfall .viz-hero .vc-body { height: calc(100vh - 220px); min-height: 300px; }
</style>

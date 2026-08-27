<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useAppStore } from '../stores/app';
import { getSynth, ensureAudio, getPlayer } from '../audio.js';

const app = useAppStore();
const currentSong = computed(() => app.currentSong);
import { TRACK_COLORS } from '../core/util.js';
import { drawVizWaterfall } from '../core/viz.js';
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
const vizRollState = { blocks: null, songRef: null, parts, keys, lastD };

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
  const tick = player && song ? player.currentTick() : 0;
  drawVizWaterfall(ctx2d, c, u, song, tick, {
    state: vizRollState,
    zoom: wfZoom.value,
    colorScheme: colorScheme.value,
    showLyrics: true,
    lyricAt: '',
    activeNotes: syn && syn.activeNow ? syn.activeNow() : [],
  });
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
          <span class="dot" style="background:var(--brand-coral)"></span><b>{{ t('音符瀑布') }}</b>
          <button class="chip-btn" :class="{ 'active': mode === 'dash' }" @click="mode = 'dash'">{{ t('仪表盘') }}</button>
          <button class="chip-btn" :class="{ 'active': mode === 'waterfall' }" @click="mode = 'waterfall'">{{ t('瀑布流') }}</button>
          <button class="chip-btn" @click="colorScheme = (colorScheme + 1) % 4" :title="t('切换瀑布流配色')">{{ t('配色') }}</button>
          <span style="flex:1"></span>
          <button class="chip-btn" @click="wfZoom = Math.max(0.4, +(wfZoom - 0.1).toFixed(2))">−</button>
          <span class="vc-zoom">{{ Math.round(wfZoom * 100) }}%</span>
          <button class="chip-btn" @click="wfZoom = Math.min(3, +(wfZoom + 0.1).toFixed(2))">+</button>
          <span class="muted small" style="margin-left:10px">{{ t('Synthesia · 播放同步') }}</span>
        </div>
        <div class="vc-body"><canvas id="vizRoll"></canvas></div>
      </div>

      <div class="viz-grid" v-if="mode === 'dash'">
        <div class="viz-card card">
          <div class="vc-head"><span class="dot" style="background:var(--brand-blue)"></span><b>{{ t('频谱瀑布') }}</b><span class="muted small" style="margin-left:auto">{{ t('竖直下落') }}</span></div>
          <div class="vc-body"><canvas id="vizSpectrum"></canvas></div>
        </div>
        <div class="viz-card card">
          <div class="vc-head"><span class="dot" style="background:var(--brand-purple)"></span><b>{{ t('波形示波器') }}</b><span class="muted small" style="margin-left:auto">{{ t('时域') }}</span></div>
          <div class="vc-body"><canvas id="vizScope"></canvas></div>
        </div>
        <div class="viz-card card">
          <div class="vc-head"><span class="dot" style="background:var(--brand-magenta)"></span><b>{{ t('实时和弦') }}</b><span class="muted small" style="margin-left:auto">{{ t('播放同步') }}</span></div>
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
.chip-btn.active { background: var(--accent); color: #fff; }
.viz-page.waterfall .viz-grid { display: none; }
.viz-page.waterfall .viz-hero { flex: 1; }
.viz-page.waterfall .viz-hero .vc-body { height: calc(100vh - 220px); min-height: 300px; }
</style>

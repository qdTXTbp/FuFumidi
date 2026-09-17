<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue';
import { useAppStore } from '../stores/app';
import { getSynth, ensureAudio, getPlayer } from '../audio.js';

const app = useAppStore();
const currentSong = computed(() => app.currentSong);
import Icon from '../components/Icon.vue';
import { drawVizWaterfall, rmsFromBytes, smoothEnergy } from '../core/viz.js';
import { t } from '../core/i18n.js';

const mode = ref('dash'); // 'dash' | 'waterfall'
const wfZoom = ref(1);
const colorScheme = ref(0);
const immersive = ref(false);

// 沉浸模式下仪表盘那三张卡片没有意义，直接按瀑布流布局铺满
const isWaterfall = computed(() => mode.value === 'waterfall' || immersive.value);

function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}

let raf = null;
let cvs = null; // { roll, spec, scope, chord }
let spec = [];
// 帧间状态交给 core/viz.js 自己按需补齐字段（块、粒子、能量包络都在里面）
const rollState = {};
let tdBuf = null;

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
    state: rollState,
    zoom: wfZoom.value,
    colorScheme: colorScheme.value,
    showLyrics: true,
    lyricAt: '',
    activeNotes: syn && syn.activeNow ? syn.activeNow() : [],
    energy: rollState.energy || 0,
  });
}

// 音乐能量：取自 AnalyserNode 的字节波形，与视频导出侧（viz.rmsAt）是同一个度量，
// 只是那边的信号源是解码后的 PCM。包络平滑把值存回 rollState，供绘制读取。
function readEnergy(syn) {
  const a = syn && syn.analyser;
  if (!a) return 0;
  if (!tdBuf || tdBuf.length !== a.fftSize) tdBuf = new Uint8Array(a.fftSize);
  a.getByteTimeDomainData(tdBuf);
  return rmsFromBytes(tdBuf);
}

// 高刷屏 rAF 可达 300fps：频谱/瀑布限流到 ~60fps（视觉无差别，省 5 倍 FFT 与绘制）
const MIN_FRAME_MS = 15;
let lastPaint = 0;
function tick(ts) {
  raf = requestAnimationFrame(tick);
  const now = ts || performance.now();
  if (now - lastPaint < MIN_FRAME_MS) return;
  lastPaint = now;
  const syn = getSynth();
  const song = currentSong.value && currentSong.value.song;
  if (!syn || !song) return;
  const player = getPlayer();
  rollState.energy = smoothEnergy(rollState.energy, readEnergy(syn));
  // 诊断钩子：CDP / 控制台读取当前音乐能量（只读用途，与 __fufumidiActivePlayer 同类）
  if (typeof window !== 'undefined') window.__fufumidiVizEnergy = rollState.energy;
  if (cvs.spec.clientWidth) drawSpectrum(cvs.spec, syn);
  if (cvs.scope.clientWidth) drawScope(cvs.scope, syn);
  if (cvs.chord.clientWidth) drawChord(cvs.chord, syn);
  if (cvs.roll.clientWidth) {
    const { ctx, w, h } = clearCanvas(cvs.roll);
    drawRoll(ctx, w, h, syn, song, player);
  }
}

/* ---------------- 沉浸模式 ---------------- */
// 进入时隐去顶栏 / 侧栏 / 播放栏，底部换成本页的 HUD 浮层；
// 退出时把这三处恢复成「进入之前的原样」（用户可能本来就关着侧栏）。
let barsSaved = null;

function setImmersive(on) {
  if (on === immersive.value) return;
  if (on && !currentSong.value) return; // 没载入曲目时无可渲染内容
  immersive.value = on;
  if (on) {
    barsSaved = { sidebar: app.sidebarOpen, playerbar: app.playerbarOpen };
    app.sidebarOpen = false;
    app.playerbarOpen = false;
    app.ui.immersive = true;
    pokeHud();
    app.toast(t('控件 3 秒无操作后自动淡出，移动鼠标或按 I 退出'));
  } else {
    if (barsSaved) {
      app.sidebarOpen = barsSaved.sidebar;
      app.playerbarOpen = barsSaved.playerbar;
      barsSaved = null;
    }
    app.ui.immersive = false;
    if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
    hudOn.value = true;
  }
}
function toggleImmersive() { setImmersive(!immersive.value); }

// HUD 自动淡出：鼠标/按键一动就亮起来，静止 3 秒后隐去
const hudOn = ref(true);
let hudTimer = null;
function pokeHud() {
  hudOn.value = true;
  if (hudTimer) clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { hudTimer = null; if (immersive.value) hudOn.value = false; }, 3000);
}

function onKey(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const tg = e.target;
  if (tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
  if (e.key === 'i' || e.key === 'I') { e.preventDefault(); toggleImmersive(); }
  else if (e.key === 'Escape' && immersive.value) { e.preventDefault(); setImmersive(false); }
}
function onPointerMove() { if (immersive.value) pokeHud(); }

/* ---------------- HUD 进度条：拖动时显示本地值，不被播放头拉回 ---------------- */
const dragging = ref(false);
const dragVal = ref(0);
const hudProgress = computed(() => (dragging.value ? dragVal.value : app.progress));
function onSeekStart() { dragging.value = true; dragVal.value = app.progress; }
function onSeekInput(e) {
  const r = parseFloat(e.target.value);
  dragVal.value = r;
  app.seekRatio(r);
}
function onSeekEnd() { dragging.value = false; }

/* ---------------- 偏好持久化（与 fufumidi_fx / fufumidi_soundfont 同风格） ---------------- */
const LS_VIZ = 'fufumidi_viz';
function loadPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_VIZ) || 'null');
    if (!s) return;
    if (typeof s.zoom === 'number' && isFinite(s.zoom)) wfZoom.value = Math.min(3, Math.max(0.4, s.zoom));
    if (typeof s.colorScheme === 'number') colorScheme.value = ((Math.round(s.colorScheme) % 4) + 4) % 4;
    if (s.mode === 'dash' || s.mode === 'waterfall') mode.value = s.mode;
  } catch (e) {}
}
function savePrefs() {
  try { localStorage.setItem(LS_VIZ, JSON.stringify({ zoom: wfZoom.value, colorScheme: colorScheme.value, mode: mode.value })); } catch (e) {}
}
watch([wfZoom, colorScheme, mode], savePrefs);

onMounted(() => {
  loadPrefs();
  try { ensureAudio(); } catch (e) { /* 不支持 Web Audio 时仅渲染瀑布 */ }
  cvs = {
    roll: document.getElementById('vizRoll'),
    spec: document.getElementById('vizSpectrum'),
    scope: document.getElementById('vizScope'),
    chord: document.getElementById('vizChord'),
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('mousemove', onPointerMove);
  raf = requestAnimationFrame(tick);
});
// KeepAlive 保活期间停掉循环：频谱/瀑布每帧都要算 FFT 与大量绘制，
// 离开本页后继续跑会明显拖慢整个应用
onActivated(() => { if (!raf) raf = requestAnimationFrame(tick); });
onDeactivated(() => { if (raf) { cancelAnimationFrame(raf); raf = null; } setImmersive(false); });
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('mousemove', onPointerMove);
  setImmersive(false);
  spec = [];
});
</script>

<template>
  <div class="page viz-page" :class="{ 'waterfall': isWaterfall, immersive }">
    <div class="viz-col">
      <div class="viz-hero card">
        <div class="vc-head" :class="{ 'hud-hidden': immersive && !hudOn }">
          <span class="dot" style="background:var(--brand-coral)"></span><b>{{ t('音符瀑布') }}</b>
          <button class="chip-btn" :class="{ 'active': mode === 'dash' }" data-guide="viz-modes" @click="mode = 'dash'">{{ t('仪表盘') }}</button>
          <button class="chip-btn" :class="{ 'active': mode === 'waterfall' }" data-guide="viz-waterfall" @click="mode = 'waterfall'">{{ t('瀑布流') }}</button>
          <button class="chip-btn" @click="colorScheme = (colorScheme + 1) % 4" :title="t('切换瀑布流配色')">{{ t('配色') }}</button>
          <span style="flex:1"></span>
          <button class="chip-btn" @click="wfZoom = Math.max(0.4, +(wfZoom - 0.1).toFixed(2))">−</button>
          <span class="vc-zoom">{{ Math.round(wfZoom * 100) }}%</span>
          <button class="chip-btn" @click="wfZoom = Math.min(3, +(wfZoom + 0.1).toFixed(2))">+</button>
          <button class="chip-btn" :disabled="!currentSong" data-guide="viz-immersive" :title="t('沉浸模式')" @click="toggleImmersive">
            <Icon name="expand" :size="13" />{{ t('沉浸模式') }}
          </button>
          <span class="muted small" style="margin-left:10px">{{ t('Synthesia · 播放同步') }}</span>
        </div>
        <div class="vc-body">
          <canvas id="vizRoll"></canvas>
          <div v-if="immersive" class="viz-hud" :class="{ 'hud-hidden': !hudOn }">
            <button class="hud-btn" :title="app.playing ? t('暂停') : t('播放')" @click="app.togglePlay()">
              <Icon :name="app.playing ? 'pause' : 'play'" :size="18" />
            </button>
            <span class="hud-time">{{ app.curStr }} / {{ app.totalStr }}</span>
            <input class="hud-seek" type="range" min="0" max="1" step="0.0001" :aria-label="t('播放进度')"
                   :value="hudProgress" @pointerdown="onSeekStart" @pointerup="onSeekEnd"
                   @pointercancel="onSeekEnd" @input="onSeekInput">
            <span class="hud-name">{{ currentSong?.name || '' }}</span>
            <button class="hud-btn hud-exit" :title="t('退出沉浸模式（Esc）')" @click="setImmersive(false)">
              <Icon name="close" :size="14" />{{ t('退出') }}
            </button>
          </div>
        </div>
      </div>

      <div class="viz-grid" v-if="!isWaterfall">
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
.viz-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.viz-col { display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0; }
.viz-hero { display: flex; flex-direction: column; min-height: 0; position: relative; }
.viz-hero .vc-body { height: 46vh; min-height: 260px; position: relative; }
/* 卡片列用 minmax(0,1fr)：canvas 的内在宽度（300px）会把纯 1fr 撑破并横向裁切 */
.viz-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.viz-card { min-width: 0; }
.viz-card .vc-body { height: clamp(140px, 20vh, 220px); }
@media (max-width: 1024px) { .viz-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .viz-grid { grid-template-columns: minmax(0, 1fr); } }
.vc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 13px; font-weight: 600; color: var(--ink); flex-wrap: wrap; }
.vc-head b { letter-spacing: -0.2px; }
.vc-head .vc-zoom { font-size: 11px; min-width: 44px; text-align: center; font-weight: 500; }
.vc-body canvas { width: 100%; height: 100%; display: block; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--canvas); }
.chip-btn.active { background: var(--accent); color: #fff; }
.viz-page.waterfall .viz-grid { display: none; }
.viz-page.waterfall .viz-hero { flex: 1; }
/* 全屏瀑布流：不写死 vh 魔法数，直接吃掉剩余高度（窗口变化时自适应） */
.viz-page.waterfall .viz-hero .vc-body { flex: 1; height: auto; min-height: 300px; }

/* ---- 沉浸模式：去掉卡片壳，画面铺满主区，控件浮在画面上并自动淡出 ---- */
.viz-page.immersive { padding: 0; max-width: none; }
.viz-page.immersive .viz-hero {
  border: 0; border-radius: 0; background: transparent; box-shadow: none; padding: 0;
}
.viz-page.immersive .vc-body canvas { border: 0; border-radius: 0; }
.viz-page.immersive .vc-head {
  position: absolute; top: 0; left: 0; right: 0; z-index: 3;
  margin: 0; padding: 8px 14px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, .5), rgba(0, 0, 0, 0));
  color: #fff;
  transition: opacity .3s ease;
}
/* 沉浸态的控件压在画面之上：统一改成白色系，深浅主题下都能读 */
.viz-page.immersive .vc-head .chip-btn {
  background: rgba(255, 255, 255, .16);
  border-color: rgba(255, 255, 255, .24);
  color: #fff;
}
.viz-page.immersive .vc-head .chip-btn:hover { background: rgba(255, 255, 255, .26); }
.viz-page.immersive .vc-head .chip-btn.active { background: #fff; color: #0a0a0a; }
.viz-page.immersive .vc-head .muted,
.viz-page.immersive .vc-head .vc-zoom { color: rgba(255, 255, 255, .82); }

.viz-hud {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px;
  background: linear-gradient(to top, rgba(0, 0, 0, .52), rgba(0, 0, 0, 0));
  color: #fff;
  transition: opacity .3s ease;
}
.hud-btn {
  display: inline-flex; align-items: center; gap: 6px;
  flex: none;
  padding: 7px 12px; border: 1px solid rgba(255, 255, 255, .24);
  border-radius: var(--radius-full, 999px);
  background: rgba(255, 255, 255, .16); color: #fff;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.hud-btn:hover { background: rgba(255, 255, 255, .28); }
.hud-time { flex: none; font-size: 12px; font-variant-numeric: tabular-nums; opacity: .92; }
.hud-name { flex: none; max-width: 32%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; opacity: .92; }
.hud-seek { flex: 1; min-width: 0; accent-color: #fff; }
.hud-exit { margin-left: auto; }
/* 静止后整层隐去：只留画面 */
.hud-hidden { opacity: 0; pointer-events: none; }
@media (max-width: 720px) {
  .hud-name { display: none; }
}
</style>

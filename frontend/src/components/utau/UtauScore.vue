<script setup>
// UTAU 可视化钢琴卷帘编辑器：画笔/选择工具、缩放、网格吸附、播放走带、歌词填词
import { ref, watch, onMounted, nextTick } from 'vue';
import Icon from '../Icon.vue';
import { useUtauStore } from '../../stores/utau';
import { useAppStore } from '../../stores/app';
import { t } from '../../core/i18n.js';

const store = useUtauStore();
const app = useAppStore();
const canvas = ref(null);
const wrap = ref(null);

// 卷帘几何（像素）
const ROW_H = 22;          // 每音高行高
const LEFT = 48;           // 左侧琴键条
const TOP = 24;            // 顶部拍号条
const MIN_P = 36;          // C2
const MAX_P = 84;          // C7
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = p => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
const freqOf = p => 440 * Math.pow(2, (p - 69) / 12);

const tool = ref('pencil'); // pencil | select
const snap = ref(1);        // 吸附（拍）：1 / 0.5 / 0.25
const playing = ref(false);
const playBeat = ref(0);

let noteW = 88;             // 每拍宽（随缩放）
let zoom = 1;
let drag = null;            // { mode:'move'|'resize'|'box', ... }
let cw = 0, ch = 0, beatEnds = 16;
let raf = 0, playT0 = 0, playStart = 0, onsetFired = new Set();
let audio = null;

const yOf = p => TOP + (MAX_P - p) * ROW_H;
const xOf = b => LEFT + b * noteW;

function snapBeat(b) { const s = snap.value; return Math.max(0, Math.round(b / s) * s); }
function snapDur(d) { const s = snap.value; return Math.max(s, Math.round(d / s) * s); }

function contentSize() {
  let end = Math.max(16, Math.ceil((store.totalBeats + 4) / 4) * 4);
  beatEnds = end;
  cw = LEFT + end * noteW + 28;
  ch = TOP + (MAX_P - MIN_P + 1) * ROW_H + 18;
}
function setupCanvas() {
  const c = canvas.value; if (!c) return;
  contentSize();
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
  c.style.width = cw + 'px'; c.style.height = ch + 'px';
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* ---------------- 工具栏 ---------------- */
function setZoom(z) { zoom = Math.max(0.5, Math.min(3, z)); noteW = 88 * zoom; setupCanvas(); draw(); }
function zoomIn() { setZoom(zoom * 1.25); }
function zoomOut() { setZoom(zoom / 1.25); }
function zoomReset() { setZoom(1); }

function play() {
  if (playing.value) { stop(); return; }
  if (!store.notes.length) { app.toast(t('请先添加音符'), 'warn'); return; }
  playing.value = true; playStart = playBeat.value; playT0 = performance.now(); onsetFired.clear();
  const b0 = Math.max(0, Math.floor(playBeat.value));
  for (const n of store.notes) if (n.startBeat <= b0) onsetFired.add(n.startBeat);
  ensureAudio();
  step();
}
function stop() { playing.value = false; cancelAnimationFrame(raf); }
function step() {
  if (!playing.value) return;
  const el = (performance.now() - playT0) / 1000;
  const b = playStart + el * (store.bpm / 60);
  for (const n of store.notes) {
    if (n.startBeat > playStart && n.startBeat <= b && !onsetFired.has(n.startBeat)) {
      onsetFired.add(n.startBeat); blip(freqOf(n.pitch));
    }
  }
  playBeat.value = b;
  scrollFollow(Math.floor(b));
  draw();
  raf = requestAnimationFrame(step);
}
function ensureAudio() {
  if (!audio) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audio = new AC(); }
  if (audio && audio.state === 'suspended') audio.resume();
}
function blip(freq) {
  ensureAudio();
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = 'triangle'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, audio.currentTime);
  g.gain.linearRampToValueAtTime(0.18, audio.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
  o.connect(g); g.connect(audio.destination);
  o.start(); o.stop(audio.currentTime + 0.2);
}
function scrollFollow(b) {
  const el = wrap.value; if (!el) return;
  const x = xOf(b);
  if (x < el.scrollLeft + 30) el.scrollLeft = Math.max(0, x - 30);
  else if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - el.clientWidth + 40;
}
function seek(e) {
  const rect = canvas.value.getBoundingClientRect();
  playBeat.value = Math.max(0, (e.clientX - rect.left - LEFT) / noteW);
  draw();
}
function stopAll() { stop(); if (audio) { try { audio.close(); } catch (e) {} audio = null; } }

/* ---------------- 绘制 ---------------- */
function draw() {
  const c = canvas.value; if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  const bg = V('--surface'), border = V('--border'), muted = V('--text-muted'),
        brand = V('--brand'), ink = V('--text'), whiteKey = V('--surface-muted');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = whiteKey; ctx.fillRect(0, 0, LEFT, ch); ctx.fillRect(0, 0, cw, TOP);

  for (let p = MAX_P; p >= MIN_P; p--) {
    const y = yOf(p);
    const isBlack = [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
    ctx.fillStyle = isBlack ? bg : whiteKey;
    ctx.fillRect(2, y, LEFT - 2, ROW_H + 1);
    if (((p % 12) + 12) % 12 === 0) {
      ctx.fillStyle = ink; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(NOTE_NAMES[0] + (Math.floor(p / 12) - 1), LEFT - 6, y + ROW_H / 2 + 3);
    }
    ctx.strokeStyle = border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(2, y + ROW_H); ctx.lineTo(cw, y + ROW_H); ctx.stroke();
  }
  for (let b = 0; b <= beatEnds; b++) {
    const x = xOf(b);
    ctx.strokeStyle = (b % 4 === 0) ? border : 'rgba(128,128,128,0.14)';
    ctx.lineWidth = (b % 4 === 0) ? 1.4 : 0.6;
    ctx.beginPath(); ctx.moveTo(x, TOP); ctx.lineTo(x, ch); ctx.stroke();
    if (b % 4 === 0) { ctx.fillStyle = muted; ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(String(b / 4 + 1), x + 4, 14); }
  }

  for (const n of store.sortedNotes) {
    const x = xOf(n.startBeat), y = yOf(n.pitch);
    const w = Math.max(noteW * 0.9, n.durBeat * noteW - 2), h = ROW_H - 2;
    const sel = store.selectedId === n.id;
    ctx.fillStyle = sel ? brand : '#9aa1ff';
    ctx.strokeStyle = sel ? brand : 'rgba(0,0,0,0.25)';
    ctx.lineWidth = sel ? 1.6 : 0.8;
    roundRect(ctx, x, y + 1, w, h, 3); ctx.fill(); ctx.stroke();
    if (n.lyric) {
      ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 1, w - 4, h); ctx.clip();
      ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(n.lyric, x + 4, y + h / 2 + 3); ctx.restore();
    }
    ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.5)';
    ctx.fillRect(x + w - 3, y + 1, 3, h);
  }

  // 播放头
  if (playing.value || playBeat.value > 0) {
    const px = xOf(playBeat.value);
    ctx.strokeStyle = brand; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, TOP); ctx.lineTo(px, ch); ctx.stroke();
    ctx.fillStyle = brand; ctx.fillRect(px - 4, TOP, 8, 8);
    if (playing.value) {
      ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(playBeat.value.toFixed(1) + t(' 拍'), px + 6, TOP + 8);
    }
  }
}
function V(n) { try { const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || F(n); } catch (e) { return F(n); } }
function F(n) { return { '--surface': '#F7F7F8', '--border': 'rgba(23,23,23,0.12)', '--text': '#171717', '--text-muted': '#52525B', '--brand': '#4B3FE3', '--surface-muted': '#EFEFF2' }[n] || '#fff'; }
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
}

/* ---------------- 交互 ---------------- */
function toXY(e) { const r = canvas.value.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function hitNote(x, y) {
  for (const n of store.sortedNotes) {
    const rx = xOf(n.startBeat), ry = yOf(n.pitch);
    const rw = Math.max(noteW * 0.9, n.durBeat * noteW - 2), rh = ROW_H - 2;
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return { n, resize: x > rx + rw - 8 };
  }
  return null;
}
function onDown(e) {
  const { x, y } = toXY(e);
  if (x < LEFT || y < TOP) return;
  const hit = hitNote(x, y);
  if (hit) { store.select(hit.n.id); drag = { mode: hit.resize ? 'resize' : 'move', id: hit.n.id, b0: hit.n.startBeat, p0: hit.n.pitch, d0: hit.n.durBeat, x0: x, y0: y }; }
  else if (tool.value === 'select') { store.select(null); drag = { mode: 'box', x0: x, y0: y }; }
  else { store.addNote(snapBeat((x - LEFT) / noteW), Math.max(MIN_P, Math.min(MAX_P, MAX_P - Math.round((y - TOP) / ROW_H)))); }
  try { canvas.value.setPointerCapture(e.pointerId); } catch (err) {}
}
function onMove(e) {
  if (!drag) return;
  const { x, y } = toXY(e);
  const n = store.notes.find(z => z.id === drag.id);
  if (!n) return;
  if (drag.mode === 'move') {
    const db = Math.round((x - drag.x0) / noteW), dp = -Math.round((y - drag.y0) / ROW_H);
    store.updateNote(n.id, { startBeat: Math.max(0, drag.b0 + db), pitch: Math.max(MIN_P, Math.min(MAX_P, drag.p0 + dp)) });
  } else if (drag.mode === 'resize') {
    store.updateNote(n.id, { durBeat: snapDur(drag.d0 + (x - drag.x0) / noteW) });
  }
}
function onUp() { drag = null; }
function onDbl(e) {
  const { x, y } = toXY(e); if (x < LEFT || y < TOP) return;
  const hit = hitNote(x, y); if (!hit) return;
  store.select(hit.n.id);
  nextTick(() => app.promptDialog({ title: t('歌词'), msg: t('输入该音符的歌词/音节：'), value: hit.n.lyric }).then(v => {
    if (v != null && String(v).trim() !== '') store.updateNote(hit.n.id, { lyric: String(v).trim() });
  }));
}
function onCtx(e) {
  e.preventDefault();
  const { x, y } = toXY(e); const hit = hitNote(x, y);
  if (hit) { store.select(hit.n.id); store.removeNote(hit.n.id); }
}
function onKey(e) {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { if (store.selectedId) store.removeNote(store.selectedId); }
  else if (e.key === ' ' && e.code === 'Space') { e.preventDefault(); play(); }
  else if (e.key === 'Escape') { stopAll(); }
}

function addAtEnd() {
  const end = store.totalBeats;
  const id = store.addNote(end, 60); store.updateNote(id, { lyric: 'あ' });
  nextTick(() => { const el = wrap.value; if (el) el.scrollLeft = xOf(end) - 40; });
}
function delSelected() { if (store.selectedId) store.removeNote(store.selectedId); }
function goRender() { app.setView('utau'); }

const pitchOptions = Array.from({ length: MAX_P - MIN_P + 1 }, (_, i) => MIN_P + i);
watch(() => store.totalBeats, () => { setupCanvas(); draw(); });
watch(() => store.notes, draw, { deep: true });
watch(() => store.selectedId, draw);
watch(() => store.bpm, () => { if (playing.value) playT0 = performance.now() - (playBeat.value - playStart) * 60000 / store.bpm; });
onMounted(() => { setupCanvas(); draw(); window.addEventListener('keydown', onKey); });
</script>

<template>
  <div class="us">
    <div class="us-toolbar">
      <button class="btn sm" :class="{ primary: playing }" @click="play"><Icon :name="playing ? 'stop' : 'play2'" :size="13" /> {{ playing ? t('停止') : t('试听') }}</button>
      <span class="sep"></span>
      <div class="tg">
        <button class="btn sm" :class="{ on: tool === 'pencil' }" @click="tool = 'pencil'" :title="t('画笔：点击加音')"><Icon name="pencil" :size="13" /></button>
        <button class="btn sm" :class="{ on: tool === 'select' }" @click="tool = 'select'" :title="t('选择：点击选中/拖动')"><Icon name="cursor" :size="13" /></button>
      </div>
      <span class="sep"></span>
      <label class="us-ad">{{ t('吸附') }}
        <select class="select-input" :value="snap" @change="e => snap = parseFloat(e.target.value)">
          <option :value="1">1 {{ t('拍') }}</option>
          <option :value="0.5">1/2</option>
          <option :value="0.25">1/4</option>
        </select>
      </label>
      <span class="sep"></span>
      <div class="tg">
        <button class="btn sm" @click="zoomOut" title="−"><Icon name="minus" :size="13" /></button>
        <button class="btn sm" @click="zoomReset">{{ Math.round(zoom * 100) }}%</button>
        <button class="btn sm" @click="zoomIn" title="+"><Icon name="plus" :size="13" /></button>
      </div>
      <span class="sep"></span>
      <label>{{ t('BPM') }}<input type="number" class="text-input us-num" :value="store.bpm" min="20" max="400" @change="e => store.setBpm(parseFloat(e.target.value) || 120)" /></label>
      <label>{{ t('音源音高') }}<select class="select-input" :value="store.sampleNote" @change="e => store.setSampleNote(e.target.value)">
        <option v-for="n in pitchOptions" :key="n" :value="pitchName(n)">{{ pitchName(n) }}</option>
      </select></label>
      <span class="sep"></span>
      <button class="btn primary" @click="addAtEnd"><Icon name="plus" :size="13" /> {{ t('末尾加音') }}</button>
      <button class="btn sm" @click="delSelected" :disabled="!store.selectedId">{{ t('删除') }}</button>
      <button class="btn sm ghost danger" @click="store.clear()" :disabled="!store.notes.length">{{ t('清空') }}</button>
    </div>

    <div ref="wrap" class="us-scroll">
      <canvas ref="canvas" class="us-canvas"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
        @dblclick="onDbl" @contextmenu="onCtx" @pointerdown.prevent></canvas>
    </div>

    <div class="us-foot">
      <span class="muted small">{{ t('画笔') }}：{{ t('点击空白加音') }} · {{ t('拖音符移动') }} · {{ t('拖右缘改长') }} · {{ t('双击改歌词') }} · {{ t('右键删除') }}</span>
      <span class="muted small" style="margin-left:auto">{{ store.notes.length }} {{ t('音符') }} · {{ store.bpm }} BPM · {{ t('音源 ') }}{{ store.sampleNote }}</span>
    </div>
  </div>
</template>

<style scoped>
.us { padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }
.us-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--stone); }
.us-toolbar label { display: inline-flex; align-items: center; gap: 6px; }
.us-num { width: 60px; padding: 3px 6px; font-size: 12px; }
.tg { display: inline-flex; gap: 2px; }
.tg .btn.on { background: var(--brand-soft); color: var(--brand-text); border-color: var(--brand); }
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; flex: none; }
.us-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); touch-action: none; }
.us-canvas { display: block; cursor: crosshair; }
.us-foot { display: flex; align-items: center; gap: 10px; line-height: 1.6; }
</style>
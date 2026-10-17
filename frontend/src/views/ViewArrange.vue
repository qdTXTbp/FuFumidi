<script setup>
// P1-1b 编排时间线（ViewArrangement）：clip 视图 + 标尺/小节网格 + markers/regions + 播放头。
// 模型在 core/arrange.js（纯函数，13 测例）；时间轴换算走 C4 TimelineModel。
// 本轮交互：选中/拖拽移动（含跨轨）/拖边缩放/按播放头切分/删除/静音/加标记/加区间/双击聚焦编辑页。
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';
import { themeColor } from '../core/palette.js';
import { timelineOfSong, iterBars, secOfTick, tickOfSec } from '../core/timeline.js';
import {
  createArrangeState, addClip, removeClip, moveClip, resizeClip, splitClip,
  setTrackFlags, addMarker, addRegion, clipLen, findClip, focusRangeOfClip,
  readArrangeFromSong, writeArrangeToSong, defaultArrangeState,
} from '../core/arrange.js';

const app = useAppStore();
const song = computed(() => (app.currentSong && app.currentSong.song) || null);
const wrap = ref(null);
const cv = ref(null);
const state = ref(createArrangeState({}));
const selected = ref('');
const zoom = ref(0.12);      // 每 tick 像素
const scrollX = ref(0);      // tick
const rowH = 56;
const RULER_H = 26;
let raf = 0;
let drag = null;

const timeline = computed(() => {
  const s = song.value;
  if (!s) return null;
  try { return timelineOfSong(s); } catch (e) { return null; }
});
const totalTicks = computed(() => {
  const s = song.value;
  if (!s) return 0;
  const end = Math.max(s.totalTicks || 0, ...state.value.clips.map((c) => c.endTick), 1920 * 4);
  return end + 1920 * 2;
});
const playTick = computed(() => {
  const s = song.value, tl = timeline.value;
  if (!s || !tl) return 0;
  try { return Math.round(s.secToTick((app.curSec || 0) / (app.tempo || 1))); } catch (e) { return 0; }
});
const clipCount = computed(() => state.value.clips.length);
const markerCount = computed(() => state.value.markers.length);
const regionCount = computed(() => state.value.regions.length);

function resetState() {
  const s = song.value;
  // P1-1c：优先恢复 song.arrange（会话内持久化），没有则按曲目生成默认编排
  state.value = readArrangeFromSong(s) || defaultArrangeState(s);
  selected.value = '';
  draw();
}
watch(song, () => { resetState(); });
// 编排状态回写 song.arrange（防抖 250ms；同曲目切换页签/重新进入不丢）
let persistTimer = 0;
watch(state, () => {
  draw();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { writeArrangeToSong(song.value, state.value); } catch (e) {}
  }, 250);
}, { deep: true });

function ensureCv() {
  const el = cv.value, w = wrap.value;
  if (!el || !w) return null;
  const W = w.clientWidth || 800;
  const rows = state.value.tracks.length;
  const H = RULER_H + Math.max(120, rows * rowH + 20);
  const dpr = window.devicePixelRatio || 1;
  if (el.width !== Math.floor(W * dpr) || el.height !== Math.floor(H * dpr)) {
    el.width = Math.floor(W * dpr); el.height = Math.floor(H * dpr);
    el.style.height = H + 'px';
  }
  return { el, g: el.getContext('2d'), W, H, dpr };
}
function xOfTick(tick) { return (tick - scrollX.value) * zoom.value; }
function tickOfX(x) { return scrollX.value + x / zoom.value; }

function draw() {
  const c = ensureCv();
  const s = song.value;
  if (!c) return;
  const { g, W, H, dpr } = c;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = themeColor('--surface', '#14161c');
  const line = themeColor('--hairline', 'rgba(255,255,255,.08)');
  const strong = themeColor('--border-strong', 'rgba(255,255,255,.18)');
  const ink = themeColor('--text', '#e8e8ea');
  const muted = themeColor('--muted', '#9aa0aa');
  const brand = themeColor('--brand', '#5b8def');
  const accent = themeColor('--brand-coral', '#e06c75');
  g.clearRect(0, 0, W, H);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  if (!s) {
    g.fillStyle = muted; g.font = '13px system-ui'; g.fillText(t('还没有载入曲目'), 16, 24);
    return;
  }
  const tl = timeline.value;
  // 标尺 + 小节线
  g.fillStyle = themeColor('--surface-soft', '#1b1e26');
  g.fillRect(0, 0, W, RULER_H);
  g.font = '10px system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle';
  if (tl) {
    let bars = [];
    try { bars = iterBars(tl, Math.max(0, scrollX.value), scrollX.value + W / zoom.value); } catch (e) { bars = []; }
    for (const bar of bars) {
      const x = Math.round(xOfTick(bar.tick)) + 0.5;
      if (x < -40 || x > W + 40) continue;
      g.strokeStyle = strong;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      g.fillStyle = muted;
      g.fillText(String(bar.bar + 1), x + 3, 12);
      // 拍线
      g.strokeStyle = line;
      const beat = bar.ticks / Math.max(1, bar.num);
      for (let k = 1; k < bar.num; k++) {
        const bx = Math.round(xOfTick(bar.tick + k * beat)) + 0.5;
        if (bx < -5 || bx > W + 5) continue;
        g.beginPath(); g.moveTo(bx, RULER_H); g.lineTo(bx, H); g.stroke();
      }
    }
  }
  // 轨道行 + clip
  state.value.tracks.forEach((tr, i) => {
    const y = RULER_H + i * rowH;
    g.fillStyle = i % 2 ? themeColor('--surface-soft', '#1b1e26') : bg;
    g.fillRect(0, y, W, rowH);
    g.strokeStyle = line;
    g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke();
    // 轨道名（左侧固定 96px 区域用半透明底遮住内容）
    g.fillStyle = themeColor('--surface', '#14161c');
    g.fillRect(0, y, 96, rowH);
    g.fillStyle = tr.mute ? muted : ink;
    g.font = '11px system-ui';
    g.fillText(tr.name + (tr.mute ? ' (M)' : ''), 8, y + 16);
    for (const clip of state.value.clips.filter((c) => c.trackId === tr.id)) {
      const x0 = xOfTick(clip.startTick), x1 = xOfTick(clip.endTick);
      if (x1 < 0 || x0 > W) continue;
      const left = Math.max(96, x0), right = Math.min(W, x1);
      if (right <= left) continue;
      const sel = selected.value === clip.id;
      const r = 6;
      g.beginPath();
      g.moveTo(left + r, y + 8); g.arcTo(right, y + 8, right, y + rowH - 8, r);
      g.arcTo(right, y + rowH - 8, left, y + rowH - 8, r);
      g.arcTo(left, y + rowH - 8, left, y + 8, r);
      g.arcTo(left, y + 8, right, y + 8, r);
      g.closePath();
      g.fillStyle = sel ? 'rgba(91,141,239,.35)' : 'rgba(91,141,239,.18)';
      g.fill();
      g.strokeStyle = sel ? brand : 'rgba(91,141,239,.55)';
      g.lineWidth = sel ? 2 : 1;
      g.stroke(); g.lineWidth = 1;
      g.fillStyle = ink;
      g.font = '11px system-ui';
      g.fillText(clip.name || clip.id, left + 8, y + 22);
    }
  });
  // regions + markers
  for (const rg of state.value.regions) {
    const x0 = xOfTick(rg.startTick), x1 = xOfTick(rg.endTick);
    if (x1 < 0 || x0 > W) continue;
    g.fillStyle = 'rgba(224,108,117,.10)';
    g.fillRect(Math.max(0, x0), RULER_H, Math.min(W, x1) - Math.max(0, x0), H - RULER_H);
  }
  for (const m of state.value.markers) {
    const x = xOfTick(m.tick);
    if (x < -10 || x > W + 10) continue;
    g.fillStyle = accent;
    g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x - 4, RULER_H - 7); g.lineTo(x + 4, RULER_H - 7); g.closePath(); g.fill();
    g.fillStyle = ink; g.font = '10px system-ui';
    g.fillText(m.title || '', x + 5, RULER_H - 13);
  }
  // 播放头
  const px = xOfTick(playTick.value);
  if (px >= 0 && px <= W) {
    g.strokeStyle = accent; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.lineWidth = 1;
  }
}

function setZoom(mult) {
  const old = zoom.value;
  zoom.value = Math.max(0.02, Math.min(1.2, old * mult));
  draw();
}
function tickAt(x, y) {
  const row = Math.floor((y - RULER_H) / rowH);
  return { tick: Math.max(0, Math.round(tickOfX(x))), trackIndex: row };
}
function hitClip(x, y) {
  const { trackIndex } = tickAt(x, y);
  const tr = state.value.tracks[trackIndex];
  if (!tr) return null;
  const tick = tickOfX(x);
  const list = state.value.clips.filter((c) => c.trackId === tr.id);
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (tick >= c.startTick && tick <= c.endTick) {
      const edge = (xOfTick(c.startTick) > 90 && Math.abs(xOfTick(c.startTick) - x) <= 6) ? 'start'
        : (Math.abs(xOfTick(c.endTick) - x) <= 6 ? 'end' : '');
      return { clip: c, edge };
    }
  }
  return null;
}
function onDown(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (y < RULER_H) {
    // 点标尺 = seek
    try { const s = song.value; if (s && timeline.value) app.seekSec(secOfTick(timeline.value, Math.max(0, Math.round(tickOfX(x))))); } catch (err) {}
    return;
  }
  const hit = hitClip(x, y);
  if (!hit) { selected.value = ''; draw(); return; }
  selected.value = hit.clip.id;
  const { trackIndex } = tickAt(x, y);
  drag = { clipId: hit.clip.id, edge: hit.edge, startX: x, startY: y, origStart: hit.clip.startTick, origEnd: hit.clip.endTick, trackIndex };
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
  draw();
}
function onMove(e) {
  if (!drag) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const dTick = Math.round((x - drag.startX) / zoom.value);
  if (drag.edge === 'start') {
    state.value = resizeClip(state.value, drag.clipId, 'start', Math.max(0, drag.origStart + dTick));
  } else if (drag.edge === 'end') {
    state.value = resizeClip(state.value, drag.clipId, 'end', Math.max(1, drag.origEnd + dTick));
  } else {
    const row = Math.floor((y - RULER_H) / rowH);
    const tr = state.value.tracks[Math.max(0, Math.min(state.value.tracks.length - 1, row))];
    const patch = { startTick: Math.max(0, drag.origStart + dTick) };
    if (tr) patch.trackId = tr.id;
    state.value = moveClip(state.value, drag.clipId, patch);
  }
  draw();
}
function onUp(e) { drag = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {} }
function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey) { setZoom(e.deltaY < 0 ? 1.15 : 0.87); return; }
  const dx = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / zoom.value;
  scrollX.value = Math.max(0, scrollX.value + dx);
  draw();
}
function onDblClick(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const hit = hitClip(e.clientX - rect.left, e.clientY - rect.top);
  if (!hit) return;
  const fr = focusRangeOfClip(hit.clip);
  const idx = Math.max(0, state.value.tracks.findIndex((tr) => tr.id === hit.clip.trackId));
  try { window.__fufumidiArrangeFocus = { trackIndex: idx, fromTick: fr.fromTick, toTick: fr.toTick }; } catch (err) {}
  app.setView('edit');
}

/* ---- 工具条动作 ---- */
function splitAtPlayhead() {
  if (!selected.value) return;
  state.value = splitClip(state.value, selected.value, playTick.value);
  draw();
}
function deleteSelected() {
  if (!selected.value) return;
  state.value = removeClip(state.value, selected.value);
  selected.value = '';
  draw();
}
function toggleMute() {
  const tr = state.value.tracks.find((x) => x.id === (findClip(state.value, selected.value) || {}).trackId);
  if (!tr) return;
  state.value = setTrackFlags(state.value, tr.id, { mute: !tr.mute });
  draw();
}
function addMarkerHere() {
  const tl = timeline.value;
  let bar = 1;
  try { bar = tl ? Math.floor(tickOfSec(tl, secOfTick(tl, playTick.value) + 0.001) / 1) : 1; } catch (e) {}
  state.value = addMarker(state.value, { title: 'M' + (markerCount.value + 1), tick: playTick.value });
  void bar;
  draw();
}
function addRegionHere() {
  const tl = timeline.value;
  let span = 1920;
  try { if (tl) { const b = iterBars(tl, playTick.value, playTick.value + 1920 * 8); if (b.length > 1) span = b[1].ticks * 4; } } catch (e) {}
  state.value = addRegion(state.value, { name: 'R' + (regionCount.value + 1), startTick: playTick.value, endTick: playTick.value + span });
  draw();
}
function fitAll() {
  const w = wrap.value ? wrap.value.clientWidth : 800;
  zoom.value = Math.max(0.01, (w - 120) / Math.max(1, totalTicks.value));
  scrollX.value = 0;
  draw();
}

let tickTimer = 0;
onMounted(async () => {
  resetState();
  await nextTick();
  fitAll();
  tickTimer = setInterval(() => { if (app.playing) draw(); }, 100);
});
onBeforeUnmount(() => { if (tickTimer) clearInterval(tickTimer); });

</script>

<template>
  <div class="arrange-page">
    <div class="arr-toolbar card">
      <Icon name="edit" :size="14" />
      <b>{{ t('编排时间线') }}</b>
      <span class="arr-stat">{{ clipCount }} {{ t('片段') }} · {{ markerCount }} {{ t('标记') }} · {{ regionCount }} {{ t('区间') }}</span>
      <span class="arr-grow"></span>
      <button class="btn sm" @click="setZoom(1.2)">{{ t('放大') }}</button>
      <button class="btn sm" @click="setZoom(1 / 1.2)">{{ t('缩小') }}</button>
      <button class="btn sm" @click="fitAll">{{ t('全览') }}</button>
      <button class="btn sm" :disabled="!selected" @click="splitAtPlayhead">{{ t('在播放头切分') }}</button>
      <button class="btn sm" :disabled="!selected" @click="toggleMute">{{ t('静音轨道') }}</button>
      <button class="btn sm" :disabled="!selected" @click="deleteSelected">{{ t('删除片段') }}</button>
      <button class="btn sm" @click="addMarkerHere">{{ t('加标记') }}</button>
      <button class="btn sm" @click="addRegionHere">{{ t('加区间') }}</button>
    </div>
    <div ref="wrap" class="arr-canvas-wrap card" data-guide="arrange-canvas">
      <canvas ref="cv" class="arr-canvas"
              @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
              @dblclick="onDblClick" @wheel="onWheel" />
      <div v-if="!song" class="arr-empty">{{ t('还没有载入曲目') }}</div>
    </div>
  </div>
</template>

<style scoped>
.arrange-page { display: flex; flex-direction: column; gap: var(--sp-2); height: 100%; min-height: 0; }
.arr-toolbar { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); flex-wrap: wrap; }
.arr-stat { color: var(--muted); }
.arr-grow { flex: 1; }
.arr-canvas-wrap { position: relative; flex: 1; min-height: 0; overflow: auto; padding: 0; }
.arr-canvas { display: block; width: 100%; cursor: pointer; }
.arr-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); }
</style>

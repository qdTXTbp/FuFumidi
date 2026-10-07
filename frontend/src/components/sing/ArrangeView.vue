// -*- coding: utf-8 -*-
<template>
  <!--
    编排时间线（对齐 OpenUTAU 的「轨道行 → part 块」两级视图）：
    每条轨一行，part 块铺在时间轴上；双击块进入卷帘聚焦，拖动块平移整段音符。
    纯 canvas 绘制（轨多/块多时性能好），交互命中用几何计算（hitTest）。
  -->
  <div class="arr" ref="rootEl">
    <canvas ref="cv" @pointerdown="onDown" @pointermove="onMove"
            @pointerup="onUp" @pointercancel="onUp" @dblclick="onDbl"
            @wheel="onWheel" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { partClusters, PART_GAP_BEATS } from '../../core/arrange.js';

const props = defineProps({
  /** [{id,name,kind,color,notes,partStarts,hidden,muted}]（kind==='audio' 的轨画音频条） */
  tracks: { type: Array, default: () => [] },
  bpm: { type: Number, default: 120 },
  playheadBeat: { type: Number, default: 0 },
  beatsPerBar: { type: Number, default: 4 },
  activeTrackId: { type: String, default: '' },
  /** 横向像素/拍（独立于卷帘的缩放） */
  pxPerBeat: { type: Number, default: 10 },
});
const emit = defineEmits(['pick-track', 'open-part', 'move-part']);

const ROW_H = 56;          // 每轨行高
const RULER_H = 22;        // 顶部标尺
const HEAD_W = 110;        // 左侧轨头固定宽
const PAD_TOP = 6;

const rootEl = ref(null);
const cv = ref(null);
let ctx = null;
let dpr = 1;
let ro = null;

/** px → 拍（时间轴区从 HEAD_W 开始） */
const beatOfX = (x) => Math.max(0, (x - HEAD_W) / props.pxPerBeat);
const xOfBeat = (b) => HEAD_W + b * props.pxPerBeat;

/** 内容总拍数：最大音符 end / 播放头，留 8 拍余量 */
const totalBeats = computed(() => {
  let m = 32;
  for (const t of props.tracks) {
    for (const n of (t.notes || [])) {
      if (n && Number.isFinite(n.startBeat)) m = Math.max(m, n.startBeat + (n.durBeat || 1));
    }
  }
  return Math.max(m, props.playheadBeat + 8);
});

const rowOfY = (y) => {
  const i = Math.floor((y - PAD_TOP - RULER_H) / ROW_H);
  return (i >= 0 && i < props.tracks.length) ? i : -1;
};

/** 每条轨的 part 区间（缓存：notes/partStarts 变了才重算） */
const clustersByTrack = computed(() => props.tracks.map((t) => ({
  id: t.id,
  parts: partClusters(t.notes, t.partStarts || [], PART_GAP_BEATS),
})));

/* ---------------------------------------------------------------- 绘制 */

function draw() {
  const c = cv.value;
  if (!c || !ctx) return;
  const w = c.clientWidth, h = c.clientHeight;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(rootEl.value);
  const bg = css.getPropertyValue('--arr-bg').trim() || '#1c1f26';
  const line = css.getPropertyValue('--arr-line').trim() || '#2a2f3a';
  const txt = css.getPropertyValue('--arr-txt').trim() || '#aab3c5';
  const dim = css.getPropertyValue('--arr-dim').trim() || '#5b6474';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // ---- 时间轴区：小节网格
  const bpb = Math.max(1, props.beatsPerBar);
  const px = props.pxPerBeat;
  ctx.lineWidth = 1;
  let beat = 0;
  // 小节从 0 开始；密度上限：一格至少 8px
  const barPx = bpb * px;
  if (barPx >= 6) {
    ctx.strokeStyle = line;
    ctx.beginPath();
    for (let bar = 0; xOfBeat(bar * bpb) < w; bar++) {
      const x = Math.round(xOfBeat(bar * bpb)) + 0.5;
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, h);
    }
    ctx.stroke();
  }
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = dim;
  for (let bar = 0; xOfBeat(bar * bpb) < w; bar++) {
    const x = xOfBeat(bar * bpb) + 3;
    if (barPx >= 26 || bar % 2 === 0) ctx.fillText(String(bar + 1), x, PAD_TOP + 13);
  }

  // ---- 每轨一行
  props.tracks.forEach((t, i) => {
    const y = PAD_TOP + RULER_H + i * ROW_H;
    if (y + ROW_H < 0 || y > h) return;
    // 行底（选中轨高亮）
    const active = t.id === props.activeTrackId;
    ctx.fillStyle = active ? (css.getPropertyValue('--arr-rowon').trim() || 'rgba(90,140,255,.10)')
                           : 'rgba(255,255,255,.02)';
    ctx.fillRect(0, y, w, ROW_H - 4);
    // 轨头
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, HEAD_W - 6, ROW_H - 4);
    ctx.clip();
    ctx.fillStyle = t.color || '#5a8cff';
    ctx.beginPath();
    ctx.arc(12, y + ROW_H / 2 - 4, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = txt;
    ctx.font = '11px system-ui, sans-serif';
    const label = (t.name || (t.kind === 'audio' ? '音频' : 'Track')) + (t.muted ? ' 🔇' : '');
    ctx.fillText(String(label).slice(0, 14), 22, y + ROW_H / 2 - 8);
    ctx.fillStyle = dim;
    ctx.font = '9px system-ui, sans-serif';
    const kindTag = t.kind === 'audio' ? 'AUDIO' : (t.engine === 'diffsinger' ? 'DIFFSINGER' : 'UTAU');
    ctx.fillText(kindTag, 22, y + ROW_H / 2 + 7);
    ctx.restore();
    // 行底色横线（轨头右侧起）
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(0, y + ROW_H - 2.5);
    ctx.lineTo(w, y + ROW_H - 2.5);
    ctx.stroke();

    // ---- part 块
    const cl = clustersByTrack.value[i];
    const drag = (dragState && dragState.trackId === t.id) ? dragState : null;
    for (const p of (cl ? cl.parts : [])) {
      const x0 = xOfBeat(p.from) + (drag ? drag.dBeat * px : 0);
      const x1 = xOfBeat(p.to) + (drag ? drag.dBeat * px : 0);
      drawPart(t, x0, x1, y, css, drag);
    }
    if (t.kind === 'audio' && !cl?.parts.length && t.audioBeats > 0) {
      drawPart(t, xOfBeat(0), xOfBeat(t.audioBeats), y, css, null);
    }
  });

  // ---- 播放头（贯穿）
  const px2 = xOfBeat(props.playheadBeat);
  if (px2 >= HEAD_W - 2 && px2 <= w) {
    ctx.strokeStyle = '#ff7a6b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px2 + 0.5, PAD_TOP);
    ctx.lineTo(px2 + 0.5, h);
    ctx.stroke();
    ctx.fillStyle = '#ff7a6b';
    ctx.beginPath();
    ctx.moveTo(px2 - 5, PAD_TOP);
    ctx.lineTo(px2 + 5, PAD_TOP);
    ctx.lineTo(px2, PAD_TOP + 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawPart(t, x0, x1, y, css, drag) {
  if (x1 <= HEAD_W || x0 >= ctx.canvas.clientWidth) return;
  const h = ROW_H - 12;
  const yy = y + 4;
  const w = Math.max(6, x1 - x0);
  const color = t.color || '#5a8cff';
  ctx.save();
  // 圆角色块（半透明底 + 实色描边）
  ctx.globalAlpha = t.muted ? 0.35 : (t.hidden ? 0.4 : 1);
  roundRect(x0, yy, w, h, 6);
  ctx.fillStyle = hexA(color, 0.30);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // 迷你音符预览：块内按音高相对范围画白色小块（对齐 OpenUTAU 的观感）
  const fromBeat = (x0 - HEAD_W) / props.pxPerBeat;
  const spanBeats = (x1 - x0) / props.pxPerBeat;
  const notes = (t.notes || []).filter((n) => n && Number.isFinite(n.startBeat)
    && n.startBeat >= fromBeat - 0.01 && n.startBeat < fromBeat + spanBeats + 0.01);
  if (notes.length && w > 12) {
    let lo = 127, hi = 0;
    for (const n of notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
    if (hi - lo < 6) { lo -= 3; hi += 3; }
    ctx.globalAlpha *= 0.9;
    ctx.fillStyle = '#ffffff';
    const pad = 4;
    for (const n of notes) {
      const nx = x0 + pad + (n.startBeat - (x0 - HEAD_W) / props.pxPerBeat) * props.pxPerBeat;
      const nw = Math.max(2, Math.min((n.durBeat || 1) * props.pxPerBeat - 1, x1 - nx - 1));
      if (nw <= 1) continue;
      const nh = Math.max(2, h * 0.09);
      const ny = yy + pad + (hi - n.pitch) / Math.max(1, hi - lo) * (h - pad * 2 - nh);
      ctx.fillRect(nx, ny, Math.min(nw, 30), nh);
    }
  }
  if (drag) {   // 拖动中的块加高亮描边
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    roundRect(x0, yy, w, h, 6);
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(90,140,255,${a})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

/* ---------------------------------------------------------------- 命中/交互 */

function hitTest(x, y) {
  const ti = rowOfY(y);
  if (ti < 0) return null;
  const t = props.tracks[ti];
  const beat = beatOfX(x);
  const parts = clustersByTrack.value[ti].parts;
  for (const p of parts) {
    if (beat >= p.from && beat <= p.to) return { trackId: t.id, trackIdx: ti, part: p };
  }
  return null;
}

let dragState = null;   // { trackId, from, to, dBeat, x0 }
let moved = false;

function onDown(e) {
  const rect = cv.value.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const hit = hitTest(x, y);
  emit('pick-track', hit ? hit.trackId : (props.tracks[rowOfY(y)]?.id || ''));
  if (!hit) return;
  dragState = { trackId: hit.trackId, from: hit.part.from, to: hit.part.to, dBeat: 0, x0: x };
  moved = false;
  cv.value.setPointerCapture(e.pointerId);
}

function onMove(e) {
  if (!dragState) return;
  const rect = cv.value.getBoundingClientRect();
  const dBeat = Math.round((e.clientX - rect.left - dragState.x0) / props.pxPerBeat);
  if (!moved && Math.abs(e.clientX - rect.left - dragState.x0) < 4) return;
  // 不允许拖出左边界
  dragState.dBeat = Math.max(-dragState.from, dBeat);
  moved = dragState.dBeat !== 0;
  draw();
}

function onUp() {
  if (dragState && moved) {
    emit('move-part', {
      trackId: dragState.trackId,
      from: dragState.from, to: dragState.to,
      delta: dragState.dBeat,
    });
  }
  dragState = null;
  moved = false;
  draw();
}

function onDbl(e) {
  const rect = cv.value.getBoundingClientRect();
  const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (hit) emit('open-part', hit);
}

/** 滚轮 = 横向滚动（触控板原生横向也走这里） */
function onWheel(e) {
  const el = rootEl.value;
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { el.scrollLeft += e.deltaX; return; }
  el.scrollLeft += e.deltaY;
}

/* ---------------------------------------------------------------- 尺寸/生命周期 */

function resize() {
  const c = cv.value;
  if (!c) return;
  dpr = window.devicePixelRatio || 1;
  c.width = Math.max(600, totalBeats.value * props.pxPerBeat + HEAD_W) * dpr;
  c.height = (PAD_TOP + RULER_H + props.tracks.length * ROW_H + 8) * dpr;
  c.style.width = Math.max(600, totalBeats.value * props.pxPerBeat + HEAD_W) + 'px';
  c.style.height = (PAD_TOP + RULER_H + props.tracks.length * ROW_H + 8) + 'px';
  ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

watch([() => props.tracks, () => props.playheadBeat, () => props.activeTrackId,
       () => props.pxPerBeat, clustersByTrack], () => resize(), { deep: false });
watch(() => props.playheadBeat, draw);

onMounted(() => {
  resize();
  ro = new ResizeObserver(() => draw());
  ro.observe(rootEl.value);
});
onBeforeUnmount(() => { if (ro) ro.disconnect(); });

defineExpose({ draw, resize });
</script>

<style scoped>
.arr {
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid var(--bd, #2a2f3a);
  border-radius: 8px;
  background: var(--arr-bg, #1c1f26);
}
.arr canvas { display: block; }
</style>

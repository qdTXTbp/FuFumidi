<script setup lang="ts">
// ============================================================
// 参数曲线编辑器（M6，借 Synthesizer V / VOCALOID 的参数曲线）
// ============================================================
// ★ 为什么要有它：音高曲线以前只有「加点 / 清空 + 两个数字输入框」——
//   要画一条渐滑得先想清楚第几拍多少音分，再一个个敲进去。这里把它变成**能画的曲线**：
//   画笔 / 直线 / 橡皮 / 平滑，拖到哪改到哪。
//
// 数据契约：points = [{ beat, value }]（音高偏差用 cent）。
// 本组件只管「画」和「改本地副本」，落库交给父组件：
//   拖动过程中 emit('preview')，抬手才 emit('commit') —— 于是一次拖拽 = 一个撤销点。
//   （store.setPitchCurve 每次调用都会 pushUndo，逐帧提交会把撤销栈冲爆。）
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { t } from '../../core/i18n.js';
/* 手写笔 / 触控（M9 收尾）：掌侧误触与第二根手指（曲线是"一路画过去"，被抢指针就会断线） */
import { claimPointer, isPrimaryPointer, releasePointer } from '../../core/pointer.js';

const props = defineProps({
  points: { type: Array, default: () => [] },
  min: { type: Number, default: -1200 },
  max: { type: Number, default: 1200 },
  beats: { type: Number, default: 16 },
  beatsPerBar: { type: Number, default: 4 },
  tool: { type: String, default: 'draw' },     // draw | line | erase
  unit: { type: String, default: 'cent' },
  height: { type: Number, default: 150 },
  snap: { type: Number, default: 0 },           // >0 时落点吸附到这个拍长（0 = 不吸）
  locked: { type: Boolean, default: false },    // 锁定后只读（防「只是想看看」时误改）
  /* 叠加参考轨（M6c 收尾）：把**另一条轨的同名曲线**画成灰线做对照。
     只读、不参与命中判定 —— 于是"看着别人的曲线调自己的"不会误改参考轨。 */
  ghostPoints: { type: Array, default: () => [] },
  ghostLabel: { type: String, default: '' },
});
const emit = defineEmits(['preview', 'commit']);

const wrap = ref<HTMLCanvasElement | null>(null);
const local = ref<{ beat: number; value: number }[]>([]);
const hover = ref<{ beat: number; value: number } | null>(null);
let ro: ResizeObserver | null = null;
let dragging = false;
let lineAnchor: { beat: number; value: number } | null = null;
let snapshot: { beat: number; value: number }[] = [];   // 拖拽起点（Esc 可回退）

function clone(pts: any[]) {
  return (pts || []).map((p: any) => ({ beat: Number(p.beat) || 0, value: Number(p.value ?? p.cents) || 0 }))
    .sort((a, b) => a.beat - b.beat);
}
watch(() => props.points, (v) => { if (!dragging) local.value = clone(v); }, { deep: true });
watch(() => props.ghostPoints, () => { draw(); }, { deep: true });
onMounted(() => { local.value = clone(props.points); if (typeof ResizeObserver !== 'undefined' && wrap.value) { ro = new ResizeObserver(() => draw()); ro.observe(wrap.value); } nextTick(draw); });
onBeforeUnmount(() => { if (ro) { ro.disconnect(); ro = null; } });

/* ---------------- 坐标换算 ---------------- */
const W = () => (wrap.value ? wrap.value.clientWidth : 600);
const H = () => props.height;
const span = () => Math.max(1, props.beats);
const xOf = (beat: number) => (beat / span()) * W();
const yOf = (v: number) => H() - ((v - props.min) / (props.max - props.min)) * H();
const beatAt = (x: number) => Math.max(0, Math.min(span(), (x / Math.max(1, W())) * span()));
const valAt = (y: number) => Math.max(props.min, Math.min(props.max, props.min + (1 - y / H()) * (props.max - props.min)));

function snapBeat(b: number) {
  return props.snap > 0 ? Math.round(b / props.snap) * props.snap : Math.round(b * 1000) / 1000;
}

/* ---------------- 绘制 ---------------- */
function draw() {
  const cv = wrap.value; if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, W()), h = H();
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext('2d'); if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = (n: string, fb: string) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  const hair = css('--hairline', '#e6e6e6'), stone = css('--stone', '#9aa0a6'), accent = css('--accent', '#ff5530');
  const ink = css('--ink', '#111');
  g.fillStyle = css('--surface-soft', '#fafafa'); g.fillRect(0, 0, w, h);
  // 小节线 + 拍线
  const per = Math.max(0.25, props.beatsPerBar || 4);
  g.strokeStyle = hair; g.lineWidth = 1;
  for (let b = 0; b <= span() + 1e-6; b += 1) {
    const x = Math.round(xOf(b)) + 0.5;
    const bar = Math.abs(b % per) < 1e-6;
    g.globalAlpha = bar ? 0.9 : 0.45;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  g.globalAlpha = 1;
  // 0 线与量程刻度
  g.strokeStyle = stone; g.globalAlpha = 0.6; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(0, Math.round(yOf(0)) + 0.5); g.lineTo(w, Math.round(yOf(0)) + 0.5); g.stroke();
  g.setLineDash([]); g.globalAlpha = 1;
  g.fillStyle = stone; g.font = '10px monospace'; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillText(String(props.max) + ' ' + props.unit, 4, 3);
  g.fillText(String(props.min), 4, h - 12);
  /* 参考轨（灰线）画在主曲线**之前**：它是背景对照，不该压住正在编辑的那条。
     同样走"二次贝塞尔取中点"的平滑，保持这套视觉语言的连续性要求。 */
  const ghost = clone(props.ghostPoints || []);
  if (ghost.length) {
    const gx = (b: number) => xOf(b), gy = (v: number) => yOf(v);
    g.globalAlpha = 0.55; g.strokeStyle = stone; g.lineWidth = 1.6;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    if (ghost.length === 1) { g.arc(gx(ghost[0].beat), gy(ghost[0].value), 2, 0, Math.PI * 2); g.fillStyle = stone; g.fill(); }
    else {
      g.moveTo(gx(ghost[0].beat), gy(ghost[0].value));
      for (let i = 1; i < ghost.length - 1; i++) {
        const x1 = gx(ghost[i].beat), y1 = gy(ghost[i].value);
        const x2 = gx(ghost[i + 1].beat), y2 = gy(ghost[i + 1].value);
        g.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
      }
      const gl = ghost[ghost.length - 1];
      g.lineTo(gx(gl.beat), gy(gl.value));
      g.stroke();
    }
    g.globalAlpha = 1;
    if (props.ghostLabel) {
      g.fillStyle = stone; g.font = '10px monospace'; g.textAlign = 'right'; g.textBaseline = 'top';
      g.fillText(t('参考：') + props.ghostLabel, w - 4, 3);
      g.textAlign = 'left';
    }
  }
  // 曲线：二次贝塞尔取中点（**不许用 lineTo 连折线**，连续性是这套视觉语言的硬要求）
  const pts = local.value;
  if (pts.length) {
    g.strokeStyle = accent; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    if (pts.length === 1) { g.arc(xOf(pts[0].beat), yOf(pts[0].value), 2.5, 0, Math.PI * 2); g.fillStyle = accent; g.fill(); }
    else {
      g.moveTo(xOf(pts[0].beat), yOf(pts[0].value));
      for (let i = 1; i < pts.length - 1; i++) {
        const x1 = xOf(pts[i].beat), y1 = yOf(pts[i].value);
        const x2 = xOf(pts[i + 1].beat), y2 = yOf(pts[i + 1].value);
        g.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
      }
      const last = pts[pts.length - 1];
      g.lineTo(xOf(last.beat), yOf(last.value));
      g.stroke();
      g.fillStyle = ink;
      for (const p of pts) {
        if (xOf(p.beat) < -6 || xOf(p.beat) > w + 6) continue;
        g.beginPath(); g.arc(xOf(p.beat), yOf(p.value), 2.2, 0, Math.PI * 2); g.fill();
      }
    }
  }
  // 悬停读数
  if (hover.value) {
    const hx = xOf(hover.value.beat), hy = yOf(hover.value.value);
    g.strokeStyle = accent; g.globalAlpha = 0.35;
    g.beginPath(); g.moveTo(hx, 0); g.lineTo(hx, h); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = accent; g.beginPath(); g.arc(hx, hy, 3.2, 0, Math.PI * 2); g.fill();
    const label = hover.value.beat.toFixed(2) + ' ' + t('拍') + ' · ' + Math.round(hover.value.value) + ' ' + props.unit;
    g.font = '10px monospace'; g.textAlign = 'right'; g.textBaseline = 'bottom';
    const tw = g.measureText(label).width + 8;
    g.fillStyle = css('--canvas', '#fff'); g.globalAlpha = 0.9;
    g.fillRect(w - tw - 4, h - 16, tw, 14); g.globalAlpha = 1;
    g.fillStyle = ink; g.fillText(label, w - 8, h - 3);
  }
  if (!pts.length) {
    g.fillStyle = stone; g.font = '11px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t('在网格上拖动即可画曲线（画笔 = 随手画，直线 = 两点之间插值，橡皮 = 擦掉经过的点）'), w / 2, h / 2);
  }
}

/* ---------------- 编辑 ---------------- */
function pos(e: PointerEvent) {
  const cv = wrap.value!;
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
/** 写入一个点：同一拍附近已有就替换，保证按 beat 有序 */
function putPoint(beat: number, value: number) {
  const b = snapBeat(beat);
  const arr = local.value.filter((p) => Math.abs(p.beat - b) > 0.02);
  arr.push({ beat: b, value });
  arr.sort((a, b2) => a.beat - b2.beat);
  local.value = arr;
}
function eraseNear(beat: number) {
  const win = span() / Math.max(1, W()) * 8;
  const arr = local.value.filter((p) => Math.abs(p.beat - beat) > win);
  if (arr.length !== local.value.length) local.value = arr;
}
function lineFrom(anchor: { beat: number; value: number }, to: { beat: number; value: number }) {
  const a = Math.min(anchor.beat, to.beat), b = Math.max(anchor.beat, to.beat);
  const step = span() / Math.max(1, W()) * 4;
  const arr = local.value.filter((p) => p.beat < a - 1e-6 || p.beat > b + 1e-6);
  for (let x = a; x <= b + 1e-9; x += step) {
    const k = b - a < 1e-9 ? 1 : (x - anchor.beat) / (to.beat - anchor.beat);
    arr.push({ beat: Math.round(x * 1000) / 1000, value: anchor.value + (to.value - anchor.value) * Math.max(0, Math.min(1, k)) });
  }
  arr.sort((p, q) => p.beat - q.beat);
  local.value = arr;
}
function onDown(e: PointerEvent) {
  if (!claimPointer(e)) return;
  if (props.locked) return;
  const p = pos(e);
  const beat = beatAt(p.x), value = valAt(p.y);
  dragging = true;
  snapshot = clone(local.value);
  try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch (err) {}
  if (props.tool === 'erase') eraseNear(beat);
  else if (props.tool === 'line') { lineAnchor = { beat: snapBeat(beat), value }; putPoint(beat, value); }
  else putPoint(beat, value);
  hover.value = { beat, value };
  emit('preview', clone(local.value));
  draw();
}
function onMove(e: PointerEvent) {
  if (!isPrimaryPointer(e)) return;
  const p = pos(e);
  if (props.locked) {
    // 锁定时仍然给读数（可以量、不能改）
    hover.value = { beat: beatAt(p.x), value: valAt(p.y) };
    draw();
    return;
  }
  const beat = beatAt(p.x), value = valAt(p.y);
  hover.value = { beat, value };
  if (!dragging) { draw(); return; }
  if (props.tool === 'erase') eraseNear(beat);
  else if (props.tool === 'line' && lineAnchor) lineFrom(lineAnchor, { beat: snapBeat(beat), value });
  else putPoint(beat, value);
  emit('preview', clone(local.value));
  draw();
}
function onUp(e?: PointerEvent) {
  if (!releasePointer(e)) return;             // 被挡掉的指针抬起不收尾
  if (!dragging) return;
  dragging = false; lineAnchor = null;
  emit('commit', clone(local.value));
  draw();
}
function onLeave() { hover.value = null; if (!dragging) draw(); }

/* ---------------- 对外动作（父组件的工具条调用） ---------------- */
function smooth() {
  const pts = clone(local.value); if (pts.length < 3) return;
  const out = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    return { beat: p.beat, value: Math.round((a.value + 2 * p.value + b.value) / 4) };
  });
  local.value = out; emit('commit', clone(out)); draw();
}
function quantize(grid: number) {
  if (!(grid > 0)) return;
  const out = clone(local.value).map((p) => ({ beat: Math.round(p.beat / grid) * grid, value: p.value }))
    .sort((a, b) => a.beat - b.beat)
    .filter((p, i, arr) => i === 0 || Math.abs(p.beat - arr[i - 1].beat) > 1e-6);
  local.value = out; emit('commit', clone(out)); draw();
}
function revert() { local.value = clone(snapshot); draw(); emit('commit', clone(local.value)); }
defineExpose({ smooth, quantize, revert, pointCount: () => local.value.length });
</script>

<template>
  <div class="cc-wrap">
    <canvas ref="wrap" class="cc-canvas" :class="{ locked: locked }" :style="{ height: height + 'px' }"
            @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onLeave"></canvas>
  </div>
</template>

<style scoped>
.cc-wrap { width: 100%; }
.cc-canvas { width: 100%; display: block; border: 1px solid var(--hairline); border-radius: 10px; cursor: crosshair; touch-action: none; background: var(--surface-soft); }
.cc-canvas.locked { cursor: not-allowed; opacity: .92; }
</style>

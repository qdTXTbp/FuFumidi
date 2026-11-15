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
            @contextmenu.prevent="onCtx" @wheel="onWheel" />
  </div>
</template>

<script setup>
import { themeColor } from '../../core/palette.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { partClusters, PART_GAP_BEATS } from '../../core/arrange.js';
import { paramById } from '../../core/param_registry.js';
import { trimClip } from '../../core/automation_clip.js';
import { squirclePath } from '../../core/canvas_shape.js';

const props = defineProps({
  /** [{id,name,kind,color,notes,partStarts,hidden,muted}]（kind==='audio' 的轨画音频条） */
  tracks: { type: Array, default: () => [] },
  bpm: { type: Number, default: 120 },
  playheadBeat: { type: Number, default: 0 },
  beatsPerBar: { type: Number, default: 4 },
  activeTrackId: { type: String, default: '' },
  /** 横向像素/拍（独立于卷帘的缩放） */
  pxPerBeat: { type: Number, default: 10 },
  /** ★ 卷帘当前可视区间（拍）——对齐 PartControl.cs:243-257：在活动轨的块上
   *  画白色视口框，时间线上能看出"卷帘正在看哪一段" */
  rollViewport: { type: Object, default: null },   // { fromBeat, toBeat }
  /** Playlist 一级自动化片段（FLAD-04）：{id,trackId,parameterId,points,startBeat,endBeat,loop,gain} */
  clips: { type: Array, default: () => [] },
  selectedClipId: { type: String, default: '' },
});
const emit = defineEmits(['pick-track', 'open-part', 'move-part',
  'select-clip', 'clip-drag-start', 'move-clip', 'resize-clip', 'clip-drag-end', 'clip-menu']);

const ROW_H = 72;          // 每轨行高（含底部自动化条带）
const AUTOM_H = 16;        // 自动化条带高度
const RULER_H = 22;        // 顶部标尺
const HEAD_W = 110;        // 左侧轨头固定宽
const PAD_TOP = 6;
/** 自动化条带顶边（相对行顶） */
const BAND_TOP = ROW_H - AUTOM_H - 4;

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
      const isDragged = !!(drag && drag.moved && p.from === drag.from && p.to === drag.to);
      if (isDragged) {
        // ★ 跨轨拖动：原位画虚影，块画到目标行（对齐 OpenUTAU 的移动观感）
        ctx.save();
        ctx.globalAlpha = 0.25;
        drawPart(t, xOfBeat(p.from), xOfBeat(p.to), y, css, null);
        ctx.restore();
        const ty = y + drag.dTrack * ROW_H;
        drawPart(t, xOfBeat(p.from) + drag.dBeat * px, xOfBeat(p.to) + drag.dBeat * px,
                 ty, css, drag);
      } else {
        const vp = (t.id === props.activeTrackId && props.rollViewport)
          ? props.rollViewport : null;
        drawPart(t, xOfBeat(p.from), xOfBeat(p.to), y, css, null, vp);
      }
    }
    if (t.kind === 'audio' && !cl?.parts.length && t.audioBeats > 0) {
      drawPart(t, xOfBeat(0), xOfBeat(t.audioBeats), y, css, null);
    }
    // ---- 自动化条带（一级 clip）
    drawAutomationBand(t, y);
  });

  // ---- 播放头（贯穿）
  const px2 = xOfBeat(props.playheadBeat);
  if (px2 >= HEAD_W - 2 && px2 <= w) {
    ctx.strokeStyle = themeColor('--t-err', '#ff7a6b');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px2 + 0.5, PAD_TOP);
    ctx.lineTo(px2 + 0.5, h);
    ctx.stroke();
    ctx.fillStyle = themeColor('--t-err', '#ff7a6b');
    ctx.beginPath();
    ctx.moveTo(px2 - 5, PAD_TOP);
    ctx.lineTo(px2 + 5, PAD_TOP);
    ctx.lineTo(px2, PAD_TOP + 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawPart(t, x0, x1, y, css, drag, viewport = null) {
  if (x1 <= HEAD_W || x0 >= ctx.canvas.clientWidth) return;
  const h = ROW_H - AUTOM_H - 12;
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
    // ★ 对齐 PartControl.cs:228-234：音高跨度不足 **52 半音**时向两侧平均扩展，
    //   保证不同歌段的迷你预览纵向比例一致（不是我们自创的 ±3）。
    let lo = 127, hi = 0;
    for (const n of notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
    if (hi - lo < 52) {
      const add = Math.floor((52 - (hi - lo)) / 2);
      lo -= add; hi += add;
    }
    ctx.globalAlpha *= 0.9;
    ctx.fillStyle = themeColor('--t-text', '#ffffff');   // 面板底色跟随主题，白音符在浅色档会消失
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
  // ★ 卷帘视口联动框（PartControl.cs:243-257）：白色半透明矩形标出卷帘正看到的区间
  if (viewport && Number.isFinite(viewport.fromBeat) && Number.isFinite(viewport.toBeats)) {
    const vx0 = Math.max(x0, xOfBeat(viewport.fromBeat));
    const vx1 = Math.min(x1, xOfBeat(viewport.toBeats));
    if (vx1 > vx0 + 1) {
      const inset = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.11)';
      ctx.strokeStyle = themeColor('--t-text', '#ffffff');
      ctx.lineWidth = 2;
      roundRect(x0 + inset + (vx0 - x0), yy + inset, vx1 - vx0, h - inset * 2, 3);
      ctx.fill();
      ctx.stroke();
    }
  }
  if (drag) {   // 拖动中的块加高亮描边
    ctx.strokeStyle = themeColor('--t-text', '#ffffff');
    ctx.lineWidth = 1.6;
    roundRect(x0, yy, w, h, 6);
    ctx.stroke();
  }
  ctx.restore();
}

/** 轨道行底部的自动化条带：clip 矩形 + 迷你折线 + 循环标记 */
function drawAutomationBand(t, y) {
  const W = ctx.canvas.clientWidth;
  const bandY = y + BAND_TOP;
  ctx.fillStyle = 'rgba(255,255,255,.035)';
  ctx.fillRect(HEAD_W, bandY, Math.max(0, W - HEAD_W), AUTOM_H);
  const list = (props.clips || []).filter((c) => c && c.trackId === t.id);
  for (const c of list) {
    const x0 = xOfBeat(c.startBeat), x1 = xOfBeat(c.endBeat);
    if (x1 <= HEAD_W || x0 >= W) continue;
    const left = Math.max(HEAD_W, x0), right = Math.min(W, x1);
    if (right - left < 2) continue;
    const sel = c.id === props.selectedClipId;
    const param = paramById(c.parameterId);
    const color = themeColor('--accent-sapphire', '#5b8def');
    ctx.save();
    roundRect(left, bandY + 1, Math.max(3, right - left), AUTOM_H - 2, 3);
    ctx.fillStyle = hexA(color, sel ? 0.42 : 0.26);
    ctx.fill();
    ctx.strokeStyle = sel ? themeColor('--t-text', '#ffffff') : hexA(color, 0.8);
    ctx.lineWidth = sel ? 1.5 : 1;
    ctx.stroke();
    const pts = Array.isArray(c.points) ? c.points : [];
    if (pts.length && right - left > 8) {
      const lo = param ? param.min : 0, hi = param ? param.max : 1;
      const span = Math.max(1e-6, hi - lo);
      const len = Math.max(1e-6, c.endBeat - c.startBeat);
      const yOf = (v) => bandY + AUTOM_H - 3 - ((Number(v) - lo) / span) * (AUTOM_H - 6);
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const local = Math.max(0, Math.min(len, Number(p && p.beat) || 0));
        const px = xOfBeat(c.startBeat + local);
        if (px < left - 1 || px > right + 1) continue;
        if (!started) { ctx.moveTo(px, yOf(p.value)); started = true; }
        else ctx.lineTo(px, yOf(p.value));
      }
      if (started) {
        ctx.strokeStyle = sel ? themeColor('--t-text', '#ffffff') : hexA(color, 0.95);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // 淡化：从条带底边斜拉到顶端，直观看出过渡长度
    const finPx = Math.max(0, (Number(c.fadeIn) || 0) * props.pxPerBeat);
    const foutPx = Math.max(0, (Number(c.fadeOut) || 0) * props.pxPerBeat);
    if (finPx > 0.5 || foutPx > 0.5) {
      ctx.save();
      ctx.strokeStyle = hexA(color, 0.95);
      ctx.lineWidth = 1;
      if (finPx > 0.5) {
        const fx = Math.min(right, left + finPx);
        ctx.beginPath(); ctx.moveTo(left + 0.5, bandY + AUTOM_H - 2);
        ctx.lineTo(fx, bandY + 1.5); ctx.stroke();
      }
      if (foutPx > 0.5) {
        const fx = Math.max(left, right - foutPx);
        ctx.beginPath(); ctx.moveTo(fx, bandY + 1.5);
        ctx.lineTo(right - 0.5, bandY + AUTOM_H - 2); ctx.stroke();
      }
      ctx.restore();
    }
    if (right - left > 26) {
      ctx.fillStyle = themeColor('--t-text', '#ffffff');
      ctx.font = '8px system-ui, sans-serif';
      const label = c.name || (param ? param.label : c.parameterId);
      ctx.fillText(String(label).slice(0, 10), left + 3, bandY + AUTOM_H - 5);
    }
    if (c.loop && right - left > 14) {
      // 循环边界虚线：看得出内容在放置区间里重复了几次
      const lenPx = Math.max(2, (c.endBeat - c.startBeat) * props.pxPerBeat);
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = hexA(color, 0.6);
      ctx.lineWidth = 1;
      for (let px = xOfBeat(c.startBeat) + lenPx; px < right - 0.5; px += lenPx) {
        if (px <= left + 1) continue;
        ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, bandY + 2);
        ctx.lineTo(Math.round(px) + 0.5, bandY + AUTOM_H - 2); ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = themeColor('--t-text', '#ffffff');
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText('↻', right - 9, bandY + 9);
    }
    ctx.restore();
  }
}

function roundRect(x, y, w, h, r) {
  // 连续曲率：与 DOM 的 corner-shape: squircle 同一套观感
  squirclePath(ctx, x, y, w, h, r);
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(90,140,255,${a})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

/* ---------------------------------------------------------------- 命中/交互 */

/** 自动化条带命中（先于 part：条带在行底部，不会与 part 争夺） */
function hitAutomation(x, y) {
  const ti = rowOfY(y);
  if (ti < 0) return null;
  const yInRow = y - (PAD_TOP + RULER_H + ti * ROW_H);
  if (yInRow < BAND_TOP || yInRow > BAND_TOP + AUTOM_H) return null;
  const t = props.tracks[ti];
  const beat = beatOfX(x);
  const list = (props.clips || []).filter((c) => c && c.trackId === t.id);
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (beat >= c.startBeat && beat <= c.endBeat) {
      // 左右 6px 视为裁剪热区
      const edge = Math.abs(x - xOfBeat(c.startBeat)) <= 6 ? 'start'
        : (Math.abs(x - xOfBeat(c.endBeat)) <= 6 ? 'end' : '');
      return { kind: 'clip', clip: c, trackIdx: ti, edge };
    }
  }
  return null;
}

function hitTest(x, y) {
  const ti = rowOfY(y);
  if (ti < 0) return null;
  const t = props.tracks[ti];
  const beat = beatOfX(x);
  const parts = clustersByTrack.value[ti].parts;
  for (const p of parts) {
    if (beat >= p.from && beat <= p.to) return { kind: 'part', trackId: t.id, trackIdx: ti, part: p };
  }
  return null;
}

let dragState = null;   // { trackId, trackIdx, from, to, dBeat, dTrack, x0, y0 }
let moved = false;
let clipDrag = null;    // { id, origClip, mode, edge, origStart, origEnd, x0, moved, started }

function onDown(e) {
  const rect = cv.value.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const auto = hitAutomation(x, y);
  if (auto) {
    emit('pick-track', auto.clip.trackId);
    emit('select-clip', auto.clip.id);
    clipDrag = {
      id: auto.clip.id, origClip: auto.clip,
      mode: auto.edge ? 'trim' : 'move', edge: auto.edge || '',
      origStart: auto.clip.startBeat, origEnd: auto.clip.endBeat,
      x0: x, moved: false, started: false,
    };
    cv.value.setPointerCapture(e.pointerId);
    draw();
    return;
  }
  const hit = hitTest(x, y);
  emit('pick-track', hit ? hit.trackId : (props.tracks[rowOfY(y)]?.id || ''));
  if (!hit) return;
  // ★ 对齐 PartMoveEditState：拖动支持**跨轨**（deltaTrack，clamp 到轨集合边界）
  dragState = { trackId: hit.trackId, trackIdx: hit.trackIdx, from: hit.part.from,
                to: hit.part.to, dBeat: 0, dTrack: 0, x0: x, y0: y };
  moved = false;
  cv.value.setPointerCapture(e.pointerId);
}

function onMove(e) {
  const rect = cv.value.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (clipDrag) {
    const dx = x - clipDrag.x0;
    if (!clipDrag.moved && Math.abs(dx) < 3) return;
    clipDrag.moved = true;
    if (!clipDrag.started) { clipDrag.started = true; emit('clip-drag-start', clipDrag.id); }
    // 吸附到 1/4 拍
    const d = Math.round((dx / props.pxPerBeat) * 4) / 4;
    if (clipDrag.mode === 'trim') {
      const beat = Math.max(0, (clipDrag.edge === 'start' ? clipDrag.origStart : clipDrag.origEnd) + d);
      const next = trimClip(clipDrag.origClip, clipDrag.edge, beat);
      if (next) emit('resize-clip', next);
      return;
    }
    const startBeat = Math.max(0, clipDrag.origStart + d);
    emit('move-clip', {
      id: clipDrag.id, startBeat,
      endBeat: startBeat + Math.max(0.25, clipDrag.origEnd - clipDrag.origStart),
    });
    return;
  }
  if (!dragState) {
    // 悬停光标：裁剪热区 col-resize，clip 主体 grab
    const hov = hitAutomation(x, y);
    if (cv.value) cv.value.style.cursor = hov ? (hov.edge ? 'col-resize' : 'grab') : 'default';
    return;
  }
  if (!moved && Math.abs(x - dragState.x0) < 4 && Math.abs(y - dragState.y0) < 4) return;
  // 不允许拖出左边界
  dragState.dBeat = Math.max(-dragState.from, Math.round((x - dragState.x0) / props.pxPerBeat));
  // ★ 跨轨（PartMoveEditState.cs:115-125）：deltaTrack clamp 到边界；只允许
  //   voice 块搬到 voice 行（我们的 audio 轨是另一类轨，不能混放）
  let dTrack = rowOfY(y) - dragState.trackIdx;
  const voiceIdx = props.tracks.map((t, i) => (t.kind !== 'audio' ? i : -1)).filter((i) => i >= 0);
  const minI = voiceIdx.indexOf(dragState.trackIdx);
  if (minI < 0) dTrack = 0;
  else dTrack = Math.min(Math.max(dTrack, -minI), voiceIdx.length - 1 - minI);
  dragState.dTrack = dTrack;
  moved = dragState.dBeat !== 0 || dragState.dTrack !== 0;
  draw();
}

function onUp() {
  if (clipDrag) {
    if (clipDrag.started) emit('clip-drag-end', clipDrag.id);
    clipDrag = null;
    draw();
    return;
  }
  if (dragState && moved) {
    const targetIdx = dragState.trackIdx + dragState.dTrack;
    emit('move-part', {
      trackId: dragState.trackId,
      toTrackId: props.tracks[targetIdx]?.id || dragState.trackId,
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
  if (hitAutomation(e.clientX - rect.left, e.clientY - rect.top)) return;
  const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (hit) emit('open-part', hit);
}

/** 自动化 clip 右键：交给父层开菜单（复制/循环/删除） */
function onCtx(e) {
  const rect = cv.value.getBoundingClientRect();
  const hit = hitAutomation(e.clientX - rect.left, e.clientY - rect.top);
  if (!hit) return;
  emit('pick-track', hit.clip.trackId);
  emit('select-clip', hit.clip.id);
  emit('clip-menu', { id: hit.clip.id, x: e.clientX, y: e.clientY });
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
// clip 拖动是逐帧更新：只重绘，不重算画布尺寸
watch([() => props.clips, () => props.selectedClipId], () => draw());

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
  border: 1px solid var(--bd, var(--t-line));
  border-radius: var(--r-md);
  background: var(--arr-bg, var(--canvas));
}
.arr canvas { display: block; }
</style>

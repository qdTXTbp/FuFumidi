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
// P1-13 B1：手势状态机（拖动/拖边/框选/平移/点击的判定与阈值统一走 core/gesture.js）
import { createGestureState, beginGesture, updateGesture, endGesture, INTENTS, isMutatingIntent } from '../core/gesture.js';
// P1-13 B2：撤销/重做走统一历史栈 + C1 命令注册表（菜单/命令面板/快捷键同一份）
import { createTabbedHistoryRegistry } from '../core/history_stack.js';
import { commands, comboOfEvent } from '../core/commands.js';
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
const snap = ref(true);
const arrCtx = ref(null);
const HEADER_W = 160;
const scrollX = ref(0);      // tick
const rowH = 56;
const RULER_H = 26;
let raf = 0;
let gs = createGestureState();       // 当前指针手势（P1-13）
let dragCtx = null;                  // 拖动上下文：clip 原值 + 命中边缘
// P1-13：**分标签页独立撤销栈** —— 每个曲目一个快照栈，切走再切回仍能撤销/重做
const tabHist = createTabbedHistoryRegistry({ limit: 60, maxTabs: 16 });
function tabKey() { return String(app.currentId || 'default'); }
let lastTabKey = tabKey();
let hist = tabHist.forTab(tabKey());
const scrollByTab = new Map();   // 每个标签的横向滚动位置（tick）
const histDepth = ref({ undo: 0, redo: 0 });
const cmdOffs = [];

function snapshotArrange() { return JSON.parse(JSON.stringify(state.value)); }
function syncHist() { histDepth.value = hist.depth(); }
/** 在修改**之前**调用：记下当前状态，供撤销恢复 */
function pushHistory() { hist.push(snapshotArrange()); syncHist(); }
function applyArrange(snap) {
  if (!snap) return false;
  state.value = createArrangeState(snap);
  selected.value = '';
  draw();
  return true;
}
function undoArrange() {
  if (!hist.canUndo()) return false;
  applyArrange(hist.undo(snapshotArrange()));
  syncHist();
  return true;
}
function redoArrange() {
  if (!hist.canRedo()) return false;
  applyArrange(hist.redo(snapshotArrange()));
  syncHist();
  return true;
}
/** 键盘：交给 C1 命令表解析（Mod+Z / Mod+Shift+Z），保证与全局快捷键同一套 */
function onArrangeKey(e) {
  const hits = commands.byKeys(e);
  const cmd = hits.find((c) => c.area === 'arrange');
  if (!cmd) return;
  e.preventDefault();
  e.stopPropagation();
  commands.run(cmd);
}

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
  // 切标签：先把**上一个**标签的滚动位置存起来，再换到该曲目的历史栈（**不清空**，切回可撤销）
  scrollByTab.set(lastTabKey, scrollX.value);
  const key = tabKey();
  lastTabKey = key;
  hist = tabHist.forTab(key);
  syncHist();
  const s = song.value;
  // P1-1c：优先恢复 song.arrange（会话内持久化），没有则按曲目生成默认编排
  state.value = readArrangeFromSong(s) || defaultArrangeState(s);
  scrollX.value = Number(scrollByTab.get(key) || 0);
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
  const H = Math.max(wrap.value ? wrap.value.clientHeight : 0, RULER_H + Math.max(160, rows * rowH + 48));
  const dpr = window.devicePixelRatio || 1;
  if (el.width !== Math.floor(W * dpr) || el.height !== Math.floor(H * dpr)) {
    el.width = Math.floor(W * dpr); el.height = Math.floor(H * dpr);
    el.style.height = H + 'px';
  }
  return { el, g: el.getContext('2d'), W, H, dpr };
}
function xOfTick(tick) { return (tick - scrollX.value) * zoom.value; }
function tickOfX(x) { return scrollX.value + x / zoom.value; }
function snapTick(tick) {
  if (!snap.value) return Math.round(tick);
  const beat = (song.value && song.value.tpb) || 480;
  const step = Math.max(30, beat / 2); // 默认吸到八分音符
  return Math.max(0, Math.round(tick / step) * step);
}

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
    g.fillRect(0, y, HEADER_W, rowH);
    g.fillStyle = tr.mute ? muted : ink;
    g.font = '11px system-ui';
    g.fillText('', 8, y + 16);
    for (const clip of state.value.clips.filter((c) => c.trackId === tr.id)) {
      const x0 = xOfTick(clip.startTick), x1 = xOfTick(clip.endTick);
      if (x1 < 0 || x0 > W) continue;
      const left = Math.max(HEADER_W, x0), right = Math.min(W, x1);
      if (right <= left) continue;
      const sel = selected.value === clip.id;
      const r = 7;
      const trackColor = themeColor('--accent-sky', '#69c8f0');
      g.beginPath();
      g.moveTo(left + r, y + 7); g.arcTo(right, y + 7, right, y + rowH - 7, r);
      g.arcTo(right, y + rowH - 7, left, y + rowH - 7, r);
      g.arcTo(left, y + rowH - 7, left, y + 7, r);
      g.arcTo(left, y + 7, right, y + 7, r);
      g.closePath();
      const grad = g.createLinearGradient(0, y + 7, 0, y + rowH - 7);
      grad.addColorStop(0, sel ? 'rgba(105,200,240,.34)' : 'rgba(47,99,212,.24)');
      grad.addColorStop(1, sel ? 'rgba(47,99,212,.28)' : 'rgba(47,99,212,.13)');
      g.fillStyle = grad; g.fill();
      g.strokeStyle = sel ? trackColor : 'rgba(105,200,240,.48)';
      g.lineWidth = sel ? 2 : 1; g.stroke(); g.lineWidth = 1;
      // 迷你 MIDI 音符预览：trackId tN 对应原曲第 N 条轨，按 clip 源区间裁剪
      const srcTrack = s && s.tracks ? s.tracks[Number(String(clip.trackId).replace(/^t/, ''))] : null;
      if (srcTrack && Array.isArray(srcTrack.notes) && srcTrack.notes.length) {
        const srcStart = clip.offsetTick, srcEnd = clip.offsetTick + clipLen(clip);
        const innerTop = y + 24, innerBot = y + rowH - 9;
        g.save();
        g.beginPath(); g.rect(left + 1, innerTop, Math.max(1, right - left - 2), innerBot - innerTop); g.clip();
        for (const n of srcTrack.notes) {
          if (n.end <= srcStart || n.start >= srcEnd) continue;
          const nx = xOfTick(clip.startTick + (n.start - srcStart));
          const nw = Math.max(1.5, (n.end - n.start) * zoom.value);
          if (nx + nw < left || nx > right) continue;
          const pitch = Math.max(0, Math.min(127, n.midi));
          const ny = innerBot - ((pitch - 24) / 84) * Math.max(6, innerBot - innerTop);
          g.fillStyle = sel ? 'rgba(190,232,255,.78)' : 'rgba(190,232,255,.40)';
          g.fillRect(nx, ny, nw, Math.max(1.5, Math.min(4, (innerBot - innerTop) / 22)));
        }
        g.restore();
      }
      // 标题与边缘握把
      g.fillStyle = ink; g.font = '11px system-ui'; g.textAlign = 'left';
      g.fillText(clip.name || clip.id, left + 9, y + 15);
      g.fillStyle = 'rgba(255,255,255,.45)';
      g.fillRect(left + 2, y + 22, 2, rowH - 30);
    }
  });
  // 空白轨道区：专业编辑器不会把时间线截在最后一条轨，下面保留可滚动的空轨网格
  const tracksBottom = RULER_H + state.value.tracks.length * rowH;
  if (tracksBottom < H) {
    g.fillStyle = 'rgba(0,0,0,.06)';
    g.fillRect(0, tracksBottom, W, H - tracksBottom);
    g.strokeStyle = line;
    for (let yy = tracksBottom + rowH; yy < H; yy += rowH) {
      g.beginPath(); g.moveTo(0, yy + 0.5); g.lineTo(W, yy + 0.5); g.stroke();
    }
  }
  // regions + markers
  for (const rg of state.value.regions) {
    const x0 = xOfTick(rg.startTick), x1 = xOfTick(rg.endTick);
    if (x1 < 0 || x0 > W) continue;
    g.fillStyle = 'rgba(224,108,117,.10)';
    g.fillRect(Math.max(0, x0), RULER_H, Math.min(W, x1) - Math.max(0, x0), H - RULER_H);
  }
  // 标尺拖拽中的区间预览（P1-13：拖宽即框区间，松手才落地）
  if (gs && gs.active && gs.ruler && gs.moved && gs.start && gs.point) {
    const a = Math.min(gs.start.x, gs.point.x), b = Math.max(gs.start.x, gs.point.x);
    g.fillStyle = 'rgba(224,108,117,.16)';
    g.fillRect(Math.max(0, a), RULER_H, Math.min(W, b) - Math.max(0, a), H - RULER_H);
    g.strokeStyle = accent; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(a, RULER_H); g.lineTo(a, H); g.moveTo(b, RULER_H); g.lineTo(b, H); g.stroke(); g.lineWidth = 1;
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
    g.fillStyle = accent;
    g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 8); g.closePath(); g.fill();
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
      const edge = (xOfTick(c.startTick) > HEADER_W && Math.abs(xOfTick(c.startTick) - x) <= 6) ? 'start'
        : (Math.abs(xOfTick(c.endTick) - x) <= 6 ? 'end' : '');
      return { clip: c, edge };
    }
  }
  return null;
}
function onDown(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const inRuler = y < RULER_H;
  const hit = inRuler ? null : hitClip(x, y);
  dragCtx = null;
  if (hit) {
    selected.value = hit.clip.id;
    const { trackIndex } = tickAt(x, y);
    dragCtx = { clipId: hit.clip.id, edge: hit.edge, origStart: hit.clip.startTick, origEnd: hit.clip.endTick, trackIndex };
  } else if (!inRuler) {
    selected.value = '';
  }
  // 命中交给手势状态机判 intent（边缘 6px 内 = resize，空白 = marquee，中键 = pan）
  const hitInfo = hit && {
    bounds: { left: Math.max(HEADER_W, xOfTick(hit.clip.startTick)), right: xOfTick(hit.clip.endTick) },
    edge: hit.edge,
  };
  beginGesture(gs, { point: { x, y }, hit: hitInfo, button: e.button, tool: 'select' });
  gs.ruler = inRuler;
  gs.rulerStartTick = inRuler ? Math.max(0, Math.round(tickOfX(x))) : 0;
  gs.panLastX = x;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
  draw();
}
function onMove(e) {
  if (!gs.active) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  updateGesture(gs, { x, y });
  if (!gs.moved) return;                       // 3px 阈值内还是"点击"
  // 第一次真正移动才记历史：快照是"移动前"的状态，整个手势只记一次（撤销粒度=一次手势）
  if (!gs.historyPushed && !gs.ruler && isMutatingIntent(gs.intent)) {
    pushHistory();
    gs.historyPushed = true;
  }
  if (gs.intent === INTENTS.PAN) {
    const d = x - (gs.panLastX == null ? gs.start.x : gs.panLastX);
    gs.panLastX = x;
    scrollX.value = Math.max(0, scrollX.value - d / zoom.value);
    draw();
    return;
  }
  if (gs.ruler) { draw(); return; }            // 标尺拖拽：onUp 落成区间（draw 里画预览带）
  if (!dragCtx) { draw(); return; }
  const dTick = Math.round(gs.dx / zoom.value);
  if (dragCtx.edge === 'start') {
    state.value = resizeClip(state.value, dragCtx.clipId, 'start', Math.max(0, snapTick(dragCtx.origStart + dTick)));
  } else if (dragCtx.edge === 'end') {
    state.value = resizeClip(state.value, dragCtx.clipId, 'end', Math.max(1, snapTick(dragCtx.origEnd + dTick)));
  } else {
    const row = Math.floor((y - RULER_H) / rowH);
    const tr = state.value.tracks[Math.max(0, Math.min(state.value.tracks.length - 1, row))];
    const patch = { startTick: Math.max(0, snapTick(dragCtx.origStart + dTick)) };
    if (tr) patch.trackId = tr.id;
    state.value = moveClip(state.value, dragCtx.clipId, patch);
  }
  draw();
}
function onUp(e) {
  const wasActive = gs.active;
  const inRuler = gs.ruler;
  const rulerStart = gs.rulerStartTick || 0;
  const end = endGesture(gs);
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
  dragCtx = null;
  if (wasActive && inRuler) {
    if (end.moved && end.end) {
      // 标尺拖拽 = 框一个区间（比"加区间"按钮更直观；太短当点击）
      const tick2 = Math.max(0, Math.round(tickOfX(end.end.x)));
      const a = Math.min(rulerStart, tick2), b = Math.max(rulerStart, tick2);
      if (b - a >= Math.max(10, Math.round(zoom.value > 0 ? 20 / zoom.value : 10))) {
        pushHistory();
        state.value = addRegion(state.value, { name: 'R' + (regionCount.value + 1), startTick: a, endTick: b });
      }
    } else {
      // 点标尺 = seek
      try { const s = song.value; if (s && timeline.value) app.seekSec(secOfTick(timeline.value, rulerStart)); } catch (err) {}
    }
  }
  draw();
}
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
  try { window.__fufumidiArrangeFocus = { trackId: hit.clip.trackId, trackName: (state.value.tracks[idx] || {}).name || '', trackIndex: idx, fromTick: fr.fromTick, toTick: fr.toTick }; } catch (err) {}
  app.setView('edit');
}

/* ---- 专业编辑器交互：轨道 M/S、片段复制、右键菜单 ---- */
function toggleTrackFlag(tr, key) {
  pushHistory();
  state.value = setTrackFlags(state.value, tr.id, { [key]: !tr[key] });
  draw();
}
function duplicateSelected() {
  const c = findClip(state.value, selected.value);
  if (!c) return;
  pushHistory();
  const len = clipLen(c);
  const id = 'clip-' + Date.now();
  state.value = addClip(state.value, { ...c, id, startTick: c.endTick, endTick: c.endTick + len, offsetTick: c.offsetTick, name: (c.name || c.id) + ' copy' });
  selected.value = id;
  draw();
}
function onCtx(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const hit = hitClip(e.clientX - rect.left, e.clientY - rect.top);
  if (!hit) { arrCtx.value = null; return; }
  selected.value = hit.clip.id;
  arrCtx.value = { x: e.clientX, y: e.clientY, clipId: hit.clip.id };
  draw();
}
function closeCtx() { arrCtx.value = null; }
function ctxSplit() { splitAtPlayhead(); closeCtx(); }
function ctxDup() { duplicateSelected(); closeCtx(); }
function ctxDelete() { deleteSelected(); closeCtx(); }
function ctxFocus() { const c = findClip(state.value, arrCtx.value && arrCtx.value.clipId); closeCtx(); if (c) { const fr = focusRangeOfClip(c); const idx = Math.max(0, state.value.tracks.findIndex(tr => tr.id === c.trackId)); try { window.__fufumidiArrangeFocus = { trackId: c.trackId, trackName: (state.value.tracks[idx] || {}).name || '', trackIndex: idx, fromTick: fr.fromTick, toTick: fr.toTick }; } catch (err) {} app.setView('edit'); } }
/* ---- 工具条动作 ---- */
function splitAtPlayhead() {
  if (!selected.value) return;
  pushHistory();
  state.value = splitClip(state.value, selected.value, playTick.value);
  draw();
}
function deleteSelected() {
  if (!selected.value) return;
  pushHistory();
  state.value = removeClip(state.value, selected.value);
  selected.value = '';
  draw();
}
function toggleMute() {
  const tr = state.value.tracks.find((x) => x.id === (findClip(state.value, selected.value) || {}).trackId);
  if (!tr) return;
  pushHistory();
  state.value = setTrackFlags(state.value, tr.id, { mute: !tr.mute });
  draw();
}
function addMarkerHere() {
  const tl = timeline.value;
  let bar = 1;
  try { bar = tl ? Math.floor(tickOfSec(tl, secOfTick(tl, playTick.value) + 0.001) / 1) : 1; } catch (e) {}
  pushHistory();
  state.value = addMarker(state.value, { title: 'M' + (markerCount.value + 1), tick: playTick.value });
  void bar;
  draw();
}
function addRegionHere() {
  const tl = timeline.value;
  let span = 1920;
  try { if (tl) { const b = iterBars(tl, playTick.value, playTick.value + 1920 * 8); if (b.length > 1) span = b[1].ticks * 4; } } catch (e) {}
  pushHistory();
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
  // E2E 钩子：分标签撤销栈隔离的断言入口（仅测试实例）
  if (window.fuBridge && window.fuBridge.e2e) {
    window.__fufumidiArrange = {
      depth: () => ({ ...histDepth.value }),
      key: () => tabKey(),
      markers: () => state.value.markers.length,
      clips: () => state.value.clips.length,
      undo: () => undoArrange(),
      redo: () => redoArrange(),
    };
  }
  await nextTick();
  fitAll();
  tickTimer = setInterval(() => { if (app.playing) draw(); }, 100);
  // C1：编排页自己的撤销/重做命令（命令面板/快捷键/Menu 都查同一张表）
  cmdOffs.push(commands.register({
    id: 'arrange.undo', title: '撤销', area: 'arrange', keys: 'Mod+Z', undoable: true,
    when: () => hist.canUndo(), run: () => { undoArrange(); },
  }));
  cmdOffs.push(commands.register({
    id: 'arrange.redo', title: '重做', area: 'arrange', keys: 'Mod+Shift+Z', undoable: true,
    when: () => hist.canRedo(), run: () => { redoArrange(); },
  }));
  window.addEventListener('keydown', onArrangeKey);
});
onBeforeUnmount(() => {
  if (window.__fufumidiArrange) { try { delete window.__fufumidiArrange; } catch (e) {} }
  if (tickTimer) clearInterval(tickTimer);
  while (cmdOffs.length) { try { cmdOffs.pop()(); } catch (e) {} }
  window.removeEventListener('keydown', onArrangeKey);
});

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
      <button class="btn sm" :class="{ on: snap }" @click="snap = !snap">{{ t('吸附') }}</button>
      <button class="btn sm" :disabled="!selected" @click="duplicateSelected">{{ t('复制片段') }}</button>
      <button class="btn sm" :disabled="!selected" @click="splitAtPlayhead">{{ t('在播放头切分') }}</button>
      <button class="btn sm" :disabled="!selected" @click="toggleMute">{{ t('静音轨道') }}</button>
      <button class="btn sm" :disabled="!selected" @click="deleteSelected">{{ t('删除片段') }}</button>
      <button class="btn sm" data-guide="arrange-undo" :disabled="!histDepth.undo" @click="undoArrange">{{ t('撤销') }}</button>
      <button class="btn sm" data-guide="arrange-redo" :disabled="!histDepth.redo" @click="redoArrange">{{ t('重做') }}</button>
      <button class="btn sm" @click="addMarkerHere">{{ t('加标记') }}</button>
      <button class="btn sm" @click="addRegionHere">{{ t('加区间') }}</button>
    </div>
    <div ref="wrap" class="arr-canvas-wrap card" data-guide="arrange-canvas">
      <canvas ref="cv" class="arr-canvas"
              @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
              @dblclick="onDblClick" @wheel="onWheel" @contextmenu.prevent="onCtx" />
      <div class="arr-heads">
        <div v-for="(tr, ti) in state.tracks" :key="tr.id" class="arr-head" :style="{ top: (RULER_H + ti * rowH) + 'px', height: rowH + 'px' }">
          <span class="arr-head-dot" :style="{ background: tr.color || 'var(--accent-sky)' }"></span>
          <b :title="tr.name">{{ tr.name || ('轨道 ' + (ti + 1)) }}</b>
          <button class="arr-ms" :class="{ on: tr.mute }" :title="t('静音')" @click.stop="toggleTrackFlag(tr, 'mute')">M</button>
          <button class="arr-ms" :class="{ on: tr.solo }" :title="t('独奏')" @click.stop="toggleTrackFlag(tr, 'solo')">S</button>
        </div>
      </div>
      <div v-if="!song" class="arr-empty">{{ t('还没有载入曲目') }}</div>
      <div class="arr-hints">{{ t('拖动片段移动 · 拖边缘裁剪 · 标尺拖拽框区间 · 双击聚焦编辑 · 右键更多操作') }}</div>
    </div>
    <div v-if="arrCtx" class="arr-ctx-mask" @click.self="closeCtx" @contextmenu.prevent="closeCtx">
      <div class="arr-ctx" :style="{ left: arrCtx.x + 'px', top: arrCtx.y + 'px' }">
        <button @click="ctxFocus"><Icon name="edit" :size="13" />{{ t('聚焦编辑') }}</button>
        <button @click="ctxSplit"><Icon name="cut" :size="13" />{{ t('在播放头切分') }}</button>
        <button @click="ctxDup"><Icon name="copy" :size="13" />{{ t('复制片段') }}</button>
        <button class="danger" @click="ctxDelete"><Icon name="trash" :size="13" />{{ t('删除片段') }}</button>
      </div>
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

.arr-heads { position: absolute; left: 0; top: 0; width: 160px; pointer-events: none; z-index: 3; }
.arr-head { position: absolute; left: 0; width: 160px; display: flex; align-items: center; gap: var(--sp-1); padding: 0 var(--sp-2); box-sizing: border-box; background: color-mix(in srgb, var(--surface) 72%, transparent); border-right: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); color: var(--text2); font-size: var(--fs-xs); pointer-events: none; }
.arr-head-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.arr-head b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--text); }
.arr-ms { width: 21px; height: 18px; border: 1px solid var(--hairline); border-radius: var(--r-xs); background: transparent; color: var(--text3); font: 600 var(--fs-xs) var(--font-num); cursor: pointer; pointer-events: auto; }
.arr-ms:hover { color: var(--text); border-color: var(--accent-sky); }
.arr-ms.on { color: var(--canvas); background: var(--accent-sky); border-color: var(--accent-sky); }
.arr-hints { position: absolute; left: 168px; right: 8px; bottom: 5px; z-index: 4; pointer-events: none; color: var(--text3); font-size: var(--fs-xs); opacity: .8; }
.arr-ctx-mask { position: fixed; inset: 0; z-index: var(--z-ctx); }
.arr-ctx { position: fixed; min-width: 168px; padding: var(--sp-1); border: 1px solid color-mix(in srgb, var(--ornament) 32%, var(--hairline)); border-radius: var(--r-md); background-color: color-mix(in srgb, var(--surface) 88%, transparent); backdrop-filter: var(--glass-blur); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 2px; }
.arr-ctx button { display: flex; align-items: center; gap: var(--sp-2); border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); text-align: left; cursor: pointer; }
.arr-ctx button:hover { background: color-mix(in srgb, var(--accent-sapphire) 14%, var(--surface)); }
.arr-ctx button.danger { color: var(--t-err); }
</style>
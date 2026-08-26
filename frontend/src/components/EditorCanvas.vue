<script setup>
// 可编辑钢琴卷帘：选择 / 画笔 / 橡皮 · 拖拽移动 · 缩放平移 · 撤销重做
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useAppStore } from '../stores/app';
import { ensureAudio } from '../audio.js';

const app = useAppStore();
const state = app;
const currentSong = computed(() => app.currentSong);
import { KEY_NAME, noteName, clamp } from '../core/util.js';

const props = defineProps({
  tool: { type: String, default: 'select' },      // select | pencil | erase
  snapRatio: { type: Number, default: 0.0625 },   // 拍的比例（0=关）
  trackIndex: { type: Number, default: 0 },
  ccEnabled: { type: Boolean, default: false },   // 是否显示 CC 泳道
  ccNumber: { type: Number, default: 11 },        // CC 控制器编号
  scaleSnap: { type: Boolean, default: false },   // 新音符吸附到调式音阶
  ksMap: { type: Object, default: () => ({}) },   // Key Switch 映射 { midi: 技法名 }
  audio: { type: Object, default: null },         // 音频波形 { data: Float32Array, rate: number }
  cc2Enabled: { type: Boolean, default: false },  // 第二条 CC 泳道
  cc2Number: { type: Number, default: 1 },
  ccMode: { type: String, default: 'free' },      // free | line | curve
});
const emit = defineEmits(['select', 'modify', 'zoom']);

const wrap = ref(null);
const canvas = ref(null);
const ccCanvas = ref(null);
const ccCanvas2 = ref(null);
let ctx2d = null;
const CC_LANE_H = 96;
const CC_NAMES = { 1: 'Modulation', 7: 'Volume', 10: 'Pan', 11: 'Expression', 64: 'Sustain' };

/* ---------------- 视图状态 ---------------- */
const zoom = ref(1);            // 缩放倍率
const viewTick = ref(0);        // 左边缘 tick
const viewTop = ref(60);        // 底部显示音高（最低）
const selection = reactive(new Set());  // 选中的音符对象引用

const pxPerBeat = computed(() => 22 * zoom.value);
const pxPerTick = computed(() => pxPerBeat.value / (song()?.tpb || 480));
const rowH = computed(() => 8 * Math.max(0.6, Math.min(2, zoom.value)));
const H = 420;

function song() { return (currentSong.value && currentSong.value.song) || null; }
function curTrack() {
  const s = song(); if (!s) return null;
  return s.tracks[props.trackIndex] || null;
}
/* 初始显示音域：跟随曲目内容，避免高音音符落在画布外 */
function computeRange() {
  const s = song();
  if (!s) { viewTop.value = 60; return; }
  let lo = 127, hi = 0;
  for (const tr of s.tracks) for (const n of tr.notes) {
    if (n.midi < lo) lo = n.midi;
    if (n.midi > hi) hi = n.midi;
  }
  viewTop.value = hi >= lo ? Math.min(127, hi + 4) : 60;
}
function noteColor(i) {
  const C = ['#ff5530', '#ea5ec1', '#1456f0', '#a855f7', '#3daeff', '#1ba673', '#3b82f6', '#f59e0b', '#d45656', '#17437d'];
  return C[i % C.length];
}
function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}

/* ---------------- 坐标换算 ---------------- */
function xToTick(x) { return viewTick.value + x / pxPerTick.value; }
function tickToX(t) { return (t - viewTick.value) * pxPerTick.value; }
function yToMidi(y) { return viewTop.value - Math.floor(y / rowH.value); }
function midiToY(m) { return (viewTop.value - m) * rowH.value; }
function snapTick(t) {
  const s = song(); if (!s || !props.snapRatio) return Math.max(0, Math.round(t));
  const st = s.tpb * props.snapRatio;
  return Math.max(0, Math.round(t / st) * st);
}
/* 音阶吸附：把 midi 吸附到当前调式音阶内最近音（主音由音符直方图估计） */
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
let _scaleCache = null;
function scaleSnapPitch(midi) {
  if (!props.scaleSnap) return midi;
  const s = song();
  if (!_scaleCache) {
    const hist = new Array(12).fill(0);
    for (const tr of s.tracks) for (const n of tr.notes) hist[((n.midi % 12) + 12) % 12]++;
    let root = 0, max = 0;
    for (let i = 0; i < 12; i++) if (hist[i] > max) { max = hist[i]; root = i; }
    const minor = hist[(root + 3) % 12] >= hist[(root + 4) % 12];
    const deg = minor ? MINOR : MAJOR;
    _scaleCache = { root: root % 12, deg };
  }
  const { root, deg } = _scaleCache;
  const oct = Math.floor(midi / 12), pc = ((midi % 12) + 12) % 12;
  const best = { d: 99, m: midi };
  for (const d of deg) {
    const m = oct * 12 + root + d;
    for (const cand of [m - 12, m, m + 12]) {
      const dd = Math.abs(cand - midi);
      if (dd < best.d) best = { d: dd, m: cand };
    }
  }
  return clamp(best.m, 0, 127);
}

/* ---------------- 撤销 / 重做 ---------------- */
const undoStack = [];
const redoStack = [];
function pushState() {
  const tr = curTrack(); if (!tr) return;
  undoStack.push({ ti: props.trackIndex, notes: JSON.parse(JSON.stringify(tr.notes)), ccs: JSON.parse(JSON.stringify(tr.ccs || [])) });
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}
function afterEdit() {
  const s = song(), item = currentSong.value;
  if (!s || !item) return;
  // 重算曲长
  let totalTicks = 0;
  for (const tr of s.tracks) for (const n of tr.notes) totalTicks = Math.max(totalTicks, n.end);
  s.totalTicks = totalTicks + s.tpb;
  s.totalSec = s.baseSec(s.totalTicks);
  s.bars = Math.ceil(s.totalTicks / (s.tpb * 4));
  // 刷新播放器 + UI
  const { player } = ensureAudio();
  player.load(s);
  player.setScale(state.tempo);
  if (state.loop) player.setLoop(true, 0, s.totalTicks);
  state.totalSec = s.totalSec;
  state.tracks = s.tracks.map((tr, i) => {
    const prev = state.tracks[i] || {};
    return { ...prev, index: i, name: tr.name, program: tr.program, isDrum: tr.isDrum, noteCount: tr.notes.length };
  });
  clearGhostSelection();
  emit('modify');
  draw();
}
function clearGhostSelection() {
  for (const n of [...selection]) {
    const tr = curTrack(); if (!tr) continue;
    if (!tr.notes.includes(n)) selection.delete(n);
  }
}
function undo() {
  const st = undoStack.pop(); if (!st) return;
  if (st.ti < 0) {
    // 全量快照：恢复所有轨道（智能伴奏等新增/删除轨道场景）
    const s = song(); if (!s) return;
    redoStack.push({ ti: -1, all: s.tracks.map(t => ({ notes: JSON.parse(JSON.stringify(t.notes)), ccs: JSON.parse(JSON.stringify(t.ccs || [])) })) });
    for (let i = 0; i < s.tracks.length; i++) {
      if (st.all && st.all[i]) { s.tracks[i].notes = st.all[i].notes; s.tracks[i].ccs = st.all[i].ccs || []; }
      else { s.tracks[i].notes = []; s.tracks[i].ccs = []; }
    }
    selection.clear();
    afterEdit();
    return;
  }
  const tr = song()?.tracks[st.ti]; if (!tr) return;
  redoStack.push({ ti: st.ti, notes: JSON.parse(JSON.stringify(tr.notes)), ccs: JSON.parse(JSON.stringify(tr.ccs || [])) });
  tr.notes = st.notes;
  tr.ccs = st.ccs || [];
  selection.clear();
  afterEdit();
}
function redo() {
  const st = redoStack.pop(); if (!st) return;
  if (st.ti < 0) {
    const s = song(); if (!s) return;
    undoStack.push({ ti: -1, all: s.tracks.map(t => ({ notes: JSON.parse(JSON.stringify(t.notes)), ccs: JSON.parse(JSON.stringify(t.ccs || [])) })) });
    for (let i = 0; i < s.tracks.length; i++) {
      if (st.all && st.all[i]) { s.tracks[i].notes = st.all[i].notes; s.tracks[i].ccs = st.all[i].ccs || []; }
      else { s.tracks[i].notes = []; s.tracks[i].ccs = []; }
    }
    selection.clear();
    afterEdit();
    return;
  }
  const tr = song()?.tracks[st.ti]; if (!tr) return;
  undoStack.push({ ti: st.ti, notes: JSON.parse(JSON.stringify(tr.notes)), ccs: JSON.parse(JSON.stringify(tr.ccs || [])) });
  tr.notes = st.notes;
  tr.ccs = st.ccs || [];
  selection.clear();
  afterEdit();
}

/* ---------------- 编辑操作 ---------------- */
function addNote(tick, midi, len) {
  const tr = curTrack(); if (!tr) return;
  pushState();
  tr.notes.push({ start: Math.round(tick), end: Math.round(tick + len), midi: clamp(scaleSnapPitch(Math.round(midi)), 0, 127), vel: 80 });
  afterEdit();
}
function deleteNotes(arr) {
  const tr = curTrack(); if (!tr || !arr.length) return;
  pushState();
  for (const n of arr) {
    const i = tr.notes.indexOf(n);
    if (i >= 0) tr.notes.splice(i, 1);
  }
  afterEdit();
}
function moveNotes(arr, dTick, dMidi) {
  const tr = curTrack(); if (!tr) return;
  for (const n of arr) {
    n.start = Math.max(0, n.start + Math.round(dTick));
    n.end = Math.max(n.start + 1, n.end + Math.round(dTick));
    n.midi = clamp(n.midi + Math.round(dMidi), 0, 127);
  }
  afterEdit();
}
function quantize(arr, ratio) {
  const tr = curTrack(); if (!tr || !arr.length) return;
  const s = song(); const st = (s.tpb * (ratio || props.snapRatio)) || 1;
  pushState();
  for (const n of arr) {
    const q = tick => Math.max(0, Math.round(tick / st) * st);
    const ns = q(n.start), ne = q(n.end);
    n.start = ns; n.end = Math.max(ns + 1, ne);
  }
  afterEdit();
}
function transpose(arr, d) {
  const tr = curTrack(); if (!tr || !arr.length) return;
  pushState();
  for (const n of arr) n.midi = clamp(n.midi + d, 0, 127);
  afterEdit();
}
function velRamp(arr, dir) {
  const tr = curTrack(); if (!tr || arr.length < 2) return;
  pushState();
  const sorted = arr.slice().sort((a, b) => a.start - b.start);
  sorted.forEach((n, i) => { n.vel = clamp(Math.round(n.vel + dir * i), 1, 127); });
  afterEdit();
}
function selectSamePitch() {
  const tr = curTrack(); if (!tr || !selection.size) return;
  const refNote = [...selection][0];
  for (const n of tr.notes) if (n.midi === refNote.midi) selection.add(n);
  draw();
}

/* 复制粘贴克隆 */
let clipNotes = null;
function copySelected() {
  clipNotes = [...selection].map(n => ({ start: n.start, end: n.end, midi: n.midi, vel: n.vel }));
  return clipNotes.length;
}
function pasteAt(tick) {
  if (!clipNotes || !clipNotes.length) return 0;
  const tr = curTrack(); if (!tr) return 0;
  pushState();
  const min = Math.min(...clipNotes.map(n => n.start));
  const newNotes = clipNotes.map(n => ({ start: Math.max(0, n.start - min + tick), end: Math.max(0, n.end - min + tick), midi: n.midi, vel: n.vel }));
  tr.notes.push(...newNotes);
  selection.clear();
  for (const n of tr.notes.slice(-newNotes.length)) selection.add(n);
  afterEdit();
  return newNotes.length;
}
function duplicateSelected() {
  if (!selection.size) return 0;
  const tr = curTrack(); if (!tr) return 0;
  const arr = [...selection].sort((a, b) => a.start - b.start);
  const lastEnd = Math.max(...arr.map(n => n.end));
  const min = Math.min(...arr.map(n => n.start));
  pushState();
  const newNotes = arr.map(n => ({ start: lastEnd + (n.start - min), end: lastEnd + (n.end - min), midi: n.midi, vel: n.vel }));
  tr.notes.push(...newNotes);
  selection.clear();
  for (const n of tr.notes.slice(-newNotes.length)) selection.add(n);
  afterEdit();
  return newNotes.length;
}

/* ---------------- 绘制 ---------------- */
function draw() {
  const cv = canvas.value, wEl = wrap.value;
  if (!cv || !wEl) return;
  const s = song();
  const dpr = window.devicePixelRatio || 1;
  const W = wEl.clientWidth || 600;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, W, H);
  const bgTop = cssVar('--canvas', '#ffffff');
  const bgBottom = cssVar('--surface', '#f7f8fa');
  const hair = cssVar('--hairline', 'rgba(10,10,10,.1)');
  const border2 = cssVar('--border-strong', 'rgba(10,10,10,.18)');
  const stone = cssVar('--stone', 'rgba(10,10,10,.4)');
  const steel = cssVar('--steel', '#c9ccd2');
  const g = ctx2d.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, bgTop); g.addColorStop(1, bgBottom);
  ctx2d.fillStyle = g; ctx2d.fillRect(0, 0, W, H);
  if (!s) return;

  const lo = viewTop.value - Math.ceil(H / rowH.value);
  const hi = viewTop.value;
  const isBlack = m => { const p = ((m % 12) + 12) % 12; return [1, 3, 6, 8, 10].includes(p); };
  // 键盘行背景
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) continue;
    ctx2d.fillStyle = 'rgba(10,10,10,0.028)';
    ctx2d.fillRect(0, (hi - m) * rowH.value, W, rowH.value);
  }
  // 垂直网格：按「拍」绘制（与吸附粒度解耦，避免缩放后线条糊成一片），
  // 小节线更强；过密时只画第一根强线（与原仓库一致）。
  const s2 = song();
  const tpb = s2 ? s2.tpb : 480;
  const sigNum = (s2 && s2.sigMap[0]) ? s2.sigMap[0].num : 4;
  const viewT0 = xToTick(0), viewT1 = viewT0 + W / pxPerTick.value;
  const firstBeat = Math.floor(viewT0 / tpb), lastBeat = Math.ceil(viewT1 / tpb);
  ctx2d.lineWidth = 1;
  let lastStrongX = -9999;
  for (let b = firstBeat; b <= lastBeat; b++) {
    const t = b * tpb;
    const x = tickToX(t);
    if (x < -5 || x > W + 5) continue;
    const isBar = b % sigNum === 0;
    if (isBar) {
      if (x - lastStrongX < 9) continue;   // 小节线过密时跳过，避免糊成一片
      lastStrongX = x;
    }
    ctx2d.strokeStyle = isBar ? border2 : hair;
    ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, H); ctx2d.stroke();
  }
  // 水平音高轨道线（每个音高一行，C 音位稍强）
  for (let m = lo; m <= hi; m++) {
    const y = (hi - m) * rowH.value;
    ctx2d.strokeStyle = (m % 12 === 0) ? border2 : hair;
    ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(W, y); ctx2d.stroke();
  }
  // 音名标签
  ctx2d.font = '10px monospace'; ctx2d.textAlign = 'left';
  for (let m = lo; m <= hi; m++) {
    if (((m % 12) + 12) % 12 !== 0) continue;
    const y = (hi - m) * rowH.value;
    ctx2d.fillStyle = stone;
    ctx2d.fillText(noteName(m), 4, y + rowH.value - 3);
  }
  // Key Switch 高亮：C-2 ~ C0（MIDI 0-24）技法名区域
  const ksKeys = Object.keys(props.ksMap || {}).map(Number).filter(m => m >= 0 && m <= 24);
  if (ksKeys.length) {
    ctx2d.font = '9px monospace'; ctx2d.textAlign = 'left';
    for (const m of ksKeys) {
      if (m < lo || m > hi) continue;
      const y = (hi - m) * rowH.value;
      ctx2d.fillStyle = 'rgba(255,140,0,0.18)';
      ctx2d.fillRect(0, y, W, rowH.value);
      ctx2d.fillStyle = '#b45309';
      ctx2d.fillText((props.ksMap[m] || '').slice(0, 10), 52, y + rowH.value - 3);
    }
  }
  // 音符
  for (const tr of s.tracks) {
    const col = noteColor(tr.index);
    for (const n of tr.notes) {
      const x = tickToX(n.start), w2 = Math.max(2, tickToX(n.end) - x);
      const y = (hi - n.midi) * rowH.value;
      if (x > W || x + w2 < 0) continue;
      const sel = tr === curTrack() && selection.has(n);
      ctx2d.globalAlpha = 0.85;
      ctx2d.fillStyle = tr === curTrack() ? col : steel;
      ctx2d.fillRect(x, y + 1, w2, rowH.value - 2);
      ctx2d.globalAlpha = 1;
      if (sel) {
        ctx2d.strokeStyle = '#ff5530'; ctx2d.lineWidth = 1.5;
        ctx2d.strokeRect(x - 1, y, w2 + 2, rowH.value);
      }
    }
  }
  ctx2d.globalAlpha = 1;
  // 音频波形（卷帘底部）：按 tick 对齐显示原始音频包络
  const a = props.audio;
  if (a && a.data && a.rate) {
    const WAVE_H = 42;
    const yBase = H - WAVE_H;
    ctx2d.fillStyle = 'rgba(20,86,240,0.05)'; ctx2d.fillRect(0, yBase, W, WAVE_H);
    ctx2d.strokeStyle = 'rgba(20,86,240,0.7)'; ctx2d.lineWidth = 1;
    const secPerTick = s.totalSec > 0 ? s.totalSec / s.totalTicks : 60 / 120 / s.tpb;
    const t0 = Math.max(0, xToTick(0)), t1 = Math.max(t0 + 1, xToTick(W));
    const s0 = t0 * secPerTick * a.rate, s1 = t1 * secPerTick * a.rate;
    const n = a.data.length;
    if (s1 > s0) {
      const pxW = Math.max(1, Math.round(W / 2)); // 按 2px 一柱采样，控制绘制量
      for (let i = 0; i <= pxW; i++) {
        const x = i / pxW * W;
        const t = t0 + (t1 - t0) * i / pxW;
        const ia = Math.max(0, Math.floor(t * secPerTick * a.rate));
        const ib = Math.max(ia + 1, Math.floor((t + (t1 - t0) / pxW) * secPerTick * a.rate));
        if (ia >= n) break;
        let mn = 0, mx = 0;
        for (let j = ia; j < Math.min(ib, n); j++) { const v = a.data[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const y1 = yBase + (1 - mx) * WAVE_H / 2;
        const y2 = yBase + (1 - mn) * WAVE_H / 2;
        ctx2d.beginPath(); ctx2d.moveTo(x, y1); ctx2d.lineTo(x, y2); ctx2d.stroke();
      }
    }
    ctx2d.strokeStyle = 'rgba(20,86,240,0.35)';
    ctx2d.beginPath(); ctx2d.moveTo(0, yBase); ctx2d.lineTo(W, yBase); ctx2d.stroke();
    ctx2d.fillStyle = 'rgba(20,86,240,0.6)'; ctx2d.font = '9px monospace'; ctx2d.textAlign = 'right';
    ctx2d.fillText('音频', W - 4, yBase + 11);
  }
  // 画笔预览
  if (dragState.value && dragState.value.type === 'create') {
    const d = dragState.value;
    const x = tickToX(d.startTick), w2 = Math.max(2, tickToX(d.startTick + d.len) - x);
    const y = (hi - d.startMidi) * rowH.value;
    ctx2d.fillStyle = 'rgba(20,86,240,0.45)';
    ctx2d.fillRect(x, y + 1, w2, rowH.value - 2);
    ctx2d.strokeStyle = 'rgba(20,86,240,0.9)'; ctx2d.lineWidth = 1.2;
    ctx2d.strokeRect(x - 1, y, w2 + 2, rowH.value);
  }
  // 播放头
  const curTick = s.secToTick(state.curSec / state.tempo);
  const px = tickToX(curTick);
  const pg = ctx2d.createLinearGradient(0, 0, 0, H);
  pg.addColorStop(0, 'rgba(255,85,48,0.4)'); pg.addColorStop(1, 'rgba(255,85,48,0.05)');
  ctx2d.fillStyle = pg;
  ctx2d.fillRect(px - 1, 0, 2.5, H);
  ctx2d.fillStyle = '#ff5530'; ctx2d.fillRect(px - 4, 0, 8, 3);
  // 框选
  if (dragState.value && dragState.value.type === 'marquee' && dragState.value.box) {
    const b = dragState.value.box;
    ctx2d.strokeStyle = 'rgba(20,86,240,0.7)'; ctx2d.lineWidth = 1;
    ctx2d.strokeRect(b.x, b.y, b.w, b.h);
    ctx2d.fillStyle = 'rgba(20,86,240,0.08)';
    ctx2d.fillRect(b.x, b.y, b.w, b.h);
  }
}
const dragState = ref(null);

/* ---------------- CC 泳道 ---------------- */
const ccDrawing = ref(false);
const ccLast = ref(null);   // {tick, val}
function drawCC(g, W, H2, ccNum) {
  const s = song();
  g.clearRect(0, 0, W, H2);
  g.fillStyle = cssVar('--surface-soft', 'rgba(10,10,10,0.03)'); g.fillRect(0, 0, W, H2);
  const name = CC_NAMES[ccNum] || ('CC' + ccNum);
  const hair = cssVar('--hairline', 'rgba(10,10,10,0.08)');
  const stone = cssVar('--stone', 'rgba(10,10,10,0.35)');
  const slate = cssVar('--slate', 'rgba(10,10,10,0.5)');
  g.fillStyle = slate; g.font = '9.5px monospace'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(name + ' ' + ccNum, 6, 10);
  for (const v of [0, 64, 127]) {
    const y = H2 - 4 - (v / 127) * (H2 - 12);
    g.strokeStyle = hair; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.fillStyle = stone; g.fillText(String(v), 6, y);
  }
  const tr = curTrack();
  const ccs = (tr && (tr.ccs || []).filter(c => c.cc === ccNum).sort((a, b) => a.tick - b.tick)) || [];
  if (!s || !ccs.length) return;
  g.strokeStyle = '#d4a017'; g.lineWidth = 1.4; g.beginPath();
  for (let i = 0; i < ccs.length; i++) {
    const x = tickToX(ccs[i].tick);
    const y = H2 - 4 - (ccs[i].cv / 127) * (H2 - 12);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.fillStyle = '#d4a017';
  for (const c of ccs) {
    const x = tickToX(c.tick);
    const y = H2 - 4 - (c.cv / 127) * (H2 - 12);
    g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
  }
}
function ccDrawLane() {
  const cv = ccCanvas.value;
  const s = song();
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H2 = CC_LANE_H;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H2 * dpr)) { cv.width = Math.floor(W * dpr); cv.height = Math.floor(H2 * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawCC(g, W, H2, props.ccNumber);
  // 第二条泳道
  if (props.cc2Enabled) {
    const cv2 = ccCanvas2.value;
    if (cv2) {
      if (cv2.width !== Math.floor(W * dpr) || cv2.height !== Math.floor(H2 * dpr)) { cv2.width = Math.floor(W * dpr); cv2.height = Math.floor(H2 * dpr); }
      const g2 = cv2.getContext('2d');
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawCC(g2, W, H2, props.cc2Number);
    }
  }
}
function ccYToVal(y) {
  const H2 = CC_LANE_H;
  return clamp(Math.round((H2 - 4 - y) / (H2 - 12) * 127), 0, 127);
}
function ccDown(e) {
  const tr = curTrack(); if (!tr) return;
  const target = e.target === ccCanvas2.value ? props.cc2Number : props.ccNumber;
  pushState();
  ccDrawing.value = true;
  ccLast.value = null;
  ccTarget.value = target;
  ccPaint(e);
}
function ccMove(e) { if (ccDrawing.value) ccPaint(e); }
function ccUp() { ccDrawing.value = false; ccLast.value = null; }
const ccTarget = ref(props.ccNumber);
function ccPaint(e) {
  const cv = e.target && e.target.tagName === 'CANVAS' ? e.target : ccCanvas.value;
  if (!cv) return;
  const ccNum = ccTarget.value;
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const tick = Math.max(0, Math.round(xToTick(x)));
  const val = ccYToVal(e.clientY - rect.top);
  const tr = curTrack(); if (!tr) return;
  const arr = tr.ccs = tr.ccs || [];
  const put = (t, v) => {
    const idx = arr.findIndex(c => c.cc === ccNum && Math.abs(c.tick - t) < 2);
    if (idx >= 0) arr[idx] = { tick: t, cc: ccNum, cv: v };
    else arr.push({ tick: t, cc: ccNum, cv: v });
  };
  if (props.ccMode === 'line' && ccLast.value) {
    // 直线：从上一采样点到当前点线性插值
    const from = ccLast.value, to = { tick, val };
    const span = Math.abs(to.tick - from.tick);
    if (span > 0) {
      for (let i = 1; i <= span; i++) {
        const t = Math.round(from.tick + (to.tick - from.tick) * i / span);
        const v = Math.round(from.val + (to.val - from.val) * i / span);
        put(t, clamp(v, 0, 127));
      }
    }
  } else if (props.ccMode === 'curve' && ccLast.value) {
    // 曲线：两段中点平滑（二次贝塞尔近似 → 简化：前半段取平均值过渡）
    const from = ccLast.value;
    const midT = Math.round((from.tick + tick) / 2);
    const midV = Math.round((from.val + val) / 2);
    put(midT, clamp(midV, 0, 127));
  } else {
    if (ccLast.value != null && Math.abs(tick - ccLast.value.tick) < 2) return;
    put(tick, val);
  }
  arr.sort((a, b) => a.tick - b.tick);
  ccLast.value = { tick, val };
  ccDrawLane();
}

/* ---------------- 交互 ---------------- */
function hitTest(x, y) {
  const tr = curTrack(); if (!tr) return null;
  const hi = viewTop.value;
  const midi = yToMidi(y);
  const tick = xToTick(x);
  const thresh = 4;
  for (const n of tr.notes) {
    const nx = tickToX(n.start), nx2 = tickToX(n.end);
    const ny = (hi - n.midi) * rowH.value;
    if (Math.abs((nx + nx2) / 2 - x) < Math.max(6, (nx2 - nx) / 2 + 4) && Math.abs(ny + rowH.value / 2 - y) < rowH.value / 2 + thresh) return n;
  }
  return null;
}
function onDown(e) {
  const s = song(), tr = curTrack();
  if (!s || !tr) return;
  const rect = canvas.value.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const multi = e.ctrlKey || e.metaKey || e.shiftKey;
  if (props.tool === 'pencil') {
    const tick = snapTick(xToTick(x)), midi = yToMidi(y);
    if (tick < 0 || midi < 0 || midi > 127) return;
    const len = Math.max(s.tpb, 120);
    dragState.value = { type: 'create', startTick: tick, startMidi: midi, len, note: null, rawEnd: tick + len };
    try { canvas.value.setPointerCapture(e.pointerId); } catch (err) {}
  } else if (props.tool === 'erase') {
    const n = hitTest(x, y);
    if (n) deleteNotes([n]);
    else { dragState.value = { type: 'marquee', x0: x, y0: y, box: null }; }
  } else {
    const n = hitTest(x, y);
    if (n) {
      if (!multi && !selection.has(n)) { selection.clear(); selection.add(n); }
      else if (multi && selection.has(n)) selection.delete(n);
      else if (multi) selection.add(n);
      if (!selection.has(n)) { dragState.value = null; draw(); return; }
      pushState(); // 操作前记录，保证撤销能还原
      // 边缘命中 → 拉伸长度（右边缘改 end，左边缘改 start 并保持 end 不动）
      const nx = tickToX(n.start), nx2 = tickToX(n.end);
      let type = 'move';
      if (Math.abs(nx2 - x) < 7) type = 'resize';
      else if (Math.abs(x - nx) < 7) type = 'resize-left';
      dragState.value = { type, notes: [n], startX: x, startY: y, orig: [{ start: n.start, end: n.end, midi: n.midi }] };
    } else {
      if (!multi) selection.clear();
      dragState.value = { type: 'marquee', x0: x, y0: y, box: null };
    }
  }
  emit('select');
  draw();
}
function onMove(e) {
  const d = dragState.value; if (!d) return;
  const rect = canvas.value.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (d.type === 'marquee') {
    d.box = { x: Math.min(d.x0, x), y: Math.min(d.y0, y), w: Math.abs(x - d.x0), h: Math.abs(y - d.y0) };
    if (d.x0 >= 0) {
      selection.clear();
      const t0 = xToTick(d.box.x), t1 = xToTick(d.box.x + d.box.w);
      const hi = viewTop.value;
      const m0 = yToMidi(d.box.y + d.box.h), m1 = yToMidi(d.box.y);
      const tr = curTrack();
      if (tr) for (const n of tr.notes) {
        if (n.start <= t1 && n.end >= t0 && n.midi >= m0 && n.midi <= m1) selection.add(n);
      }
    }
  } else if (d.type === 'move') {
    const dTick = (x - d.startX) / pxPerTick.value;
    const dMidi = (d.startY - y) / rowH.value;
    const orig = d.orig || [];
    d.notes.forEach((n, i) => {
      const o = orig[i];
      const ns = Math.max(0, o.start + Math.round(dTick));
      n.start = ns; n.end = Math.max(ns + 1, o.end + Math.round(dTick));
      n.midi = clamp(o.midi + Math.round(dMidi), 0, 127);
    });
    draw();
  } else if (d.type === 'resize' || d.type === 'resize-left') {
    const n = d.notes[0], o = d.orig[0];
    if (d.type === 'resize') {
      n.end = Math.max(o.start + 60, snapTick(xToTick(x)));
    } else {
      n.start = Math.max(0, Math.min(o.end - 60, snapTick(xToTick(x))));
    }
    draw();
  } else if (d.type === 'create') {
    const raw = xToTick(x);
    const end = Math.max(d.startTick + 60, raw);
    d.rawEnd = end;
    d.len = end - d.startTick;
    draw();
  }
}
function onUp() {
  const d = dragState.value;
  if (!d) return;
  const tr = curTrack();
  if ((d.type === 'move' || d.type === 'resize' || d.type === 'resize-left') && d.notes.length && tr) {
    // 位置/长度已在拖拽中直接修改；状态在 onDown 时已入撤销栈
    afterEdit();
  } else if (d.type === 'create' && tr) {
    pushState();
    const len = Math.max(d.len || Math.max(song()?.tpb || 480, 120), 60);
    const st = Math.round(d.startTick);
    const en = Math.round(st + len);
    tr.notes.push({ start: st, end: en, midi: clamp(scaleSnapPitch(Math.round(d.startMidi)), 0, 127), vel: 80 });
    afterEdit();
  } else if (d.type === 'marquee' && d.box) {
    emit('select');
    draw();
  }
  dragState.value = null;
}
function onWheel(e) {
  e.preventDefault();
  const rect = canvas.value.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  if (e.ctrlKey || e.metaKey) {
    const before = xToTick(mx);
    const nz = clamp(zoom.value * (e.deltaY < 0 ? 1.15 : 0.87), 0.4, 2.5);
    zoom.value = nz;
    viewTick.value = before - mx / pxPerTick.value;
    emit('zoom', zoom.value);
  } else if (e.shiftKey) {
    viewTick.value = Math.max(0, viewTick.value + e.deltaY / pxPerTick.value);
  } else {
    viewTop.value = clamp(viewTop.value + e.deltaY / rowH.value, 0, 127);
  }
  draw();
}

/* ---------------- 对外方法 ---------------- */
function setZoom(v) { zoom.value = clamp(v, 0.4, 2.5); emit('zoom', zoom.value); draw(); }
function setViewTick(t) { viewTick.value = Math.max(0, t); draw(); }
function zoomBy(f) { setZoom(zoom.value * f); }
function fit() {
  const s = song(); if (!s) return;
  const W = wrap.value?.clientWidth || 600;
  const z = clamp(W / (s.totalTicks / s.tpb * 22), 0.4, 2.5);
  zoom.value = z; viewTick.value = 0;
  emit('zoom', zoom.value); draw();
}
function focusSelection() {
  if (!selection.size) return;
  const first = [...selection].sort((a, b) => a.start - b.start)[0];
  viewTick.value = Math.max(0, first.start - (song()?.tpb || 480) * 2);
  draw();
}
function deleteSelected() { if (selection.size) deleteNotes([...selection]); }
function quantizeSelected() { if (selection.size) quantize([...selection]); }
function transposeSelected(d) { if (selection.size) transpose([...selection], d); }
function velRampSelected(dir) { if (selection.size) velRamp([...selection], dir); }
function selectAll() {
  const tr = curTrack(); if (!tr) return;
  selection.clear(); for (const n of tr.notes) selection.add(n);
  draw(); emit('select');
}
function selectNone() { selection.clear(); draw(); emit('select'); }
function selCount() { return selection.size; }
function selInfo() {
  const tr = curTrack(); if (!tr || !selection.size) return null;
  const arr = [...selection];
  const first = arr[0];
  return {
    count: arr.length,
    midi: arr.length === 1 ? first.midi : null,
    name: arr.length === 1 ? noteName(first.midi) : null,
    vel: arr.length === 1 ? first.vel : null,
    start: arr.length === 1 ? first.start : null,
    len: arr.length === 1 ? (first.end - first.start) : null,
  };
}
function setSelVel(v) {
  const tr = curTrack(); if (!tr || !selection.size) return;
  pushState();
  for (const n of selection) n.vel = clamp(Math.round(v), 1, 127);
  afterEdit();
}
function setSelMidi(m) {
  const tr = curTrack(); if (!tr || !selection.size) return;
  pushState();
  for (const n of selection) n.midi = clamp(Math.round(m), 0, 127);
  afterEdit();
}
function setSelStart(t) {
  const tr = curTrack(); if (!tr || !selection.size) return;
  pushState();
  for (const n of selection) { const d = Math.round(t) - n.start; n.start = Math.max(0, Math.round(t)); n.end = Math.max(n.start + 1, n.end + d); }
  afterEdit();
}
function setSelLen(l) {
  const tr = curTrack(); if (!tr || !selection.size) return;
  pushState();
  for (const n of selection) n.end = Math.max(n.start + 1, n.start + Math.round(l));
  afterEdit();
}
/* 力度曲线：arr 为按 start 排序后每个选中音符的新力度（1-127） */
function applyVelCurve(arr) {
  const tr = curTrack(); if (!tr || !selection.size || !arr) return 0;
  pushState();
  const sorted = [...selection].sort((a, b) => a.start - b.start);
  sorted.forEach((n, i) => { const v = arr[i]; if (v != null) n.vel = clamp(Math.round(v), 1, 127); });
  afterEdit();
  return sorted.length;
}
/* 列表编辑器：用新数组整体替换当前轨道音符（单个撤销点） */
function replaceNotes(arr) {
  const tr = curTrack(); if (!tr || !arr) return;
  pushState();
  tr.notes = arr;
  selection.clear();
  afterEdit();
}
/* 选中音符拷贝（按 start 排序），供列表编辑器编辑草稿 */
function selNotes() {
  return [...selection].sort((a, b) => a.start - b.start).map(n => ({ start: n.start, end: n.end, midi: n.midi, vel: n.vel }));
}
/* 选中音符的原始引用数组（供批量编辑直接修改） */
function selRef() {
  return [...selection].sort((a, b) => a.start - b.start);
}
/* 按数组替换当前选中集合 */
function selectNotes(arr) {
  selection.clear();
  const tr = curTrack();
  if (tr && Array.isArray(arr)) for (const n of arr) if (tr.notes.includes(n)) selection.add(n);
  draw(); emit('select');
}
/* 列表编辑器保存：按选中顺序写回草稿值 */
function applyDraft(arr) {
  const tr = curTrack(); if (!tr || !selection.size || !arr) return;
  pushState();
  const sorted = [...selection].sort((a, b) => a.start - b.start);
  sorted.forEach((n, i) => {
    const d = arr[i]; if (!d) return;
    n.start = Math.max(0, Math.round(d.start));
    n.end = Math.max(n.start + 1, Math.round(d.end));
    n.midi = clamp(Math.round(d.midi), 0, 127);
    n.vel = clamp(Math.round(d.vel), 1, 127);
  });
  afterEdit();
}
/* 踏板：选区/整轨起止处添加 CC64 延音（down→127，up→0）；删除区间内 CC64 */
function selSpan() {
  const tr = curTrack(); if (!tr) return null;
  if (selection.size) {
    const arr = [...selection];
    const a = Math.min(...arr.map(n => n.start));
    const b = Math.max(...arr.map(n => n.end));
    return { a, b };
  }
  const s = song(); if (!s || !tr.notes.length) return null;
  return { a: 0, b: s.totalTicks };
}
function addPedal() {
  const tr = curTrack(); if (!tr) return 0;
  const span = selSpan(); if (!span) return 0;
  pushState();
  const arr = tr.ccs = tr.ccs || [];
  const { a, b } = span;
  arr.push({ tick: a, cc: 64, cv: 127 });
  arr.push({ tick: Math.max(a, b - Math.max(1, Math.round((song()?.tpb || 480) / 8))), cc: 64, cv: 0 });
  arr.sort((x, y) => x.tick - y.tick);
  afterEdit();
  return 2;
}
function delPedal() {
  const tr = curTrack(); if (!tr) return 0;
  const span = selSpan(); if (!span || !(tr.ccs || []).length) return 0;
  pushState();
  const before = tr.ccs.length;
  tr.ccs = tr.ccs.filter(c => !(c.cc === 64 && c.tick >= span.a && c.tick <= span.b));
  const removed = before - tr.ccs.length;
  if (removed) afterEdit();
  else { redoStack.length = 0; undoStack.pop(); }
  return removed;
}
function canUndo() { return undoStack.length > 0; }
function canRedo() { return redoStack.length > 0; }
function clearHistory() { undoStack.length = 0; redoStack.length = 0; }
function historySnapshots() {
  return undoStack.map(s => ({ ti: s.ti, notes: s.notes.length, at: Date.now() }));
}
/* 音频起音检测（短时 RMS 能量突增） */
let _onsetsCache = null;
function audioOnsets() {
  const a = props.audio;
  if (!a || !a.data || !a.rate) return [];
  if (_onsetsCache) return _onsetsCache;
  const frame = Math.max(1, Math.floor(a.rate * 0.01));
  const n = a.data.length, rms = [];
  for (let i = 0; i < n; i += frame) {
    let sum = 0; const end = Math.min(i + frame, n);
    for (let j = i; j < end; j++) sum += a.data[j] * a.data[j];
    rms.push(Math.sqrt(sum / (end - i)));
  }
  const avg = rms.length ? rms.reduce((a2, b) => a2 + b, 0) / rms.length : 0;
  const onsets = [];
  for (let i = 1; i < rms.length; i++) {
    if (rms[i] > avg * 0.6 && rms[i] > rms[i - 1] * 1.8) onsets.push(i * frame / a.rate);
  }
  _onsetsCache = onsets;
  return onsets;
}
/* 选区/整轨音符吸附到最近的波形起音（±80ms） */
function snapSelToAudio() {
  const s = song(), tr = curTrack();
  if (!s || !tr) return 0;
  const onsets = audioOnsets();
  if (!onsets.length) return 0;
  const secPerTick = s.totalSec > 0 ? s.totalSec / s.totalTicks : 60 / 120 / s.tpb;
  const winSec = 0.08;
  const arr = selection.size ? [...selection] : tr.notes.slice();
  pushState();
  let moved = 0;
  for (const n of arr) {
    const sec = n.start * secPerTick;
    let best = null;
    for (const o of onsets) {
      if (o < sec - winSec) continue;
      if (o > sec + winSec) break;
      if (!best || Math.abs(o - sec) < Math.abs(best - sec)) best = o;
    }
    if (best != null) {
      const nt = Math.max(0, Math.round(best / secPerTick));
      n.end = n.end - n.start + nt;
      n.start = nt;
      moved++;
    }
  }
  if (moved) afterEdit();
  return moved;
}
/* 外部编辑（鼓组编辑器等）：按指定轨道做快照并同步刷新；ti < 0 时做全量快照（智能伴奏等） */
function pushStateForTrack(ti) {
  const s = song(); if (!s) return;
  if (ti < 0) {
    undoStack.push({ ti: -1, all: s.tracks.map(t => ({ notes: JSON.parse(JSON.stringify(t.notes)), ccs: JSON.parse(JSON.stringify(t.ccs || [])) })) });
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
    return;
  }
  if (!s.tracks[ti]) return;
  undoStack.push({ ti, notes: JSON.parse(JSON.stringify(s.tracks[ti].notes)), ccs: JSON.parse(JSON.stringify(s.tracks[ti].ccs || [])) });
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}
function notifyExternalEdit() { afterEdit(); }
function resetView() { computeRange(); viewTick.value = 0; zoom.value = 1; fit(); }

defineExpose({
  setZoom, setViewTick, zoomBy, fit, focusSelection, resetView,
  deleteSelected, quantizeSelected, transposeSelected, velRampSelected,
  copySelected, pasteAt, duplicateSelected, selectSamePitch,
  selectAll, selectNone, selCount, selInfo,
  setSelVel, setSelMidi, setSelStart, setSelLen, applyVelCurve, replaceNotes, selNotes, selRef, selectNotes, applyDraft,
  addPedal, delPedal, selSpan, addNote, deleteNotes, pushStateForTrack, notifyExternalEdit,
  undo, redo, canUndo, canRedo, clearHistory, historySnapshots,
  snapSelToAudio,
});

/* ---------------- 生命周期 ---------------- */
let raf = 0;
function loop() { draw(); ccDrawLane(); raf = requestAnimationFrame(loop); }
watch(() => currentSong.value, () => { selection.clear(); resetView(); draw(); });
watch(() => props.trackIndex, () => { selection.clear(); draw(); ccDrawLane(); });
watch(() => props.tool, () => { dragState.value = null; draw(); });
watch(() => props.ccNumber, () => ccDrawLane());
watch(() => props.cc2Number, () => ccDrawLane());
watch(() => props.cc2Enabled, (v) => { if (!v) ccDrawing.value = false; ccDrawLane(); });
watch(() => props.ccMode, () => ccDrawLane());
watch(() => props.ccEnabled, (v) => { if (!v) ccDrawing.value = false; ccDrawLane(); });
watch(() => props.scaleSnap, () => { _scaleCache = null; });
watch(() => props.audio, () => { _onsetsCache = null; draw(); });
watch(() => props.ksMap, () => draw(), { deep: true });

onMounted(async () => {
  await nextTick();
  ctx2d = canvas.value.getContext('2d');
  resetView();
  raf = requestAnimationFrame(loop);
});
onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf); });
</script>

<template>
  <div class="ed-canvas-wrap" ref="wrap" data-guide="edit-canvas" @wheel.prevent="onWheel">
    <canvas ref="canvas" :style="{ height: H + 'px' }" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp"></canvas>
    <div v-if="ccEnabled" class="cc-lane" :style="{ height: CC_LANE_H + 'px' }">
      <canvas ref="ccCanvas" class="cc-lane-canvas" @pointerdown="ccDown" @pointermove="ccMove" @pointerup="ccUp" @pointerleave="ccUp"></canvas>
    </div>
    <div v-if="ccEnabled && cc2Enabled" class="cc-lane" :style="{ height: CC_LANE_H + 'px' }">
      <canvas ref="ccCanvas2" class="cc-lane-canvas" @pointerdown="ccDown" @pointermove="ccMove" @pointerup="ccUp" @pointerleave="ccUp"></canvas>
    </div>
  </div>
</template>

<style scoped>
.ed-canvas-wrap { position: relative; width: 100%; overflow: hidden; }
.ed-canvas-wrap canvas { display: block; width: 100%; cursor: crosshair; touch-action: none; }
.cc-lane { border-top: 1px solid var(--hairline); background: var(--surface); }
.cc-lane-canvas { display: block; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
</style>

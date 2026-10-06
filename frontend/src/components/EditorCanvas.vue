<script setup>
// 可编辑钢琴卷帘：选择 / 画笔 / 橡皮 · 拖拽移动 · 缩放平移 · 撤销重做
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue';
import { useAppStore } from '../stores/app';
import { ensureAudio } from '../audio.js';

const app = useAppStore();
const state = app;
const currentSong = computed(() => app.currentSong);
import { KEY_NAME, noteName, clamp } from '../core/util.js';
import { t } from '../core/i18n.js';
import { snapToPcs, scalePitchClasses } from '../core/scale.js';
// 乐谱视图要用「按音符分布猜调号」（与乐谱页同一套）
import { detectSf } from '../core/score.js';

const props = defineProps({
  tool: { type: String, default: 'select' },      // select | pencil | erase
  snapRatio: { type: Number, default: 0.0625 },   // 拍的比例（0=关）
  trackIndex: { type: Number, default: 0 },
  ccEnabled: { type: Boolean, default: false },   // 是否显示 CC 泳道
  ccNumber: { type: Number, default: 11 },        // CC 控制器编号
  // 步进输入（M4）：开启后画笔不在「点哪落哪」，而是落在**步进指针**上并自动前进
  stepOn: { type: Boolean, default: false },
  stepTicks: { type: Number, default: 120 },   // 每步长度（tick）
  scaleSpec: { type: Object, default: null },     // { root, type, custom } 调内编辑用的音阶；空则按曲目自动判断
  scaleMode: { type: String, default: 'off' },    // off | highlight（高亮调内音） | constrain（约束到调内音）
  chordTrack: { type: Array, default: () => [] }, // P1-2 和弦轨 [{ tick, endTick, pcs }]；约束时并入当前小节的调内音
  ksMap: { type: Object, default: () => ({}) },   // Key Switch 映射 { midi: 技法名 }
  audio: { type: Object, default: null },         // 音频波形 { data: Float32Array, rate: number }
  cc2Enabled: { type: Boolean, default: false },  // 第二条 CC 泳道
  cc2Number: { type: Number, default: 1 },
  ccMode: { type: String, default: 'free' },      // free | line | curve
  defaultVelocity: { type: Number, default: 80 }, // 新音符默认力度
  colorMode: { type: String, default: 'track' },  // track | pitch | velocity | selection | scale
  /**
   * 渲染/编辑模式：piano=钢琴卷帘（默认） / score=五线谱。
   *
   * ★ 乐谱不是「另一个页面」而是**同一份数据的另一种视图**：选择、撤销栈、吸附、
   *   播放头、量化/移调/删除这些操作全部复用，所以两个视图里改的都是同一批音符对象。
   */
  view: { type: String, default: 'piano' },
});
const emit = defineEmits(['select', 'modify', 'zoom', 'ctxmenu', 'hover', 'step']);

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
/* 卷帘高度：填满舞台可用高度（扣掉 CC 车道），让卷帘像 DAW 一样铺满窗口而非固定 420px */
const H = ref(420);
function availH() {
  const el = wrap.value;
  const lanes = (props.ccEnabled ? CC_LANE_H : 0) + (props.ccEnabled && props.cc2Enabled ? CC_LANE_H : 0);
  const avail = (el ? el.clientHeight : 0) - lanes;
  return avail > 180 ? Math.round(avail) : 420;
}

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
/* 轨道着色：轮转 8 个轨道色令牌 */
function noteColor(i, pal) { return pal.tracks[((i % pal.tracks.length) + pal.tracks.length) % pal.tracks.length]; }
/* 音高着色：12 个音级各一色（同名音全曲同色，便于看调性/声部走向）；
   饱和度/亮度取自主题令牌，保证深色底也看得清 */
const PITCH_HUES = [8, 345, 300, 275, 240, 225, 205, 187, 160, 85, 38, 0];
function pitchColor(midi, pal) {
  const i = ((midi % 12) + 12) % 12;
  return 'hsl(' + PITCH_HUES[i] + ', ' + pal.noteS + ', ' + pal.noteL + ')';
}
/* 力度着色：低力度冷色（蓝）→ 高力度暖色（红） */
function velColor(v, pal) {
  const k = Math.max(0, Math.min(1, (Number(v) || 0) / 127));
  return 'hsl(' + Math.round(210 - k * 210) + ', ' + pal.noteS + ', ' + pal.noteL + ')';
}
function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}
/* 一次性解析本轮绘制所需的全部颜色令牌（避免在逐音符循环里反复 getComputedStyle）。
   结果按主题缓存：主题切换由 applyTheme 写 documentElement 的内联样式触发，
   用 MutationObserver 失效即可 —— 否则每帧 ~30 次 getComputedStyle 会让整个应用发烫
   （实测后台保活时 getComputedStyle 调用量达 5000+/秒）。 */
const TRACK_FALLBACK = ['#3b82f6', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899'];
let _pal = null;
function buildPalette() {
  const tracks = [];
  for (let i = 1; i <= 8; i++) tracks.push(cssVar('--track-' + i, TRACK_FALLBACK[i - 1]));
  return {
    canvas: cssVar('--canvas', '#ffffff'),
    surface: cssVar('--surface', '#f7f8fa'),
    hair: cssVar('--hairline', 'rgba(10,10,10,.1)'),
    border2: cssVar('--border-strong', 'rgba(10,10,10,.18)'),
    stone: cssVar('--stone', 'rgba(10,10,10,.4)'),
    steel: cssVar('--steel', '#c9ccd2'),
    rowAlt: cssVar('--row-alt', 'rgba(10,10,10,0.028)'),
    tint: cssVar('--tint', 'rgba(20,86,240,0.06)'),
    tintStrong: cssVar('--tint-strong', 'rgba(20,86,240,0.20)'),
    sel: cssVar('--sel', '#ff5530'),
    playhead: cssVar('--playhead', '#ff5530'),
    playheadSoft: cssVar('--playhead-soft', 'rgba(255,85,48,0.16)'),
    curve: cssVar('--curve', '#4f8ef7'),
    ksBg: cssVar('--ks-bg', 'rgba(245,158,11,0.18)'),
    ksFg: cssVar('--ks-fg', '#b45309'),
    cc: cssVar('--cc', '#d4a017'),
    waveBg: cssVar('--wave-bg', 'rgba(20,86,240,0.05)'),
    waveBar: cssVar('--wave-bar', 'rgba(20,86,240,0.35)'),
    laneBg: cssVar('--lane-bg', 'rgba(10,10,10,0.03)'),
    noteS: cssVar('--note-s', '72%'),
    noteL: cssVar('--note-l', '52%'),
    tracks,
  };
}
function themeColors() {
  if (!_pal) _pal = buildPalette();
  return _pal;
}
function invalidatePalette() { _pal = null; }

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
/* 调内编辑（P0-1）：显式音阶优先，未配置时按音符直方图自动估计调式 */
let _autoScale = null;
function autoScale() {
  if (_autoScale) return _autoScale;
  const s = song();
  if (!s) return { root: 0, type: 'major' };
  const hist = new Array(12).fill(0);
  for (const tr of s.tracks) for (const n of tr.notes) hist[((n.midi % 12) + 12) % 12]++;
  let root = 0, max = 0;
  for (let i = 0; i < 12; i++) if (hist[i] > max) { max = hist[i]; root = i; }
  const minor = hist[(root + 3) % 12] >= hist[(root + 4) % 12];
  _autoScale = { root: root % 12, type: minor ? 'minor' : 'major' };
  return _autoScale;
}
/** 当前生效的音阶：显式配置优先，否则用自动判断结果 */
function effScale() { return props.scaleSpec || autoScale(); }
/** 该 tick 所在小节的和弦音级（无和弦轨返回 null） */
function chordPcsAt(tick) {
  if (!props.chordTrack || !props.chordTrack.length) return null;
  for (const b of props.chordTrack) if (tick >= b.tick && tick < b.endTick) return b.pcs;
  return null;
}
/** 约束集合：音阶调内音 ∪ 该小节和弦音 */
function constrainPcsAt(tick) {
  const s = scalePitchClasses(effScale());
  const set = s ? new Set(s) : new Set();
  const c = chordPcsAt(tick);
  if (c && c.length) for (const p of c) set.add(p);
  return set;
}
function scaleSnapPitch(midi, tick) {
  if (props.scaleMode !== 'constrain') return midi;
  return snapToPcs(midi, constrainPcsAt(tick == null ? viewTick.value : tick));
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
  // 维持「notes 按 start 升序」不变量：draw() 的视口裁剪用二分查找定位可见区间，
  // 新建/粘贴/拖动如果打乱顺序，新音符会落在窗口之外而整段画不出来（大文件尤其明显）。
  const ct = curTrack();
  if (ct) sortNotes(ct.notes);
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
  tr.notes.push({ start: Math.round(tick), end: Math.round(tick + len), midi: clamp(scaleSnapPitch(Math.round(midi), tick), 0, 127), vel: clamp(Math.round(props.defaultVelocity), 1, 127) });
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
/* 音符数组按 start 升序（同起点按音高）：仅在已乱序时才真正排序，代价 O(n) 检查 */
function sortNotes(ns) {
  for (let i = 1; i < ns.length; i++) {
    if (ns[i].start < ns[i - 1].start) { ns.sort((a, b) => a.start - b.start || a.midi - b.midi); return; }
  }
}
/* 静音：仅影响发声与显示，不改动力度/时值（撤销可回退） */
function toggleMute(n) {
  const tr = curTrack(); if (!tr || !n) return;
  pushState();
  n.muted = !n.muted;
  afterEdit();
}
function setSelMuted(on) {
  const tr = curTrack(); if (!tr || !selection.size) return;
  pushState();
  for (const n of selection) n.muted = !!on;
  afterEdit();
}
/* 选区静音状态：全静音返回 true，全不静音返回 false，混合返回 null */
function selMuted() {
  if (!selection.size) return null;
  let on = 0;
  for (const n of selection) if (n.muted) on++;
  return on === 0 ? false : (on === selection.size ? true : null);
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
/* ---------------------------------------------------------------- 五线谱绘制 */
function drawScore(g, W, HK) {
  const lay = scoreLayout(W, HK);
  if (!lay) return;
  const pal = themeColors();
  const { tr, gap, staffH, lineY0, leftPad, barW, barsPerSystem, bars, systes: _x } = lay;
  const sharp = lay.sharps;
  const keyAcc = (letter) => {
    // 调号里每个字母的升降：升号顺序 F C G D A E B，降号反过来
    const order = sharp ? [3, 0, 4, 1, 5, 2, 6] : [6, 2, 5, 1, 4, 0, 3];
    const n = Math.abs(lay.sf);
    for (let i = 0; i < n; i++) if (order[i] === letter) return sharp ? 1 : -1;
    return 0;
  };
  const ink = pal.steel || '#333';
  const line = pal.hair || 'rgba(0,0,0,.25)';
  const accent = pal.accent || '#3d8bfd';
  const selSet = selection;
  for (let sys = 0; sys < lay.systems; sys++) {
    const y0 = 8 + sys * lay.systemH - scoreScrollY.value;
    if (y0 + lay.systemH < -20 || y0 > HK + 20) continue;
    const top = y0 + lineY0, bottom = top + staffH, midY = top + staffH / 2;
    // 五线谱线
    g.strokeStyle = line; g.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const y = Math.round(top + i * gap) + 0.5;
      g.beginPath(); g.moveTo(leftPad - 26, y); g.lineTo(W - 8, y); g.stroke();
    }
    // 谱号（用 Unicode 音乐符号：𝄞 / 𝄢；字体链里带上符号字体）
    g.fillStyle = ink;
    g.font = (gap * 4.6) + 'px "Segoe UI Symbol", "Cambria Math", "Noto Music", serif';
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(lay.clef === 'bass' ? '\uD834\uDD22' : '\uD834\uDD1E', leftPad - 24, midY + gap * 1.55);
    // 调号（♯/♭）
    g.font = (gap * 2.1) + 'px "Segoe UI Symbol", "Cambria Math", serif';
    const order = sharp ? [3, 0, 4, 1, 5, 2, 6] : [6, 2, 5, 1, 4, 0, 3];
    const octOf = sharp ? [5, 5, 5, 5, 4, 4, 4] : [4, 4, 4, 4, 3, 3, 3];
    for (let i = 0; i < Math.min(7, Math.abs(lay.sf)); i++) {
      const letter = order[i];
      const dia = octOf[i] * 7 + letter;
      const midDia = scoreSpell(lay.clef === 'bass' ? 50 : 71, true).diatonic;
      const y = midY - ((dia - midDia) * gap) / 2;
      g.fillText(sharp ? '\u266F' : '\u266D', leftPad - 8 + i * (gap * 0.72), y + gap * 0.72);
    }
    // 拍号
    g.font = 'bold ' + (gap * 2.0) + 'px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(String(lay.sig.num), leftPad + 12, top + gap * 1.9);
    g.fillText(String(lay.sig.den), leftPad + 12, top + gap * 3.9);
    // 小节线（行内 barsThis 条）
    const firstBar = sys * barsPerSystem;
    const barsThis = Math.min(barsPerSystem, bars - firstBar);
    for (let b = 0; b <= barsThis; b++) {
      const x = Math.round(leftPad + b * barW) + 0.5;
      if (b === barsThis && firstBar + b < bars) continue;      // 行尾不画（下一行的开头画）
      g.strokeStyle = (b === 0) ? ink : line;
      g.lineWidth = (b === 0) ? 1.6 : 1;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
    }
    // 空小节：画一个全休止方块
    g.fillStyle = line;
    for (let b = 0; b < barsThis; b++) {
      const t0 = (firstBar + b) * lay.barTicks, t1 = t0 + lay.barTicks;
      let has = false;
      for (const n of tr.notes) { if (n.end > t0 && n.start < t1) { has = true; break; } }
      if (has) continue;
      const x = leftPad + b * barW + barW / 2;
      g.fillRect(x - gap * 0.7, top + staffH * 0.22, gap * 1.4, gap * 0.5);
    }
    // 音符
    for (const n of tr.notes) {
      const bar = Math.floor(n.start / lay.barTicks);
      if (bar < firstBar || bar >= firstBar + barsThis) continue;
      const xRaw = scoreXOf(lay, n.start);
      const x = Math.round(xRaw) + 0.5;
      const y = Math.round(y0 + scoreYOf(lay, n)) + 0.5;
      drawScoreNote(g, lay, n, x, y, midY, top, bottom, { ink, line, accent, selSet, keyAcc, sharp });
    }
    // 行号（小节号）
    g.fillStyle = pal.stone || '#888';
    g.font = '10px system-ui, sans-serif'; g.textAlign = 'left';
    g.fillText(String(firstBar + 1), leftPad + 2, y0 + 10);
  }
  // 播放头：按 tick 找行，画一条竖线
  // ★ 这里原来写的是 playTick.value —— 那个名字在本文件里根本没定义，
  //   一进乐谱视图就抛 ReferenceError（实测）。播放头位置跟迷你条用同一个来源。
  const pt = (() => { const sg = song(); return sg ? sg.secToTick(state.curSec / state.tempo) : null; })();
  if (pt != null && pt >= 0) {
    const bar = Math.floor(pt / lay.barTicks);
    const sys = Math.floor(bar / barsPerSystem);
    const y0 = 8 + sys * lay.systemH - scoreScrollY.value;
    if (y0 > -20 && y0 < HK + 20) {
      const x = Math.round(scoreXOf(lay, pt)) + 0.5;
      g.strokeStyle = accent; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(x, y0 + 4); g.lineTo(x, y0 + lay.systemH - 4); g.stroke();
    }
  }
}

/** 单个音符：符头 / 符干 / 符尾 / 符点 / 临时记号 / 加线 */
function drawScoreNote(g, lay, n, x, y, midY, top, bottom, ctxInfo) {
  const { ink, line, accent, selSet, keyAcc, sharp } = ctxInfo;
  const gap = lay.gap;
  const sp = scoreSpell(n.midi, sharp);
  const acc = sp.acc - keyAcc(sp.letter);
  const isSel = selSet.has(n);
  // 时值 → 符头形状与符尾数量
  const quarters = (n.end - n.start) / lay.tpb;
  let base = 1, dot = false;
  for (const q of [4, 2, 1, 0.5, 0.25, 0.125]) {
    if (Math.abs(quarters - q) < 0.02) { base = q; break; }
    if (Math.abs(quarters - q * 1.5) < 0.02) { base = q; dot = true; break; }
  }
  if (Math.abs(quarters - 1.5) < 0.02) { base = 1; dot = true; }
  const hollow = base >= 2;
  const noStem = base >= 4;
  const flags = base === 0.5 ? 1 : base === 0.25 ? 2 : base === 0.125 ? 3 : 0;
  // 加线
  g.strokeStyle = line; g.lineWidth = 1;
  const step = gap / 2;
  for (let yy = top - step; yy >= y - 1; yy -= gap) { g.beginPath(); g.moveTo(x - gap * 0.9, Math.round(yy) + 0.5); g.lineTo(x + gap * 0.9, Math.round(yy) + 0.5); g.stroke(); }
  for (let yy = bottom + step; yy <= y + 1; yy += gap) { g.beginPath(); g.moveTo(x - gap * 0.9, Math.round(yy) + 0.5); g.lineTo(x + gap * 0.9, Math.round(yy) + 0.5); g.stroke(); }
  // 临时记号
  if (acc !== 0) {
    g.fillStyle = ink;
    g.font = (gap * 2.0) + 'px "Segoe UI Symbol", "Cambria Math", serif';
    g.textAlign = 'center';
    g.fillText(acc > 0 ? '\u266F' : (acc < 0 ? '\u266D' : '\u266E'), x - gap * 1.5, y + gap * 0.7);
  }
  // 符头
  g.beginPath();
  g.ellipse(x, y, gap * 0.62, gap * 0.44, -0.35, 0, Math.PI * 2);
  if (isSel) { g.fillStyle = accent; g.fill(); }
  else if (hollow) { g.fillStyle = pal_canvas(g); g.fill(); g.strokeStyle = ink; g.lineWidth = 1.6; g.stroke(); }
  else { g.fillStyle = ink; g.fill(); }
  // 符干 + 符尾
  if (!noStem) {
    const up = y >= midY;
    const sx = up ? x + gap * 0.58 : x - gap * 0.58;
    const sy2 = up ? y - gap * 3.2 : y + gap * 3.2;
    g.strokeStyle = isSel ? accent : ink; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(sx, y); g.lineTo(sx, sy2); g.stroke();
    for (let f = 0; f < flags; f++) {
      const fy = sy2 + (up ? f * gap * 0.6 : -f * gap * 0.6);
      g.beginPath();
      if (up) { g.moveTo(sx, fy); g.quadraticCurveTo(sx + gap * 0.9, fy + gap * 0.5, sx + gap * 0.15, fy + gap * 1.1); }
      else { g.moveTo(sx, fy); g.quadraticCurveTo(sx - gap * 0.9, fy - gap * 0.5, sx - gap * 0.15, fy - gap * 1.1); }
      g.stroke();
    }
  }
  if (dot) { g.fillStyle = isSel ? accent : ink; g.beginPath(); g.arc(x + gap * 1.05, y, gap * 0.16, 0, Math.PI * 2); g.fill(); }
  // 歌词（MIDI 里有词时画在谱下）
  if (n.lyric) {
    g.fillStyle = pal_stone(g);
    g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.textAlign = 'center';
    g.fillText(String(n.lyric), x, bottom + gap * 2.2);
  }
}
function pal_canvas(g) { const p = themeColors(); return p.canvas || '#fff'; }
function pal_stone(g) { const p = themeColors(); return p.stone || '#888'; }
function draw() {
  const cv = canvas.value, wEl = wrap.value;
  if (!cv || !wEl) return;
  const s = song();
  const dpr = window.devicePixelRatio || 1;
  const W = wEl.clientWidth || 600;
  const HK = H.value;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(HK * dpr)) {
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(HK * dpr);
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, W, HK);
  const pal = themeColors();
  const bgTop = pal.canvas;
  const bgBottom = pal.surface;
  const hair = pal.hair;
  const border2 = pal.border2;
  const stone = pal.stone;
  const steel = pal.steel;
  const g = ctx2d.createLinearGradient(0, 0, 0, HK);
  g.addColorStop(0, bgTop); g.addColorStop(1, bgBottom);
  ctx2d.fillStyle = g; ctx2d.fillRect(0, 0, W, HK);
  if (!s) return;
  if (props.view === 'score') { drawScore(ctx2d, W, HK); return; }

  const lo = viewTop.value - Math.ceil(HK / rowH.value);
  const hi = viewTop.value;
  const isBlack = m => { const p = ((m % 12) + 12) % 12; return [1, 3, 6, 8, 10].includes(p); };
  // 键盘行背景
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) continue;
    ctx2d.fillStyle = pal.rowAlt;
    ctx2d.fillRect(0, (hi - m) * rowH.value, W, rowH.value);
  }
  // 调内音高亮：非「关闭」模式下，把调内音所在行铺一层浅色带（Studio One 的 Scale Panel 效果）
  // 有和弦轨时按小节绘制「音阶 ∪ 和弦音」，否则整屏统一按音阶
  if (props.scaleMode !== 'off') {
    ctx2d.fillStyle = pal.tint;
    if (props.chordTrack && props.chordTrack.length) {
      for (const bar of props.chordTrack) {
        const x0 = Math.max(0, tickToX(bar.tick)), x1 = Math.min(W, tickToX(bar.endTick));
        if (x1 <= 0 || x0 >= W) continue;
        const set = constrainPcsAt(bar.tick);
        if (!set.size) continue;
        for (let m = lo; m <= hi; m++) {
          if (!set.has(((m % 12) + 12) % 12)) continue;
          ctx2d.fillRect(x0, (hi - m) * rowH.value, Math.max(1, x1 - x0), rowH.value);
        }
      }
    } else {
      const set = scalePitchClasses(effScale());
      if (set) {
        for (let m = lo; m <= hi; m++) {
          if (!set.has(((m % 12) + 12) % 12)) continue;
          ctx2d.fillRect(0, (hi - m) * rowH.value, W, rowH.value);
        }
      }
    }
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
    ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, HK); ctx2d.stroke();
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
      ctx2d.fillStyle = pal.ksBg;
      ctx2d.fillRect(0, y, W, rowH.value);
      ctx2d.fillStyle = pal.ksFg;
      ctx2d.fillText((props.ksMap[m] || '').slice(0, 10), 52, y + rowH.value - 3);
    }
  }
  // 音符（大文件裁剪：notes 按 start 升序，仅遍历视口附近区间，避免每帧全量扫描）
  // viewT0/viewT1 已在网格段声明；winTic = 一个屏幕宽的 tick，作为向前回退窗口（覆盖跨屏长音）
  // 注意：此处二分变量不得命名为 lo/hi —— 外层 lo/hi 是音域（draw 开头声明），
  // 遮蔽会导致下方 y=(hi-midi)*rowH 用「音符数」当「最高音」，音符全部画到画布外不可见。
  const winTic = viewT1 - viewT0;
  // 「按音阶」着色（M4）：每帧只算一次调内音集合（逐音符算会在大文件上炸）
  const scaleSet = props.colorMode === 'scale' ? constrainPcsAt(null) : null;
  for (const tr of s.tracks) {
    const col = noteColor(tr.index, pal);
    const ns = tr.notes;
    if (!ns.length) continue;
    // 上界：start <= viewT1
    let uLo = 0, uHi = ns.length;
    while (uLo < uHi) { const m = (uLo + uHi) >> 1; if (ns[m].start <= viewT1) uLo = m + 1; else uHi = m; }
    // 下界：start >= viewT0 - 一个屏幕宽
    let a = 0, b = uLo, t0lo = viewT0 - winTic;
    while (a < b) { const m = (a + b) >> 1; if (ns[m].start < t0lo) a = m + 1; else b = m; }
    const isCur = tr === curTrack();
    for (let k = a; k < uLo; k++) {
      const n = ns[k];
      const x = tickToX(n.start), w2 = Math.max(2, tickToX(n.end) - x);
      const y = (hi - n.midi) * rowH.value;
      if (x > W || x + w2 < 0) continue;
      const sel = isCur && selection.has(n);
      // 着色方案：非当前轨道一律灰（保持「正在编辑哪条轨」的视觉层级）
      let fill = steel;
      if (isCur) {
        if (props.colorMode === 'pitch') fill = pitchColor(n.midi, pal);
        else if (props.colorMode === 'velocity') fill = velColor(n.vel, pal);
        else if (props.colorMode === 'selection') fill = sel ? pal.sel : steel;
        // 调外音用高亮色标出来 —— 校对「转谱结果里有没有跑调的音」时比看音高更快
        else if (props.colorMode === 'scale') fill = (!scaleSet || !scaleSet.size) ? col : (scaleSet.has(((n.midi % 12) + 12) % 12) ? col : pal.sel);
        else fill = col;
      }
      // 静音音符半透明显示（不发声，但仍可编辑）
      ctx2d.globalAlpha = n.muted ? 0.35 : 0.85;
      ctx2d.fillStyle = fill;
      ctx2d.fillRect(x, y + 1, w2, rowH.value - 2);
      ctx2d.globalAlpha = 1;
      if (sel) {
        ctx2d.strokeStyle = pal.sel; ctx2d.lineWidth = 1.5;
        ctx2d.strokeRect(x - 1, y, w2 + 2, rowH.value);
      }
    }
  }
  ctx2d.globalAlpha = 1;
  // 音频波形（卷帘底部）：按 tick 对齐显示原始音频包络
  const a = props.audio;
  if (a && a.data && a.rate) {
    const WAVE_H = 42;
    const yBase = HK - WAVE_H;
    ctx2d.fillStyle = pal.waveBg; ctx2d.fillRect(0, yBase, W, WAVE_H);
    ctx2d.strokeStyle = pal.curve; ctx2d.lineWidth = 1;
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
    ctx2d.strokeStyle = pal.waveBar;
    ctx2d.beginPath(); ctx2d.moveTo(0, yBase); ctx2d.lineTo(W, yBase); ctx2d.stroke();
    ctx2d.fillStyle = pal.curve; ctx2d.font = '9px monospace'; ctx2d.textAlign = 'right';
    ctx2d.fillText(t('音频'), W - 4, yBase + 11);
  }
  // 画笔预览
  if (dragState.value && dragState.value.type === 'create') {
    const d = dragState.value;
    const x = tickToX(d.startTick), w2 = Math.max(2, tickToX(d.startTick + d.len) - x);
    const y = (hi - d.startMidi) * rowH.value;
    ctx2d.fillStyle = pal.tintStrong;
    ctx2d.fillRect(x, y + 1, w2, rowH.value - 2);
    ctx2d.strokeStyle = pal.curve; ctx2d.lineWidth = 1.2;
    ctx2d.strokeRect(x - 1, y, w2 + 2, rowH.value);
  }
  // 步进指针（M4）：当前这一格的整条竖带 + 顶边把手，看得见「下一个音落哪」
  if (props.stepOn) {
    const len = Math.max(30, Math.round(props.stepTicks || 120));
    const sx = tickToX(stepCursor.value);
    const sw = Math.max(2, tickToX(stepCursor.value + len) - sx);
    ctx2d.fillStyle = pal.tintStrong;
    ctx2d.fillRect(sx, 0, sw, HK);
    ctx2d.strokeStyle = pal.curve; ctx2d.lineWidth = 1.2;
    ctx2d.strokeRect(sx + 0.5, 0.5, sw - 1, HK - 1);
    ctx2d.fillStyle = pal.curve; ctx2d.fillRect(sx, 0, sw, 3);
  }
  // 播放头
  const curTick = s.secToTick(state.curSec / state.tempo);
  const px = tickToX(curTick);
  const pg = ctx2d.createLinearGradient(0, 0, 0, HK);
  pg.addColorStop(0, pal.playhead); pg.addColorStop(1, pal.playheadSoft);
  ctx2d.fillStyle = pg;
  ctx2d.fillRect(px - 1, 0, 2.5, HK);
  ctx2d.fillStyle = pal.playhead; ctx2d.fillRect(px - 4, 0, 8, 3);
  // 框选
  if (dragState.value && dragState.value.type === 'marquee' && dragState.value.box) {
    const b = dragState.value.box;
    ctx2d.strokeStyle = pal.curve; ctx2d.lineWidth = 1;
    ctx2d.strokeRect(b.x, b.y, b.w, b.h);
    ctx2d.fillStyle = pal.tintStrong;
    ctx2d.fillRect(b.x, b.y, b.w, b.h);
  }
}
const dragState = ref(null);

/* ---------------- CC 泳道 ---------------- */
const ccDrawing = ref(false);
const ccLast = ref(null);   // {tick, val}
function drawCC(g, W, H2, ccNum) {
  const s = song();
  const pal = themeColors();
  g.clearRect(0, 0, W, H2);
  g.fillStyle = pal.laneBg; g.fillRect(0, 0, W, H2);
  const name = CC_NAMES[ccNum] || ('CC' + ccNum);
  const hair = pal.hair;
  const stone = pal.stone;
  const slate = pal.steel;
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
  g.strokeStyle = pal.cc; g.lineWidth = 1.4; g.beginPath();
  for (let i = 0; i < ccs.length; i++) {
    const x = tickToX(ccs[i].tick);
    const y = H2 - 4 - (ccs[i].cv / 127) * (H2 - 12);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.fillStyle = pal.cc;
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
/* ================================================================
 * 五线谱视图（view === 'score'）
 * ----------------------------------------------------------------
 * 自己刻谱而不是引第三方库（VexFlow/OSMD）：
 *   1. 引擎侧已经有 abcjs/Verovio 只读刻本（乐谱页），但它们是 SVG、不可编辑；
 *   2. 编辑需要「像素 ↔ 音高/时值」双向映射与命中测试，自己刻反而短；
 *   3. 离线包不引入新依赖。
 * 只做单声部旋律谱（这是「改 MIDI」的常见诉求）：五线谱 + 谱号 + 调号 + 拍号 + 小节线，
 * 音符含符干/符尾/符点/临时记号/加线；不画连桁与休止符（空小节给全休止方块）。
 * ================================================================ */
const scoreScrollY = ref(0);
const scoreClef = ref('auto');            // auto | treble | bass
const insertTicks = ref(0);               // 画笔插入时用的时值（0 = 用一拍）
const insertDot = ref(false);
const SCORE_LETTER_SEMI = [0, 2, 4, 5, 7, 9, 11];
const SCORE_PC_TO_LETTER = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];   // 升号拼写
const SCORE_FLAT_MAP = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [3, 1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
const SCORE_GLYPH = { 0: 'w', 1: 'h', 2: 'q', 3: 'e', 4: 's', 5: 't' };   // 由「四分音符数」反查时值

/** 音高拼写：升号优先（keySf < 0 时用降号） */
function scoreSpell(midi, sharps) {
  const pc = ((midi % 12) + 12) % 12;
  let letter, acc;
  if (sharps) { letter = SCORE_PC_TO_LETTER[pc]; acc = pc - SCORE_LETTER_SEMI[letter]; }
  else { const f = SCORE_FLAT_MAP[pc]; letter = f[0]; acc = f[1]; }
  const octave = Math.floor(midi / 12) - 1;
  return { letter, acc, octave, diatonic: octave * 7 + letter };
}

/** 由「全音阶序号 + 变音记号」还原 MIDI 音高 */
function scorePitchOf(diatonic, acc) {
  const letter = ((diatonic % 7) + 7) % 7;
  const octave = Math.floor(diatonic / 7);
  const midi = SCORE_LETTER_SEMI[letter] + acc + 12 * (octave + 1);
  return Math.max(0, Math.min(127, midi));
}

/** 调号：优先用曲目的 keySig，没有就按音符分布猜（core/score.js 的 detectSf） */
function scoreKeySf(tr) {
  const s = song();
  if (s && s.keySig && typeof s.keySig.sf === 'number') return s.keySig.sf;
  try { return detectSf((tr && tr.notes) || []); } catch (e) { return 0; }
}

/** 谱号：旋律整体偏低自动换低音谱号（也可由工具栏强制） */
function scoreClefNow(tr) {
  if (scoreClef.value !== 'auto') return scoreClef.value;
  const ns = (tr && tr.notes) || [];
  if (!ns.length) return 'treble';
  let sum = 0;
  for (const n of ns) sum += n.midi;
  return (sum / ns.length) < 59 ? 'bass' : 'treble';
}

/** 谱面几何：每行几小节、音符画在哪（绘制与命中测试共用同一份布局） */
function scoreLayout(W, HK) {
  const s = song(), tr = curTrack();
  if (!s || !tr) return null;
  const tpb = s.tpb || 480;
  const sig = (s.sigMap && s.sigMap.length) ? s.sigMap[0] : { num: 4, den: 4 };
  const beatsPerBar = Math.max(1, sig.num * (4 / (sig.den || 4)));
  const barTicks = beatsPerBar * tpb;
  const sf = scoreKeySf(tr);
  const sharps = sf >= 0;
  const clef = scoreClefNow(tr);
  const gap = Math.max(5, Math.round(5 * Math.min(1.8, Math.max(0.7, zoom.value))));   // 线间距
  const lineY0 = 30;                                     // 第一行五线谱的顶线（相对行内）
  const staffH = gap * 4;
  const systemH = staffH + gap * 5.5;                    // 一行占的高度（上下留白）
  const leftPad = 66;                                    // 谱号 + 调号 + 拍号
  const rightPad = 10;
  const beatPx = Math.max(9, pxPerBeat.value * 0.85);
  const barW = Math.max(96, beatsPerBar * beatPx);
  const barsPerSystem = Math.max(1, Math.floor((W - leftPad - rightPad) / barW));
  const lastTick = Math.max(barTicks, maxTickOf(tr));
  const bars = Math.max(1, Math.ceil(lastTick / barTicks));
  const systems = Math.max(1, Math.ceil(bars / barsPerSystem));
  return { s, tr, tpb, sig, beatsPerBar, barTicks, sf, sharps, clef, gap, lineY0, staffH, systemH,
           leftPad, rightPad, barW, barsPerSystem, bars, systems, W, HK };
}
function maxTickOf(tr) { let m = 0; for (const n of tr.notes || []) m = Math.max(m, n.end); return m; }

/** 音符在谱面上的 y（全音阶序号 → 像素）。五线谱 E4=0 线序的换算在这里集中 */
function scoreYOf(lay, n) {
  const midB = lay.clef === 'bass' ? 50 : 71;          // 低音谱号中线 D3=50；高音谱号中线 B4=71
  const midDia = scoreSpell(midB, true).diatonic;
  const dia = scoreSpell(n.midi, lay.sharps).diatonic;
  const midY = lay.lineY0 + lay.staffH / 2;
  return midY - ((dia - midDia) * lay.gap) / 2;
}

/** 音符 x：按 tick 线性映射（与卷帘同一个 pxPerBeat 语义，缩放一致） */
function scoreXOf(lay, tick) {
  const bar = Math.floor(tick / lay.barTicks);
  const inBar = tick - bar * lay.barTicks;
  const barIdx = bar % lay.barsPerSystem;
  return lay.leftPad + barIdx * lay.barW + (inBar / lay.barTicks) * (lay.barW - 12);
}
function scoreSystemY(lay, tick) {
  const bar = Math.floor(tick / lay.barTicks);
  return 8 + Math.floor(bar / lay.barsPerSystem) * lay.systemH - scoreScrollY.value;
}
function scoreTickAt(lay, x, y) {
  const row = Math.floor((y - 8 + scoreScrollY.value) / lay.systemH);
  const localX = x - lay.leftPad;
  const barIdx = Math.max(0, Math.min(lay.barsPerSystem - 1, Math.floor(localX / lay.barW)));
  const frac = Math.max(0, Math.min(1, (localX - barIdx * lay.barW) / (lay.barW - 12)));
  const bar = row * lay.barsPerSystem + barIdx;
  return Math.round((bar * lay.barTicks + frac * lay.barTicks) / 5) * 5;
}
/** 由 y 反推该处的音高（保留原音符的变音记号） */
function scorePitchAt(lay, y, acc) {
  const midB = lay.clef === 'bass' ? 50 : 71;
  const midDia = scoreSpell(midB, true).diatonic;
  const midY = lay.lineY0 + lay.staffH / 2;
  const dia = midDia + Math.round(((midY - y) * 2) / lay.gap);
  return scorePitchOf(dia, acc);
}

/** 乐谱命中：符头附近（半径 ≈ 一个线间距）算命中 */
function scoreHit(x, y) {
  const lay = scoreLayout(wrap.value ? wrap.value.clientWidth : 600, H.value);
  if (!lay) return null;
  const r = Math.max(8, lay.gap * 1.2);
  let best = null, bestD = 1e9;
  for (const n of lay.tr.notes) {
    const ny = scoreSystemY(lay, n.start) + scoreYOf(lay, n);
    const nx = scoreXOf(lay, n.start);
    const d = Math.hypot(nx - x, ny - y);
    if (d <= r && d < bestD) { bestD = d; best = n; }
  }
  return best;
}

/** 乐谱视图里按下鼠标：选中 / 画笔插入 / 竖直拖动改音高 */
function scoreDown(e, x, y, multi) {
  const lay = scoreLayout(wrap.value ? wrap.value.clientWidth : 600, H.value);
  if (!lay) return;
  const hitNote = scoreHit(x, y);
  if (props.tool === 'pencil' && !hitNote) {
    const tick = snapTick(scoreTickAt(lay, x, y));
    const midi = scorePitchAt(lay, y, 0);
    const len = Math.max(30, insertTicks.value || (insertDot.value ? Math.round(lay.tpb * 1.5) : lay.tpb));
    const note = { start: Math.max(0, tick), end: Math.max(0, tick) + len, midi, vel: props.defaultVelocity, ch: (curTrack() && curTrack().ch) || 0 };
    pushState();
    lay.tr.notes.push(note);
    sortNotes(lay.tr.notes);
    selection.clear(); selection.add(note);
    dragState.value = { type: 'score-move', notes: [note], startX: x, startY: y,
                        orig: [{ n: note, midi: note.midi, start: note.start, end: note.end }], moved: false };
    afterEdit(); emit('modify'); emit('select'); draw();
    return;
  }
  if (!hitNote) { if (!multi) selection.clear(); emit('select'); draw(); return; }
  if (!multi && !selection.has(hitNote)) { selection.clear(); selection.add(hitNote); }
  else if (multi && selection.has(hitNote)) selection.delete(hitNote);
  else if (multi) selection.add(hitNote);
  if (!selection.has(hitNote)) { dragState.value = null; draw(); return; }
  pushState();
  dragState.value = { type: 'score-move', notes: [...selection], startX: x, startY: y,
                      orig: [...selection].map((n) => ({ n, midi: n.midi, start: n.start, end: n.end })), moved: false };
  emit('select'); draw();
}

/** 乐谱视图里的拖动：竖直按**全音阶**换音高（保留变音记号），水平按拍移动 */
function scoreMove(x, y) {
  const d = dragState.value;
  const lay = scoreLayout(wrap.value ? wrap.value.clientWidth : 600, H.value);
  if (!d || !lay) return;
  const step = Math.max(2, lay.gap / 2);
  const diaSteps = Math.round((d.startY - y) / step);
  const tickPerPx = lay.barTicks / Math.max(1, lay.barW - 12);
  const dTickRaw = (x - d.startX) * tickPerPx;
  const dTick = snapTick(Math.abs(dTickRaw)) * (dTickRaw < 0 ? -1 : 1);
  for (const o of d.orig) {
    const sp = scoreSpell(o.midi, lay.sharps);
    o.n.midi = scorePitchOf(sp.diatonic + diaSteps, sp.acc);
    o.n.start = Math.max(0, Math.round(o.start + dTick));
    o.n.end = Math.max(o.n.start + 1, Math.round(o.end + dTick));
  }
  d.moved = d.moved || diaSteps !== 0 || dTick !== 0;
  if (d.moved) emit('modify');
  draw();
}

function hitTest(x, y) {
  if (props.view === 'score') return scoreHit(x, y);
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
  if (props.view === 'score') {
    scoreDown(e, x, y, multi);
    try { canvas.value.setPointerCapture(e.pointerId); } catch (err) {}
    return;
  }
  if (props.tool === 'pencil' && props.stepOn) {
    // 步进：音高来自点击位置，**位置来自指针**，落完整步前进
    const midi = yToMidi(y);
    if (midi < 0 || midi > 127) return;
    const len = Math.max(30, Math.round(props.stepTicks || 120));
    const st = Math.max(0, Math.round(stepCursor.value));
    pushState();
    const note = { start: st, end: st + len, midi: clamp(scaleSnapPitch(midi, st), 0, 127), vel: clamp(Math.round(props.defaultVelocity), 1, 127) };
    tr.notes.push(note);
    selection.clear(); selection.add(note);
    stepCursor.value = st + len;
    emit('step', stepCursor.value);
    afterEdit();
    emit('select');
    return;
  }
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
  } else if (props.tool === 'mute') {
    // 静音工具：点击音符切换 muted（不改力度、不删音符，可撤销）
    const n = hitTest(x, y);
    if (n) toggleMute(n);
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
      // M3 修饰键：Alt+拖拽 = 改力度（画布上最常用的「手感」参数）。
      // 命中音符若已在多选集合里，就对整个选区生效，否则只动这一个。
      if (e.altKey) {
        const targets = selection.has(n) && selection.size > 1 ? [...selection] : [n];
        dragState.value = { type: 'vel', notes: targets, startX: x, startY: y, orig: targets.map((m) => ({ vel: m.vel })), hit: n };
      } else {
        let type = 'move';
        if (Math.abs(nx2 - x) < 7) type = 'resize';
        else if (Math.abs(x - nx) < 7) type = 'resize-left';
        dragState.value = { type, notes: [n], startX: x, startY: y, orig: [{ start: n.start, end: n.end, midi: n.midi }] };
      }
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
  if (d.type === 'score-move') { scoreMove(x, y); return; }
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
  } else if (d.type === 'vel') {
    // 竖直拖动改力度：约 2px = 1 级，够细也够快
    const dv = (d.startY - y) * 0.5;
    d.notes.forEach((n, i) => { n.vel = clamp(Math.round(d.orig[i].vel + dv), 1, 127); });
    draw();
    return;
  } else if (d.type === 'move') {
    const dTick = (x - d.startX) / pxPerTick.value;
    // M3 修饰键：Shift+拖拽 = 锁定音高，只改时间位置
    const dMidi = e.shiftKey ? 0 : (d.startY - y) / rowH.value;
    const orig = d.orig || [];
    d.notes.forEach((n, i) => {
      const o = orig[i];
      const ns = Math.max(0, o.start + Math.round(dTick));
      n.start = ns; n.end = Math.max(ns + 1, o.end + Math.round(dTick));
      n.midi = clamp(o.midi + Math.round(dMidi), 0, 127);
    });
    // 拖动改 start：实时维持升序，否则被拖的音符可能落在二分窗口外而看不见
    const trM = curTrack(); if (trM) sortNotes(trM.notes);
    draw();
  } else if (d.type === 'resize' || d.type === 'resize-left') {
    const n = d.notes[0], o = d.orig[0];
    if (d.type === 'resize') {
      n.end = Math.max(o.start + 60, snapTick(xToTick(x)));
    } else {
      n.start = Math.max(0, Math.min(o.end - 60, snapTick(xToTick(x))));
    }
    const trR = curTrack(); if (trR) sortNotes(trR.notes);
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
  if (d.type === 'score-move') {
    // 拖动期间已就地改过数据（撤销栈在 onDown 里入栈），这里只做收尾与重排
    if (d.moved) { afterEdit(); emit('modify'); }
    dragState.value = null;
    draw();
    return;
  }
  if ((d.type === 'move' || d.type === 'resize' || d.type === 'resize-left' || d.type === 'vel') && d.notes.length && tr) {
    // 位置/长度已在拖拽中直接修改；状态在 onDown 时已入撤销栈
    if (d.type === 'move' && props.scaleMode === 'constrain') {
      for (const n of d.notes) n.midi = clamp(snapToPcs(n.midi, constrainPcsAt(n.start)), 0, 127);
    }
    afterEdit();
  } else if (d.type === 'create' && tr) {
    pushState();
    const len = Math.max(d.len || Math.max(song()?.tpb || 480, 120), 60);
    const st = Math.round(d.startTick);
    const en = Math.round(st + len);
    tr.notes.push({ start: st, end: en, midi: clamp(scaleSnapPitch(Math.round(d.startMidi), st), 0, 127), vel: clamp(Math.round(props.defaultVelocity), 1, 127) });
    afterEdit();
  } else if (d.type === 'marquee' && d.box) {
    emit('select');
    draw();
  }
  dragState.value = null;
}
/* ---------------- 步进输入（M4） ----------------
   Cubase/Logic 的 Step Input：画笔不在「点哪落哪」，而是落在**指针**上，落完自动前进一格。
   指针位置用 emit('step') 回报给上层（工具条要显示它在第几拍），也支持 ← → 手动走。 */
const stepCursor = ref(0);
function setStepCursor(v) { stepCursor.value = Math.max(0, Math.round(v || 0)); emit('step', stepCursor.value); draw(); }
function stepBy(n) { const d = Math.max(30, Math.round(props.stepTicks || 120)); setStepCursor(stepCursor.value + n * d); }
function stepAt() { return stepCursor.value; }

/* ---------------- 悬停工具条（M3） ----------------
   鼠标压到音符上时通知上层弹一条就地工具条（FL / Studio One 的做法）。
   只在**命中的音符发生变化**时才 emit：pointermove 一秒几十次，无脑 emit 会把 Vue 刷爆。 */
let hoverNote = null;
function onHoverMove(e) {
  if (dragState.value) { if (hoverNote) { hoverNote = null; emit('hover', null); } return; }
  const rect = canvas.value.getBoundingClientRect();
  const n = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (n === hoverNote) return;
  hoverNote = n;
  if (!n) { emit('hover', null); return; }
  emit('hover', {
    x: e.clientX, y: e.clientY, midi: n.midi, name: noteName(n.midi), vel: n.vel,
    muted: !!n.muted, sel: selection.has(n), count: selection.has(n) ? selection.size : 1,
    len: Math.round(n.end - n.start),
  });
}
function onHoverLeave() { if (hoverNote) { hoverNote = null; emit('hover', null); } }
/** 画布内坐标命中的音符（测试与外部工具用；坐标为画布左上角起算的 CSS px） */
function hitAt(x, y) {
  const n = hitTest(x, y);
  if (!n) return null;
  return { midi: n.midi, name: noteName(n.midi), vel: n.vel, start: n.start, len: Math.round(n.end - n.start), muted: !!n.muted };
}
/** 悬停工具条上的就地操作：命中音符在多选里就作用于整个选区，否则只动它 */
function hoverAction(kind) {
  const tr = curTrack(); const n = hoverNote;
  if (!tr || !n || !tr.notes.includes(n)) return 0;
  const targets = (selection.has(n) && selection.size > 1) ? [...selection] : [n];
  pushState();
  for (const x of targets) {
    if (kind === 'velUp') x.vel = clamp(x.vel + 5, 1, 127);
    else if (kind === 'velDown') x.vel = clamp(x.vel - 5, 1, 127);
    else if (kind === 'half') x.end = x.start + Math.max(30, Math.round((x.end - x.start) / 2));
    else if (kind === 'double') x.end = x.start + Math.max(30, Math.round((x.end - x.start) * 2));
    else if (kind === 'mute') x.muted = !x.muted;
    else if (kind === 'del') { /* 删除在下面统一处理（要动数组） */ }
  }
  if (kind === 'del') {
    for (const x of targets) { const i = tr.notes.indexOf(x); if (i >= 0) tr.notes.splice(i, 1); }
    for (const x of targets) selection.delete(x);
    hoverNote = null;
    emit('hover', null);
  }
  afterEdit();
  return targets.length;
}
/** 把悬停的音符设为当前选中（供「更多工具」这类需要选区的入口用） */
function selectHover() {
  const n = hoverNote; const tr = curTrack();
  if (!n || !tr || !tr.notes.includes(n)) return 0;
  selection.clear(); selection.add(n);
  emit('select'); draw();
  return 1;
}

/* 右键菜单：命中音符时先选中它，再把坐标交给上层（ViewEdit）弹菜单 */
function onCtxMenu(e) {
  const s = song(), tr = curTrack();
  if (!s || !tr) { emit('ctxmenu', { x: e.clientX, y: e.clientY, hit: false, tick: 0, midi: 60 }); return; }
  const rect = canvas.value.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const n = hitTest(x, y);
  if (n && !selection.has(n)) { selection.clear(); selection.add(n); emit('select'); draw(); }
  emit('ctxmenu', {
    x: e.clientX, y: e.clientY,
    hit: !!(n || selection.size),
    tick: snapTick(xToTick(x)),
    midi: yToMidi(y),
  });
}
function onWheel(e) {
  e.preventDefault();
  const rect = canvas.value.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  if (props.view === 'score') {
    // 谱面是「一行一行往下排」，所以滚轮滚的是可见行（Ctrl 才缩放）
    if (e.ctrlKey || e.metaKey) {
      const nz = clamp(zoom.value * (e.deltaY < 0 ? 1.15 : 0.87), 0.4, 2.5);
      zoom.value = nz; emit('zoom', zoom.value);
    } else {
      const lay = scoreLayout(rect.width, H.value);
      const maxY = lay ? Math.max(0, lay.systems * lay.systemH + 16 - H.value) : 0;
      scoreScrollY.value = Math.max(0, Math.min(maxY, scoreScrollY.value + e.deltaY));
    }
    draw();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    const before = xToTick(mx);
    const nz = clamp(zoom.value * (e.deltaY < 0 ? 1.15 : 0.87), 0.4, 2.5);
    zoom.value = nz;
    viewTick.value = before - mx / pxPerTick.value;
    emit('zoom', zoom.value);
  } else if (e.shiftKey) {
    viewTick.value = Math.max(0, viewTick.value + e.deltaY / pxPerTick.value);
  } else {
    // viewTop = 屏幕顶部的音高。滚轮向下（deltaY>0）应看到更低的音高 → viewTop 减小
    // （原先为 +=，方向与滚轮直觉相反）
    viewTop.value = clamp(viewTop.value - e.deltaY / rowH.value, 0, 127);
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
  if (props.view === 'score') {
    const lay = scoreLayout(wrap.value ? wrap.value.clientWidth : 600, H.value);
    if (lay) {
      const bar = Math.floor(first.start / lay.barTicks);
      const sys = Math.floor(bar / lay.barsPerSystem);
      const y = sys * lay.systemH;
      if (y < scoreScrollY.value || y + lay.systemH > scoreScrollY.value + H.value) {
        scoreScrollY.value = Math.max(0, y - lay.systemH * 0.5);
      }
    }
    draw();
    return;
  }
  viewTick.value = Math.max(0, first.start - (song()?.tpb || 480) * 2);
  draw();
}
/* 乐谱：画笔插入用的时值（拍数 → tick，附点再 ×1.5） */
function setInsert(ticks, dot) {
  if (ticks != null) insertTicks.value = Math.max(0, Math.round(ticks));
  if (dot != null) insertDot.value = !!dot;
}
function deleteSelected() { if (selection.size) deleteNotes([...selection]); }
function quantizeSelected(ratio) { if (selection.size) quantize([...selection], ratio); }
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
/* ---------------- 参数化工具的实时预览（M2） ----------------
   预览期间**不碰撤销栈**：beginPreview 存一份「选中音符的字段基线」，
   每次 applyPreviewNow 先把字段恢复成基线、再从基线重算 —— 于是拖动滑杆 200 次
   撤销栈也只多一条（commit 时才把基线压进去），Esc 能把整段预览一次还原。
   只记字段、不换对象：选中集合是对象引用的 Set，换成新对象会让选择当场失效。 */
let previewBase = null;
/** order：可选，指定预览基线的顺序（列表编辑器要把「表格第 i 行」稳定映射到音符，
    所以传它自己那份按 start 排序的引用数组）。不传就用选择集合的插入顺序。 */
function beginPreview(order) {
  const tr = curTrack();
  if (!tr || !selection.size) { previewBase = null; return 0; }
  const arr = (Array.isArray(order) && order.length) ? order.filter((n) => tr.notes.includes(n)) : [...selection];
  if (!arr.length) { previewBase = null; return 0; }
  previewBase = arr.map((n) => ({ n, start: n.start, end: n.end, midi: n.midi, vel: n.vel, muted: !!n.muted }));
  return previewBase.length;
}
function previewing() { return !!previewBase; }
function previewCount() { return previewBase ? previewBase.length : 0; }
function restorePreviewBase() {
  for (const b of previewBase) {
    const { n } = b;
    n.start = b.start; n.end = b.end; n.midi = b.midi; n.vel = b.vel;
    if (b.muted) n.muted = true; else n.muted = false;
  }
}
/** 从基线重算一次：fn(notes) 直接改 note 对象，返回改动条数 */
function applyPreviewNow(fn) {
  if (!previewBase) return 0;
  restorePreviewBase();
  let changed = 0;
  try { changed = fn(previewBase.map((b) => b.n)) || 0; } catch (e) { changed = 0; }
  const tr = curTrack(); if (tr) sortNotes(tr.notes);
  emit('modify');
  draw();
  return changed;
}
function commitPreview() {
  if (!previewBase) return 0;
  const after = previewBase.map((b) => ({ start: b.n.start, end: b.n.end, midi: b.n.midi, vel: b.n.vel, muted: !!b.n.muted }));
  restorePreviewBase();
  pushState();                       // 存的是「预览之前」的轨道，撤销一次回到预览前
  previewBase.forEach((b, i) => {
    const a = after[i];
    b.n.start = a.start; b.n.end = a.end; b.n.midi = a.midi; b.n.vel = a.vel; b.n.muted = a.muted;
  });
  const n = previewBase.length;
  previewBase = null;
  afterEdit();
  return n;
}
function cancelPreview() {
  if (!previewBase) return 0;
  restorePreviewBase();
  const n = previewBase.length;
  previewBase = null;
  const tr = curTrack(); if (tr) sortNotes(tr.notes);
  emit('modify');
  draw();
  return n;
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
  toggleMute, setSelMuted, selMuted,
  addPedal, delPedal, selSpan, addNote, deleteNotes, pushStateForTrack, notifyExternalEdit,
  // 参数化工具的实时预览（M2）
  beginPreview, previewing, previewCount, applyPreviewNow, commitPreview, cancelPreview,
  // 悬停工具条（M3）
  hoverAction, selectHover, hitAt,
  // 步进输入（M4）
  setStepCursor, stepBy, stepAt,
  undo, redo, canUndo, canRedo, clearHistory, historySnapshots,
  snapSelToAudio,
  // 乐谱视图（五线谱）对外：滚动/谱号/插入时值/重绘
  scoreScrollY, scoreClef, insertTicks, insertDot, setInsert, draw,
});

/* ---------------- 生命周期 ---------------- */
// 绘制循环改为「按需重绘」：只有在内容变化（dirty）或正在播放（播放头每帧移动）时才真正画。
// 原实现无条件每帧 draw()+ccDrawLane()，大 MIDI（9 万+音符）下会把主线程占满，
// 且被 KeepAlive 保活的组件离开页面后仍在烧 CPU —— 表现为「整个界面卡」。
let raf = 0;
let dirty = true;
// 可见性：KeepAlive 把被缓存的子树移入 0×0 的隐藏容器，v-show 隐藏同理，尺寸都会归零。
// onDeactivated 只会对被缓存组件的「根」触发，嵌套组件收不到 —— 所以用尺寸变化来判定可见性，
// 隐藏时 loop 直接空转（不读画布、不绘制）。
let visible = false;
// 高刷屏上 rAF 可达 300fps，而播放头/曲线这类连续重绘 60fps 已足够：
// 用最小帧间隔限流，避免 5 倍的无谓绘制（实测本机 rAF=300fps）。
const MIN_FRAME_MS = 15;
let lastPaint = 0;
function markDirty() { dirty = true; }
function loop(ts) {
  const now = ts || performance.now();
  if (visible && (dirty || state.playing) && (dirty || now - lastPaint >= MIN_FRAME_MS)) {
    dirty = false;
    lastPaint = now;
    draw();
    if (props.ccEnabled) ccDrawLane();
  }
  raf = requestAnimationFrame(loop);
}
function startLoop() { if (!raf) raf = requestAnimationFrame(loop); }
function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

watch(() => currentSong.value, () => { selection.clear(); _autoScale = null; resetView(); markDirty(); draw(); });
watch(() => props.trackIndex, () => { selection.clear(); markDirty(); draw(); if (props.ccEnabled) ccDrawLane(); });
watch(() => props.tool, () => { dragState.value = null; markDirty(); draw(); });
// 视图切换（卷帘 ↔ 五线谱）：绘制是按需重绘的，不标脏就不会自己画
watch(() => props.view, () => { dragState.value = null; scoreScrollY.value = 0; markDirty(); nextTick(draw); });
watch(() => props.ccNumber, () => ccDrawLane());
watch(() => props.cc2Number, () => ccDrawLane());
watch(() => props.cc2Enabled, (v) => { if (!v) ccDrawing.value = false; markDirty(); ccDrawLane(); });
watch(() => props.ccMode, () => markDirty());
watch(() => props.ccEnabled, (v) => { if (!v) ccDrawing.value = false; markDirty(); ccDrawLane(); });
watch(() => props.scaleMode, () => { markDirty(); draw(); });
watch(() => props.scaleSpec, () => { markDirty(); draw(); }, { deep: true });
/* 着色方案、默认力度、步进参数都是「只影响绘制」的 prop：没有这个 watch，
   改了色卡要等下一次交互（鼠标移动/选择）才重绘 —— 用户看到的就是「点了没反应」。 */
watch(() => [props.colorMode, props.stepOn, props.stepTicks, props.defaultVelocity, props.ccMode],
  () => { markDirty(); draw(); });
watch(() => props.chordTrack, () => { markDirty(); draw(); }, { deep: true });
watch(() => props.audio, () => { _onsetsCache = null; markDirty(); draw(); });
watch(() => props.ksMap, () => { markDirty(); draw(); }, { deep: true });
// 播放中由 state.playing 兜底每帧重绘；暂停时拖动进度条 / 定位也要跟着走
watch(() => state.curSec, () => { if (!state.playing) markDirty(); });

// 主题切换：applyTheme 直接改 documentElement 的内联样式，监测到就失效颜色缓存
let palObs = null;
let ro = null;
onMounted(async () => {
  await nextTick();
  ctx2d = canvas.value.getContext('2d');
  H.value = availH();
  resetView();
  // 跟随舞台尺寸：窗口/检查器变化时重算卷帘高度，保证铺满且不重叠车道
  if (typeof ResizeObserver !== 'undefined' && wrap.value) {
    const syncVisible = () => {
      const v = wrap.value ? (wrap.value.clientWidth > 0 && wrap.value.clientHeight > 0) : false;
      if (v !== visible) { visible = v; markDirty(); }
    };
    syncVisible();
    ro = new ResizeObserver(() => {
      const n = availH();
      if (n !== H.value) { H.value = n; markDirty(); }
      syncVisible();
    });
    ro.observe(wrap.value);
  }
  if (typeof MutationObserver !== 'undefined') {
    palObs = new MutationObserver(() => { invalidatePalette(); markDirty(); });
    palObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  }
  startLoop();
});
onActivated(() => { markDirty(); startLoop(); });
onDeactivated(stopLoop);
onBeforeUnmount(() => {
  stopLoop();
  if (ro) { ro.disconnect(); ro = null; }
  if (palObs) { palObs.disconnect(); palObs = null; }
});
</script>

<template>
  <div class="ed-canvas-wrap" ref="wrap" data-guide="edit-canvas" @wheel.prevent="onWheel" @contextmenu.prevent="onCtxMenu">
    <canvas ref="canvas" :style="{ height: H + 'px' }" @pointerdown="onDown" @pointermove="onMove($event); onHoverMove($event)" @pointerup="onUp" @pointerleave="onUp(); onHoverLeave()"></canvas>
    <div v-if="ccEnabled" class="cc-lane" :style="{ height: CC_LANE_H + 'px' }">
      <canvas ref="ccCanvas" class="cc-lane-canvas" @pointerdown="ccDown" @pointermove="ccMove" @pointerup="ccUp" @pointerleave="ccUp"></canvas>
    </div>
    <div v-if="ccEnabled && cc2Enabled" class="cc-lane" :style="{ height: CC_LANE_H + 'px' }">
      <canvas ref="ccCanvas2" class="cc-lane-canvas" @pointerdown="ccDown" @pointermove="ccMove" @pointerup="ccUp" @pointerleave="ccUp"></canvas>
    </div>
  </div>
</template>

<style scoped>
.ed-canvas-wrap { position: relative; width: 100%; height: 100%; overflow: hidden; }
.ed-canvas-wrap canvas { display: block; width: 100%; cursor: crosshair; touch-action: none; }
.cc-lane { border-top: 1px solid var(--hairline); background: var(--surface); }
.cc-lane-canvas { display: block; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
</style>

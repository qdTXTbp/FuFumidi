<script setup>
// 编辑视图：钢琴卷帘编辑器（工具栏 + 迷你图 + 可编辑画布 + 属性检查器）
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import EditorCanvas from '../components/EditorCanvas.vue';
import { state, currentSong, toast, importFiles } from '../store.js';
import { ensureAudio } from '../audio.js';
import { encodeMidi } from '../core/midi.js';
import { noteName, clamp } from '../core/util.js';

const bridge = window.fuBridge;

const tool = ref('pencil');
const snapRatio = ref(0.0625);
const trackIndex = ref(0);
const zoomPct = ref(100);
const editor = ref(null);
const miniEl = ref(null);
const miniWrap = ref(null);
const advOpen = ref(false);

// 力度曲线弹窗
const vcOpen = ref(false);
const vcCanvas = ref(null);
const vcVals = ref([]);
const vcPainting = ref(false);

// 列表编辑器弹窗
const listOpen = ref(false);
const listDraft = ref([]);

// CC 泳道
const ccEnabled = ref(false);
const ccNumber = ref(11);
const CC_OPTIONS = [[1, 'CC1 颤音'], [7, 'CC7 音量'], [10, 'CC10 声像'], [11, 'CC11 表情'], [64, 'CC64 延音']];

const sel = reactive({ count: 0, midi: null, name: '', vel: null, start: null, len: null });

const SNAPS = [
  [0, '关'], [1, '1 拍'], [0.75, '附点8分'], [0.6666666667, '三连2分'], [0.5, '1/2'],
  [0.3333333333, '三连音'], [0.25, '1/4'], [0.125, '1/8'], [0.0625, '1/16'], [0.03125, '1/32'],
];

const song = computed(() => (currentSong.value && currentSong.value.song) || null);

const smpteText = computed(() => {
  const sec = Math.max(0, state.curSec || 0);
  const fps = 25;
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  const ff = Math.floor((sec % 1) * fps);
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + ':' + String(ff).padStart(2, '0');
});

function refreshSel() {
  const info = editor.value ? editor.value.selInfo() : null;
  sel.count = info ? info.count : 0;
  sel.midi = info && info.midi != null ? info.midi : null;
  sel.name = info && info.name ? info.name : '';
  sel.vel = info && info.vel != null ? info.vel : null;
  sel.start = info && info.start != null ? info.start : null;
  sel.len = info && info.len != null ? info.len : null;
}
function onZoom(z) { zoomPct.value = Math.round(z * 100); }

/* ---------------- 工具栏操作 ---------------- */
function undo() { editor.value?.undo(); refreshSel(); }
function redo() { editor.value?.redo(); refreshSel(); }
function del() { editor.value?.deleteSelected(); refreshSel(); }
function quantize() { editor.value?.quantizeSelected(); refreshSel(); }
function trUp() { editor.value?.transposeSelected(1); refreshSel(); }
function trDown() { editor.value?.transposeSelected(-1); refreshSel(); }
function octUp() { editor.value?.transposeSelected(12); refreshSel(); }
function octDown() { editor.value?.transposeSelected(-12); refreshSel(); }
function copy() { const n = editor.value?.copySelected() || 0; toast('已复制 ' + n + ' 个音符', 'ok'); }
function paste() {
  const s = song.value; if (!s) return;
  const playTick = Math.round(s.secToTick(state.curSec / state.tempo));
  const n = editor.value?.pasteAt(playTick) || 0;
  if (n) toast('已粘贴 ' + n + ' 个音符', 'ok');
}
function dup() { const n = editor.value?.duplicateSelected() || 0; if (n) toast('已克隆 ' + n + ' 个音符', 'ok'); }
function velUp() { editor.value?.velRampSelected(3); refreshSel(); }
function velDown() { editor.value?.velRampSelected(-3); refreshSel(); }
function samePitch() { editor.value?.selectSamePitch(); refreshSel(); }
function selectAll() { editor.value?.selectAll(); refreshSel(); }

/* ---------------- 力度曲线 ---------------- */
function openVelCurve() {
  if (!editor.value?.selCount()) { toast('请先在钢琴卷帘中选择音符', 'warn'); return; }
  const n = editor.value.selCount();
  const v = editor.value.selInfo();
  // 初始：线性渐变（首音符力度 → 末音符力度）
  const from = (v && v.vel != null) ? v.vel : 80;
  const to = 100;
  vcVals.value = Array.from({ length: n }, (_, i) => n > 1 ? Math.round(from + (to - from) * i / (n - 1)) : from);
  vcOpen.value = true;
  nextTick(drawVelCurve);
}
function drawVelCurve() {
  const cv = vcCanvas.value;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 480, H = cv.clientHeight || 160;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) { cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(10,10,10,0.04)'; g.fillRect(0, 0, W, H);
  // 力度参考网格
  g.strokeStyle = 'rgba(10,10,10,0.08)'; g.lineWidth = 1;
  for (let v = 0; v <= 127; v += 32) {
    const y = H - v / 127 * (H - 10) - 5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  g.fillStyle = 'rgba(10,10,10,0.45)'; g.font = '9px monospace';
  g.fillText('127', 3, 10); g.fillText('1', 3, H - 5);
  // 曲线
  const n = vcVals.value.length;
  if (!n) return;
  const x0 = 26, xw = W - x0 - 8;
  g.strokeStyle = '#1456f0'; g.lineWidth = 1.6; g.beginPath();
  vcVals.value.forEach((v, i) => {
    const x = x0 + (n > 1 ? i / (n - 1) * xw : 0);
    const y = H - 5 - (v / 127) * (H - 10);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.stroke();
  // 音符落点
  g.fillStyle = '#ff5530';
  vcVals.value.forEach((v, i) => {
    const x = x0 + (n > 1 ? i / (n - 1) * xw : 0);
    const y = H - 5 - (v / 127) * (H - 10);
    g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
  });
}
function vcDown(e) { vcPainting.value = true; vcLast = null; vcPaint(e); }
function vcMove(e) { if (vcPainting.value) vcPaint(e); }
function vcUp() { vcPainting.value = false; vcLast = null; }
let vcLast = null;
function vcPaint(e) {
  const cv = vcCanvas.value; if (!cv) return;
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const W = rect.width, H = rect.height;
  const n = vcVals.value.length;
  if (!n) return;
  const x0 = 26, xw = W - x0 - 8;
  const idx = clamp(Math.round((x - x0) / Math.max(1, xw) * (n - 1)), 0, n - 1);
  const v = clamp(Math.round((H - 5 - y) / (H - 10) * 127), 1, 127);
  if (vcLast != null && vcLast.idx !== idx) {
    // 从上次位置到当前位置线性插值填充，保证拖拽画线连续覆盖
    const from = vcLast.idx, toIdx = idx, vFrom = vcLast.v;
    const step = Math.sign(toIdx - from);
    const span = Math.max(1, Math.abs(toIdx - from));
    for (let i = from; i !== toIdx + step; i += step) {
      const t = Math.abs(i - from) / span;
      const iv = Math.round(vFrom + (v - vFrom) * t);
      if (i >= 0 && i < n) vcVals.value[i] = iv;
    }
  } else {
    vcVals.value[idx] = v;
  }
  vcLast = { idx, v };
  drawVelCurve();
}
function applyVelCurve() {
  editor.value?.applyVelCurve([...vcVals.value]);
  vcOpen.value = false;
  refreshSel();
  toast('力度曲线已应用', 'ok');
}

/* ---------------- 列表编辑器 ---------------- */
function openList() {
  const notes = editor.value?.selNotes();
  if (!notes || !notes.length) { toast('请先在钢琴卷帘中选择音符', 'warn'); return; }
  listDraft.value = notes.map(n => ({ start: n.start, end: n.end, midi: n.midi, vel: n.vel }));
  listOpen.value = true;
}
function saveList() {
  editor.value?.applyDraft(listDraft.value);
  listOpen.value = false;
  refreshSel();
  toast('列表修改已应用', 'ok');
}
function addPedal() {
  const n = editor.value?.addPedal() || 0;
  if (n) toast('已添加踏板（CC64 起止）', 'ok');
  else toast('请先选择音符或载入曲目', 'warn');
}
function delPedal() {
  const n = editor.value?.delPedal() || 0;
  if (n) toast('已删除 ' + n + ' 个踏板事件', 'ok');
  else toast('区间内没有踏板事件', 'warn');
}
function setLoopFromSel() {
  const sel = editor.value?.selRef();
  if (!sel || !sel.length) { toast('请先选择音符，再设置为选区循环', 'warn'); return; }
  let a = Infinity, b = 0;
  for (const n of sel) { a = Math.min(a, n.start); b = Math.max(b, n.end); }
  const { player } = ensureAudio();
  player.setLoop(true, a, b);
  state.loop = true;
  toast('已设置选区循环（' + a + ' - ' + b + '）', 'ok');
}
function clearLoopSel() {
  const s = song.value;
  if (!s) return;
  const { player } = ensureAudio();
  player.setLoop(false, 0, s.totalTicks);
  state.loop = false;
  toast('已清除循环', 'ok');
}

// 鼓组编辑器弹窗
const drumOpen = ref(false);
const drumTrack = ref(0);
const drumCv = ref(null);
const DRUM_PITCHES = [35,36,38,40,41,43,45,47,48,50,51,53,55,57,59,60,61,63,65,66,67,69,71,72,73,75,76,77,79,81];
const DRUM_NAMES = {35:'Acoustic Bass Drum',36:'Bass Drum 1',38:'Acoustic Snare',40:'Electric Snare',41:'Floor Tom 2',43:'Floor Tom 1',45:'Low Tom',47:'Low-Mid Tom',48:'Hi-Mid Tom',50:'High Tom',51:'Ride Cymbal 1',53:'Ride Bell',55:'Splash Cymbal',57:'Crash Cymbal 2',59:'Ride Cymbal 2',60:'Hi Bongo',61:'Low Bongo',63:'High Conga',65:'Low Conga',66:'High Timbale',67:'Low Timbale',69:'Cowbell',71:'High Agogo',72:'Low Agogo',73:'Maracas',75:'Claves',76:'Hi Wood Block',77:'Low Wood Block',79:'Open Cuica',81:'Open Hi-Hat'};
const drumTracks = computed(() => song.value ? song.value.tracks.map((t, i) => ({ i, t })) : []);

function openDrumEditor() {
  if (!song.value) { toast('请先载入 MIDI', 'warn'); return; }
  const drums = drumTracks.value.filter(x => x.t.isDrum || x.t.ch === 9);
  const list = drums.length ? drums : drumTracks.value;
  drumTrack.value = list.length ? list[0].i : 0;
  drumOpen.value = true;
  nextTick(drawDrum);
}
function drawDrum() {
  const cv = drumCv.value, s = song.value;
  if (!cv || !s) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 700, h = cv.clientHeight || 420;
  if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(10,10,10,0.03)'; g.fillRect(0, 0, w, h);
  const rows = DRUM_PITCHES.length;
  const tr = s.tracks[drumTrack.value]; if (!tr) return;
  const tpb = s.tpb || 480, bars = Math.min(8, s.bars || 4), beats = bars * 4;
  const rowH = h / rows, colW = w / beats;
  for (let i = 0; i < rows; i++) {
    const y = i * rowH;
    g.strokeStyle = 'rgba(10,10,10,0.07)'; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.fillStyle = 'rgba(10,10,10,0.5)'; g.font = '9px monospace'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(String(DRUM_NAMES[DRUM_PITCHES[i]] || DRUM_PITCHES[i]).slice(0, 14), 4, y + rowH / 2);
  }
  for (let b = 0; b < beats; b++) {
    const x = b * colW;
    g.strokeStyle = b % 4 === 0 ? 'rgba(10,10,10,0.16)' : 'rgba(10,10,10,0.05)';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  g.fillStyle = '#ff5530';
  for (const n of tr.notes) {
    const ri = DRUM_PITCHES.indexOf(n.midi); if (ri < 0) continue;
    const x = n.start / (tpb * 4) * colW;
    g.fillRect(x + 1, ri * rowH + 2, Math.max(4, (n.end - n.start) / (tpb * 4) * colW - 2), rowH - 4);
  }
}
function drumClick(e) {
  const cv = drumCv.value, s = song.value;
  if (!cv || !s) return;
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const rows = DRUM_PITCHES.length;
  const tr = s.tracks[drumTrack.value]; if (!tr) return;
  const tpb = s.tpb || 480, bars = Math.min(8, s.bars || 4), beats = bars * 4;
  const rowH = rect.height / rows, colW = rect.width / beats;
  const ri = Math.floor(y / rowH), bi = Math.floor(x / colW);
  if (ri < 0 || ri >= rows || bi < 0 || bi >= beats) return;
  const midi = DRUM_PITCHES[ri], tick = Math.round(bi * tpb);
  editor.value?.pushStateForTrack(drumTrack.value);
  const hit = tr.notes.find(n => n.midi === midi && Math.abs(n.start - tick) < tpb / 8);
  if (hit) { const i = tr.notes.indexOf(hit); if (i >= 0) tr.notes.splice(i, 1); }
  else tr.notes.push({ start: tick, end: tick + Math.round(tpb / 2), midi, vel: 100 });
  tr.notes.sort((a, b) => a.start - b.start);
  editor.value?.notifyExternalEdit();
  drawDrum();
}
function drumClear() {
  const s = song.value; if (!s) return;
  const tr = s.tracks[drumTrack.value]; if (!tr) return;
  const hits = tr.notes.filter(n => DRUM_PITCHES.includes(n.midi));
  if (hits.length) {
    editor.value?.pushStateForTrack(drumTrack.value);
    for (const h of hits) { const i = tr.notes.indexOf(h); if (i >= 0) tr.notes.splice(i, 1); }
    editor.value?.notifyExternalEdit();
    drawDrum();
    toast('已清除 ' + hits.length + ' 个鼓点', 'ok');
  }
}
watch(drumTrack, () => nextTick(drawDrum));

/* ============ 高级编辑功能（对齐原仓库） ============ */
const scaleSnap = ref(false);
const cc2Enabled = ref(false);
const cc2Number = ref(1);
const ccMode = ref('free');
const bpmInput = ref(song.value ? song.value.initialBpm : 120);
const fullscreenOn = ref(false);

// Key Switch 映射（localStorage 持久化）
function loadKS() { try { return JSON.parse(localStorage.getItem('fufumidi_ksmap') || '{}') || {}; } catch (e) { return {}; } }
function saveKS(m) { localStorage.setItem('fufumidi_ksmap', JSON.stringify(m)); }
const ksMap = ref(loadKS());
const KS_PRESETS = {
  spitfire: {0:'Legato',1:'Staccato',2:'Tremolo',3:'Pizzicato',4:'Spiccato',5:'Marcato',6:'Sustain',7:'Con Sordino',8:'Flautando',9:'Harmonics',10:'Trill'},
  vsl: {0:'Legato',1:'Detache',2:'Staccato',3:'Spiccato',4:'Pizzicato',5:'Tremolo',6:'Trill',7:'Sforzando',8:'Marcato',9:'Portamento'},
  eastwest: {0:'Legato',1:'Staccato',2:'Tremolo',3:'Pizzicato',4:'Spiccato',5:'Marcato',6:'Sustain',7:'Con Sordino',8:'Harmonics',9:'Trill',10:'Flautando'},
};
const ksPreset = ref('');
const ksOpen = ref(false);
const ksDraft = ref({});

// 音频对齐（载入原音频 → 波形/吸附起音/试听）
const audioData = ref(null);
const audioSyncOn = ref(false);
let audioEl = null;

// 智能量化弹窗
const sqOpen = ref(false);
const sqGrid = ref(8);
const sqGroove = ref('none');
const sqStrength = ref(60);

// 逻辑编辑器弹窗
const logicOpen = ref(false);
const logicTarget = ref('sel');
const logicCond = ref('vel_lt');
const logicCondVal = ref(40);
const logicAction = ref('vel_inc');
const logicActVal = ref(20);

// 宏面板弹窗
const macroOpen = ref(false);
const customMacros = ref([]);
const macroName = ref('');
const macroCmd = ref('');

// CC 事件列表 / 撤销历史 / 歌词编辑 / 帮助
const ccListOpen = ref(false);
const historyOpen = ref(false);
const lyricOpen = ref(false);
const lyricText = ref('');
const helpOpen = ref(false);

// 撤销历史快照
function openHistory() { historyOpen.value = true; }
const historyList = computed(() => (editor.value ? editor.value.historySnapshots() : []).slice().reverse());

/* ---- 批量操作 ---- */
function selectChordBatch() {
  const tr = song.value?.tracks[trackIndex.value];
  if (!tr || !editor.value?.selCount()) { toast('请先选中一个音符', 'warn'); return; }
  const arr = editor.value.selRef();
  const ref0 = arr[0];
  const eps = Math.max(0.005, (ref0.end - ref0.start) * 0.5);
  const hits = tr.notes.filter(n => Math.abs(n.start - ref0.start) <= eps || Math.abs(n.end - ref0.end) <= eps);
  editor.value.selectNotes(hits);
  refreshSel();
  toast('已选择 ' + hits.length + ' 个和弦音符', 'ok');
}
function deleteShortNotes() {
  const s = song.value, tr = s?.tracks[trackIndex.value];
  if (!tr || !tr.notes.length) return;
  const sec = 0.08, bpm = s.initialBpm || 120;
  const short = tr.notes.filter(n => (n.end - n.start) / s.tpb * (60 / bpm) < sec);
  if (!short.length) { toast('当前轨道没有短于 80ms 的音符', 'ok'); return; }
  editor.value.pushStateForTrack(trackIndex.value);
  for (const n of short) { const i = tr.notes.indexOf(n); if (i >= 0) tr.notes.splice(i, 1); }
  editor.value.notifyExternalEdit();
  toast('已删除 ' + short.length + ' 个短音', 'ok');
}
function loudScale(f) {
  const tr = song.value?.tracks[trackIndex.value];
  if (!tr) return;
  const arr = editor.value?.selCount() ? editor.value.selRef() : tr.notes;
  if (!arr.length) { toast('没有可处理的音符', 'warn'); return; }
  editor.value.pushStateForTrack(trackIndex.value);
  for (const n of tr.notes) if (arr.includes(n)) n.vel = clamp(Math.round(n.vel * f), 1, 127);
  editor.value.notifyExternalEdit();
  toast('已调整响度 ' + (f > 1 ? '+' : '') + Math.round((f - 1) * 100) + '%', 'ok');
}
function applyBpm() {
  const s = song.value;
  if (!s) { toast('请先载入 MIDI', 'warn'); return; }
  const bpm = clamp(bpmInput.value || 120, 20, 400);
  const us = Math.round(60e6 / bpm);
  const map = s.tempoMap;
  for (const e of map) e.us = us;
  // 重算时间映射
  for (let i = 1; i < map.length; i++) map[i].sec = map[i - 1].sec + (map[i].tick - map[i - 1].tick) * map[i - 1].us / 1e6 / s.tpb;
  s.baseSec = (function (m, tpb, orig) {
    return function (tick) {
      let seg = m[0];
      for (let i = m.length - 1; i >= 0; i--) if (m[i].tick <= tick) { seg = m[i]; break; }
      return seg.sec + (tick - seg.tick) * seg.us / 1e6 / tpb;
    };
  })(map, s.tpb);
  s.totalSec = s.baseSec(s.totalTicks);
  s.initialBpm = bpm;
  const { player } = ensureAudio();
  player.load(s);
  player.setScale(state.tempo);
  toast('BPM 已应用到歌曲：' + bpm, 'ok');
}

/* ---- 智能伴奏 ---- */
function analyzeBarsForChords(s) {
  const tpb = s.tpb, bars = Math.max(1, s.bars);
  const chordBars = [];
  for (let b = 0; b < bars; b++) {
    const t0 = b * tpb * 4, t1 = t0 + tpb * 4;
    const hist = new Array(12).fill(0);
    for (const tr of s.tracks) {
      if (tr.isDrum) continue;
      for (const n of tr.notes) if (n.end > t0 && n.start < t1) hist[((n.midi % 12) + 12) % 12]++;
    }
    let root = 0, max = 0;
    for (let i = 0; i < 12; i++) if (hist[i] > max) { max = hist[i]; root = i; }
    const minor = hist[(root + 3) % 12] >= hist[(root + 4) % 12];
    chordBars.push({ root, minor, strong: max > 0 });
  }
  return chordBars;
}
function addAccompaniment() {
  const s = song.value;
  if (!s) { toast('请先载入 MIDI', 'warn'); return; }
  const tpb = s.tpb, bars = Math.max(1, s.bars);
  const chords = analyzeBarsForChords(s);
  const bass = [], arp = [], pad = [];
  for (let b = 0; b < bars; b++) {
    const c = chords[b];
    const barT = b * tpb * 4;
    const third = c.minor ? 3 : 4;
    const tones = [c.root, c.root + third, c.root + 7];
    const rootMidi = clamp(36 + c.root, 28, 55);
    for (let q = 0; q < 4; q++) {
      const t = barT + q * tpb;
      bass.push({ start: t, end: t + tpb * 0.9, midi: rootMidi, vel: c.strong ? 92 : 70 });
    }
    for (let e = 0; e < 8; e++) {
      const t = barT + e * tpb / 2;
      const deg = [0, 1, 2, 1][e % 4];
      const m = clamp(48 + c.root + (tones[deg % 3] - c.root) + (deg >= 2 ? 12 : 0), 48, 88);
      arp.push({ start: t, end: t + tpb * 0.45, midi: m, vel: c.strong ? 72 : 58 });
    }
    for (let i = 0; i < 3; i++) {
      const m = clamp(52 + tones[i], 40, 84);
      pad.push({ start: barT, end: barT + tpb * 4, midi: m, vel: 55 });
    }
  }
  const nextIdx = s.tracks.length;
  editor.value.pushStateForTrack(-1); // 全量快照，撤销可还原新增轨道
  s.tracks.push({ index: nextIdx, name: '智能贝斯', ch: 2, program: 33, isDrum: false, notes: bass, events: [], ccs: [] });
  s.tracks.push({ index: nextIdx + 1, name: '智能分解和弦', ch: 1, program: 26, isDrum: false, notes: arp, events: [], ccs: [] });
  s.tracks.push({ index: nextIdx + 2, name: '智能铺底', ch: 3, program: 49, isDrum: false, notes: pad, events: [], ccs: [] });
  editor.value.notifyExternalEdit();
  toast('已生成智能伴奏：贝斯 / 分解和弦 / 铺底 3 轨（Ctrl+Z 可撤销）', 'ok');
}

/* ---- 智能量化 + Groove ---- */
function openSmartQuantize() { if (song.value) sqOpen.value = true; else toast('请先载入 MIDI', 'warn'); }
function extractGroove() {
  const notes = editor.value?.selNotes();
  if (!notes || !notes.length) { toast('请先选中要提取 Groove 的音符', 'err'); return; }
  const gridTicks = (song.value.tpb || 480) * 4 / (sqGrid.value || 8);
  const offsets = notes.map(n => { const ideal = Math.round(n.start / gridTicks) * gridTicks; return (n.start - ideal) / gridTicks; });
  localStorage.setItem('fufumidi_custom_groove', JSON.stringify(offsets));
  toast('已提取自定义 Groove：' + offsets.length + ' 个偏移', 'ok');
}
function applySmartQuantize() {
  const s = song.value; if (!s) return;
  const tpb = s.tpb, gridTicks = tpb * 4 / (sqGrid.value || 8);
  const strength = (sqStrength.value || 0) / 100;
  const notes = editor.value?.selCount() ? editor.value.selRef() : s.tracks.reduce((a, t) => a.concat(t.notes), []);
  if (!notes.length) { toast('没有可处理的音符', 'warn'); return; }
  editor.value.pushStateForTrack(editor.value?.selCount() ? trackIndex.value : -1);
  let count = 0;
  for (const n of notes) {
    const ideal = Math.round(n.start / gridTicks) * gridTicks;
    let offset = 0;
    if (sqGroove.value !== 'none') {
      const step = Math.round(n.start / gridTicks);
      const alt = step % 2;
      const g = sqGroove.value;
      if (g === 'funk') offset = alt ? gridTicks * 0.18 : 0;
      else if (g === 'jazz') offset = alt ? gridTicks * 0.24 : 0;
      else if (g === 'rock') offset = alt ? gridTicks * 0.12 : 0;
      else if (g === 'latin') offset = alt ? -gridTicks * 0.12 : gridTicks * 0.06;
      else if (g === 'custom') { try { const arr = JSON.parse(localStorage.getItem('fufumidi_custom_groove') || '[]'); if (arr.length) offset = (arr[step % arr.length] || 0) * gridTicks; } catch (e) {} }
    }
    const target = Math.max(0, Math.round(ideal + offset * strength));
    n.end = n.end - n.start + target;
    n.start = target;
    count++;
  }
  editor.value.notifyExternalEdit();
  sqOpen.value = false;
  toast('已量化 ' + count + ' 个音符', 'ok');
}
/* ---- 逻辑编辑器 ---- */
function openLogicEditor() { if (song.value) logicOpen.value = true; else toast('请先载入 MIDI', 'warn'); }
function applyLogic() {
  const s = song.value; if (!s) return;
  const tpb = s.tpb;
  let notes = [];
  if (logicTarget.value === 'sel') notes = editor.value?.selRef() || [];
  else if (logicTarget.value === 'track') notes = s.tracks[trackIndex.value]?.notes.slice() || [];
  else for (const tr of s.tracks) notes = notes.concat(tr.notes);
  if (!notes.length) { toast('目标区间没有音符', 'warn'); return; }
  const condVal = parseFloat(logicCondVal.value) || 0;
  const actVal = parseFloat(logicActVal.value) || 0;
  const cond = logicCond.value, action = logicAction.value;
  let changed = 0;
  if (action === 'delete') {
    // 删除目标内满足条件的音符
    for (const n of notes) {
      let ok = false;
      if (cond === 'vel_lt') ok = n.vel < condVal;
      else if (cond === 'vel_gt') ok = n.vel > condVal;
      else if (cond === 'dur_lt') ok = (n.end - n.start) < condVal;
      else if (cond === 'pitch_eq') ok = n.midi === condVal;
      else ok = true;
      if (!ok) continue;
      const tr = s.tracks.find(t => t.notes.includes(n));
      if (tr) { const i = tr.notes.indexOf(n); if (i >= 0) { tr.notes.splice(i, 1); changed++; } }
    }
  } else {
    for (const n of notes) {
      let ok = false;
      if (cond === 'vel_lt') ok = n.vel < condVal;
      else if (cond === 'vel_gt') ok = n.vel > condVal;
      else if (cond === 'dur_lt') ok = (n.end - n.start) < condVal;
      else if (cond === 'pitch_eq') ok = n.midi === condVal;
      else ok = true;
      if (!ok) continue;
      if (action === 'vel_inc') n.vel = clamp(n.vel + actVal, 1, 127);
      else if (action === 'vel_dec') n.vel = clamp(n.vel - actVal, 1, 127);
      else if (action === 'vel_fix') n.vel = clamp(actVal, 1, 127);
      else if (action === 'quantize') { const st = Math.round(n.start / tpb) * tpb; n.end = n.end - n.start + st; n.start = st; }
      else if (action === 'transpose') n.midi = clamp(n.midi + actVal, 0, 127);
      changed++;
    }
  }
  editor.value.pushStateForTrack(logicTarget.value === 'all' ? -1 : trackIndex.value);
  editor.value.notifyExternalEdit();
  logicOpen.value = false;
  toast('已处理 ' + changed + ' 个音符', changed ? 'ok' : 'err');
}

/* ---- 宏系统 ---- */
function loadCustomMacros() { try { return JSON.parse(localStorage.getItem('fufumidi_custom_macros') || '[]') || []; } catch (e) { return []; } }
function saveCustomMacros(arr) { localStorage.setItem('fufumidi_custom_macros', JSON.stringify(arr)); }
function openMacroPanel() { customMacros.value = loadCustomMacros(); macroOpen.value = true; }
function runMacro(name) {
  const s = song.value; if (!s) return;
  let count = 0;
  if (name === 'clean') {
    for (const tr of s.tracks) {
      const before = tr.notes.length;
      tr.notes = tr.notes.filter(n => n.vel > 0);
      count += before - tr.notes.length;
      for (const n of tr.notes) { const st = Math.round(n.start / s.tpb) * s.tpb; n.end = n.end - n.start + st; n.start = st; count++; }
    }
  } else if (name === 'transpose_up') {
    for (const tr of s.tracks) for (const n of tr.notes) { n.midi = clamp(n.midi + 12, 0, 127); count++; }
  } else if (name === 'normalize_vel') {
    const src = editor.value?.selCount() ? editor.value.selRef() : s.tracks.reduce((a, t) => a.concat(t.notes), []);
    if (!src.length) { toast('没有可处理的音符', 'err'); return; }
    const min = Math.min(...src.map(n => n.vel)), max = Math.max(...src.map(n => n.vel));
    const range = Math.max(1, max - min);
    for (const n of src) { n.vel = Math.round(80 + (n.vel - min) / range * 47); count++; }
  }
  editor.value.pushStateForTrack(name === 'normalize_vel' && editor.value?.selCount() ? trackIndex.value : -1);
  editor.value.notifyExternalEdit();
  macroOpen.value = false;
  toast('宏已执行，处理 ' + count + ' 个音符', 'ok');
}
function addCustomMacro() {
  const name = macroName.value.trim(), cmd = macroCmd.value.trim();
  if (!name || !cmd) { toast('请填写宏名称和命令', 'err'); return; }
  const arr = loadCustomMacros(); arr.push({ name, cmd }); saveCustomMacros(arr);
  customMacros.value = arr; macroName.value = ''; macroCmd.value = '';
  toast('自定义宏已保存', 'ok');
}
function runCustomMacro(cmd) {
  const s = song.value; if (!s) return;
  const tpb = s.tpb;
  const notes = s.tracks.reduce((a, t) => a.concat(t.notes), []);
  let count = 0;
  for (const line of cmd.split(/[\n;]+/).map(x => x.trim()).filter(Boolean)) {
    const parts = line.split(/\s+/);
    const op = parts[0], arg = parseFloat(parts[1]) || 0;
    if (op === 'transpose') { for (const n of notes) { n.midi = clamp(n.midi + arg, 0, 127); count++; } }
    else if (op === 'quantize') { const gridTicks = tpb * 4 / (arg || 8); for (const n of notes) { const st = Math.round(n.start / gridTicks) * gridTicks; n.end = n.end - n.start + st; n.start = st; count++; } }
    else if (op === 'normalize') { const src = editor.value?.selCount() ? editor.value.selRef() : notes; if (src.length) { const min = Math.min(...src.map(n => n.vel)), max = Math.max(...src.map(n => n.vel)); const range = Math.max(1, max - min); for (const n of src) { n.vel = Math.round(80 + (n.vel - min) / range * 47); count++; } } }
    else if (op === 'vel_inc') { for (const n of notes) { n.vel = clamp(n.vel + arg, 1, 127); count++; } }
    else if (op === 'vel_dec') { for (const n of notes) { n.vel = clamp(n.vel - arg, 1, 127); count++; } }
    else if (op === 'vel_fix') { for (const n of notes) { n.vel = clamp(arg, 1, 127); count++; } }
  }
  editor.value.pushStateForTrack(-1);
  editor.value.notifyExternalEdit();
  macroOpen.value = false;
  toast('自定义宏已执行，处理 ' + count + ' 个音符', 'ok');
}
function delCustomMacro(i) {
  const arr = loadCustomMacros(); arr.splice(i, 1); saveCustomMacros(arr); customMacros.value = arr;
}

/* ---- Key Switch ---- */
function openKSMap() { ksDraft.value = { ...ksMap.value }; ksPreset.value = ''; ksOpen.value = true; }
function applyKSPreset() {
  const preset = KS_PRESETS[ksPreset.value]; if (!preset) return;
  for (const m of Object.keys(preset)) if (+m <= 24) ksDraft.value[+m] = preset[m];
}
function saveKSMap() {
  const map = {};
  for (const m of Object.keys(ksDraft.value)) if (ksDraft.value[m] && +m <= 24) map[+m] = ksDraft.value[m];
  ksMap.value = map; saveKS(map);
  ksOpen.value = false;
  toast('Key Switch 映射已保存', 'ok');
}

/* ---- CC 事件列表 ---- */
const ccListItems = computed(() => {
  const tr = song.value?.tracks[trackIndex.value];
  return (tr && (tr.ccs || []).slice().sort((a, b) => a.tick - b.tick)) || [];
});
function openCCList() { ccListOpen.value = true; }
function delCCItem(i) {
  const tr = song.value?.tracks[trackIndex.value]; if (!tr) return;
  editor.value.pushStateForTrack(trackIndex.value);
  tr.ccs.splice(i, 1);
  editor.value.notifyExternalEdit();
}

/* ---- 歌词编辑（添加到选中音符） ---- */
function openLyricEditor() {
  const n = editor.value?.selCount();
  if (!n) { toast('请先在钢琴卷帘中选择音符', 'warn'); return; }
  lyricText.value = '';
  lyricOpen.value = true;
}
function addLyricToSel() {
  const s = song.value, text = lyricText.value.trim();
  if (!s || !text) { toast('请输入歌词', 'warn'); return; }
  const notes = editor.value?.selNotes();
  if (!notes || !notes.length) return;
  const tr = s.tracks[trackIndex.value];
  editor.value.pushStateForTrack(trackIndex.value);
  for (const n of notes) tr.events.push({ tick: n.start, type: 'lyric', text });
  tr.events.sort((a, b) => a.tick - b.tick);
  editor.value.notifyExternalEdit();
  lyricOpen.value = false;
  toast('已为 ' + notes.length + ' 个音符添加歌词', 'ok');
}

/* ---- 音频对齐 ---- */
async function loadAudio() {
  if (!bridge || !bridge.pickAudio) { toast('请使用桌面版选择音频', 'warn'); return; }
  const p = await bridge.pickAudio();
  if (!p) return;
  try {
    const buf = await bridge.readBinary(p);
    if (!buf) { toast('无法读取音频文件', 'err'); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const audioBuf = await ctx.decodeAudioData(ab);
    audioData.value = { data: audioBuf.getChannelData(0), rate: audioBuf.sampleRate };
    audioCtx = ctx;
    toast('音频已载入，可在卷帘底部查看波形', 'ok');
  } catch (e) { toast('音频解码失败：' + (e.message || e), 'err'); }
}
function snapAudio() {
  if (!audioData.value) { toast('请先载入原音频', 'warn'); return; }
  const n = editor.value?.snapSelToAudio() || 0;
  toast(n ? '已吸附 ' + n + ' 个音符到波形起音' : '没有可吸附的音符（需载入音频）', n ? 'ok' : 'warn');
}
async function toggleAudioSync() {
  const s = song.value; if (!s) return;
  if (audioSyncOn.value) { if (audioEl) { audioEl.pause(); audioEl = null; } audioSyncOn.value = false; toast('已停止试听', 'ok'); return; }
  if (!audioData.value) { toast('请先载入原音频', 'warn'); return; }
  try {
    const p = await bridge.pickAudio();
    if (!p) return;
    const buf = await bridge.readBinary(p);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const blob = new Blob([ab], { type: 'audio/wav' });
    if (!audioEl) audioEl = new Audio(URL.createObjectURL(blob));
    else audioEl.src = URL.createObjectURL(blob);
    audioEl.play();
    audioSyncOn.value = true;
    toast('试听中（播放 MIDI 同时播放原音频）', 'ok');
  } catch (e) { toast('音频试听失败：' + (e.message || e), 'err'); }
}

/* ---- 音色 ---- */
const GM_NAMES = {
  0:'Acoustic Grand Piano',1:'Bright Piano',4:'Electric Piano',5:'Honky-tonk',6:'Electric Piano 2',7:'Harpsichord',8:'Clavinet',11:'Music Box',
  12:'Marimba',13:'Xylophone',14:'Tubular Bells',15:'Dulcimer',16:'Drawbar Organ',17:'Percussive Organ',19:'Church Organ',20:'Reed Organ',
  24:'Acoustic Guitar Nylon',25:'Acoustic Guitar Steel',26:'Electric Guitar Jazz',27:'Electric Guitar Clean',28:'Electric Guitar Muted',29:'Overdriven Guitar',30:'Distortion Guitar',31:'Guitar Harmonics',
  32:'Acoustic Bass',33:'Electric Bass Finger',34:'Electric Bass Pick',35:'Fretless Bass',36:'Slap Bass 1',38:'Synth Bass 1',39:'Synth Bass 2',
  40:'Violin',41:'Viola',42:'Cello',43:'Contrabass',44:'Tremolo Strings',45:'Pizzicato Strings',46:'Orchestral Harp',47:'Timpani',48:'String Ensemble 1',49:'String Ensemble 2',50:'Synth Strings 1',
  52:'Choir Aahs',53:'Voice Oohs',54:'Synth Voice',55:'Orchestra Hit',
  56:'Trumpet',57:'Trombone',58:'Tuba',59:'Muted Trumpet',60:'French Horn',61:'Brass Section',62:'Synth Brass 1',63:'Synth Brass 2',
  64:'Soprano Sax',65:'Alto Sax',66:'Tenor Sax',67:'Baritone Sax',68:'Oboe',69:'English Horn',70:'Bassoon',71:'Clarinet',72:'Piccolo',73:'Flute',74:'Recorder',75:'Pan Flute',76:'Blown Bottle',77:'Shakuhachi',78:'Whistle',79:'Ocarina',
  80:'Lead 1 Square',81:'Lead 2 Sawtooth',82:'Lead 3 Calliope',88:'Pad 1 New Age',89:'Pad 2 Warm',91:'Pad 4 Choir',95:'Pad 7 Halo',
  103:'FX 7 Echoes',104:'Sitar',105:'Banjo',106:'Shamisen',107:'Koto',108:'Kalimba',109:'Bagpipe',110:'Fiddle',111:'Shanai',
  112:'Tinkle Bell',113:'Agogo',114:'Steel Drums',115:'Woodblock',116:'Taiko Drum',117:'Melodic Tom',118:'Synth Drum',119:'Reverse Cymbal',
};
function timbreChange() {
  const tr = song.value?.tracks[trackIndex.value]; if (!tr) return;
  tr.program = timbre.value;
  const { player } = ensureAudio();
  player.load(song.value); player.setScale(state.tempo);
  toast('音色已切换：' + (GM_NAMES[timbre.value] || ('音色 ' + timbre.value)), 'ok');
}
function timbreAll() {
  const s = song.value; if (!s) return;
  for (const tr of s.tracks) if (!tr.isDrum) tr.program = timbre.value;
  const { player } = ensureAudio();
  player.load(s); player.setScale(state.tempo);
  toast('已把当前音色应用到全部非鼓轨', 'ok');
}
function smartTimbre() {
  const tr = song.value?.tracks[trackIndex.value]; if (!tr) return;
  // 按音域/密度/名称智能选择
  const notes = tr.notes;
  if (!notes.length) { toast('当前轨道没有音符', 'warn'); return; }
  const lo = Math.min(...notes.map(n => n.midi)), hi = Math.max(...notes.map(n => n.midi));
  const name = (tr.name || '').toLowerCase();
  let p = 0;
  if (/bass|贝斯|低音/.test(name) || lo < 40) p = 33;
  else if (/drum|鼓|打击/.test(name) || tr.isDrum) p = 0;
  else if (/violin|小提琴/.test(name)) p = 40;
  else if (/cello|大提琴/.test(name)) p = 42;
  else if (/guitar|吉他/.test(name)) p = 24;
  else if (/flute|长笛|笛/.test(name)) p = 73;
  else if (/trumpet|小号/.test(name)) p = 56;
  else if (/string|弦乐/.test(name) || (hi - lo > 48)) p = 48;
  else if (/organ|风琴/.test(name)) p = 19;
  else if (/piano|钢琴/.test(name)) p = 0;
  else p = hi > 72 ? 80 : hi > 60 ? 0 : 40;
  timbre.value = p;
  tr.program = p;
  const { player } = ensureAudio();
  player.load(song.value); player.setScale(state.tempo);
  toast('智能音色：' + (GM_NAMES[p] || p), 'ok');
}

/* ---- 全屏编辑 ---- */
function toggleFullscreen() {
  fullscreenOn.value = !fullscreenOn.value;
  const el = document.querySelector('.edit-view');
  if (el) el.classList.toggle('ed-fullscreen', fullscreenOn.value);
}

/* ---- 视频轨道嵌入（影视配乐对齐） ---- */
const videoUrl = ref('');
async function loadVideo() {
  if (!bridge || !bridge.pickFile) { toast('请使用桌面版选择视频', 'warn'); return; }
  const p = await bridge.pickFile({ title: '选择视频文件', filters: [{ name: '视频', extensions: ['mp4', 'webm', 'mkv', 'mov', 'avi'] }] });
  if (!p) return;
  videoUrl.value = 'file://' + p.replace(/\\/g, '/');
  toast('视频已嵌入编辑区，播放 MIDI 时自动同步', 'ok');
}
function removeVideo() { videoUrl.value = ''; toast('已移除视频轨道', 'ok'); }

function newMidi() {
  const mid = { ticksPerBeat: 480, format: 1, tracks: [{ name: '音轨 1', ch: 0, program: 0, events: [], notes: [], ccs: [] }] };
  const bytes = encodeMidi(mid.tracks, { division: 480 });
  importFiles([{ name: '未命名.mid', bytes }]);
  toast('已新建空白 MIDI', 'ok');
}
async function exportMidi() {
  const s = song.value;
  if (!s) { toast('请先载入 MIDI', 'warn'); return; }
  try {
    const bytes = encodeMidi(s.tracks, { division: s.tpb, tempoMap: s.tempoMap, sigMap: s.sigMap });
    if (bridge && bridge.saveBinary) {
      const r = await bridge.saveBinary({ name: s.name + '.mid', data: Array.from(bytes) });
      if (r && r.ok) toast('已导出 MIDI', 'ok');
      else if (!(r && r.canceled)) toast('导出失败：' + ((r && r.error) || ''), 'warn');
    } else {
      const blob = new Blob([bytes], { type: 'audio/midi' });
      const a = document.createElement('a');
      a.download = s.name + '.mid'; a.href = URL.createObjectURL(blob); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('已导出 MIDI', 'ok');
    }
  } catch (e) { toast('导出失败：' + (e.message || e), 'warn'); }
}

/* ---------------- 迷你图 ---------------- */
function drawMini() {
  const cv = miniEl.value, s = song.value;
  if (!cv || !s) return;
  const W = cv.clientWidth || 600, H = 34;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) { cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(10,10,10,0.04)'; g.fillRect(0, 0, W, H);
  const C = ['#ff5530', '#ea5ec1', '#1456f0', '#a855f7', '#3daeff', '#1ba673', '#3b82f6', '#f59e0b', '#d45656', '#17437d'];
  const scale = W / s.totalTicks;
  for (const tr of s.tracks) {
    g.fillStyle = C[tr.index % C.length];
    for (const n of tr.notes) {
      const x = n.start * scale, w2 = Math.max(1, (n.end - n.start) * scale);
      g.fillRect(x, 12 + (tr.index % 2) * 8, w2, 4);
    }
  }
  g.fillStyle = 'rgba(255,85,48,0.5)'; g.fillRect(0, 0, 2, H);
}
function miniClick(e) {
  const cv = miniEl.value, s = song.value;
  if (!cv || !s) return;
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const tick = x / rect.width * s.totalTicks;
  editor.value?.setViewTick(Math.max(0, tick - s.totalTicks * 0.15));
}

/* ---------------- 快捷键 ---------------- */
function onKey(e) {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (mod && e.key === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && e.key === 'c') { e.preventDefault(); copy(); return; }
  if (mod && e.key === 'v') { e.preventDefault(); paste(); return; }
  if (mod && e.key === 's') { e.preventDefault(); exportMidi(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { del(); return; }
  const k = e.key.toLowerCase();
  if (k === 'v') tool.value = 'select';
  else if (k === 'b') tool.value = 'pencil';
  else if (k === 'e') tool.value = 'erase';
}

let raf = 0;
function loop() { drawMini(); raf = requestAnimationFrame(loop); }

watch([currentSong, trackIndex], () => {
  trackIndex.value = Math.min(trackIndex.value, Math.max(0, (song.value?.tracks.length || 1) - 1));
  refreshSel();
  const tr = song.value?.tracks[trackIndex.value];
  if (tr) { timbre.value = tr.program != null ? tr.program : 0; }
  if (song.value) bpmInput.value = song.value.initialBpm || 120;
  nextTick(drawMini);
});

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  await nextTick();
  raf = requestAnimationFrame(loop);
  refreshSel();
});
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="page edit-view">
    <div class="page-head">
      <div class="page-ic"><Icon name="edit" :size="20" /></div>
      <div class="grow">
        <div class="page-title">编辑器</div>
        <div class="page-sub">钢琴卷帘 · 画笔点击添加 · 拖拽移动 · 边缘拉伸</div>
      </div>
      <button class="btn sm" @click="selectAll">全选</button>
      <button class="btn sm" @click="newMidi"><Icon name="plus" :size="13" /> 新建</button>
      <button class="btn sm primary" @click="exportMidi"><Icon name="save" :size="13" /> 导出 MIDI</button>
    </div>

    <div v-if="!currentSong" class="empty card">
      <div class="empty-ic"><Icon name="edit" :size="34" /></div>
      <b>还没有载入曲目</b>
      <p>导入 MIDI 文件后即可在钢琴卷帘中逐音符精修：添加、移动、拉伸、量化、移调。</p>
    </div>

    <template v-else>
      <!-- 工具栏 -->
      <div class="card ed-toolbar">
        <div class="et-group">
          <button class="et-btn" :class="{ active: tool === 'select' }" title="选择 V" @click="tool = 'select'"><Icon name="cursor" :size="14" />选择</button>
          <button class="et-btn" :class="{ active: tool === 'pencil' }" title="画笔 B" @click="tool = 'pencil'"><Icon name="pencil" :size="14" />画笔</button>
          <button class="et-btn" :class="{ active: tool === 'erase' }" title="橡皮 E" @click="tool = 'erase'"><Icon name="erase" :size="14" />橡皮</button>
        </div>
        <span class="et-sep"></span>
        <span class="et-label">吸附</span>
        <select class="select-input" v-model="snapRatio" style="width:auto;padding:4px 8px">
          <option v-for="s in SNAPS" :key="s[0]" :value="s[0]">{{ s[1] }}</option>
        </select>
        <span class="et-sep"></span>
        <span class="et-label">编辑轨道</span>
        <select class="select-input" v-model="trackIndex" style="width:auto;max-width:170px;padding:4px 8px">
          <option v-for="(tr, i) in song.tracks" :key="i" :value="i">{{ tr.name }}（{{ state.tracks[i]?.noteCount ?? tr.notes.length }}）</option>
        </select>
        <span class="et-sep"></span>
        <button class="et-btn" title="撤销 Ctrl+Z" @click="undo"><Icon name="undo" :size="14" />撤销</button>
        <button class="et-btn" title="重做 Ctrl+Y" @click="redo"><Icon name="redo" :size="14" />重做</button>
        <button class="et-btn danger" title="删除 Del" @click="del"><Icon name="trash" :size="14" />删除</button>
        <span class="et-sep"></span>
        <button class="et-btn" title="量化到吸附网格" @click="quantize"><Icon name="quantize" :size="14" />量化</button>
        <button class="et-btn" title="降半音" @click="trDown">-1</button>
        <button class="et-btn" title="升半音" @click="trUp">+1</button>
        <button class="et-btn" title="降八度" @click="octDown">-8</button>
        <button class="et-btn" title="升八度" @click="octUp">+8</button>
        <span class="et-sep"></span>
        <button class="et-btn" title="复制 Ctrl+C" @click="copy"><Icon name="copy" :size="14" />复制</button>
        <button class="et-btn" title="粘贴到播放头 Ctrl+V" @click="paste"><Icon name="paste" :size="14" />粘贴</button>
        <button class="et-btn" title="克隆选区到其后" @click="dup"><Icon name="plus" :size="14" />克隆</button>
        <span class="et-sep"></span>
        <button class="et-btn" title="选区力度渐强" @click="velUp"><Icon name="cresc" :size="14" />渐强</button>
        <button class="et-btn" title="选区力度渐弱" @click="velDown"><Icon name="dim" :size="14" />渐弱</button>
        <button class="et-btn" title="力度曲线：绘制力度包络并应用到选区" @click="openVelCurve"><Icon name="chart" :size="14" />力度曲线</button>
        <button class="et-btn" title="同音高批量选择" @click="samePitch"><Icon name="target" :size="14" />同音高</button>
        <button class="et-btn" title="列表编辑器：精确修改音符数值" @click="openList"><Icon name="list" :size="14" />列表</button>
        <button class="et-btn" title="鼓组编辑器：打击乐专用视图" @click="openDrumEditor"><Icon name="drum" :size="14" />鼓组</button>
        <span class="et-sep"></span>
        <span class="et-label">CC泳道</span>
        <select class="select-input" v-model="ccNumber" style="width:auto;max-width:130px;padding:4px 8px">
          <option v-for="c in CC_OPTIONS" :key="c[0]" :value="c[0]">{{ c[1] }}</option>
        </select>
        <button class="et-btn" :class="{ active: ccEnabled }" title="切换 CC 自动化泳道" @click="ccEnabled = !ccEnabled"><Icon name="cclane" :size="14" />{{ ccEnabled ? '关闭泳道' : '显示泳道' }}</button>
        <span class="et-sep"></span>
        <span class="et-label">踏板</span>
        <button class="et-btn" title="在选区/整轨起止处添加延音踏板（CC64）" @click="addPedal">+ 踏板</button>
        <button class="et-btn" title="删除选区/整轨内的踏板事件" @click="delPedal">- 踏板</button>
        <span class="et-sep"></span>
        <span class="et-label">循环</span>
        <button class="et-btn" :class="{ active: state.loop }" title="将选区设为循环" @click="setLoopFromSel">选区循环</button>
        <button class="et-btn" title="清除循环" @click="clearLoopSel">清循环</button>
        <button class="et-btn et-more" :class="{ active: advOpen }" @click="advOpen = !advOpen">
          <Icon name="chevron" :size="13" :style="{ transform: advOpen ? 'rotate(180deg)' : '' }" /> 高级
        </button>
      </div>

      <!-- 高级工具区（折叠） -->
      <div v-if="advOpen" class="card ed-adv">
        <div class="adv-row">
          <span class="et-label">音阶</span>
          <button class="et-btn" :class="{ active: scaleSnap }" title="新音符吸附到当前调式音阶" @click="scaleSnap = !scaleSnap">音阶吸附</button>
          <span class="et-sep"></span>
          <span class="et-label">批量</span>
          <button class="et-btn" title="选中与当前音符同时发声的音符" @click="selectChordBatch">和弦</button>
          <button class="et-btn" title="删除当前轨道短于 80ms 的音符" @click="deleteShortNotes">删短音</button>
          <button class="et-btn" title="选区/整轨响度降低 10%" @click="loudScale(0.9)">-10%</button>
          <button class="et-btn" title="选区/整轨响度提高 10%" @click="loudScale(1.1)">+10%</button>
          <span class="et-sep"></span>
          <span class="et-label">BPM</span>
          <input v-model.number="bpmInput" class="num-input" type="number" min="20" max="400" step="1" style="width:62px" />
          <button class="et-btn" title="应用为歌曲速度（改写 tempo 事件）" @click="applyBpm">应用</button>
          <span class="et-sep"></span>
          <button class="et-btn" title="基于当前旋律/和弦自动生成 贝斯+分解和弦+铺底" @click="addAccompaniment">智能伴奏</button>
          <button class="et-btn" title="智能量化：网格 + Groove 模板" @click="openSmartQuantize">智能量化</button>
          <button class="et-btn" title="逻辑编辑器：批量规则处理音符" @click="openLogicEditor">逻辑</button>
          <button class="et-btn" title="宏面板：一键执行常用批量处理" @click="openMacroPanel">宏</button>
          <button class="et-btn" title="Key Switch 映射配置" @click="openKSMap">键位</button>
          <button class="et-btn" title="撤销历史" @click="openHistory">历史</button>
        </div>
        <div class="adv-row">
          <span class="et-label">CC 绘制</span>
          <select v-model="ccMode" class="select-input" style="width:auto;padding:4px 8px">
            <option value="free">手绘</option><option value="line">直线</option><option value="curve">曲线</option>
          </select>
          <button class="et-btn" title="查看当前轨道 CC 控制器事件" @click="openCCList">CC 列表</button>
          <button class="et-btn" :class="{ active: cc2Enabled }" title="切换第二条 CC 泳道" @click="cc2Enabled = !cc2Enabled">CC2</button>
          <select v-model="cc2Number" class="select-input" style="width:auto;padding:4px 8px">
            <option v-for="c in CC_OPTIONS" :key="c[0]" :value="c[0]">{{ c[1] }}</option>
          </select>
          <span class="et-sep"></span>
          <span class="et-label">歌词</span>
          <button class="et-btn" title="为选中的音符添加歌词" @click="openLyricEditor">添加歌词</button>
          <span class="et-sep"></span>
          <span class="et-label">音频</span>
          <button class="et-btn" title="载入原音频，在卷帘底部显示波形与起音" @click="loadAudio">载入</button>
          <button class="et-btn" title="选区/整轨音符吸附到最近的波形起音（±80ms）" @click="snapAudio">吸附起音</button>
          <button class="et-btn" :class="{ active: audioSyncOn }" title="播放 MIDI 时同步试听原音频" @click="toggleAudioSync">试听</button>
           <button class="et-btn" title="嵌入视频轨道（影视配乐对齐）" @click="loadVideo">视频</button>
           <button v-if="videoUrl" class="et-btn" title="移除视频轨道" @click="removeVideo">移除视频</button>
        </div>
        <div class="adv-row">
          <span class="et-label">音色</span>
          <select v-model.number="timbre" class="select-input" style="width:auto;max-width:230px;padding:4px 8px" @change="timbreChange">
            <option v-for="(nm, p) in GM_NAMES" :key="p" :value="Number(p)">{{ p }} {{ nm }}</option>
          </select>
          <button class="et-btn" title="把当前音色应用到全部非鼓轨" @click="timbreAll">全部</button>
          <button class="et-btn" title="按轨道音域/密度/名称智能选择音色" @click="smartTimbre">智能</button>
          <span class="et-sep"></span>
          <button class="et-btn" title="全屏编辑，最大化钢琴卷帘" @click="toggleFullscreen">全屏</button>
          <button class="et-btn" title="编辑功能介绍" @click="helpOpen = true">说明</button>
        </div>
      </div>

      <!-- 迷你图 + 缩放 -->
      <div class="ed-nav" ref="miniWrap">
        <canvas ref="miniEl" class="ed-mini" style="height:34px" @click="miniClick"></canvas>
        <div class="ed-zoom">
          <button class="icon-btn" title="缩小" @click="editor?.zoomBy(0.85)"><Icon name="minus" :size="13" /></button>
          <span class="ez-pct">{{ zoomPct }}%</span>
          <button class="icon-btn" title="放大" @click="editor?.zoomBy(1.18)"><Icon name="plus" :size="13" /></button>
          <button class="btn sm ghost" @click="editor?.fit()">适应</button>
        </div>
      </div>

      <!-- 钢琴卷帘 -->
      <div class="ed-wrap-rel">
        <EditorCanvas ref="editor" :tool="tool" :snap-ratio="snapRatio" :track-index="trackIndex"
                      :cc-enabled="ccEnabled" :cc-number="ccNumber"
                      :scale-snap="scaleSnap" :ks-map="ksMap" :audio="audioData"
                      :cc2-enabled="cc2Enabled" :cc2-number="cc2Number" :cc-mode="ccMode"
                      @select="refreshSel" @modify="refreshSel" @zoom="onZoom" />
        <video v-if="videoUrl" :src="videoUrl" controls playsinline class="ed-video-overlay"></video>
      </div>

      <!-- 属性检查器 -->
      <div class="card ed-inspector">
        <span class="ins-item">选中 <b>{{ sel.count }}</b></span>
        <span class="ins-item">音高 <b>{{ sel.midi ?? '—' }}</b></span>
        <span class="ins-item">音名 <b>{{ sel.name || '—' }}</b></span>
        <span class="ins-item">力度
          <input type="range" min="1" max="127" :value="sel.vel ?? 80" style="width:90px" :disabled="!sel.vel"
                 @input="e => editor?.setSelVel(+e.target.value)" />
        </span>
        <span class="ins-item">起点 <input type="number" class="num-input" :value="sel.start ?? 0" step="1" min="0" :disabled="!sel.start"
                 @change="e => editor?.setSelStart(+e.target.value)" style="width:78px" /></span>
        <span class="ins-item">长度 <input type="number" class="num-input" :value="sel.len ?? 0" step="1" min="1" :disabled="!sel.len"
                 @change="e => editor?.setSelLen(+e.target.value)" style="width:78px" /></span>
        <span class="ins-item">SMPTE <b style="font-family:var(--mono)">{{ smpteText }}</b></span>
        <span class="ins-item et-tip">单位：tick · Ctrl+滚轮 缩放 · Shift+滚轮 平移 · 滚轮 上下滚动</span>
      </div>
    </template>

    <!-- 力度曲线弹窗 -->
    <div v-if="vcOpen" class="ed-modal-mask" @click.self="vcOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head">
          <b>力度曲线</b><span class="muted small">在画布上拖拽绘制力度包络，应用到选区 {{ vcVals.length }} 个音符</span>
          <button class="icon-btn" style="margin-left:auto" @click="vcOpen = false"><Icon name="minus" :size="14" /></button>
        </div>
        <canvas ref="vcCanvas" class="vc-canvas" style="height:160px"
                @pointerdown="vcDown" @pointermove="vcMove" @pointerup="vcUp" @pointerleave="vcUp"></canvas>
        <div class="ed-modal-foot">
          <button class="btn sm" @click="vcOpen = false">取消</button>
          <button class="btn sm primary" @click="applyVelCurve">应用曲线</button>
        </div>
      </div>
    </div>

    <!-- 列表编辑器弹窗 -->
    <div v-if="listOpen" class="ed-modal-mask" @click.self="listOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head">
          <b>列表编辑器</b><span class="muted small">精确修改选中 {{ listDraft.length }} 个音符（单位：tick）</span>
          <button class="icon-btn" style="margin-left:auto" @click="listOpen = false"><Icon name="minus" :size="14" /></button>
        </div>
        <div class="ed-list-scroll">
          <table class="ed-list-table">
            <thead><tr><th>#</th><th>起点</th><th>终点</th><th>音高</th><th>力度</th><th>时长</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in listDraft" :key="i">
                <td>{{ i + 1 }}</td>
                <td><input type="number" class="num-input" v-model.number="r.start" step="1" min="0" /></td>
                <td><input type="number" class="num-input" v-model.number="r.end" step="1" min="1" /></td>
                <td><input type="number" class="num-input" v-model.number="r.midi" step="1" min="0" max="127" /></td>
                <td><input type="number" class="num-input" v-model.number="r.vel" step="1" min="1" max="127" /></td>
                <td class="muted small">{{ r.end - r.start }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="ed-modal-foot">
          <button class="btn sm" @click="listOpen = false">取消</button>
          <button class="btn sm primary" @click="saveList">保存修改</button>
        </div>
      </div>
    </div>
    <!-- 鼓组编辑器弹窗 -->
    <div v-if="drumOpen" class="ed-modal-mask" @click.self="drumOpen = false">
      <div class="ed-modal" style="width:min(820px,96vw)">
        <div class="ed-modal-head">
          <b>鼓组编辑器</b><span class="muted small">打击乐网格 · 点击添加/删除鼓点</span>
          <button class="icon-btn" style="margin-left:auto" @click="drumOpen = false"><Icon name="minus" :size="14" /></button>
        </div>
        <div class="row" style="gap:8px">
          <select class="select-input" v-model="drumTrack" style="min-width:160px">
            <option v-for="d in drumTracks" :key="d.i" :value="d.i">{{ d.t.name }}（{{ d.t.notes.length }}）</option>
          </select>
          <button class="btn sm danger" @click="drumClear">清除当前轨道鼓点</button>
        </div>
        <canvas ref="drumCv" class="drum-canvas" style="height:420px" @click="drumClick"></canvas>
      </div>
    </div>

    <!-- 智能量化弹窗 -->
    <div v-if="sqOpen" class="ed-modal-mask" @click.self="sqOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>智能量化</b><span class="muted small">网格 + Groove 模板</span><button class="icon-btn" style="margin-left:auto" @click="sqOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="adv-form-grid">
          <label>网格
            <select v-model="sqGrid" class="select-input" style="width:100%">
              <option :value="4">1/4</option><option :value="8">1/8</option><option :value="16">1/16</option><option :value="32">1/32</option>
            </select>
          </label>
          <label>Groove
            <select v-model="sqGroove" class="select-input" style="width:100%">
              <option value="none">无</option><option value="funk">Funk</option><option value="jazz">Jazz</option><option value="rock">Rock</option><option value="latin">Latin</option><option value="custom">自定义 Groove</option>
            </select>
          </label>
          <label class="span2">强度 <input type="range" min="0" max="100" v-model.number="sqStrength" style="width:100%" /> <span class="muted small">{{ sqStrength }}%</span></label>
        </div>
        <div class="ed-modal-foot">
          <button class="btn sm" @click="extractGroove">提取选中为 Groove</button>
          <button class="btn sm" @click="sqOpen = false">取消</button>
          <button class="btn sm primary" @click="applySmartQuantize">应用量化</button>
        </div>
      </div>
    </div>

    <!-- 逻辑编辑器弹窗 -->
    <div v-if="logicOpen" class="ed-modal-mask" @click.self="logicOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>逻辑编辑器</b><span class="muted small">批量规则处理音符</span><button class="icon-btn" style="margin-left:auto" @click="logicOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="adv-form-grid">
          <label>目标
            <select v-model="logicTarget" class="select-input" style="width:100%">
              <option value="all">所有音符</option><option value="sel">选中音符</option><option value="track">当前轨道</option>
            </select>
          </label>
          <label>条件
            <select v-model="logicCond" class="select-input" style="width:100%">
              <option value="vel_lt">力度 &lt;</option><option value="vel_gt">力度 &gt;</option><option value="dur_lt">时值 &lt;</option><option value="pitch_eq">音高 =</option>
            </select>
          </label>
          <label>条件值 <input v-model.number="logicCondVal" class="num-input" type="number" style="width:100%" /></label>
          <label>操作
            <select v-model="logicAction" class="select-input" style="width:100%">
              <option value="vel_inc">力度 +</option><option value="vel_dec">力度 -</option><option value="vel_fix">固定力度</option><option value="quantize">量化</option><option value="transpose">移调</option><option value="delete">删除</option>
            </select>
          </label>
          <label>操作值 <input v-model.number="logicActVal" class="num-input" type="number" style="width:100%" /></label>
        </div>
        <div class="ed-modal-foot">
          <button class="btn sm" @click="logicOpen = false">取消</button>
          <button class="btn sm primary" @click="applyLogic">应用规则</button>
        </div>
      </div>
    </div>

    <!-- 宏面板弹窗 -->
    <div v-if="macroOpen" class="ed-modal-mask" @click.self="macroOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>宏面板</b><span class="muted small">一键执行常用批量处理，操作进入撤销历史</span><button class="icon-btn" style="margin-left:auto" @click="macroOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="macro-list">
          <button class="btn sm" style="justify-content:flex-start" @click="runMacro('clean')">清理工程<span class="muted small">删除力度为 0 的音符 + 量化所有音符</span></button>
          <button class="btn sm" style="justify-content:flex-start" @click="runMacro('transpose_up')">批量移调<span class="muted small">所有音符升高一个八度</span></button>
          <button class="btn sm" style="justify-content:flex-start" @click="runMacro('normalize_vel')">力度标准化<span class="muted small">选中/全部音符力度归一化到 80-127</span></button>
        </div>
        <div class="adv-form-sec">
          <div class="adv-form-sec-title">自定义宏</div>
          <div v-for="(m, i) in customMacros" :key="i" class="macro-item">
            <span class="macro-name">{{ m.name }}</span>
            <code class="macro-cmd">{{ m.cmd }}</code>
            <button class="btn sm" @click="runCustomMacro(m.cmd)">运行</button>
            <button class="btn sm danger" @click="delCustomMacro(i)">删除</button>
          </div>
          <div v-if="!customMacros.length" class="muted small">暂无自定义宏</div>
          <div class="macro-add">
            <input v-model="macroName" class="num-input" placeholder="宏名称" style="flex:1" />
            <input v-model="macroCmd" class="num-input" placeholder="命令：transpose 12 / quantize 8 / normalize" style="flex:2" />
            <button class="btn sm primary" @click="addCustomMacro">添加</button>
          </div>
          <div class="muted small" style="margin-top:4px">支持命令：transpose N、quantize N、normalize、vel_inc N、vel_dec N、vel_fix N</div>
        </div>
      </div>
    </div>

    <!-- Key Switch 映射弹窗 -->
    <div v-if="ksOpen" class="ed-modal-mask" @click.self="ksOpen = false">
      <div class="ed-modal" style="width:min(560px,92vw)">
        <div class="ed-modal-head"><b>Key Switch 映射</b><span class="muted small">为 C-2 ~ C0（MIDI 0-24）命名技法</span><button class="icon-btn" style="margin-left:auto" @click="ksOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="row" style="gap:8px">
          <select v-model="ksPreset" class="select-input" style="min-width:150px">
            <option value="">选择预设</option><option value="spitfire">Spitfire</option><option value="vsl">VSL</option><option value="eastwest">EastWest</option>
          </select>
          <button class="btn sm" @click="applyKSPreset">应用预设</button>
        </div>
        <div class="ks-list">
          <div v-for="m in 25" :key="m - 1" class="ks-row">
            <span class="ks-label">MIDI {{ m - 1 }}</span>
            <input v-model="ksDraft[m - 1]" class="num-input" placeholder="技法名（如 Legato）" style="flex:1" />
          </div>
        </div>
        <div class="ed-modal-foot"><button class="btn sm primary" @click="saveKSMap">保存</button></div>
      </div>
    </div>

    <!-- CC 事件列表弹窗 -->
    <div v-if="ccListOpen" class="ed-modal-mask" @click.self="ccListOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>CC 控制器事件</b><span class="muted small">当前轨道 {{ ccListItems.length }} 条</span><button class="icon-btn" style="margin-left:auto" @click="ccListOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="ed-list-scroll" style="max-height:50vh">
          <table class="ed-list-table">
            <thead><tr><th>#</th><th>Tick</th><th>CC</th><th>值</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(c, i) in ccListItems" :key="i">
                <td>{{ i + 1 }}</td><td>{{ c.tick }}</td><td>CC{{ c.cc }}</td><td>{{ c.cv }}</td>
                <td><button class="btn sm danger" @click="delCCItem(i)">删除</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 撤销历史弹窗 -->
    <div v-if="historyOpen" class="ed-modal-mask" @click.self="historyOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>撤销历史</b><span class="muted small">点击条目回退到该状态</span><button class="icon-btn" style="margin-left:auto" @click="historyOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="ks-list">
          <div v-for="(h, i) in historyList" :key="i" class="ks-row">
            <span class="ks-label">#{{ historyList.length - i }}</span>
            <span class="muted small">轨道 {{ h.ti + 1 }} · {{ h.notes }} 个音符 · {{ new Date(h.at).toLocaleTimeString() }}</span>
            <button class="btn sm" @click="historyOpen = false">撤销</button>
          </div>
          <div v-if="!historyList.length" class="muted small">暂无撤销记录</div>
        </div>
      </div>
    </div>

    <!-- 歌词编辑弹窗 -->
    <div v-if="lyricOpen" class="ed-modal-mask" @click.self="lyricOpen = false">
      <div class="ed-modal">
        <div class="ed-modal-head"><b>添加歌词</b><span class="muted small">为选中的 {{ editor?.selCount() || 0 }} 个音符添加歌词</span><button class="icon-btn" style="margin-left:auto" @click="lyricOpen = false"><Icon name="minus" :size="14" /></button></div>
        <input v-model="lyricText" class="num-input" placeholder="输入歌词（如：爱）" @keyup.enter="addLyricToSel" style="width:100%;padding:8px" />
        <div class="ed-modal-foot">
          <button class="btn sm" @click="lyricOpen = false">取消</button>
          <button class="btn sm primary" @click="addLyricToSel">添加</button>
        </div>
      </div>
    </div>

    <!-- 编辑说明弹窗 -->
    <div v-if="helpOpen" class="ed-modal-mask" @click.self="helpOpen = false">
      <div class="ed-modal" style="width:min(680px,92vw)">
        <div class="ed-modal-head"><b>编辑功能说明</b><button class="icon-btn" style="margin-left:auto" @click="helpOpen = false"><Icon name="minus" :size="14" /></button></div>
        <div class="help-scroll">
          <div class="help-sec"><b>钢琴卷帘</b><span>选择/画笔/橡皮三种工具；拖拽移动音符、边缘拉伸改时值、Alt 拖拽调力度；支持吸附、音阶吸附、撤销/重做。</span></div>
          <div class="help-sec"><b>CC 自动化</b><span>展开 CC 泳道后选择 CC1/7/10/11/64；支持手绘、直线、曲线三种绘制；点击/拖动直接写 CC 数据。</span></div>
          <div class="help-sec"><b>Key Switch</b><span>C-2~C0 区域橙色高亮；支持自定义技法名称，并提供 Spitfire/VSL/EastWest 预设模板。</span></div>
          <div class="help-sec"><b>逻辑编辑器</b><span>按“目标→条件→操作”批量修改音符：力度、时值、音高、删除、量化、移调。</span></div>
          <div class="help-sec"><b>列表编辑器</b><span>以表格精确编辑每个音符的起点/终点/音高/力度；支持添加、删除、排序。</span></div>
          <div class="help-sec"><b>宏系统</b><span>内置清理/移调/力度标准化宏；支持自定义命令宏。</span></div>
          <div class="help-sec"><b>智能量化</b><span>按 1/4、1/8、1/16、1/32 量化；支持 Funk/Jazz/Rock/Latin/自定义 Groove；可提取选中音符的 Groove。</span></div>
          <div class="help-sec"><b>鼓组编辑器</b><span>打击乐专用网格视图，点击添加/删除鼓点，支持鼓轨切换与清除。</span></div>
          <div class="help-sec"><b>智能伴奏</b><span>基于当前旋律/和弦自动生成 贝斯 + 分解和弦 + 铺底 3 轨（可撤销）。</span></div>
          <div class="help-sec"><b>音频对齐</b><span>载入原音频后在卷帘底部显示波形；「吸附起音」把音符吸附到最近的波形起音（±80ms）；「试听」同步播放原音频检查对齐效果。</span></div>
          <div class="help-sec"><b>影视配乐</b><span>载入视频轨道嵌入编辑区右上角，播放 MIDI 时自动同步，用于影视配乐对齐。</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.edit-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; padding: 16px 22px 0; }
.ed-toolbar { padding: 8px 12px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-bottom: 8px; }
.et-group { display: flex; align-items: center; gap: 4px; }
.et-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 9px; border: 1px solid transparent; border-radius: 8px; background: transparent; font-size: 12px; color: var(--slate); cursor: pointer; }
.et-btn:hover { background: var(--surface-soft); color: var(--ink); }
.et-btn.active { background: var(--btn-bg); border-color: var(--btn-bg); color: var(--btn-fg); }
.et-btn.danger { color: var(--error); }
.et-btn.et-more { margin-left: auto; }
.et-btn.et-more.active { background: var(--surface-soft); color: var(--ink); }
.et-sep { width: 1px; height: 20px; background: var(--hairline); margin: 0 3px; }
.et-label { font-size: 11px; color: var(--stone); }
.ed-nav { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ed-mini { flex: 1; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 8px; display: block; cursor: pointer; }
.ed-zoom { display: flex; align-items: center; gap: 5px; flex: none; }
.ez-pct { font-size: 11px; color: var(--steel); min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; }
.ed-inspector { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 8px 14px; margin-top: 8px; font-size: 12px; color: var(--slate); flex: none; }
.ins-item { display: inline-flex; align-items: center; gap: 5px; }
.ins-item b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.ins-item input[type=range] { accent-color: var(--ink); }
.num-input { width: 60px; padding: 3px 5px; font-size: 11px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 6px; color: var(--ink); font-family: var(--mono); outline: none; }
.num-input:focus { border-color: var(--ink); }
.et-tip { margin-left: auto; color: var(--stone); font-size: 10.5px; }
.ed-modal-mask { position: fixed; inset: 0; background: rgba(10,10,10,0.35); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.ed-modal { width: min(560px, 92vw); background: #fff; border-radius: 14px; box-shadow: 0 24px 64px rgba(16,24,40,0.2); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.ed-modal-head { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--ink); }
.ed-modal-head b { font-size: 15px; }
.vc-canvas { width: 100%; display: block; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 10px; cursor: crosshair; touch-action: none; }
.ed-modal-foot { display: flex; justify-content: flex-end; gap: 8px; }
.ed-list-scroll { max-height: 40vh; overflow: auto; border: 1px solid var(--hairline); border-radius: 10px; }
.ed-list-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ed-list-table th { position: sticky; top: 0; background: var(--surface); text-align: left; padding: 6px 8px; font-weight: 600; color: var(--slate); border-bottom: 1px solid var(--hairline); font-size: 11px; }
.ed-list-table td { padding: 3px 6px; border-bottom: 1px solid var(--hairline-soft); color: var(--ink); }
.ed-list-table td .num-input { width: 70px; }
.drum-canvas { width: 100%; display: block; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 10px; cursor: crosshair; touch-action: none; }
.ed-adv { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; margin-bottom: 8px; }
.adv-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.adv-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.adv-form-grid label { font-size: 12px; color: var(--slate); display: flex; flex-direction: column; gap: 5px; }
.adv-form-grid .span2 { grid-column: 1 / -1; }
.adv-form-sec { border-top: 1px dashed var(--hairline); padding-top: 10px; margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
.adv-form-sec-title { font-size: 12px; font-weight: 700; color: var(--ink); }
.macro-list { display: flex; flex-direction: column; gap: 6px; }
.macro-list .btn { width: 100%; flex-direction: column; align-items: flex-start; gap: 2px; }
.macro-item { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--hairline); border-radius: 8px; padding: 4px 8px; }
.macro-name { flex: 0 0 auto; font-size: 12px; font-weight: 600; }
.macro-cmd { font-family: var(--mono); font-size: 10.5px; color: var(--stone); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.macro-add { display: flex; gap: 6px; }
.ks-list { max-height: 50vh; overflow: auto; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--hairline); border-radius: 10px; padding: 6px; }
.ks-row { display: flex; align-items: center; gap: 8px; padding: 2px 6px; border-radius: 6px; }
.ks-row:nth-child(odd) { background: var(--surface-soft); }
.ks-label { width: 64px; font-size: 11px; color: var(--stone); flex: none; }
.help-scroll { max-height: 60vh; overflow: auto; display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--slate); line-height: 1.7; }
.help-sec b { display: block; color: var(--ink); }
.ed-fullscreen .ed-wrap-rel { flex: 1; }
.ed-fullscreen .ed-toolbar, .ed-fullscreen .ed-nav, .ed-fullscreen .ed-inspector, .ed-fullscreen .ed-adv { display: none; }
.ed-wrap-rel { position: relative; flex: 1; min-height: 0; }
.ed-video-overlay { position: absolute; top: 4px; right: 4px; width: 300px; max-width: 34%; border-radius: 8px; z-index: 20; background: #000; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
</style>

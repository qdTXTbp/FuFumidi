<script setup>
// 编辑视图：钢琴卷帘编辑器（工具栏 + 迷你图 + 可编辑画布 + 属性检查器）
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import EditorCanvas from '../components/EditorCanvas.vue';
import { state, currentSong, toast, importFiles } from '../store.js';
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
        <button class="et-btn et-more" :class="{ active: advOpen }" @click="advOpen = !advOpen">
          <Icon name="chevron" :size="13" :style="{ transform: advOpen ? 'rotate(180deg)' : '' }" /> 高级
        </button>
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
      <EditorCanvas ref="editor" :tool="tool" :snap-ratio="snapRatio" :track-index="trackIndex"
                    :cc-enabled="ccEnabled" :cc-number="ccNumber"
                    @select="refreshSel" @modify="refreshSel" @zoom="onZoom" />

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
  </div>
</template>

<style scoped>
.edit-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; padding: 16px 22px 0; }
.ed-toolbar { padding: 8px 12px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-bottom: 8px; }
.et-group { display: flex; align-items: center; gap: 4px; }
.et-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 9px; border: 1px solid transparent; border-radius: 8px; background: transparent; font-size: 12px; color: var(--slate); cursor: pointer; }
.et-btn:hover { background: var(--surface-soft); color: var(--ink); }
.et-btn.active { background: var(--ink); border-color: var(--ink); color: #fff; }
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
</style>

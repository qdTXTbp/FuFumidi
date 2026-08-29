<script setup>
// UTAU 可视化钢琴卷帘编辑器
// 画笔/选择工具、框选多选、缩放、网格吸附、播放走带、歌词填词、
// 复制/剪切/粘贴/重复、撤销/重做、键盘微调、Alt拖拽复制、左右缘缩放、右键菜单
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../Icon.vue';
import { useUtauStore } from '../../stores/utau';
import { useAppStore } from '../../stores/app';
import { parseMidi, buildSong } from '../../core/midi.js';
import { fmtTime } from '../../core/util.js';
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
let drag = null;            // { mode:'move'|'rresize'|'lresize'|'create'|'box', ... }
let cw = 0, ch = 0, beatEnds = 16;
let raf = 0, playT0 = 0, playStart = 0, onsetFired = new Set();
let audio = null;
const clipboard = ref([]);   // 内部剪贴板（纯音符数据）
let nudgeTok = null, nudgeT = 0; // 键盘微调的历史合并标记

// 右键菜单
const ctxOpen = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);
const ctxOnNote = ref(false);

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
function seekTo(beat) {
  playBeat.value = Math.max(0, beat);
  if (playing.value) {
    playStart = playBeat.value; playT0 = performance.now(); onsetFired.clear();
    const b0 = Math.max(0, Math.floor(playBeat.value));
    for (const n of store.notes) if (n.startBeat <= b0) onsetFired.add(n.startBeat);
  }
  draw();
}
function seek(e) {
  const rect = canvas.value.getBoundingClientRect();
  seekTo((e.clientX - rect.left - LEFT) / noteW);
}
function stopAll() { stop(); if (audio) { try { audio.close(); } catch (e) {} audio = null; } }

/* ---------------- 剪贴板 ---------------- */
function selIds() { return store.selectedIds.slice(); }
function copySel() {
  const sel = store.selectedNotes;
  if (!sel.length) return;
  clipboard.value = sel.map(n => ({ ...n }));
  app.toast(t('已复制 ') + sel.length + t(' 个音符'));
}
function cutSel() {
  const sel = store.selectedNotes;
  if (!sel.length) return;
  clipboard.value = sel.map(n => ({ ...n }));
  store.removeNotes(selIds());
}
function pasteClip() {
  if (!clipboard.value.length) { app.toast(t('剪贴板为空'), 'warn'); return; }
  const minStart = Math.min(...clipboard.value.map(n => n.startBeat));
  const at = snapBeat(playBeat.value);
  store.addNotes(clipboard.value.map(n => ({ ...n, startBeat: at + (n.startBeat - minStart) })));
}
function dupSel() {
  const sel = store.selectedNotes;
  if (!sel.length) return;
  const span = Math.max(...sel.map(n => n.startBeat + n.durBeat)) - Math.min(...sel.map(n => n.startBeat));
  const offset = Math.max(snap.value, span);
  store.duplicateNotes(selIds(), offset);
}

/* ---------------- 键盘微调（历史合并） ---------------- */
function nudge(patch, tok) {
  const ids = selIds();
  if (!ids.length) return;
  const now = Date.now();
  if (nudgeTok !== tok || now - nudgeT > 700) { store.pushUndo(); nudgeTok = tok; nudgeT = now; }
  else { nudgeT = now; }
  for (const id of ids) {
    const n = store.notes.find(z => z.id === id);
    if (!n) continue;
    const p = typeof patch === 'function' ? patch(n) : patch;
    const next = {};
    if (p.dStart != null) next.startBeat = Math.max(0, n.startBeat + p.dStart);
    if (p.dDur != null) next.durBeat = Math.max(snap.value, n.durBeat + p.dDur);
    if (p.dPitch != null) next.pitch = Math.max(MIN_P, Math.min(MAX_P, n.pitch + p.dPitch));
    store.updateNote(id, next);
  }
}

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

  const selIds = new Set(store.selectedIds);
  for (const n of store.sortedNotes) {
    const x = xOf(n.startBeat), y = yOf(n.pitch);
    const w = Math.max(noteW * 0.9, n.durBeat * noteW - 2), h = ROW_H - 2;
    const sel = selIds.has(n.id);
    const primary = store.selectedId === n.id;
    ctx.fillStyle = sel ? brand : '#9aa1ff';
    ctx.strokeStyle = primary ? ink : (sel ? brand : 'rgba(0,0,0,0.25)');
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

  // 框选矩形
  if (drag && drag.mode === 'box') {
    const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
    const bw = Math.abs(drag.x1 - drag.x0), bh = Math.abs(drag.y1 - drag.y0);
    ctx.save();
    ctx.strokeStyle = brand; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.fillStyle = 'rgba(75,63,227,0.08)';
    ctx.fillRect(x0, y0, bw, bh); ctx.strokeRect(x0, y0, bw, bh);
    ctx.restore();
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
function noteRect(n) {
  const rx = xOf(n.startBeat), ry = yOf(n.pitch);
  const rw = Math.max(noteW * 0.9, n.durBeat * noteW - 2), rh = ROW_H - 2;
  return { rx, ry, rw, rh };
}
function hitNote(x, y) {
  for (const n of store.sortedNotes) {
    const { rx, ry, rw, rh } = noteRect(n);
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
      // 右缘缩放 / 左缘缩放 / 主体
      const zone = (x > rx + rw - 7 && rw > 18) ? 'r' : (x < rx + 7 && rw > 26) ? 'l' : 'body';
      return { n, zone };
    }
  }
  return null;
}
function closeCtx() { ctxOpen.value = false; }

function onDown(e) {
  closeCtx();
  // 右键/中键不参与绘制与拖拽，留给 contextmenu 开菜单
  if (e.button !== 0) return;
  const { x, y } = toXY(e);
  // 顶部拍号条：点击定位播放头
  if (y < TOP) { if (x >= LEFT) seek(e); return; }
  if (x < LEFT) return;
  const hit = hitNote(x, y);
  if (hit) {
    const multi = store.selectedIds.includes(hit.n.id) && store.selectedIds.length > 1;
    if (e.shiftKey) { store.toggleSelect(hit.n.id); return; }
    if (!multi && !store.selectedIds.includes(hit.n.id)) store.select(hit.n.id);
    // Alt+拖拽 = 复制出一个再拖
    if (e.altKey) {
      const [cid] = store.duplicateNotes([hit.n.id], 0);
      if (cid) {
        const c = store.notes.find(z => z.id === cid);
        drag = { mode: 'move', ids: [cid], orig: [{ id: cid, b0: c.startBeat, p0: c.pitch }], x0: x, y0: y };
      }
    } else if (hit.zone === 'r') {
      store.pushUndo();
      drag = { mode: 'rresize', id: hit.n.id, d0: hit.n.durBeat, x0: x };
    } else if (hit.zone === 'l') {
      store.pushUndo();
      drag = { mode: 'lresize', id: hit.n.id, b0: hit.n.startBeat, d0: hit.n.durBeat, x0: x };
    } else {
      // 拖动：多选时整体拖
      const ids = multi ? selIds() : [hit.n.id];
      if (multi) store.pushUndo();
      drag = { mode: 'move', ids, orig: ids.map(id => {
        const n = store.notes.find(z => z.id === id);
        return { id, b0: n.startBeat, p0: n.pitch };
      }), x0: x, y0: y };
    }
  } else if (tool.value === 'select') {
    if (!e.shiftKey) store.select(null);
    drag = { mode: 'box', x0: x, y0: y, x1: x, y1: y, additive: !!e.shiftKey };
  } else {
    // 画笔：按下创建，可拖出长度
    const start = snapBeat((x - LEFT) / noteW);
    const pitch = Math.max(MIN_P, Math.min(MAX_P, MAX_P - Math.round((y - TOP) / ROW_H)));
    const id = store.addNote(start, pitch);
    drag = { mode: 'create', id, b0: start, x0: x };
  }
  try { canvas.value.setPointerCapture(e.pointerId); } catch (err) {}
}
function onMove(e) {
  if (!drag) return;
  const { x, y } = toXY(e);
  if (drag.mode === 'box') { drag.x1 = x; drag.y1 = y; draw(); return; }
  if (drag.mode === 'create') {
    const dur = snapDur(drag.b0 + (x - drag.x0) / noteW);
    store.updateNote(drag.id, { durBeat: dur });
    return;
  }
  if (drag.mode === 'rresize') {
    const n = store.notes.find(z => z.id === drag.id); if (!n) return;
    store.updateNote(drag.id, { durBeat: snapDur(drag.d0 + (x - drag.x0) / noteW) });
    return;
  }
  if (drag.mode === 'lresize') {
    const s = snap.value;
    let start = Math.round((drag.b0 + (x - drag.x0) / noteW) / s) * s;
    start = Math.max(0, Math.min(drag.b0 + drag.d0 - s, start));
    store.updateNote(drag.id, { startBeat: start, durBeat: drag.d0 + (drag.b0 - start) });
    return;
  }
  if (drag.mode === 'move') {
    const s = snap.value;
    const db = Math.round(((x - drag.x0) / noteW) / s) * s;
    const dp = -Math.round((y - drag.y0) / ROW_H);
    for (const o of drag.orig) {
      store.updateNote(o.id, {
        startBeat: Math.max(0, o.b0 + db),
        pitch: Math.max(MIN_P, Math.min(MAX_P, o.p0 + dp)),
      });
    }
  }
}
function onUp(e) {
  if (drag && drag.mode === 'box') {
    const x0 = Math.min(drag.x0, drag.x1), x1 = Math.max(drag.x0, drag.x1);
    const y0 = Math.min(drag.y0, drag.y1), y1 = Math.max(drag.y0, drag.y1);
    const hitIds = [];
    for (const n of store.notes) {
      const { rx, ry, rw, rh } = noteRect(n);
      if (rx < x1 && rx + rw > x0 && ry < y1 && ry + rh > y0) hitIds.push(n.id);
    }
    if (drag.additive) {
      const merged = new Set(store.selectedIds);
      for (const id of hitIds) merged.add(id);
      store.setSelection([...merged]);
    } else {
      store.setSelection(hitIds);
    }
  }
  drag = null;
  draw();
}
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
  const { x, y } = toXY(e);
  const hit = hitNote(x, y);
  if (hit && !store.selectedIds.includes(hit.n.id)) store.select(hit.n.id);
  if (!hit) store.select(null);
  ctxOnNote.value = !!hit;
  // 菜单坐标相对容器
  const rect = (wrap.value?.parentElement || canvas.value).getBoundingClientRect();
  ctxX.value = e.clientX - rect.left;
  ctxY.value = e.clientY - rect.top;
  ctxOpen.value = true;
}
function onKey(e) {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const k = e.key, mod = e.ctrlKey || e.metaKey;
  if (mod && (k === 'z' || k === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) { if (!store.redo()) app.toast(t('没有可重做的操作')); }
    else { if (!store.undo()) app.toast(t('没有可撤销的操作')); }
    return;
  }
  if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); if (!store.redo()) app.toast(t('没有可重做的操作')); return; }
  if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); store.selectAll(); return; }
  if (mod && (k === 'c' || k === 'C')) { e.preventDefault(); copySel(); return; }
  if (mod && (k === 'x' || k === 'X')) { e.preventDefault(); cutSel(); return; }
  if (mod && (k === 'v' || k === 'V')) { e.preventDefault(); pasteClip(); return; }
  if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); dupSel(); return; }
  if (k === 'Delete' || k === 'Backspace') {
    e.preventDefault();
    if (store.selectedIds.length) store.removeNotes(selIds());
    return;
  }
  if (k === ' ' && e.code === 'Space') { e.preventDefault(); play(); return; }
  if (k === 'Escape') { closeCtx(); libOpen.value = false; stopAll(); return; }
  // 方向键微调
  const s = snap.value;
  if (k === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? nudge({ dDur: -s }, 'dur-') : nudge({ dStart: -s }, 'start-'); }
  else if (k === 'ArrowRight') { e.preventDefault(); e.shiftKey ? nudge({ dDur: s }, 'dur+') : nudge({ dStart: s }, 'start+'); }
  else if (k === 'ArrowUp') { e.preventDefault(); nudge({ dPitch: e.shiftKey ? 12 : 1 }, 'p+'); }
  else if (k === 'ArrowDown') { e.preventDefault(); nudge({ dPitch: e.shiftKey ? -12 : -1 }, 'p-'); }
}

function addAtEnd() {
  const end = store.totalBeats;
  const id = store.addNote(end, 60); store.updateNote(id, { lyric: 'あ' });
  nextTick(() => { const el = wrap.value; if (el) el.scrollLeft = xOf(end) - 40; });
}
function delSelected() { if (store.selectedIds.length) store.removeNotes(selIds()); }
function goRender() { app.setView('utau'); }
// 右键菜单入口：对主选中音符打开歌词对话框
function onDblFromCtx() {
  const n = store.selected;
  if (!n) return;
  app.promptDialog({ title: t('歌词'), msg: t('输入该音符的歌词/音节：'), value: n.lyric }).then(v => {
    if (v != null && String(v).trim() !== '') store.updateNote(n.id, { lyric: String(v).trim() });
  });
}

/* ---------------- MIDI 基底旋律导入 ---------------- */
const libOpen = ref(false);   // 曲库选择浮层
const midiInput = ref(null);  // 网页端隐藏文件选择

// buildSong 产物（song）→ UTAU 音符数据；自动跳过鼓轨、选音符最多的轨道
function songToUtau(song) {
  const tpb = song.tpb || 480;
  let best = null;
  for (const tk of song.tracks || []) {
    if (tk.isDrum) continue;
    const ns = tk.notes || [];
    if (!best || ns.length > best.length) best = ns;
  }
  if (!best || !best.length) return null;
  const items = best.slice().sort((a, b) => a.start - b.start).map(n => ({
    startBeat: Math.max(0, n.start / tpb),
    durBeat: Math.max(0.25, (n.end - n.start) / tpb),
    pitch: Math.max(0, Math.min(127, Math.round(n.midi))),
    velocity: Math.max(1, Math.min(200, n.vel || 100)),
    lyric: 'あ',
  }));
  return { items, bpm: (song.initialBpm && song.initialBpm >= 20 && song.initialBpm <= 400) ? song.initialBpm : 120 };
}

async function doImportSong(song) {
  const r = songToUtau(song);
  if (!r || !r.items.length) { app.toast(t('该 MIDI 没有可用的旋律音符（鼓轨已自动跳过）'), 'warn'); return; }
  // 已有音符时询问替换或追加
  let replace = true;
  if (store.notes.length) {
    replace = await app.confirmDialog({
      title: t('导入基底旋律'),
      msg: t('将导入 ') + r.items.length + t(' 个音符作为基底旋律。是否清空当前 ') + store.notes.length + t(' 个音符？\n（选「取消」则追加到末尾）'),
      okText: t('清空并导入'),
      cancelText: t('追加'),
    });
    // confirmDialog 取消返回 false
  }
  stopAll();
  store.setBpm(r.bpm);
  const ids = store.importNotes(r.items, !!replace);
  if (!ids.length) return;
  app.toast(t('已导入 ') + ids.length + t(' 个音符，双击音符可修改唱音'));
  seekTo(0);
  nextTick(() => { const el = wrap.value; if (el) el.scrollLeft = 0; });
  draw();
}

function applyMidiBytes(buf) {
  try {
    const mid = parseMidi(new Uint8Array(buf));
    const song = buildSong(mid);
    doImportSong(song);
  } catch (e) { app.toast(t('无法解析该 MIDI 文件'), 'error'); }
}

// 桌面端：文件对话框；网页端：隐藏 input
async function importMidiFile() {
  const b = window.fuBridge;
  if (b && b.pickFile && b.readBinary) {
    try {
      const p = await b.pickFile({ filters: [{ name: 'MIDI', extensions: ['mid', 'midi', 'kar', 'rmi'] }] });
      if (!p) return;
      const ab = await b.readBinary(p);
      if (ab) applyMidiBytes(ab);
      return;
    } catch (e) { /* 回退到网页 input */ }
  }
  if (midiInput.value) midiInput.value.click();
}
function onMidiFileChange(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  f.arrayBuffer().then(buf => applyMidiBytes(buf)).catch(() => app.toast(t('读取文件失败'), 'error'));
  e.target.value = '';
}

// 从曲库选一首 MIDI 作为基底旋律
async function importFromLibrary(item) {
  libOpen.value = false;
  let song = item.song;
  if (!song) {
    try {
      if (item.__bytes) song = buildSong(parseMidi(new Uint8Array(item.__bytes)));
    } catch (e) { song = null; }
  }
  if (!song) { app.toast(t('无法读取该曲目的 MIDI 数据'), 'warn'); return; }
  await doImportSong(song);
}

// 修改选中音符唱音（工具栏按钮）
function editSelectedLyric() {
  const n = store.selected;
  if (!n) return;
  app.promptDialog({ title: t('唱音'), msg: t('输入该音符的歌词/音节：'), value: n.lyric }).then(v => {
    if (v != null && String(v).trim() !== '') store.updateNote(n.id, { lyric: String(v).trim() });
  });
}

const pitchOptions = Array.from({ length: MAX_P - MIN_P + 1 }, (_, i) => MIN_P + i);
watch(() => store.totalBeats, () => { setupCanvas(); draw(); });
watch(() => store.notes, draw, { deep: true });
watch(() => [store.selectedId, store.selectedIds], draw, { deep: true });
watch(() => store.bpm, () => { if (playing.value) playT0 = performance.now() - (playBeat.value - playStart) * 60000 / store.bpm; });
onMounted(() => { setupCanvas(); draw(); window.addEventListener('keydown', onKey); });
onBeforeUnmount(() => { stop(); window.removeEventListener('keydown', onKey); });
</script>

<template>
  <div class="us" @pointerdown="closeCtx">
    <div class="us-toolbar">
      <button class="btn sm" :class="{ primary: playing }" @click="play"><Icon :name="playing ? 'stop' : 'play2'" :size="13" /> {{ playing ? t('停止') : t('试听') }}</button>
      <span class="sep"></span>
      <div class="tg">
        <button class="btn sm" :class="{ on: tool === 'pencil' }" @click="tool = 'pencil'" :title="t('画笔：点击/拖拽加音')"><Icon name="pencil" :size="13" /></button>
        <button class="btn sm" :class="{ on: tool === 'select' }" @click="tool = 'select'" :title="t('选择：点击/框选/Shift加选')"><Icon name="cursor" :size="13" /></button>
      </div>
      <span class="sep"></span>
      <div class="tg">
        <button class="btn sm" @click="store.undo()" :disabled="!store.undoStack.length" :title="t('撤销 (Ctrl+Z)')"><Icon name="undo" :size="13" /></button>
        <button class="btn sm" @click="store.redo()" :disabled="!store.redoStack.length" :title="t('重做 (Ctrl+Y)')"><Icon name="redo" :size="13" /></button>
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
      <button class="btn sm" @click="importMidiFile" :title="t('导入 MIDI 文件作为基底旋律')"><Icon name="import" :size="13" /> {{ t('导入MIDI') }}</button>
      <button class="btn sm" @click="libOpen = true" :title="t('从曲库选择一首 MIDI 作为基底旋律')"><Icon name="music" :size="13" /> {{ t('曲库旋律') }}</button>
      <button class="btn sm" @click="editSelectedLyric" :disabled="!store.selected" :title="t('修改选中音符的唱音')"><Icon name="pencil" :size="13" /> {{ t('改唱音') }}</button>
      <span class="sep"></span>
      <button class="btn primary" @click="addAtEnd"><Icon name="plus" :size="13" /> {{ t('末尾加音') }}</button>
      <button class="btn sm" @click="delSelected" :disabled="!store.selectedIds.length">{{ t('删除') }}</button>
      <button class="btn sm ghost danger" @click="store.clear()" :disabled="!store.notes.length">{{ t('清空') }}</button>
    </div>

    <input ref="midiInput" type="file" accept=".mid,.midi,.kar,.rmi" hidden @change="onMidiFileChange" />

    <div ref="wrap" class="us-scroll" @pointerdown="closeCtx">
      <canvas ref="canvas" class="us-canvas"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
        @dblclick="onDbl" @contextmenu="onCtx"></canvas>
    </div>

    <div class="us-foot">
      <span class="muted small">{{ t('画笔拖出音符') }} · {{ t('框选/Shift多选') }} · {{ t('Alt拖拽复制') }} · {{ t('左右缘改长') }} · {{ t('双击改歌词') }} · {{ t('方向键微调') }} · {{ t('Ctrl+C/V/Z') }}</span>
      <span class="muted small" style="margin-left:auto">{{ store.notes.length }} {{ t('音符') }} · {{ store.bpm }} BPM · {{ t('音源 ') }}{{ store.sampleNote }}</span>
    </div>

    <!-- 右键菜单 -->
    <div v-if="ctxOpen" class="us-ctx" :style="{ left: ctxX + 'px', top: ctxY + 'px' }"
      @pointerdown.stop @contextmenu.prevent>
      <button class="us-ctx-i" :disabled="!store.undoStack.length" @click="store.undo(); closeCtx()"><Icon name="undo" :size="13" /> {{ t('撤销') }}</button>
      <button class="us-ctx-i" :disabled="!store.redoStack.length" @click="store.redo(); closeCtx()"><Icon name="redo" :size="13" /> {{ t('重做') }}</button>
      <div class="us-ctx-sep"></div>
      <button class="us-ctx-i" :disabled="!ctxOnNote" @click="cutSel(); closeCtx()">{{ t('剪切') }}</button>
      <button class="us-ctx-i" :disabled="!ctxOnNote" @click="copySel(); closeCtx()">{{ t('复制') }}</button>
      <button class="us-ctx-i" :disabled="!clipboard.length" @click="pasteClip(); closeCtx()">{{ t('粘贴') }}</button>
      <button class="us-ctx-i" :disabled="!ctxOnNote" @click="dupSel(); closeCtx()">{{ t('重复') }}</button>
      <div class="us-ctx-sep"></div>
      <button class="us-ctx-i" :disabled="!ctxOnNote" @click="onDblFromCtx(); closeCtx()">{{ t('编辑歌词') }}</button>
      <button class="us-ctx-i danger" :disabled="!ctxOnNote" @click="delSelected(); closeCtx()">{{ t('删除音符') }}</button>
    </div>

    <!-- 曲库选择：选一首 MIDI 作为基底旋律 -->
    <Transition name="ov">
      <div v-if="libOpen" class="us-lib-mask" role="dialog" aria-modal="true" :aria-label="t('选择基底旋律')" @click.self="libOpen = false">
        <div class="us-lib">
          <div class="us-lib-head">
            <b>{{ t('选择基底旋律') }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" aria-label="t('关闭')" @click="libOpen = false"><Icon name="close" :size="14" /></button>
          </div>
          <div class="us-lib-list">
            <button v-for="s in app.songs" :key="s.id" class="us-lib-item" @click="importFromLibrary(s)">
              <span class="us-lib-name">{{ s.name }}</span>
              <span class="us-lib-meta">{{ s.meta && s.meta.dur ? fmtTime(s.meta.dur) : '' }}</span>
            </button>
            <div v-if="!app.songs.length" class="us-lib-empty">{{ t('资料库为空，请先导入 MIDI 歌曲') }}</div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.us { padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; position: relative; }
.us-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--stone); }
.us-toolbar label { display: inline-flex; align-items: center; gap: 6px; }
.us-num { width: 60px; padding: 3px 6px; font-size: 12px; }
.tg { display: inline-flex; gap: 2px; }
.tg .btn.on { background: var(--brand-soft); color: var(--brand-text); border-color: var(--brand); }
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; flex: none; }
.us-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); touch-action: none; }
.us-canvas { display: block; cursor: crosshair; }
.us-foot { display: flex; align-items: center; gap: 10px; line-height: 1.6; }

/* 右键菜单 */
.us-ctx { position: absolute; z-index: 30; min-width: 148px; padding: 4px; display: flex; flex-direction: column; gap: 1px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.14); font-size: 12px; }
.us-ctx-i { display: flex; align-items: center; gap: 7px; padding: 6px 10px; border: 0; border-radius: 6px;
  background: transparent; color: var(--text); cursor: pointer; text-align: left; width: 100%; }
.us-ctx-i:hover:not(:disabled) { background: var(--brand-soft); color: var(--brand-text); }
.us-ctx-i:disabled { opacity: 0.4; cursor: default; }
.us-ctx-i.danger { color: #d33; }
.us-ctx-i.danger:hover:not(:disabled) { background: rgba(211,51,51,0.1); color: #d33; }
.us-ctx-sep { height: 1px; background: var(--border); margin: 3px 6px; }

/* 曲库选择浮层 */
.us-lib-mask { position: fixed; inset: 0; background: rgba(10,10,10,0.4); display: flex; align-items: center; justify-content: center; z-index: 60; }
.us-lib { width: min(420px, 92vw); max-height: min(70vh, 560px); background: var(--canvas); border-radius: 14px;
  box-shadow: 0 24px 64px rgba(16,24,40,0.24); display: flex; flex-direction: column; overflow: hidden; }
.us-lib-head { display: flex; align-items: center; gap: 8px; padding: 13px 16px 9px; font-size: 14px; color: var(--ink); }
.us-lib-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 10px 10px; display: flex; flex-direction: column; gap: 4px; }
.us-lib-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font-size: 13px; cursor: pointer; text-align: left; }
.us-lib-item:hover { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-text); }
.us-lib-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.us-lib-meta { flex: none; font-size: 11px; color: var(--text-muted, #888); }
.us-lib-empty { padding: 26px 0; text-align: center; color: var(--text-muted, #888); font-size: 13px; }
</style>

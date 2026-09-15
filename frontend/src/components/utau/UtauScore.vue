<script setup>
// UTAU 可视化钢琴卷帘编辑器
// 画笔/选择工具、框选多选、缩放、网格吸附、播放走带、歌词填词、
// 复制/剪切/粘贴/重复、撤销/重做、键盘微调、Alt拖拽复制、左右缘缩放、右键菜单
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../Icon.vue';
import { useUtauStore, UTAU_PARAMS, paramMeta, paramValue } from '../../stores/utau';
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
  setupParamCanvas();
  setupCurveCanvas();
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
  const grid = V('--grid'), onNote = V('--on-note'), noteFill = V('--note-fill');
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
    ctx.strokeStyle = (b % 4 === 0) ? border : grid;
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
    ctx.fillStyle = sel ? brand : noteFill;
    ctx.strokeStyle = primary ? ink : (sel ? brand : V('--note-edge'));
    ctx.lineWidth = sel ? 1.6 : 0.8;
    roundRect(ctx, x, y + 1, w, h, 3); ctx.fill(); ctx.stroke();
    if (n.lyric) {
      ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 1, w - 4, h); ctx.clip();
      ctx.fillStyle = onNote; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(n.lyric, x + 4, y + h / 2 + 3); ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = sel ? 1 : 0.5;
    ctx.fillStyle = onNote;
    ctx.fillRect(x + w - 3, y + 1, 3, h);
    ctx.restore();
  }

  // 框选矩形
  if (drag && drag.mode === 'box') {
    const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
    const bw = Math.abs(drag.x1 - drag.x0), bh = Math.abs(drag.y1 - drag.y0);
    ctx.save();
    ctx.strokeStyle = brand; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.fillStyle = V('--tint-strong');
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
      ctx.fillStyle = onNote; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(playBeat.value.toFixed(1) + t(' 拍'), px + 6, TOP + 8);
    }
  }
  drawParam();
  drawCurve();
}
function V(n) { try { const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || F(n); } catch (e) { return F(n); } }
function F(n) {
  return {
    '--surface': '#F7F7F8', '--border': 'rgba(23,23,23,0.12)', '--text': '#171717',
    '--text-muted': '#52525B', '--brand': '#4B3FE3', '--surface-muted': '#EFEFF2',
    '--muted': '#a8aab2', '--grid': 'rgba(15,23,42,0.08)', '--grid-strong': 'rgba(15,23,42,0.16)',
    '--tint-strong': 'rgba(20,86,240,0.20)', '--row-alt': 'rgba(15,23,42,0.035)',
    '--sel': '#ff5530', '--sel-soft': 'rgba(255,85,48,0.14)',
    '--note-fill': '#8b83f0', '--note-edge': 'rgba(23,23,23,0.25)', '--on-note': '#ffffff',
  }[n] || '#fff';
}
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
/* 一键重置：颤音（音高相关编辑）/ 全部调声参数 回到默认值 */
function ctxResetVibrato() {
  const ids = selIds();
  if (!ids.length) { closeCtx(); return; }
  store.resetVibrato(ids);
  app.toast(t('已重置颤音'), 'ok');
  closeCtx();
}
function ctxResetParams() {
  const ids = selIds();
  if (!ids.length) { closeCtx(); return; }
  store.resetParams(ids);
  app.toast(t('已重置调声参数'), 'ok');
  closeCtx();
}
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
/* ---------------- UTAU 参数预设（BPM + 音源音高，存 localStorage） ---------------- */
const utauPresets = reactive((() => { try { return JSON.parse(localStorage.getItem('fufumidi_utau_presets') || '{}'); } catch (e) { return {}; } })());
function saveUtauPreset() {
  const name = prompt(t('预设名称'), 'Preset ' + (Object.keys(utauPresets).length + 1));
  if (!name || !name.trim()) return;
  utauPresets[name.trim()] = { bpm: store.bpm, sampleNote: store.sampleNote };
  try { localStorage.setItem('fufumidi_utau_presets', JSON.stringify(utauPresets)); } catch (e) {}
  app.toast(t('已保存预设 ') + name.trim(), 'ok');
}
function applyUtauPreset(name) {
  const p = utauPresets[name];
  if (!p) return;
  if (p.bpm) store.setBpm(p.bpm);
  if (p.sampleNote) store.setSampleNote(p.sampleNote);
  app.toast(t('已应用预设 ') + name, 'ok');
}
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
/* ---------------- P1-4 发音 / 别名替换 ---------------- */
const aliasOpen = ref(false);
const aliasQuery = ref('');
const aliasAll = ref([]);          // 当前声库的全部别名（首次打开时拉取并缓存）
const aliasDir = ref('');
const aliasBusy = ref(false);
const aliasTotal = ref(0);
const aliasFiltered = computed(() => {
  const q = aliasQuery.value.trim();
  const all = aliasAll.value;
  const hit = q ? all.filter(a => a.indexOf(q) >= 0) : all;
  return hit.slice(0, 300);
});
async function ensureAliases() {
  const dir = store.voicebankDir;
  if (!dir) { app.toast(t('请先在「声库制作」选择声库'), 'warn'); return false; }
  const api = window.fuBridge;
  if (!api || typeof api.utauAliases !== 'function') { app.toast(t('网页版无法读取声库发音，请用桌面版'), 'warn'); return false; }
  if (aliasDir.value === dir && aliasAll.value.length) return true;
  aliasBusy.value = true;
  try {
    const r = await api.utauAliases({ voicebank: dir, limit: 2000 });
    if (!r || !r.ok) { app.toast(t('读取声库发音失败：') + ((r && r.error) || 'unknown'), 'err'); return false; }
    aliasAll.value = r.aliases || [];
    aliasTotal.value = r.total || aliasAll.value.length;
    aliasDir.value = dir;
    return true;
  } catch (e) {
    app.toast(t('读取声库发音失败：') + ((e && e.message) || e), 'err');
    return false;
  } finally { aliasBusy.value = false; }
}
function openAliasPicker() {
  const n = store.selected;
  aliasQuery.value = n ? String(n.lyric || '') : '';
  aliasOpen.value = true;
  ensureAliases();
}
function applyAlias(a) {
  const ids = selIds();
  if (!ids.length) { closeAliasPicker(); return; }
  store.updateNotes(ids, { lyric: a });
  app.toast(t('已替换发音：') + a + t('（') + ids.length + t(' 个音符）'), 'ok');
  closeAliasPicker();
}
function closeAliasPicker() { aliasOpen.value = false; }
watch(() => store.voicebankDir, () => { aliasDir.value = ''; aliasAll.value = []; aliasTotal.value = 0; });

/* ---------------- P0-3 参数车道（逐音符合成参数） ---------------- */
const PARAM_H = 84;
const paramKey = ref('');            // '' = 关闭；否则 UtauParamKey
const paramCanvas = ref(null);
let paramCtx = null;
let paramGesture = null;             // { pushed, lastX }
const paramMetaNow = computed(() => (paramKey.value ? paramMeta(paramKey.value) : null));

function setupParamCanvas() {
  const c = paramCanvas.value; if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(cw * dpr); c.height = Math.round(PARAM_H * dpr);
  c.style.width = cw + 'px'; c.style.height = PARAM_H + 'px';
  paramCtx = c.getContext('2d'); paramCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
const paramPad = 8;
function paramToY(v) {
  const m = paramMetaNow.value; if (!m) return PARAM_H;
  const h = PARAM_H - paramPad * 2;
  const k = (Math.max(m.min, Math.min(m.max, Number(v) || 0)) - m.min) / Math.max(1e-9, m.max - m.min);
  return paramPad + (1 - k) * h;
}
function paramFromY(y) {
  const m = paramMetaNow.value; if (!m) return 0;
  const h = PARAM_H - paramPad * 2;
  const k = 1 - Math.max(0, Math.min(1, (y - paramPad) / h));
  return Math.round(m.min + k * (m.max - m.min));
}
function drawParam() {
  const c = paramCanvas.value; if (!c || !paramKey.value) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(cw * dpr)) setupParamCanvas();
  const g = paramCtx || c.getContext('2d');
  if (!g) return;
  const m = paramMetaNow.value;
  const brand = V('--brand');
  c.style.transform = 'translateX(' + (-(wrap.value ? wrap.value.scrollLeft : 0)) + 'px)';
  g.clearRect(0, 0, cw, PARAM_H);
  g.fillStyle = V('--surface-muted'); g.fillRect(0, 0, cw, PARAM_H);
  // 拍线
  for (let b = 0; b <= beatEnds; b++) {
    const x = xOf(b);
    g.strokeStyle = (b % 4 === 0) ? V('--border') : V('--grid');
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, PARAM_H); g.stroke();
  }
  // 默认值参考线
  const yDef = paramToY(m.def);
  g.setLineDash([4, 4]); g.strokeStyle = V('--grid-strong');
  g.beginPath(); g.moveTo(0, yDef); g.lineTo(cw, yDef); g.stroke();
  g.setLineDash([]);
  // 每个音符：从默认值线出发的柱状
  for (const n of store.sortedNotes) {
    const x = xOf(n.startBeat);
    const w = Math.max(noteW * 0.9, n.durBeat * noteW - 2);
    const v = paramValue(n, paramKey.value);
    if (Math.abs(v - m.def) < 1e-9) continue;
    const y = paramToY(v);
    g.fillStyle = V('--tint-strong');
    g.fillRect(x + 1, Math.min(y, yDef), w - 2, Math.max(1, Math.abs(y - yDef)));
    g.fillStyle = brand;
    g.fillRect(x + 1, y - 1, w - 2, 2);
  }
  // 选中音符描边
  const sel = new Set(store.selectedIds);
  for (const n of store.sortedNotes) {
    if (!sel.has(n.id)) continue;
    const x = xOf(n.startBeat), w = Math.max(noteW * 0.9, n.durBeat * noteW - 2);
    g.strokeStyle = V('--sel'); g.lineWidth = 1.5;
    g.strokeRect(x + 1, 1, w - 2, PARAM_H - 2);
  }
  // 播放头
  if (playing.value || playBeat.value > 0) {
    const px = xOf(playBeat.value);
    g.strokeStyle = brand; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, PARAM_H); g.stroke();
  }
  // 量程标签
  g.fillStyle = V('--text-muted'); g.font = '9px sans-serif'; g.textAlign = 'right';
  g.fillText(String(m.max), LEFT - 6, paramPad + 8);
  g.fillText(String(m.def), LEFT - 6, yDef + 3);
  g.fillText(String(m.min), LEFT - 6, PARAM_H - paramPad + 2);
}
function paramXY(e) { const r = paramCanvas.value.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
/** 手势中按 x 连续写入：单点拖动改一个音的值，横扫即可批量设值 */
function paramPaint(e) {
  if (!paramKey.value || !paramGesture) return;
  const { x, y } = paramXY(e);
  const v = paramFromY(y);
  const x0 = paramGesture.lastX;
  const [a, b] = x0 <= x ? [x0, x] : [x, x0];
  const hits = [];
  for (const n of store.sortedNotes) {
    const nx = xOf(n.startBeat), nw = Math.max(noteW * 0.9, n.durBeat * noteW - 2);
    if (nx + nw >= a - 1 && nx <= b + 1) hits.push(n.id);
  }
  if (hits.length) {
    if (!paramGesture.pushed) { store.pushUndo(); paramGesture.pushed = true; }
    store.setParams(hits, paramKey.value, v, false);
  }
  paramGesture.lastX = x;
  drawParam();
}
function paramDown(e) {
  if (!paramKey.value) return;
  e.preventDefault();
  paramGesture = { pushed: false, lastX: paramXY(e).x };
  try { paramCanvas.value.setPointerCapture(e.pointerId); } catch (err) {}
  paramPaint(e);
}
function paramMove(e) { if (paramGesture) paramPaint(e); }
function paramUp() { paramGesture = null; }
function paramResetAll() {
  const ids = store.selectedIds.length ? [...store.selectedIds] : store.notes.map(n => n.id);
  if (!ids.length) { app.toast(t('没有可重置的音符'), 'warn'); return; }
  store.setParams(ids, paramKey.value, paramMetaNow.value.def);
  app.toast(t('已重置参数为默认值'), 'ok');
}
watch(paramKey, async () => {
  await nextTick();
  if (paramKey.value) { setupParamCanvas(); drawParam(); }
});

/* ---------------- P1-1 音高曲线手绘车道 ---------------- */
const CURVE_H = 96;
const CURVE_SEMI = 1200;                    // 车道量程：±1200 音分（一个八度）
const curveMode = ref('off');               // off | draw（手绘） | point（控制点）
const curveCanvas = ref(null);
let curveCtx = null;
let curveGesture = null;                    // { pushed, noteId, points, kind }

function setupCurveCanvas() {
  const c = curveCanvas.value; if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(cw * dpr); c.height = Math.round(CURVE_H * dpr);
  c.style.width = cw + 'px'; c.style.height = CURVE_H + 'px';
  curveCtx = c.getContext('2d'); curveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
const curveMid = () => CURVE_H / 2;
const centsToY = v => curveMid() - Math.max(-CURVE_SEMI, Math.min(CURVE_SEMI, v)) / CURVE_SEMI * (curveMid() - 6);
const yToCents = y => Math.round(Math.max(-1, Math.min(1, (curveMid() - y) / (curveMid() - 6))) * CURVE_SEMI);
function noteSpan(n) {
  const x = xOf(n.startBeat);
  const w = Math.max(noteW * 0.9, n.durBeat * noteW - 2);
  return { x, w };
}
function noteAtX(x) {
  for (const n of store.sortedNotes) {
    const { x: nx, w } = noteSpan(n);
    if (x >= nx && x <= nx + w) return n;
  }
  return null;
}
function drawCurve() {
  const c = curveCanvas.value;
  if (!c || curveMode.value === 'off') return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(cw * dpr)) setupCurveCanvas();
  const g = curveCtx || c.getContext('2d');
  if (!g) return;
  const brand = V('--brand');
  c.style.transform = 'translateX(' + (-(wrap.value ? wrap.value.scrollLeft : 0)) + 'px)';
  g.clearRect(0, 0, cw, CURVE_H);
  g.fillStyle = V('--surface-muted'); g.fillRect(0, 0, cw, CURVE_H);
  // 拍线 + 0 音分中线 + ±半个八度参考线
  for (let b = 0; b <= beatEnds; b++) {
    const x = xOf(b);
    g.strokeStyle = (b % 4 === 0) ? V('--border') : V('--grid');
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, CURVE_H); g.stroke();
  }
  g.setLineDash([4, 4]); g.strokeStyle = V('--grid-strong');
  g.beginPath(); g.moveTo(0, curveMid()); g.lineTo(cw, curveMid()); g.stroke();
  g.setLineDash([]);
  g.fillStyle = V('--muted');
  g.font = '9px sans-serif'; g.textAlign = 'right';
  g.fillText('+1200', LEFT - 6, 12);
  g.fillText('0', LEFT - 6, curveMid() + 3);
  g.fillText('-1200', LEFT - 6, CURVE_H - 4);
  // 每个音符：底纹 + 曲线
  const sel = new Set(store.selectedIds);
  for (const n of store.sortedNotes) {
    const { x, w } = noteSpan(n);
    if (x > cw || x + w < 0) continue;
    g.fillStyle = sel.has(n.id) ? V('--sel-soft') : V('--row-alt');
    g.fillRect(x, 0, w, CURVE_H);
    if (sel.has(n.id)) { g.strokeStyle = V('--sel'); g.lineWidth = 1; g.strokeRect(x + 0.5, 0.5, w - 1, CURVE_H - 1); }
    const cu = n.pitchCurve;
    if (!cu || !cu.length) continue;
    g.strokeStyle = brand; g.lineWidth = 2; g.beginPath();
    cu.forEach((p, i) => {
      const px = x + p.pos * w, py = centsToY(p.cents);
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    });
    g.stroke();
    if (curveMode.value === 'point') {
      for (const p of cu) {
        g.fillStyle = V('--on-note'); g.strokeStyle = brand; g.lineWidth = 1.5;
        g.beginPath(); g.arc(x + p.pos * w, centsToY(p.cents), 3.5, 0, Math.PI * 2);
        g.fill(); g.stroke();
      }
    }
  }
  // 播放头
  if (playing.value || playBeat.value > 0) {
    const px = xOf(playBeat.value);
    g.strokeStyle = brand; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, CURVE_H); g.stroke();
  }
}
function curveXY(e) { const r = curveCanvas.value.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function curvePushNote(n) {
  if (!curveGesture.pushed) { store.pushUndo(); curveGesture.pushed = true; }
}
/** 手绘：按下即清空该音符原曲线，滑动过程中按 x 采样 */
function curvePaint(e) {
  const { x, y } = curveXY(e);
  const n = store.sortedNotes.find(k => k.id === curveGesture.noteId);
  if (!n) return;
  const { x: nx, w } = noteSpan(n);
  const pos = Math.max(0, Math.min(1, (x - nx) / Math.max(1, w)));
  const cents = yToCents(y);
  curvePushNote(n);
  const pts = curveGesture.points.slice();
  pts.push({ pos, cents });
  curveGesture.points = pts;
  store.setPitchCurve(n.id, pts, false);
  drawCurve();
}
/** 控制点：拖动最近点 / 空白处新增 */
function curvePoint(e, initial) {
  const { x, y } = curveXY(e);
  const n = store.sortedNotes.find(k => k.id === curveGesture.noteId);
  if (!n) return;
  const { x: nx, w } = noteSpan(n);
  const cur = (n.pitchCurve || []).map(p => ({ ...p }));
  if (initial) {
    let bi = -1, bd = 9;
    cur.forEach((p, i) => {
      const d = Math.hypot(nx + p.pos * w - x, centsToY(p.cents) - y);
      if (d < bd) { bd = d; bi = i; }
    });
    curveGesture.idx = bi >= 0 ? bi : -1;
    if (bi < 0) {
      curvePushNote(n);
      cur.push({ pos: Math.max(0, Math.min(1, (x - nx) / Math.max(1, w))), cents: yToCents(y) });
      curveGesture.idx = cur.length - 1;
    }
    curveGesture.points = cur;
  }
  const i = curveGesture.idx;
  if (i < 0 || i >= cur.length) return;
  curvePushNote(n);
  cur[i] = { pos: Math.max(0, Math.min(1, (x - nx) / Math.max(1, w))), cents: yToCents(y) };
  curveGesture.points = cur;
  store.setPitchCurve(n.id, cur, false);
  drawCurve();
}
function curveDown(e) {
  if (curveMode.value === 'off') return;
  e.preventDefault();
  const { x } = curveXY(e);
  const n = noteAtX(x);
  if (!n) { curveGesture = null; return; }
  if (!store.selectedIds.includes(n.id)) store.select(n.id);
  curveGesture = { pushed: false, noteId: n.id, points: [], idx: -1, kind: curveMode.value };
  try { curveCanvas.value.setPointerCapture(e.pointerId); } catch (err) {}
  if (curveMode.value === 'draw') curvePaint(e); else curvePoint(e, true);
}
function curveMove(e) {
  if (!curveGesture) return;
  if (curveGesture.kind === 'draw') curvePaint(e); else curvePoint(e, false);
}
function curveUp() {
  if (curveGesture) {
    // 手绘至少要有两个点才有意义
    if (curveGesture.kind === 'draw' && curveGesture.points.length < 2) {
      const n = store.sortedNotes.find(k => k.id === curveGesture.noteId);
      if (n) store.setPitchCurve(n.id, []);
    }
    curveGesture = null;
  }
}
/** 双击控制点删除 */
function curveDbl(e) {
  if (curveMode.value !== 'point') return;
  const { x, y } = curveXY(e);
  const n = noteAtX(x);
  if (!n || !n.pitchCurve || !n.pitchCurve.length) return;
  const { x: nx, w } = noteSpan(n);
  const rest = n.pitchCurve.filter(p => Math.hypot(nx + p.pos * w - x, centsToY(p.cents) - y) > 8);
  if (rest.length !== n.pitchCurve.length) store.setPitchCurve(n.id, rest);
}
function curveClear() {
  const ids = store.selectedIds.length ? [...store.selectedIds] : store.notes.map(n => n.id);
  const has = store.notes.filter(n => ids.includes(n.id) && n.pitchCurve && n.pitchCurve.length);
  if (!has.length) { app.toast(t('没有可清除的音高曲线'), 'warn'); return; }
  store.clearPitchCurve(has.map(n => n.id));
  app.toast(t('已清除音高曲线'), 'ok');
}
watch(curveMode, async () => {
  await nextTick();
  if (curveMode.value !== 'off') { if (paramKey.value) paramKey.value = ''; setupCurveCanvas(); drawCurve(); }
});
watch(paramKey, (v) => { if (v && curveMode.value !== 'off') curveMode.value = 'off'; });

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
      <label>{{ t('预设') }}<select class="select-input" :value="''" @change="applyUtauPreset($event.target.value)">
        <option value="">{{ t('选择…') }}</option>
        <option v-for="(p, k) in utauPresets" :key="k" :value="k">{{ k }}{{ t('（') }}{{ p.bpm }} BPM / {{ p.sampleNote }}{{ t('）') }}</option>
      </select></label>
      <button class="btn sm" @click="saveUtauPreset" :title="t('把当前 BPM 与音源音高保存为预设')">{{ t('存为预设') }}</button>
      <span class="sep"></span>
      <button class="btn sm" @click="importMidiFile" :title="t('导入 MIDI 文件作为基底旋律')"><Icon name="import" :size="13" /> {{ t('导入MIDI') }}</button>
      <button class="btn sm" @click="libOpen = true" :title="t('从曲库选择一首 MIDI 作为基底旋律')"><Icon name="music" :size="13" /> {{ t('曲库旋律') }}</button>
      <button class="btn sm" @click="editSelectedLyric" :disabled="!store.selected" :title="t('修改选中音符的唱音')"><Icon name="pencil" :size="13" /> {{ t('改唱音') }}</button>
      <button class="btn sm" @click="openAliasPicker" :disabled="!store.selected" :title="t('从声库别名列表里替换选中音符的发音')"><Icon name="music" :size="13" /> {{ t('发音') }}</button>
      <span class="sep"></span>
      <button class="btn primary" @click="addAtEnd"><Icon name="plus" :size="13" /> {{ t('末尾加音') }}</button>
      <button class="btn sm" @click="delSelected" :disabled="!store.selectedIds.length">{{ t('删除') }}</button>
      <button class="btn sm ghost danger" @click="store.clear()" :disabled="!store.notes.length">{{ t('清空') }}</button>
    </div>

    <input ref="midiInput" type="file" accept=".mid,.midi,.kar,.rmi" hidden @change="onMidiFileChange" />

    <div ref="wrap" class="us-scroll" @pointerdown="closeCtx" @scroll="drawParam(); drawCurve()">
      <canvas ref="canvas" class="us-canvas"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
        @dblclick="onDbl" @contextmenu="onCtx"></canvas>
    </div>

    <!-- P0-3 参数车道：逐音符调声参数的可视化编辑 -->
    <div class="us-param-bar">
      <span class="muted small">{{ t('参数车道') }}</span>
      <select v-model="paramKey" class="text-input" style="width:auto;padding:3px 6px">
        <option value="">{{ t('关闭') }}</option>
        <option v-for="p in UTAU_PARAMS" :key="p.key" :value="p.key">{{ t(p.label) }}</option>
      </select>
      <template v-if="paramMetaNow">
        <span class="muted small">{{ t('在车道上拖动/横扫即可改值（可撤销）') }}</span>
        <button class="btn sm ghost" @click="paramResetAll">{{ t('重置为默认') }}</button>
        <span class="muted small" style="margin-left:auto">
          {{ t('默认') }} {{ paramMetaNow.def }} · {{ t('范围') }} {{ paramMetaNow.min }}~{{ paramMetaNow.max }}
        </span>
      </template>
      <span v-if="!paramMetaNow" class="sep"></span>
      <template v-if="!paramMetaNow">
        <span class="muted small">{{ t('音高曲线') }}</span>
        <select v-model="curveMode" class="text-input" style="width:auto;padding:3px 6px">
          <option value="off">{{ t('关闭') }}</option>
          <option value="draw">{{ t('手绘') }}</option>
          <option value="point">{{ t('控制点') }}</option>
        </select>
        <template v-if="curveMode !== 'off'">
          <span class="muted small">{{ curveMode === 'draw' ? t('在音符区间内按住拖动即可绘制曲线') : t('拖动控制点改音高；空白处点击新增；双击删除') }}</span>
          <button class="btn sm ghost" @click="curveClear">{{ t('清除曲线') }}</button>
          <span class="muted small" style="margin-left:auto">{{ t('量程 ±1200 音分') }}</span>
        </template>
      </template>
    </div>
    <div v-if="paramKey" class="us-param-lane">
      <canvas ref="paramCanvas" class="us-param-canvas"
        @pointerdown="paramDown" @pointermove="paramMove" @pointerup="paramUp" @pointercancel="paramUp"></canvas>
    </div>
    <div v-if="curveMode !== 'off'" class="us-param-lane us-curve-lane">
      <canvas ref="curveCanvas" class="us-param-canvas"
        @pointerdown="curveDown" @pointermove="curveMove" @pointerup="curveUp" @pointercancel="curveUp"
        @dblclick="curveDbl"></canvas>
    </div>

    <div class="us-foot">
      <span class="muted small">{{ t('画笔拖出音符') }} · {{ t('框选/Shift多选') }} · {{ t('Alt拖拽复制') }} · {{ t('左右缘改长') }} · {{ t('双击改歌词') }} · {{ t('方向键微调') }} · {{ t('Ctrl+C/V/Z') }}</span>
      <span class="muted small" style="margin-left:auto">{{ store.notes.length }} {{ t('音符') }} · {{ store.bpm }} BPM · {{ t('音源 ') }}{{ store.sampleNote }}</span>
    </div>

    <!-- 右键菜单 -->
    <Transition name="ctxmenu">
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
      <button class="us-ctx-i" :disabled="!ctxOnNote" @click="openAliasPicker(); closeCtx()">{{ t('替换发音（别名）') }}</button>
      <div class="us-ctx-sep"></div>
      <button class="us-ctx-i" :disabled="!ctxOnNote" @click="ctxResetVibrato">{{ t('重置颤音') }}</button>
      <button class="us-ctx-i" :disabled="!ctxOnNote" @click="ctxResetParams">{{ t('重置全部参数') }}</button>
      <div class="us-ctx-sep"></div>
      <button class="us-ctx-i danger" :disabled="!ctxOnNote" @click="delSelected(); closeCtx()">{{ t('删除音符') }}</button>
    </div>
    </Transition>

    <!-- P1-4 发音 / 别名替换 -->
    <Transition name="ov">
      <div v-if="aliasOpen" class="us-lib-mask" role="dialog" aria-modal="true" :aria-label="t('替换发音')" @click.self="closeAliasPicker">
        <div class="us-lib">
          <div class="us-lib-head">
            <b>{{ t('替换发音（别名）') }}</b>
            <span class="muted small">{{ t('声库别名 ') }}{{ aliasTotal || aliasAll.length }}</span>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="closeAliasPicker"><Icon name="close" :size="14" /></button>
          </div>
          <div class="row" style="gap:8px">
            <input v-model="aliasQuery" class="text-input" style="flex:1" :placeholder="t('搜索别名（如 か / a / 001）')" :aria-label="t('搜索别名')" />
            <span class="muted small">{{ aliasFiltered.length }}</span>
          </div>
          <div class="us-lib-list">
            <button v-for="a in aliasFiltered" :key="a" class="us-lib-item" @click="applyAlias(a)">
              <span class="us-lib-name">{{ a }}</span>
            </button>
            <div v-if="aliasBusy" class="us-lib-empty">{{ t('正在读取声库…') }}</div>
            <div v-else-if="!aliasAll.length" class="us-lib-empty">{{ t('请先在「声库制作」选择声库，或该声库没有可用别名') }}</div>
            <div v-else-if="!aliasFiltered.length" class="us-lib-empty">{{ t('没有匹配的别名') }}</div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 曲库选择：选一首 MIDI 作为基底旋律 -->
    <Transition name="ov">
      <div v-if="libOpen" class="us-lib-mask" role="dialog" aria-modal="true" :aria-label="t('选择基底旋律')" @click.self="libOpen = false">
        <div class="us-lib">
          <div class="us-lib-head">
            <b>{{ t('选择基底旋律') }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="libOpen = false"><Icon name="close" :size="14" /></button>
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
.us-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; overflow-x: auto; font-size: 12px; color: var(--stone); flex: none; }
.us-toolbar label { display: inline-flex; align-items: center; gap: 6px; }
.us-num { width: 60px; padding: 3px 6px; font-size: 12px; }
.tg { display: inline-flex; gap: 2px; }
.tg .btn.on { background: var(--brand-soft); color: var(--brand-text); border-color: var(--brand); }
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; flex: none; }
.us-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); touch-action: none; }
.us-canvas { display: block; cursor: crosshair; }
.us-foot { display: flex; align-items: center; gap: 10px; line-height: 1.6; }

/* 右键菜单 */
.us-ctx { position: absolute; z-index: var(--z-ctx); min-width: 148px; padding: 4px; display: flex; flex-direction: column; gap: 1px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.14); font-size: 12px; }
.us-ctx-i { display: flex; align-items: center; gap: 7px; padding: 6px 10px; border: 0; border-radius: 6px;
  background: transparent; color: var(--text); cursor: pointer; text-align: left; width: 100%; }
.us-ctx-i:hover:not(:disabled) { background: var(--brand-soft); color: var(--brand-text); }
.us-ctx-i:disabled { opacity: 0.4; cursor: default; }
.us-ctx-i.danger { color: var(--red); }
.us-ctx-i.danger:hover:not(:disabled) { background: rgba(211,51,51,0.1); color: var(--red); }
.us-ctx-sep { height: 1px; background: var(--border); margin: 3px 6px; }

/* P0-3 参数车道 */
.us-param-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px 0; flex: none; }
.us-param-lane { position: relative; height: var(--lane-h, 84px); overflow: hidden; border-top: 1px solid var(--border); background: var(--surface-muted); flex: none; }
.us-param-canvas { position: absolute; top: 0; left: 0; display: block; cursor: crosshair; touch-action: none; }
.us-curve-lane { height: var(--lane-h-tall, 96px); }
/* 右键菜单开合动画（从触发点轻缩放弹出） */
.ctxmenu-enter-active, .ctxmenu-leave-active { transition: opacity .12s ease, transform .14s cubic-bezier(.2,.9,.3,1.18); transform-origin: left top; }
.ctxmenu-enter-from, .ctxmenu-leave-to { opacity: 0; transform: scale(.94) translate(-3px, -3px); }

/* 曲库选择浮层 */
.us-lib-mask { position: fixed; inset: 0; background: rgba(10,10,10,0.4); display: flex; align-items: center; justify-content: center; z-index: var(--z-overlay, 900); }
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

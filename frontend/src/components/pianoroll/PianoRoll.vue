<script setup>
// 通用钢琴卷帘（OpenUTAU 式可视化编辑），由 adapter 适配不同 store。
// ------------------------------------------------------------
// 设计参考 OpenUTAU 的钢琴卷帘：渲染层与交互层分离，音符区为单一交互画布。
// 本组件只负责「音符层」：网格 / 键盘 / 音符块 / 拖拽 / 框选 / 缩放 / 快捷键。
// 参数车道、音高曲线、音素条带等属于上层诉求，后续按 P2/P3 增量叠加。
//
// 用法（宿主传入响应式数据 + 变更回调，组件本身不直接依赖任何 store）：
//   <PianoRoll
//     :notes="store.sortedNotes" :selected-id="store.selectedId" :selected-ids="store.selectedIds"
//     :bpm="store.bpm" :api="rollApi" :note-label="n => n.lyric" @edit-lyric="onEditLyric" />
//
// api 需实现：
//   addNote(startBeat, pitch) -> id
//   updateNote(id, patch) / moveNotes(ids, dBeat, dPitch) / setNotesDuration(ids, durBeat)
//   removeNotes(ids) / setSelection(ids, primary) / pushUndo() / undo() / redo()
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../Icon.vue';
import { t } from '../../core/i18n.js';
import { derivePhonemes } from '../../core/phoneme.js';
import { laneViewOf } from '../../core/track_automation.js';

const props = defineProps({
  notes: { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  selectedIds: { type: Array, default: () => [] },
  bpm: { type: Number, default: 120 },
  api: { type: Object, required: true },
  noteLabel: { type: Function, default: (n) => n.lyric || '' },
  height: { type: Number, default: 320 },
  /** fill 模式：不写死视口高度，由宿主 flex 容器拉伸（卷帘占满剩余空间） */
  fill: { type: Boolean, default: false },
  canEdit: { type: Boolean, default: true },
  /* ---- 几何（供宿主对齐自带车道用，默认即通用编辑器的自适应布局） ---- */
  left: { type: Number, default: 46 },       // 左侧键盘列宽
  top: { type: Number, default: 18 },        // 顶部留白
  rowHeight: { type: Number, default: 14 },  // 初始行高
  beatWidth: { type: Number, default: 34 },  // 初始每拍像素
  pitchLo: { type: Number, default: null },  // 指定则固定音域（如 UTAU 的 C2..C7）
  pitchHi: { type: Number, default: null },
  showToolbar: { type: Boolean, default: true },
});
const emit = defineEmits(['edit-lyric']);

/* ---------------- 布局 ---------------- */
// 键盘列宽 / 顶部留白以 props 为准（挂载期固定，不随运行时变）
const LEFT = props.left;
const TOP = props.top;

const rowH = ref(props.rowHeight);   // 行高（音高半音），可被工具栏 ↕ 切换
const noteW = ref(props.beatWidth);  // 每拍像素（缩放）
const scrollX = ref(0);
const scrollY = ref(0);
const canvas = ref(null);
const wrap = ref(null);
const rootEl = ref(null);
const ctxOpen = ref(false);
const ctxX = ref(0), ctxY = ref(0), ctxOnNote = ref(false);
const ctxNoteId = ref(null);
const cursor = ref('default');
let ctx = null;
let cw = 0, ch = 0;       // 内容尺寸（绘制坐标语义，保持不变）
const vw = ref(0), vh = ref(0);   // 视口尺寸（backing 大小；不含滚动条，canvas 不遮挡滚动条）

/* 音高范围：以音符为中心自适应，至少 3 个八度 */
const pitchSpan = computed(() => {
  // 宿主指定了固定音域（如 UTAU 工作台的 C2..C7）则直接采用
  if (props.pitchLo != null && props.pitchHi != null && props.pitchHi > props.pitchLo) {
    return { lo: props.pitchLo, hi: props.pitchHi };
  }
  const list = props.notes;
  if (!list.length) return { lo: 48, hi: 72 };
  let lo = 127, hi = 0;
  for (const n of list) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
  lo = Math.max(0, lo - 6); hi = Math.min(127, hi + 6);
  while (hi - lo < 36) { if (lo > 0) lo--; else if (hi < 127) hi++; else break; }
  return { lo, hi };
});
const rows = computed(() => pitchSpan.value.hi - pitchSpan.value.lo + 1);
const totalBeats = computed(() => {
  let m = 0;
  for (const n of props.notes) m = Math.max(m, n.startBeat + n.durBeat);
  return Math.max(m + 8, 32);
});
const viewH = computed(() => TOP + rows.value * rowH.value + 8);
const viewW = computed(() => LEFT + totalBeats.value * noteW.value + 8);
/** 滚动范围总高：音符区 + 音素条带 + 曲线泳道（按开关叠加） */
const contentH = computed(() =>
  viewH.value + (showPhoneme.value ? PH_H : 0) + (pitchOn.value ? PI_H : 0));

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function pitchName(p) { return NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1); }

/* 坐标换算 */
function xOf(beat) { return LEFT + beat * noteW.value; }
function beatOf(x) { return (x - LEFT) / noteW.value; }
function yOf(pitch) { return TOP + (pitchSpan.value.hi - pitch) * rowH.value; }
function pitchOf(y) { return pitchSpan.value.hi - Math.floor((y - TOP) / rowH.value); }
function noteGeo(n) {
  const x = xOf(n.startBeat), w = Math.max(3, n.durBeat * noteW.value - 1);
  return { x, y: yOf(n.pitch), w, h: rowH.value - 1 };
}

/* ---------------- 吸附 ---------------- */
const snapOn = ref(true);
const snapDiv = ref(4);   // 1/4 拍
function snapBeat(b) {
  if (!snapOn.value) return Math.max(0, b);
  const step = 1 / snapDiv.value;
  return Math.max(0, Math.round(b / step) * step);
}

/* ---------------- 工具 ---------------- */
const tool = ref('select');  // select | pen

/* ---------------- 绘制 ---------------- */
function V(name) {
  try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || '#888'; } catch (e) { return '#888'; }
}
function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

function setupCanvas() {
  const c = canvas.value; if (!c) return;
  const el = wrap.value; if (!el) return;
  const dpr = window.devicePixelRatio || 1;
  // ★ backing = 视口尺寸（浏览器 canvas 单边 ~65535px 上限，全内容尺寸画布
  //   在长曲放大到一定程度时会创建失败 → 所有音符消失）。
  //   绘制仍用内容坐标，draw() 里 translate(-scrollX, -scrollY) 平移。
  //   clientWidth/Height 不含滚动条 → 滚动条露在外面可拖。
  vw.value = el.clientWidth; vh.value = el.clientHeight;
  cw = viewW.value; ch = viewH.value;
  c.width = Math.max(1, Math.round(vw.value * dpr)); c.height = Math.max(1, Math.round(vh.value * dpr));
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx = g;
}

function draw() {
  const c = canvas.value; if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  // 视口尺寸变化（容器拉伸/换页签）都要重建 backing
  if (c.width !== Math.max(1, Math.round(vw.value * dpr)) || c.height !== Math.max(1, Math.round(vh.value * dpr))) setupCanvas();
  if (!ctx) return;
  const g = ctx;
  const bg = V('--surface'), surfaceMuted = V('--surface-muted'), border = V('--border');
  const ink = V('--text'), muted = V('--text-muted'), brand = V('--brand'), grid = V('--grid');
  const onNote = V('--on-note'), noteFill = V('--note-fill');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, vw.value, vh.value);
  g.translate(-scrollX.value, -scrollY.value);   // 之后全部是内容坐标
  g.fillStyle = bg; g.fillRect(0, 0, cw, ch);

  // 键盘列 + 顶部标尺底色
  g.fillStyle = surfaceMuted; g.fillRect(0, 0, LEFT, ch); g.fillRect(0, 0, cw, TOP);

  // 音高行 + 键盘
  for (let p = pitchSpan.value.lo; p <= pitchSpan.value.hi; p++) {
    const y = yOf(p);
    const semi = ((p % 12) + 12) % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(semi);
    g.fillStyle = isBlack ? bg : surfaceMuted;
    g.fillRect(0, y, LEFT - 1, rowH.value);
    if (semi === 0) {
      g.fillStyle = ink; g.font = '9px system-ui, sans-serif'; g.textAlign = 'right';
      g.fillText(pitchName(p), LEFT - 5, y + rowH.value / 2 + 3);
    }
    g.strokeStyle = border; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, y + rowH.value + 0.5); g.lineTo(cw, y + rowH.value + 0.5); g.stroke();
  }

  // 拍线
  const beats = Math.ceil(totalBeats.value);
  for (let b = 0; b <= beats; b++) {
    const x = xOf(b);
    const isBar = b % 4 === 0;
    g.strokeStyle = isBar ? border : grid;
    g.lineWidth = isBar ? 1.2 : 0.6;
    g.beginPath(); g.moveTo(x + 0.5, TOP); g.lineTo(x + 0.5, ch); g.stroke();
    if (isBar) {
      g.fillStyle = muted; g.font = '9px system-ui, sans-serif'; g.textAlign = 'left';
      g.fillText(String(b / 4 + 1), x + 3, TOP - 5);
    }
  }

  // 音符
  const selSet = new Set(props.selectedIds);
  for (const n of props.notes) {
    const { x, y, w, h } = noteGeo(n);
    if (x + w < scrollX.value - 40 || x > scrollX.value + (wrap.value ? wrap.value.clientWidth : cw) + 40) continue;
    const sel = selSet.has(n.id);
    const primary = props.selectedId === n.id;
    g.fillStyle = sel ? brand : noteFill;
    g.strokeStyle = primary ? ink : (sel ? brand : V('--note-edge'));
    g.lineWidth = sel ? 1.6 : 0.8;
    roundRect(g, x, y, w, h, 3); g.fill(); g.stroke();

    const label = props.noteLabel ? props.noteLabel(n) : '';
    if (label && w > 8) {
      g.save(); g.beginPath(); g.rect(x + 1, y, w - 2, h); g.clip();
      g.fillStyle = onNote; g.font = '10px system-ui, sans-serif'; g.textAlign = 'left';
      g.fillText(String(label), x + 3, y + h / 2 + 3.5); g.restore();
    }
    // 右缘把手
    if (sel && w > 6) {
      g.fillStyle = onNote; g.globalAlpha = 0.7;
      g.fillRect(x + w - 3, y + 1, 2.5, h - 2);
      g.globalAlpha = 1;
    }
  }

  // 框选矩形
  if (drag && drag.mode === 'box') {
    const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
    const bw = Math.abs(drag.x1 - drag.x0), bh = Math.abs(drag.y1 - drag.y0);
    g.save();
    g.strokeStyle = brand; g.lineWidth = 1; g.setLineDash([4, 3]);
    g.fillStyle = 'rgba(127,127,127,0.12)';
    g.fillRect(x0, y0, bw, bh); g.strokeRect(x0 + 0.5, y0 + 0.5, bw, bh);
    g.restore();
  }

  // 音素条带与音符层同源重绘，保证始终对齐
  drawPhoneme();
  drawPitch();
}

/* ---------------- 交互 ----------------
   单画布三层（音符 / 音素条带 / 曲线泳道）：按内容 y 分发到对应层的处理函数。
   toXY 返回的是**内容坐标**（含滚动偏移），命中/绘制同域。 */
let drag = null;
const phTop = () => viewH.value;
const piTop = () => viewH.value + (showPhoneme.value ? PH_H : 0);
function toXY(e) {
  const r = canvas.value.getBoundingClientRect();
  return { x: e.clientX - r.left + scrollX.value, y: e.clientY - r.top + scrollY.value };
}
function hit(x, y) {
  for (let i = props.notes.length - 1; i >= 0; i--) {
    const n = props.notes[i];
    const geo = noteGeo(n);
    if (x >= geo.x && x <= geo.x + geo.w && y >= geo.y && y <= geo.y + geo.h) {
      const edge = Math.min(6, geo.w / 3);
      return { n, side: x >= geo.x + geo.w - edge ? 'r' : (x <= geo.x + edge ? 'l' : 'body') };
    }
  }
  return null;
}
/** pointerdown 入口：按内容 y 分发到 音符层 / 音素条带 / 曲线泳道 */
function onDown(e) {
  closeCtx();
  const r = canvas.value.getBoundingClientRect();
  const vx = e.clientX - r.left, vy = e.clientY - r.top;
  const cy = vy + scrollY.value;
  if (pitchOn.value && cy >= piTop()) return pDown(e, vx, cy - piTop());
  if (showPhoneme.value && cy >= phTop()) return phDown(e, vx);
  onNoteDown(e, vx, vy);
}
function onNoteDown(e, vx, vy) {
  const x = vx + scrollX.value, y = vy + scrollY.value;
  if (!props.canEdit) return;
  if (x < LEFT || y < TOP) return;
  const hitRes = hit(x, y);

  // 画笔工具：空白处拖出音符
  if (tool.value === 'pen' && !hitRes) {
    props.api.pushUndo();
    const id = props.api.addNote(snapBeat(beatOf(x)), pitchOf(y));
    props.api.setSelection([id], id);
    drag = { mode: 'create', id, b0: snapBeat(beatOf(x)), x0: x };
    try { canvas.value.setPointerCapture(e.pointerId); } catch (err) {}
    draw();
    return;
  }

  if (hitRes) {
    const { n, side } = hitRes;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    // 先算好本次拖拽要作用的集合：props 要到下一帧才更新，不能 setSelection 后立刻回读
    const prev = props.selectedIds.length ? props.selectedIds
      : (props.selectedId ? [props.selectedId] : []);
    let use, primary = n.id;
    if (additive) {
      use = prev.includes(n.id) ? prev.filter(i => i !== n.id) : [...prev, n.id];
    } else if (prev.includes(n.id)) {
      use = prev.slice();          // 点组内已选项：保持整组，便于整体拖动
    } else {
      use = [n.id];
    }
    props.api.setSelection(use, use.length ? primary : null);
    if (!use.length) { draw(); return; }   // 只是取消了唯一选中，不起拖拽
    props.api.pushUndo();
    drag = {
      mode: side === 'r' ? 'rresize' : side === 'l' ? 'lresize' : 'move',
      ids: use, x0: x, y0: y,
      orig: use.map(id => {
        const cur = props.notes.find(z => z.id === id) || n;
        return { id, b0: cur.startBeat, p0: cur.pitch, d0: cur.durBeat };
      }),
      snapshot: use.map(id => {
        const cur = props.notes.find(z => z.id === id) || n;
        return { id, b0: cur.startBeat, d0: cur.durBeat };
      }),
    };
  } else {
    // 上游语义（NoteSelectionEditState）：空白处左键按下 = 先取消全部选择，
    // 再进入框选；Ctrl/Shift = 追加模式（保留当前选择作为基准）。
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const prev = props.selectedIds.length ? props.selectedIds
      : (props.selectedId ? [props.selectedId] : []);
    if (!additive) props.api.setSelection([], null);
    drag = { mode: 'box', x0: x, y0: y, x1: x, y1: y, additive, baseIds: additive ? prev : [] };
  }
  try { canvas.value.setPointerCapture(e.pointerId); } catch (err) {}
  draw();
}

function onMove(e) {
  if (phDrag) return phMove(e);
  if (pDrag) return pMove(e);
  const r = canvas.value.getBoundingClientRect();
  const cy = (e.clientY - r.top) + scrollY.value;
  // 悬停在条带/泳道区：不给音符光标
  if ((showPhoneme.value || pitchOn.value) && cy >= phTop()) { cursor.value = 'default'; return; }
  const { x, y } = toXY(e);
  if (!drag) {
    const h = hit(x, y);
    cursor.value = !h ? (tool.value === 'pen' ? 'crosshair' : 'default')
      : (h.side === 'body' ? 'move' : 'ew-resize');
    return;
  }
  if (drag.mode === 'box') {
    drag.x1 = x; drag.y1 = y;
    // 实时预览（上游 TempSelectNotes 语义）：相交命中的音符即时高亮，
    // 选择不入撤销栈，直接 setSelection 是安全的。
    const x0 = Math.min(drag.x0, x), y0 = Math.min(drag.y0, y);
    const x1 = Math.max(drag.x0, x), y1 = Math.max(drag.y0, y);
    const ids = [];
    for (const n of props.notes) {
      const g = noteGeo(n);
      if (g.x < x1 && g.x + g.w > x0 && g.y < y1 && g.y + g.h > y0) ids.push(n.id);
    }
    const next = drag.additive ? Array.from(new Set([...drag.baseIds, ...ids])) : ids;
    props.api.setSelection(next, next[0] ?? null);
    return draw();
  }
  if (drag.mode === 'create') {
    const dur = Math.max(1 / snapDiv.value, snapBeat(drag.b0 + beatOf(x) - beatOf(drag.x0)));
    props.api.setNotesDuration([drag.id], dur);
    return draw();
  }
  if (drag.mode === 'move') {
    const dBeat = snapBeat(drag.orig[0].b0 + beatOf(x) - beatOf(drag.x0)) - drag.orig[0].b0;
    const dPitch = pitchOf(y) - pitchOf(drag.y0);
    for (const o of drag.orig) {
      props.api.updateNote(o.id, {
        startBeat: Math.max(0, o.b0 + dBeat),
        pitch: Math.max(0, Math.min(127, o.p0 + dPitch)),
      });
    }
    return draw();
  }
  if (drag.mode === 'rresize') {
    const d = snapBeat(beatOf(x) - beatOf(drag.x0));
    for (const o of drag.orig) props.api.updateNote(o.id, { durBeat: Math.max(1 / snapDiv.value, o.d0 + d) });
    return draw();
  }
  if (drag.mode === 'lresize') {
    const d = beatOf(x) - beatOf(drag.x0);
    for (const o of drag.snapshot) {
      const nb = Math.max(0, snapBeat(o.b0 + d));
      const shift = nb - o.b0;
      const nd = Math.max(1 / snapDiv.value, o.d0 - shift);
      props.api.updateNote(o.id, { startBeat: nb, durBeat: nd });
    }
    return draw();
  }
}

function onUp(e) {
  if (phDrag) return phUp();
  if (pDrag) return pUp();
  if (drag && drag.mode === 'box') {
    // 与 onMove 的实时预览同一套命中（水平相交），提交最终结果
    const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
    const x1 = Math.max(drag.x0, drag.x1), y1 = Math.max(drag.y0, drag.y1);
    const ids = [];
    for (const n of props.notes) {
      const g = noteGeo(n);
      if (g.x < x1 && g.x + g.w > x0 && g.y < y1 && g.y + g.h > y0) ids.push(n.id);
    }
    const next = drag.additive ? Array.from(new Set([...(drag.baseIds || []), ...ids])) : ids;
    props.api.setSelection(next, next[0] ?? null);
  }
  drag = null;
  draw();
}

function onDbl(e) {
  const { x, y } = toXY(e);
  const h = hit(x, y);
  if (h) { props.api.setSelection([h.n.id], h.n.id); emit('edit-lyric', h.n); return; }
}

function onCtx(e) {
  e.preventDefault();
  const { x, y } = toXY(e);
  const h = hit(x, y);
  ctxOnNote.value = !!h;
  ctxNoteId.value = h ? h.n.id : null;
  if (h && !props.selectedIds.includes(h.n.id)) props.api.setSelection([h.n.id], h.n.id);
  // 菜单是 .pr 的直接 absolute 子元素，坐标必须相对 .pr，而不是滚动容器 wrap
  const r = (rootEl.value && rootEl.value.getBoundingClientRect) ? rootEl.value.getBoundingClientRect() : wrap.value.getBoundingClientRect();
  ctxX.value = e.clientX - r.left; ctxY.value = e.clientY - r.top;
  ctxOpen.value = true;
}
function closeCtx() { ctxOpen.value = false; }

function onWheel(e) {
  // ★ 画布浮在滚动区上，wheel 不会再自然驱动 wrap → 这里手动接管
  e.preventDefault();
  const wrapEl = wrap.value; if (!wrapEl) return;
  if (e.ctrlKey || e.metaKey) {
    // 以光标为锚缩放：记下光标处的拍，缩放后把同一拍放回同一屏幕位置。
    const vx = e.clientX - wrapEl.getBoundingClientRect().left;
    zoomAt(e.deltaY < 0 ? 1.12 : 0.89, vx);
  } else if (e.shiftKey) {
    wrapEl.scrollLeft += e.deltaY;
  } else {
    wrapEl.scrollTop += e.deltaY;
    wrapEl.scrollLeft += e.deltaX;
  }
}

/** 以屏幕位置 anchorVx（相对视口左缘）为锚缩放 noteW。
 *  同一拍在缩放前后落在同一屏幕 x 上：scrollLeft' = beat·noteW' + LEFT − anchorVx。 */
function zoomAt(factor, anchorVx) {
  const wrapEl = wrap.value;
  if (!wrapEl) return;
  const oldW = noteW.value;
  const newW = Math.max(12, Math.min(120, oldW * factor));
  if (newW === oldW) return;
  const beat = (wrapEl.scrollLeft + anchorVx - LEFT) / oldW;
  noteW.value = newW;
  nextTick(() => {
    // 先按新宽度重建画布（scrollWidth 才会更新），再校正滚动位置
    setupCanvas();
    draw();
    wrapEl.scrollLeft = Math.max(0, beat * newW + LEFT - anchorVx);
  });
}
/** 工具栏 ± 按钮：以视口中心为锚缩放 */
function zoomAtCenter(factor) {
  const wrapEl = wrap.value;
  zoomAt(factor, wrapEl ? wrapEl.clientWidth / 2 : 0);
}

/* ---------------- 滚动 / 尺寸联动 ----------------
   画布是视口尺寸，滚动只改 translate 原点 + 重绘（rAF 合帧） */
let scrollRaf = 0;
function onScroll() {
  const el = wrap.value; if (!el) return;
  scrollX.value = el.scrollLeft;
  scrollY.value = el.scrollTop;
  if (!scrollRaf) {
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      draw();
    });
  }
}
function onResize() {
  setupCanvas();
  draw();
}
/** 容器尺寸/滚动条出现与否都会改 clientWidth → 跟踪重建画布 */
let wrapRO = null;

/* ---------------- 快捷键 ---------------- */
function onKey(e) {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const api = props.api;
  const ids = props.selectedIds.length ? props.selectedIds : (props.selectedId ? [props.selectedId] : []);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? api.redo() : api.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); api.redo(); return; }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); api.selectAll(); return; }
  if (!ids.length) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); api.pushUndo(); api.removeNotes(ids); return; }
  const step = 1 / snapDiv.value;
  if (e.key === 'ArrowLeft') { e.preventDefault(); api.pushUndo(); api.moveNotes(ids, -step, 0); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); api.pushUndo(); api.moveNotes(ids, step, 0); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); api.pushUndo(); api.moveNotes(ids, 0, 1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); api.pushUndo(); api.moveNotes(ids, 0, -1); }
}

/* ---------------- 音素条带（P2） ----------------
   参考 OpenUTAU 的 PhonemeCanvas：音素不画在音符内部，而是画在底部独立条带里，
   按「辅音→元音」分段显示并标注；标签碰撞时上下交错（raiseText）避免重叠。
   本条的 x 映射与音符画布共用 xOf()，且两者同处一个滚动容器 → 天然对齐。 */
const PH_H = 46;
const showPhoneme = ref(false);
try { showPhoneme.value = localStorage.getItem('fufumidi_roll_phoneme') === '1'; } catch (e) {}
/** 音素块命中数据（drawPhoneme 重建）：拖拽水平移动 = 改该音素的 offset */
let phHit = [];
let phDrag = null;   // { noteId, idx, startX, startOffMs }

function drawPhoneme() {
  if (!showPhoneme.value) return;
  const c = canvas.value; if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.max(1, Math.round(vw.value * dpr)) || c.height !== Math.max(1, Math.round(vh.value * dpr))) setupCanvas();
  const g = ctx; if (!g) return;
  // 画在主画布的音素层（内容顶 = viewH）：视口 backing + 平移到层内容坐标
  g.save();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.translate(-scrollX.value, viewH.value - scrollY.value);
  const surf = V('--surface'), muted = V('--surface-muted'), border = V('--border');
  const ink = V('--text'), dim = V('--text-muted'), brand = V('--brand'), grid = V('--grid');
  g.fillStyle = muted; g.fillRect(scrollX.value, 0, vw.value, PH_H);
  g.fillStyle = surf; g.fillRect(scrollX.value, 0, LEFT, PH_H);
  g.fillStyle = dim; g.font = '9px system-ui, sans-serif'; g.textAlign = 'right';
  g.fillText(t('音素'), LEFT - 6, PH_H / 2 + 3);

  // 拍线（与音符区一致，便于对齐阅读）
  for (let b = 0; b <= Math.ceil(totalBeats.value); b++) {
    const x = xOf(b); const isBar = b % 4 === 0;
    g.strokeStyle = isBar ? border : grid; g.lineWidth = isBar ? 1.2 : 0.6;
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, PH_H); g.stroke();
  }

  const selSet = new Set(props.selectedIds);
  const bandTop = 5, bandH = PH_H - 16;
  let lastTextEndX = -Infinity, raise = false;
  // 音素块的命中数据（拖拽改 offset 用；绘制时重建）
  phHit = [];
  const noteById = new Map(props.notes.map(n => [n.id, n]));
  for (const row of derivePhonemes(props.notes)) {
    const selected = selSet.has(row.noteId);
    const note = noteById.get(row.noteId);
    const overrides = (note && note.phonemeOverrides) || [];
    for (let itIdx = 0; itIdx < row.items.length; itIdx++) {
      const it = row.items[itIdx];
      // 音素覆写的起点偏移（ms → 拍；拖拽编辑的就是它，拖拽中用预览值）
      const ov = overrides.find(o => o && o.index === itIdx);
      let offMs = (ov && ov.offset) || 0;
      if (phDrag && phDrag.noteId === row.noteId && phDrag.idx === itIdx && phDrag.offMs != null) offMs = phDrag.offMs;
      const offBeat = (offMs / 1000) * (props.bpm / 60);
      const x0 = xOf(row.startBeat + it.t0 + offBeat);
      const x1 = xOf(row.startBeat + it.t1 + offBeat);
      const w = Math.max(2, x1 - x0) - 1;
      phHit.push({ noteId: row.noteId, idx: itIdx, x0, x1: x0 + w });
      if (x0 + w < scrollX.value - 60 || x0 > scrollX.value + (wrap.value ? wrap.value.clientWidth : cw) + 60) continue;
      // 分段块：辅音用强调底、元音用普通底
      g.fillStyle = selected ? brand : (it.cons ? V('--tint-strong') : V('--note-fill'));
      g.fillRect(x0, bandTop, w, bandH);
      g.strokeStyle = selected ? brand : V('--note-edge'); g.lineWidth = 1;
      g.strokeRect(x0 + 0.5, bandTop + 0.5, w, bandH);
      // 音素起点竖线（对应 OpenUTAU 的 position 线）；被覆写过的加粗提示
      g.strokeStyle = selected ? brand : ink;
      g.globalAlpha = 0.6; g.lineWidth = ov ? 2 : 1;
      g.beginPath(); g.moveTo(x0 + 0.5, bandTop); g.lineTo(x0 + 0.5, bandTop + bandH); g.stroke();
      g.globalAlpha = 1; g.lineWidth = 1;

      // 标签：窄处不画；碰撞则上下交错（复用 OpenUTAU 的 raiseText 思路）
      if (noteW.value > 20 && it.text) {
        g.font = '10px system-ui, sans-serif';
        const tw = g.measureText(it.text).width + 7;
        if (x0 < lastTextEndX) raise = !raise; else raise = false;
        const ty = raise ? 12 : PH_H - 3;
        g.fillStyle = surf; g.fillRect(x0 + 1, ty - 10, tw, 12);
        g.strokeStyle = border; g.lineWidth = 1; g.strokeRect(x0 + 1.5, ty - 9.5, tw, 12);
        g.fillStyle = ink; g.textAlign = 'left';
        g.fillText(it.text, x0 + 4, ty);
        lastTextEndX = x0 + tw + 2;
      }
    }
  }
  g.restore();
}

/* ---- 音素时间编辑：水平拖拽音素块 = 改该音素的 offset（ms，存 phonemeOverrides）---- */
function phDown(e, vx) {
  if (!showPhoneme.value || !props.canEdit) return;
  const x = vx + scrollX.value;
  const hit = phHit.find(h => x >= h.x0 - 2 && x <= h.x1 + 2);
  if (!hit) return;
  if (props.api && props.api.pushUndo) props.api.pushUndo();
  const note = (props.notes || []).find(n => n.id === hit.noteId);
  const cur = ((note && note.phonemeOverrides) || []).find(o => o && o.index === hit.idx);
  phDrag = { noteId: hit.noteId, idx: hit.idx, startX: e.clientX, startOffMs: (cur && cur.offset) || 0 };
  try { canvas.value.setPointerCapture(e.pointerId); } catch (err) {}
}
function phMove(e) {
  if (!phDrag) return;
  // 像素 → 拍 → ms：拖多少拍换算成毫秒偏移（以当前 BPM）
  const dBeat = (e.clientX - phDrag.startX) / Math.max(1, noteW.value);
  const off = Math.round(Math.max(-2000, Math.min(2000, phDrag.startOffMs + dBeat * 60000 / Math.max(1, props.bpm))));
  if (off !== phDrag.offMs) {
    phDrag.offMs = off;
    drawPhoneme();
  }
}
function phUp() {
  if (!phDrag) return;
  const d = phDrag; phDrag = null;
  if (d.offMs == null) return;                       // 没动过
  const note = (props.notes || []).find(n => n.id === d.noteId);
  if (!note || !props.api || !props.api.updateNote) return;
  // 合并进该音符的覆写表；offset 归零且无 delta 的条目直接移除
  const list = (note.phonemeOverrides || []).filter(o => o && o.index !== d.idx);
  if (d.offMs !== 0) list.push({ index: d.idx, offset: d.offMs });
  props.api.updateNote(d.noteId, { phonemeOverrides: list });
  drawPhoneme();
}

/* ---------------- 曲线泳道（PIT / DYN / BRE / GEN） ----------------
   参考 OpenUTAU 的曲线车道：车道内是「拍 → 参数值」的控制点折线，工具齐全
   （手绘 / 直线 / 正弦 / 平滑 / 移动控制点）。与音符、音素同处一个滚动容器，天然对齐。
   ★ 值域/刻度从 track_automation.laneViewOf 派生（DYN/BRE/GEN 仅 UTAU 轨可编辑，
     PIT 两边通用）；读写统一走 api.getCurvePoints / setCurvePoints ——
     PIT 经 store.setCurve 自动镜像 pitchCurve，渲染链路直接消费。 */
const PI_H = 92;
const LANE_DEFS = Object.fromEntries(
  ['PIT', 'DYN', 'BRE', 'GEN'].map((a) => [a, laneViewOf(a)]),
);
const pitchOn = ref(false);
try { pitchOn.value = localStorage.getItem('fufumidi_roll_pitch') === '1'; } catch (e) {}
watch(pitchOn, v => { try { localStorage.setItem('fufumidi_roll_pitch', v ? '1' : '0'); } catch (e) {} });
const activeLane = ref('PIT');
try { const l = localStorage.getItem('fufumidi_roll_lane'); if (LANE_DEFS[l]) activeLane.value = l; } catch (e) {}
watch(activeLane, v => { try { localStorage.setItem('fufumidi_roll_lane', v); } catch (e) {} });
/** 当前轨道可用的泳道：DYN/BRE/GEN 只有 UTAU 吃（引擎差异见 CURVE_TARGETS.engines） */
const laneAvail = computed(() => {
  const eng = (props.api && props.api.getEngine) ? props.api.getEngine() : 'utau';
  return eng === 'utau' ? ['PIT', 'DYN', 'BRE', 'GEN'] : ['PIT'];
});
watch(laneAvail, (list) => {
  if (!list.includes(activeLane.value)) activeLane.value = 'PIT';
});
const laneDef = computed(() => LANE_DEFS[activeLane.value] || LANE_DEFS.PIT);
const pitchTool = ref('draw');   // move | draw | line | sine | smooth
const pCurve = ref([]);
let pDrag = null;
let pitchBusy = false;
/** 参数值 → 泳道 y（显示窗口由 laneDef 决定；PIT ±200，其余全域） */
function yOfVal(v) {
  const half = PI_H / 2 - 6;
  const { dispMin, dispMax } = laneDef.value;
  const c = Math.max(dispMin, Math.min(dispMax, v));
  return PI_H / 2 - ((c - (dispMin + dispMax) / 2) / ((dispMax - dispMin) / 2)) * half;
}
function valOfY(y) {
  const half = PI_H / 2 - 6;
  const { dispMin, dispMax } = laneDef.value;
  const v = (PI_H / 2 - y) / half * ((dispMax - dispMin) / 2) + (dispMin + dispMax) / 2;
  return Math.round(Math.max(dispMin, Math.min(dispMax, v)));
}

function loadLane() {
  if (pitchBusy) return;
  const pts = (props.api && props.api.getCurvePoints) ? (props.api.getCurvePoints(activeLane.value) || []) : [];
  pCurve.value = pts.slice().sort((a, b) => a.beat - b.beat);
}
const pitchRev = computed(() => {
  const pts = (props.api && props.api.getCurvePoints) ? (props.api.getCurvePoints(activeLane.value) || []) : [];
  let s = pts.length;
  for (const p of pts) s += p.beat * 3 + p.value * 7;
  return s;
});

function upsertLanePoint(b, v) {
  const eps = 1 / 32;
  pCurve.value = pCurve.value.filter(p => Math.abs(p.beat - b) > eps);
  pCurve.value.push({ beat: b, value: v });
  pCurve.value.sort((a, x) => a.beat - x.beat);
  if (pCurve.value.length > 4000) pCurve.value = pCurve.value.filter((_, i) => i % 2 === 0);
}
function applyLineOrSine(d) {
  let b0 = Math.min(d.b0, d.b1), b1 = Math.max(d.b0, d.b1);
  let v0, v1;
  if (d.b0 <= d.b1) { v0 = d.v0; v1 = d.v1; } else { v0 = d.v1; v1 = d.v0; }
  if (b1 - b0 < 1 / 32) { upsertLanePoint(b0, v0); return; }
  const eps = 1 / 64;
  pCurve.value = pCurve.value.filter(p => p.beat < b0 - eps || p.beat > b1 + eps);
  const span = b1 - b0, step = 1 / 16;
  const cyc = Math.max(1, Math.round(span * 1.5));
  const amp = d.tool === 'sine' ? (v1 - v0) * 0.5 : 0;
  for (let t = 0; t <= span + 1e-9; t += step) {
    const frac = t / span;
    let v = v0 + (v1 - v0) * frac;
    if (d.tool === 'sine') v += amp * Math.sin(frac * Math.PI * 2 * cyc);
    pCurve.value.push({ beat: b0 + t, value: Math.round(v) });
  }
  pCurve.value.sort((a, x) => a.beat - x.beat);
}
function smoothLaneAt(b) {
  const win = 0.4;
  const pts = pCurve.value;
  for (let i = 1; i < pts.length - 1; i++) {
    if (Math.abs(pts[i].beat - b) <= win) pts[i].value = Math.round((pts[i - 1].value + pts[i].value + pts[i + 1].value) / 3);
  }
}

function drawPitch() {
  if (!pitchOn.value) return;
  const c = canvas.value; if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.max(1, Math.round(vw.value * dpr)) || c.height !== Math.max(1, Math.round(vh.value * dpr))) setupCanvas();
  const g = ctx; if (!g) return;
  // 画在主画布的泳道层（内容顶 = piTop）：视口 backing + 平移到层内容坐标
  g.save();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.translate(-scrollX.value, piTop() - scrollY.value);
  const surf = V('--surface'), muted = V('--surface-muted'), border = V('--border');
  const ink = V('--text'), dim = V('--text-muted'), brand = V('--brand'), grid = V('--grid');
  g.fillStyle = muted; g.fillRect(scrollX.value, 0, vw.value, PI_H);
  g.fillStyle = surf; g.fillRect(0, 0, LEFT, PI_H);
  g.fillStyle = dim; g.font = '9px system-ui, sans-serif'; g.textAlign = 'right';
  g.fillText(t(laneDef.value.label), LEFT - 6, PI_H / 2 + 3);

  // 刻度线（按泳道值域；0 线加粗）
  for (const cval of laneDef.value.ticks) {
    const y = yOfVal(cval);
    const isMid = cval === (laneDef.value.dispMin + laneDef.value.dispMax) / 2
      || (laneDef.value.dispMin < 0 && laneDef.value.dispMax > 0 && cval === 0);
    g.strokeStyle = isMid ? border : grid; g.lineWidth = isMid ? 1.2 : 0.6;
    g.beginPath(); g.moveTo(LEFT, y + 0.5); g.lineTo(cw, y + 0.5); g.stroke();
    g.fillStyle = dim; g.textAlign = 'right'; g.font = '8px system-ui, sans-serif';
    g.fillText(String(cval), LEFT - 3, y + 3);
  }
  for (let b = 0; b <= Math.ceil(totalBeats.value); b++) {
    const x = xOf(b); const isBar = b % 4 === 0;
    g.strokeStyle = isBar ? border : grid; g.lineWidth = isBar ? 1 : 0.5;
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, PI_H); g.stroke();
  }

  // 曲线折线
  const pts = pCurve.value;
  if (pts.length) {
    g.strokeStyle = brand; g.lineWidth = 1.6; g.beginPath();
    pts.forEach((p, i) => { const x = xOf(p.beat), y = yOfVal(p.value); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.fillStyle = ink;
    for (const p of pts) g.fillRect(xOf(p.beat) - 2, yOfVal(p.value) - 2, 4, 4);
  }

  // 直线 / 正弦拖拽预览
  if (pDrag && (pDrag.tool === 'line' || pDrag.tool === 'sine')) {
    const x0 = xOf(pDrag.b0), y0 = yOfVal(pDrag.v0), x1 = xOf(pDrag.b1), y1 = yOfVal(pDrag.v1);
    g.save(); g.strokeStyle = brand; g.setLineDash([4, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.setLineDash([]); g.restore();
    if (pDrag.tool === 'sine') {
      let a = Math.min(pDrag.b0, pDrag.b1), bb = Math.max(pDrag.b0, pDrag.b1);
      let va = pDrag.b0 <= pDrag.b1 ? pDrag.v0 : pDrag.v1, vb = pDrag.b0 <= pDrag.b1 ? pDrag.v1 : pDrag.v0;
      const span = bb - a; if (span >= 1 / 32) {
        const cyc = Math.max(1, Math.round(span * 1.5));
        const amp = (vb - va) * 0.5;
        g.strokeStyle = brand; g.lineWidth = 1; g.beginPath();
        for (let t2 = 0; t2 <= span + 1e-9; t2 += 1 / 32) {
          const frac = t2 / span;
          const y = yOfVal(va + (vb - va) * frac + amp * Math.sin(frac * Math.PI * 2 * cyc));
          const x = xOf(a + t2);
          t2 === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
      }
    }
  }
  g.restore();
}

function pDown(e, vx, ly) {
  if (!pitchOn.value || !props.canEdit) return;
  const x = vx + scrollX.value, y = ly;
  if (x < LEFT) return;
  if (props.api && props.api.pushUndo) props.api.pushUndo();
  pitchBusy = true;
  loadLane();
  const b = snapBeat(beatOf(x)), v = valOfY(y);
  if (pitchTool.value === 'move') {
    let best = -1, bd = 9;
    pCurve.value.forEach((p, i) => { const d = Math.hypot(xOf(p.beat) - x, yOfVal(p.value) - y); if (d < bd) { bd = d; best = i; } });
    if (best < 0) { pitchBusy = false; return; }
    pDrag = { tool: 'move', idx: best };
  } else {
    pDrag = { tool: pitchTool.value, b0: b, v0: v, b1: b, v1: v };
    if (pitchTool.value === 'draw') upsertLanePoint(b, v);
    else if (pitchTool.value === 'smooth') smoothLaneAt(b);
  }
  try { canvas.value.setPointerCapture(e.pointerId); } catch (err) {}
  drawPitch();
}
function pMove(e) {
  if (!pDrag) return;
  const r = canvas.value.getBoundingClientRect();
  const x = e.clientX - r.left + scrollX.value;
  const y = (e.clientY - r.top) + scrollY.value - piTop();
  const b = snapBeat(beatOf(x)), v = valOfY(y);
  if (pDrag.tool === 'draw') upsertLanePoint(b, v);
  else if (pDrag.tool === 'smooth') smoothLaneAt(b);
  else if (pDrag.tool === 'move') { const p = pCurve.value[pDrag.idx]; if (p) { p.beat = b; p.value = v; pCurve.value.sort((a, z) => a.beat - z.beat); } }
  else { pDrag.b1 = b; pDrag.v1 = v; }
  drawPitch();
}
function pUp() {
  if (!pDrag) return;
  if (pDrag.tool === 'line' || pDrag.tool === 'sine') applyLineOrSine(pDrag);
  pDrag = null;
  pitchBusy = false;
  if (props.api && props.api.setCurvePoints) props.api.setCurvePoints(activeLane.value, pCurve.value.slice());
  drawPitch();
}
function clearPitch() {
  if (props.api && props.api.pushUndo) props.api.pushUndo();
  pCurve.value = [];
  if (props.api && props.api.setCurvePoints) props.api.setCurvePoints(activeLane.value, []);
  drawPitch();
}

/* ---------------- 重绘触发 ---------------- */
const rev = computed(() => {
  let s = props.notes.length;
  for (const n of props.notes) s += n.startBeat * 3 + n.durBeat * 7 + n.pitch * 11;
  return s;
});
const selRev = computed(() => props.selectedIds.join(',') + '|' + props.selectedId);
// 歌词变化也要重绘音素条带（音素由歌词派生）
const lyricRev = computed(() => {
  let s = 0;
  for (const n of props.notes) s += String(n.lyric || '').length * 13;
  return s;
});
watch([rev, selRev, lyricRev, () => props.bpm, pitchSpan], () => nextTick(draw));
watch([noteW, rowH, showPhoneme, pitchOn], () => nextTick(() => { setupCanvas(); draw(); }));
watch(pitchRev, () => { loadLane(); nextTick(drawPitch); });
watch(activeLane, () => { loadLane(); nextTick(drawPitch); });
watch(showPhoneme, v => { try { localStorage.setItem('fufumidi_roll_phoneme', v ? '1' : '0'); } catch (e) {} });

onMounted(() => {
  setupCanvas(); draw();
  loadLane();
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver !== 'undefined' && wrap.value) {
    wrapRO = new ResizeObserver(() => onResize());
    wrapRO.observe(wrap.value);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onResize);
  if (wrapRO) { wrapRO.disconnect(); wrapRO = null; }
  if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
});

/* 供宿主（如 UTAU 工作台的自定义车道）对齐几何与滚动：
   车道画布用 xOf/beatOf 换算、读 wrap 同步横向滚动即可 */
defineExpose({
  draw, setupCanvas,
  noteW, rowH, pitchSpan, totalBeats,
  xOf, beatOf, yOf, pitchOf,
  scrollEl: wrap,
});
</script>

<template>
  <div ref="rootEl" class="pr" :class="{ 'pr-fill': fill }">
    <!-- 工具栏（宿主自带工具条时可关掉） -->
    <div v-if="showToolbar" class="pr-bar">
      <div class="pr-tools">
        <button class="pr-tool" :class="{ on: tool === 'select' }" :title="t('选择 / 框选 / 拖动')" @click="tool = 'select'"><Icon name="edit" :size="13" /> {{ t('选择') }}</button>
        <button class="pr-tool" :class="{ on: tool === 'pen' }" :title="t('在空白处拖出音符')" @click="tool = 'pen'"><Icon name="plus" :size="13" /> {{ t('画笔') }}</button>
      </div>
      <label class="pr-ad">
        <input type="checkbox" v-model="snapOn" /> {{ t('吸附') }}
        <select v-model.number="snapDiv" :disabled="!snapOn">
          <option :value="1">1/4</option>
          <option :value="2">1/8</option>
          <option :value="4">1/16</option>
          <option :value="8">1/32</option>
        </select>
      </label>
      <label class="pr-ad" :title="t('底部条带显示音素切分（辅音 → 元音）')">
        <input type="checkbox" v-model="showPhoneme" /> {{ t('音素') }}
      </label>
      <label class="pr-ad" :title="t('底部车道显示音高微调曲线（手绘/直线/正弦/平滑）')">
        <input type="checkbox" v-model="pitchOn" /> {{ t('音高') }}
      </label>
      <span class="pr-zoom">
        <button class="pr-mini" :title="t('缩小')" @click="zoomAtCenter(0.85)">−</button>
        <button class="pr-mini" :title="t('放大')" @click="zoomAtCenter(1.18)">+</button>
        <button class="pr-mini" :title="t('行高')" @click="rowH = rowH >= 18 ? 12 : rowH + 3">↕</button>
      </span>
      <span class="pr-hint">{{ t('滚轮+Ctrl 缩放 · Shift+滚轮 平移 · 双击改歌词 · 方向键微调 · Ctrl+Z 撤销') }}</span>
    </div>

    <!-- 曲线泳道工具行（仅在打开泳道时显示） -->
    <Transition name="fade">
    <div v-if="showToolbar && pitchOn" class="pr-bar pr-bar-pitch">
      <label class="pr-ad" :title="t('选择要编辑的参数曲线')">
        <select class="select-input" v-model="activeLane">
          <option v-for="l in laneAvail" :key="l" :value="l">{{ t(LANE_DEFS[l].label) }}</option>
        </select>
      </label>
      <div class="pr-tools">
        <button class="pr-tool" :class="{ on: pitchTool === 'move' }" :title="t('拖动控制点')" @click="pitchTool = 'move'">⌖ {{ t('移动') }}</button>
        <button class="pr-tool" :class="{ on: pitchTool === 'draw' }" :title="t('按住拖出曲线')" @click="pitchTool = 'draw'">✎ {{ t('手绘') }}</button>
        <button class="pr-tool" :class="{ on: pitchTool === 'line' }" :title="t('从 A 拖到 B 画直线')" @click="pitchTool = 'line'">╱ {{ t('直线') }}</button>
        <button class="pr-tool" :class="{ on: pitchTool === 'sine' }" :title="t('从 A 拖到 B 画正弦波')" @click="pitchTool = 'sine'">∿ {{ t('正弦') }}</button>
        <button class="pr-tool" :class="{ on: pitchTool === 'smooth' }" :title="t('按住拖动以平滑局部')" @click="pitchTool = 'smooth'">∼ {{ t('平滑') }}</button>
        <button class="pr-tool" :title="t('清空当前曲线')" @click="clearPitch">✕ {{ t('清空') }}</button>
      </div>
    </div>
    </Transition>

    <!-- 画布：spacer 撑出滚动范围，视口尺寸的画布浮在其上（内容坐标经 translate 对齐） -->
    <div class="pr-body">
      <div ref="wrap" class="pr-scroll" :style="fill ? {} : { height: height + 'px' }" @scroll="onScroll">
        <div class="pr-spacer" :style="{ width: viewW + 'px', height: contentH + 'px' }"></div>
      </div>
      <canvas ref="canvas" class="pr-vp" :style="{ cursor, width: vw + 'px', height: vh + 'px' }"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
        @dblclick="onDbl" @contextmenu="onCtx" @wheel="onWheel"></canvas>
    </div>

    <!-- 右键菜单 -->
    <Transition name="ctxmenu">
      <div v-if="ctxOpen" class="pr-ctx" :style="{ left: ctxX + 'px', top: ctxY + 'px' }" @pointerdown.stop @contextmenu.prevent>
        <button class="pr-ctx-i" :disabled="!ctxOnNote" @click="props.api.undo(); closeCtx()"><Icon name="undo" :size="13" /> {{ t('撤销') }}</button>
        <button class="pr-ctx-i" :disabled="!ctxOnNote" @click="props.api.redo(); closeCtx()"><Icon name="redo" :size="13" /> {{ t('重做') }}</button>
        <div class="pr-ctx-sep"></div>
        <button class="pr-ctx-i" :disabled="!ctxOnNote" @click="emit('edit-lyric', notes.find(n => n.id === ctxNoteId)); closeCtx()">{{ t('编辑歌词') }}</button>
        <button class="pr-ctx-i" :disabled="!ctxOnNote" @click="props.api.pushUndo(); props.api.removeNotes(selectedIds.length ? selectedIds : [ctxNoteId]); closeCtx()">{{ t('删除') }}</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.pr { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface); }
/* fill 模式（对齐上游 Height="*"）：组件吃掉宿主 flex 容器的剩余空间，泳道内滚动 */
.pr-fill { flex: 1; min-height: 0; }
.pr-fill .pr-body { flex: 1; min-height: 60px; }
.pr-body { position: relative; min-height: 0; }
.pr-scroll { overflow: auto; background: var(--surface); height: 100%; }
.pr-spacer { position: relative; }
/* 视口尺寸画布：浮在滚动区之上，内容坐标经 translate 对齐 */
.pr-vp { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: block; }
.pr-bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; flex-wrap: wrap; border-bottom: 1px solid var(--border); background: var(--surface-muted); }
.pr-tools { display: inline-flex; gap: 4px; }
.pr-tool { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: var(--stone); font-size: 12px; cursor: pointer; }
.pr-tool:hover { background: var(--surface); color: var(--ink); }
.pr-tool.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-text); }
.pr-ad { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--stone); }
.pr-ad select { height: 24px; font-size: 11.5px; padding: 0 4px; }
.pr-bar-pitch { padding-top: 0; border-top: 0; }
.pr-zoom { display: inline-flex; gap: 3px; }
.pr-mini { width: 24px; height: 24px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--stone); cursor: pointer; line-height: 1; }
.pr-mini:hover { background: var(--surface); color: var(--ink); }
.pr-hint { margin-left: auto; font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-scroll { overflow: auto; background: var(--surface); height: 100%; }
.pr-vp { position: absolute; top: 0; left: 0; display: block; }
.pr-ctx { position: absolute; z-index: 40; min-width: 132px; padding: 4px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.pr-ctx-i { display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--ink); font-size: 12.5px; text-align: left; cursor: pointer; }
.pr-ctx-i:hover:not(:disabled) { background: var(--surface-muted); }
.pr-ctx-i:disabled { opacity: .4; cursor: not-allowed; }
.pr-ctx-sep { height: 1px; margin: 4px 2px; background: var(--border); }
.ctxmenu-enter-active, .ctxmenu-leave-active { transition: opacity .1s, transform .1s; }
.ctxmenu-enter-from, .ctxmenu-leave-to { opacity: 0; transform: scale(.96); }
</style>

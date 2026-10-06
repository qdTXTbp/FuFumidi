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

const props = defineProps({
  notes: { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  selectedIds: { type: Array, default: () => [] },
  bpm: { type: Number, default: 120 },
  api: { type: Object, required: true },
  noteLabel: { type: Function, default: (n) => n.lyric || '' },
  /**
   * 卷帘可视高度（px）。`fill: true` 时忽略它，改为**跟着父容器**长。
   *
   * ★ 为什么要 fill：固定 320px 在 1440p 屏上只占编辑区的一小块（用户实测反馈
   *   「音符视图面积太小」），而编辑器给卷帘留的高度是随窗口/面板变化的。
   */
  height: { type: Number, default: 320 },
  /** 占满父容器（父容器必须有确定高度，例如 flex:1 的盒子）；行高按可用高度自适应 */
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
  /* ---- P2-1：播放头（宿主给拍位，卷帘只负责画线与"在播放头切分/粘贴"）---- */
  playheadBeat: { type: Number, default: -1 },
  /* ---- P2-1：音阶高亮 { root: 0..11, type: 'major'|'minor'|'chromatic' }，null = 关 ---- */
  scale: { type: Object, default: null },
  /* ---- P2-3：每小节几拍（由工程拍号换算而来；只影响小节线与编号）---- */
  beatsPerBar: { type: Number, default: 4 },
  /* ---- P2-2：当前选中的音素 { noteId, index }，用于在条带上高亮 ---- */
  selPhoneme: { type: Object, default: null },
  /* ---- 多轨叠置（ghost notes）----
     `tracks`: [{ id, name, color, notes, hidden }]，**含当前轨**；顺序即绘制顺序。
     `activeTrackId` 那条轨正常绘制（可编辑），其余画成半透明「幽灵音符」——
     对着别的声部写和声/对词时，这是唯一能看清「我这条跟它对没对上」的办法
     （FL Studio 的 ghost notes、Ableton 的多片段编辑都是这个思路）。
     `overlay=false` 时只画当前轨（老行为）。 */
  tracks: { type: Array, default: () => [] },
  activeTrackId: { type: String, default: '' },
  overlay: { type: Boolean, default: true },
  /** 幽灵音符上是否也画歌词（对词时有用；窄音符自动省略） */
  ghostLabels: { type: Boolean, default: true },
  /* ---- P2-4：参数车道（自动化曲线）
     { abbr, label, unit, min, max, def, points: [{beat, value}] }；null = 不显示车道。
     宿主决定"什么时候给"（例如只在打开自动化页签时给），组件不猜。 */
  automation: { type: Object, default: null },
});
const emit = defineEmits(['edit-lyric', 'set-scale', 'set-scale-root', 'edit-phoneme',
  'set-automation', 'automation-begin',
  // 点到了别的轨的音符：宿主据此把那条轨切成当前轨，并把该音符选上
  'pick-note']);

/** 幽灵层：除当前轨以外、可见且有音符的那些轨 */
const ghostTracks = computed(() => {
  if (!props.overlay) return [];
  return (props.tracks || []).filter((t) => t && t.id !== props.activeTrackId
    && !t.hidden && Array.isArray(t.notes) && t.notes.length);
});

/* ---------------- 布局 ---------------- */
// 键盘列宽 / 顶部留白以 props 为准（挂载期固定，不随运行时变）
const LEFT = props.left;
const TOP = props.top;

const rowH = ref(props.rowHeight);   // 行高（音高半音），可被工具栏 ↕ 切换
const noteW = ref(props.beatWidth);  // 每拍像素（缩放）
/* 缩放上下限：下限要能装下整首歌的总览（见 fitView），上限够看清 1/32 音符 */
const MIN_NOTE_W = 1.2;
const MAX_NOTE_W = 160;
const scrollX = ref(0);
const canvas = ref(null);
const wrap = ref(null);
const rootEl = ref(null);
const ctxOpen = ref(false);
const ctxX = ref(0), ctxY = ref(0), ctxOnNote = ref(false);
const ctxNoteId = ref(null);
const cursor = ref('default');
let ctx = null;
let cw = 0, ch = 0;

/* 音高范围：以音符为中心自适应，至少 3 个八度 */
const pitchSpan = computed(() => {
  // 宿主指定了固定音域（如 UTAU 工作台的 C2..C7）则直接采用
  if (props.pitchLo != null && props.pitchHi != null && props.pitchHi > props.pitchLo) {
    return { lo: props.pitchLo, hi: props.pitchHi };
  }
  // ★ 叠置时音域要**连同幽灵轨一起**算：只按当前轨自适应的话，别的声部会被画到画布外
  //   （看起来像「叠置没生效」）。
  const list = props.notes;
  const ghosts = ghostTracks.value;
  if (!list.length && !ghosts.length) return { lo: 48, hi: 72 };
  let lo = 127, hi = 0;
  for (const n of list) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
  for (const t of ghosts) for (const n of t.notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
  lo = Math.max(0, lo - 6); hi = Math.min(127, hi + 6);
  while (hi - lo < 36) { if (lo > 0) lo--; else if (hi < 127) hi++; else break; }
  return { lo, hi };
});
const rows = computed(() => pitchSpan.value.hi - pitchSpan.value.lo + 1);
const totalBeats = computed(() => {
  let m = 0;
  for (const n of props.notes) m = Math.max(m, n.startBeat + n.durBeat);
  // 叠置时按最长的轨算总长（同理：别把别的声部截掉）
  for (const t of ghostTracks.value) for (const n of t.notes) m = Math.max(m, n.startBeat + n.durBeat);
  return Math.max(m + 8, 32);
});
const viewH = computed(() => TOP + rows.value * rowH.value + 8);

/* ---------------- 占满父容器（fill） ----------------
   ★ 关键取舍：纵向**不无条件铺满**。音域可能是 5 个八度（60 行），硬铺满会把行高压到
     2~3px，音符变成一条线；所以行高在 [ROW_MIN, ROW_MAX] 之间自适应，超出就照常纵向滚动。 */
const ROW_MIN = 9;   // 低于 9px 就分不清上下邻音了
const ROW_MAX = 34;
const fluid = computed(() => props.fill || props.height <= 0);
let ro = null;
function applyFluidHeight() {
  if (!fluid.value) return;
  const el = wrap.value;
  if (!el) return;
  const avail = Math.max(80, el.clientHeight - TOP - 8);
  const next = Math.max(ROW_MIN, Math.min(ROW_MAX, avail / Math.max(1, rows.value)));
  if (Math.abs(next - rowH.value) < 0.01) return;
  rowH.value = next;
  nextTick(() => { setupCanvas(); draw(); });
}
const viewW = computed(() => LEFT + totalBeats.value * noteW.value + 8);

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
/* ---------------- 音阶高亮（P2-1） ----------------
   写旋律时最常犯的错是"手滑画到调外音"，而半音行本身很难一眼分辨。
   这里只做**视觉分区**（调内行提亮、调外行压暗），不改任何数据。 */
const SCALE_SETS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const scaleSet = computed(() => {
  const s = props.scale;
  if (!s || !s.type) return null;
  const set = SCALE_SETS[s.type];
  if (!set) return null;
  const root = ((Number(s.root) || 0) % 12 + 12) % 12;
  return new Set(set.map((x) => (x + root) % 12));
});
function inScale(pitch) {
  const set = scaleSet.value;
  if (!set) return true;
  return set.has(((pitch % 12) + 12) % 12);
}

function snapBeat(b) {
  if (!snapOn.value) return Math.max(0, b);
  const step = 1 / snapDiv.value;
  return Math.max(0, Math.round(b / step) * step);
}

/* ---------------- 工具 ---------------- */
const tool = ref('select');  // select | pen

/** 每小节几拍（P2-3）：三处小节线必须用同一个值，否则上下会对不齐 */
function perBarFor(v) { return Math.max(1, Math.round(Number(v)) || 4); }

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
  const dpr = window.devicePixelRatio || 1;
  cw = viewW.value; ch = viewH.value;
  c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
  c.style.width = cw + 'px'; c.style.height = ch + 'px';
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx = g;
}

function draw() {
  const c = canvas.value; if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  // 宽或高任一变化都要重建（行高/音域变化只影响高度，漏判会导致底部残影）
  if (c.width !== Math.round(viewW.value * dpr) || c.height !== Math.round(viewH.value * dpr)) setupCanvas();
  if (!ctx) return;
  const g = ctx;
  const bg = V('--surface'), surfaceMuted = V('--surface-muted'), border = V('--border');
  const ink = V('--text'), muted = V('--text-muted'), brand = V('--brand'), grid = V('--grid');
  const onNote = V('--on-note'), noteFill = V('--note-fill');
  g.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  g.clearRect(0, 0, cw, ch);
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
    // 调外音行压暗（音阶高亮，P2-1）：只影响音符区，键盘列不动
    if (scaleSet.value && !inScale(p)) {
      g.fillStyle = 'rgba(20,20,28,0.10)';
      g.fillRect(LEFT, y, cw - LEFT, rowH.value);
    }
  }

  // 拍线
  const beats = Math.ceil(totalBeats.value);
  const perBar = perBarFor(props.beatsPerBar);
  for (let b = 0; b <= beats; b++) {
    const x = xOf(b);
    const isBar = b % perBar === 0;
    g.strokeStyle = isBar ? border : grid;
    g.lineWidth = isBar ? 1.2 : 0.6;
    g.beginPath(); g.moveTo(x + 0.5, TOP); g.lineTo(x + 0.5, ch); g.stroke();
    if (isBar) {
      g.fillStyle = muted; g.font = '9px system-ui, sans-serif'; g.textAlign = 'left';
      g.fillText(String(b / perBar + 1), x + 3, TOP - 5);
    }
  }

  // ---- 幽灵音符（其它声部）--------------------------------------------------
  // 画在当前轨**下面**、网格**上面**：半透明 + 细描边，够看清对齐关系，又不会
  // 抢当前轨的注意力。不画选中态、不画把手 —— 它们不可直接编辑（点一下会切轨）。
  const gx0 = scrollX.value - 40, gx1 = scrollX.value + (wrap.value ? wrap.value.clientWidth : cw) + 40;
  for (const t of ghostTracks.value) {
    const col = t.color || V('--note-fill');
    g.save();
    g.globalAlpha = 0.30 * ghostFade.value;
    g.fillStyle = col;
    g.strokeStyle = col;
    g.lineWidth = 1;
    for (const n of t.notes) {
      const { x, y, w, h } = noteGeo(n);
      if (x + w < gx0 || x > gx1) continue;
      roundRect(g, x, y, w, h, 3); g.fill(); g.stroke();
      if (props.ghostLabels && w > 14) {
        const lab = props.noteLabel ? props.noteLabel(n) : '';
        if (lab) {
          g.save(); g.beginPath(); g.rect(x + 1, y, w - 2, h); g.clip();
          g.globalAlpha = 0.75; g.fillStyle = V('--text');
          g.font = '10px system-ui, sans-serif'; g.textAlign = 'left';
          g.fillText(String(lab), x + 3, y + h / 2 + 3.5); g.restore();
        }
      }
    }
    g.restore();
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

  // 播放头（P2-1）：一条竖线标出"现在播到哪/将从哪开始"，切分与粘贴都以它为准
  if (props.playheadBeat >= 0) {
    const phx = xOf(props.playheadBeat);
    if (phx >= LEFT - 1 && phx <= cw) {
      g.save();
      g.strokeStyle = V('--brand-coral'); g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(phx + 0.5, TOP); g.lineTo(phx + 0.5, ch); g.stroke();
      g.fillStyle = V('--brand-coral');
      g.beginPath(); g.moveTo(phx - 4, TOP); g.lineTo(phx + 4, TOP); g.lineTo(phx, TOP + 6); g.closePath(); g.fill();
      g.restore();
    }
  }

  // 音素条带 / 参数车道 / 音高车道都与音符层同源重绘，保证始终对齐
  drawPhoneme();
  drawAuto();
  drawPitch();
}

/* ---------------- 交互 ---------------- */
let drag = null;
function toXY(e) {
  const r = canvas.value.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
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
  // 幽灵层：**后画的在上面**，所以倒着找；命中只用来切轨，不进入编辑拖拽
  const ghosts = ghostTracks.value;
  for (let ti = ghosts.length - 1; ti >= 0; ti--) {
    const t = ghosts[ti];
    for (let i = t.notes.length - 1; i >= 0; i--) {
      const n = t.notes[i];
      const geo = noteGeo(n);
      if (x >= geo.x && x <= geo.x + geo.w && y >= geo.y && y <= geo.y + geo.h) {
        return { n, side: 'body', ghost: true, trackId: t.id };
      }
    }
  }
  return null;
}
function onDown(e) {
  if (!props.canEdit) return;
  closeCtx();
  const { x, y } = toXY(e);
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

  if (hitRes && hitRes.ghost) {
    // ★ 多轨叠置下「点别人的音符」= 我要编辑那条轨：切过去并把该音符选上。
    //   不在这里直接改数据 —— 当前轨的 api 只认自己的音符 id，跨轨编辑必须宿主先换轨。
    emit('pick-note', { trackId: hitRes.trackId, noteId: hitRes.n.id });
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
    drag = { mode: 'box', x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey };
  }
  try { canvas.value.setPointerCapture(e.pointerId); } catch (err) {}
  draw();
}

function onMove(e) {
  const { x, y } = toXY(e);
  if (!drag) {
    const h = hit(x, y);
    cursor.value = !h ? (tool.value === 'pen' ? 'crosshair' : 'default')
      : (h.ghost ? 'pointer' : (h.side === 'body' ? 'move' : 'ew-resize'));
    return;
  }
  if (drag.mode === 'box') { drag.x1 = x; drag.y1 = y; return draw(); }
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

function onUp() {
  if (drag && drag.mode === 'box') {
    const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
    const x1 = Math.max(drag.x0, drag.x1), y1 = Math.max(drag.y0, drag.y1);
    /* 框选（M8d）：以前只遍历当前轨的 `props.notes` —— 于是"跨轨框选"根本不存在。
       现在叠加显示（overlay）打开时，**幽灵音符也在框选范围内**：框到的别的轨音符会被加进选区，
       随后就能用批量工具一起处理（选区数据层已经跨轨，见 stores/singer.ts 的 selectedNotes）。
       拖动仍不支持跨轨（编辑 api 按当前轨注入），但"选中后批量改"这条路已经通了。 */
    const ids = [];
    for (const n of props.notes) {
      const g = noteGeo(n);
      if (g.x < x1 && g.x + g.w > x0 && g.y < y1 && g.y + g.h > y0) ids.push(n.id);
    }
    /* ⚠ 跨轨框选（M8d 第三块）**已回退**：本机验收工装驱动不了卷帘的框选
       （真实鼠标拖拽、合成 PointerEvent 都试过，连"只框当前轨"的基线都是 0 选中），
       于是这段代码无法被证明可用；而它一旦在 `onUp` 里抛错，会连带**破坏所有人的框选**。
       按项目既定标准（不留未验证的改动）先撤掉，等验收工装能驱动卷帘后再上。
       参考：`store.selectedNotes` 的跨轨选区与幽灵点击加选**都已验证可用**（见计划书附录 T）。 */
    const prev = props.selectedIds;
    const next = drag.additive ? Array.from(new Set([...prev, ...ids])) : ids;
    props.api.setSelection(next, next[0] ?? null);
  }
  drag = null;
  draw();
}

function onDbl(e) {
  const g0 = toXY(e);
  const gh = g0.x >= LEFT && g0.y >= TOP ? hit(g0.x, g0.y) : null;
  if (gh && gh.ghost) { emit('pick-note', { trackId: gh.trackId, noteId: gh.n.id }); return; }
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
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    noteW.value = Math.max(MIN_NOTE_W, Math.min(MAX_NOTE_W, noteW.value * (e.deltaY < 0 ? 1.12 : 0.89)));
    nextTick(draw);
  } else if (e.shiftKey) {
    e.preventDefault();
    wrap.value.scrollLeft += e.deltaY;
  }
}

/* ---------------- 剪贴板 / 切分 / 合并（P2-1） ----------------
   OpenUTAU 里"复制一小节再挪到下一段"是最常用的编辑动作，而此前卷帘只能一个一个
   音符改 —— 这里把整套补齐：Ctrl+C/X/V/D 复制/剪切/粘贴/重复，Ctrl+E 在播放头切分，
   Ctrl+M 合并同音高相邻音符。所有写入都先 pushUndo()，一次操作 = 一步撤销。 */
const clip = ref([]);                 // 剪贴板（相对最小 startBeat 的偏移量）
const CLIP_KEYS = ['pitch', 'durBeat', 'lyric', 'velocity', 'volume', 'flags', 'params',
  'gender', 'breath', 'dyn', 'atk', 'dec', 'shft', 'clr', 'pitchOffset',
  'vibrato', 'vibDepth', 'vibFreq', 'vibFade', 'phExpressions'];

function selIds() {
  return props.selectedIds.length ? props.selectedIds : (props.selectedId ? [props.selectedId] : []);
}
/** 把选中的音符拷进剪贴板（坐标归一到最早的起点，粘贴时再按目标位置落） */
function copySelection(cut = false) {
  const ids = selIds();
  const picked = props.notes.filter((n) => ids.includes(n.id));
  if (!picked.length) return 0;
  const base = Math.min(...picked.map((n) => n.startBeat));
  clip.value = picked.map((n) => {
    const o = { _beat: n.startBeat - base };
    for (const k of CLIP_KEYS) if (n[k] !== undefined) o[k] = JSON.parse(JSON.stringify(n[k]));
    return o;
  });
  if (cut) { props.api.pushUndo(); props.api.removeNotes(ids); }
  return clip.value.length;
}
/** 粘贴到播放头（没有播放头就贴在原处再往右挪一个剪贴板宽度） */
function pasteClipboard(atBeat) {
  const items = clip.value;
  if (!items.length) return 0;
  const span = Math.max(...items.map((o) => o._beat + (o.durBeat || 1)));
  let base = atBeat;
  if (base == null) base = Math.max(...props.notes.map((n) => n.startBeat + n.durBeat), 0);
  props.api.pushUndo();
  const made = [];
  for (const o of items) {
    const id = props.api.addNote(base + o._beat, o.pitch);
    const patch = {};
    for (const k of CLIP_KEYS) if (o[k] !== undefined) patch[k] = o[k];
    props.api.updateNote(id, patch);
    made.push(id);
  }
  if (made.length) props.api.setSelection(made, made[0]);
  return made.length;
}
/** 重复：紧跟在选区末尾再放一份（切分走临时剪贴板，不覆盖用户已复制的内容） */
function duplicateSelection() {
  const keep = clip.value;
  const n = copySelection(false);
  if (!n) { clip.value = keep; return 0; }
  const ids = selIds();
  const picked = props.notes.filter((z) => ids.includes(z.id));
  const end = Math.max(...picked.map((z) => z.startBeat + z.durBeat));
  const made = pasteClipboard(end);
  clip.value = keep;                 // 用户的剪贴板原样还回去
  return made;
}
/**
 * 在播放头切分选中的音符：左半保留原 id（歌词/表达式跟着走），右半是新音符。
 * 播放头不在音符内部时跳过它 —— 静默切一半比不切更让人困惑。
 */
function splitSelection(atBeat) {
  const ids = selIds();
  if (atBeat == null || atBeat < 0) return 0;
  let n = 0;
  props.api.pushUndo();
  for (const id of ids) {
    const note = props.notes.find((z) => z.id === id);
    if (!note) continue;
    const s = note.startBeat, e = s + note.durBeat;
    if (atBeat <= s + 0.02 || atBeat >= e - 0.02) continue;
    const newId = props.api.addNote(atBeat, note.pitch);
    const patch = {};
    for (const k of CLIP_KEYS) if (note[k] !== undefined && k !== 'durBeat') patch[k] = JSON.parse(JSON.stringify(note[k]));
    patch.durBeat = e - atBeat;
    props.api.updateNote(newId, patch);
    props.api.updateNote(id, { durBeat: atBeat - s });
    n++;
  }
  if (n) draw();
  return n;
}
/** 合并：同音高的选中音符首尾相接成一条（歌词取最早那条的） */
function mergeSelection() {
  const ids = selIds();
  const picked = props.notes.filter((n) => ids.includes(n.id)).slice()
    .sort((a, b) => a.startBeat - b.startBeat);
  if (picked.length < 2) return 0;
  const byPitch = new Map();
  for (const n of picked) {
    const k = String(n.pitch);
    if (!byPitch.has(k)) byPitch.set(k, []);
    byPitch.get(k).push(n);
  }
  let merged = 0;
  const survivors = [];
  props.api.pushUndo();
  for (const grp of byPitch.values()) {
    if (grp.length < 2) { survivors.push(...grp.map((n) => n.id)); continue; }
    const first = grp[0];
    const end = Math.max(...grp.map((n) => n.startBeat + n.durBeat));
    props.api.updateNote(first.id, { durBeat: Math.max(0.125, end - first.startBeat) });
    props.api.removeNotes(grp.slice(1).map((n) => n.id));
    survivors.push(first.id);
    merged += grp.length - 1;
  }
  props.api.setSelection(survivors, survivors[0] ?? null);
  draw();
  return merged;
}

/* ---------------- 快捷键 ---------------- */
function onKey(e) {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const api = props.api;
  const ids = selIds();
  const mod = e.ctrlKey || e.metaKey;
  const k = (e.key || '').toLowerCase();
  /* ★ 撤销/重做必须**让位给宿主页面**（M8c 实测踩到）：本组件是 window 级监听，
     而调教页也实现了自己的撤销/重做（并在焦点位于卷帘内时让给本组件）。
     两边都没有"焦点归属"判断时，一次 Ctrl+Z 会走两步历史 —— 实测：
     组内量化后按一次 Ctrl+Z，量化和"建音符"各退一步。所以这里只在焦点确实在卷帘内时接管。 */
  const el = e.target;
  const inRoll = !!(el && typeof el.closest === 'function' && el.closest('.pr'));
  if (mod && k === 'z' && inRoll) { e.preventDefault(); e.shiftKey ? api.redo() : api.undo(); return; }
  if (mod && k === 'y' && inRoll) { e.preventDefault(); api.redo(); return; }
  if (mod && k === 'a') { e.preventDefault(); api.selectAll(); return; }
  /* P2-1 编辑快捷键：即使没有选中音符，粘贴也要能用（剪贴板里可能有东西） */
  if (mod && k === 'c') { if (ids.length) { e.preventDefault(); copySelection(false); } return; }
  if (mod && k === 'x') { if (ids.length) { e.preventDefault(); copySelection(true); } return; }
  if (mod && k === 'v') {
    e.preventDefault();
    const n = pasteClipboard(props.playheadBeat >= 0 ? props.playheadBeat : null);
    if (!n) apiHint(t('剪贴板是空的：先选中音符按 Ctrl+C'));
    return;
  }
  if (mod && k === 'd') { if (ids.length) { e.preventDefault(); duplicateSelection(); } return; }
  if (mod && k === 'e') { if (ids.length) { e.preventDefault(); if (!splitSelection(props.playheadBeat)) apiHint(t('播放头不在选中的音符里：先把播放头拖到要切的位置')); } return; }
  if (mod && k === 'm') { if (ids.length) { e.preventDefault(); if (!mergeSelection()) apiHint(t('合并需要选中同一音高的 2 个以上音符')); } return; }
  if (!ids.length) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); api.pushUndo(); api.removeNotes(ids); return; }
  /* ★ 方向键必须让开带修饰键的组合（M7a）：本组件是 **window** 级监听，
     宿主页面的 Ctrl+↑↓（八度）也会走到这里 —— 不挡住就会"按一次八度，实际移了 13 个半音"。
     实测过：60 → Ctrl+↑ → 75（页面 +12 与本组件 +1 叠加），加 !mod 后是 72。 */
  const step = 1 / snapDiv.value;
  if (mod) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); api.pushUndo(); api.moveNotes(ids, -step, 0); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); api.pushUndo(); api.moveNotes(ids, step, 0); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); api.pushUndo(); api.moveNotes(ids, 0, 1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); api.pushUndo(); api.moveNotes(ids, 0, -1); }
}

/* 音阶选择：组件不持有状态，改的是宿主的 props（emit 上去） */
function onScalePick(e) { emit('set-scale', e.target.value); }
function onScaleRoot(e) { emit('set-scale-root', Number(e.target.value)); }

/* 右键菜单用的包装：模板里只写函数名，语句块留在 script 侧 */
function ctxCopy(cut) { copySelection(!!cut); closeCtx(); }
function ctxPaste() { pasteClipboard(props.playheadBeat >= 0 ? props.playheadBeat : null); closeCtx(); }
function ctxDuplicate() { duplicateSelection(); closeCtx(); }
function ctxSplit() { if (!splitSelection(props.playheadBeat)) apiHint(t('播放头不在选中的音符里：先把播放头拖到要切的位置')); closeCtx(); }
function ctxMerge() { if (!mergeSelection()) apiHint(t('合并需要选中同一音高的 2 个以上音符')); closeCtx(); }

/** 卷帘内的轻提示：宿主没给 toast 通道时退化成控制台，绝不静默 */
function apiHint(msg) {
  if (typeof props.api.hint === 'function') props.api.hint(msg);
  else console.warn('[PianoRoll]', msg);
}

/* ---------------- 音素条带（P2） ----------------
   参考 OpenUTAU 的 PhonemeCanvas：音素不画在音符内部，而是画在底部独立条带里，
   按「辅音→元音」分段显示并标注；标签碰撞时上下交错（raiseText）避免重叠。
   本条的 x 映射与音符画布共用 xOf()，且两者同处一个滚动容器 → 天然对齐。 */
const PH_H = 46;
const showPhoneme = ref(false);
try { showPhoneme.value = localStorage.getItem('fufumidi_roll_phoneme') === '1'; } catch (e) {}
const phonemeCanvas = ref(null);
let phCtx = null;

function setupPhonemeCanvas() {
  const c = phonemeCanvas.value; if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(cw * dpr); c.height = Math.round(PH_H * dpr);
  c.style.width = cw + 'px'; c.style.height = PH_H + 'px';
  phCtx = c.getContext('2d');
  phCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawPhoneme() {
  const c = phonemeCanvas.value;
  if (!c || !showPhoneme.value) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(PH_H * dpr)) setupPhonemeCanvas();
  const g = phCtx; if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const surf = V('--surface'), muted = V('--surface-muted'), border = V('--border');
  const ink = V('--text'), dim = V('--text-muted'), brand = V('--brand'), grid = V('--grid');
  g.clearRect(0, 0, cw, PH_H);
  g.fillStyle = muted; g.fillRect(0, 0, cw, PH_H);
  g.fillStyle = surf; g.fillRect(0, 0, LEFT, PH_H);
  g.fillStyle = dim; g.font = '9px system-ui, sans-serif'; g.textAlign = 'right';
  g.fillText(t('音素'), LEFT - 6, PH_H / 2 + 3);

  // 拍线（与音符区一致，便于对齐阅读）
  const perBarPh = perBarFor(props.beatsPerBar);
  for (let b = 0; b <= Math.ceil(totalBeats.value); b++) {
    const x = xOf(b); const isBar = b % perBarPh === 0;
    g.strokeStyle = isBar ? border : grid; g.lineWidth = isBar ? 1.2 : 0.6;
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, PH_H); g.stroke();
  }

  const selSet = new Set(props.selectedIds);
  const bandTop = 5, bandH = PH_H - 16;
  let lastTextEndX = -Infinity, raise = false;
  for (const row of derivePhonemes(props.notes)) {
    const selected = selSet.has(row.noteId);
    row.items.forEach((it, phIdx) => {
      const x0 = xOf(row.startBeat + it.t0);
      const x1 = xOf(row.startBeat + it.t1);
      const w = Math.max(2, x1 - x0) - 1;
      if (x0 + w < scrollX.value - 60 || x0 > scrollX.value + (wrap.value ? wrap.value.clientWidth : cw) + 60) return;
      /* P2-2：当前正在编辑的音素（条带上点选的那个）单独强调 —— 用户点了它就得看见它 */
      const phSel = !!props.selPhoneme && props.selPhoneme.noteId === row.noteId
        && Number(props.selPhoneme.index) === phIdx;
      // 分段块：辅音用强调底、元音用普通底
      g.fillStyle = phSel ? V('--brand-coral') : (selected ? brand : (it.cons ? V('--tint-strong') : V('--note-fill')));
      g.fillRect(x0, bandTop, w, bandH);
      g.strokeStyle = phSel ? V('--brand-coral') : (selected ? brand : V('--note-edge'));
      g.lineWidth = phSel ? 2 : 1;
      g.strokeRect(x0 + 0.5, bandTop + 0.5, w, bandH);
      // 音素起点竖线（对应 OpenUTAU 的 position 线）
      g.strokeStyle = selected ? brand : ink; g.globalAlpha = 0.6;
      g.beginPath(); g.moveTo(x0 + 0.5, bandTop); g.lineTo(x0 + 0.5, bandTop + bandH); g.stroke();
      g.globalAlpha = 1;

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
    });
  }
}

/**
 * P2-2：音素条带上点选单个音素 → 通知宿主打开音素面板。
 * 命中判定用**与绘制同一套** derivePhonemes / xOf，所以"看到哪就能点到哪"；
 * 点空白处发 null，宿主据此收起面板（比"点了没反应"清楚）。
 */
function phDown(e) {
  if (!props.canEdit || !phonemeCanvas.value) return;
  const rect = phonemeCanvas.value.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < LEFT) return;
  const beat = beatOf(x);
  for (const row of derivePhonemes(props.notes)) {
    for (let i = 0; i < row.items.length; i++) {
      const it = row.items[i];
      if (beat >= row.startBeat + it.t0 && beat <= row.startBeat + it.t1) {
        props.api.setSelection([row.noteId], row.noteId);
        emit('edit-phoneme', { noteId: row.noteId, index: i, text: it.text });
        return;
      }
    }
  }
  emit('edit-phoneme', null);
}

/* ---------------- 参数车道（P2-4） ----------------
 * 自动化此前只有「表格加点」：在输入框里敲 beat 与数值，改 5 个点要敲 10 次。
 * 这里把它画成**可拖拽的曲线车道**（对齐 OpenUTAU 的曲线编辑）：
 *   · 空白处按下 → 在该处加一个点并开始拖
 *   · 拖点 → 同时改 beat（吸附）与数值
 *   · Alt+点 / 右键点 → 删掉那个点
 * ★ x 映射与音符层共用 xOf()，所以车道与卷帘天然对齐；
 *   点数组的排序/钳制交给宿主的 store（它已有 normalizeCurve）。
 */
const AUTO_H = 70;
const autoCanvas = ref(null);
let autoCtx = null;
let autoDrag = null;

function autoSpec() {
  const a = props.automation;
  if (!a || !a.abbr) return null;
  const min = Number.isFinite(a.min) ? Number(a.min) : 0;
  const max = Number.isFinite(a.max) ? Number(a.max) : 100;
  return { min, max: max > min ? max : min + 1, def: Number.isFinite(a.def) ? Number(a.def) : min, unit: a.unit || '' };
}
function setupAutoCanvas() {
  const c = autoCanvas.value; if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(cw * dpr); c.height = Math.round(AUTO_H * dpr);
  c.style.width = cw + 'px'; c.style.height = AUTO_H + 'px';
  autoCtx = c.getContext('2d');
  autoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function yOfVal(v, spec) {
  const k = (Number(v) - spec.min) / (spec.max - spec.min);
  const pad = 8;
  return AUTO_H - pad - Math.max(0, Math.min(1, k)) * (AUTO_H - pad * 2);
}
function valOfY(y, spec) {
  const pad = 8;
  const k = 1 - (y - pad) / (AUTO_H - pad * 2);
  const v = spec.min + Math.max(0, Math.min(1, k)) * (spec.max - spec.min);
  return Math.round(v * 100) / 100;
}
function autoPoints() {
  const a = props.automation;
  const pts = (a && Array.isArray(a.points)) ? a.points : [];
  return pts.map((p) => ({ beat: Number(p.beat) || 0, value: Number(p.value) || 0 })).sort((x, y) => x.beat - y.beat);
}
function drawAuto() {
  const c = autoCanvas.value;
  const spec = autoSpec();
  if (!c || !spec) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(AUTO_H * dpr)) setupAutoCanvas();
  const g = autoCtx; if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const surf = V('--surface'), muted = V('--surface-muted'), border = V('--border');
  const ink = V('--text'), dim = V('--text-muted'), brand = V('--brand'), grid = V('--grid');
  g.clearRect(0, 0, cw, AUTO_H);
  g.fillStyle = surf; g.fillRect(0, 0, cw, AUTO_H);
  g.fillStyle = muted; g.fillRect(0, 0, LEFT, AUTO_H);
  g.fillStyle = dim; g.font = '9px system-ui, sans-serif'; g.textAlign = 'right';
  g.fillText(String((props.automation && props.automation.label) || 'AUTO'), LEFT - 6, 14);
  g.fillText(String(spec.max), LEFT - 6, 24);
  g.fillText(String(spec.min), LEFT - 6, AUTO_H - 4);

  const perBarA = perBarFor(props.beatsPerBar);
  for (let b = 0; b <= Math.ceil(totalBeats.value); b++) {
    const x = xOf(b); const isBar = b % perBarA === 0;
    g.strokeStyle = isBar ? border : grid; g.lineWidth = isBar ? 1.2 : 0.6;
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, AUTO_H); g.stroke();
  }
  // 默认值基线（虚线）：一眼看出哪里被抬起来了
  const yDef = yOfVal(spec.def, spec);
  g.save(); g.setLineDash([4, 3]); g.strokeStyle = dim; g.lineWidth = 1;
  g.beginPath(); g.moveTo(LEFT, yDef + 0.5); g.lineTo(cw, yDef + 0.5); g.stroke(); g.restore();

  const pts = autoPoints();
  // 曲线：首点之前取首点值、末点之后取末点值（与运行时的采样语义一致）
  g.strokeStyle = brand; g.lineWidth = 1.6; g.beginPath();
  if (pts.length) {
    g.moveTo(LEFT, yOfVal(pts[0].value, spec));
    for (const p of pts) g.lineTo(xOf(p.beat), yOfVal(p.value, spec));
    g.lineTo(cw, yOfVal(pts[pts.length - 1].value, spec));
  }
  g.stroke();
  for (const p of pts) {
    const x = xOf(p.beat), y = yOfVal(p.value, spec);
    g.fillStyle = surf; g.strokeStyle = brand; g.lineWidth = 1.6;
    g.beginPath(); g.arc(x, y, 3.6, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  if (autoDrag) {
    const cur = pts[autoDrag.index];
    if (cur) {
      g.fillStyle = ink; g.font = '10px system-ui, sans-serif'; g.textAlign = 'left';
      g.fillText(String(cur.value) + spec.unit + ' @ ' + cur.beat.toFixed(2), xOf(cur.beat) + 7, yOfVal(cur.value, spec) - 5);
    }
  }
}

function autoXY(e) {
  const r = autoCanvas.value.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function autoHit(x, y, spec) {
  const pts = autoPoints();
  for (let i = pts.length - 1; i >= 0; i--) {
    const px = xOf(pts[i].beat), py = yOfVal(pts[i].value, spec);
    if (Math.abs(px - x) <= 6 && Math.abs(py - y) <= 6) return i;
  }
  return -1;
}
function emitAuto(pts) { emit('set-automation', pts); }

function aDown(e) {
  const spec = autoSpec();
  if (!spec || !props.canEdit) return;
  const { x, y } = autoXY(e);
  if (x < LEFT) return;
  const pts = autoPoints();
  const hitIdx = autoHit(x, y, spec);
  /* 一次拖拽 = 一步撤销：宿主收到 begin 才 pushUndo，
     后续的 set-automation 只改数据（否则拖一次会灌满整个撤销栈）。 */
  emit('automation-begin');
  if (hitIdx >= 0 && (e.altKey || e.button === 2)) {           // Alt / 右键点：删点
    pts.splice(hitIdx, 1);
    emitAuto(pts);
    return;
  }
  let index = hitIdx;
  if (index < 0) {                                             // 空白：加点并直接进入拖动
    pts.push({ beat: Math.max(0, snapBeat(beatOf(x))), value: valOfY(y, spec) });
    pts.sort((a, b) => a.beat - b.beat);
    index = pts.length - 1;
    emitAuto(pts);
  }
  autoDrag = { index };
  try { autoCanvas.value.setPointerCapture(e.pointerId); } catch (err) { /* 老实现忽略 */ }
  nextTick(drawAuto);
}
function aMove(e) {
  if (!autoDrag) return;
  const spec = autoSpec();
  if (!spec) return;
  const { x, y } = autoXY(e);
  const pts = autoPoints();
  const p = pts[autoDrag.index];
  if (!p) return;
  p.beat = Math.max(0, snapBeat(beatOf(x)));
  p.value = valOfY(y, spec);
  pts.sort((a, b) => a.beat - b.beat);
  emitAuto(pts);
  nextTick(drawAuto);
}
function aUp() { autoDrag = null; nextTick(drawAuto); }
/* ---------------- 音高车道（P3） ----------------
   参考 OpenUTAU 的曲线车道：车道内是「拍 → 音分」的控制点折线，工具齐全
   （手绘 / 直线 / 正弦 / 平滑 / 移动控制点）。与音符、音素同处一个滚动容器，天然对齐。 */
const PI_H = 92;
const PITCH_MIN = -200, PITCH_MAX = 200;
const pitchOn = ref(false);
try { pitchOn.value = localStorage.getItem('fufumidi_roll_pitch') === '1'; } catch (e) {}
watch(pitchOn, v => { try { localStorage.setItem('fufumidi_roll_pitch', v ? '1' : '0'); } catch (e) {} });
const pitchCanvas = ref(null);
let piCtx = null;
const pitchTool = ref('draw');   // move | draw | line | sine | smooth
const pCurve = ref([]);
let pDrag = null;
let pitchBusy = false;

function setupPitchCanvas() {
  const c = pitchCanvas.value; if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(cw * dpr); c.height = Math.round(PI_H * dpr);
  c.style.width = cw + 'px'; c.style.height = PI_H + 'px';
  piCtx = c.getContext('2d');
  piCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function yOfCents(c) { const half = PI_H / 2 - 6; return PI_H / 2 - (Math.max(PITCH_MIN, Math.min(PITCH_MAX, c)) / PITCH_MAX) * half; }
function centsOfY(y) { const half = PI_H / 2 - 6; return Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round((PI_H / 2 - y) / half * PITCH_MAX))); }

function loadPitch() {
  if (pitchBusy) return;
  const pts = (props.api && props.api.getPitchPoints) ? (props.api.getPitchPoints() || []) : [];
  pCurve.value = pts.slice().sort((a, b) => a.beat - b.beat);
}
const pitchRev = computed(() => {
  const pts = (props.api && props.api.getPitchPoints) ? (props.api.getPitchPoints() || []) : [];
  let s = pts.length;
  for (const p of pts) s += p.beat * 3 + p.cents * 7;
  return s;
});

function upsertPitchPoint(b, c) {
  const eps = 1 / 32;
  pCurve.value = pCurve.value.filter(p => Math.abs(p.beat - b) > eps);
  pCurve.value.push({ beat: b, cents: c });
  pCurve.value.sort((a, x) => a.beat - x.beat);
  if (pCurve.value.length > 4000) pCurve.value = pCurve.value.filter((_, i) => i % 2 === 0);
}
function applyLineOrSine(d) {
  let b0 = Math.min(d.b0, d.b1), b1 = Math.max(d.b0, d.b1);
  let c0, c1;
  if (d.b0 <= d.b1) { c0 = d.c0; c1 = d.c1; } else { c0 = d.c1; c1 = d.c0; }
  if (b1 - b0 < 1 / 32) { upsertPitchPoint(b0, c0); return; }
  const eps = 1 / 64;
  pCurve.value = pCurve.value.filter(p => p.beat < b0 - eps || p.beat > b1 + eps);
  const span = b1 - b0, step = 1 / 16;
  const cyc = Math.max(1, Math.round(span * 1.5));
  const amp = d.tool === 'sine' ? (c1 - c0) * 0.5 : 0;
  for (let t = 0; t <= span + 1e-9; t += step) {
    const frac = t / span;
    let c = c0 + (c1 - c0) * frac;
    if (d.tool === 'sine') c += amp * Math.sin(frac * Math.PI * 2 * cyc);
    pCurve.value.push({ beat: b0 + t, cents: Math.round(c) });
  }
  pCurve.value.sort((a, x) => a.beat - x.beat);
}
function smoothPitchAt(b) {
  const win = 0.4;
  const pts = pCurve.value;
  for (let i = 1; i < pts.length - 1; i++) {
    if (Math.abs(pts[i].beat - b) <= win) pts[i].cents = Math.round((pts[i - 1].cents + pts[i].cents + pts[i + 1].cents) / 3);
  }
}

function drawPitch() {
  const c = pitchCanvas.value;
  if (!c || !pitchOn.value) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(PI_H * dpr)) setupPitchCanvas();
  const g = piCtx; if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const surf = V('--surface'), muted = V('--surface-muted'), border = V('--border');
  const ink = V('--text'), dim = V('--text-muted'), brand = V('--brand'), grid = V('--grid');
  g.clearRect(0, 0, cw, PI_H);
  g.fillStyle = muted; g.fillRect(0, 0, cw, PI_H);
  g.fillStyle = surf; g.fillRect(0, 0, LEFT, PI_H);
  g.fillStyle = dim; g.font = '9px system-ui, sans-serif'; g.textAlign = 'right';
  g.fillText(t('音高'), LEFT - 6, PI_H / 2 + 3);

  // 刻度线：0 / ±100 / ±200 音分
  for (const cval of [-200, -100, 0, 100, 200]) {
    const y = yOfCents(cval);
    g.strokeStyle = cval === 0 ? border : grid; g.lineWidth = cval === 0 ? 1.2 : 0.6;
    g.beginPath(); g.moveTo(LEFT, y + 0.5); g.lineTo(cw, y + 0.5); g.stroke();
    g.fillStyle = dim; g.textAlign = 'right'; g.font = '8px system-ui, sans-serif';
    g.fillText(String(cval), LEFT - 3, y + 3);
  }
  for (let b = 0; b <= Math.ceil(totalBeats.value); b++) {
    const x = xOf(b); const isBar = b % perBarFor(props.beatsPerBar) === 0;
    g.strokeStyle = isBar ? border : grid; g.lineWidth = isBar ? 1 : 0.5;
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, PI_H); g.stroke();
  }

  // 曲线折线
  const pts = pCurve.value;
  if (pts.length) {
    g.strokeStyle = brand; g.lineWidth = 1.6; g.beginPath();
    pts.forEach((p, i) => { const x = xOf(p.beat), y = yOfCents(p.cents); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.fillStyle = ink;
    for (const p of pts) g.fillRect(xOf(p.beat) - 2, yOfCents(p.cents) - 2, 4, 4);
  }

  // 直线 / 正弦拖拽预览
  if (pDrag && (pDrag.tool === 'line' || pDrag.tool === 'sine')) {
    const x0 = xOf(pDrag.b0), y0 = yOfCents(pDrag.c0), x1 = xOf(pDrag.b1), y1 = yOfCents(pDrag.c1);
    g.save(); g.strokeStyle = brand; g.setLineDash([4, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.setLineDash([]); g.restore();
    if (pDrag.tool === 'sine') {
      let a = Math.min(pDrag.b0, pDrag.b1), bb = Math.max(pDrag.b0, pDrag.b1);
      let ca = pDrag.b0 <= pDrag.b1 ? pDrag.c0 : pDrag.c1, cb = pDrag.b0 <= pDrag.b1 ? pDrag.c1 : pDrag.c0;
      const span = bb - a; if (span >= 1 / 32) {
        const cyc = Math.max(1, Math.round(span * 1.5));
        const amp = (cb - ca) * 0.5;
        g.strokeStyle = brand; g.lineWidth = 1; g.beginPath();
        for (let t = 0; t <= span + 1e-9; t += 1 / 32) {
          const frac = t / span;
          const y = yOfCents(ca + (cb - ca) * frac + amp * Math.sin(frac * Math.PI * 2 * cyc));
          const x = xOf(a + t);
          t === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
      }
    }
  }
}

function pDown(e) {
  if (!pitchOn.value || !props.canEdit) return;
  const r = pitchCanvas.value.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (x < LEFT) return;
  if (props.api && props.api.pushUndo) props.api.pushUndo();
  pitchBusy = true;
  loadPitch();
  const b = snapBeat(beatOf(x)), c = centsOfY(y);
  if (pitchTool.value === 'move') {
    let best = -1, bd = 9;
    pCurve.value.forEach((p, i) => { const d = Math.hypot(xOf(p.beat) - x, yOfCents(p.cents) - y); if (d < bd) { bd = d; best = i; } });
    if (best < 0) { pitchBusy = false; return; }
    pDrag = { tool: 'move', idx: best };
  } else {
    pDrag = { tool: pitchTool.value, b0: b, c0: c, b1: b, c1: c };
    if (pitchTool.value === 'draw') upsertPitchPoint(b, c);
    else if (pitchTool.value === 'smooth') smoothPitchAt(b);
  }
  try { pitchCanvas.value.setPointerCapture(e.pointerId); } catch (err) {}
  drawPitch();
}
function pMove(e) {
  if (!pDrag) return;
  const r = pitchCanvas.value.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const b = snapBeat(beatOf(x)), c = centsOfY(y);
  if (pDrag.tool === 'draw') upsertPitchPoint(b, c);
  else if (pDrag.tool === 'smooth') smoothPitchAt(b);
  else if (pDrag.tool === 'move') { const p = pCurve.value[pDrag.idx]; if (p) { p.beat = b; p.cents = c; pCurve.value.sort((a, z) => a.beat - z.beat); } }
  else { pDrag.b1 = b; pDrag.c1 = c; }
  drawPitch();
}
function pUp() {
  if (!pDrag) return;
  if (pDrag.tool === 'line' || pDrag.tool === 'sine') applyLineOrSine(pDrag);
  pDrag = null;
  pitchBusy = false;
  if (props.api && props.api.setPitchPoints) props.api.setPitchPoints(pCurve.value.slice());
  drawPitch();
}
function clearPitch() {
  if (props.api && props.api.pushUndo) props.api.pushUndo();
  pCurve.value = [];
  if (props.api && props.api.setPitchPoints) props.api.setPitchPoints([]);
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
// 叠置：幽灵轨的音符/颜色/显隐、开关本身、当前轨切换都要重画
const ghostRev = computed(() => {
  let s = props.overlay ? 1 : 0;
  for (const t of props.tracks || []) {
    s += (t.hidden ? 1 : 0) + String(t.color || '').length + (t.notes ? t.notes.length : 0) * 17;
    if (t.notes) for (const n of t.notes) s += n.startBeat * 3 + n.pitch * 5 + n.durBeat * 7;
  }
  return s + String(props.activeTrackId || '');
});
/* 打开「多轨叠置」时幽灵音符淡入一次：直接跳出来会让人以为是自己轨上的音符。
   画布是每帧重绘的，所以这里只维护一个 0→1 的系数，rAF 里推它。 */
const ghostFade = ref(1);
let ghostRaf = 0;
watch(() => props.overlay, (on) => {
  cancelAnimationFrame(ghostRaf);
  if (!on) { ghostFade.value = 1; return; }
  const t0 = performance.now();
  ghostFade.value = 0;
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / 260);
    ghostFade.value = k * k * (3 - 2 * k);          // smoothstep
    draw();
    if (k < 1) ghostRaf = requestAnimationFrame(step);
  };
  ghostRaf = requestAnimationFrame(step);
});
watch(ghostRev, () => nextTick(() => { setupCanvas(); draw(); }));
watch([noteW, rowH, showPhoneme, pitchOn], () => nextTick(() => { setupCanvas(); draw(); }));
// 播放头每帧都在动：只重绘音符层，不做 setupCanvas（重建画布会把滚动位置抖掉）
watch(() => props.playheadBeat, () => draw());
// 音阶高亮与剪贴板可用性也会改变画面
watch(() => (props.scale && props.scale.type) + ':' + (props.scale && props.scale.root), () => draw());
watch(() => props.beatsPerBar, () => draw());
// 选中的音素变了要重画（条带上的强调块）
watch(() => props.selPhoneme && (props.selPhoneme.noteId + '#' + props.selPhoneme.index) || '', () => draw());
/* 参数车道：曲线/目标/拍号变化都要重画（点数组是宿主传下来的新数组，直接比引用） */
watch(() => props.automation, () => nextTick(drawAuto), { deep: true });
watch(() => props.beatsPerBar, () => nextTick(drawAuto));
watch(pitchRev, () => { loadPitch(); nextTick(drawPitch); });
watch(showPhoneme, v => { try { localStorage.setItem('fufumidi_roll_phoneme', v ? '1' : '0'); } catch (e) {} });

onMounted(() => {
  setupCanvas(); draw();
  loadPitch();
  window.addEventListener('keydown', onKey);
  // fill 模式：容器尺寸一变就重新分配行高（窗口缩放、面板折叠、详情展开都走这里）
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => applyFluidHeight());
    if (wrap.value) ro.observe(wrap.value);
  }
  nextTick(applyFluidHeight);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
});

/* 供宿主（如 UTAU 工作台的自定义车道）对齐几何与滚动：
   车道画布用 xOf/beatOf 换算、读 wrap 同步横向滚动即可 */
/**
 * 适应窗口：横向把全曲塞进可视宽度、纵向把音域铺满可视高度。
 *
 * ★ 为什么需要：卷帘默认 noteW 是固定值，一首 4 分钟的歌画出来有 13000+ px 宽，
 *   而视口只有 1200 多 px —— 导入后用户看到的是「音符不全」（其实是要横向滚 10 屏），
 *   旧工具栏只有 −/＋ 两个按钮，没有任何「一键看全」的入口。
 */
function fitView() {
  const el = wrap.value;
  if (!el) return;
  const availW = Math.max(160, el.clientWidth - LEFT - 12);
  /* 下限放到 1.2 px/拍：4 分钟的歌有近 400 拍，6 px/拍下限会让「适应窗口」根本装不下
     （实测 390 拍 × 6 = 2340 px，视口只有 625 px）。缩到 1~2 px/拍是**总览**该有的密度。 */
  noteW.value = Math.max(MIN_NOTE_W, Math.min(MAX_NOTE_W, availW / Math.max(1, totalBeats.value)));
  if (fluid.value) {
    // 纵向由 applyFluidHeight 负责（这里只管横向铺满）
  } else {
    const availH = Math.max(60, el.clientHeight - TOP - 10);
    rowH.value = Math.max(5, Math.min(22, availH / Math.max(1, rows.value)));
  }
  el.scrollLeft = 0;
  nextTick(() => { setupCanvas(); draw(); });
}

defineExpose({
  draw, setupCanvas,
  noteW, rowH, pitchSpan, totalBeats,
  xOf, beatOf, yOf, pitchOf,
  scrollEl: wrap,
  fitView,
});
</script>

<template>
  <div ref="rootEl" class="pr" :class="{ 'pr-fill': fluid }">
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
      <!-- 音阶高亮（P2-1）：只压暗调外音行，不动任何数据 -->
      <label class="pr-ad" :title="t('高亮当前调式：调外音行压暗，写旋律时一眼看出跑调的音')">
        {{ t('音阶') }}
        <select :value="(scale && scale.type) || 'off'" @change="onScalePick($event)">
          <option value="off">{{ t('关闭') }}</option>
          <option value="major">{{ t('大调') }}</option>
          <option value="minor">{{ t('小调') }}</option>
        </select>
        <select v-if="scale && scale.type" :value="String(scale.root ?? 0)" @change="onScaleRoot($event)">
          <option v-for="(nm, i) in NOTE_NAMES" :key="i" :value="String(i)">{{ nm }}</option>
        </select>
      </label>
      <span class="pr-zoom">
        <button class="pr-mini" :title="t('缩小')" @click="noteW = Math.max(MIN_NOTE_W, noteW * 0.85)">−</button>
        <button class="pr-mini" :title="t('放大')" @click="noteW = Math.min(MAX_NOTE_W, noteW * 1.18)">+</button>
        <button class="pr-mini" :title="t('行高')" @click="rowH = rowH >= 18 ? 12 : rowH + 3">↕</button>
        <button class="pr-mini" :title="t('适应窗口（全曲入画）')" @click="fitView">⤢</button>
      </span>
      <span class="pr-hint">{{ t('滚轮+Ctrl 缩放 · Shift+滚轮 平移 · 双击改歌词 · 方向键微调 · Ctrl+Z 撤销') }}</span>
    </div>

    <!-- 音高工具行（仅在打开音高车道时显示） -->
    <div v-if="showToolbar && pitchOn" class="pr-bar pr-bar-pitch">
      <span class="pr-ad">{{ t('音高工具') }}</span>
      <div class="pr-tools">
        <button class="pr-tool" :class="{ on: pitchTool === 'move' }" :title="t('拖动控制点')" @click="pitchTool = 'move'">⌖ {{ t('移动') }}</button>
        <button class="pr-tool" :class="{ on: pitchTool === 'draw' }" :title="t('按住拖出曲线')" @click="pitchTool = 'draw'">✎ {{ t('手绘') }}</button>
        <button class="pr-tool" :class="{ on: pitchTool === 'line' }" :title="t('从 A 拖到 B 画直线')" @click="pitchTool = 'line'">╱ {{ t('直线') }}</button>
        <button class="pr-tool" :class="{ on: pitchTool === 'sine' }" :title="t('从 A 拖到 B 画正弦波')" @click="pitchTool = 'sine'">∿ {{ t('正弦') }}</button>
        <button class="pr-tool" :class="{ on: pitchTool === 'smooth' }" :title="t('按住拖动以平滑局部')" @click="pitchTool = 'smooth'">∼ {{ t('平滑') }}</button>
        <button class="pr-tool" :title="t('清空音高曲线')" @click="clearPitch">✕ {{ t('清空') }}</button>
      </div>
    </div>

    <!-- 画布 -->
    <div ref="wrap" class="pr-scroll" :style="fluid ? null : { height: height + 'px' }" @pointerdown="closeCtx" @wheel="onWheel">
      <canvas ref="canvas" class="pr-canvas" :style="{ cursor }"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
        @dblclick="onDbl" @contextmenu="onCtx"></canvas>
      <!-- 音素条带：与上方音符画布同处一个滚动容器，横向天然对齐 -->
      <canvas v-if="showPhoneme" ref="phonemeCanvas" class="pr-canvas pr-ph-canvas"
        :style="{ cursor: canEdit ? 'pointer' : 'default' }" @pointerdown="phDown"></canvas>
      <!-- 参数车道（P2-4）：拖拽编辑自动化曲线 -->
      <canvas v-if="automation && automation.abbr" ref="autoCanvas" class="pr-canvas pr-ph-canvas pr-auto-canvas"
        :style="{ cursor: canEdit ? 'crosshair' : 'default' }"
        @pointerdown="aDown" @pointermove="aMove" @pointerup="aUp" @pointercancel="aUp"
        @contextmenu.prevent="aDown"></canvas>
      <!-- 音高车道：曲线与控制点 -->
      <canvas v-if="pitchOn" ref="pitchCanvas" class="pr-canvas pr-ph-canvas"
        @pointerdown="pDown" @pointermove="pMove" @pointerup="pUp" @pointercancel="pUp"></canvas>
    </div>

    <!-- 右键菜单 -->
    <Transition name="ctxmenu">
      <div v-if="ctxOpen" class="pr-ctx" :style="{ left: ctxX + 'px', top: ctxY + 'px' }" @pointerdown.stop @contextmenu.prevent>
        <button class="pr-ctx-i" @click="api.undo(); closeCtx()"><Icon name="undo" :size="13" /> {{ t('撤销') }}</button>
        <button class="pr-ctx-i" @click="api.redo(); closeCtx()"><Icon name="redo" :size="13" /> {{ t('重做') }}</button>
        <div class="pr-ctx-sep"></div>
        <button class="pr-ctx-i" :disabled="!ctxOnNote" @click="emit('edit-lyric', notes.find(n => n.id === ctxNoteId)); closeCtx()"><Icon name="edit" :size="13" /> {{ t('编辑歌词') }}</button>
        <div class="pr-ctx-sep"></div>
        <button class="pr-ctx-i" :disabled="!selIds().length" @click="ctxCopy(false)"><Icon name="copy" :size="13" /> {{ t('复制') }}<span class="pr-ctx-k">Ctrl+C</span></button>
        <button class="pr-ctx-i" :disabled="!selIds().length" @click="ctxCopy(true)"><Icon name="cut" :size="13" /> {{ t('剪切') }}<span class="pr-ctx-k">Ctrl+X</span></button>
        <button class="pr-ctx-i" :disabled="!clip.length" @click="ctxPaste()"><Icon name="paste" :size="13" /> {{ t('粘贴到播放头') }}<span class="pr-ctx-k">Ctrl+V</span></button>
        <button class="pr-ctx-i" :disabled="!selIds().length" @click="ctxDuplicate()"><Icon name="copy" :size="13" /> {{ t('重复一份') }}<span class="pr-ctx-k">Ctrl+D</span></button>
        <button class="pr-ctx-i" :disabled="!selIds().length" @click="ctxSplit()"><Icon name="split" :size="13" /> {{ t('在播放头切分') }}<span class="pr-ctx-k">Ctrl+E</span></button>
        <button class="pr-ctx-i" :disabled="selIds().length < 2" @click="ctxMerge()"><Icon name="merge" :size="13" /> {{ t('合并同音高') }}<span class="pr-ctx-k">Ctrl+M</span></button>
        <div class="pr-ctx-sep"></div>
        <button class="pr-ctx-i" :disabled="!ctxOnNote" @click="api.pushUndo(); api.removeNotes(selectedIds.length ? selectedIds : [ctxNoteId]); closeCtx()"><Icon name="trash" :size="13" /> {{ t('删除') }}</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.pr { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface); }
.pr-bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; flex-wrap: wrap; border-bottom: 1px solid var(--border); background: var(--surface-muted); }
.pr-tools { display: inline-flex; gap: 4px; }
.pr-tool { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: var(--stone); font-size: 12px; cursor: pointer; }
.pr-tool:hover { background: var(--surface); color: var(--ink); }
.pr-tool.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-text); }
.pr-ad { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--stone); }
.pr-ad select { height: 24px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--ink); font-size: 11.5px; }
.pr-bar-pitch { padding-top: 0; border-top: 0; }
.pr-zoom { display: inline-flex; gap: 3px; }
.pr-mini { width: 24px; height: 24px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--stone); cursor: pointer; line-height: 1; }
.pr-mini:hover { background: var(--surface); color: var(--ink); }
.pr-hint { margin-left: auto; font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-scroll { position: relative; overflow: auto; background: var(--surface); }
/* fill：卷帘自己撑满父容器，滚动区吃掉工具栏之外的全部高度（行高由 JS 自适应） */
.pr.pr-fill { height: 100%; min-height: 0; }
.pr.pr-fill .pr-scroll { flex: 1 1 auto; min-height: 0; }
.pr-canvas { display: block; }
/* 音素条带：贴住音符区底部，横向随同一滚动容器对齐 */
.pr-ph-canvas { border-top: 1px solid var(--border); }
.pr-auto-canvas { touch-action: none; }
.pr-ctx { position: absolute; z-index: 40; min-width: 132px; padding: 4px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.pr-ctx-i { display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--ink); font-size: 12.5px; text-align: left; cursor: pointer; }
.pr-ctx-i:hover:not(:disabled) { background: var(--surface-muted); }
.pr-ctx-i:disabled { opacity: .4; cursor: not-allowed; }
.pr-ctx-k { margin-left: auto; color: var(--text-muted); font-size: 10.5px; font-family: var(--mono); }
.pr-ctx-sep { height: 1px; margin: 4px 2px; background: var(--border); }
.ctxmenu-enter-active, .ctxmenu-leave-active { transition: opacity .1s, transform .1s; }
.ctxmenu-enter-from, .ctxmenu-leave-to { opacity: 0; transform: scale(.96); }
</style>

<script setup lang="ts">
/**
 * 歌声合成 · 统一编辑器
 *
 * 布局照上游 OpenUtau 的编辑器：左侧轨道列表，右侧钢琴卷帘 + 音符表 + 渲染。
 * 引擎（UTAU / DiffSinger）是**轨道上的属性**，不是页面级的模式 ——
 * 所以一个工程里两种轨可以混排，渲染时按各自引擎分派。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import PianoRoll from '../components/pianoroll/PianoRoll.vue';
import { trackColorOf, newNoteId } from '../stores/singer';
import VoicebankPanel from '../components/sing/VoicebankPanel.vue';
import CurveCanvas from '../components/sing/CurveCanvas.vue';
import ViewVoicebank from './ViewVoicebank.vue';
import { t } from '../core/i18n.js';
import { ENGINES, LANGUAGES, useSingerStore } from '../stores/singer';
import { useAppStore } from '../stores/app';
import { getTransport } from '../core/sing_transport.js';
import { FX_TYPES, FX_ORDER } from '../core/track_fx.js';
import { CURVE_TARGETS, curveOf, defaultFor, targetsFor } from '../core/track_automation.js';
import { notePhonemes } from '../core/phoneme.js';
import { alignLyrics, splitLyricLines, splitNotesToFit } from '../core/sing_align.js';

const store = useSingerStore();
const app = useAppStore();
const route = useRoute();
const router = useRouter();

/*
 * P1-4 统一提示：整个页面**只有一个**提示出口（app.toast）。
 * 早先这里有一条自己的 msg 条（编辑区顶部），错误还会各处 inline ——
 * 用户永远不知道提示会从哪儿冒出来。现在：
 *   say(...)    普通结果（ok/info/warn）
 *   sayErr(...) 失败 + **下一步该做什么**（hint）+ 可展开详情（detail）
 * 常驻的「为什么渲不了」不放 toast（它不该 6 秒后消失），仍留在渲染按钮旁。
 */
function say(m: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'ok', opts: any = {}) {
  app.toast(m, kind, opts);
}
function sayErr(m: string, hint = '', detail = '') {
  if (!m) return;
  app.toast(m, 'error', { hint, detail });
}

/* ---------------------------------------------------------- 页签名
 * 「调教」页把原来的「歌声合成」与「声库」两页并成一个：编辑器（选歌手 / 画音符 / 渲染）
 * 与声库（做 / 装 / 管）本就是同一条工作流的两半，不再各占一个顶栏入口。
 *
 * ?tab= 取值（面板永远只有「编辑器 / 声库」两个页签）：
 *   banks                → 声库页签（原 /banks 页）
 *   utau / diffsinger    → 编辑器页签，并选中/新建该引擎的轨（合并前的旧深链）
 *   其它 / 缺省 / editor → 编辑器页签 */
type SingTab = 'editor' | 'banks' | 'maker';
const asTab = (v: any): SingTab => (v === 'banks' ? 'banks' : (v === 'maker' ? 'maker' : 'editor'));
const tab = ref<SingTab>(asTab(route.query.tab));

watch(() => route.query.tab, (v) => {
  const want = asTab(v);
  if (want !== tab.value) tab.value = want;
});

function setTab(v: SingTab) {
  tab.value = v;
  // 用 path + query 直接替换：交给顶层 /:pathMatch 兜底，不依赖具体路由名
  try { void router.replace({ path: '/singer', query: v === 'editor' ? {} : { tab: v } }); }
  catch (_) { /* 路由不可用时忽略 */ }
}
const propsOpen = ref(false);
const cands = ref([]);
const candFor = ref('');

const tr = computed(() => store.activeTrack);
const isUtau = computed(() => tr.value?.kind === 'voice' && tr.value?.engine === 'utau');
const isDs = computed(() => tr.value?.kind === 'voice' && tr.value?.engine === 'diffsinger');
const isAudio = computed(() => tr.value?.kind === 'audio');
const sel = computed(() => store.activeNote);

/* ---------------------------------------------------------- 轨道属性面板 */
/**
 * 面板分三块：参数 / 效果链 / 自动化。
 *
 * 效果链和自动化是**本轨独享**的（对应 AltZin 的"前置效果链 + 从属轨"），
 * 放在轨道上而不是总线上 —— 一条人声加混响不该把伴奏也拖进混响里。
 */
const propsTab = ref<'params' | 'fx' | 'auto'>('params');
const fxList = computed<any[]>(() => (tr.value?.fx || []).slice());

/** 这条轨能挂哪些自动化目标（引擎不同，列表不同） */
const autoTargets = computed<string[]>(() => (tr.value ? store.curveTargets(tr.value.id) : []));
const curAbbr = ref('PIT');

/** 换轨 / 换引擎后当前目标可能不存在了（UTAU 才有 DYN/BRE/GEN）→ 落回第一个可用的 */
watch([() => tr.value?.id, autoTargets], () => {
  if (autoTargets.value.indexOf(curAbbr.value) < 0) curAbbr.value = autoTargets.value[0] || 'PIT';
}, { immediate: true });

const curCurve = computed<any>(() => (tr.value ? curveOf(tr.value, curAbbr.value) : null));
const curTarget = computed<any>(() => (CURVE_TARGETS as any)[curAbbr.value] || null);

/* 模板里不方便写 TS 断言，这几个取值函数放到 script 侧 */
const fxType = (k: string): any => (FX_TYPES as any)[k] || { label: k, params: [] };
const fxParams = (f: any): any[] => fxType(f.type).params || [];
const curTgt = (a: string): any => (CURVE_TARGETS as any)[a] || { label: a };

function onGainDb(e: Event) {
  const t0 = tr.value;
  if (!t0) return;
  const v = Math.max(-60, Math.min(6, nval(e, 0)));
  if (t0.kind === 'audio') store.patchAudio(t0.id, { gainDb: v });
  else store.patchTrack(t0.id, { gainDb: v });
}

function onAddFx(e: Event) {
  const el = e.target as HTMLSelectElement;
  const type = el.value;
  el.value = '';                            // 复位，方便连着加
  if (!type || !tr.value) return;
  store.addFx(tr.value.id, type);
}

/** 参数一律走 `patchFx` → `normalizeFx` 钳制，脏值进不了节点 */
function setFxParam(f: any, p: any, e: Event) {
  if (!tr.value) return;
  const v = p.kind === 'enum' ? sval(e) : nval(e, p.def);
  store.patchFx(tr.value.id, f.id, { params: { [p.k]: v } });
}
function toggleFx(f: any, e: Event) {
  if (!tr.value) return;
  store.patchFx(tr.value.id, f.id, { enabled: (e.target as HTMLInputElement).checked });
}

/* 自动化点编辑：整组替换 —— 排序和钳制交给 `normalizeCurve` */
function autoPoints(): { beat: number; value: number }[] {
  return (curCurve.value?.points || []).map((p: any) => ({ beat: p.beat, value: p.value }));
}
function autoAddPoint() {
  if (!tr.value) return;
  const t0 = tr.value;
  const last = t0.kind === 'audio' ? null : t0.notes[t0.notes.length - 1];
  const beat = last ? Math.round((last.startBeat + last.durBeat / 2) * 4) / 4 : 0;
  const pts = autoPoints();
  pts.push({ beat, value: defaultFor(curAbbr.value) });
  store.setCurve(t0.id, curAbbr.value, pts);
}
function autoSetPoint(pts: { beat: number; value: number }[], i: number, field: string, e: Event) {
  if (!tr.value) return;
  const v = nval(e, 0);
  const next = pts.map((p) => ({ ...p }));
  if (next[i]) {
    if (field === 'beat') next[i].beat = Math.max(0, v); else next[i].value = v;
  }
  store.setCurve(tr.value.id, curAbbr.value, next);
}
/** 卷帘里双击音符：选中它，并把详情面板打开 —— 颤音/音素/曲线都在那里面（M6c） */
function onEditNoteFromRoll(id: string) {
  store.select(id);
  if (!detailOpen.value) detailOpen.value = true;
}
/* ---------------- 曲线的复制与锁定（M6c，计划书 §4.1 曲线工具条的剩余项） ---------------- */
/** 锁定：锁上以后画布只读，避免「只是想看看」时误改 */
const curveLocked = ref(localStorage.getItem('fufumidi_curve_locked') === '1');
watch(curveLocked, (v) => { try { localStorage.setItem('fufumidi_curve_locked', v ? '1' : '0'); } catch (e) {} });
/** 复制当前参数曲线到别的轨（同引擎的轨才有同一个目标表） */
const copyToId = ref('');
/* 只列出「这条参数它也用得了」的轨：UTAU 专属的 DYN 复制到 DiffSinger 轨会被 normalizeCurves 丢掉，
   与其让用户点了个没反应，不如根本不给选。 */
const copyTargets = computed(() => store.tracks.filter((x: any) =>
  x.id !== (tr.value && tr.value.id) && x.kind === 'voice' && targetsFor(x.engine, x.kind).indexOf(curAbbr.value) >= 0));
function copyCurveTo(trackId: string) {
  const t0 = tr.value; if (!t0 || !trackId) return;
  const c = curCurve.value; if (!c || !c.points.length) { say(t('这条曲线还没有点')); return; }
  store.setCurve(trackId, curAbbr.value, c.points.map((p: any) => ({ beat: p.beat, value: p.value })));
  say(t('已把 ') + curAbbr.value + t(' 曲线复制到目标轨'), 'ok');
}
function copyCurveToAll() {
  const c = curCurve.value; if (!c || !c.points.length) { say(t('这条曲线还没有点')); return; }
  let n = 0;
  for (const x of copyTargets.value) { store.setCurve(x.id, curAbbr.value, c.points.map((p: any) => ({ beat: p.beat, value: p.value }))); n++; }
  say(t('已复制到 ') + n + t(' 条轨'), n ? 'ok' : 'warn');
}
function autoDelPoint(pts: { beat: number; value: number }[], i: number) {
  if (!tr.value) return;
  store.setCurve(tr.value.id, curAbbr.value, pts.filter((_, k) => k !== i));
}

/* ------------------------------------------------------------ 轨道 */
function addTrack(engine) { store.addTrack(engine); }

/* ---- 轨列表：拖拽排序 / 静音 / 双击改名 / 右键菜单 ---- */
const dragId = ref('');
const dragOver = ref('');
function onTrackDragStart(id: string) { dragId.value = id; }
function onTrackDragEnd() { dragId.value = ''; dragOver.value = ''; }
function onTrackDrop(toId: string) {
  if (dragId.value && dragId.value !== toId) store.moveTrack(dragId.value, toId);
  onTrackDragEnd();
}
async function toggleMute(x: any) {
  store.patchTrack(x.id, { muted: !x.muted });
  await reloadTransport();          // 静音要立刻听得见：lane 是 load 时生成的
}
function renameTrack(x: any) {
  const next = window.prompt(t('轨道名称'), x.name || '');
  if (next == null) return;
  store.patchTrack(x.id, { name: String(next).trim() });
}
const trackMenu = ref<{ x: number; y: number; track: any } | null>(null);
function openTrackMenu(e: MouseEvent, x: any) {
  trackMenu.value = { x: e.clientX, y: e.clientY, track: x };
  store.selectTrack(x.id);
}
function closeTrackMenu() { trackMenu.value = null; }
function menuDuplicate(x: any) {
  // 复制轨：新 id + 深拷贝音符（引用共享会让两条轨编辑互相影响）
  const src = JSON.parse(JSON.stringify({ engine: x.engine, name: x.name, singer: x.singer, singerName: x.singerName,
    language: x.language, notes: x.notes, fx: x.fx, curves: x.curves, pitchCurve: x.pitchCurve, gainDb: x.gainDb }));
  store.pushUndo();
  const id = store.addTrack(src.engine);
  store.patchTrack(id, {
    name: (src.name || '') + t(' 副本'), singer: src.singer, singerName: src.singerName,
    language: src.language, gainDb: src.gainDb, pitchCurve: src.pitchCurve,
    // ★ 复制出来的音符要**换新 id**：沿用原 id 会让两条轨的 id 撞车，
    //   而 updateNote 是按 id 找第一条匹配的 → 编辑副本会改到原轨
    notes: src.notes.map((n: any) => ({ ...n, id: newNoteId() })), fx: src.fx, curves: src.curves,
  });
  closeTrackMenu();
}
/** 该引擎下已安装的声库（点选用）。空列表时给"去声库页签装"的提示。 */
function banksFor(engine: string) {
  return store.banks.filter((b) => b.engine === engine);
}
function onSingerPick(id: string, e: Event) {
  const dir = String((e.target as HTMLSelectElement).value || '');
  const hit = store.banks.find((b) => b.dir === dir);
  store.patchTrack(id, { singer: dir, singerName: hit ? hit.name : (dir ? String(dir).split(/[\\/]/).pop() || '' : '') });
}

function onSingerPath(id, e) {
  const d = e.target.value.trim();
  store.patchTrack(id, { singer: d, singerName: d ? d.split(/[\\/]/).pop() : '' });
}
function onEngine(id, e) { store.patchTrack(id, { engine: e.target.value }); }

/* ------------------------------------------------------------ 音符 */
/**
 * 交给钢琴卷帘的适配器。
 *
 * ★ 这里必须**完整实现 PianoRoll 文档里那份契约**（addNote / updateNote / moveNotes /
 *   setNotesDuration / removeNotes / setSelection / selectAll / pushUndo / undo / redo）。
 *   旧实现只给了 addNote/updateNote/removeNote/select/selectMany —— 于是箭头微调、
 *   Delete、Ctrl+A、Ctrl+Z、右键撤销这些操作在卷帘里**全部静默失效**
 *   （调用不存在的函数直接抛 TypeError，界面毫无变化）。
 *
 * 撤销语义：卷帘自己会在一次交互开始时调 `pushUndo()`，其余写入走 store；
 * 所以 store 侧的变更方法里**不**再重复入栈（拖拽一次 = 一步）。
 */
function rollApi() {
  const noteIds = () => (tr.value?.notes || []).map((n) => n.id);
  return {
    bpm: () => store.bpm,
    notes: () => tr.value?.notes || [],
    selectedId: () => store.selectedId,
    selectedIds: () => store.selectedIds,
    addNote: (b, p) => store.addNote(b, p),
    updateNote: (id, patch) => store.updateNote(id, patch),
    removeNote: (id) => store.removeNote(id),
    removeNotes: (ids) => { (ids || []).forEach((id) => store.removeNote(id)); },
    moveNotes: (ids, dBeat, dPitch) => {
      for (const id of ids || []) {
        const n = (tr.value?.notes || []).find((x) => x.id === id);
        if (!n) continue;
        store.updateNote(id, {
          startBeat: Math.max(0, n.startBeat + dBeat),
          pitch: Math.max(0, Math.min(127, n.pitch + dPitch)),
        });
      }
    },
    setNotesDuration: (ids, durBeat) => {
      for (const id of ids || []) store.updateNote(id, { durBeat: Math.max(0.125, durBeat) });
    },
    select: (id, add) => store.select(id, add),
    selectMany: (ids) => store.selectMany(ids),
    setSelection: (ids, primary) => {
      store.selectMany(ids || []);
      store.select(primary ?? (ids && ids.length ? ids[0] : null));
    },
    selectAll: () => store.selectMany(noteIds()),
    getPitchPoints: () => (tr.value?.pitchCurve || []).map((p) => ({ beat: p.beat, cents: p.cents })),
    setPitchPoints: (pts) => store.setPitchCurve((pts || []).map((p) => ({ beat: p.beat, cents: p.cents }))),
    pushUndo: () => store.pushUndo(),
    undo: () => store.undo(),
    redo: () => store.redo(),
    /* 卷帘里的"轻提示"（比如剪贴板是空的）也走统一出口，别让它静默失败 */
    hint: (m: string) => say(m, 'info'),
    /* 播放头拍位：切分/粘贴以它为准（与传输栏的时间码同一个钟） */
    playheadBeat: () => playheadBeat.value,
  };
}

/* ------------------------------------------------------------ 工程级参数（P2-3） */
/** 对齐偏移的**待应用**值（真正落盘的是 store.meta.alignMs） */
const alignMs = ref(Number(store.meta.alignMs) || 0);
/** 拍号：只驱动卷帘的小节线，不改数据 */
const beatsPerBar = computed(() => {
  const s = String(store.meta.timeSig || '4/4');
  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return 4;
  const num = Number(m[1]);
  // 6/8 这类"以八分音符为一拍"的拍号：卷帘的时间单位是四分音符，
  // 所以一个小节 = num * 4/den 个四分音符（6/8 → 3 个四分音符），而不是 6 个。
  const den = Number(m[2]) || 4;
  const beats = num * (4 / den);
  return beats >= 1 && beats <= 16 ? Math.round(beats) : 4;
});
function onTimeSig(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  store.meta = Object.assign({}, store.meta, { timeSig: v });
  say(t('拍号已改为 ') + v + t('（只影响小节线，音符没动）'), 'info');
}
/** 把当前轨的音符整体平移 alignMs 毫秒（按当前 BPM 折算成拍），可撤销 */
function applyAlign() {
  const track = tr.value;
  if (!track || track.kind !== 'voice') { sayErr(t('先选中一条声部轨'), t('伴奏轨是音频，挪了就对不上拍子。')); return; }
  const n = store.shiftNotesByMs(alignMs.value, track.id);
  if (!n) { say(t('偏移量为 0，什么都没改'), 'info'); return; }
  say(t('已把 ') + String(n) + t(' 个音符整体平移 ') + String(alignMs.value) + t(' ms'), 'ok',
    { hint: t('Ctrl+Z 可以撤销。'), action: { label: t('撤销'), run: () => store.undo() } });
}

/* ------------------------------------------------------------ 参数车道（P2-4）
 * 表格加点保留（精确输入用），同时把它画成可拖拽车道：只在打开「自动化」页签时给车道，
 * 免得平时白占一条 70px 的高度。 */
const autoLane = computed<any>(() => {
  const t0 = tr.value;
  if (!t0 || propsTab.value !== 'auto') return null;
  const tgt: any = curTarget.value || {};
  const curve: any = curCurve.value;
  return {
    abbr: curAbbr.value,
    label: (tgt.label || curAbbr.value) + (tgt.unit ? ' (' + tgt.unit + ')' : ''),
    min: Number.isFinite(tgt.min) ? tgt.min : 0,
    max: Number.isFinite(tgt.max) ? tgt.max : 100,
    def: Number.isFinite(tgt.def) ? tgt.def : defaultFor(curAbbr.value),
    unit: tgt.unit || '',
    points: ((curve && curve.points) || []).map((p: any) => ({ beat: p.beat, value: p.value })),
  };
});
/** 车道拖拽结果落库：排序与钳制交给 store 的 normalizeCurve */
function onAutoLane(pts: any[]) {
  const t0 = tr.value;
  if (!t0) return;
  store.setCurve(t0.id, curAbbr.value, (pts || []).map((p: any) => ({ beat: p.beat, value: p.value })));
}

/* ------------------------------------------------------------ 音素级编辑（P2-2）
 * 条带上点一个音素 → 这里改**那一个音素**的表达式。
 *
 * ★ 与音符级字段的分工：音符级值会落到该音符的每个音素；这里按下标单独覆盖，
 *   引擎侧（build_part）让音素级优先。所以「辅音轻、元音亮」可以同时成立。
 * ★ 下标来自 core/phoneme.js 的派生（与条带绘制同一套），是**估计**：
 *   引擎真正的音素切分以声库 oto 为准；下标越界时引擎会忽略，不会渲染失败。
 */
const PH_EXPRS: { abbr: string; label: string; min: number; max: number; def: number; hint: string }[] = [
  { abbr: 'vol', label: '音量 VOL', min: 0, max: 100, def: 100, hint: '表情级音量（100 = 原样，不是衰减量）' },
  { abbr: 'vel', label: '力度 VEL', min: 0, max: 100, def: 100, hint: '辅音速度与力度，越小越柔' },
  { abbr: 'dyn', label: '力度曲线 DYN', min: -240, max: 120, def: 0, hint: '音量曲线偏移（-240 ~ 120）' },
  { abbr: 'atk', label: '起音 ATK', min: 0, max: 100, def: 100, hint: '音符开头的咬字力度' },
  { abbr: 'dec', label: '衰减 DEC', min: 0, max: 100, def: 100, hint: '越小收得越快' },
  { abbr: 'shft', label: '音高偏移 SHFT', min: 0, max: 100, def: 0, hint: '音高偏移量（0 ~ 100）' },
  { abbr: 'clr', label: '语音色 CLR', min: 0, max: 99, def: 0, hint: '语音色选项下标；声库没有多语音色时保持 0' },
];
const selPh = ref<{ noteId: string; index: number; text: string } | null>(null);
/** 面板当前作用的音符：优先用条带上点选的那个，否则跟随卷帘选中的音符 */
const phNote = computed<any>(() => {
  const id = (selPh.value && selPh.value.noteId) || store.selectedId;
  return (tr.value?.notes || []).find((n: any) => n.id === id) || null;
});
/** 该音符的音素列表（与条带同一套派生） */
const phItems = computed<any[]>(() => { const n = phNote.value; return n ? notePhonemes(n) : []; });
/** 当前下标；没点过条带时默认第一个音素 */
const phIndex = computed<number>(() => {
  if (selPh.value && phNote.value && selPh.value.noteId === phNote.value.id) return selPh.value.index;
  return phItems.value.length ? 0 : -1;
});
const phCur = computed<any>(() => (phIndex.value >= 0 ? phItems.value[phIndex.value] : null));
/** 当前音素上已设的覆盖值 */
const phVals = computed<Record<string, number>>(() => {
  const n = phNote.value;
  if (!n || phIndex.value < 0) return {};
  return (n.phExpressions || {})[String(phIndex.value)] || {};
});
const phOverrideCount = computed(() => Object.keys(phVals.value).length);
/** 条带上点选音素（组件发上来的事件；点空白发 null） */
function onPickPhoneme(p: any) {
  selPh.value = p && p.noteId != null
    ? { noteId: p.noteId, index: Number(p.index) || 0, text: String(p.text || '') }
    : null;
}
function pickPhonemeIndex(i: number) {
  const n = phNote.value;
  if (!n) return;
  const it = phItems.value[i];
  store.select(n.id);
  selPh.value = { noteId: n.id, index: i, text: (it && it.text) || '' };
}
function setPhExpr(abbr: string, e: Event) {
  const n = phNote.value;
  if (!n) return;
  const el = e.target as HTMLInputElement;
  const raw = String(el.value).trim();
  if (!raw) { store.setPhonemeExpression(n.id, phIndex.value, abbr, null); return; }
  const val = Number(raw);
  if (!Number.isFinite(val)) { el.value = String(phVals.value[abbr] ?? ''); return; }
  store.setPhonemeExpression(n.id, phIndex.value, abbr, val);
}
function clearPhExpr() {
  const n = phNote.value;
  if (!n) return;
  store.clearPhonemeExpressions(n.id, phIndex.value);
  say(t('已清空该音素的覆盖，回到音符/轨道默认值'), 'ok');
}

/* ------------------------------------------------------------ 多选批量操作（P2-1）
 * 卷帘负责"几何"（复制/切分/合并/拖动），这里负责"内容"：批量填词与力度斜坡。
 * 两者都要求先有多选，否则提示怎么多选 —— 不静默失败。 */
/* ------------------------------------------------------------ 多轨叠置（卷帘） */
/**
 * 卷帘里要不要同时显示其它声部（ghost notes）。
 *
 * ★ 为什么需要：和声/叠唱是「对着另一条轨写」的活。以前卷帘只画当前轨，
 *   第二条轨一选中，第一条就整条消失 —— 对不上拍、对不上字全靠耳朵记。
 *   现在默认叠置（与 FL Studio 的 ghost notes、Ableton 多片段编辑同一个思路）。
 */
/*
 * ★ 音符区默认**吃掉编辑区的剩余高度**（原来固定 320px，在 1440p 上只占一小块，
 *   用户反馈「音符视图面积太小」）。这里给两档：
 *   · 自动（默认）：flex:1 铺满剩余空间，行高由卷帘自己按可用高度自适应；
 *   · 手动：用户拖过分隔条之后按像素固定（存 localStorage），双击分隔条恢复自动。
 */
const rollManualH = ref(Number(localStorage.getItem('fufumidi_roll_h')) || 0);
const rollBoxStyle = computed(() => (rollManualH.value >= 160 ? { flex: 'none', height: rollManualH.value + 'px' } : {}));
/*
 * 详情面板（歌词/音素/曲线）默认**收起**：它们加起来 350px+，全展开时会把音符区挤到
 * 只剩一条缝（实测固定高度时甚至压到 2px —— 卷帘直接看不见）。
 * 收起后音符区吃满编辑区；选中音符时下面给一条单行「已选音符」摘要，点「显示详情」再展开。
 */
const detailOpen = ref(localStorage.getItem('fufumidi_sing_detail') === '1');
watch(detailOpen, (v) => { try { localStorage.setItem('fufumidi_sing_detail', v ? '1' : '0'); } catch (e) {} });
/** 拖分隔条：往上拖 = 音符区更高。拖过就算手动档，双击恢复自动 */
function startRollResize(e: PointerEvent) {
  const box = document.querySelector('.roll-box') as HTMLElement | null;
  if (!box) return;
  const startY = e.clientY, startH = box.getBoundingClientRect().height;
  const move = (ev: PointerEvent) => {
    const h = Math.round(Math.max(160, Math.min(window.innerHeight - 160, startH + (ev.clientY - startY))));
    rollManualH.value = h;
    rollH.value = h;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    try { localStorage.setItem('fufumidi_roll_h', String(rollManualH.value)); } catch (err) {}
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
function resetRollHeight() {
  rollManualH.value = 0;
  try { localStorage.removeItem('fufumidi_roll_h'); } catch (e) {}
}

const rollOverlay = ref(localStorage.getItem('fufumidi_roll_overlay') !== '0');
watch(rollOverlay, (v) => { try { localStorage.setItem('fufumidi_roll_overlay', v ? '1' : '0'); } catch (e) {} });
const rollGhostLabels = ref(localStorage.getItem('fufumidi_roll_ghostlyric') !== '0');
watch(rollGhostLabels, (v) => { try { localStorage.setItem('fufumidi_roll_ghostlyric', v ? '1' : '0'); } catch (e) {} });

/** 声部轨（叠置只对声部有意义；伴奏轨没有音符） */
const voiceTracks = computed<any[]>(() => (store.tracks || []).filter(t => t.kind !== 'audio'));
/** 传给卷帘的轨道表：含当前轨，顺序与左侧轨列表一致 */
/** 卷帘的像素高度：只有「手动档」才给具体值（自动档走 fill） */
const rollH = ref(rollManualH.value || 0);
watch(rollManualH, (v) => { rollH.value = v || 0; });

const rollTracks = computed<any[]>(() => voiceTracks.value.map((t, i) => ({
  id: t.id, name: t.name, color: trackColorOf(t, i), notes: t.notes || [],
  hidden: store.rollHidden.includes(t.id),
})));
function colorOf(t: any) {
  const i = voiceTracks.value.indexOf(t);
  return trackColorOf(t, i < 0 ? 0 : i);
}
/**
 * 卷帘里点到了别的轨的音符：把那条轨切成当前轨、并把这个音符选上。
 *
 * ★ 不在卷帘里跨轨改数据：编辑 api 是「按当前轨」注入的（`rollApi()` 只认 tr 的音符），
 *   跨轨拖动必须换轨后由新的 api 接手 —— 这样撤销栈、渲染过期标记也都跟着走对的那条轨。
 */
function onPickGhostNote(e: any) {
  if (!e || !e.trackId) return;
  if (e.trackId !== store.activeTrackId) store.selectTrack(e.trackId);
  if (e.noteId) store.select(e.noteId);
}

const selNotes = computed<any[]>(() => {
  const ids = store.selectedIds;
  return (tr.value?.notes || []).filter((n: any) => ids.includes(n.id))
    .slice().sort((a: any, b: any) => a.startBeat - b.startBeat);
});
function needMulti(): boolean {
  if (selNotes.value.length >= 2) return true;
  sayErr(t('这个操作需要先选中 2 个以上音符'), t('在卷帘里框选，或按 Ctrl+A 全选。'));
  return false;
}
/** 批量填词：空格分词 → 按音符顺序依次填；只有一个词时所有音符都用它 */
async function batchLyric() {
  if (!needMulti()) return;
  const list = selNotes.value;
  const s = await app.promptDialog({
    title: t('批量填词'),
    msg: t('用空格分词，按音符先后依次填。只填一个词时所有音符都用这个词。'),
    value: '',
    okText: t('填词'),
  });
  if (s == null) return;
  const words = String(s).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return;
  store.pushUndo();
  list.forEach((n: any, i: number) => {
    store.updateNote(n.id, { lyric: words.length === 1 ? words[0] : words[Math.min(i, words.length - 1)] });
  });
  if (words.length > 1 && words.length < list.length) {
    say(t('已填词，但词比音符少：后面 ') + String(list.length - words.length) + t(' 个音符沿用了最后一个词'), 'warn');
  } else {
    say(t('已批量填词：') + String(words.length) + t(' 个词 → ') + String(list.length) + t(' 个音符'), 'ok');
  }
}
/**
 * 力度斜坡：渐强 20→100 / 渐弱 100→20。
 * UTAU 走 velocity（0..100），DiffSinger 走 dyn（-240..120，0 为默认）——
 * 两条引擎的"力度"语义完全不同，所以映射写在这里而不是让用户自己算。
 */
function rampVelocity(dir: 1 | -1) {
  if (!needMulti()) return;
  const list = selNotes.value;
  const n = list.length;
  store.pushUndo();
  list.forEach((note: any, i: number) => {
    const k = n <= 1 ? 1 : i / (n - 1);
    const v = dir > 0 ? 20 + 80 * k : 100 - 80 * k;
    if (isUtau.value) store.updateNote(note.id, { velocity: Math.round(v) });
    else store.updateNote(note.id, { dyn: Math.round(-120 + (v / 100) * 240) });
  });
  say(dir > 0 ? t('已按音符顺序渐强（20 → 100）') : t('已按音符顺序渐弱（100 → 20）'), 'ok');
}

/* ------------------------------------------------------------ 声库别名可用性（P2-5）
 * 渲染引擎只有在渲完之后才把"这个词不在声库别名表里"塞进 warnings ——
 * 那时已经等了几十秒。这里把**同一个别名表**提前取来（主进程的 utau:aliases），
 * 一边打字一边标红，并给出相近别名建议。
 * ★ 取不到别名表（engine 缺失 / 非 UTAU 轨）时**什么都不显示**，绝不误报。 */
const aliasSet = ref<Set<string> | null>(null);
const aliasFor = ref('');                 // 别名集对应的声库目录（换歌手要重取）
let aliasBusy = false;
watch([() => tr.value?.singer, () => tr.value?.engine], async ([dir, eng]) => {
  aliasSet.value = null; aliasFor.value = '';
  const b = window.fuBridge as any;
  if (!dir || eng !== 'utau' || !b || typeof b.utauAliases !== 'function' || aliasBusy) return;
  aliasBusy = true;
  try {
    const r = await b.utauAliases({ voicebank: dir, limit: 2000 });
    if (r && r.ok && Array.isArray(r.aliases)) {
      aliasSet.value = new Set(r.aliases.map((x: string) => String(x).toLowerCase()));
      aliasFor.value = dir;
    }
  } catch (_) { /* 拿不到就不提示：这是增强功能，不该挡住编辑 */ }
  finally { aliasBusy = false; }
}, { immediate: true });

/** 本轨里"歌词不在别名表里"的音符（空歌词不算，引擎会用默认元音） */
const missingLyrics = computed<any[]>(() => {
  const set = aliasSet.value;
  const t0 = tr.value;
  if (!set || !t0 || t0.kind !== 'voice' || t0.engine !== 'utau') return [];
  return (t0.notes || []).filter((n: any) => n.lyric && !set.has(String(n.lyric).toLowerCase()));
});
const selLyricMissing = computed(() => {
  const set = aliasSet.value;
  const n = sel.value;
  if (!set || !n || !n.lyric) return false;
  return !set.has(String(n.lyric).toLowerCase());
});
/** 相近别名（前缀互含 + 去掉音高后缀后相同）：够用且不引入编辑距离的复杂度 */
function suggestAliases(text: string, limit = 6): string[] {
  const set = aliasSet.value;
  if (!set || !text) return [];
  const low = String(text).toLowerCase();
  const bare = low.replace(/[_,-]?[a-g]#?-?\d?$/i, '');
  const out: string[] = [];
  for (const a of set) {
    if (a === low) continue;
    if (a.startsWith(low) || low.startsWith(a) || (bare && a.replace(/[_,-]?[a-g]#?-?\d?$/i, '') === bare)) {
      out.push(a);
      if (out.length >= limit) break;
    }
  }
  return out;
}
function gotoFirstMissing() {
  const first = missingLyrics.value[0];
  if (!first) return;
  store.select(first.id);
  say(t('已选中第一个待修音符：') + (first.lyric || ''), 'info', { hint: t('可以点下面的相近别名直接替换，或改成声库里有的发音。') });
}

/* ------------------------------------------------------------ 播放头 / 音阶高亮（P2-1）
 * 播放头是"当前时刻在时间轴上的位置"，卷帘拿它画竖线，并以它为切分/粘贴的落点。
 * 换算用工程 BPM：拍 = 秒 × BPM / 60。 */
const playheadBeat = computed(() => Math.max(0, (tpos.value / 1000) * (store.bpm / 60)));

/**
 * 音阶高亮（P2-1）：只做视觉分区，不改数据。
 * 默认按工程调（store.meta.key 若有），没有就关闭 —— 不做"猜调"这种事。
 */
const scale = ref<{ root: number; type: string } | null>(null);
try {
  const raw = localStorage.getItem('fufumidi_sing_scale');
  if (raw && raw !== 'off') scale.value = JSON.parse(raw);
} catch (_) { /* 脏值忽略 */ }
function onRollScale(type: string) {
  if (!type || type === 'off') scale.value = null;
  else scale.value = { root: scale.value ? scale.value.root : 0, type };
  try { localStorage.setItem('fufumidi_sing_scale', scale.value ? JSON.stringify(scale.value) : 'off'); } catch (_) {}
}
function onRollScaleRoot(root: number) {
  if (!scale.value) return;
  scale.value = { root: Number(root) || 0, type: scale.value.type };
  try { localStorage.setItem('fufumidi_sing_scale', JSON.stringify(scale.value)); } catch (_) {}
}

/** 页面级快捷键：卷帘有焦点时它自己处理，这里负责"没点进卷帘也能用"的那部分 */
function onSingKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  const mod = e.ctrlKey || e.metaKey;
  /* ★ 卷帘自己也监听 window.keydown（PianoRoll.onKey），撤销/重做两边都会响应 →
     一次 Ctrl+Z 走两步历史：实测「导入 713 音符 → 批量填词 → Ctrl+Z」直接变成 0 音符。
     这里让出这几组键：焦点在卷帘里时归卷帘管，其余情况归本页管。 */
  const inRoll = !!el && typeof (el as any).closest === 'function' && !!(el as any).closest('.pr');
  if (mod && !typing && !inRoll && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) store.redo(); else store.undo();
    return;
  }
  if (mod && !typing && !inRoll && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void saveProject(false); return; }
  if (typing) return;
  if (e.key === ' ') { e.preventDefault(); void tplay(); return; }
  if (e.key === 'Enter') { e.preventDefault(); if (!renderBlocked.value) void doRender(); return; }
  if (e.key === '[') { setTab('editor'); return; }
  if (e.key === ']') { setTab('banks'); return; }
  /* P1-6：循环区间与跟随播放也要能用键盘 —— 一边听一边标点位时手不离键 */
  if (e.key.toLowerCase() === 'l') { e.preventDefault(); toggleLoop(); return; }
  if (e.key === ',') { e.preventDefault(); markLoop('a'); return; }
  if (e.key === '.') { e.preventDefault(); markLoop('b'); return; }
  if (e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFollow(); return; }
}

function onLyric(note, e) {
  const text = e.target.value;
  store.updateNote(note.id, { lyric: text });
  void askCands(note.id, text);
}

async function askCands(noteId, text) {
  cands.value = [];
  if (!text || !tr.value) return;
  candFor.value = noteId;
  try {
    const b = window.fuBridge;
    if (!b || typeof b.diffsingerSuggestLyric !== 'function') return;
    const r = await b.diffsingerSuggestLyric({
      text,
      language: tr.value.language,
      voicebank: tr.value.engine === 'diffsinger' ? tr.value.singer : '',
      limit: 10,
    });
    if (candFor.value !== noteId) return;          // 过期响应
    cands.value = (r && r.ok && r.items) || [];
  } catch (_) { /* 无 bridge 时静默 —— 候选是增强功能，不该挡住编辑 */ }
}

function pickCand(id, text) {
  store.updateNote(id, { lyric: text });
  cands.value = [];
}

/* ------------------------------------------------------------ 空态 / 渲染门禁 */

/**
 * 渲染按钮为什么点不动 —— 直接把原因写在按钮上。
 * 旧界面在"没选歌手 / 没音符"时按钮是灰的，但**不说为什么**，用户只能猜。
 */
const renderReason = computed<string>(() => {
  if (store.busy) return t('正在渲染…');
  const t0 = tr.value;
  if (!t0) return t('先在左侧新建或选中一条轨道');
  if (t0.kind === 'audio') return t('伴奏轨不需要渲染');
  if (!t0.notes.length) return t('这条轨还没有音符：导入 MIDI 或用画笔在卷帘上画');
  if (!t0.singer) return t('还没有选歌手：在顶栏的声库选择器里挑一个');
  return '';
});
const renderBlocked = computed(() => !!renderReason.value);

/** 编辑器空态：新工程（一条空声部轨、没渲染过任何东西）时给"三步走"而不是一片空白。
 *  ★ 不能用 `tracks.length === 0`：`clearAll()`/新建工程都会预置一条空 DiffSinger 轨。 */
const isEmptyProject = computed(() =>
  store.tracks.length === 1
  && store.tracks[0].kind === 'voice'
  && store.tracks[0].notes.length === 0
  && Object.keys(store.renderByTrack).length === 0
  && !store.projectPath);

/* ------------------------------------------------------------ 导入 */

const busyImport = ref(false);
const midiPick = ref<{ tracks: any[]; tpb: number; bpm: number } | null>(null);

/** 用 <audio> 探音频时长（Chromium 支持 mp3/wav/flac/m4a/ogg…） */
function probeDuration(path: string): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = 'file:///' + String(path).replace(/\\/g, '/');
    const done = (ms: number) => { a.src = ''; resolve(ms); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration * 1000 : 0);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);          // 兜底：某些格式探不出就用 0
    a.src = url;
  });
}

/** 导入音频 → 新建一条**伴奏轨**（对应上游 `UWavePart`） */
async function importAudio() {
  const b = window.fuBridge;
  if (!b || typeof b.pickAudio !== 'function') { sayErr(t('桌面版才能导入音频'), t('这是浏览器预览环境；请用 FuFumidi 桌面版打开。')); return; }
  busyImport.value = true;
  try {
    const path = await b.pickAudio();
    if (!path) return;
    const fileName = String(path).split(/[\\/]/).pop() || 'audio';
    const durMs = await probeDuration(path);
    store.addAudioTrack(path, fileName, durMs);
    if (durMs > 0) say(t('已导入伴奏：') + fileName, 'ok');
    else say(t('已导入伴奏（时长未探到，可能是浏览器不支持的编码）：') + fileName, 'warn',
      { hint: t('能播放，但进度条总长不准；换成 wav/mp3 再导一次即可。') });
  } catch (e) {
    sayErr(String((e as any)?.message || e), t('检查这个音频文件能否被系统播放器打开。'));
  } finally {
    busyImport.value = false;
  }
}

/** 导入 MIDI → 选轨 → 落进当前（或新建的）声部轨 */
async function importMidi() {
  const b = window.fuBridge;
  if (!b || typeof b.pickFile !== 'function') { sayErr(t('桌面版才能导入 MIDI'), t('这是浏览器预览环境；请用 FuFumidi 桌面版打开。')); return; }
  busyImport.value = true;
  try {
    const path = await b.pickFile({
      title: t('选择 MIDI'),
      filters: [{ name: 'MIDI', extensions: ['mid', 'midi', 'kar', 'rmi'] }],
    });
    if (!path) return;
    const bytes = await b.readBinary(path);
    if (!bytes) { sayErr(t('读取文件失败'), t('文件可能被占用或没有读取权限，换一个位置再试。')); return; }
    await openMidiBytes(bytes);
  } catch (e) {
    sayErr(String((e as any)?.message || e), t('确认它是标准 MIDI（.mid）；损坏或纯音频文件解析不了。'));
  } finally {
    busyImport.value = false;
  }
}

/**
 * MIDI 字节 → 解析 → 选轨（导入 MIDI 与「从曲库选」共用这一段）。
 *
 * 抽出来的原因：曲库里的 115 首本来就已经在数据目录里了，却只能走系统文件对话框
 * 重新找一遍文件 —— 实测时为了导入一首库里的歌，得先把它复制成 ASCII 路径再驱动对话框。
 */
async function openMidiBytes(bytes: any) {
  const { parseMidi, buildSong } = await import('../core/midi.js');
  const r = store.parseMidiTracks(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    buildSong, parseMidi);
  if (r.error) { sayErr(r.error, t('确认它是标准 MIDI（.mid）；损坏或纯音频文件解析不了。')); return; }
  const list = r.tracks || [];
  if (list.length === 1) {                       // 只有一条就不弹窗了
    applyPicked(list[0], r.tpb || 480, r.bpm || 120);
    return;
  }
  midiPick.value = { tracks: list, tpb: r.tpb || 480, bpm: r.bpm || 120 };
}

/* ------------------------------------------------------------ 从曲库选 MIDI（P1-12） */

const libDlg = ref<{ q: string } | null>(null);
/** 曲库里的 MIDI 曲目（app.songs 是唯一来源；每首都有 meta.path 指向真实 .mid 文件） */
const libSongs = computed<any[]>(() => {
  const q = (libDlg.value?.q || '').trim().toLowerCase();
  return ((app as any).songs || [])
    .filter((s: any) => (s.kind || 'midi') === 'midi')
    .filter((s: any) => !q || String(s.name || '').toLowerCase().includes(q))
    .slice(0, 400);
});

function openLibraryDialog() {
  libDlg.value = { q: '' };
}

async function importFromLibrary(song: any) {
  const b = window.fuBridge as any;
  const path = song && song.meta && song.meta.path;
  if (!path) { sayErr(t('这首曲目没有对应的 MIDI 文件'), t('可以在「资源管理」里跑一次曲库自检重建。')); return; }
  if (!b || typeof b.readBinary !== 'function') { sayErr(t('桌面版才能导入 MIDI')); return; }
  busyImport.value = true;
  try {
    const bytes = await b.readBinary(path);
    if (!bytes) { sayErr(t('读取文件失败') + '：' + path); return; }
    libDlg.value = null;
    await openMidiBytes(bytes);
    say(t('已从曲库载入「') + String(song.name || '') + t('」'), 'ok', { hint: t('下一步：选一条轨 → 选歌手 → 渲染。') });
  } catch (e: any) {
    sayErr(String((e && e.message) || e));
  } finally {
    busyImport.value = false;
  }
}

/** 落到当前声部轨；当前是音频轨/无轨时自动新建一条 DiffSinger 轨 */
function applyPicked(midiTrack: any, tpb: number, bpm: number) {
  let target = tr.value;
  if (!target || target.kind !== 'voice') {
    const id = store.addTrack('diffsinger');
    target = store.tracks.find(x => x.id === id) || null;
  }
  if (!target) { sayErr(t('无法创建轨道'), t('先去左侧「新建轨」建一条声部轨，再导入 MIDI。')); return; }
  const useTrack = monoPick.value && overlapCount(midiTrack) > 0
    ? { ...midiTrack, notes: monophonic(midiTrack.notes) }
    : midiTrack;
  const n = store.applyMidiTrack(target.id, useTrack, tpb, bpm, true);
  store.patchTrack(target.id, { name: target.name || midiTrack.name || '' });
  midiPick.value = null;
  say(t('已导入 ') + String(n) + t(' 个音符'), 'ok', { hint: t('下一步：选歌手 → 渲染。') });
  fitRollSoon();
}

/* ------------------------------------------------------------ 单音化（P1-6） */

/**
 * MIDI 导入时「只取最高音」。
 *
 * ★ 实测教训：`烦恼歌.mid` 里名为 voice 的轨其实是柱式和弦（713 音符、465 处同时发声），
 *   原样导入后每个 tick 上有 3~4 个音同时唱一个歌词 —— 必然糊。旋律线通常在最高声部，
 *   所以给一个一键单音化；默认开（复音轨本来就不该直接拿去唱）。
 */
const monoPick = ref(true);

/** 同一 tick 同时响的"多余"音符数（>0 即说明这是复音轨） */
function overlapCount(mt: any): number {
  const seen = new Set<number>();
  let dup = 0;
  for (const n of (mt && mt.notes) || []) {
    if (seen.has(n.start)) dup++; else seen.add(n.start);
  }
  return dup;
}

/** 单音化：同一 start 只留最高音，再按时间排序 */
function monophonic(notes: any[]): any[] {
  const best = new Map<number, any>();
  for (const n of notes || []) {
    const cur = best.get(n.start);
    if (!cur || n.midi > cur.midi) best.set(n.start, n);
  }
  return [...best.values()].sort((a, b) => a.start - b.start);
}

/** 导入后把卷帘缩放到"全曲入画"，否则 4 分钟的歌要横向滚十几屏（用户报的"音符显示不全"） */
function fitRollSoon() {
  setTimeout(() => {
    try { prRef.value?.fitView?.(); } catch (_) { /* 卷帘还没挂载就算了 */ }
  }, 120);
}

/* ------------------------------------------------------------ 批量填词对话框（P1-7/8） */

type LyricMode = 'auto' | 'char' | 'space' | 'line';
type FillMode = 'seq' | 'loop' | 'trim';
/** 对齐方式：seq=顺序（老行为）；spread=整首按比例；phrases=按乐句（P1：字数≠音符数时的正解） */
type AlignMode = 'seq' | 'spread' | 'phrases' | 'split';
const lyricDlg = ref<{ text: string; mode: LyricMode; fill: FillMode; align: AlignMode; gap: number;
                            alts?: string[][]; altsFrom?: string[] } | null>(null);

/** 多音字候选：与转换后的音节一一对应（长度 >1 的才是多音字） */
const heteroList = computed(() => {
  const d = lyricDlg.value;
  if (!d || !d.alts || !d.alts.length) return [];
  const toks = d.text.split(/\s+/).filter(Boolean);
  const out: { index: number; ch: string; current: string; options: string[] }[] = [];
  d.alts.forEach((opts, i) => {
    if (!opts || opts.length < 2) return;
    out.push({ index: i, ch: (d.altsFrom && d.altsFrom[i]) || '', current: toks[i] || '', options: opts.slice(0, 4) });
  });
  return out.slice(0, 16);
});
/** 点候选：替换第 index 个音节（不动其它字，用户可反复换） */
function pickPinyin(index: number, syl: string) {
  const d = lyricDlg.value;
  if (!d) return;
  const toks = d.text.split(/\s+/).filter(Boolean);
  if (index < 0 || index >= toks.length) return;
  toks[index] = syl;
  d.text = toks.join(' ');
  d.mode = 'space';
}
const pinyinBusy = ref(false);

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const isWordChar = (c: string) => /[0-9A-Za-z\u00C0-\u024F\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(c);

/**
 * 歌词分词。
 *
 * ★ 旧实现只有 `split(/\\s+/)` 一条规则：把中文歌词整段粘进去 = **一个词**，
 *   于是 713 个音符每个都被填上整段歌词（实测提示「已批量填词：1 个词 → 713 个音符」）；
 *   粘整首（带换行）则是每行一个词。中文歌词必须能逐字切。
 */
function tokenizeLyrics(text: string, mode: LyricMode): string[] {
  const s = String(text || '');
  if (mode === 'space') return s.trim().split(/\s+/).filter(Boolean);
  if (mode === 'line') return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (mode === 'char') return [...s].filter((c) => !/\s/.test(c) && isWordChar(c));
  // auto：中日韩逐字、拉丁按词、标点与空白当分隔符
  const out: string[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const ch of s) {
    if (CJK_RE.test(ch)) { flush(); out.push(ch); }
    else if (isWordChar(ch)) buf += ch;
    else flush();
  }
  flush();
  return out;
}
const lyricTokens = computed(() => tokenizeLyrics(lyricDlg.value?.text || '', lyricDlg.value?.mode || 'auto'));

function openLyricDialog(prefill = '') {
  if (!selNotes.value.length) {
    sayErr(t('先选中音符再填词'), t('在卷帘里框选，或先按 Ctrl+A 全选。'));
    return;
  }
  lyricDlg.value = { text: prefill, mode: 'auto', fill: 'seq', align: 'seq', gap: 1 };
}

function applyLyricDialog() {
  const d = lyricDlg.value;
  if (!d) return;
  const list = selNotes.value;
  const words = lyricTokens.value;
  if (!words.length) { sayErr(t('没有可用的词'), t('换个分词方式，或先把歌词粘进来。')); return; }
  store.pushUndo();
  let blank = 0;
  /* ★ 对齐方式（P1-8）：
     顺序填在「字数 ≠ 音符数」时一定错位 —— 实测烦恼歌 441 字 / 275 音符，顺序填只能唱到
     第 166 个字（副歌整段没词）。spread / phrases 把字按比例铺满全曲，首尾永远对得上。 */
  /* ★ 切开长音符：字比音符多时把长音对半切开，**一个字都不丢**（会改变音符个数）。
     实测《烦恼歌》441 字 / 275 音符：按乐句铺开会丢 166 个字且丢在句中
     （「不爱的不断打扰」→「不 的 断 打 你」），唱出来直接错词。 */
  if (d.align === 'split') {
    const ordered = [...list].sort((a: any, b: any) => (a.startBeat - b.startBeat));
    const r = splitNotesToFit(ordered, words, Math.max(0.125, Number(d.gap) || 1));
    const n = store.replaceNotes(tr.value!.id, r.pieces);
    say(t('按乐句切开长音符：') + String(r.phrases) + t(' 个乐句')
      + String(words.length) + t(' 个字 → ') + String(n) + t(' 个音符')
      + (r.added ? t('（切开 ') + String(r.added) + t(' 处）') : '')
      + (r.dropped ? t('（有 ') + String(r.dropped) + t(' 个字实在放不下，已跳过）') : ''),
      r.dropped ? 'warn' : 'ok',
      { hint: t('旋律节奏会因切分略有变化；想还原就按 Ctrl+Z。') });
    lyricDlg.value = null;
    return;
  }
  if (d.align !== 'seq') {
    const ordered = [...list].sort((a: any, b: any) => (a.startBeat - b.startBeat));
    const r = alignLyrics(ordered, words, d.align, Math.max(0.125, Number(d.gap) || 1));
    ordered.forEach((n: any, i: number) => {
      const w = r.lyrics[i] || '';
      if (!w) blank++;
      store.updateNote(n.id, { lyric: w });
    });
    const how = d.align === 'phrases'
      ? t('按乐句对齐：') + String(r.phrases) + t(' 个乐句')
      : t('整首按比例铺开：');
    say(how + String(words.length) + t(' 个字 → ') + String(ordered.length) + t(' 个音符')
        + (r.skipped ? t('（字数多，跳过 ') + String(r.skipped) + t(' 个字）') : '')
        + (r.repeated ? t('（音符多，重复 ') + String(r.repeated) + t(' 个字）') : ''),
        'ok', { hint: t('首尾已对齐；个别字想改，双击音符直接编辑。') });
    lyricDlg.value = null;
    return;
  }
  list.forEach((n: any, i: number) => {
    let w = '';
    if (i < words.length) w = words[i];
    else if (d.fill === 'loop') w = words[i % words.length];
    else if (d.fill === 'seq') w = words[words.length - 1];
    if (!w) blank++;
    store.updateNote(n.id, { lyric: w });
  });
  const extra = words.length > list.length ? words.length - list.length : 0;
  if (d.fill === 'seq' && words.length < list.length) {
    say(t('已填词，但词比音符少：后面 ') + String(list.length - words.length) + t(' 个音符沿用了最后一个词'),
        'warn', { hint: t('想让歌词循环填满就选「循环填」，想留空就选「只填到用完」。') });
  } else if (blank) {
    say(t('已填词：') + String(list.length - blank) + t(' 个音符有词，') + String(blank) + t(' 个留空'), 'ok');
  } else {
    say(t('已填词：') + String(words.length) + t(' 个词 → ') + String(list.length) + t(' 个音符')
        + (extra ? t('（多出的 ') + String(extra) + t(' 个词没用上）') : ''), 'ok');
  }
  lyricDlg.value = null;
}

/** 汉字 → 拼音（UTAU 中文声库要的是拼音别名；DS 引擎内部自己会转） */
async function toPinyin() {
  const d = lyricDlg.value;
  if (!d) return;
  const b = window.fuBridge as any;
  if (!b || typeof b.singToPinyin !== 'function') { sayErr(t('当前环境不支持转拼音'), t('请使用桌面版。')); return; }
  pinyinBusy.value = true;
  try {
    const from = lyricTokens.value.slice();
    // alternatives：pypinyin 的 heteronym 结果 —— 多音字给「换成…」候选，不用手打拼音
    const r = await b.singToPinyin({ tokens: lyricTokens.value, alternatives: true });
    if (!r || !r.ok) { sayErr(t('转拼音失败：') + ((r && r.error) || t('未知原因'))); return; }
    const syls: string[] = (r.syllables || []).filter(Boolean);
    d.text = syls.join(' ');
    d.mode = 'space';
    d.alts = Array.isArray(r.alternatives) ? r.alternatives : [];
    d.altsFrom = from;
    const nHetero = d.alts.filter((a: string[]) => a && a.length > 1).length;
    say(t('已转拼音：') + String(syls.length) + t(' 个音节')
        + (nHetero ? t('（其中 ') + String(nHetero) + t(' 个多音字可用下面的候选改）') : ''),
        'ok', { hint: nHetero ? t('多音字默认取最常见读音；不对就点候选。') : t('再点「填入」把拼音填给音符。') });
  } finally { pinyinBusy.value = false; }
}

/* ------------------------------------------------------------ 发音表（P1-14） */

const aliasDlg = ref<{ dir: string; all: string[]; q: string; loading: boolean; err: string } | null>(null);

async function openAliasDialog() {
  const b = window.fuBridge as any;
  const cur = tr.value;
  if (!cur || cur.engine !== 'utau') {
    sayErr(t('发音表只适用于 UTAU 声库'), t('DiffSinger 用声库自带的音素词典，不走别名表。'));
    return;
  }
  const dir = String(cur.singer || '');
  if (!dir) { sayErr(t('先选一个歌手'), t('在顶栏的声库选择器里挑一个。')); return; }
  aliasDlg.value = { dir, all: [], q: '', loading: true, err: '' };
  try {
    const r = await b.utauAliases({ voicebank: dir, limit: 5000 });
    if (aliasDlg.value) {
      if (r && r.ok && Array.isArray(r.aliases)) aliasDlg.value.all = r.aliases.map((x: string) => String(x));
      else aliasDlg.value.err = (r && r.error) || t('读取失败');
    }
  } catch (e: any) {
    if (aliasDlg.value) aliasDlg.value.err = String(e?.message || e);
  } finally {
    if (aliasDlg.value) aliasDlg.value.loading = false;
  }
}

const aliasFiltered = computed(() => {
  const d = aliasDlg.value;
  if (!d) return [] as string[];
  const q = d.q.trim().toLowerCase();
  const arr = q ? d.all.filter((a) => a.toLowerCase().includes(q)) : d.all;
  return arr.slice(0, 800);
});

/** 点别名：有选中音符就填给它，填词对话框开着就追加，否则复制到剪贴板 */
function useAlias(a: string) {
  const n = sel.value;
  if (n) {
    store.pushUndo();
    store.updateNote(n.id, { lyric: a });
    say(t('已把当前音符改成「') + a + t('」'), 'ok');
    return;
  }
  if (lyricDlg.value) {
    const d = lyricDlg.value;
    d.text = (d.text ? d.text.replace(/\s+$/, '') + ' ' : '') + a;
    d.mode = 'space';
    return;
  }
  void navigator.clipboard?.writeText(a).catch(() => {});
  say(t('已复制到剪贴板：') + a, 'info');
}

/* ------------------------------------------------------------ 歌词文件导入（P1-9） */

async function importLyricsFile() {
  const b = window.fuBridge as any;
  if (!b || typeof b.pickFile !== 'function') { sayErr(t('桌面版才能导入歌词文件'), t('这是浏览器预览环境。')); return; }
  const path = await b.pickFile({
    title: t('选择歌词文件'),
    filters: [{ name: '歌词', extensions: ['txt', 'lrc'] }],
  });
  if (!path) return;
  const bytes = await b.readBinary(path);
  if (!bytes) { sayErr(t('读取文件失败'), t('文件可能被占用或没有读取权限。')); return; }
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (const enc of ['utf-8', 'gbk', 'shift_jis']) {
    try { text = new TextDecoder(enc, { fatal: true }).decode(buf); break; } catch (_) { /* 换下一种编码 */ }
  }
  if (!text) text = new TextDecoder('utf-8').decode(buf);
  if (/\[\d{1,2}:\d{2}([.:]\d{1,3})?\]/.test(text)) { fillFromLrc(text); return; }
  openLyricDialog(text);
  say(t('已读入歌词文件') + '：' + t('确认分词与填充方式后点「填入」'), 'ok');
}

/** LRC：按时间戳把每一行分给该时间窗内的音符（自动对轴，省掉整首手填） */
function fillFromLrc(text: string) {
  const cur = tr.value;
  if (!cur || cur.kind !== 'voice') { sayErr(t('当前不是声部轨')); return; }
  const entries: { sec: number; line: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!body) continue;
    for (const m of stamps) {
      const frac = m[3] ? Number(('0.' + m[3])) : 0;
      entries.push({ sec: Number(m[1]) * 60 + Number(m[2]) + frac, line: body });
    }
  }
  if (!entries.length) { sayErr(t('没解析出 LRC 时间戳'), t('确认是 [mm:ss.xx] 开头的歌词文件。')); return; }
  entries.sort((a, b) => a.sec - b.sec);
  const spb = 60 / Math.max(20, store.bpm || 120);
  const notes = [...(cur.notes || [])].sort((a, b) => a.startBeat - b.startBeat);
  store.pushUndo();
  let filled = 0;
  for (let i = 0; i < entries.length; i++) {
    const from = entries[i].sec / spb;
    const to = i + 1 < entries.length ? entries[i + 1].sec / spb : Infinity;
    const words = tokenizeLyrics(entries[i].line, 'auto');
    const inWin = notes.filter((n) => n.startBeat >= from - 0.01 && n.startBeat < to);
    inWin.forEach((n, k) => {
      const w = words[k] || '';
      if (w) filled++;
      store.updateNote(n.id, { lyric: w });
    });
  }
  say(t('已按 LRC 时间轴填词：') + String(filled) + t(' 个音符'), 'ok',
      { hint: t('对不齐的话，用「对齐偏移」整体平移，或手动改个别音符。') });
}

/* ------------------------------------------------------------ 播放 */

/**
 * 同步播放：伴奏与渲染结果**同时起播**。
 *
 * ★ 用 Web Audio 而不是两个 `<audio>`：两条 `AudioBufferSourceNode` 共用一个
 *   `AudioContext` 时钟、同一个 `start(when, offset)` → **采样级同步**。
 *   （两个 <audio> 各自 play() 会有几十毫秒偏差且随时间漂移，对齐歌词时很难受。）
 */
const tpos = ref(0);                 // 播放位置 ms
const rate = ref(1);                 // 变速试听倍率（不改工程 BPM）
const tplaying = ref(false);
const tpending = ref(false);         // 正在解码

const transport = getTransport();
/* 循环区间 / 跟随播放 / 时间码跳转 —— P1-6 传输栏补的常用件 */
const loopOn = ref(false);
const loopA = ref(0);
const loopB = ref(0);
const follow = ref(localStorage.getItem('fufumidi_sing_follow') !== '0');
const prRef = ref<any>(null);        // 卷帘组件实例（只为读它暴露的 xOf / scrollEl）

transport.onTick = (ms, playing) => {
  tpos.value = ms;
  tplaying.value = playing;
  followTick(ms);                    // 跟随播放：把播放头留在可视区
};

/** 循环区间在进度条上的位置（百分比），没设区间就不画 */
const loopStyle = computed(() => {
  void tpos.value;   // 时长要装载后才知道；装载后必然开始推 tick，借它触发重算
  const d = transport.durationMs || 0;
  if (!d || loopB.value - loopA.value < 20) return null;
  const l = Math.max(0, Math.min(100, (loopA.value / d) * 100));
  const r = Math.max(0, Math.min(100, (loopB.value / d) * 100));
  return { left: l + '%', width: Math.max(0.4, r - l) + '%' };
});

function pushLoop() {
  transport.setLoop(loopA.value, loopB.value, loopOn.value);
  // 夹回真实时长后的值同步回 UI（拖动过长度、或时长为 0 时尤其重要）
  const l = transport.loop;
  loopA.value = l.a; loopB.value = l.b; loopOn.value = l.on;
}
/** A/B 取**当前播放位置** —— 一边听一边标，是设循环最省事的做法 */
function markLoop(which: 'a' | 'b') {
  const at = Math.round(tpos.value);
  if (which === 'a') loopA.value = at; else loopB.value = at;
  if (loopB.value - loopA.value >= 20) loopOn.value = true;
  pushLoop();
  if (which === 'a' && loopB.value <= loopA.value) say(t('A 点已设在 ') + fmtMs(loopA.value) + t('，再点「B」设终点'), 'info');
  else say(t('循环区间：') + fmtMs(loopA.value) + ' ~ ' + fmtMs(loopB.value), 'ok');
}
function toggleLoop() {
  if (loopB.value - loopA.value < 20) {
    sayErr(t('还没有可循环的区间'), t('先播到起点按「A」，再播到终点按「B」。'));
    return;
  }
  loopOn.value = !loopOn.value;
  pushLoop();
}
function clearLoopRegion() { loopA.value = 0; loopB.value = 0; loopOn.value = false; pushLoop(); }

function toggleFollow() {
  follow.value = !follow.value;
  try { localStorage.setItem('fufumidi_sing_follow', follow.value ? '1' : '0'); } catch (_) { /* 隐私模式忽略 */ }
  if (follow.value) followTick(tpos.value, true);
}
/**
 * 跟随播放：播放头靠近视口边缘时把卷帘滚过去。
 * ★ 像素换算交给卷帘自己（它暴露 `xOf(beat)`），这里只负责"什么时候滚"，
 *   免得两处各算一套小时宽然后对不上。
 */
function followTick(ms: number, force = false) {
  if (!follow.value && !force) return;
  if (!transport.playing && !force) return;
  const pr = prRef.value;
  const el = pr && pr.scrollEl;
  if (!el || typeof pr.xOf !== 'function') return;
  const beat = (ms / 1000) * (store.bpm / 60);
  const x = pr.xOf(beat);
  const pad = Math.max(60, el.clientWidth * 0.18);
  if (x < el.scrollLeft + pad || x > el.scrollLeft + el.clientWidth - pad) {
    el.scrollLeft = Math.max(0, x - el.clientWidth * 0.35);
  }
}

/** 时间码跳转：点时间显示 → 输入 m:ss.s */
function parseTimecode(s: string): number | null {
  const v = String(s || '').trim();
  if (!v) return null;
  const m = v.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n * 1000) : null;
}
async function jumpToTime() {
  const s = await app.promptDialog({
    title: t('跳转到时间'),
    msg: t('格式 m:ss.s（例如 1:23.4），也可以直接填秒数。'),
    value: fmtMs(tpos.value),
    okText: t('跳转'),
  });
  if (s == null) return;
  const ms = parseTimecode(s);
  if (ms == null) { sayErr(t('时间格式看不懂：') + s, t('用 m:ss.s，例如 1:23.4；或直接填 83.4 表示 83.4 秒。')); return; }
  transport.seek(ms);
  tpos.value = transport.positionMs;
}

/**
 * 一条轨要交给传输器的东西。
 *
 * ★ 效果链和自动化在这里落地：它们都是**播放时**才生效的东西，
 *   渲染管线不认识 `fx`（渲染出来的是干声），所以漏了这一步就会出现
 *   "面板上加了混响、听起来没变化"。
 */
function laneOf(t0: any): any {
  return {
    fx: (t0.fx || []).slice(),
    bpm: store.bpm || 120,
    volPoints: (curveOf(t0, 'VOL')?.points || []).slice(),
    panPoints: (curveOf(t0, 'PAN')?.points || []).slice(),
  };
}

/** 把所有音频轨 + 渲染结果装进传输器 */
async function reloadTransport(): Promise<string> {
  const b = window.fuBridge;
  const items: any[] = [];
  // 音频轨（伴奏）
  for (const t0 of store.tracks) {
    if (t0.kind !== 'audio' || !t0.audio?.path) continue;
    if (typeof b?.readBinary !== 'function') continue;
    try {
      const bytes = await b.readBinary(t0.audio.path);
      if (!bytes) continue;
      items.push({
        label: t0.audio.fileName, bytes,
        gainDb: t0.audio.gainDb, muted: t0.audio.muted,
        skipMs: t0.audio.skip, fadeIn: t0.audio.fadeIn, fadeOut: t0.audio.fadeOut,
        ...laneOf(t0),
      });
    } catch (_) { /* 单轨读失败不阻塞其它轨 */ }
  }
  // ★ 已渲染的**每一条**声部轨都进来 —— 只塞"最后一份"的话，渲第二条就会
  //   顶掉第一条，听感上永远只有一条人声。各自的静音 / 增益在这里生效。
  for (const t0 of store.tracks) {
    if (t0.kind === 'audio') continue;
    const vb = store.renderByTrack[t0.id];
    if (!vb) continue;
    items.push({
      label: t0.name || t0.singerName || t('渲染结果'),
      bytes: vb,
      gainDb: t0.gainDb || 0,
      muted: !!t0.muted,
      ...laneOf(t0),
    });
  }
  if (!items.length) return t('没有可播放的音频（先导入伴奏或渲染一次）');
  tpending.value = true;
  try {
    const n = await transport.load(items);
    // 装载后把当前倍率带回：新解出的 lane 还没起播，setRate 只改状态不会重起
    transport.setRate(rate.value);
    tpos.value = 0;
    return n ? '' : t('音频解码失败（可能是浏览器不支持的编码）');
  } finally {
    tpending.value = false;
  }
}

async function tplay() {
  if (transport.playing) { transport.pause(); return; }
  if (!transport.lanes.length) {
    const err = await reloadTransport();
    if (err) { sayErr(err, t('先渲染一次，或导入一个伴奏；也可以点传输栏的「重新装载」。')); return; }
  }
  transport.play();
  tplaying.value = transport.playing;
}
/** 重装后从头播（音频轨上的 ▶ 用） */
async function reloadThenPlay() {
  const err = await reloadTransport();
  if (err) { sayErr(err, t('先渲染一次，或导入一个伴奏；也可以点传输栏的「重新装载」。')); return; }
  transport.seek(0);
  transport.play();
  tplaying.value = transport.playing;
}


/** 变速：装载中的 lane 需要按新倍率重起（源节点的 playbackRate 是起播时定死的） */
async function setPlayRate(v: number) {
  const r = Math.max(0.25, Math.min(2, Number(v) || 1));
  rate.value = r;
  if (!transport.lanes.length) return;
  const wasPlaying = transport.playing;
  const at = transport.positionMs;
  await reloadTransport();          // 用新的 rate 重新装载（reloadTransport 会沿用 transport.rate）
  transport.seek(at);
  if (wasPlaying) { transport.play(); tplaying.value = transport.playing; }
}

function tstop() {
  transport.stop();
  tpos.value = 0;
}
function tseek(e: Event) {
  const ms = Number((e.target as HTMLInputElement).value);
  transport.seek(ms);
  tpos.value = ms;
}

/** 渲染完成后自动重装传输器，这样"渲完就能听" */
watch(() => store.renderUrl, () => { void reloadTransport(); });

/* 页面级快捷键只在「调教」页挂载期间生效（切走即摘掉） */
onMounted(() => {
  window.addEventListener('keydown', onSingKey);
  // 进页即拉声库列表：歌手选择器是**点选**的，列表为空就等于没法选歌手
  void store.loadBanks();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onSingKey));

const fmtMs = (ms: number) => {
  const s0 = Math.max(0, ms) / 1000;
  return Math.floor(s0 / 60) + ':' + String(Math.floor(s0 % 60)).padStart(2, '0')
    + '.' + String(Math.floor((s0 * 10) % 10));
};

/* ------------------------------------------------------------ 音高曲线 */
function curveAdd() {
  const t0 = tr.value;
  if (!t0) return;
  const last = t0.notes[t0.notes.length - 1];
  const beat = last ? Math.round((last.startBeat + last.durBeat / 2) * 4) / 4 : 0;
  const pts = t0.pitchCurve.slice();
  pts.push({ beat, cents: 0 });
  store.setPitchCurve(pts);
}
function curveClear() { store.clearPitchCurve(); }
/* ---------------- 音高曲线画布（M6，计划书 4.1 的头号项） ----------------
   以前只能「加点 + 敲两个数字」，现在可以在网格上直接画。
   落库走 store.setPitchCurve（它会镜像 PIT 子轨并 pushUndo），所以：
   拖动期间只 emit preview 更新本地副本，**抬手才 commit** —— 一次拖拽 = 一个撤销点。 */
const CURVE_TOOLS: [string, string][] = [['draw', '画笔'], ['line', '直线'], ['erase', '橡皮']];
const curveTool = ref('draw');
const curveCanvas = ref<any>(null);
/** 画布横轴的总拍数：跟着内容走，末尾留 4 拍余量 */
const curveBeats = computed(() => {
  const t0 = tr.value; if (!t0) return 16;
  let m = 16;
  for (const n of (t0.notes || [])) m = Math.max(m, (Number(n.startBeat) || 0) + (Number(n.durBeat) || 1));
  for (const p of (t0.pitchCurve || [])) m = Math.max(m, (Number(p.beat) || 0) + 2);
  return Math.ceil(m + 4);
});
const curveCents = computed(() => (tr.value && tr.value.pitchCurve ? tr.value.pitchCurve.length : 0));
function onCurveCommit(pts: { beat: number; value: number }[]) {
  store.setPitchCurve(pts.map((p) => ({ beat: p.beat, cents: p.value })));
}
/* ---- 自动化子轨也用同一块画布（M6b）：于是每条引擎参数都能直接画，不再只能敲数字 ---- */
const curveCanvasAuto = ref<any>(null);
function onAutoCurveCommit(pts: { beat: number; value: number }[]) {
  const t0 = tr.value; if (!t0) return;
  store.setCurve(t0.id, curAbbr.value, pts.map((p) => ({ beat: p.beat, value: p.value })));
}
/* ---------------- 颤音包络预览（M6b，计划书 §4.2） ----------------
   画的是这个音的颤音包络：振幅按 淡入(vibFade) 渐入、中间保持、末尾同样渐出，
   频率 vibFreq 是「每拍几次」—— 图上按音的时值 durBeat 换算成实际波数，所见即所听。 */
const vibCv = ref<HTMLCanvasElement | null>(null);
function vibVal(k: 'vibDepth' | 'vibFreq' | 'vibFade'): number {
  const n = sel.value ? Number((sel.value as any)[k]) : NaN;
  if (Number.isFinite(n)) return n;
  return k === 'vibDepth' ? 35 : (k === 'vibFreq' ? 5.5 : 0.25);
}
function drawVib() {
  const cv = vibCv.value; if (!cv) return;
  const w = cv.clientWidth || 320, h = 46;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = (n: string, fb: string) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  g.strokeStyle = css('--hairline', '#e6e6e6'); g.beginPath();
  g.moveTo(0, Math.round(h / 2) + 0.5); g.lineTo(w, Math.round(h / 2) + 0.5); g.stroke();
  if (!sel.value || !sel.value.vibrato) {
    g.fillStyle = css('--stone', '#9aa0a6'); g.font = '11px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t('颤音已关闭（勾上「颤音」即按下面的深度/速率/淡入生效）'), w / 2, h / 2);
    return;
  }
  const depth = Math.max(0, Math.min(100, vibVal('vibDepth'))) / 100;
  const freq = Math.max(0, vibVal('vibFreq'));
  const fade = Math.max(0, Math.min(0.9, vibVal('vibFade')));
  const dur = Math.max(0.125, Number(sel.value.durBeat) || 1);
  const cycles = Math.max(0.5, freq * dur);
  const amp = (h / 2 - 4) * depth;
  g.strokeStyle = css('--accent', '#ff5530'); g.lineWidth = 1.6; g.beginPath();
  for (let i = 0; i <= 200; i++) {
    const x = (i / 200) * w;
    // 淡入 / 淡出（两端各按 fade 比例）
    const k = i / 200;
    const env = Math.min(1, fade > 0 ? k / fade : 1, fade > 0 ? (1 - k) / fade : 1);
    const y = h / 2 - Math.sin(k * cycles * Math.PI * 2) * amp * Math.max(0, env);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}
watch([() => (sel.value ? sel.value.id : ''), () => vibVal('vibDepth'), () => vibVal('vibFreq'), () => vibVal('vibFade'), () => (sel.value ? sel.value.vibrato : false) || false],
  () => { nextTick(drawVib); }, { immediate: true });
function curveSet(i, e) {
  const t0 = tr.value;
  if (!t0) return;
  const pts = t0.pitchCurve.slice();
  const f = e.target.dataset.f;
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) return;
  if (f === 'beat') pts[i].beat = v; else pts[i].cents = v;
  store.setPitchCurve(pts);
}

/* ------------------------------------------------------------ 渲染 */
/**
 * 渲染 → **自动装载并试听**。
 *
 * 旧流程渲完只丢出一句话，用户还要自己找播放键、再等一次解码 ——
 * 一次"渲一下听听"要三步。现在渲完直接把传输器装满并起播（失败才只报错）。
 */
async function playAfterRender() {
  const err = await reloadTransport();
  if (err) { sayErr(err, t('渲染出的音频装载失败；点传输栏的「重新装载」再试。')); return; }
  transport.seek(0);
  transport.play();
  tplaying.value = transport.playing;
}

async function doRender() {
  const err = await store.renderTrack();
  if (err) { sayErr(err, t('看下面的渲染日志；常见原因是没选歌手、声库缺文件或引擎组件未装。'), store.renderWarnings.join('\n')); return; }
  // 渲完就能听：给「导出 WAV」一个动作按钮，省掉再找按钮这一步（P1-2）
  say(t('渲染完成，正在试听'), 'ok', { action: { label: t('导出 WAV'), run: () => doSave() } });
  await playAfterRender();
}

/**
 * 渲染所有声部轨。
 *
 * 渲染是串行的（两条 DiffSinger 同时跑会打满显存），一条几十秒，
 * 所以这里全程显示"正在渲染 i/n"（进度与分条文案都在 store 里），别让用户以为卡死了。
 */
async function doRenderAll() {
  const err = await store.renderAll();
  if (err) { sayErr(err, t('看下面的渲染日志；常见原因是没选歌手、声库缺文件或引擎组件未装。'), store.renderWarnings.join('\n')); return; }
  say(store.msg || t('全部轨渲染完成，正在试听'), 'ok', { action: { label: t('导出 WAV'), run: () => doSave() } });
  await playAfterRender();   // 全部渲完一次性装进传输器并起播
}

/** 静音要立刻听得见：改的是 lane 上的状态，而 lane 是 load() 时生成的 → 必须重装 */
async function onMuteVoice(x: any, e: Event) {
  store.patchTrack(x.id, { muted: !!(e.target as HTMLInputElement).checked });
  await reloadTransport();
}
async function onMuteAudio(x: any, e: Event) {
  store.patchAudio(x.id, { muted: !!(e.target as HTMLInputElement).checked });
  await reloadTransport();
}

/**
 * 导出当前轨的渲染结果（WAV）。
 *
 * ★ 实测两个坑（2026-10-06）：
 *   1. `exportBytes` 是 Pinia 的 **getter**，原来写成 `store.exportBytes()` 会直接抛
 *      `TypeError: store.exportBytes is not a function` —— 点「导出 WAV」毫无反应、也没有任何提示。
 *   2. 桌面版不能再走 `<a download>`：Electron 33 的下载子系统已失效
 *      （见 main/dialogs.js 的说明），应用里其他导出（MIDI / 视频 / 配置 / 乐谱）早就改走
 *      `file:saveBinary`，只有这里漏了。现在与它们统一。
 */
/** AudioBuffer → 16bit PCM WAV 字节（导出成品用；单轨导出直接给引擎回传的原始字节） */
function bufferToWav(buf: AudioBuffer): Uint8Array {
  const ch = Math.min(2, buf.numberOfChannels || 1);
  const n = buf.length;
  const bytes = new Uint8Array(44 + n * ch * 2);
  const dv = new DataView(bytes.buffer);
  const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); ws(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, buf.sampleRate, true); dv.setUint32(28, buf.sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const data: Float32Array[] = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return bytes;
}

/** 「导出 WAV」：
 *  - 有伴奏轨 / 有多条已渲染声部轨 → 导出**成品混音**（与播放听到的完全一致）；
 *  - 只有一条轨 → 仍然导出引擎回传的原始字节（不二次编码）。
 *  ★ 以前无论什么情况都只给「当前这一条轨」，用户要成品只能自己去外面混。
 */
async function doSave() {
  const b = store.exportBytes;
  const b2 = window.fuBridge as any;
  const save = async (name: string, data: Uint8Array): Promise<void> => {
    if (b2 && typeof b2.saveBinary === 'function') {
      // 直接传 Uint8Array（结构化克隆），避免 Array.from 生成数千万元素的数组
      const r = await b2.saveBinary({ name, data });
      if (r && r.ok) say(t('已保存到：') + String(r.path || name), 'ok');
      else if (!(r && r.canceled)) sayErr(t('保存失败：') + ((r && r.error) || t('未知原因')));
      return;
    }
    const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const hasAudio = store.tracks.some(x => x.kind === 'audio' && x.audio && !x.audio.muted);
  const rendered = store.renderedTrackIds.length;
  if (hasAudio || rendered > 1) {
    say(t('正在混音（伴奏 + 已渲染声部）…'), 'info');
    try {
      const err = await reloadTransport();
      if (err) { sayErr(err); return; }
      const buf = await (transport as any).renderOffline();
      if (!buf) { sayErr(t('混音失败'), t('先渲染一次，或导入一个伴奏。')); return; }
      await save((store.meta?.title || tr.value?.name || 'render') + '_mix.wav', bufferToWav(buf));
      return;
    } catch (e: any) {
      sayErr(t('混音失败：') + String((e && e.message) || e), t('已改回导出当前轨。'));
    }
  }
  if (!b) { sayErr(t('还没有可导出的音频'), t('先点「渲染本轨」（Enter）或「渲染全部轨」，再导出。')); return; }
  await save(((tr.value?.name || 'render') + '.wav'), b);
}

/* ------------------------------------------------------------ 工程文件 */
/**
 * `.fufumidi` 自包含工程包。
 *
 * 编辑器状态原本只在内存里，关掉就没了；伴奏轨存的又是本机绝对路径，
 * 换台机器必然断链。工程包把伴奏一起打进 `files/`，轨道上只留 asset id。
 */
async function saveProject(saveAs: boolean) {
  const err = await store.saveProject(saveAs);
  if (err) sayErr(err, t('换一个有写入权限的位置（例如桌面）再保存。'));
  else say(t('工程已保存：') + String(store.projectPath || '').split(/[\\/]/).pop(), 'ok');
}
async function openProject() {
  const err = await store.openProject();
  if (err) sayErr(err, t('工程包里的伴奏可能已损坏；也可以只导入 MIDI 重建工程。'));
  // 伴奏换成了包里解出来的那份 —— 传输器还握着旧字节，必须重装
  if (store.projectPath) await reloadTransport();
}
function newProject() {
  store.newProject();
}
function onTitle(e: Event) {
  store.meta = Object.assign({}, store.meta, { title: sval(e) });
}

/* ------------------------------------------------------------ 旧深链 */
/**
 * 合并前是 `#/utau` 与 `#/diffsinger` 两个入口，现在统一到 `#/singer`。
 * 老书签/内部跳转带 `?tab=utau|diffsinger` 时，这里据此新建并选中对应引擎的轨 ——
 * 不用改调用方（`setView('utau')` 之类照旧有效）。
 */
watch(() => route.query && route.query.tab, (q) => {
  const want = q === 'utau' ? 'utau' : q === 'diffsinger' ? 'diffsinger' : '';
  if (!want) return;
  const cur = store.activeTrack;
  if (cur && cur.engine === want) return;
  const hit = store.tracks.find(x => x.engine === want);
  if (hit) store.selectTrack(hit.id);
  else store.addTrack(want);
}, { immediate: true });

/* ------------------------------------------------------------ 小工具 */
const sval = (e) => (e && e.target ? e.target.value : e);
const nval = (e, d) => { const v = parseFloat(e && e.target ? e.target.value : e); return Number.isFinite(v) ? v : d; };
</script>

<template>
  <div class="sing-page">
    <!-- ==================== 页签：编辑器 / 声库 ====================
         两页合并后入口只有一个（顶栏「调教」），这里切工作台的两半。
         用 v-show 保留编辑器状态（卷帘滚动位置、选中音符）；声库面板按需挂载，进页即拉列表。 -->
    <div class="sing-nav">
      <button class="sn-tab" :class="{ on: tab === 'editor' }" data-guide="sing-tab-editor" @click="setTab('editor')">
        <Icon name="edit" :size="13" /> {{ t('编辑器') }}
        <i>{{ t('选歌手 · 画音符 · 渲染') }}</i>
      </button>
      <button class="sn-tab" :class="{ on: tab === 'banks' }" data-guide="sing-tab-banks" @click="setTab('banks')">
        <Icon name="box" :size="13" /> {{ t('声库') }}
        <i>{{ t('UTAU · DiffSinger · 组件') }}</i>
      </button>
      <!-- 声库制作原本是独立路由（/voicebank），现在与编辑器/声库并列成第三个页签：
           「做声库 / 装声库 / 用声库」本来就是同一条工作流。 -->
      <button class="sn-tab" :class="{ on: tab === 'maker' }" data-guide="sing-tab-maker" @click="setTab('maker')">
        <Icon name="mic" :size="13" /> {{ t('声库制作') }}
        <i>{{ t('切片 · 标注 · 导出') }}</i>
      </button>
      <span class="sp" />
    </div>

    <!-- 轨列表右键菜单（复制 / 清空 / 删除） -->
    <div v-if="trackMenu" class="tk-menu-mask" @click="closeTrackMenu" @contextmenu.prevent="closeTrackMenu"></div>
    <div v-if="trackMenu" class="tk-menu" :style="{ left: trackMenu.x + 'px', top: trackMenu.y + 'px' }" @click.stop>
      <b>{{ trackMenu.track.name || t('未命名轨') }}</b>
      <button @click="renameTrack(trackMenu.track); closeTrackMenu()"><Icon name="edit" :size="13" /> {{ t('重命名') }}</button>
      <button @click="menuDuplicate(trackMenu.track)"><Icon name="copy" :size="13" /> {{ t('复制这条轨') }}</button>
      <button @click="store.clearTrack(trackMenu.track.id); closeTrackMenu()"><Icon name="erase" :size="13" /> {{ t('清空音符') }}</button>
      <button class="danger" @click="store.removeTrack(trackMenu.track.id); closeTrackMenu()"><Icon name="trash" :size="13" /> {{ t('删除这条轨') }}</button>
    </div>

    <!-- 空态：没有任何轨道时给"三步走"，而不是让用户对着空白猜按钮 -->
    <div v-if="tab === 'editor' && isEmptyProject && !store.busy" class="sing-empty">
      <div class="se-main">
        <Icon name="utau" :size="18" />
        <b>{{ t('还没有轨道') }}</b>
        <span class="muted small">{{ t('新建声部轨 → 导入 MIDI 或用画笔写音符 → 选好声库点「渲染本轨」') }}</span>
      </div>
      <div class="se-acts">
        <button class="btn sm primary" @click="addTrack('diffsinger')"><Icon name="spark" :size="12" /> {{ t('新建 DiffSinger 轨') }}</button>
        <button class="btn sm" @click="addTrack('utau')"><Icon name="mic" :size="12" /> {{ t('新建 UTAU 轨') }}</button>
        <button class="btn sm" @click="openProject"><Icon name="folder" :size="12" /> {{ t('打开工程') }}</button>
        <button class="btn sm" @click="importMidi"><Icon name="import" :size="12" /> {{ t('导入 MIDI') }}</button>
        <button class="btn sm" @click="openLibraryDialog"><Icon name="folder" :size="12" /> {{ t('从曲库选') }}</button>
        <button class="btn sm" @click="setTab('banks')"><Icon name="box" :size="12" /> {{ t('装声库') }}</button>
      </div>
    </div>

    <div class="sing" v-show="tab === 'editor'">
    <!-- ==================== 左：轨道列表 ==================== -->
    <aside class="trk">
      <div class="trk-head">
        <Icon name="layers" :size="14" />
        <b>{{ t('轨道') }}</b>
        <span class="sp" />
        <button class="ib" :title="t('新建 UTAU 轨')" @click="addTrack('utau')">
          <Icon name="mic" :size="12" />
        </button>
        <button class="ib" :title="t('新建 DiffSinger 轨')" @click="addTrack('diffsinger')">
          <Icon name="spark" :size="12" />
        </button>
      </div>

      <!-- 导入：音频（伴奏轨，对应上游 UWavePart）与 MIDI -->
      <div class="trk-import">
        <button class="ib wide" data-guide="sing-import-audio" :disabled="busyImport" @click="importAudio">
          <Icon name="music" :size="12" /> {{ t('导入音频（伴奏）') }}
        </button>
        <button class="ib wide" data-guide="sing-import-midi" :disabled="busyImport" @click="importMidi">
          <Icon name="import" :size="12" /> {{ t('导入 MIDI') }}
        </button>
        <!-- 曲库里的 MIDI 本来就在数据目录里，没必要再走一次系统文件对话框 -->
        <button class="ib wide" data-guide="sing-import-library" :disabled="busyImport" @click="openLibraryDialog">
          <Icon name="folder" :size="12" /> {{ t('从曲库选') }}
        </button>
      </div>

      <div class="trk-list" data-guide="sing-tracks">
        <div
          v-for="(x, xi) in store.tracks" :key="x.id"
          class="trk-item" :class="{ on: x.id === store.activeTrackId, dragging: dragId === x.id }"
          :draggable="true"
          @click="store.selectTrack(x.id)"
          @dragstart="onTrackDragStart(x.id)"
          @dragover.prevent="dragOver = x.id"
          @dragleave="dragOver = (dragOver === x.id ? '' : dragOver)"
          @drop.prevent="onTrackDrop(x.id)"
          @dragend="onTrackDragEnd"
          @contextmenu.prevent="openTrackMenu($event, x)"
          @dblclick="renameTrack(x)"
        >
          <div class="trk-row1">
            <span class="tk-drag" :title="t('拖动排序')"><Icon name="drag" :size="11" /></span>
            <select class="eng" :value="x.engine" @click.stop @change="onEngine(x.id, $event)">
              <option v-for="e in ENGINES" :key="e.id" :value="e.id">{{ e.id === 'utau' ? 'UTAU' : 'DS' }}</option>
            </select>
            <input class="nm" :value="x.name" :placeholder="t('未命名轨（双击改名）')"
                   @click.stop @input="store.patchTrack(x.id, { name: sval($event) })" />
            <button class="ib" :class="{ on: !!x.muted }" :title="t('静音（M）')" @click.stop="toggleMute(x)">
              <Icon name="volume" :size="11" />
            </button>
            <button class="ib" :title="t('独奏：只留这一条出声（再点恢复）')" @click.stop="store.toggleSolo(x.id)">
              S
            </button>
            <button class="ib del" :title="t('删除轨')" @click.stop="store.removeTrack(x.id)">
              <Icon name="trash" :size="11" />
            </button>
          </div>
          <!-- 声部轨：选歌手 + 语言；音频轨：文件信息 + 静音 -->
          <template v-if="x.kind === 'voice'">
            <!-- 歌手选择：**点选**而不是手打路径。声库列表来自 store.banks（两类混排的同一份来源），
                 只列与该轨引擎匹配的那些；路径不在列表里时补一个"（原路径）"选项，避免静默清空。 -->
            <select class="pth" :value="x.singer || ''" :title="t('该轨使用哪个声库')"
                    @click.stop @change="onSingerPick(x.id, $event)">
              <option value="">{{ t('（未选歌手）') }}</option>
              <option v-if="x.singer && !banksFor(x.engine).includes(x.singer)" :value="x.singer">
                {{ x.singerName || String(x.singer).split(/[\\/]/).pop() }}
              </option>
              <option v-for="b in banksFor(x.engine)" :key="b.dir" :value="b.dir">{{ b.name }}</option>
            </select>
            <button class="ib" :title="t('刷新声库列表')" @click.stop="store.loadBanks()">
              <Icon name="refresh" :size="11" />
            </button>
            <!-- 发音表：放在轨道行里（而不是只在"已选 2 个音符"才出现的批量工具行），
                 因为"这个声库能唱哪些音"恰恰是**还没填词时**最需要查的 -->
            <button v-if="x.engine === 'utau'" class="ib" :title="t('发音表（这个声库支持哪些发音）')"
                    @click.stop="store.selectTrack(x.id); openAliasDialog()">
              <Icon name="music" :size="11" />
            </button>
            <div class="trk-row2" @click.stop>
              <select class="lang" :value="x.language" @click.stop
                      @change="store.patchTrack(x.id, { language: sval($event) })">
                <option v-for="L in LANGUAGES" :key="L.code" :value="L.code">{{ L.label }}</option>
              </select>
              <!-- 渲染状态：已渲染 ● / 已过期 ⚠（音符改过，听到的还是上一版） -->
              <span v-if="store.renderByTrack[x.id] && store.staleRenderIds.includes(x.id)" class="rdy stale"
                    :title="t('音符改过，渲染结果已过期 —— 点「渲染本轨」重渲才听得到')">⚠</span>
              <span v-else-if="store.renderByTrack[x.id]" class="rdy"
                    :title="t('已渲染，播放时会一起响')">●</span>
              <label class="ck" :title="t('静音')">
                <input type="checkbox" :checked="!!x.muted" @change="onMuteVoice(x, $event)" />
                <span>{{ t('静音') }}</span>
              </label>
              <span class="cnt">{{ x.notes.length }} {{ t('音符') }}</span>
            </div>
          </template>
          <template v-else>
            <div class="trk-row2" @click.stop>
              <span class="muted small" :title="x.audio?.path">
                {{ ((x.audio?.durationMs || 0) / 1000).toFixed(1) }}s
              </span>
              <label class="ck" :title="t('静音')">
                <input type="checkbox" :checked="!!x.audio?.muted"
                       @change="onMuteAudio(x, $event)" />
                <span>{{ t('静音') }}</span>
              </label>
              <button class="ib" :title="t('重装并从头播放')" @click="reloadThenPlay">
                <Icon name="play" :size="11" />
              </button>
            </div>
          </template>
        </div>
      </div>
    </aside>

    <!-- ==================== 右：共用编辑器 ==================== -->
    <section class="edt">
      <!-- 工程文件：新建 / 打开 / 保存 / 另存为 -->
      <div class="proj" data-guide="sing-project">
        <input class="ptitle" :value="store.meta.title" :placeholder="t('工程标题')"
               @change="onTitle" />
        <button class="btn" :title="t('新建一个空工程')" @click="newProject">
          <Icon name="plus" :size="12" /> {{ t('新建') }}
        </button>
        <button class="btn" :title="t('打开 .fufumidi 工程')" @click="openProject">
          <Icon name="folder" :size="12" /> {{ t('打开') }}
        </button>
        <button class="btn" :title="t('保存到当前工程文件')" @click="saveProject(false)">
          <Icon name="save" :size="12" /> {{ t('保存') }}
        </button>
        <button class="btn" :title="t('换一个文件保存')" @click="saveProject(true)">
          <Icon name="copy" :size="12" /> {{ t('另存为') }}
        </button>
        <!-- 工程级参数（P2-3）：BPM / 拍号 / 对齐偏移。三个都是**整个工程**的属性，
             所以放在工程条上，而不是藏在某条轨的属性里。 -->
        <label class="proj-field" :title="t('工程 BPM：音符位置存的是拍，改 BPM 时音符相对小节不动，只有时间长度变')">
          {{ t('BPM') }}
          <input type="number" min="1" max="400" :value="store.bpm" @change="store.bpm = nval($event, 120)" />
        </label>
        <label class="proj-field" :title="t('拍号：只改卷帘的小节线与编号，不动任何音符')">
          {{ t('拍号') }}
          <select :value="store.meta.timeSig || '4/4'" @change="onTimeSig($event)">
            <option value="2/4">2/4</option>
            <option value="3/4">3/4</option>
            <option value="4/4">4/4</option>
            <option value="6/8">6/8</option>
          </select>
        </label>
        <label class="proj-field" :title="t('对齐偏移：把音符整体平移 n 毫秒（负数=提前）。治“整首歌都抢一点/拖一点”')">
          {{ t('对齐偏移') }}
          <input class="al-ms" type="number" step="5" :value="alignMs" @change="alignMs = nval($event, 0)" />
          <span class="muted">ms</span>
        </label>
        <button class="btn" :disabled="!alignMs" :title="t('把这条轨的音符整体平移这么多毫秒（可撤销；伴奏轨不动）')"
                @click="applyAlign">
          <Icon name="target" :size="12" /> {{ t('应用') }}
        </button>
        <span class="sp" />
        <span class="ppath muted small" :title="store.projectPath || t('还没有保存过')">
          {{ store.projectPath ? String(store.projectPath).split(/[\\/]/).pop() : t('未保存') }}
        </span>
      </div>
      <ul v-if="store.missingAudio.length" class="warn small">
        <li v-for="m in store.missingAudio" :key="m.trackId">
          {{ t('伴奏文件缺失（工程包里没有或解包失败）：') }}{{ m.fileName }}
        </li>
      </ul>

      <div class="edt-bar">
        <template v-if="tr">
          <span class="tag" :class="isAudio ? 'e-audio' : 'e-' + tr.engine">
            {{ isAudio ? t('伴奏') : (tr.engine === 'utau' ? 'UTAU' : 'DiffSinger') }}
          </span>
          <span class="who">{{ isAudio ? (tr.audio?.fileName || tr.name) : (tr.singerName || tr.singer || t('未选歌手')) }}</span>
          <span v-if="!isAudio" class="muted small">{{ tr.language.toUpperCase() }} · {{ tr.notes.length }} {{ t('音符') }}</span>
        </template>
        <span v-else class="muted small">{{ t('左侧选一条轨道') }}</span>

        <span class="sp" />
        <!-- 撤销 / 重做：覆盖音符、轨道、效果链、自动化、轨名（页面级，见 store.history） -->
        <button class="ib" :disabled="!store.canUndo" :title="t('撤销 Ctrl+Z')" @click="store.undo()">
          <Icon name="undo" :size="13" />
        </button>
        <button class="ib" :disabled="!store.canRedo" :title="t('重做 Ctrl+Shift+Z')" @click="store.redo()">
          <Icon name="redo" :size="13" />
        </button>
        <button class="btn" data-guide="sing-track-props" :disabled="!tr" @click="propsOpen = !propsOpen">
          <Icon name="sliders" :size="13" /> {{ t('轨道属性') }}
        </button>
        <!-- 主动作：渲染本轨。禁用时把**原因**写在按钮上，不让用户猜 -->
        <button v-if="!isAudio" class="btn primary" data-guide="sing-render"
                :disabled="renderBlocked" :title="renderReason || t('按该轨的引擎自动分派')" @click="doRender">
          <Icon name="play" :size="13" /> {{ t('渲染本轨') }}
        </button>
        <button class="btn" data-guide="sing-render-all" :disabled="store.busy" @click="doRenderAll"
                :title="t('渲染所有声部轨，渲完一起播放')">
          <Icon name="zap" :size="13" /> {{ t('渲染全部轨') }}
        </button>
      </div>

      <!-- 渲染进行中：进度条 + 分条文案 + 取消入口（不然长曲只能干等） -->
      <div v-if="store.busy" class="edt-prog-wrap">
        <div class="edt-prog"><i :style="{ width: store.progress + '%' }" /></div>
        <span class="muted small">{{ store.msg || t('正在渲染…') }}</span>
        <button class="btn sm" :title="t('正在渲染的这一条不会被打断，它跑完即停')" @click="store.cancelRender">
          <Icon name="stop" :size="12" /> {{ t('停止后续渲染') }}
        </button>
      </div>
      <!-- 渲染门禁原因：只在"想渲但渲不了"时显示，平时不占位（提示本身走 app.toast，见 P1-4） -->
      <p v-if="renderReason && !store.busy && !isAudio" class="edt-msg small hint">
        {{ renderReason }}
      </p>
      <!-- P2-5：渲染前就把"歌词不在声库"标出来，别等渲完几十秒才在 warnings 里看到 -->
      <p v-if="missingLyrics.length" class="edt-msg small bad">
        <Icon name="info" :size="12" />
        {{ t('本轨有 ') }}{{ missingLyrics.length }}{{ t(' 个歌词不在声库别名表里（渲染时会被跳过或静音）') }}
        <button class="btn sm" @click="gotoFirstMissing"><Icon name="search" :size="12" /> {{ t('定位第一个') }}</button>
      </p>

      <!-- 传输栏：伴奏与渲染结果**同时播放**（Web Audio 单时钟，采样级同步） -->
      <div class="xport" data-guide="sing-transport">
        <button class="btn" :disabled="tpending" :title="t('播放 / 暂停')" @click="tplay">
          <Icon :name="tplaying ? 'pause' : 'play'" :size="13" />
        </button>
        <button class="btn" :title="t('停止（回到 0）')" @click="tstop">
          <Icon name="stop" :size="12" />
        </button>
        <!-- 进度条上叠一层循环区间色块：A/B 设在哪一眼可见 -->
        <div class="xbar-wrap">
          <i v-if="loopStyle" class="xbar-loop" :style="loopStyle" :class="{ on: loopOn }" />
          <input
            class="xbar" type="range" min="0" :max="Math.max(1, transport.durationMs)"
            :value="tpos" @input="tseek" :disabled="tpending"
          />
        </div>
        <!-- 时间码点一下就能跳（长曲里拖进度条很难对准） -->
        <button class="xtime small" :title="t('点击输入时间跳转')" @click="jumpToTime">
          {{ fmtMs(tpos) }} / {{ fmtMs(transport.durationMs) }}
        </button>
        <!-- 循环区间：A/B 都取当前播放位置；开着循环时到 B 自动回 A -->
        <button class="btn sm" :class="{ on: loopOn }" :title="t('循环区间开关（A/B 之间反复听）')" @click="toggleLoop">
          <Icon name="loop" :size="12" /> {{ t('循环') }}
        </button>
        <button class="btn sm" :title="t('把当前播放位置设为循环起点 A')" @click="markLoop('a')">A</button>
        <button class="btn sm" :title="t('把当前播放位置设为循环终点 B')" @click="markLoop('b')">B</button>
        <button v-if="loopB - loopA >= 20" class="btn sm ghost" :title="t('清除循环区间')" @click="clearLoopRegion">×</button>
        <!-- 跟随播放：播放头跑出可视区就自动滚过去 -->
        <button class="btn sm" :class="{ on: follow }" :title="t('跟随播放滚动卷帘')" @click="toggleFollow">
          <Icon name="target" :size="12" />
        </button>
        <button class="btn" :disabled="tpending" :title="t('重新装载伴奏与渲染结果')"
                @click="reloadTransport">
          <Icon name="refresh" :size="12" />
        </button>
        <!-- 变速试听：慢放核对咬字、快放通听全曲（与播放器里的变速互不影响） -->
        <select class="dev" :value="rate" :title="t('变速试听（不改工程 BPM）')"
                @change="setPlayRate(nval($event, 1))">
          <option :value="0.5">0.5×</option>
          <option :value="0.75">0.75×</option>
          <option :value="1">1.0×</option>
          <option :value="1.25">1.25×</option>
          <option :value="1.5">1.5×</option>
          <option :value="2">2.0×</option>
        </select>
        <span v-if="transport.lanes.length" class="muted small">
          {{ transport.lanes.length }} {{ t('条同时播放') }}
        </span>
        <button v-if="store.renderUrl" class="btn" @click="doSave">
          <Icon name="save" :size="12" /> {{ t('导出 WAV') }}
        </button>
      </div>
      <ul v-if="store.renderWarnings.length" class="warn small">
        <li v-for="(w, i) in store.renderWarnings" :key="i">{{ w }}</li>
      </ul>

      <!-- 轨道属性：参数 / 效果链 / 自动化（后两者都是**本轨独享**的） -->
      <div v-if="propsOpen && tr" class="tprops">
        <div class="tabs small">
          <button class="tab" :class="{ on: propsTab === 'params' }" @click="propsTab = 'params'">
            <Icon name="gear" :size="12" /> {{ t('参数') }}
          </button>
          <button class="tab" :class="{ on: propsTab === 'fx' }" @click="propsTab = 'fx'">
            <Icon name="spark" :size="12" /> {{ t('效果链') }}<span v-if="fxList.length" class="cnt">{{ fxList.length }}</span>
          </button>
          <button class="tab" :class="{ on: propsTab === 'auto' }" @click="propsTab = 'auto'">
            <Icon name="cclane" :size="12" /> {{ t('自动化') }}<span v-if="tr.curves && tr.curves.length" class="cnt">{{ tr.curves.length }}</span>
          </button>
          <span class="sp" />
          <button class="ib" :title="t('收起')" @click="propsOpen = false">×</button>
        </div>

        <!-- ── 参数 ── -->
        <div v-if="propsTab === 'params'" class="props small">
          <!-- 推理后端 / 采样音属于"这条轨怎么渲"，从顶栏下沉到这里 -->
          <label :title="t('推理后端：优先用哪个计算设备')">{{ t('推理后端') }}
            <select :value="store.device" @change="store.device = sval($event)">
              <option value="auto">{{ t('自动') }}</option>
              <option value="cpu">CPU</option>
              <option value="cuda">CUDA</option>
              <option value="dml">DirectML</option>
            </select>
          </label>
          <template v-if="isUtau">
            <label :title="t('UTAU 采样音（alias）：歌词为空时用它兜底')">{{ t('采样音') }}
              <input :value="store.sampleNote" @change="store.sampleNote = sval($event)" /></label>
            <label>{{ t('重采样器') }}<input :value="tr.resampler || ''"
              @change="store.patchTrack(tr.id, { resampler: sval($event) })" /></label>
            <label>{{ t('波源工具') }}<input :value="tr.wavtool || ''"
              @change="store.patchTrack(tr.id, { wavtool: sval($event) })" /></label>
          </template>
          <template v-if="isDs">
            <label>{{ t('深度') }}<input type="number" step="0.05" min="0" max="1" :value="tr.depth ?? 1"
              @change="store.patchTrack(tr.id, { depth: nval($event, 1) })" /></label>
            <label>{{ t('采样步数') }}<input type="number" min="1" :value="tr.steps ?? 20"
              @change="store.patchTrack(tr.id, { steps: nval($event, 20) })" /></label>
          </template>
          <label>{{ t('BPM') }}<input type="number" min="1" :value="store.bpm"
            @change="store.bpm = nval($event, 120)" /></label>
          <label :title="t('整条轨的增益（dB）：0 = 原样，负值衰减')">{{ t('轨增益') }}
            <input type="number" step="0.5" min="-60" max="6"
              :value="isAudio ? (tr.audio?.gainDb ?? 0) : (tr.gainDb ?? 0)"
              @change="onGainDb($event)" /><span class="muted">dB</span></label>
        </div>

        <!-- ── 效果链（本轨独享，顺序 = 信号流） ── -->
        <div v-else-if="propsTab === 'fx'" class="fxpane small">
          <div class="fx-bar">
            <select class="fx-new" @change="onAddFx">
              <option value="">{{ t('添加效果…') }}</option>
              <option v-for="k in FX_ORDER" :key="k" :value="k">{{ t(fxType(k).label) }}</option>
            </select>
            <span class="muted">{{ t('从上到下就是信号流顺序') }}</span>
            <span class="sp" />
            <button class="btn" :title="t('重新装载后播放才带新效果')" @click="reloadTransport">
              <Icon name="refresh" :size="12" /> {{ t('应用') }}
            </button>
          </div>
          <p v-if="!fxList.length" class="muted">{{ t('这条轨还没有效果。') }}</p>
          <div v-for="(f, i) in fxList" :key="f.id" class="fx-item" :class="{ off: f.enabled === false }">
            <div class="fx-head">
              <label class="ck">
                <input type="checkbox" :checked="f.enabled !== false" @change="toggleFx(f, $event)" />
                <b>{{ t(fxType(f.type).label) || f.type }}</b>
              </label>
              <span class="sp" />
              <button class="ib" :disabled="i === 0" :title="t('上移')"
                      @click="store.moveFx(tr.id, f.id, -1)">↑</button>
              <button class="ib" :disabled="i === fxList.length - 1" :title="t('下移')"
                      @click="store.moveFx(tr.id, f.id, 1)">↓</button>
              <button class="ib del" :title="t('删除')" @click="store.removeFx(tr.id, f.id)">×</button>
            </div>
            <div class="fx-params">
              <label v-for="p in fxParams(f)" :key="p.k">
                <span>{{ t(p.label) }}</span>
                <select v-if="p.kind === 'enum'" :value="f.params[p.k]" @change="setFxParam(f, p, $event)">
                  <option v-for="o in p.options" :key="o" :value="o">{{ o }}</option>
                </select>
                <input v-else type="number" :min="p.min" :max="p.max" :step="p.step"
                       :value="f.params[p.k]" @change="setFxParam(f, p, $event)" />
                <span v-if="p.unit" class="muted">{{ p.unit }}</span>
              </label>
            </div>
          </div>
        </div>

        <!-- ── 自动化子轨 ── -->
        <div v-else class="autopane small">
          <div class="auto-bar">
            <button v-for="a in autoTargets" :key="a" class="chip"
                    :class="{ on: a === curAbbr }" :title="t(curTgt(a).label)" @click="curAbbr = a">
              {{ a }}
            </button>
          </div>
          <div v-if="curTarget" class="auto-head">
            <b>{{ curAbbr }}</b>
            <span class="muted">{{ t(curTarget.label) }} {{ curTarget.unit || '' }}
              （{{ curTarget.min }} ~ {{ curTarget.max }}）</span>
            <span v-if="curTarget.mode === 'render'" class="tag-m re">{{ t('改了要重渲本轨') }}</span>
            <span v-else class="tag-m pb">{{ t('播放时实时生效') }}</span>
            <span class="sp" />
            <button class="btn" @click="autoAddPoint"><Icon name="plus" :size="12" /> {{ t('加点') }}</button>
            <button class="btn" @click="store.clearCurve(tr.id, curAbbr)"><Icon name="erase" :size="12" /> {{ t('清空') }}</button>
            <button class="btn" :class="{ primary: curveLocked }" :title="t('锁定后画布只读，避免「只是想看看」时误改')"
                    @click="curveLocked = !curveLocked"><Icon :name="curveLocked ? 'lock' : 'unlock'" :size="12" /> {{ curveLocked ? t('已锁定') : t('锁定') }}</button>
            <select v-model="copyToId" class="select-input" style="width:auto;max-width:140px" :title="t('把这条曲线复制到哪条轨')">
              <option value="">{{ t('复制到…') }}</option>
              <option v-for="x in copyTargets" :key="x.id" :value="x.id">{{ x.name || t('未命名轨') }}</option>
            </select>
            <button class="btn" :disabled="!copyToId" @click="copyCurveTo(copyToId)">{{ t('复制') }}</button>
            <button class="btn" :disabled="!copyTargets.length" @click="copyCurveToAll">{{ t('复制到全部轨') }}</button>
          </div>
          <!-- P2-4：表格用于精确输入，车道用于"凭耳朵拖" —— 两条路都留着 -->
          <p class="muted auto-hint">
            {{ t('下面的车道可以直接拖：空白处按下加点并拖动，Alt+点或右键点删除。表格用于精确输入。') }}
          </p>
          <!-- M6b：这条参数也能直接画了（画笔/直线/橡皮/平滑/量化），落库走 store.setCurve -->
          <div class="curves-head small">
            <span class="curve-tools">
              <button v-for="tl in CURVE_TOOLS" :key="tl[0]" class="btn" :class="{ primary: curveTool === tl[0] }"
                      @click="curveTool = tl[0]">{{ t(tl[1]) }}</button>
            </span>
            <button class="btn" @click="curveCanvasAuto?.smooth()">{{ t('平滑') }}</button>
            <button class="btn" @click="curveCanvasAuto?.quantize(0.25)">{{ t('量化 1/16') }}</button>
            <span class="muted">{{ (curCurve && curCurve.points.length) || 0 }}{{ t(' 个点') }}</span>
          </div>
          <CurveCanvas ref="curveCanvasAuto" :points="(curCurve && curCurve.points) || []"
                       :min="curTarget ? curTarget.min : -1200" :max="curTarget ? curTarget.max : 1200"
                       :beats="curveBeats" :beats-per-bar="beatsPerBar" :tool="curveTool"
                       :unit="(curTarget && curTarget.unit) || ''" :locked="curveLocked" @commit="onAutoCurveCommit" />
          <details v-if="curCurve && curCurve.points.length" class="curve-nums">
            <summary class="muted small">{{ t('数值表（精确输入）') }}</summary>
          <div class="auto-grid">
            <div v-for="(p, i) in curCurve.points" :key="i" class="curve-row">
              <span class="ci">{{ i + 1 }}</span>
              <input type="number" step="0.25" :value="p.beat"
                     @change="autoSetPoint(curCurve.points, i, 'beat', $event)" />
              <input type="number" :step="curTarget.step || 1" :value="p.value"
                     @change="autoSetPoint(curCurve.points, i, 'value', $event)" />
              <span class="muted">beat / {{ curTarget.unit || '' }}</span>
              <button class="ib del" :title="t('删除')" @click="autoDelPoint(curCurve.points, i)">×</button>
            </div>
          </div>
          </details>
          <p v-else class="muted">{{ t('还没有点，整条轨用默认值。') }}</p>
        </div>
      </div>

      <!-- MIDI 多轨时选一条 -->
      <div v-if="midiPick" class="pick small">
        <div class="pick-head">
          <b>{{ t('这个 MIDI 有 ') }}{{ midiPick.tracks.length }}{{ t(' 条旋律轨，选一条：') }}</b>
          <label class="mono-chk" :title="t('同一时刻只留最高音（旋律线）；复音轨直接唱会每拍叠好几个音节') ">
            <input type="checkbox" v-model="monoPick" /> {{ t('只取最高音（单音化）') }}
          </label>
          <span class="sp" />
          <button class="btn" @click="midiPick = null">{{ t('取消') }}</button>
        </div>
        <ul class="pick-list">
          <li v-for="mt in midiPick.tracks" :key="mt.index">
            <span class="nm">{{ mt.name }}</span>
            <span class="muted">{{ mt.noteCount }} {{ t('音符') }} · {{ mt.minPitch }}–{{ mt.maxPitch }}</span>
            <span v-if="overlapCount(mt)" class="ovl" :title="t('同一时刻有多个音在响（复音轨）')">
              {{ t('复音 ') }}{{ overlapCount(mt) }}
            </span>
            <button class="btn" @click="applyPicked(mt, midiPick?.tpb || 480, midiPick?.bpm || 120)">
              <Icon name="check" :size="12" /> {{ t('用这条') }}
            </button>
          </li>
        </ul>
      </div>

      <!-- 从曲库选 MIDI（P1-12）：曲目已经在 <数据目录>/midi 里，直接读字节，不弹系统对话框 -->
      <div v-if="libDlg" class="singdlg small">
        <div class="singdlg-head">
          <b>{{ t('从曲库选 MIDI') }}</b>
          <span class="muted">{{ t('曲库里的曲目（数据目录 midi/）') }}</span>
          <span class="sp" />
          <button class="btn" @click="libDlg = null">{{ t('取消') }}</button>
        </div>
        <div class="singdlg-row">
          <input class="singdlg-q" v-model="libDlg.q" :placeholder="t('搜索曲名')" />
          <span class="muted">{{ libSongs.length }}</span>
        </div>
        <ul class="lib-list">
          <li v-for="s in libSongs" :key="s.id">
            <button class="lib-item" :disabled="busyImport" @click="importFromLibrary(s)">
              <span class="nm">{{ s.name }}</span>
              <span class="muted small">
                {{ s.meta && s.meta.tracks ? s.meta.tracks + t(' 轨 · ') : '' }}{{ s.meta && s.meta.dur ? Math.round(s.meta.dur) + 's' : '' }}
              </span>
            </button>
          </li>
        </ul>
      </div>

      <!-- 批量填词（P1-7/8）：中文逐字分词 + 填充模式 + 预览 + 转拼音 + 读歌词文件 -->
      <div v-if="lyricDlg" class="singdlg small">
        <div class="singdlg-head">
          <b>{{ t('批量填词') }}</b>
          <span class="muted">{{ t('作用于选中的 ') }}{{ selNotes.length }}{{ t(' 个音符') }}</span>
          <span class="sp" />
          <button class="btn" @click="lyricDlg = null">{{ t('取消') }}</button>
        </div>
        <textarea class="singdlg-ta" v-model="lyricDlg.text"
                  :placeholder="t('把歌词粘进来：中文会自动逐字切分，也可以写成空格分隔的音节。')"></textarea>
        <div class="singdlg-row">
          <label>{{ t('分词') }}
            <select v-model="lyricDlg.mode">
              <option value="auto">{{ t('自动（中文逐字）') }}</option>
              <option value="char">{{ t('逐字') }}</option>
              <option value="space">{{ t('按空白') }}</option>
              <option value="line">{{ t('按行') }}</option>
            </select>
          </label>
          <label v-if="lyricDlg.align === 'seq'">{{ t('填充') }}
            <select v-model="lyricDlg.fill">
              <option value="seq">{{ t('顺序（不够时沿用最后一个）') }}</option>
              <option value="loop">{{ t('循环（从头重复）') }}</option>
              <option value="trim">{{ t('只填到用完（其余留空）') }}</option>
            </select>
          </label>
          <!-- ★ 对齐方式：字数与音符数不一致时（实测 441 字 / 275 音符），顺序填一定会错位 -->
          <label :title="t('顺序=一个字一个音符；按比例/按乐句会把字铺满全曲（字多时跳过一些字）；切开长音符=把长音切开，一个字都不丢')">{{ t('对齐') }}
            <select v-model="lyricDlg.align">
              <option value="seq">{{ t('顺序') }}</option>
              <option value="spread">{{ t('整首按比例') }}</option>
              <option value="phrases">{{ t('按乐句') }}</option>
              <option value="split">{{ t('切开长音符（一字不丢）') }}</option>
            </select>
          </label>
          <label v-if="lyricDlg.align === 'phrases' || lyricDlg.align === 'split'" :title="t('两个音符之间空多久算换句')">
            {{ t('换句休止') }}
            <input type="number" min="0.125" step="0.25" style="width:64px" v-model.number="lyricDlg.gap" /> {{ t('拍') }}
          </label>
          <button class="btn sm" :disabled="pinyinBusy" @click="toPinyin">
            <Icon name="convert" :size="12" /> {{ pinyinBusy ? t('转换中…') : t('汉字→拼音') }}
          </button>
          <button class="btn sm" @click="importLyricsFile"><Icon name="import" :size="12" /> {{ t('读歌词文件') }}</button>
        </div>
        <div class="singdlg-prev">
          <span class="muted">{{ t('识别到 ') }}{{ lyricTokens.length }}{{ t(' 个词 → ') }}{{ selNotes.length }}{{ t(' 个音符') }}</span>
          <span v-if="lyricDlg.align === 'seq' && Math.abs(lyricTokens.length - selNotes.length) > Math.max(4, selNotes.length * 0.25)"
                class="mismatch">
            {{ t('字数与音符数差得多：顺序填会从中间开始错位；想一个字都不丢就选「切开长音符」。') }}
          </span>
          <span class="chips">
            <i v-for="(w, i) in lyricTokens.slice(0, 24)" :key="i">{{ w }}</i>
            <em v-if="lyricTokens.length > 24">…</em>
          </span>
        </div>
        <!-- 多音字候选：不/了/着/得… 自动转换必然有一半是错的，给个一键换 -->
        <div v-if="heteroList.length" class="singdlg-py">
          <span class="muted">{{ t('多音字：') }}</span>
          <span v-for="h in heteroList" :key="h.index" class="py-item">
            <b>{{ h.ch }}</b>
            <button v-for="o in h.options" :key="o" class="chip-btn"
                    :class="{ on: o === h.current }" @click="pickPinyin(h.index, o)">{{ o }}</button>
          </span>
          <span v-if="heteroList.length >= 16" class="muted small">{{ t('（只列出前 16 个）') }}</span>
        </div>
        <div class="singdlg-foot">
          <span class="muted">{{ t('UTAU 中文声库要先转拼音（引擎只认别名）；DiffSinger 直接用汉字。') }}</span>
          <span class="sp" />
          <button class="btn primary" @click="applyLyricDialog"><Icon name="check" :size="12" /> {{ t('填入') }}</button>
        </div>
      </div>

      <!-- 发音表（P1-14）：这个声库到底能唱哪些音 -->
      <div v-if="aliasDlg" class="singdlg small">
        <div class="singdlg-head">
          <b>{{ t('发音表') }}</b>
          <span class="muted">{{ aliasDlg.dir }}</span>
          <span class="sp" />
          <button class="btn" @click="aliasDlg = null"><Icon name="close" :size="12" /> {{ t('关闭') }}</button>
        </div>
        <div class="singdlg-row">
          <input class="singdlg-q" v-model="aliasDlg.q" :placeholder="t('搜索发音（如 ai / bu / hao）')" />
          <span class="muted">{{ aliasDlg.loading ? t('读取中…') : String(aliasFiltered.length) + ' / ' + String(aliasDlg.all.length) }}</span>
        </div>
        <p v-if="aliasDlg.err" class="edt-msg small bad">{{ aliasDlg.err }}</p>
        <div class="singdlg-chips">
          <button v-for="a in aliasFiltered" :key="a" class="chip-btn" @click="useAlias(a)">{{ a }}</button>
        </div>
        <div class="singdlg-foot">
          <span class="muted">{{ t('点一个发音：有选中音符就填给它，否则复制到剪贴板。') }}</span>
        </div>
      </div>

      <!-- 多轨叠置条：一眼看清有哪几条声部、各自什么颜色、现在在编辑哪条 -->
      <!-- ★ 以前没有这一条：卷帘只画当前轨，用户在第二条轨上工作时看不到第一条，
           和声/对词只能靠记。点色块＝切轨，点眼睛＝临时藏起来，点圆点＝换色。 -->
      <div v-if="tr && !isAudio && voiceTracks.length" class="roll-strip">
        <button class="chip-btn" :class="{ on: rollOverlay }" :title="t('把其它声部的音符画成半透明幽灵，方便对拍对词')"
                @click="rollOverlay = !rollOverlay"><Icon name="layers" :size="12" />{{ t('多轨叠置') }}</button>
        <button v-if="rollOverlay" class="chip-btn" :class="{ on: rollGhostLabels }" :title="t('幽灵音符上也显示歌词，便于对齐字位')"
                @click="rollGhostLabels = !rollGhostLabels"><Icon name="edit" :size="12" />{{ t('显示歌词') }}</button>
        <span class="rs-sep" />
        <button v-for="(tk, i) in voiceTracks" :key="tk.id" class="rs-track"
                :class="{ on: tk.id === store.activeTrackId, off: store.rollHidden.includes(tk.id) }"
                :title="t('点一下切到这条轨编辑；点圆点换颜色；点眼睛临时隐藏')"
                @click="store.selectTrack(tk.id)">
          <i class="rs-dot" :style="{ background: colorOf(tk) }" @click.stop="store.cycleTrackColor(tk.id)" />
          <span class="rs-name">{{ tk.name || tk.singerName || t('未命名轨') }}</span>
          <span class="rs-cnt">{{ (tk.notes || []).length }}</span>
          <span class="rs-ib" :title="t('渲染结果')" v-if="store.renderByTrack[tk.id]">●</span>
          <span class="rs-ib" :class="{ on: tk.muted }" :title="t('静音')" @click.stop="store.patchTrack(tk.id, { muted: !tk.muted })">M</span>
          <span class="rs-ib" :title="t('独奏')" @click.stop="store.toggleSolo(tk.id)">S</span>
          <span class="rs-ib" :title="t('在卷帘里显示/隐藏')" @click.stop="store.toggleRollHidden(tk.id)">
            <Icon :name="store.rollHidden.includes(tk.id) ? 'eye-off' : 'eye'" :size="11" /></span>
        </button>
        <button class="chip-btn" :class="{ on: !detailOpen }" :title="t('收起下方的歌词/音素/曲线面板，把高度全给音符区')"
                @click="detailOpen = !detailOpen">
          <Icon name="expand" :size="12" />{{ detailOpen ? t('放大音符区') : t('显示详情') }}</button>
        <span class="rs-hint muted small" :title="t('点别的轨的音符即可切过去编辑')" v-if="rollOverlay && voiceTracks.length > 1">ⓘ</span>
      </div>

      <!-- 共用钢琴卷帘 -->
      <!-- ★ 卷帘放在吃满剩余高度的盒子里（fill）：原来固定 320px，大屏上只占一小块。
           拖动下面的分隔条可手动定高，双击恢复「自动铺满」。 -->
      <div v-if="tr && !isAudio" class="roll-box" :style="rollBoxStyle">
      <PianoRoll
        ref="prRef"
        class="edt-roll"
        fill
        :height="rollH || 320"
        :notes="tr.notes"
        :selected-id="store.selectedId"
        :selected-ids="store.selectedIds"
        :bpm="store.bpm"
        :api="rollApi()"
        :playhead-beat="playheadBeat"
        :beats-per-bar="beatsPerBar"
        :scale="scale"
        :sel-phoneme="selPh"
        :automation="autoLane"
        :tracks="rollTracks"
        :active-track-id="store.activeTrackId"
        :overlay="rollOverlay"
        :ghost-labels="rollGhostLabels"
        @edit-lyric="onEditNoteFromRoll"
        @automation-begin="store.pushUndo()"
        @set-automation="onAutoLane"
        @set-scale="onRollScale"
        @set-scale-root="onRollScaleRoot"
        @edit-phoneme="onPickPhoneme"
        @pick-note="onPickGhostNote"
      />
      </div>
      <div v-if="tr && !isAudio" class="roll-resizer" :title="t('拖动调整音符区高度；双击恢复自动铺满')"
           @pointerdown.prevent="startRollResize" @dblclick="resetRollHeight">
        <span class="rr-grip"></span>
      </div>

      <!-- 选中音符的详细编辑（两边共用一套，引擎特有项按轨道显示） -->
      <!-- 多选批量工具（P2-1）：选中 2 个以上音符才出现，平时不占地方 -->
      <div v-if="detailOpen && !isAudio && selNotes.length > 1" class="bulk small">
        <b>{{ t('已选 ') }}{{ selNotes.length }}{{ t(' 个音符') }}</b>
        <button class="btn sm" @click="openLyricDialog()"><Icon name="edit" :size="12" /> {{ t('批量填词') }}</button>
        <button class="btn sm" @click="importLyricsFile" :title="t('读入 .txt / .lrc：txt 走分词填入，lrc 按时间轴自动对轴')">
          <Icon name="import" :size="12" /> {{ t('导入歌词') }}
        </button>
        <button class="btn sm" @click="openAliasDialog" :title="t('看这个声库支持哪些发音，点一下就能填')">
          <Icon name="music" :size="12" /> {{ t('发音表') }}
        </button>
        <button class="btn sm" @click="rampVelocity(1)" :title="t('按音符先后做 20 → 100 的力度递增')">
          <Icon name="cresc" :size="12" /> {{ t('渐强') }}
        </button>
        <button class="btn sm" @click="rampVelocity(-1)" :title="t('按音符先后做 100 → 20 的力度递减')">
          <Icon name="dim" :size="12" /> {{ t('渐弱') }}
        </button>
        <span class="muted">{{ t('复制 / 切分 / 合并：卷帘里右键，或 Ctrl+C / Ctrl+E / Ctrl+M') }}</span>
      </div>

      <!-- 详情收起时的单行摘要：不展开面板也能看到选中音符的关键字段 -->
      <div v-if="!detailOpen && sel && !isAudio" class="det-mini small">
        <b>{{ t('已选音符') }}</b>
        <span>{{ t('歌词') }}「{{ sel.lyric || t('（空）') }}」</span>
        <span>{{ t('音高') }} {{ sel.pitch }}</span>
        <span>{{ t('起点') }} {{ Number(sel.startBeat).toFixed(2) }}</span>
        <span>{{ t('时长') }} {{ Number(sel.durBeat).toFixed(2) }}</span>
        <span class="sp" />
        <button class="btn sm" @click="detailOpen = true"><Icon name="edit" :size="12" /> {{ t('显示详情') }}</button>
      </div>

      <div v-if="detailOpen && sel && !isAudio" class="det">
        <label class="ly">
          <span>{{ t('歌词') }}</span>
          <span class="ly-wrap">
            <input :value="sel.lyric" @input="onLyric(sel, $event)" />
            <span v-if="cands.length && candFor === sel.id" class="cands">
              <button v-for="c in cands" :key="c.kind + c.text" class="cand"
                      :class="'k-' + c.kind" :title="c.note" @click="pickCand(sel.id, c.text)">
                {{ c.text }}
              </button>
            </span>
          </span>
        </label>
        <!-- P2-5：这个词不在声库别名表里 —— 行内标红 + 相近别名一键替换 -->
        <div v-if="selLyricMissing" class="ly-bad small">
          <Icon name="info" :size="12" />
          <span>{{ t('「') }}{{ sel.lyric }}{{ t('」不在当前声库的别名表里，渲染时会静音或被跳过') }}</span>
          <button v-for="a in suggestAliases(sel.lyric)" :key="a" class="chip-btn" :title="t('替换成这个别名')"
                  @click="store.updateNote(sel.id, { lyric: a })">{{ a }}</button>
        </div>
        <label><span>{{ t('起点') }}</span><input type="number" step="0.125" min="0" :value="sel.startBeat"
          @change="store.updateNote(sel.id, { startBeat: nval($event, 0) })" /></label>
        <label><span>{{ t('时长') }}</span><input type="number" step="0.125" min="0.125" :value="sel.durBeat"
          @change="store.updateNote(sel.id, { durBeat: Math.max(0.125, nval($event, 1)) })" /></label>
        <label><span>{{ t('音高') }}</span><input type="number" min="0" max="127" :value="sel.pitch"
          @change="store.updateNote(sel.id, { pitch: Math.max(0, Math.min(127, nval($event, 60))) })" /></label>
        <!-- 颤音（M6b，计划书 §4.2）：布尔开关 + 三条参数升级成「能看见包络」的一块 -->
        <div class="vib-block">
          <div class="vib-head">
            <label class="ck"><input type="checkbox" :checked="sel.vibrato"
              @change="store.updateNote(sel.id, { vibrato: $event.target.checked })" /><span>{{ t('颤音') }}</span></label>
            <span class="muted small">{{ t('下面画的是这个音的颤音包络：起音渐入 → 保持 → 收尾渐出') }}</span>
          </div>
          <label class="vib-row"><span>{{ t('深度') }}</span>
            <input type="range" min="0" max="100" step="1" :value="vibVal('vibDepth')" :disabled="!sel.vibrato"
                   @input="store.updateNote(sel.id, { vibDepth: nval($event, 35) })" />
            <em>{{ vibVal('vibDepth') }}</em></label>
          <label class="vib-row"><span>{{ t('速率') }}</span>
            <input type="range" min="0" max="12" step="0.1" :value="vibVal('vibFreq')" :disabled="!sel.vibrato"
                   @input="store.updateNote(sel.id, { vibFreq: nval($event, 5.5) })" />
            <em>{{ Number(vibVal('vibFreq')).toFixed(1) }} Hz</em></label>
          <label class="vib-row"><span>{{ t('淡入') }}</span>
            <input type="range" min="0" max="0.9" step="0.05" :value="vibVal('vibFade')" :disabled="!sel.vibrato"
                   @input="store.updateNote(sel.id, { vibFade: nval($event, 0.25) })" />
            <em>{{ Math.round(Number(vibVal('vibFade')) * 100) }}%</em></label>
          <canvas ref="vibCv" class="vib-cv" height="46"></canvas>
        </div>
        <label v-if="isDs"><span>{{ t('音分偏移') }}</span><input type="number" min="-100" max="100" :value="sel.pitchOffset || 0"
          @change="store.updateNote(sel.id, { pitchOffset: nval($event, 0) })" /></label>
        <!-- 留空 = 用引擎默认值。占位符直接显示那个默认值，免得用户以为"0 是默认" -->
        <label v-if="isUtau" :title="t('力度（0 ~ 100，默认 100）：影响辅音速度与音量，越小越柔')"><span>{{ t('力度') }}</span>
          <input type="number" min="0" max="100" placeholder="100" :value="sel.velocity ?? ''"
            @change="store.updateNote(sel.id, { velocity: nval($event, 100) })" /></label>
        <label v-if="isUtau" :title="t('GENC（-100 ~ 100，默认 0 = 不变）：正值更亮（偏女声），负值更暗')"><span>{{ t('GENC') }}</span>
          <input type="number" min="-100" max="100" placeholder="0" :value="sel.gender ?? ''"
            @change="store.updateNote(sel.id, { gender: nval($event, 0) })" /></label>
        <label v-if="isUtau" :title="t('气声（0 ~ 100，默认 0）')"><span>{{ t('气声') }}</span>
          <input type="number" min="0" max="100" placeholder="0" :value="sel.breath ?? ''"
            @change="store.updateNote(sel.id, { breath: nval($event, 0) })" /></label>
        <label v-if="isUtau" :title="t('音量（表情级 0 ~ 100，默认 100 = 原样；不是衰减量）')"><span>{{ t('音量') }}</span>
          <input type="number" min="0" max="100" placeholder="100" :value="sel.volume ?? ''"
            @change="store.updateNote(sel.id, { volume: nval($event, 100) })" /></label>

        <!-- OpenUTAU 表达式（每音符，作用于该音符首个音素；不填 = 用轨道默认值） -->
        <template v-if="isUtau">
          <label :title="t('起音：音符开头的咬字力度，越小越柔和')"><span>{{ t('起音 ATK') }}</span>
            <input type="number" min="0" max="100" placeholder="100" :value="sel.atk ?? ''"
              @change="store.updateNote(sel.id, { atk: nval($event, 100) })" /></label>
          <label :title="t('衰减：音符尾部的收束，越小收得越快')"><span>{{ t('衰减 DEC') }}</span>
            <input type="number" min="0" max="100" placeholder="100" :value="sel.dec ?? ''"
              @change="store.updateNote(sel.id, { dec: nval($event, 100) })" /></label>
          <label :title="t('音量曲线偏移（-240 ~ 120），对应 OpenUTAU 的 dyn')"><span>{{ t('力度曲线 DYN') }}</span>
            <input type="number" min="-240" max="120" placeholder="0" :value="sel.dyn ?? ''"
              @change="store.updateNote(sel.id, { dyn: nval($event, 0) })" /></label>
          <label :title="t('音高偏移量（0 ~ 100），对应 OpenUTAU 的 shft')"><span>{{ t('音高偏移 SHFT') }}</span>
            <input type="number" min="0" max="100" placeholder="0" :value="sel.shft ?? ''"
              @change="store.updateNote(sel.id, { shft: nval($event, 0) })" /></label>
          <label :title="t('语音色选项下标（0 起），对应 OpenUTAU 的 clr；声库没有多语音色时保持 0')"><span>{{ t('语音色 CLR') }}</span>
            <input type="number" min="0" step="1" placeholder="0" :value="sel.clr ?? ''"
              @change="store.updateNote(sel.id, { clr: nval($event, 0) })" /></label>
        </template>
      </div>

      <!-- 音素级编辑（P2-2）：条带上点一个音素，或点下面的音素芯片 -->
      <div v-if="detailOpen && !isAudio && phNote && phItems.length" class="ph-panel">
        <div class="ph-head small">
          <b>{{ t('音素级编辑') }}</b>
          <span class="muted">{{ t('音符「') }}{{ phNote.lyric || '—' }}{{ t('」的音素（辅音 → 元音）：') }}</span>
          <button v-for="(it, i) in phItems" :key="i" class="chip-btn"
                  :class="{ on: i === phIndex, has: !!(phNote.phExpressions && phNote.phExpressions[String(i)]) }"
                  :title="t('编辑这个音素（下标 ') + i + t('）；带圆点表示已单独设过') "
                  @click="pickPhonemeIndex(i)">{{ it.text }}</button>
          <span class="sp" />
          <span v-if="phOverrideCount" class="muted">{{ t('本音素已覆盖 ') }}{{ phOverrideCount }}{{ t(' 项') }}</span>
          <button class="btn sm" :disabled="!phOverrideCount" @click="clearPhExpr"><Icon name="erase" :size="12" /> {{ t('清除本音素覆盖') }}</button>
        </div>
        <div class="ph-grid small">
          <label v-for="e in PH_EXPRS" :key="e.abbr" :title="t(e.hint) + t('；留空 = 用音符/轨道的值')">
            <span>{{ t(e.label) }}</span>
            <input type="number" :min="e.min" :max="e.max" :placeholder="String(e.def)"
                   :value="phVals[e.abbr] ?? ''" @change="setPhExpr(e.abbr, $event)" />
          </label>
        </div>
        <p class="muted small ph-note">
          {{ t('只改这一个音素；留空即沿用音符级/轨道默认值。音素切分是按歌词估计的，引擎以声库 oto 为准，下标越界会被忽略。') }}
        </p>
      </div>

      <!-- 音高曲线（两边共用） -->
      <div v-if="detailOpen && !isAudio" class="curves">
        <div class="curves-head small">
          <b>{{ t('音高曲线') }}</b>
          <span class="curve-tools">
            <button v-for="tl in CURVE_TOOLS" :key="tl[0]" class="btn" :class="{ primary: curveTool === tl[0] }"
                    :title="t('曲线工具')" @click="curveTool = tl[0]">{{ t(tl[1]) }}</button>
          </span>
          <button class="btn" :title="t('对曲线做一次三点平滑')" @click="curveCanvas?.smooth()">{{ t('平滑') }}</button>
          <button class="btn" :title="t('把曲线点吸附到 1/16 拍')" @click="curveCanvas?.quantize(0.25)">{{ t('量化 1/16') }}</button>
          <button class="btn" @click="curveAdd"><Icon name="plus" :size="12" /> {{ t('加点') }}</button>
          <button class="btn" @click="curveClear"><Icon name="erase" :size="12" /> {{ t('清空') }}</button>
          <span class="muted">{{ curveCents }}{{ t(' 个点 · 单位：音分（cent），作用于整条轨') }}</span>
        </div>
        <CurveCanvas ref="curveCanvas" :points="(tr && tr.pitchCurve) || []" :min="-1200" :max="1200"
                     :beats="curveBeats" :beats-per-bar="beatsPerBar" :tool="curveTool" unit="cent"
                     @commit="onCurveCommit" />
        <details v-if="tr && tr.pitchCurve.length" class="curve-nums">
          <summary class="muted small">{{ t('数值表（精确输入）') }}</summary>
        <div class="curves-grid small">
          <div v-for="(p, i) in tr.pitchCurve" :key="i" class="curve-row">
            <span class="ci">{{ i + 1 }}</span>
            <input :value="p.beat" step="0.25" :data-f="'beat'" @change="curveSet(i, $event)" />
            <input :value="p.cents" step="5" :data-f="'cents'" @change="curveSet(i, $event)" />
            <span class="muted">beat / cent</span>
          </div>
        </div>
        </details>
      </div>
    </section>
    </div>

    <!-- ==================== 声库（原独立页并入同一入口） ====================
         页签切换加一次淡入上浮（全局 .view-* 那套）：原来声库面板是整块硬切进来的。 -->
    <Transition name="view" mode="out-in">
      <VoicebankPanel v-if="tab === 'banks'" class="sing-banks" key="banks" />
    </Transition>

    <!-- ==================== 声库制作（原独立路由 /voicebank） ==================== -->
    <div v-show="tab === 'maker'" class="sing-maker" :class="{ 'sing-in': tab === 'maker' }">
      <ViewVoicebank />
    </div>
  </div>
</template>

<style scoped>
/* ★ 实心底：壁纸开启时 .app-main 是透明的，这里必须自己铺不透明底 —— 否则乐谱/卷帘/
   声库这些密集文字会直接压在动态壁纸上（改版前「声库页透明、读不清」的根因）。 */
.sing-page { height: 100%; display: flex; flex-direction: column; min-height: 0;
             background: var(--canvas); }
.sing-nav { display: flex; align-items: center; gap: 8px; padding: 8px 14px; flex: none;
            border-bottom: 1px solid var(--border); background: var(--canvas); }
.sing-nav .sp { flex: 1; }
.sn-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 13px; cursor: pointer;
          border: 1px solid var(--border); border-radius: 999px; background: var(--surface);
          color: var(--steel); font-size: 12.5px; }
.sn-tab i { font-style: normal; font-size: 10.5px; opacity: .75; }
.sn-tab:hover { border-color: var(--brand); color: var(--ink); }
.sn-tab.on { border-color: var(--accent); background: var(--brand-soft); color: var(--ink); font-weight: 600; }
/* 空态：**一条横向提示条**（此前是竖向大卡片：大图标 + 标题 + 三行有序列表 + 两行按钮，
   在 1600×900 下占了近半屏，密度低又抢视线）。现在压成一行提示 + 一行动作。 */
.sing-empty { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
              margin: 10px 14px 0; padding: 9px 14px; border: 1px solid var(--border);
              border-radius: 10px; background: var(--surface); }
.se-main { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1 1 340px; }
.se-main > b { font-size: 13px; white-space: nowrap; }
.se-main > .small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.se-acts { display: flex; gap: 6px; flex-wrap: wrap; }
.edt-msg.hint { color: var(--stone); }
/* 多选批量工具行（P2-1）与歌词告警（P2-5） */
/* 音素级编辑面板（P2-2） */
.auto-hint { margin: 6px 0 0; line-height: 1.7; }
.ph-panel { margin: 8px 12px 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px;
  /* 面板高度封顶：它们是「按需看」的，不该把音符区挤没（超出自己滚） */
  max-height: 200px; overflow: auto;
  background: var(--surface); }
.ph-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ph-head .sp { flex: 1; }
.ph-head .chip-btn.has { box-shadow: inset 0 0 0 1.5px var(--brand-coral); }
.ph-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 10px; margin-top: 8px; }
.ph-grid label { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.ph-grid label span { color: var(--slate); font-size: 11.5px; }
.ph-grid input { width: 74px; height: 24px; border: 1px solid var(--hairline); border-radius: 7px;
  background: var(--surface-soft); color: var(--ink); font-size: 12px; text-align: right; }
.ph-note { margin: 8px 0 0; line-height: 1.7; }
/* 工程条上的小控件（P2-3） */
.proj-field { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--slate); }
.proj-field input, .proj-field select { height: 24px; border: 1px solid var(--hairline); border-radius: 7px;
  background: var(--surface); color: var(--ink); font-size: 12px; }
.proj-field .al-ms { width: 62px; }
.bulk { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 12px 0; padding: 7px 10px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface-soft); }
.bulk b { font-size: 12.5px; }
.bulk .muted { margin-left: auto; font-size: 11px; }
.edt-msg.bad { display: flex; align-items: center; gap: 8px; color: var(--brand-coral); }
.ly-bad { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; grid-column: 1 / -1;
  margin: 2px 0 4px; color: var(--brand-coral); }
.ly-bad .chip-btn { font-size: 11px; }
.edt-prog-wrap { display: flex; align-items: center; gap: 10px; padding: 4px 2px; }
.trk-item .rdy.stale { color: var(--brand-coral); font-weight: 700; }
/* 拖拽排序 / 静音 / 独奏 / 右键菜单 */
.trk-item.dragging { opacity: .45; }
.trk-item .tk-drag { flex: none; color: var(--stone); cursor: grab; display: inline-flex; align-items: center; }
.trk-item .ib.on { color: var(--brand-coral); }
.tk-menu-mask { position: fixed; inset: 0; z-index: 60; }
.tk-menu { position: fixed; z-index: 61; min-width: 168px; padding: 6px;
           border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
           box-shadow: 0 10px 28px rgba(0,0,0,.22); display: flex; flex-direction: column; gap: 2px; }
.tk-menu b { font-size: 11.5px; color: var(--stone); padding: 4px 8px 6px; }
.tk-menu button { display: flex; align-items: center; gap: 8px; text-align: left; padding: 6px 9px; border: 0; border-radius: 6px;
                  background: transparent; color: var(--ink); font-size: 12.5px; cursor: pointer; }
.tk-menu button:hover { background: var(--surface-muted); }
.tk-menu button.danger { color: var(--brand-coral); }
.edt-prog-wrap .edt-prog { flex: 1; }
.sing { flex: 1; min-height: 0; display: flex; }
.sing-banks { flex: 1; min-height: 0; }
/* 声库制作页签：整块撑开（内部是 flex 布局：工具栏 + 片段列表/波形） */
.sing-maker { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px 18px; background: var(--canvas); }
.sing-maker > * { min-height: 100%; }
/* 声库制作页切进来时一次性淡入（v-show 不会触发 Transition，用动画类代替） */
.sing-maker.sing-in { animation: singMakerIn .28s cubic-bezier(.2, .7, .3, 1) both; }
@keyframes singMakerIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* ---- 左：轨道列表 ---- */
.trk { width: 264px; flex: none; display: flex; flex-direction: column;
       border-right: 1px solid var(--border); background: var(--canvas); }
.trk-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
            border-bottom: 1px solid var(--border); font-size: 12.5px; }
.trk-head b { font-size: 12.5px; }
.sp { flex: 1; }
.trk-list { flex: 1; overflow: auto; padding: 6px; }
.trk-item { border: 1px solid var(--border); border-radius: 8px; padding: 6px;
            margin-bottom: 6px; cursor: pointer; background: var(--surface); }
.trk-item:hover { border-color: var(--brand); }
.trk-item.on { border-color: var(--brand); background: var(--brand-soft); }
.trk-row1 { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.trk-row2 { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.trk-item .nm { flex: 1; min-width: 0; }
.trk-item .pth { width: 100%; min-width: 0; font-size: 11.5px; height: 24px; }
.trk-item .pth { width: 100%; font-size: 11px; }
.trk-item .eng { font-size: 10.5px; padding: 1px 3px; border-radius: 4px;
                 border: 1px solid var(--border); }
.eng.e-utau { background: rgba(80,190,120,.18); }
.eng.e-diffsinger { background: rgba(64,140,255,.18); }
.trk-item .lang { font-size: 11px; }
.trk-item .cnt { font-size: 11px; color: var(--stone); margin-left: auto; }
.ib { border: 1px solid var(--border); background: transparent; color: inherit;
      border-radius: 5px; padding: 2px 5px; cursor: pointer; }
.ib:hover { border-color: var(--brand); color: var(--brand-text); }
.ib.del:hover { border-color: #c66; color: #c66; }

/* ---- 右：编辑器 ---- */
.edt { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: auto; }
.proj { display: flex; align-items: center; gap: 6px; padding: 3px 12px;
        border-bottom: 1px solid var(--border); }
.proj .ptitle { flex: 0 1 200px; font-size: 12.5px; }
.proj .ppath { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.edt-bar { display: flex; align-items: center; gap: 8px; padding: 4px 12px;
           border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.edt-bar .who { font-size: 13px; }
.edt-bar .tag { font-size: 10.5px; padding: 1px 6px; border-radius: 4px;
                border: 1px solid var(--border); }
.edt-bar .tag.e-utau { background: rgba(80,190,120,.18); }
.edt-bar .tag.e-diffsinger { background: rgba(64,140,255,.18); }
.edt-prog { height: 3px; background: var(--surface-muted); }
.edt-prog i { display: block; height: 100%; background: var(--brand); transition: width .2s; }
.edt-msg { margin: 6px 12px; color: var(--brand-text); }
/* 音符区：默认吃满编辑区剩余高度（flex:1），手动拖过则固定像素（见 rollBoxStyle） */
/*
 * 音符区的下限给到 320px：编辑区底下的歌词/音素/曲线面板加起来能有 350px+，
 * 没有下限时它们会把卷帘挤成一条缝（实测固定 320px 时卷帘被压到 2px，完全看不见）。
 * 超出的部分由编辑区整体滚动，或用「放大音符区」一键把下面三块收起来。
 */
.roll-box { flex: 1 1 auto; min-height: 380px; display: flex; margin: 4px 12px 0; }
.roll-box .edt-roll { flex: 1 1 auto; min-width: 0; margin: 0; }
/* 分隔条：上下拖动改变音符区高度；双击恢复自动 */
.roll-resizer { flex: none; height: 10px; margin: 0 12px; display: flex; align-items: center;
  cursor: ns-resize; touch-action: none; }
.roll-resizer:hover .rr-grip { background: var(--brand); }
.rr-grip { display: block; width: 100%; height: 3px; border-radius: 3px; background: var(--border); transition: background .15s; }
/* 多轨叠置条（卷帘上方）：色块=切轨 / 圆点=换色 / 眼睛=临时隐藏 / M,S=静音独奏 */
.roll-strip { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 12px 0;
  padding: 3px 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-soft); }
.roll-strip .rs-sep { width: 1px; height: 18px; background: var(--border); }
.roll-strip .rs-track { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; cursor: pointer;
  border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--slate);
  font-size: 11.5px; line-height: 1.6; }
.roll-strip .rs-track:hover { border-color: var(--brand); color: var(--ink); }
.roll-strip .rs-track.on { border-color: var(--brand); background: var(--brand-soft); color: var(--ink); font-weight: 600; }
.roll-strip .rs-track.off .rs-name, .roll-strip .rs-track.off .rs-cnt { opacity: .45; text-decoration: line-through; }
.roll-strip .rs-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1px rgba(0,0,0,.18) inset; }
.roll-strip .rs-name { max-width: 116px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.roll-strip .rs-cnt { font-size: 10.5px; color: var(--stone); }
.roll-strip .rs-ib { display: inline-flex; align-items: center; justify-content: center; min-width: 13px;
  font-size: 10px; color: var(--stone); }
.roll-strip .rs-ib:hover { color: var(--brand-text); }
.roll-strip .rs-ib.on { color: var(--brand-coral); font-weight: 700; }
.roll-strip .rs-hint { margin-left: auto; }

.edt-bar .dev, .edt-bar .smp { font-size: 11.5px; }
.edt-bar .smp { width: 48px; }
.xport { display: flex; align-items: center; gap: 8px; padding: 6px 12px;
         border-bottom: 1px solid var(--border); }
.xport .xbar { flex: 1; min-width: 120px; }
.xport .xtime { min-width: 92px; text-align: right; font-variant-numeric: tabular-nums;
  font-family: var(--mono); color: var(--slate); cursor: pointer; background: none; border: none; }
.xport .xtime:hover { color: var(--brand-text); text-decoration: underline; }
.xbar-wrap { position: relative; flex: 1; min-width: 120px; display: flex; align-items: center; }
.xbar-wrap .xbar { width: 100%; position: relative; z-index: 1; background: transparent; }
.xbar-loop { position: absolute; top: 50%; height: 8px; transform: translateY(-50%); border-radius: 4px;
  background: color-mix(in srgb, var(--brand-coral) 32%, transparent); pointer-events: none; }
.xbar-loop.on { background: color-mix(in srgb, var(--brand-coral) 62%, transparent); }
.xport .btn.on { border-color: var(--brand-coral); color: var(--brand-text); background: var(--surface-soft); }
.warn { margin: 4px 12px; color: var(--stone); }

.trk-import { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-bottom: 1px solid var(--border); }
/* 批量填词 / 发音表对话框（P1-7/8/14）：不依赖全局弹窗，长文本要能多行编辑 */
.singdlg { margin: 8px 0; padding: 10px; border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; gap: 8px; }
.singdlg-head, .singdlg-row, .singdlg-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.singdlg-head .sp, .singdlg-foot .sp { flex: 1; }
.singdlg-ta { width: 100%; min-height: 92px; resize: vertical; font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; }
.singdlg-q { flex: 1; min-width: 180px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; }
.singdlg-py { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 2px 2px;
              border-top: 1px dashed var(--hairline); margin-top: 6px; font-size: 12px; }
.singdlg-py .py-item { display: inline-flex; align-items: center; gap: 4px; }
.singdlg-py .py-item b { font-weight: 600; }
.singdlg-prev { display: flex; flex-direction: column; gap: 4px; }
.singdlg-prev .chips { display: flex; flex-wrap: wrap; gap: 4px; }
.singdlg-prev .mismatch { color: var(--warn-text, var(--stone)); }
.singdlg-prev .chips i { font-style: normal; padding: 1px 6px; border: 1px solid var(--border); border-radius: 999px; font-size: 11.5px; }
.singdlg-chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 220px; overflow: auto; }
.lib-list { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.lib-item { width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 5px 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.lib-item:hover { border-color: var(--border); background: var(--surface); }
.lib-item .nm { flex: 1; }
.mono-chk { display: inline-flex; align-items: center; gap: 4px; }
.ovl { font-size: 11.5px; color: var(--warn-text, var(--stone)); }
.ib.wide { width: 100%; justify-content: center; display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; padding: 4px 6px; }
.trk-item .ck { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; }
.trk-item .ck input { width: auto; }
.trk-item .rdy { color: var(--brand); font-size: 11px; line-height: 1; }
.edt-bar .tag.e-audio { background: rgba(220,160,60,.20); }
.pick { margin: 8px 12px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.pick-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.pick-list { list-style: none; margin: 0; padding: 0; }
.pick-list li { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.pick-list .nm { min-width: 120px; }
.pick-list .btn { margin-left: auto; }

/* ---- 轨道属性：三栏（参数 / 效果链 / 自动化） ---- */
.tprops { border-bottom: 1px solid var(--border); }
.tprops .tabs { display: flex; align-items: center; gap: 4px; padding: 5px 12px 0; }
.tprops .tab { display: inline-flex; align-items: center; gap: 6px;
               border: 1px solid transparent; border-bottom: none; background: transparent;
               color: var(--stone); cursor: pointer; border-radius: 6px 6px 0 0;
               padding: 3px 10px; font-size: 12px; }
.tprops .tab:hover { color: var(--brand-text); }
.tprops .tab.on { color: var(--brand-text); border-color: var(--border);
                  background: var(--surface); font-weight: 600; }
.tprops .tab .cnt { margin-left: 4px; font-size: 10.5px; padding: 0 4px; border-radius: 6px;
                    background: var(--brand-soft); }
.tprops > div:not(.tabs) { padding: 8px 12px; }

.props { display: flex; flex-wrap: wrap; gap: 10px; }
.props label { display: inline-flex; align-items: center; gap: 4px; }
.props input { width: 90px; }

.fxpane { display: flex; flex-direction: column; gap: 6px; }
.fx-bar { display: flex; align-items: center; gap: 8px; }
.fx-new { font-size: 12px; }
.fx-item { border: 1px solid var(--border); border-radius: 7px; padding: 5px 8px;
           background: var(--surface); }
.fx-item.off { opacity: .55; }
.fx-head { display: flex; align-items: center; gap: 6px; }
.fx-head .ck { display: inline-flex; align-items: center; gap: 4px; }
.fx-head .ck input { width: auto; }
.fx-params { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 5px; }
.fx-params label { display: inline-flex; align-items: center; gap: 4px; }
.fx-params input, .fx-params select { width: 82px; font-size: 12px; }

.autopane { display: flex; flex-direction: column; gap: 6px; }
.auto-bar { display: flex; flex-wrap: wrap; gap: 4px; }
.auto-bar .chip { border: 1px solid var(--border); background: transparent; color: var(--stone);
                  border-radius: 5px; padding: 1px 8px; font-size: 11.5px; cursor: pointer;
                  font-variant-numeric: tabular-nums; }
.auto-bar .chip:hover { border-color: var(--brand); }
.auto-bar .chip.on { border-color: var(--brand); background: var(--brand-soft);
                     color: var(--brand-text); font-weight: 600; }
.auto-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tag-m { font-size: 10.5px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); }
.tag-m.re { background: rgba(220,160,60,.20); }
.tag-m.pb { background: rgba(80,190,120,.18); }
/* 颤音块（M6b）：一排滑杆 + 一条包络预览 */
.vib-block { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface-soft); }
.vib-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vib-row { display: flex; align-items: center; gap: 8px; }
.vib-row > span { flex: none; width: 42px; font-size: 11.5px; color: var(--stone); }
.vib-row input[type="range"] { flex: 1; min-width: 0; accent-color: var(--accent); }
.vib-row em { flex: none; width: 54px; text-align: right; font-style: normal; font-family: var(--mono); font-size: 11px; color: var(--slate); }
.vib-cv { width: 100%; height: 46px; display: block; border: 1px solid var(--hairline); border-radius: 8px; background: var(--canvas); }
.curve-tools { display: inline-flex; gap: 4px; }

.auto-grid { display: flex; flex-direction: column; gap: 4px; }
.auto-grid input { width: 84px; }

/* ---- 音符详情 ---- */
.det-mini { display: flex; align-items: center; gap: 10px; margin: 4px 12px 0; padding: 4px 10px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface-soft); color: var(--slate); }
.det-mini b { color: var(--ink); }
.det-mini .sp { flex: 1; }
.det { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 12px;
       border-top: 1px solid var(--border); }
.det label { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.det label > span:first-child { color: var(--stone); }
.det input[type=number] { width: 74px; }
.det .ck input { width: auto; }
.ly { flex: 1 1 240px; }
.ly-wrap { position: relative; display: inline-block; flex: 1; }
.ly-wrap input { width: 100%; }
.cands { position: absolute; left: 0; top: 100%; z-index: 30; display: flex;
         flex-wrap: wrap; gap: 3px; margin-top: 2px; padding: 4px; max-width: 320px;
         background: var(--surface); border: 1px solid var(--border);
         border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.18); }
.cand { font-size: 11.5px; padding: 1px 7px; border-radius: 4px; cursor: pointer;
        border: 1px solid var(--border); background: var(--surface-muted); color: inherit; }
.cand:hover { border-color: var(--brand); background: var(--brand-soft); }
.cand.k-phoneme { font-weight: 600; background: rgba(64,140,255,.16); }
.cand.k-term { font-weight: 600; background: rgba(168,96,220,.18); }
.cand.k-syllable { background: rgba(80,190,120,.16); }
.cand.k-initial, .cand.k-final { color: var(--stone); }

/* ---- 曲线 ---- */
.curves { padding: 8px 12px; border-top: 1px solid var(--border); max-height: 180px; overflow: auto; }
.curves-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.curves-grid { display: flex; flex-direction: column; gap: 4px; }
.curve-row { display: flex; align-items: center; gap: 6px; }
.curve-row input { width: 84px; }
.curve-row .ci { width: 18px; color: var(--stone); }
</style>

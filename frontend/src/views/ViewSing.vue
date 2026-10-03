<script setup lang="ts">
/**
 * 歌声合成 · 统一编辑器
 *
 * 布局照上游 OpenUtau 的编辑器：左侧轨道列表，右侧钢琴卷帘 + 音符表 + 渲染。
 * 引擎（UTAU / DiffSinger）是**轨道上的属性**，不是页面级的模式 ——
 * 所以一个工程里两种轨可以混排，渲染时按各自引擎分派。
 */
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import Icon from '../components/Icon.vue';
import PianoRoll from '../components/pianoroll/PianoRoll.vue';
import { t } from '../core/i18n.js';
import { ENGINES, LANGUAGES, useSingerStore } from '../stores/singer';
import { getTransport } from '../core/sing_transport.js';
import { FX_TYPES, FX_ORDER } from '../core/track_fx.js';
import { CURVE_TARGETS, curveOf, defaultFor, targetsFor } from '../core/track_automation.js';

const store = useSingerStore();
const route = useRoute();
const msg = ref('');
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
function autoDelPoint(pts: { beat: number; value: number }[], i: number) {
  if (!tr.value) return;
  store.setCurve(tr.value.id, curAbbr.value, pts.filter((_, k) => k !== i));
}

/* ------------------------------------------------------------ 轨道 */
function addTrack(engine) { store.addTrack(engine); msg.value = ''; }
function onSingerPath(id, e) {
  const d = e.target.value.trim();
  store.patchTrack(id, { singer: d, singerName: d ? d.split(/[\\/]/).pop() : '' });
}
function onEngine(id, e) { store.patchTrack(id, { engine: e.target.value }); }

/* ------------------------------------------------------------ 音符 */
function rollApi() {
  return {
    bpm: () => store.bpm,
    notes: () => tr.value?.notes || [],
    selectedId: () => store.selectedId,
    selectedIds: () => store.selectedIds,
    addNote: (b, p) => store.addNote(b, p),
    updateNote: (id, patch) => store.updateNote(id, patch),
    removeNote: (id) => store.removeNote(id),
    select: (id, add) => store.select(id, add),
    selectMany: (ids) => store.selectMany(ids),
  };
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
  if (!b || typeof b.pickAudio !== 'function') { msg.value = t('桌面版才能导入音频'); return; }
  busyImport.value = true;
  try {
    const path = await b.pickAudio();
    if (!path) return;
    const fileName = String(path).split(/[\\/]/).pop() || 'audio';
    const durMs = await probeDuration(path);
    store.addAudioTrack(path, fileName, durMs);
    msg.value = durMs > 0
      ? t('已导入伴奏：') + fileName
      : t('已导入伴奏（时长未探到，可能是浏览器不支持的编码）：') + fileName;
  } catch (e) {
    msg.value = String((e as any)?.message || e);
  } finally {
    busyImport.value = false;
  }
}

/** 导入 MIDI → 选轨 → 落进当前（或新建的）声部轨 */
async function importMidi() {
  const b = window.fuBridge;
  if (!b || typeof b.pickFile !== 'function') { msg.value = t('桌面版才能导入 MIDI'); return; }
  busyImport.value = true;
  try {
    const path = await b.pickFile({
      title: t('选择 MIDI'),
      filters: [{ name: 'MIDI', extensions: ['mid', 'midi', 'kar', 'rmi'] }],
    });
    if (!path) return;
    const bytes = await b.readBinary(path);
    if (!bytes) { msg.value = t('读取文件失败'); return; }
    const { parseMidi, buildSong } = await import('../core/midi.js');
    const r = store.parseMidiTracks(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      buildSong, parseMidi);
    if (r.error) { msg.value = r.error; return; }
    const list = r.tracks || [];
    if (list.length === 1) {                       // 只有一条就不弹窗了
      applyPicked(list[0], r.tpb || 480, r.bpm || 120);
      return;
    }
    midiPick.value = { tracks: list, tpb: r.tpb || 480, bpm: r.bpm || 120 };
  } catch (e) {
    msg.value = String((e as any)?.message || e);
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
  if (!target) { msg.value = t('无法创建轨道'); return; }
  const n = store.applyMidiTrack(target.id, midiTrack, tpb, bpm, true);
  store.patchTrack(target.id, { name: target.name || midiTrack.name || '' });
  midiPick.value = null;
  msg.value = t('已导入 ') + String(n) + t(' 个音符');
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
const tplaying = ref(false);
const tpending = ref(false);         // 正在解码

const transport = getTransport();
transport.onTick = (ms, playing) => { tpos.value = ms; tplaying.value = playing; };

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
    if (err) { msg.value = err; return; }
  }
  transport.play();
  tplaying.value = transport.playing;
}
/** 重装后从头播（音频轨上的 ▶ 用） */
async function reloadThenPlay() {
  const err = await reloadTransport();
  if (err) { msg.value = err; return; }
  transport.seek(0);
  transport.play();
  tplaying.value = transport.playing;
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
async function doRender() { msg.value = await store.renderTrack(); }

/**
 * 渲染所有声部轨。
 *
 * 渲染是串行的（两条 DiffSinger 同时跑会打满显存），一条几十秒，
 * 所以这里全程显示"正在渲染 i/n"，别让用户以为卡死了。
 */
async function doRenderAll() {
  msg.value = '';
  const err = await store.renderAll();
  msg.value = err;
  await reloadTransport();          // 全部渲完再一次性装进传输器
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

function doSave() {
  const b = store.exportBytes();
  if (!b) { msg.value = t('还没有可导出的音频'); return; }
  const url = URL.createObjectURL(new Blob([b.buffer as ArrayBuffer], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = (tr.value?.name || 'render') + '.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ------------------------------------------------------------ 工程文件 */
/**
 * `.fufumidi` 自包含工程包。
 *
 * 编辑器状态原本只在内存里，关掉就没了；伴奏轨存的又是本机绝对路径，
 * 换台机器必然断链。工程包把伴奏一起打进 `files/`，轨道上只留 asset id。
 */
async function saveProject(saveAs: boolean) {
  msg.value = await store.saveProject(saveAs);
}
async function openProject() {
  const err = await store.openProject();
  msg.value = err;
  // 伴奏换成了包里解出来的那份 —— 传输器还握着旧字节，必须重装
  if (store.projectPath) await reloadTransport();
}
function newProject() {
  store.newProject();
  msg.value = '';
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
  <div class="sing">
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
          <Icon name="upload" :size="12" /> {{ t('导入 MIDI') }}
        </button>
      </div>

      <div class="trk-list" data-guide="sing-tracks">
        <div
          v-for="x in store.tracks" :key="x.id"
          class="trk-item" :class="{ on: x.id === store.activeTrackId }"
          @click="store.selectTrack(x.id)"
        >
          <div class="trk-row1">
            <select class="eng" :value="x.engine" @click.stop @change="onEngine(x.id, $event)">
              <option v-for="e in ENGINES" :key="e.id" :value="e.id">{{ e.id === 'utau' ? 'UTAU' : 'DS' }}</option>
            </select>
            <input class="nm" :value="x.name" :placeholder="t('未命名轨')"
                   @click.stop @input="store.patchTrack(x.id, { name: sval($event) })" />
            <button class="ib del" :title="t('删除轨')" @click.stop="store.removeTrack(x.id)">
              <Icon name="trash" :size="11" />
            </button>
          </div>
          <!-- 声部轨：选歌手 + 语言；音频轨：文件信息 + 静音 -->
          <template v-if="x.kind === 'voice'">
            <input class="pth" :value="x.singer" :placeholder="t('歌手目录（留空则该轨用默认歌手）')"
                   @click.stop @change="onSingerPath(x.id, $event)" />
            <div class="trk-row2" @click.stop>
              <select class="lang" :value="x.language" @click.stop
                      @change="store.patchTrack(x.id, { language: sval($event) })">
                <option v-for="L in LANGUAGES" :key="L.code" :value="L.code">{{ L.label }}</option>
              </select>
              <span v-if="store.renderByTrack[x.id]" class="rdy"
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
        <select class="dev" :value="store.device" :title="t('推理后端')"
                @change="store.device = sval($event)">
          <option value="auto">{{ t('自动') }}</option>
          <option value="cpu">CPU</option>
          <option value="cuda">CUDA</option>
          <option value="dml">DirectML</option>
        </select>
        <input v-if="isUtau" class="smp" :value="store.sampleNote" :title="t('UTAU 采样音（alias）')"
               @change="store.sampleNote = sval($event)" />
        <button class="btn" data-guide="sing-track-props" :disabled="!tr" @click="propsOpen = !propsOpen">
          <Icon name="sliders" :size="13" /> {{ t('轨道属性') }}
        </button>
        <button v-if="!isAudio" class="btn" data-guide="sing-render" :disabled="!tr" @click="doRender"
                :title="t('按该轨的引擎自动分派')">
          <Icon name="play" :size="13" /> {{ t('渲染本轨') }}
        </button>
        <button class="btn" data-guide="sing-render-all" :disabled="store.busy" @click="doRenderAll"
                :title="t('渲染所有声部轨，渲完一起播放')">
          <Icon name="zap" :size="13" /> {{ t('渲染全部轨') }}
        </button>
      </div>

      <div v-if="store.busy" class="edt-prog"><i :style="{ width: store.progress + '%' }" /></div>
      <p v-if="msg" class="edt-msg small">{{ msg }}</p>

      <!-- 传输栏：伴奏与渲染结果**同时播放**（Web Audio 单时钟，采样级同步） -->
      <div class="xport" data-guide="sing-transport">
        <button class="btn" :disabled="tpending" :title="t('播放 / 暂停')" @click="tplay">
          <Icon :name="tplaying ? 'pause' : 'play'" :size="13" />
        </button>
        <button class="btn" :title="t('停止（回到 0）')" @click="tstop">
          <Icon name="square" :size="12" />
        </button>
        <input
          class="xbar" type="range" min="0" :max="Math.max(1, transport.durationMs)"
          :value="tpos" @input="tseek" :disabled="tpending"
        />
        <span class="xtime small">{{ fmtMs(tpos) }} / {{ fmtMs(transport.durationMs) }}</span>
        <button class="btn" :disabled="tpending" :title="t('重新装载伴奏与渲染结果')"
                @click="reloadTransport">
          <Icon name="refresh" :size="12" />
        </button>
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
            {{ t('参数') }}
          </button>
          <button class="tab" :class="{ on: propsTab === 'fx' }" @click="propsTab = 'fx'">
            {{ t('效果链') }}<span v-if="fxList.length" class="cnt">{{ fxList.length }}</span>
          </button>
          <button class="tab" :class="{ on: propsTab === 'auto' }" @click="propsTab = 'auto'">
            {{ t('自动化') }}<span v-if="tr.curves && tr.curves.length" class="cnt">{{ tr.curves.length }}</span>
          </button>
          <span class="sp" />
          <button class="ib" :title="t('收起')" @click="propsOpen = false">×</button>
        </div>

        <!-- ── 参数 ── -->
        <div v-if="propsTab === 'params'" class="props small">
          <template v-if="isUtau">
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
          <label>{{ t('音量') }}<input type="number" step="0.5" min="-60" max="6"
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
              {{ t('应用') }}
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
            <button class="btn" @click="store.clearCurve(tr.id, curAbbr)">{{ t('清空') }}</button>
          </div>
          <div v-if="curCurve && curCurve.points.length" class="auto-grid">
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
          <p v-else class="muted">{{ t('还没有点，整条轨用默认值。') }}</p>
        </div>
      </div>

      <!-- MIDI 多轨时选一条 -->
      <div v-if="midiPick" class="pick small">
        <div class="pick-head">
          <b>{{ t('这个 MIDI 有 ') }}{{ midiPick.tracks.length }}{{ t(' 条旋律轨，选一条：') }}</b>
          <span class="sp" />
          <button class="btn" @click="midiPick = null">{{ t('取消') }}</button>
        </div>
        <ul class="pick-list">
          <li v-for="mt in midiPick.tracks" :key="mt.index">
            <span class="nm">{{ mt.name }}</span>
            <span class="muted">{{ mt.noteCount }} {{ t('音符') }} · {{ mt.minPitch }}–{{ mt.maxPitch }}</span>
            <button class="btn" @click="applyPicked(mt, midiPick?.tpb || 480, midiPick?.bpm || 120)">
              {{ t('用这条') }}
            </button>
          </li>
        </ul>
      </div>

      <!-- 共用钢琴卷帘 -->
      <PianoRoll
        v-if="tr && !isAudio"
        class="edt-roll"
        :notes="tr.notes"
        :selected-id="store.selectedId"
        :selected-ids="store.selectedIds"
        :bpm="store.bpm"
        :api="rollApi()"
        @edit-lyric="(id) => store.select(id)"
      />

      <!-- 选中音符的详细编辑（两边共用一套，引擎特有项按轨道显示） -->
      <div v-if="sel && !isAudio" class="det">
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
        <label><span>{{ t('起点') }}</span><input type="number" step="0.125" min="0" :value="sel.startBeat"
          @change="store.updateNote(sel.id, { startBeat: nval($event, 0) })" /></label>
        <label><span>{{ t('时长') }}</span><input type="number" step="0.125" min="0.125" :value="sel.durBeat"
          @change="store.updateNote(sel.id, { durBeat: Math.max(0.125, nval($event, 1)) })" /></label>
        <label><span>{{ t('音高') }}</span><input type="number" min="0" max="127" :value="sel.pitch"
          @change="store.updateNote(sel.id, { pitch: Math.max(0, Math.min(127, nval($event, 60))) })" /></label>
        <label class="ck"><input type="checkbox" :checked="sel.vibrato"
          @change="store.updateNote(sel.id, { vibrato: $event.target.checked })" /><span>{{ t('颤音') }}</span></label>
        <label><span>{{ t('深度') }}</span><input type="number" min="0" max="100" :value="sel.vibDepth"
          @change="store.updateNote(sel.id, { vibDepth: nval($event, 35) })" /></label>
        <label><span>{{ t('频率') }}</span><input type="number" step="0.5" min="0" max="12" :value="sel.vibFreq"
          @change="store.updateNote(sel.id, { vibFreq: nval($event, 5.5) })" /></label>
        <label v-if="isDs"><span>{{ t('音分偏移') }}</span><input type="number" min="-100" max="100" :value="sel.pitchOffset || 0"
          @change="store.updateNote(sel.id, { pitchOffset: nval($event, 0) })" /></label>
        <label v-if="isUtau"><span>{{ t('音量') }}</span><input type="number" min="0" max="100" :value="sel.velocity ?? 100"
          @change="store.updateNote(sel.id, { velocity: nval($event, 100) })" /></label>
        <label v-if="isUtau"><span>{{ t('GENC') }}</span><input type="number" min="-100" max="100" :value="sel.gender || 0"
          @change="store.updateNote(sel.id, { gender: nval($event, 0) })" /></label>
        <label v-if="isUtau"><span>{{ t('气声') }}</span><input type="number" min="0" max="100" :value="sel.breath || 0"
          @change="store.updateNote(sel.id, { breath: nval($event, 0) })" /></label>
      </div>

      <!-- 音高曲线（两边共用） -->
      <div v-if="!isAudio" class="curves">
        <div class="curves-head small">
          <b>{{ t('音高曲线') }}</b>
          <button class="btn" @click="curveAdd"><Icon name="plus" :size="12" /> {{ t('加点') }}</button>
          <button class="btn" @click="curveClear">{{ t('清空') }}</button>
          <span class="muted">{{ t('单位：音分（cent），作用于整条轨') }}</span>
        </div>
        <div v-if="tr && tr.pitchCurve.length" class="curves-grid small">
          <div v-for="(p, i) in tr.pitchCurve" :key="i" class="curve-row">
            <span class="ci">{{ i + 1 }}</span>
            <input :value="p.beat" step="0.25" :data-f="'beat'" @change="curveSet(i, $event)" />
            <input :value="p.cents" step="5" :data-f="'cents'" @change="curveSet(i, $event)" />
            <span class="muted">beat / cent</span>
          </div>
        </div>
        <p v-else class="muted small">{{ t('还没有曲线点。') }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sing { display: flex; height: 100%; min-height: 0; }

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
.proj { display: flex; align-items: center; gap: 6px; padding: 6px 12px;
        border-bottom: 1px solid var(--border); }
.proj .ptitle { flex: 0 1 200px; font-size: 12.5px; }
.proj .ppath { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.edt-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
           border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.edt-bar .who { font-size: 13px; }
.edt-bar .tag { font-size: 10.5px; padding: 1px 6px; border-radius: 4px;
                border: 1px solid var(--border); }
.edt-bar .tag.e-utau { background: rgba(80,190,120,.18); }
.edt-bar .tag.e-diffsinger { background: rgba(64,140,255,.18); }
.edt-prog { height: 3px; background: var(--surface-muted); }
.edt-prog i { display: block; height: 100%; background: var(--brand); transition: width .2s; }
.edt-msg { margin: 6px 12px; color: var(--brand-text); }
.edt-roll { margin: 8px 12px; }

.edt-bar .dev, .edt-bar .smp { font-size: 11.5px; }
.edt-bar .smp { width: 48px; }
.xport { display: flex; align-items: center; gap: 8px; padding: 6px 12px;
         border-bottom: 1px solid var(--border); }
.xport .xbar { flex: 1; min-width: 120px; }
.xport .xtime { min-width: 92px; text-align: right; font-variant-numeric: tabular-nums; }
.warn { margin: 4px 12px; color: var(--stone); }

.trk-import { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-bottom: 1px solid var(--border); }
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
.tprops .tab { border: 1px solid transparent; border-bottom: none; background: transparent;
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
.auto-grid { display: flex; flex-direction: column; gap: 4px; }
.auto-grid input { width: 84px; }

/* ---- 音符详情 ---- */
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
.curves { padding: 8px 12px; border-top: 1px solid var(--border); }
.curves-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.curves-grid { display: flex; flex-direction: column; gap: 4px; }
.curve-row { display: flex; align-items: center; gap: 6px; }
.curve-row input { width: 84px; }
.curve-row .ci { width: 18px; color: var(--stone); }
</style>

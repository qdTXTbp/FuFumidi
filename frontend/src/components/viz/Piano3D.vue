<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useAppStore } from '../../stores/app';
import { t } from '../../core/i18n.js';
import { listMidiInputs, selectMidiInput } from '../../core/midiin.js';
import { ensureAudio } from '../../audio.js';
import { drawVizWaterfallPost } from '../../core/viz/index.js';
import { FX_DEFAULTS } from '../../core/viz.js';
import { createGame } from '../../core/piano3d/game.js';
import { createRecorder } from '../../core/recorder.js';
import { encodeMidi } from '../../core/midi.js';
import { DEMO_SONGS, buildDemoSong } from '../../core/piano3d/demoSongs.js';
import { analyzeSong } from '../../core/piano3d/rating.js';

const props = defineProps({ song: { type: Object, default: null } });
const app = useAppStore();
const host = ref(null);
const cv = ref(null);
const devices = ref([]);
const deviceId = ref('');
const midiStatus = ref('');
const gameMode = ref('free');
const demoId = ref('');
const demoPlaying = ref(false);
const hasSong = ref(false);
const rating = ref(null);
const stats = reactive({ perfect:0, great:0, good:0, miss:0, combo:0, maxCombo:0, score:0, accuracy:0, judged:0, total:0 });
const recording = ref(false);
const localPlaying = ref(false);
const playStart = ref(0);
const flashNotes = new Map();
const visualHeld = new Map();
let visualTimers = [];
const recordedNotes = ref(0);
const lastTake = ref(null);
const mappingMode = ref(false);
const bindTarget = ref(48);
const keymapPage = ref(false);
const pendingBind = ref(null);
const program = ref(0);
const PROGRAMS = [
  { id: 0, label: '钢琴' }, { id: 4, label: '电钢琴' }, { id: 24, label: '吉他' },
  { id: 33, label: '贝斯' }, { id: 40, label: '小提琴' }, { id: 48, label: '弦乐' },
  { id: 56, label: '小号' }, { id: 73, label: '长笛' }, { id: 80, label: '合成器' },
];
const DEFAULT_KEYMAP = {
  // 低八度 C2–B2
  KeyZ: 36, KeyS: 37, KeyX: 38, KeyD: 39, KeyC: 40, KeyV: 41, KeyG: 42, KeyB: 43, KeyH: 44, KeyN: 45, KeyJ: 46, KeyM: 47,
  // 中八度 C3–B3
  KeyQ: 48, Digit2: 49, KeyW: 50, Digit3: 51, KeyE: 52, KeyR: 53, Digit5: 54, KeyT: 55, Digit6: 56, KeyY: 57, Digit7: 58, KeyU: 59,
  // 高八度 C4–B4
  KeyA: 60, KeyF: 61, KeyK: 62, KeyL: 63, Semicolon: 64, Quote: 65, Comma: 66, Period: 67, Slash: 68, KeyI: 69, KeyO: 70, KeyP: 71,
};
const KEY_LABELS = { Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=' };
function prettyKey(code) { return KEY_LABELS[code] || code.replace(/^Key/, '').replace(/^Digit/, ''); }
const keyMap = reactive({ ...DEFAULT_KEYMAP });
try { const saved = JSON.parse(localStorage.getItem('fufumidi_piano3d_keymap') || 'null'); if (saved && typeof saved === 'object') Object.assign(keyMap, saved); } catch (e) {}
const keyLabels = ref([]);

let raf = 0, game = null, recorder = null, demoTimers = [], demoStart = 0, lastHud = 0, localTimers = [];
let rendererCtx = null, mouseNote = null;
const renderState = {};
const activeInput = ref([]);
const WHITE_MIDI = Array.from({ length: 88 }, (_, i) => 21 + i).filter(m => ![1,3,6,8,10].includes(m % 12));
const BLACK_MIDI = Array.from({ length: 88 }, (_, i) => 21 + i).filter(m => [1,3,6,8,10].includes(m % 12));
const BLACK_CENTERS = BLACK_MIDI.map(m => {
  const i = WHITE_MIDI.indexOf(m - 1);
  return { midi: m, u: (i + 1) / WHITE_MIDI.length };
});

function activeSong() {
  const demo = DEMO_SONGS.find(d => d.id === demoId.value);
  return demo ? buildDemoSong(demo) : (props.song && props.song.song ? props.song.song : null);
}
function currentSec() {
  if ((demoPlaying.value || localPlaying.value) && hasSong.value) return (performance.now() - playStart.value) / 1000;
  return 0;
}
function noteActive(midi) {
  if (activeInput.value.includes(midi)) return true;
  if (visualHeld.has(midi)) return true;
  return (flashNotes.get(midi) || 0) > performance.now();
}
function activeNoteList() {
  const now = performance.now();
  const set = new Set(activeInput.value);
  for (const m of visualHeld.keys()) set.add(m);
  for (const [m, until] of flashNotes) if (until > now) set.add(m);
  return [...set].map(midi => ({ midi }));
}
function holdVisual(midi, dur) {
  if (midi == null) return;
  visualHeld.set(midi, (visualHeld.get(midi) || 0) + 1);
  const tm = setTimeout(() => {
    const n = (visualHeld.get(midi) || 1) - 1;
    if (n <= 0) visualHeld.delete(midi); else visualHeld.set(midi, n);
  }, Math.max(80, dur * 1000));
  visualTimers.push(tm);
}
function clearVisual() { visualTimers.forEach(clearTimeout); visualTimers = []; visualHeld.clear(); }
function prepareVisualSong(song) {
  if (!song || !song.tracks) return song;
  const clone = { ...song, tracks: song.tracks.map(tr => ({ ...tr, notes: (tr.notes || []).map(n => ({ ...n })) })) };
  for (const tr of clone.tracks) {
    const byPitch = new Map();
    for (const n of tr.notes) { const p = n.pitch != null ? n.pitch : n.midi; if (!byPitch.has(p)) byPitch.set(p, []); byPitch.get(p).push(n); }
    for (const arr of byPitch.values()) {
      arr.sort((a, b) => (a.start || 0) - (b.start || 0));
      for (let i = 0; i < arr.length - 1; i++) {
        const cur = arr[i], next = arr[i + 1];
        const gap = Math.max(1, Math.round((clone.tpb || 480) * 0.025));
        if ((next.start || 0) < (cur.end || 0)) cur.end = Math.max((cur.start || 0) + 1, (next.start || 0) - gap);
      }
    }
  }
  return clone;
}
function refreshSong() {
  const s = activeSong();
  hasSong.value = !!s;
  rating.value = s ? analyzeSong(s) : null;
  game = s ? createGame(s) : null;
  Object.assign(stats, game ? game.stats() : { perfect:0,great:0,good:0,miss:0,combo:0,maxCombo:0,score:0,accuracy:0,judged:0,total:0 });
  const arr = [];
  for (const [code, midi] of Object.entries(keyMap)) arr.push({ code, label: prettyKey(code), midi });
  keyLabels.value = arr.sort((a, b) => a.midi - b.midi);
}
function saveKeyMap() { try { localStorage.setItem('fufumidi_piano3d_keymap', JSON.stringify(keyMap)); } catch (e) {} }
function playSound(midi, dur = .3) {
  try {
    const { ctx, synth } = ensureAudio();
    if (!ctx || !synth) return;
    try { synth.setChannelProgram(0, Math.max(0, Math.min(127, Number(program.value) || 0))); } catch (e) {}
    if (ctx.state === 'suspended') ctx.resume();
    synth.noteOn(ctx.currentTime + .005, { midi, pitch: midi, vel: 100, trk: 0, ch: 0, isDrum: false }, ctx.currentTime + Math.max(.1, dur));
  } catch (e) {}
}
function pressNote(n) {
  if (n == null) return;
  flashNotes.set(n, performance.now() + 420);
  if (!activeInput.value.includes(n)) activeInput.value.push(n);
  playSound(n, .28);
  if (recording.value && recorder) { try { recorder.noteOn(n, 100, performance.now()); } catch (e) {} }
  if (gameMode.value === 'game' && game) { game.input(n, currentSec()); Object.assign(stats, game.stats()); }
}
function releaseNote(n) {
  activeInput.value = activeInput.value.filter(x => x !== n);
  if (recording.value && recorder) { try { recorder.noteOff(n, performance.now()); } catch (e) {} } }
function noteName(midi) {
  const nn = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return nn[midi % 12] + (Math.floor(midi / 12) - 1);
}
function openKeymapPage() { keymapPage.value = true; mappingMode.value = false; pendingBind.value = null; stopDemo(); }
function closeKeymapPage() { keymapPage.value = false; pendingBind.value = null; }
function beginBind(midi) { pendingBind.value = midi; app.toast(t('请按一个电脑键') , 'ok'); }
function bindPending(code) {
  if (pendingBind.value == null) return;
  for (const [c, m] of Object.entries(keyMap)) if (m === pendingBind.value) delete keyMap[c];
  keyMap[code] = pendingBind.value; saveKeyMap(); refreshSong();
  app.toast(t('键位已绑定') + '：' + prettyKey(code), 'ok');
  pendingBind.value = null;
}
function resetKeymap() {
  for (const k of Object.keys(keyMap)) delete keyMap[k];
  Object.assign(keyMap, DEFAULT_KEYMAP); saveKeyMap(); refreshSong(); pendingBind.value = null;
  app.toast(t('已恢复默认键位'), 'ok');
}
// 3D 页面独占键盘：先于全局快捷键捕获，只让本页的钢琴键与键位设置生效。
function onGlobalKeyDown(e) {
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (['input','select','textarea'].includes(tag) || (e.target && e.target.isContentEditable)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (keymapPage.value) {
    if (e.code === 'Escape') { closeKeymapPage(); return; }
    if (pendingBind.value != null) bindPending(e.code);
    return;
  }
  if (e.code === 'Escape') return;
  const n = keyMap[e.code];
  if (n != null) pressNote(n);
  // 其它全局快捷键在 3D 钢琴里一律不生效（用户要求），只保留本页弹奏。
}
function onGlobalKeyUp(e) {
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (['input','select','textarea'].includes(tag) || (e.target && e.target.isContentEditable)) return;
  e.stopImmediatePropagation();
  const n = keyMap[e.code]; if (n != null) releaseNote(n);
}
function startDemo() {
  stopDemo();
  const demo = DEMO_SONGS.find(d => d.id === demoId.value); if (!demo) return;
  demoPlaying.value = true; localPlaying.value = true; playStart.value = performance.now(); refreshSong();
  const song = buildDemoSong(demo);
  for (const n of demo.notes) {
    const dur = Math.max(.08, song.baseSec(n.end) - song.baseSec(n.start));
    demoTimers.push(setTimeout(() => { holdVisual(n.pitch, dur); playSound(n.pitch, dur); }, song.baseSec(n.start) * 1000));
  }
}
function stopDemo() { demoTimers.forEach(clearTimeout); demoTimers = []; clearLocalTimers(); clearVisual(); demoPlaying.value = false; localPlaying.value = false; }
function clearLocalTimers() { localTimers.forEach(clearTimeout); localTimers = []; }
function scheduleSong(song, fromSec) {
  clearLocalTimers();
  if (!song || !song.tracks) return;
  const base = typeof song.baseSec === 'function' ? song.baseSec.bind(song) : (t => t / (song.tpb || 480));
  let n = 0;
  for (const tr of song.tracks) for (const x of (tr.notes || [])) {
    const pitch = x.pitch != null ? x.pitch : x.midi;
    const st = base(x.start || 0);
    if (!Number.isFinite(pitch) || !Number.isFinite(st) || st < fromSec - 0.2) continue;
    if (++n > 5000) return;
    const dur = Math.max(.08, base(x.end != null ? x.end : x.start || 0) - st);
    localTimers.push(setTimeout(() => { holdVisual(pitch, dur); playSound(pitch, dur); }, Math.max(0, (st - fromSec) * 1000)));
  }
}
function startLocal() {
  if (!hasSong.value) return;
  stopDemo();
  const song = activeSong();
  localPlaying.value = true; playStart.value = performance.now(); refreshSong();
  scheduleSong(song, 0);
}
function stopLocal() { localPlaying.value = false; clearLocalTimers(); }
function toggleDemo() {
  if (demoPlaying.value || localPlaying.value) { stopDemo(); return; }
  if (demoId.value) startDemo(); else startLocal();
}
function selectDemo() { stopDemo(); refreshSong(); }
function startRec() {
  if (recording.value) return;
  const s = activeSong(); if (!s) { app.toast(t('请先载入曲目'), 'warn'); return; }
  try {
    recorder = createRecorder({ tpb: s.tpb || 480, bpm: s.initialBpm || 120, preRollBars: 0, quantize: 'off', mode: 'overdub' });
    recorder.start({ atMs: performance.now(), startTick: 0, loopStartTick: 0, loopEndTick: (s.tpb || 480) * 64 });
    recording.value = true; recordedNotes.value = 0; lastTake.value = null;
  } catch (e) { app.toast(t('录音启动失败：') + ((e && e.message) || e), 'warn'); }
}
function stopRec() {
  if (!recording.value || !recorder) return;
  try { lastTake.value = recorder.stop(performance.now()); } catch (e) { lastTake.value = null; }
  recorder = null; recording.value = false;
  recordedNotes.value = lastTake.value && lastTake.value.notes ? lastTake.value.notes.length : 0;
}
async function saveRec() {
  const take = lastTake.value; if (!take || !take.notes || !take.notes.length) { app.toast(t('还没有录到音符'), 'warn'); return; }
  const s = activeSong(); const tpb = (s && s.tpb) || 480, bpm = (s && s.initialBpm) || 120;
  const st = Number(take.takeStartTick) || 0;
  const bytes = encodeMidi([{ name: t('3D 钢琴录音'), ch: 0, program: Number(program.value) || 0, notes: take.notes.map(n => ({ start: st + n.start, end: st + Math.max(1, n.end), midi: n.midi, vel: n.vel, ch: 0 })) }], { ticksPerBeat: tpb, tempoMap: [{ tick: 0, us: Math.round(60000000 / bpm) }] });
  try { const path = await app.writeMidiFile(t('3D 钢琴录音') + '.mid', bytes); app.toast(path ? t('已保存') + '：' + path : t('保存失败'), path ? 'ok' : 'warn'); } catch (e) { app.toast(t('保存失败：') + ((e && e.message) || e), 'warn'); }
}
async function refreshDevices() { devices.value = await listMidiInputs(); if (!deviceId.value && devices.value.length) deviceId.value = devices.value[0].id; }
async function chooseDevice() { const ok = await selectMidiInput(deviceId.value, { onNoteOn: (n) => pressNote(n), onNoteOff: (n) => releaseNote(n) }); midiStatus.value = ok ? t('已连接') : t('连接失败'); }

function draw() {
  raf = requestAnimationFrame(draw);
  const el = cv.value; if (!el) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = el.clientWidth || 800, h = el.clientHeight || 480;
  if (el.width !== Math.floor(w * dpr) || el.height !== Math.floor(h * dpr)) { el.width = Math.floor(w * dpr); el.height = Math.floor(h * dpr); }
  if (!rendererCtx) rendererCtx = el.getContext('2d');
  const ctx = rendererCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const song = prepareVisualSong(activeSong());
  if (!song) return;
  const sec = currentSec();
  const tick = typeof song.secToTick === 'function' ? song.secToTick(sec) : sec * (song.tpb || 480) * (song.initialBpm || 120) / 60;
  try {
    drawVizWaterfallPost(ctx, w, h, song, tick, {
      state: renderState, zoom: 1, showLyrics: false, lyricAt: '', activeNotes: activeNoteList(), energy: 0,
      fx: { ...FX_DEFAULTS, keys3d: true, persp: 0.68, keyNames: false, particles: false, beams: false, hitLine: true, gloss: true },
      wallClock: true,
      theme: {}, bg: {},
    });
  } catch (e) { console.error('[p3d] draw failed', e); }
  if (gameMode.value === 'game' && game) {
    game.tick(sec);
    const now = performance.now();
    if (now - lastHud > 120) { lastHud = now; Object.assign(stats, game.stats()); }
  }
}
function midiAt(ev) {
  const el = cv.value; if (!el) return null;
  const r = el.getBoundingClientRect();
  const x = (ev.clientX - r.left) / Math.max(1, r.width);
  const y = (ev.clientY - r.top) / Math.max(1, r.height);
  if (y < .55) return null;
  const kw = 1 / WHITE_MIDI.length;
  // 黑键在键盘上半段：先找最近的黑键中心，命中就返回黑键，否则回落白键。
  if (y < .88) {
    let best = null, bd = Infinity;
    for (const b of BLACK_CENTERS) { const d = Math.abs(x - b.u); if (d < bd) { bd = d; best = b; } }
    if (best && bd <= kw * 0.34) return best.midi;
  }
  const i = Math.max(0, Math.min(WHITE_MIDI.length - 1, Math.floor(x * WHITE_MIDI.length)));
  return WHITE_MIDI[i];
}
function onPointerDown(ev) {
  const midi = midiAt(ev);
  if (midi == null) return;
  if (mappingMode.value) { bindTarget.value = midi; app.toast(t('已选中琴键，请按一个电脑键绑定'), 'ok'); return; }
  mouseNote = midi; pressNote(midi);
  try { cv.value.setPointerCapture(ev.pointerId); } catch (e) {}
  ev.preventDefault();
}
function onPointerMove(ev) {
  if (mouseNote == null) return;
  const midi = midiAt(ev);
  if (midi != null && midi !== mouseNote) { releaseNote(mouseNote); mouseNote = midi; pressNote(midi); }
}
function onPointerUp() { if (mouseNote != null) { releaseNote(mouseNote); mouseNote = null; } }
function resize() { rendererCtx = null; }
onMounted(async () => {
  refreshSong(); window.addEventListener('resize', resize);
  window.addEventListener('keydown', onGlobalKeyDown, true); window.addEventListener('keyup', onGlobalKeyUp, true);
  cv.value.addEventListener('pointerdown', onPointerDown);
  cv.value.addEventListener('pointermove', onPointerMove);
  cv.value.addEventListener('pointerup', onPointerUp);
  cv.value.addEventListener('pointercancel', onPointerUp);
  try { if (app.playing) await app.togglePlay(); } catch (e) {}
  draw();
  try { await refreshDevices(); if (deviceId.value) await chooseDevice(); } catch (e) { midiStatus.value = t('MIDI 初始化失败'); }
});
watch(() => props.song, () => { if (!demoId.value) { stopDemo(); refreshSong(); } });
watch(() => demoId, () => refreshSong());
onBeforeUnmount(() => {
  cancelAnimationFrame(raf); stopDemo(); clearLocalTimers(); localPlaying.value = false; window.removeEventListener('resize', resize);
  window.removeEventListener('keydown', onGlobalKeyDown, true); window.removeEventListener('keyup', onGlobalKeyUp, true);
  try { cv.value.removeEventListener('pointerdown', onPointerDown); cv.value.removeEventListener('pointermove', onPointerMove); cv.value.removeEventListener('pointerup', onPointerUp); cv.value.removeEventListener('pointercancel', onPointerUp); } catch (e) {}
  try { selectMidiInput('', {}); } catch (e) {}
});
</script>

<template>
  <div ref="host" class="p3d">
    <canvas ref="cv" class="p3d-canvas"></canvas>
    <div class="p3d-top">
      <b>3D 钢琴</b>
      <select v-model="demoId" class="select-input p3d-sel" style="width:116px" @change="selectDemo">
        <option value="">{{ t('当前导入曲目') }}</option>
        <option v-for="d in DEMO_SONGS" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button class="chip-btn" :disabled="!hasSong" @click="toggleDemo">{{ demoPlaying || localPlaying ? t('暂停') : t('播放') }}</button>
      <span v-if="rating" class="p3d-rating">{{ rating.level }}/10 · {{ rating.label }}</span>
      <span class="p3d-grow"></span>
      <select v-model.number="program" class="select-input p3d-sel" style="width:82px">
        <option v-for="pg in PROGRAMS" :key="pg.id" :value="pg.id">{{ t(pg.label) }}</option>
      </select>
      <select v-model="gameMode" class="select-input p3d-sel" style="width:86px">
        <option value="free">{{ t('自由演奏') }}</option>
        <option value="game">{{ t('音游模式') }}</option>
      </select>
      <button class="chip-btn" @click="openKeymapPage">{{ t('键位设置') }}</button>
      <button class="chip-btn" :class="{ active: recording }" @click="recording ? stopRec() : startRec()">{{ recording ? t('停止') : t('录音') }}</button>
      <button v-if="lastTake" class="chip-btn" @click="saveRec">{{ t('保存') }}</button>
      <select v-model="deviceId" class="select-input p3d-sel" style="width:118px" @change="chooseDevice">
        <option value="">{{ t('MIDI 键盘') }}</option>
        <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button class="chip-btn" @click="refreshDevices">{{ t('刷新') }}</button>
    </div>
    <div v-if="keymapPage" class="p3d-page">
      <div class="p3d-page-head">
        <b>{{ t('键位设置') }}</b>
        <span class="muted">{{ t('点击「重新绑定」后按电脑键；Esc 关闭') }}</span>
        <span class="p3d-grow"></span>
        <button class="chip-btn" @click="resetKeymap">{{ t('恢复默认') }}</button>
        <button class="chip-btn" @click="closeKeymapPage">{{ t('关闭') }}</button>
      </div>
      <div class="p3d-page-body">
        <div class="p3d-bind-grid">
          <div v-for="l in keyLabels" :key="l.midi" class="p3d-bind-row" :class="{ waiting: pendingBind === l.midi }">
            <span class="p3d-bind-key">{{ l.label }}</span>
            <span class="p3d-bind-note">{{ noteName(l.midi) }}</span>
            <button class="chip-btn" @click="beginBind(l.midi)">{{ pendingBind === l.midi ? t('请按键…') : t('重新绑定') }}</button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="!hasSong" class="p3d-empty">{{ t('载入一首 MIDI 或选择内置曲目') }}</div>
    <div v-if="gameMode === 'game' && hasSong" class="p3d-score">
      <span class="p3d-grade" :class="stats.lastGrade">{{ stats.lastGrade || 'READY' }}</span>
      <b>{{ stats.score }}</b>
      <span>{{ t('连击') }} {{ stats.combo }}</span>
      <span>{{ t('准确率') }} {{ stats.accuracy }}%</span>
      <span class="muted">{{ stats.perfect }}P / {{ stats.great }}G / {{ stats.good }}Gd / {{ stats.miss }}M</span>
    </div>
    <div class="p3d-labels">
      <span v-for="l in keyLabels" :key="l.code" class="p3d-key" :class="{ active: noteActive(l.midi) }">{{ l.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.p3d { position:relative; width:100%; height:100%; min-height:560px; display:flex; flex-direction:column; gap:8px; overflow:hidden; border-radius:var(--r-sm); background:transparent; color:var(--text); }
.p3d-canvas { position:relative; order:2; flex:1 1 auto; width:100%; min-height:420px; display:block; border-radius:var(--r-sm); background:var(--canvas); border:1px solid var(--hairline); }
.p3d-top { position:relative; order:1; z-index:5; display:flex; align-items:center; gap:6px; overflow-x:auto; white-space:nowrap; padding:8px 10px; border-radius:var(--r-sm); background:color-mix(in srgb, var(--panel) 86%, transparent); border:1px solid var(--hairline); box-shadow: var(--shadow-sm, 0 4px 18px rgba(0,0,0,.18)); backdrop-filter:blur(14px); color:var(--text); }
.p3d-sel { flex:0 0 auto; min-width:0; }
.p3d-top b { flex:0 0 auto; font-size:var(--fs-md,13px); color:var(--text); } .p3d-sub { color:var(--text3); font-size:var(--fs-xs,11px); } .p3d-grow { flex:1 0 8px; }
.p3d-rating { font-size:var(--fs-xs,11px); color:var(--text2); } .p3d-rating b { color:var(--accent-sky, #6cc7ff); font-size:var(--fs-md,15px); }
.p3d-page { position:absolute; inset:8px; z-index:20; border-radius:var(--r-lg); border:1px solid var(--hairline); box-shadow:var(--shadow-lg, 0 20px 60px rgba(0,0,0,.35)); display:flex; flex-direction:column; background:color-mix(in srgb, var(--panel) 96%, transparent); backdrop-filter:blur(18px); padding:18px 22px; }
.p3d-page-head { display:flex; align-items:center; gap:var(--sp-2,10px); padding-bottom:12px; border-bottom:1px solid var(--hairline); color:var(--text); }
.p3d-page-head b { font-size:var(--fs-lg,17px); }
.p3d-page-body { flex:1; overflow:auto; padding-top:14px; }
.p3d-bind-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:8px; }
.p3d-bind-row { display:flex; align-items:center; gap:var(--sp-2,10px); padding:8px 10px; border:1px solid var(--hairline); border-radius:var(--r-sm); background:color-mix(in srgb, var(--card) 82%, transparent); color:var(--text); }
.p3d-bind-row.waiting { border-color:var(--accent-sky); box-shadow:0 0 16px color-mix(in srgb, var(--accent-sky) 36%, transparent); }
.p3d-bind-key { min-width:34px; text-align:center; padding:2px 6px; border-radius:6px; border:1px solid color-mix(in srgb, var(--accent-sky) 42%, var(--hairline)); background:color-mix(in srgb, var(--accent-sky) 10%, transparent); font:700 var(--fs-xs,11px) Consolas, monospace; color:var(--accent-sky); }
.p3d-bind-note { flex:1; color:var(--text2); font-size:var(--fs-xs,12px); }
.p3d-empty { position:absolute; left:0; right:0; top:80px; bottom:60px; display:grid; place-items:center; color:var(--text3); z-index:2; pointer-events:none; }
.p3d-score { position:absolute; right:14px; bottom:52px; z-index:4; display:flex; align-items:center; gap:9px; padding:7px 11px; border-radius:var(--r-sm); background:color-mix(in srgb, var(--panel) 86%, transparent); border:1px solid var(--hairline); color:var(--text); font-size:var(--fs-xs,11px); }
.p3d-score b { font-size:19px; color:#8fd6ff; } .p3d-grade { font-weight:800; color:#ffd166; min-width:50px; } .p3d-grade.miss { color:#ff7b7b; }
.p3d-labels { position:absolute; left:20px; right:20px; bottom:10px; z-index:4; display:flex; justify-content:center; gap:5px; pointer-events:none; flex-wrap:wrap; }
.p3d-key.active { background:var(--accent-sky) !important; border-color:color-mix(in srgb, var(--accent-sky) 60%, white) !important; color:var(--on-accent, #03111e) !important; box-shadow:0 0 14px color-mix(in srgb, var(--accent-sky) 70%, transparent); transform:translateY(2px) scale(1.12); }
.p3d-key { padding:2px 5px; transition:all .08s ease; border-radius:4px; border:1px solid rgba(120,210,255,.45); background:rgba(4,10,18,.62); color:#dff1ff; font:600 10px/1.1 Consolas, monospace; }
.p3d-hint { position:absolute; left:16px; bottom:42px; z-index:4; color:#75a3bd; font-size:11px; pointer-events:none; }
</style>

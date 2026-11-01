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
const recordedNotes = ref(0);
const lastTake = ref(null);
const mappingMode = ref(false);
const bindTarget = ref(48);
const program = ref(0);
const PROGRAMS = [
  { id: 0, label: '钢琴' }, { id: 4, label: '电钢琴' }, { id: 24, label: '吉他' },
  { id: 33, label: '贝斯' }, { id: 40, label: '小提琴' }, { id: 48, label: '弦乐' },
  { id: 56, label: '小号' }, { id: 73, label: '长笛' }, { id: 80, label: '合成器' },
];
const DEFAULT_KEYMAP = {
  KeyZ: 48, KeyS: 49, KeyX: 50, KeyD: 51, KeyC: 52, KeyV: 53, KeyG: 54, KeyB: 55, KeyH: 56, KeyN: 57, KeyJ: 58, KeyM: 59,
  KeyQ: 60, Digit2: 61, KeyW: 62, Digit3: 63, KeyE: 64, KeyR: 65, Digit5: 66, KeyT: 67, Digit6: 68, KeyY: 69, Digit7: 70, KeyU: 71, KeyI: 72,
};
const keyMap = reactive({ ...DEFAULT_KEYMAP });
try { const saved = JSON.parse(localStorage.getItem('fufumidi_piano3d_keymap') || 'null'); if (saved && typeof saved === 'object') Object.assign(keyMap, saved); } catch (e) {}
const keyLabels = ref([]);

let raf = 0, game = null, recorder = null, demoTimers = [], demoStart = 0, lastHud = 0;
let rendererCtx = null;

function activeSong() {
  const demo = DEMO_SONGS.find(d => d.id === demoId.value);
  return demo ? buildDemoSong(demo) : (props.song && props.song.song ? props.song.song : null);
}
function currentSec() {
  if (demoPlaying.value && demoId.value) return (performance.now() - demoStart) / 1000;
  try { return app.curSec || 0; } catch (e) { return 0; }
}
function refreshSong() {
  const s = activeSong();
  hasSong.value = !!s;
  rating.value = s ? analyzeSong(s) : null;
  game = s ? createGame(s) : null;
  Object.assign(stats, game ? game.stats() : { perfect:0,great:0,good:0,miss:0,combo:0,maxCombo:0,score:0,accuracy:0,judged:0,total:0 });
  const arr = [];
  for (const [code, midi] of Object.entries(keyMap)) arr.push({ code: code.replace(/^Key/, '').replace(/^Digit/, ''), midi });
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
  playSound(n, .28);
  if (recording.value && recorder) { try { recorder.noteOn(n, 100, performance.now()); } catch (e) {} }
  if (gameMode.value === 'game' && game) { game.input(n, currentSec()); Object.assign(stats, game.stats()); }
}
function releaseNote(n) { if (recording.value && recorder) { try { recorder.noteOff(n, performance.now()); } catch (e) {} } }
function keyDown(e) {
  if (!e || e.repeat) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (['input','select','textarea'].includes(tag) || (e.target && e.target.isContentEditable)) return;
  if (mappingMode.value) {
    e.preventDefault();
    for (const [code, m] of Object.entries(keyMap)) if (m === bindTarget.value) delete keyMap[code];
    keyMap[e.code] = bindTarget.value; saveKeyMap(); refreshSong(); mappingMode.value = false;
    app.toast(t('键位已绑定'), 'ok'); return;
  }
  const n = keyMap[e.code]; if (n == null) return;
  e.preventDefault(); pressNote(n);
}
function keyUp(e) { const n = keyMap[e.code]; if (n != null) releaseNote(n); }
function startDemo() {
  stopDemo();
  const demo = DEMO_SONGS.find(d => d.id === demoId.value); if (!demo) return;
  demoPlaying.value = true; demoStart = performance.now(); refreshSong();
  const song = buildDemoSong(demo);
  for (const n of demo.notes) demoTimers.push(setTimeout(() => playSound(n.pitch, Math.max(.08, song.baseSec(n.end) - song.baseSec(n.start))), song.baseSec(n.start) * 1000));
}
function stopDemo() { demoTimers.forEach(clearTimeout); demoTimers = []; demoPlaying.value = false; }
function toggleDemo() { if (demoPlaying.value) stopDemo(); else startDemo(); }
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
  const song = activeSong();
  if (!song) return;
  const sec = currentSec();
  const tick = typeof song.secToTick === 'function' ? song.secToTick(sec) : sec * (song.tpb || 480) * (song.initialBpm || 120) / 60;
  try {
    drawVizWaterfallPost(ctx, w, h, song, tick, {
      state: {}, zoom: 1, showLyrics: false, lyricAt: '', activeNotes: [], energy: 0,
      fx: { ...FX_DEFAULTS, keys3d: true, persp: 0.68, keyNames: false, particles: false, beams: false, hitLine: true, gloss: true },
      theme: {}, bg: {},
    });
  } catch (e) {}
  if (gameMode.value === 'game' && game) {
    game.tick(sec);
    const now = performance.now();
    if (now - lastHud > 120) { lastHud = now; Object.assign(stats, game.stats()); }
  }
}
function resize() { rendererCtx = null; }
onMounted(async () => {
  refreshSong(); window.addEventListener('resize', resize);
  window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp);
  draw();
  try { await refreshDevices(); if (deviceId.value) await chooseDevice(); } catch (e) { midiStatus.value = t('MIDI 初始化失败'); }
});
watch(() => props.song, () => { if (!demoId.value) { stopDemo(); refreshSong(); } });
watch(() => demoId, () => refreshSong());
onBeforeUnmount(() => {
  cancelAnimationFrame(raf); stopDemo(); window.removeEventListener('resize', resize);
  window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp);
  try { selectMidiInput('', {}); } catch (e) {}
});
</script>

<template>
  <div ref="host" class="p3d">
    <canvas ref="cv" class="p3d-canvas"></canvas>
    <div class="p3d-top">
      <b>{{ t('3D 钢琴') }}</b>
      <span class="p3d-sub">{{ t('外接 MIDI / 电脑键盘') }}</span>
      <span class="p3d-grow"></span>
      <select v-model="demoId" class="select-input" style="width:120px" @change="selectDemo">
        <option value="">{{ t('当前导入曲目') }}</option>
        <option v-for="d in DEMO_SONGS" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button class="chip-btn" :disabled="!demoId" @click="toggleDemo">{{ demoPlaying ? t('停止示范') : t('播放示范') }}</button>
      <span v-if="rating" class="p3d-rating">{{ t('难度') }} <b>{{ rating.level }}</b>/10 · {{ rating.label }}</span>
      <select v-model.number="program" class="select-input" style="width:88px">
        <option v-for="pg in PROGRAMS" :key="pg.id" :value="pg.id">{{ t(pg.label) }}</option>
      </select>
      <select v-model="gameMode" class="select-input" style="width:88px">
        <option value="free">{{ t('自由演奏') }}</option>
        <option value="game">{{ t('音游模式') }}</option>
      </select>
      <button class="chip-btn" :class="{ active: mappingMode }" @click="mappingMode = !mappingMode">{{ mappingMode ? t('退出键位') : t('自定义键位') }}</button>
      <button class="chip-btn" :class="{ active: recording }" @click="recording ? stopRec() : startRec()">{{ recording ? t('停止录音') : t('录音') }}</button>
      <button v-if="lastTake" class="chip-btn" @click="saveRec">{{ t('保存 MIDI') }}</button>
      <span class="p3d-grow"></span>
      <select v-model="deviceId" class="select-input" style="width:140px" @change="chooseDevice">
        <option value="">{{ t('选择 MIDI 键盘') }}</option>
        <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button class="chip-btn" @click="refreshDevices">{{ t('刷新') }}</button>
    </div>
    <div v-if="mappingMode" class="p3d-bindbar">
      <span>{{ t('选择要绑定的音') }}</span>
      <select v-model.number="bindTarget" class="select-input">
        <option v-for="l in keyLabels" :key="l.midi" :value="l.midi">{{ l.code }}</option>
      </select>
      <span class="muted">{{ t('然后按一个电脑键') }}</span>
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
      <span v-for="l in keyLabels" :key="l.code" class="p3d-key">{{ l.code }}</span>
    </div>
    <div class="p3d-hint">{{ t('电脑键盘：Z–M / Q–I 弹奏 · 点击琴键试听') }}</div>
  </div>
</template>

<style scoped>
.p3d { position:relative; width:100%; height:100%; min-height:560px; overflow:hidden; border-radius:18px; background:#050912; }
.p3d-canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
.p3d-top { position:absolute; top:10px; left:12px; right:12px; z-index:5; display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:7px 9px; border-radius:11px; background:rgba(5,12,24,.7); border:1px solid rgba(105,180,255,.16); backdrop-filter:blur(12px); color:#dff1ff; }
.p3d-top b { font-size:13px; } .p3d-sub { color:#7eabc9; font-size:11px; } .p3d-grow { flex:1; min-width:6px; }
.p3d-rating { font-size:11px; color:#b9d8eb; } .p3d-rating b { color:#ffd166; font-size:15px; }
.p3d-bindbar { position:absolute; top:62px; left:12px; z-index:6; display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:9px; background:rgba(5,12,24,.82); border:1px solid rgba(255,209,102,.4); color:#dff1ff; font-size:12px; }
.p3d-empty { position:absolute; inset:0; display:grid; place-items:center; color:#89b6d1; z-index:2; pointer-events:none; }
.p3d-score { position:absolute; right:14px; bottom:48px; z-index:4; display:flex; align-items:center; gap:9px; padding:7px 11px; border-radius:10px; background:rgba(4,10,18,.76); border:1px solid rgba(120,210,255,.2); color:#dff1ff; font-size:11px; }
.p3d-score b { font-size:19px; color:#8fd6ff; } .p3d-grade { font-weight:800; color:#ffd166; min-width:50px; } .p3d-grade.miss { color:#ff7b7b; }
.p3d-labels { position:absolute; left:20px; right:20px; bottom:10px; z-index:4; display:flex; justify-content:center; gap:5px; pointer-events:none; flex-wrap:wrap; }
.p3d-key { padding:2px 5px; border-radius:4px; border:1px solid rgba(120,210,255,.45); background:rgba(4,10,18,.62); color:#dff1ff; font:600 10px/1.1 Consolas, monospace; }
.p3d-hint { position:absolute; left:16px; bottom:42px; z-index:4; color:#75a3bd; font-size:11px; pointer-events:none; }
</style>

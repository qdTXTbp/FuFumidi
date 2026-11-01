<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import * as THREE from 'three';
import { useAppStore } from '../../stores/app';
import { t } from '../../core/i18n.js';
import { listMidiInputs, selectMidiInput } from '../../core/midiin.js';
import { ensureAudio } from '../../audio.js';
import { createGame } from '../../core/piano3d/game.js';
import { createRecorder } from '../../core/recorder.js';
import { encodeMidi } from '../../core/midi.js';
import { DEMO_SONGS, buildDemoSong } from '../../core/piano3d/demoSongs.js';
import { analyzeSong } from '../../core/piano3d/rating.js';
import { drawVizWaterfallPost } from '../../core/viz/index.js';

const props = defineProps({ song: { type: Object, default: null } });
const app = useAppStore();
const host = ref(null);
const devices = ref([]);
const deviceId = ref('');
const midiStatus = ref('');
const hasSong = ref(false);
const gameMode = ref('free');   // free | game
const stats = reactive({ perfect:0, great:0, good:0, miss:0, combo:0, maxCombo:0, score:0, accuracy:0, judged:0, total:0 });
const demoId = ref('');
const demoPlaying = ref(false);
const fallSpeed = ref(1.15);
const program = ref(0);
const PROGRAMS = [
  { id: 0, label: '钢琴' }, { id: 4, label: '电钢琴' }, { id: 24, label: '吉他' },
  { id: 33, label: '贝斯' }, { id: 40, label: '小提琴' }, { id: 48, label: '弦乐' },
  { id: 56, label: '小号' }, { id: 73, label: '长笛' }, { id: 80, label: '合成器' },
];
const mappingMode = ref(false);
const bindTarget = ref(null);
const keyMap = reactive({});
let labelSprites = [];
let raycaster = null;
const demoStart = ref(0);
const rating = ref(null);
let demoTimers = [];
let toneCtx = null;
let game = null;
let recorder = null;
const recording = ref(false);
const recordedNotes = ref(0);
const lastTake = ref(null);
let lastStatsAt = 0;

let renderer, scene, camera, raf = 0;
let keys = [];                 // { midi, mesh, black, x }
let notePool = [];             // reusable bars
let wfCanvas = null, wfCtx = null, wfTexture = null, wfPlane = null;
let activeNotes = [];
let pressed = new Map();       // midi -> until (performance.now)
const zNear = 0.2;

function activeSong() {
  const demo = DEMO_SONGS.find(d => d.id === demoId.value);
  if (demo) return buildDemoSong(demo);
  return props.song && props.song.song ? props.song.song : null;
}
function currentSec() {
  if (demoPlaying.value && demoId.value) return (performance.now() - demoStart.value) / 1000;
  try { return app.curSec || 0; } catch (e) { return 0; }
}
function soundProgram() { return Math.max(0, Math.min(127, Number(program.value) || 0)); }
function playNoteSound(midi, dur = 0.32) {
  try {
    const { ctx, synth } = ensureAudio();
    if (ctx && synth) {
      try { synth.setChannelProgram(0, soundProgram()); } catch (e) {}
      if (ctx.state === 'suspended') ctx.resume();
      synth.noteOn(ctx.currentTime + 0.004, { midi, pitch: midi, vel: 100, trk: 0, ch: 0, isDrum: false }, ctx.currentTime + Math.max(0.1, dur));
      return;
    }
  } catch (e) {}
  tone(midi, dur);
}
function ensureTone() {
  if (toneCtx) return toneCtx;
  try { toneCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { toneCtx = null; }
  return toneCtx;
}
function tone(midi, dur = 0.35) {
  const ctx = ensureTone(); if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + Math.max(0.08, dur));
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + Math.max(0.1, dur) + 0.02);
  } catch (e) {}
}
function stopDemo() {
  demoTimers.forEach(clearTimeout); demoTimers = []; demoPlaying.value = false;
}
function startDemo() {
  stopDemo();
  const demo = DEMO_SONGS.find(d => d.id === demoId.value);
  if (!demo) return;
  demoPlaying.value = true; demoStart.value = performance.now();
  refreshGame();
  const song = buildDemoSong(demo);
  for (const n of demo.notes) {
    const at = song.baseSec(n.start) * 1000;
    demoTimers.push(setTimeout(() => tone(n.pitch, song.baseSec(n.end) - song.baseSec(n.start)), at));
  }
}
function toggleDemo() { if (demoPlaying.value) stopDemo(); else startDemo(); }
function selectDemo() { stopDemo(); refreshGame(); }

const KEY_TO_MIDI = {
  KeyZ: 48, KeyS: 49, KeyX: 50, KeyD: 51, KeyC: 52, KeyV: 53, KeyG: 54, KeyB: 55, KeyH: 56, KeyN: 57, KeyJ: 58, KeyM: 59,
  KeyQ: 60, Digit2: 61, KeyW: 62, Digit3: 63, KeyE: 64, KeyR: 65, Digit5: 66, KeyT: 67, Digit6: 68, KeyY: 69, Digit7: 70, KeyU: 71, KeyI: 72,
};
const heldKeys = new Set();
// 键位持久化 + 自定义：keyMap[KeyboardEvent.code] = MIDI
Object.assign(keyMap, KEY_TO_MIDI);
try {
  const saved = JSON.parse(localStorage.getItem('fufumidi_piano3d_keymap') || 'null');
  if (saved && typeof saved === 'object') Object.assign(keyMap, saved);
} catch (e) {}
function saveKeyMap() { try { localStorage.setItem('fufumidi_piano3d_keymap', JSON.stringify(keyMap)); } catch (e) {} }
function keyLabelFor(midi) {
  const hit = Object.entries(keyMap).find(([, m]) => m === midi);
  if (!hit) return '';
  return hit[0].replace(/^Key/, '').replace(/^Digit/, '');
}
function refreshLabels() {
  if (!scene) return;
  for (const sp of labelSprites) { try { scene.remove(sp); sp.material?.map?.dispose?.(); sp.material?.dispose?.(); } catch (e) {} }
  labelSprites = [];
  for (const k of keys) {
    const label = keyLabelFor(k.midi);
    if (!label) continue;
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(6,12,20,.82)'; g.beginPath(); g.roundRect(4, 8, 120, 48, 12); g.fill();
    g.strokeStyle = 'rgba(120,210,255,.85)'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#dff6ff'; g.font = 'bold 30px Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, 64, 33);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    sp.frustumCulled = false; sp.material.depthTest = false;
    sp.position.set(midiToX(k.midi), 0.62, k.black ? 0.36 : 0.86);
    sp.scale.set(0.34, 0.17, 1); sp.renderOrder = 20;
    scene.add(sp); labelSprites.push(sp);
  }
}
function keyDown(e) {
  if (!e || e.repeat) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
  // 自定义键位：先点 3D 琴键选中 MIDI，再按一个新电脑键
  if (mappingMode.value && bindTarget.value != null) {
    e.preventDefault();
    for (const [code, m] of Object.entries(keyMap)) if (m === bindTarget.value) delete keyMap[code];
    keyMap[e.code] = bindTarget.value;
    saveKeyMap(); refreshLabels(); bindTarget.value = null;
    app.toast(t('键位已绑定') + '：' + e.code.replace(/^Key/, ''), 'ok');
    return;
  }
  const n = keyMap[e.code]; if (n == null) return;
  e.preventDefault(); heldKeys.add(n); pressNote(n);
}
function keyUp(e) {
  const n = keyMap[e.code]; if (n == null) return;
  heldKeys.delete(n); releaseNote(n);
}

function midiToX(m) {
  // 21..108 白键/黑键近似坐标；等距即可，重点是 3D 观感
  const whiteIndex = [];
  for (let n = 21; n <= 108; n++) if (![1,3,6,8,10].includes(n % 12)) whiteIndex.push(n);
  const idx = whiteIndex.indexOf(m);
  if (idx >= 0) return (idx - (whiteIndex.length - 1) / 2) * 0.15;
  // 黑键落在相邻白键之间
  let prev = m - 1;
  while (!whiteIndex.includes(prev) && prev > 21) prev--;
  const i = whiteIndex.indexOf(prev);
  return (i - (whiteIndex.length - 1) / 2 + 0.5) * 0.15;
}

function isBlack(m) { return [1,3,6,8,10].includes(m % 12); }

function buildPiano() {
  const whiteMat = new THREE.MeshStandardMaterial({ color: '#f4f1e8', roughness: 0.35, metalness: 0.05 });
  const blackMat = new THREE.MeshStandardMaterial({ color: '#11151c', roughness: 0.28, metalness: 0.15 });
  for (let m = 21; m <= 108; m++) {
    const black = isBlack(m);
    const w = black ? 0.095 : 0.14;
    const h = black ? 0.28 : 0.16;
    const d = black ? 0.9 : 1.35;
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, black ? blackMat : whiteMat);
    mesh.position.set(midiToX(m), black ? 0.12 : 0.02, black ? -0.25 : 0);
    mesh.castShadow = true;
    scene.add(mesh);
    keys.push({ midi: m, mesh, black, baseY: mesh.position.y });
  }
  // 琴体
  const body = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.85, 2.6), new THREE.MeshStandardMaterial({ color: '#080b12', roughness: 0.22, metalness: 0.35 }));
  body.position.set(0, -0.55, -0.55); body.receiveShadow = true; scene.add(body);
}

function makeBars() {
  // 直接复用瀑布流渲染器：把它画到离屏 canvas，再作为 3D 背景纹理。
  wfCanvas = document.createElement('canvas');
  wfCanvas.width = 1024; wfCanvas.height = 576;
  wfCtx = wfCanvas.getContext('2d');
  wfTexture = new THREE.CanvasTexture(wfCanvas);
  wfTexture.colorSpace = THREE.SRGBColorSpace;
  wfPlane = new THREE.Mesh(new THREE.PlaneGeometry(18, 10), new THREE.MeshBasicMaterial({ map: wfTexture, transparent: true, depthWrite: false }));
  wfPlane.position.set(0, 3.6, -1.8); wfPlane.renderOrder = -1; scene.add(wfPlane);
  const geo = new THREE.BoxGeometry(0.16, 1, 0.08);
  const mats = [0x5cc8ff, 0xff6b9d, 0xffc45c, 0x9b7bff, 0x7ddf9a, 0xff9f5a].map(c => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending, depthWrite: false }));
  for (let i = 0; i < 260; i++) {
    const m = new THREE.Mesh(geo, mats[i % mats.length].clone());
    m.visible = false; scene.add(m); notePool.push(m);
  }
}

function updateBars(nowSec) {
  const song = activeSong();
  const tracks = (song && song.tracks) || [];
  // 取当前时间之后 4 秒内的音符
  let out = 0;
  if (song) {
    for (let ti = 0; ti < tracks.length && out < notePool.length; ti++) {
      const tr = tracks[ti];
      for (const n of (tr.notes || [])) {
        n._trackIdx = ti;
        const pitch = n.pitch != null ? n.pitch : n.midi;
        if (!Number.isFinite(pitch)) continue;
        const st = song.baseSec(n.start);
        const en = song.baseSec(n.end);
        const dt = st - nowSec;
        if (dt < -0.35 || dt > 4.2) continue;
        const obj = notePool[out++]; if (!obj) break;
        const dur = Math.max(0.08, en - st);
        obj.visible = true;
        const len = Math.max(0.12, dur * fallSpeed.value);
        obj.position.set(midiToX(pitch), 0.62 + dt * fallSpeed.value + len / 2, -0.06);
        obj.scale.set(1, len, 1);
        obj.material.opacity = 0.58 + Math.min(0.32, (n.vel || 80) / 500);
        if (obj.material.color && n._trackIdx != null) {
          const palette = [0x5cc8ff, 0xff6b9d, 0xffc45c, 0x9b7bff, 0x7ddf9a, 0xff9f5a];
          obj.material.color.setHex(palette[n._trackIdx % palette.length]);
        }
        obj.userData.pitch = pitch;
      }
    }
  }
  for (let i = out; i < notePool.length; i++) notePool[i].visible = false;
}

function animate() {
  raf = requestAnimationFrame(animate);
  const now = performance.now();
  for (const k of keys) {
    const until = pressed.get(k.midi) || 0;
    const down = until > now;
    k.mesh.position.y = k.baseY - (down ? 0.055 : 0);
  }
  const nowSec = currentSec();
  if (!window.__piano3dFrames) { window.__piano3dFrames = 0; console.log('[piano3d] first frame', nowSec, keys.length); } window.__piano3dFrames++;
  if (!activeSong()) { if (wfCtx) wfCtx.clearRect(0, 0, wfCanvas.width, wfCanvas.height); }
  else if (wfCtx) {
    try {
      const song = activeSong();
      const tick = typeof song.secToTick === 'function' ? song.secToTick(nowSec) : nowSec * (song.tpb || 480) * (song.initialBpm || 120) / 60;
      drawVizWaterfallPost(wfCtx, wfCanvas.width, wfCanvas.height, song, tick, { state: {}, zoom: 1, showLyrics: false, activeNotes: [], energy: 0, fx: {}, theme: {}, bg: {} });
      wfTexture.needsUpdate = true;
    } catch (e) {}
  }
  if (gameMode.value === 'game' && game) {
    game.tick(nowSec);
    if (now - lastStatsAt > 100) { lastStatsAt = now; Object.assign(stats, game.stats()); }
  }
  renderer.render(scene, camera);
}

function startRec() {
  if (recording.value) return;
  const songObj = activeSong();
  if (!songObj) { app.toast(t('请先载入曲目'), 'warn'); return; }
  try {
    recorder = createRecorder({ tpb: songObj.tpb || 480, bpm: songObj.initialBpm || 120, preRollBars: 0, quantize: 'off', mode: 'overdub' });
    recorder.start({ atMs: performance.now(), startTick: 0, loopStartTick: 0, loopEndTick: (songObj.tpb || 480) * 64 });
    recording.value = true; recordedNotes.value = 0; lastTake.value = null;
    app.toast(t('开始录音，弹奏外接键盘'), 'ok');
  } catch (e) { app.toast(t('录音启动失败：') + ((e && e.message) || e), 'warn'); }
}
function stopRec() {
  if (!recording.value || !recorder) return;
  try { lastTake.value = recorder.stop(performance.now()); } catch (e) { lastTake.value = null; }
  recorder = null; recording.value = false;
  recordedNotes.value = lastTake.value && lastTake.value.notes ? lastTake.value.notes.length : 0;
}
async function saveRec() {
  const take = lastTake.value;
  if (!take || !take.notes || !take.notes.length) { app.toast(t('还没有录到音符'), 'warn'); return; }
  const songObj = activeSong();
  const tpb = (songObj && songObj.tpb) || 480;
  const bpm = (songObj && songObj.initialBpm) || 120;
  const startTick = Number(take.takeStartTick) || 0;
  const notes = take.notes.map(n => ({ start: startTick + n.start, end: startTick + Math.max(1, n.end), midi: n.midi, vel: n.vel, ch: 0 }));
  const bytes = encodeMidi([{ name: t('3D 钢琴录音'), ch: 0, program: 0, notes }], { ticksPerBeat: tpb, tempoMap: [{ tick: 0, us: Math.round(60000000 / bpm) }] });
  try {
    const path = await app.writeMidiFile(t('3D 钢琴录音') + '.mid', bytes);
    app.toast(path ? t('已保存') + '：' + path : t('保存失败'), path ? 'ok' : 'warn');
  } catch (e) { app.toast(t('保存失败：') + ((e && e.message) || e), 'warn'); }
}
function refreshGame() {
  const song = activeSong();
  hasSong.value = !!song;
  game = song ? createGame(song) : null;
  rating.value = song ? analyzeSong(song) : null;
  Object.assign(stats, game ? game.stats() : { perfect:0,great:0,good:0,miss:0,combo:0,maxCombo:0,score:0,accuracy:0,judged:0,total:0 });
}
function pressNote(n) {
  if (n == null) return;
  pressed.set(n, performance.now() + 200);
  playNoteSound(n, 0.28);
  if (recording.value && recorder) { try { recorder.noteOn(n, 100, performance.now()); } catch (e) {} }
  if (gameMode.value === 'game' && game) {
    game.input(n, currentSec());
    Object.assign(stats, game.stats());
  }
}
function releaseNote(n) {
  if (recording.value && recorder) { try { recorder.noteOff(n, performance.now()); } catch (e) {} }
}
const midiDown = (n) => pressNote(n);
const midiUp = (n) => releaseNote(n);

async function refreshDevices() {
  devices.value = await listMidiInputs();
  if (!deviceId.value && devices.value.length) deviceId.value = devices.value[0].id;
}
async function chooseDevice() {
  const ok = await selectMidiInput(deviceId.value, {
    onNoteOn: (n) => midiDown(n),
    onNoteOff: (n) => midiUp(n),
  });
  midiStatus.value = ok ? t('已连接') : t('连接失败');
}

function setupPointer() {
  if (!renderer) return;
  raycaster = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    try {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera({ x, y }, camera);
      const hit = raycaster.intersectObjects(keys.map(k => k.mesh), false)[0];
      if (!hit) return;
      const k = keys.find(x => x.mesh === hit.object);
      if (!k) return;
      if (mappingMode.value) { bindTarget.value = k.midi; app.toast(t('请按一个电脑键绑定') + '：' + k.midi, 'ok'); return; }
      pressNote(k.midi); setTimeout(() => releaseNote(k.midi), 220);
    } catch (e) {}
  });
}
function resize() {
  const el = host.value; if (!el || !renderer) return;
  const w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
}

onMounted(async () => {
  const el = host.value;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x070b12, 1);
  renderer.shadowMap.enabled = true;
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x070b12, 8, 22);
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 5.2, 9.0); camera.lookAt(0, -0.8, -1.5);
  const amb = new THREE.HemisphereLight(0xaad4ff, 0x10131c, 1.1); scene.add(amb);
  const key = new THREE.DirectionalLight(0xbfe6ff, 2.2); key.position.set(-4, 8, 6); key.castShadow = true; scene.add(key);
  const rim = new THREE.PointLight(0x6a7cff, 2.2, 30); rim.position.set(5, 2, -4); scene.add(rim);
  buildPiano(); makeBars(); refreshGame(); refreshLabels(); setupPointer();
  window.__piano3d = { scene, camera, renderer, keys, notePool };
  console.log('[piano3d] built', keys.length, notePool.length);
  resize(); window.addEventListener('resize', resize);
  // 先渲染一帧，再初始化 MIDI：Web MIDI 权限/设备异常不能把 3D 场景一起卡黑。
  renderer.render(scene, camera);
  animate();
  refreshLabels(); window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  try { await refreshDevices(); if (deviceId.value) await chooseDevice(); } catch (e) { midiStatus.value = t('MIDI 初始化失败'); }
});
watch(() => props.song, () => { if (!demoId.value) { stopDemo(); refreshGame(); } });
watch(() => demoId, () => refreshGame());
onBeforeUnmount(() => {
  cancelAnimationFrame(raf); window.removeEventListener('resize', resize);
  window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); stopDemo();
  try { selectMidiInput('', {}); } catch (e) {}
  try { renderer && renderer.dispose(); } catch (e) {}
  try { host.value && renderer && host.value.removeChild(renderer.domElement); } catch (e) {}
});
</script>

<template>
  <div ref="host" class="piano3d-host">
    <div class="piano3d-hud">
      <b>{{ t('3D 钢琴') }}</b>
      <span class="muted small">{{ t('外接电钢琴直接弹') }}</span>
      <span style="flex:1"></span>
      <select v-model="deviceId" class="select-input" style="width:180px" @change="chooseDevice">
        <option value="">{{ t('选择 MIDI 键盘') }}</option>
        <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button class="chip-btn" @click="refreshDevices">{{ t('刷新') }}</button>
      <select v-model.number="program" class="select-input" style="width:96px" :title="t('音色')">
        <option v-for="pg in PROGRAMS" :key="pg.id" :value="pg.id">{{ t(pg.label) }}</option>
      </select>
      <select v-model="gameMode" class="select-input" style="width:96px">
        <option value="free">{{ t('自由演奏') }}</option>
        <option value="game">{{ t('音游模式') }}</option>
      </select>
      <span class="muted small">{{ midiStatus }}</span>
      <button class="chip-btn" :class="{ active: mappingMode }" @click="mappingMode = !mappingMode; bindTarget = null">{{ mappingMode ? t('退出键位') : t('自定义键位') }}</button>
      <button class="chip-btn" :class="{ active: recording }" @click="recording ? stopRec() : startRec()">{{ recording ? t('停止录音') : t('录音') }}</button>
      <span v-if="recordedNotes" class="muted small">{{ t('已录') }} {{ recordedNotes }} {{ t('个音符') }}</span>
      <button v-if="lastTake" class="chip-btn" @click="saveRec">{{ t('保存 MIDI') }}</button>
    </div>
    <div class="piano3d-bar">
      <span class="muted small">{{ t('内置曲目') }}</span>
      <select v-model="demoId" class="select-input" style="width:120px" @change="selectDemo">
        <option value="">{{ t('当前导入曲目') }}</option>
        <option v-for="d in DEMO_SONGS" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button class="chip-btn" :disabled="!demoId" @click="toggleDemo">{{ demoPlaying ? t('停止示范') : t('播放示范') }}</button>
      <span v-if="rating" class="piano3d-rating">难度 <b>{{ rating.level }}</b>/10 · {{ rating.label }}</span>
      <span class="muted small">{{ t('电脑键盘：Z–M / Q–I 弹奏') }}</span>
      <span class="muted small">{{ t('速度') }}</span>
      <input type="range" min="0.6" max="2.2" step="0.05" v-model.number="fallSpeed" style="width:80px" />
    </div>
    <div v-if="!hasSong" class="viz-empty" role="status"><b>{{ t('还没有可演奏的曲目') }}</b></div>
    <div v-if="hasSong && gameMode === 'game'" class="piano3d-score">
      <span class="piano3d-grade" :class="stats.lastGrade">{{ stats.lastGrade || 'READY' }}</span>
      <b>{{ stats.score }}</b>
      <span>{{ t('连击') }} {{ stats.combo }}</span>
      <span>{{ t('准确率') }} {{ stats.accuracy }}%</span>
      <span class="muted">{{ stats.perfect }}P / {{ stats.great }}G / {{ stats.good }}Gd / {{ stats.miss }}M</span>
    </div>
  </div>
</template>

<style scoped>
.piano3d-host { position:relative; width:100%; height:100%; min-height:360px; overflow:hidden; border-radius:var(--r-sm); background:#070b12; }
.piano3d-host canvas { display:block; width:100%; height:100%; }
.piano3d-hud { position:absolute; top:10px; left:12px; right:12px; display:flex; align-items:center; gap:8px; z-index:2; padding:8px 10px; border-radius:10px; background:rgba(8,14,26,.72); border:1px solid rgba(120,180,255,.18); backdrop-filter:blur(10px); }
.piano3d-hud b { color:#dff1ff; font-size:13px; }
.piano3d-bar { position:absolute; top:62px; left:12px; right:12px; display:flex; align-items:center; gap:8px; z-index:2; padding:7px 10px; border-radius:10px; background:rgba(8,14,26,.64); border:1px solid rgba(120,180,255,.14); backdrop-filter:blur(8px); }
.piano3d-rating { color:#cfe7ff; font-size:12px; } .piano3d-rating b { color:#ffd166; font-size:16px; }
.piano3d-score { position:absolute; right:16px; bottom:16px; display:flex; align-items:center; gap:10px; padding:8px 12px; border-radius:10px; background:rgba(8,14,26,.78); border:1px solid rgba(120,180,255,.2); color:#dff1ff; font-size:12px; z-index:2; }
.piano3d-score b { font-size:20px; color:#8fd6ff; }
.piano3d-grade { font-weight:800; color:#ffd166; min-width:58px; }
.piano3d-grade.miss { color:#ff7b7b; }
</style>

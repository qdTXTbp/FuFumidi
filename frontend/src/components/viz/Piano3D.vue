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

const props = defineProps({ song: { type: Object, default: null } });
const app = useAppStore();
const host = ref(null);
const labelLayer = ref(null);
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
const bindTarget = ref(null);
const fallSpeed = ref(1.4);
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

let renderer, scene, camera, raf = 0;
let keyboardGroup = null;
let keyMeshes = [];
let notePool = [], noteMeshes = [];
let noteData = [];
let labelEls = [];
let game = null;
let recorder = null;
let demoTimers = [];
let wfTick = 0;
let lastHudAt = 0;
const pressed = new Map();

function activeSong() {
  const demo = DEMO_SONGS.find(d => d.id === demoId.value);
  return demo ? buildDemoSong(demo) : (props.song && props.song.song ? props.song.song : null);
}
function currentSec() {
  if (demoPlaying.value && demoId.value) return (performance.now() - demoStart) / 1000;
  try { return app.curSec || 0; } catch (e) { return 0; }
}
let demoStart = 0;

function songNotes(song) {
  const out = [];
  if (!song || !song.tracks) return out;
  const base = typeof song.baseSec === 'function' ? song.baseSec.bind(song) : (t => t / (song.tpb || 480));
  for (let ti = 0; ti < song.tracks.length; ti++) {
    for (const n of (song.tracks[ti].notes || [])) {
      const pitch = n.pitch != null ? n.pitch : n.midi;
      const st = base(n.start || 0), en = base(n.end != null ? n.end : n.start || 0);
      if (!Number.isFinite(pitch) || !Number.isFinite(st) || !Number.isFinite(en)) continue;
      out.push({ pitch, st, en: Math.max(st + 0.04, en), ti, vel: n.vel || 80 });
    }
  }
  out.sort((a, b) => a.st - b.st);
  return out;
}
function rebuildSong() {
  const song = activeSong();
  hasSong.value = !!song;
  noteData = songNotes(song);
  rating.value = song ? analyzeSong(song) : null;
  game = song ? createGame(song) : null;
  Object.assign(stats, game ? game.stats() : { perfect:0, great:0, good:0, miss:0, combo:0, maxCombo:0, score:0, accuracy:0, judged:0, total:0 });
  rebuildLabels();
}
function refreshGame() { rebuildSong(); }
function noteLabel(n) { return n; }

function whiteIndex(m) {
  const arr = [];
  for (let i = 21; i <= 108; i++) if (![1,3,6,8,10].includes(i % 12)) arr.push(i);
  return arr;
}
const WHITES = whiteIndex(21);
function isBlack(m) { return [1,3,6,8,10].includes(m % 12); }
function xOf(m) {
  const i = WHITES.indexOf(m);
  if (i >= 0) return (i - (WHITES.length - 1) / 2) * 0.105;
  let p = m - 1; while (p > 21 && !WHITES.includes(p)) p--;
  return (WHITES.indexOf(p) - (WHITES.length - 1) / 2 + 0.5) * 0.105;
}
function buildKeyboard() {
  keyboardGroup = new THREE.Group();
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe8eef7, roughness: .32, metalness: .02 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x111722, roughness: .22, metalness: .18 });
  for (let m = 21; m <= 108; m++) {
    const black = isBlack(m), w = black ? 0.062 : 0.094, h = black ? 0.18 : 0.10, d = black ? 0.62 : 0.95;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), black ? blackMat : whiteMat);
    mesh.position.set(xOf(m), black ? 0.13 : 0.05, black ? 0.10 : 0.20);
    mesh.castShadow = true; mesh.receiveShadow = true;
    keyboardGroup.add(mesh); keyMeshes.push({ midi: m, mesh, black, baseY: mesh.position.y });
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(5.6, .42, 1.5), new THREE.MeshStandardMaterial({ color: 0x070b12, roughness: .3, metalness: .5 }));
  body.position.set(0, -.22, .05); body.receiveShadow = true; keyboardGroup.add(body);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(5.3, .08, .1), new THREE.MeshStandardMaterial({ color: 0x2c6fa8, emissive: 0x0b2d4a, metalness: .6, roughness: .25 }));
  rail.position.set(0, .09, .68); keyboardGroup.add(rail);
  keyboardGroup.position.y = 0; scene.add(keyboardGroup);
}
function makeNotes() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < 360; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: .78, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat); mesh.visible = false; scene.add(mesh);
    noteMeshes.push(mesh);
  }
}
function clearNoteTimers() { demoTimers.forEach(clearTimeout); demoTimers = []; }
function stopDemo() { clearNoteTimers(); demoPlaying.value = false; }
function playSound(n, dur = .3) {
  try {
    const { ctx, synth } = ensureAudio();
    if (!ctx || !synth) return;
    try { synth.setChannelProgram(0, Math.max(0, Math.min(127, Number(program.value) || 0))); } catch (e) {}
    if (ctx.state === 'suspended') ctx.resume();
    synth.noteOn(ctx.currentTime + .005, { midi: n, pitch: n, vel: 100, trk: 0, ch: 0, isDrum: false }, ctx.currentTime + Math.max(.1, dur));
  } catch (e) {}
}
function pressNote(n) {
  if (n == null) return;
  pressed.set(n, performance.now() + 260);
  playSound(n, .28);
  if (recording.value && recorder) { try { recorder.noteOn(n, 100, performance.now()); } catch (e) {} }
  if (gameMode.value === 'game' && game) { game.input(n, currentSec()); Object.assign(stats, game.stats()); }
}
function releaseNote(n) { if (recording.value && recorder) { try { recorder.noteOff(n, performance.now()); } catch (e) {} } }
function keyLabelFor(midi) {
  const hit = Object.entries(keyMap).find(([, m]) => m === midi);
  return hit ? hit[0].replace(/^Key/, '').replace(/^Digit/, '') : '';
}
function saveKeyMap() { try { localStorage.setItem('fufumidi_piano3d_keymap', JSON.stringify(keyMap)); } catch (e) {} }
function rebuildLabels() {
  if (!labelLayer.value) return;
  labelLayer.value.innerHTML = ''; labelEls = [];
  for (const k of keyMeshes) {
    const label = keyLabelFor(k.midi);
    if (!label) continue;
    const el = document.createElement('span');
    el.className = 'p3d-key-label';
    el.textContent = label;
    labelLayer.value.appendChild(el);
    labelEls.push({ el, midi: k.midi });
  }
}
function updateLabels() {
  if (!labelEls.length) return;
  try {
    const lo = xOf(21), hi = xOf(108);
    for (const item of labelEls) {
      const px = (xOf(item.midi) - lo) / Math.max(0.001, hi - lo);
      item.el.style.left = (px * 100) + '%';
      item.el.style.top = 'auto';
      item.el.style.bottom = '46px';
      item.el.style.opacity = (px >= 0 && px <= 1) ? '1' : '0';
    }
  } catch (e) {}
}
function keyDown(e) {
  if (!e || e.repeat) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (['input','select','textarea'].includes(tag) || (e.target && e.target.isContentEditable)) return;
  if (mappingMode.value && bindTarget.value != null) {
    e.preventDefault();
    for (const [code, m] of Object.entries(keyMap)) if (m === bindTarget.value) delete keyMap[code];
    keyMap[e.code] = bindTarget.value; saveKeyMap(); rebuildLabels(); bindTarget.value = null;
    app.toast(t('键位已绑定') + '：' + e.code.replace(/^Key/, ''), 'ok'); return;
  }
  const n = keyMap[e.code]; if (n == null) return;
  e.preventDefault(); pressNote(n);
}
function keyUp(e) { const n = keyMap[e.code]; if (n != null) releaseNote(n); }
function onPointer(ev) {
  try {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = { x: ((ev.clientX - rect.left) / rect.width) * 2 - 1, y: -((ev.clientY - rect.top) / rect.height) * 2 + 1 };
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(keyMeshes.map(k => k.mesh), false)[0];
    if (!hit) return;
    const k = keyMeshes.find(x => x.mesh === hit.object);
    if (!k) return;
    if (mappingMode.value) { bindTarget.value = k.midi; app.toast(t('请按一个电脑键绑定'), 'ok'); return; }
    pressNote(k.midi); setTimeout(() => releaseNote(k.midi), 180);
  } catch (e) {}
}
function animate() {
  raf = requestAnimationFrame(animate);
  const now = performance.now();
  for (const k of keyMeshes) {
    const down = (pressed.get(k.midi) || 0) > now;
    k.mesh.position.y = k.baseY - (down ? .045 : 0);
  }
  const song = activeSong();
  const sec = currentSec();
  const speed = fallSpeed.value;
  let oi = 0;
  if (song && hasSong.value) {
    for (const n of noteData) {
      const dur = Math.max(.06, n.en - n.st);
      const dt = n.st - sec;
      if (dt > 4.5 || dt < -dur - .5) continue;
      if (oi >= noteMeshes.length) break;
      const m = noteMeshes[oi++];
      const x = xOf(n.pitch);
      const len = Math.max(.08, dur * speed);
      m.visible = true;
      m.position.set(x, .72 + dt * speed + len / 2, .62);
      m.scale.set(.085, len, .075);
      m.material.color.setHex([0x5cc8ff, 0xff6b9d, 0xffc45c, 0x9b7bff, 0x7ddf9a, 0xff9f5a][n.ti % 6]);
      m.material.opacity = .55 + Math.min(.35, (n.vel || 80) / 400);
    }
  }
  for (let i = oi; i < noteMeshes.length; i++) noteMeshes[i].visible = false;
  if (gameMode.value === 'game' && game) {
    game.tick(sec);
    if (now - lastHudAt > 120) { lastHudAt = now; Object.assign(stats, game.stats()); }
  }
  renderer.render(scene, camera);
  updateLabels();
}
function resize() {
  if (!renderer || !host.value) return;
  const w = host.value.clientWidth, h = host.value.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
}
function startDemo() {
  stopDemo();
  const demo = DEMO_SONGS.find(d => d.id === demoId.value); if (!demo) return;
  demoPlaying.value = true; demoStart = performance.now(); rebuildSong();
  const song = buildDemoSong(demo);
  for (const n of demo.notes) demoTimers.push(setTimeout(() => playSound(n.pitch, Math.max(.08, song.baseSec(n.end) - song.baseSec(n.start))), song.baseSec(n.start) * 1000));
}
function toggleDemo() { if (demoPlaying.value) stopDemo(); else startDemo(); }
function selectDemo() { stopDemo(); rebuildSong(); }
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

onMounted(async () => {
  const el = host.value;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x050912, 0);
  renderer.shadowMap.enabled = true;
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x050912, 10, 24);
  camera = new THREE.PerspectiveCamera(42, 1, .1, 60);
  camera.position.set(1.6, 3.4, 8.6); camera.lookAt(1.6, -0.25, 0.2);
  scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x0a1018, 1.25));
  const keyLight = new THREE.DirectionalLight(0xbfe6ff, 2.4); keyLight.position.set(-3, 7, 5); keyLight.castShadow = true; scene.add(keyLight);
  const rim = new THREE.PointLight(0x4477ff, 2.5, 20); rim.position.set(4, 1.5, -3); scene.add(rim);
  buildKeyboard(); makeNotes(); rebuildSong();
  resize(); window.addEventListener('resize', resize);
  window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp);
  renderer.domElement.addEventListener('pointerdown', onPointer);
  animate();
  try { await refreshDevices(); if (deviceId.value) await chooseDevice(); } catch (e) { midiStatus.value = t('MIDI 初始化失败'); }
});
watch(() => props.song, () => { if (!demoId.value) { stopDemo(); rebuildSong(); } });
watch(() => demoId, () => { rebuildSong(); });
onBeforeUnmount(() => {
  cancelAnimationFrame(raf); stopDemo();
  window.removeEventListener('resize', resize); window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp);
  try { selectMidiInput('', {}); } catch (e) {}
  try { renderer && renderer.dispose(); } catch (e) {}
  try { host.value && renderer && host.value.removeChild(renderer.domElement); } catch (e) {}
});
</script>

<template>
  <div ref="host" class="p3d">
    <div class="p3d-top">
      <b>{{ t('3D 钢琴') }}</b>
      <span class="p3d-sub">{{ t('外接 MIDI / 电脑键盘') }}</span>
      <span class="p3d-grow"></span>
      <select v-model="demoId" class="select-input" style="width:128px" @change="selectDemo">
        <option value="">{{ t('当前导入曲目') }}</option>
        <option v-for="d in DEMO_SONGS" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button class="chip-btn" :disabled="!demoId" @click="toggleDemo">{{ demoPlaying ? t('停止示范') : t('播放示范') }}</button>
      <span v-if="rating" class="p3d-rating">{{ t('难度') }} <b>{{ rating.level }}</b>/10 · {{ rating.label }}</span>
      <select v-model.number="program" class="select-input" style="width:92px">
        <option v-for="pg in PROGRAMS" :key="pg.id" :value="pg.id">{{ t(pg.label) }}</option>
      </select>
      <select v-model="gameMode" class="select-input" style="width:92px">
        <option value="free">{{ t('自由演奏') }}</option>
        <option value="game">{{ t('音游模式') }}</option>
      </select>
      <button class="chip-btn" :class="{ active: mappingMode }" @click="mappingMode = !mappingMode; bindTarget = null">{{ mappingMode ? t('退出键位') : t('自定义键位') }}</button>
      <button class="chip-btn" :class="{ active: recording }" @click="recording ? stopRec() : startRec()">{{ recording ? t('停止录音') : t('录音') }}</button>
      <button v-if="lastTake" class="chip-btn" @click="saveRec">{{ t('保存 MIDI') }}</button>
      <span class="p3d-grow"></span>
      <select v-model="deviceId" class="select-input" style="width:150px" @change="chooseDevice">
        <option value="">{{ t('选择 MIDI 键盘') }}</option>
        <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button class="chip-btn" @click="refreshDevices">{{ t('刷新') }}</button>
    </div>
    <div ref="labelLayer" class="p3d-labels"></div>
    <div v-if="!hasSong" class="p3d-empty">{{ t('载入一首 MIDI 或选择内置曲目') }}</div>
    <div v-if="gameMode === 'game' && hasSong" class="p3d-score">
      <span class="p3d-grade" :class="stats.lastGrade">{{ stats.lastGrade || 'READY' }}</span>
      <b>{{ stats.score }}</b>
      <span>{{ t('连击') }} {{ stats.combo }}</span>
      <span>{{ t('准确率') }} {{ stats.accuracy }}%</span>
      <span class="muted">{{ stats.perfect }}P / {{ stats.great }}G / {{ stats.good }}Gd / {{ stats.miss }}M</span>
    </div>
    <div class="p3d-hint">{{ t('电脑键盘：Z–M / Q–I 弹奏 · 点击琴键试听') }}</div>
  </div>
</template>

<style scoped>
.p3d { position:relative; width:100%; height:100%; min-height:520px; overflow:hidden; border-radius:18px; background: radial-gradient(ellipse at 50% 25%, #10243a 0%, #070d18 58%, #04070d 100%); }
.p3d canvas { position:absolute; inset:0; width:100% !important; height:100% !important; display:block; }
.p3d-top { position:absolute; top:12px; left:12px; right:12px; z-index:5; display:flex; align-items:center; flex-wrap:wrap; gap:7px; padding:8px 10px; border-radius:12px; background:rgba(5,12,24,.72); border:1px solid rgba(105,180,255,.18); backdrop-filter:blur(14px); color:#dff1ff; }
.p3d-top b { font-size:13px; letter-spacing:.02em; }
.p3d-sub { font-size:11px; color:#7eabc9; }
.p3d-grow { flex:1; min-width:6px; }
.p3d-rating { font-size:11px; color:#b9d8eb; } .p3d-rating b { color:#ffd166; font-size:15px; }
.p3d-labels { position:absolute; inset:0; pointer-events:none; z-index:3; }
.p3d-labels :deep(.p3d-key-label) { position:absolute; transform:translate(-50%,-50%); padding:2px 5px; border-radius:5px; border:1px solid rgba(120,210,255,.5); background:rgba(4,10,18,.72); color:#e1f6ff; font:600 10px/1.2 Consolas, monospace; letter-spacing:.04em; white-space:nowrap; }
.p3d-empty { position:absolute; inset:0; display:grid; place-items:center; color:#89b6d1; font-size:14px; z-index:2; pointer-events:none; }
.p3d-score { position:absolute; right:14px; bottom:14px; z-index:4; display:flex; align-items:center; gap:9px; padding:7px 11px; border-radius:10px; background:rgba(4,10,18,.76); border:1px solid rgba(120,210,255,.2); color:#dff1ff; font-size:11px; }
.p3d-score b { font-size:19px; color:#8fd6ff; } .p3d-grade { font-weight:800; color:#ffd166; min-width:50px; } .p3d-grade.miss { color:#ff7b7b; }
.p3d-hint { position:absolute; left:16px; bottom:14px; z-index:4; font-size:11px; color:#75a3bd; pointer-events:none; }
</style>

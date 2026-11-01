<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import * as THREE from 'three';
import { useAppStore } from '../../stores/app';
import { t } from '../../core/i18n.js';
import { listMidiInputs, selectMidiInput } from '../../core/midiin.js';

const props = defineProps({ song: { type: Object, default: null } });
const app = useAppStore();
const host = ref(null);
const devices = ref([]);
const deviceId = ref('');
const midiStatus = ref('');

let renderer, scene, camera, raf = 0;
let keys = [];                 // { midi, mesh, black, x }
let notePool = [];             // reusable bars
let activeNotes = [];
let pressed = new Map();       // midi -> until (performance.now)
const zNear = 0.2;

function midiToX(m) {
  // 21..108 白键/黑键近似坐标；等距即可，重点是 3D 观感
  const whiteIndex = [];
  for (let n = 21; n <= 108; n++) if (![1,3,6,8,10].includes(n % 12)) whiteIndex.push(n);
  const idx = whiteIndex.indexOf(m);
  if (idx >= 0) return (idx - (whiteIndex.length - 1) / 2) * 0.30;
  // 黑键落在相邻白键之间
  let prev = m - 1;
  while (!whiteIndex.includes(prev) && prev > 21) prev--;
  const i = whiteIndex.indexOf(prev);
  return (i - (whiteIndex.length - 1) / 2 + 0.5) * 0.30;
}

function isBlack(m) { return [1,3,6,8,10].includes(m % 12); }

function buildPiano() {
  const whiteMat = new THREE.MeshStandardMaterial({ color: '#f4f1e8', roughness: 0.35, metalness: 0.05 });
  const blackMat = new THREE.MeshStandardMaterial({ color: '#11151c', roughness: 0.28, metalness: 0.15 });
  for (let m = 21; m <= 108; m++) {
    const black = isBlack(m);
    const w = black ? 0.17 : 0.26;
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
  const body = new THREE.Mesh(new THREE.BoxGeometry(15.2, 0.85, 2.6), new THREE.MeshStandardMaterial({ color: '#080b12', roughness: 0.22, metalness: 0.35 }));
  body.position.set(0, -0.55, -0.55); body.receiveShadow = true; scene.add(body);
}

function makeBars() {
  const geo = new THREE.BoxGeometry(0.19, 0.10, 1);
  const mats = [0x5cc8ff, 0xff6b9d, 0x9b7bff, 0x7ddf9a, 0xffc45c].map(c => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.82 }));
  for (let i = 0; i < 260; i++) {
    const m = new THREE.Mesh(geo, mats[i % mats.length].clone());
    m.visible = false; scene.add(m); notePool.push(m);
  }
}

function updateBars(nowSec) {
  const song = props.song && props.song.song ? props.song : null;
  const tracks = (song && song.tracks) || [];
  // 取当前时间之后 4 秒内的音符
  let out = 0;
  if (song) {
    for (let ti = 0; ti < tracks.length && out < notePool.length; ti++) {
      const tr = tracks[ti];
      for (const n of (tr.notes || [])) {
        const st = song.baseSec(n.start);
        const en = song.baseSec(n.end);
        const dt = st - nowSec;
        if (dt < -0.35 || dt > 4.2) continue;
        const obj = notePool[out++]; if (!obj) break;
        const dur = Math.max(0.08, en - st);
        obj.visible = true;
        obj.position.set(midiToX(n.pitch), 0.55 + dt * 0.9, -dt * 1.65);
        obj.scale.set(1, 1, Math.max(0.15, dur * 1.65));
        obj.material.opacity = 0.62 + Math.min(0.28, (n.vel || 80) / 500);
        obj.userData.pitch = n.pitch;
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
  const nowSec = (() => { try { return app.curSec || 0; } catch (e) { return 0; } })();
  updateBars(nowSec);
  renderer.render(scene, camera);
}

const midiDown = (n) => { pressed.set(n, performance.now() + 180); };
const midiUp = (n) => { /* visual key stays for 180ms */ };

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

function resize() {
  const el = host.value; if (!el || !renderer) return;
  const w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
}

onMounted(async () => {
  const el = host.value;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x070b12, 1);
  renderer.shadowMap.enabled = true;
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x070b12, 8, 22);
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 4.2, 7.5); camera.lookAt(0, 0.2, -0.8);
  const amb = new THREE.HemisphereLight(0xaad4ff, 0x10131c, 1.1); scene.add(amb);
  const key = new THREE.DirectionalLight(0xbfe6ff, 2.2); key.position.set(-4, 8, 6); key.castShadow = true; scene.add(key);
  const rim = new THREE.PointLight(0x6a7cff, 2.2, 30); rim.position.set(5, 2, -4); scene.add(rim);
  buildPiano(); makeBars();
  resize(); window.addEventListener('resize', resize);
  await refreshDevices();
  if (deviceId.value) await chooseDevice();
  animate();
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf); window.removeEventListener('resize', resize);
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
      <span class="muted small">{{ midiStatus }}</span>
    </div>
    <div v-if="!song" class="viz-empty" role="status"><b>{{ t('还没有可演奏的曲目') }}</b></div>
  </div>
</template>

<style scoped>
.piano3d-host { position:relative; width:100%; height:100%; min-height:360px; overflow:hidden; border-radius:var(--r-sm); background:#070b12; }
.piano3d-host canvas { display:block; width:100%; height:100%; }
.piano3d-hud { position:absolute; top:10px; left:12px; right:12px; display:flex; align-items:center; gap:8px; z-index:2; padding:8px 10px; border-radius:10px; background:rgba(8,14,26,.72); border:1px solid rgba(120,180,255,.18); backdrop-filter:blur(10px); }
.piano3d-hud b { color:#dff1ff; font-size:13px; }
</style>

<script setup>
// P0-3b MIDI 键盘录音面板：设备选择 / 预备拍 / 量化 / 叠加或替换 / 延迟校准 / take 采用丢弃。
// 录音引擎在 core/recorder.js（纯逻辑，有单测）；这里只做 UI 与传输控制（走 app 的播放/seek）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../Icon.vue';
import { t } from '../../core/i18n.js';
import { useAppStore } from '../../stores/app';
import { ensureAudio } from '../../audio.js';
import { listMidiInputs, selectMidiInput } from '../../core/midiin.js';
import { createRecorder, applyTake, calibrateLatency, recordStartPlan } from '../../core/recorder.js';

const props = defineProps({
  song: { type: Object, default: null },
  trackIndex: { type: Number, default: 0 },
});
const emit = defineEmits(['apply', 'close']);
const app = useAppStore();
const bridge = window.fuBridge;

const devices = ref([]);
const deviceId = ref('');
const preRollBars = ref(1);
const quantize = ref('off');
const mode = ref('overdub');
const offsetMs = ref(0);
const recording = ref(false);
const lastTake = ref(null);
const preRollLeft = ref(0);
const calibrateOpen = ref(false);
const calibrating = ref(false);
const clicks = ref([]);
const taps = ref([]);
const calResult = ref(null);

let recorder = null;
let pollTimer = 0;
let recStartWall = 0;
let lastTick = null;
let loopOn = false;
const canRecord = computed(() => !!(props.song && deviceId.value));

const PREF_KEY = 'fufumidi_record_prefs';
onMounted(async () => {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    if (p) {
      if (p.preRollBars != null) preRollBars.value = p.preRollBars;
      if (p.quantize) quantize.value = p.quantize;
      if (p.mode) mode.value = p.mode;
    }
  } catch (e) {}
  try {
    const s = (bridge && bridge.getSettings) ? await bridge.getSettings() : {};
    if (s && s.midiInputOffsetMs != null) offsetMs.value = Number(s.midiInputOffsetMs) || 0;
  } catch (e) {}
  await refreshDevices();
});
onBeforeUnmount(() => { stopTimer(); if (recording.value) void stopRec(); try { selectMidiInput('', {}); } catch (e) {} });

async function refreshDevices() {
  try {
    devices.value = await listMidiInputs();
    if (!deviceId.value && devices.value.length) deviceId.value = devices.value[0].id;
  } catch (e) { devices.value = []; }
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ preRollBars: preRollBars.value, quantize: quantize.value, mode: mode.value })); } catch (e) {}
}
async function saveOffset() {
  try { if (bridge && bridge.saveSettings) await bridge.saveSettings({ midiInputOffsetMs: Number(offsetMs.value) || 0 }); } catch (e) {}
}
function stopTimer() { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } lastTick = null; }

function currentTick() {
  try { const { player } = ensureAudio(); return player && player.currentTick ? player.currentTick() : 0; } catch (e) { return 0; }
}

async function startRec() {
  const s = props.song;
  if (!s || !deviceId.value) return;
  const { player } = ensureAudio();
  loopOn = !!(player && player.loop && player.loopEnd > player.loopStart);
  const tpb = s.tpb || 480;
  const bpm = s.initialBpm || 120;
  const sig = (s.sigMap && s.sigMap[0]) || { num: 4, den: 4 };
  const barTicks = Math.max(1, Math.round(sig.num * tpb * 4 / (sig.den || 4)));
  const startTick = loopOn ? player.loopStart : Math.max(0, Math.round(s.secToTick(app.curSec / (app.tempo || 1))));
  const plan = recordStartPlan({ startTick, barTicks, preRollBars: preRollBars.value, bpm, tpb });
  // 先 seek 到「起点 - 预备拍」，这样预备拍结束时播放头正好在 startTick
  try { app.seekSec(s.baseSec(plan.seekTick) / (app.tempo || 1)); } catch (e) {}
  if (!app.playing) { try { await app.togglePlay(); } catch (e) {} }
  recorder = createRecorder({
    tpb, bpm, sigNum: sig.num, sigDen: sig.den,
    preRollBars: preRollBars.value, quantize: quantize.value, mode: mode.value,
    inputOffsetMs: Number(offsetMs.value) || 0,
  });
  const atMs = performance.now();
  recorder.start({ atMs, startTick, loopStartTick: startTick, loopEndTick: loopOn ? player.loopEnd : startTick + barTicks * 8 });
  recStartWall = atMs + plan.preRollMs;
  recording.value = true;
  lastTick = null;
  savePrefs();
  const ok = await selectMidiInput(deviceId.value, {
    onNoteOn: (n, v, ms) => { try { recorder.noteOn(n, v, ms); } catch (e) {} },
    onNoteOff: (n, ms) => { try { recorder.noteOff(n, ms); } catch (e) {} },
  });
  if (!ok) { recording.value = false; return; }
  pollTimer = setInterval(() => {
    const now = performance.now();
    preRollLeft.value = Math.max(0, Math.ceil((recStartWall - now) / 1000));
    if (loopOn) {
      const tick = currentTick();
      if (lastTick != null && tick + 10 < lastTick) { try { recorder.advanceLoop(); } catch (e) {} }
      lastTick = tick;
    }
  }, 100);
}

async function stopRec() {
  stopTimer();
  const wasPlaying = app.playing;
  if (recorder) {
    try { lastTake.value = recorder.stop(performance.now()); } catch (e) { lastTake.value = null; }
  }
  recorder = null;
  recording.value = false;
  preRollLeft.value = 0;
  try { await selectMidiInput('', {}); } catch (e) {}
  if (wasPlaying) { try { await app.togglePlay(); } catch (e) {} }
}

function discardTake() { lastTake.value = null; }
function applyTakeNow() {
  if (!lastTake.value) return;
  emit('apply', { take: lastTake.value, trackIndex: props.trackIndex });
  lastTake.value = null;
}

/* ---- 延迟校准：播 4 下 click，邀请用户跟着敲；中位偏移写入输入延迟 ---- */
function clickOnce() {
  try {
    const { ctx } = ensureAudio();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 1200; g.gain.value = 0.12;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.03);
  } catch (e) {}
}
async function startCalibration() {
  calibrating.value = true; calResult.value = null; clicks.value = []; taps.value = [];
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 300 : 600));
    clickOnce();
    clicks.value.push(performance.now());
  }
}
function tapCalibration() {
  if (!calibrating.value) return;
  taps.value.push(performance.now());
  if (taps.value.length >= 4) {
    calResult.value = calibrateLatency(clicks.value, taps.value);
    calibrating.value = false;
    // 采用中位偏移（夹到 ±200ms），保存到设置
    offsetMs.value = Math.max(-200, Math.min(200, Math.round(calResult.value.medianMs)));
    void saveOffset();
  }
}
</script>

<template>
  <div class="card rec-panel" data-guide="edit-record">
    <div class="rec-head">
      <Icon name="music" :size="14" />
      <b>{{ t('MIDI 键盘录音') }}</b>
      <span class="rec-grow"></span>
      <button class="btn sm" @click="emit('close')">{{ t('关闭') }}</button>
    </div>
    <div class="rec-row">
      <label>{{ t('输入设备') }}</label>
      <select v-model="deviceId" :disabled="recording">
        <option value="">{{ t('未检测到设备') }}</option>
        <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button class="btn sm" @click="refreshDevices" :disabled="recording">{{ t('刷新') }}</button>
    </div>
    <div class="rec-row">
      <label>{{ t('预备拍') }}</label>
      <select v-model.number="preRollBars" :disabled="recording" @change="savePrefs">
        <option :value="0">{{ t('关') }}</option>
        <option :value="1">1 {{ t('小节') }}</option>
        <option :value="2">2 {{ t('小节') }}</option>
      </select>
      <label>{{ t('量化') }}</label>
      <select v-model="quantize" :disabled="recording" @change="savePrefs">
        <option value="off">{{ t('关') }}</option>
        <option value="1/4">1/4</option>
        <option value="1/8">1/8</option>
        <option value="1/16">1/16</option>
        <option value="1/32">1/32</option>
      </select>
      <label>{{ t('录制模式') }}</label>
      <select v-model="mode" :disabled="recording" @change="savePrefs">
        <option value="overdub">{{ t('叠加 (overdub)') }}</option>
        <option value="replace">{{ t('替换 (replace)') }}</option>
      </select>
    </div>
    <div class="rec-row">
      <label>{{ t('输入延迟') }}</label>
      <input type="number" v-model.number="offsetMs" min="-200" max="200" step="1" class="num-input rec-num" :disabled="recording" @change="saveOffset" />
      <span class="rec-hint">ms</span>
      <button class="btn sm" @click="calibrateOpen = !calibrateOpen">{{ t('校准…') }}</button>
      <span class="rec-grow"></span>
      <button v-if="!recording" class="btn sm primary" @click="startRec" :disabled="!canRecord">
        <Icon name="record" :size="12" />{{ t('开始录音') }}
      </button>
      <button v-else class="btn sm" @click="stopRec"><Icon name="stop" :size="12" />{{ t('停止录音') }}</button>
      <span v-if="recording" class="rec-live">● {{ t('录音中') }}<template v-if="preRollLeft > 0"> · {{ t('预备拍') }} {{ preRollLeft }}</template></span>
      <span v-else-if="lastTake" class="rec-hint">{{ t('已录制') }} {{ lastTake.notes.length }} {{ t('个音符') }}</span>
    </div>
    <div v-if="lastTake" class="rec-row rec-take">
      <span class="rec-grow">{{ t('已录制') }} {{ lastTake.notes.length }} {{ t('个音符') }} · {{ lastTake.quantize }} · {{ lastTake.mode }}</span>
      <button class="btn sm" @click="discardTake">{{ t('丢弃') }}</button>
      <button class="btn sm primary" @click="applyTakeNow">{{ t('采用') }}</button>
    </div>
    <div v-if="calibrateOpen" class="rec-cal">
      <div class="rec-row">
        <b>{{ t('延迟校准') }}</b>
        <span class="rec-grow"></span>
        <button class="btn sm" @click="calibrateOpen = false">{{ t('关闭') }}</button>
      </div>
      <p class="rec-hint">{{ t('播放 4 下节拍，跟着每一下点「敲击」；取中位偏移写入输入延迟。') }}</p>
      <div class="rec-row">
        <button class="btn sm" @click="startCalibration" :disabled="calibrating">{{ calibrating ? t('播放中…') : t('开始校准') }}</button>
        <button class="btn sm primary" @click="tapCalibration" :disabled="!calibrating">{{ t('敲击') }} ({{ taps.length }}/4)</button>
        <span v-if="calResult" class="rec-hint">
          {{ t('中位偏移') }} {{ calResult.medianMs.toFixed(1) }} ms · {{ t('离散') }} {{ calResult.spreadMs.toFixed(1) }} ms · {{ calResult.ok ? t('通过') : t('需重试') }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rec-panel { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); margin-bottom: 8px; }
.rec-head { display: flex; align-items: center; gap: var(--sp-2); }
.rec-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.rec-row label { color: var(--muted); }
.rec-row select { min-width: 120px; }
.rec-grow { flex: 1; }
.rec-num { width: 72px; }
.rec-hint { color: var(--muted); }
.rec-live { color: var(--brand-coral); }
.rec-take { border-top: 1px solid var(--hairline); padding-top: var(--sp-2); }
.rec-cal { border-top: 1px solid var(--hairline); padding-top: var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-2); }
</style>

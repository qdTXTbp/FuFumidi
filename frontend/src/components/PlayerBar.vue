<script setup>
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { getPlayer, getCtx } from '../audio.js';
import { t } from '../core/i18n.js';
import { initMidiOutput, setMidiOutEnabled, midiOutOn, midiOutOff, midiAllOff, getMidiOutDeviceName } from '../core/midiout.js';

const app = useAppStore();
const state = app;
const currentSong = computed(() => app.currentSong);
const totalStr = computed(() => app.totalStr);
const curStr = computed(() => app.curStr);
const togglePlay = () => app.togglePlay();
const stopPlay = () => app.stopPlay();
const seekRatio = (r) => app.seekRatio(r);
const setTempo = (v) => app.setTempo(v);
const toggleLoop = () => app.toggleLoop();
const toggleMetro = () => app.toggleMetro();
const setVolume = (v) => app.setVolume(v);
const selectSong = (id) => app.selectSong(id);
const toast = (m, t) => app.toast(m, t);
const toggleTrackMute = (i) => app.toggleTrackMute(i);
const toggleTrackSolo = (i) => app.toggleTrackSolo(i);
const setTrackVol = (i, v) => app.setTrackVol(i, v);
const setTrackPan = (i, v) => app.setTrackPan(i, v);

// 播放中 rAF 会逐帧改写 state.progress；若用户在拖动进度条，则改为显示本地拖动值，
// 避免手指/鼠标拖到哪又被拉回播放头位置（表现为“进度条拖不动”）。
const dragging = ref(false);
const dragRatio = ref(0);
const displayProgress = computed(() => (dragging.value ? dragRatio.value : state.progress));
const compact = ref(false);

const pbStyle = computed(() => ({ '--fill': (displayProgress.value * 100) + '%' }));
const volStyle = computed(() => ({ '--fill': (state.volume * 100) + '%' }));
const tempoStyle = computed(() => ({ '--fill': ((state.tempo - 0.25) / 3.75) * 100 + '%' }));

function onProgressDragStart() { dragging.value = true; }
function onProgressDragEnd() { dragging.value = false; }
function onProgressInput(e) {
  const r = parseFloat(e.target.value);
  dragRatio.value = r;
  seekRatio(r);
}

function stepTempo(d) { setTempo(Math.round((state.tempo + d) * 100) / 100); }

/* ---------------- BPM 输入（BPM = 歌曲初始速度 × 倍率） ---------------- */
const bpmVal = computed({
  get: () => {
    const s = currentSong.value && currentSong.value.song;
    return Math.round((s ? s.initialBpm : 120) * state.tempo);
  },
  set: v => {
    const s = currentSong.value && currentSong.value.song;
    const b = parseFloat(v);
    if (!s || !isFinite(b) || b <= 0) return;
    setTempo(b / s.initialBpm);
  },
});

/* ---------------- MIDI 硬件输出 ---------------- */
const midiOn = ref(false);
const midiDevice = ref('');
function noteHandler(n, t, e) {
  const ctx = getCtx();
  const now = ctx ? ctx.currentTime : 0;
  const ch = n.ch != null ? n.ch : 0;
  midiOutOn(ch, n.midi, n.vel, t, now);
  midiOutOff(ch, n.midi, e, now);
}
async function toggleMidiOut() {
  if (midiOn.value) {
    midiOn.value = false;
    setMidiOutEnabled(false);
    midiAllOff();
    toast(t('已关闭 MIDI 硬件输出'));
    return;
  }
  const ok = await initMidiOutput();
  if (!ok) { toast(t('未找到 MIDI 输出设备，或系统不支持 Web MIDI'), 'warn'); return; }
  const p = getPlayer();
  if (p) { p.onNote = noteHandler; p.onStop = () => midiAllOff(); }
  midiOn.value = true;
  midiDevice.value = getMidiOutDeviceName();
  setMidiOutEnabled(true);
  toast(t('已连接 MIDI 输出：') + midiDevice.value, 'ok');
}

/* ---------------- 混音台弹窗 ---------------- */
const mixerOpen = ref(false);
function panStyle(i) {
  const v = state.tracks[i]?.pan || 0;
  return { '--fill': ((v + 1) / 2) * 100 + '%' };
}
function panTitle(i) {
  const v = state.tracks[i]?.pan || 0;
  return t('声像 ') + (v > 0 ? 'R' + Math.round(v * 100) : v < 0 ? 'L' + Math.round(-v * 100) : t('中'));
}

function prev() {
  const q = app.queueSongs;
  const i = q.findIndex(s => s.id === state.currentId);
  if (i > 0) selectSong(q[i - 1].id);
  else if (i < 0 && q.length) selectSong(q[q.length - 1].id);
}
function next() {
  const q = app.queueSongs;
  const i = q.findIndex(s => s.id === state.currentId);
  if (i >= 0 && i < q.length - 1) selectSong(q[i + 1].id);
  else if (i < 0 && q.length) selectSong(q[0].id);
}
</script>

<template>
  <footer class="playerbar" :class="{ compact }">
    <div class="pb-main">
      <div class="pb-transport">
        <button class="tp-btn" :title="t('上一首')" aria-label="t('上一首')" @click="prev" :disabled="!currentSong"><Icon name="prev" :size="17" /></button>
        <button class="tp-play" :class="{ playing: state.playing }" :title="state.playing ? t('暂停') : t('播放')" @click="togglePlay">
          <Icon :name="state.playing ? 'pause' : 'play'" :size="20" />
        </button>
        <button class="tp-btn" :title="t('停止')" aria-label="t('停止')" @click="stopPlay" :disabled="!currentSong"><Icon name="stop" :size="16" /></button>
        <button class="tp-btn" :title="t('下一首')" aria-label="t('下一首')" @click="next" :disabled="!currentSong"><Icon name="next" :size="17" /></button>
      </div>
      <div class="pb-title">
        <b>{{ currentSong?.name || t('未选择曲目') }}</b>
        <small>{{ currentSong ? (currentSong.song ? currentSong.song.tracks.length + t(' 轨 · ') : '') + curStr + ' / ' + totalStr : t('导入 MIDI 开始播放') }}</small>
      </div>
    </div>

    <div class="pb-progress">
      <div class="pb-time"><span>{{ curStr }}</span><span>{{ totalStr }}</span></div>
      <input id="pb-progress" name="pb-progress" type="range" aria-label="t('播放进度')" min="0" max="1" step="0.0001" :style="pbStyle" :value="displayProgress"
             @pointerdown="onProgressDragStart" @pointerup="onProgressDragEnd" @pointercancel="onProgressDragEnd"
             @input="onProgressInput">
    </div>

    <div class="pb-right">
      <button class="tp-btn" :class="{ 'toggle-on': midiOn }" :title="t('MIDI 硬件输出')" aria-label="t('MIDI 硬件输出')" @click="toggleMidiOut"><Icon name="music" :size="16" /></button>
      <button class="tp-btn" :class="{ 'toggle-on': state.loop }" :title="t('循环播放')" aria-label="t('循环播放')" @click="toggleLoop"><Icon name="loop" :size="16" /></button>
      <button class="tp-btn" :class="{ 'toggle-on': state.metro }" title="节拍器" aria-label="t('节拍器')" @click="toggleMetro"><Icon name="metro" :size="16" /></button>
      <button class="tp-btn" :class="{ 'toggle-on': mixerOpen }" :title="t('混音台')" aria-label="t('混音台')" @click="mixerOpen = !mixerOpen"><Icon name="cclane" :size="16" /></button>
      <button class="tp-btn" :class="{ 'toggle-on': compact }" :title="t('紧凑/完整播放栏')" aria-label="t('紧凑/完整播放栏')" @click="compact = !compact"><Icon name="menu" :size="16" /></button>

      <div class="row" style="gap:4px">
        <button class="chip-btn" @click="stepTempo(-0.05)" :title="t('减速')" aria-label="t('减速')">−</button>
        <input id="pb-tempo" name="pb-tempo" class="num-input" aria-label="t('速度倍率')" type="number" min="0.25" max="4" step="0.05" v-model.number="state.tempo" style="width:52px;text-align:center" :title="t('速度倍率')">
        <button class="chip-btn" @click="stepTempo(0.05)" :title="t('加速')" aria-label="t('加速')">＋</button>
      </div>

      <div class="bpm-wrap">
        <input id="pb-bpm" name="pb-bpm" class="num-input" aria-label="t('BPM（修改后应用到歌曲）')" type="number" min="20" max="400" step="1" v-model.number="bpmVal" style="width:64px;text-align:center" :title="t('BPM（修改后应用到歌曲）')">
        <span class="bpm-lbl">BPM</span>
      </div>

      <div class="vol-wrap">
        <span class="vol-ic"><Icon name="volume" :size="16" /></span>
        <input id="pb-volume" name="pb-volume" type="range" aria-label="t('音量')" min="0" max="1" step="0.01" :style="volStyle" :value="state.volume" @input="setVolume(parseFloat($event.target.value))">
      </div>
    </div>

    <!-- 混音台弹窗 -->
    <div v-if="mixerOpen" class="mx-overlay" @click.self="mixerOpen = false">
      <div class="mx-card">
        <div class="mx-head">
          <b>混音台</b>
          <button class="icon-btn" @click="mixerOpen = false" title="关闭"><Icon name="plus" :size="14" style="transform:rotate(45deg)" /></button>
        </div>
        <div v-if="!state.tracks.length" class="muted small" style="padding:12px 4px">{{ t('当前曲目没有可混音的轨道') }}</div>
        <div v-for="(tr, i) in state.tracks" :key="i" class="mix-track">
          <span class="mt-color" :style="{ background: tr.color }"></span>
          <div class="mt-name">
            <b>{{ tr.name }}</b>
            <small>音色 #{{ tr.program }}{{ tr.isDrum ? t(' · 打击乐') : '' }} · {{ tr.noteCount }} 音符</small>
          </div>
          <div class="mt-ctl">
            <button class="chip-btn" :class="{ 'on-solo': tr.solo }" :title="t('独奏')" aria-label="t('独奏')" @click="toggleTrackSolo(i)">S</button>
            <button class="chip-btn" :class="{ 'on-mute': tr.mute }" :title="t('静音')" aria-label="t('静音')" @click="toggleTrackMute(i)">M</button>
          </div>
          <div class="mt-vol" :title="t('音量 ') + Math.round(tr.vol * 100) + '%'">
            <input type="range" min="0" max="1" step="0.01" :style="{ '--fill': tr.vol * 100 + '%' }"
                   :value="tr.vol" @input="setTrackVol(i, parseFloat($event.target.value))">
          </div>
          <div style="width:70px;display:flex;align-items:center;gap:6px" :title="panTitle(i)">
            <span class="muted small">L</span>
            <input type="range" min="-1" max="1" step="0.01" :style="panStyle(i)"
                   :value="tr.pan" @input="setTrackPan(i, parseFloat($event.target.value))">
            <span class="muted small">R</span>
          </div>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.bpm-wrap { display: flex; align-items: center; gap: 6px; flex: none; }
.bpm-lbl { font-size: 10.5px; color: rgba(255, 255, 255, 0.55); font-weight: 600; }
.mx-overlay {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(10, 10, 10, 0.28);
  display: flex; align-items: flex-end; justify-content: flex-end;
  padding: 0 14px calc(var(--playerbar-h) + 14px) 0;
}
.mx-card {
  width: 480px; max-width: calc(100vw - 28px); max-height: 58vh; overflow-y: auto;
  background: var(--canvas); color: var(--ink);
  border: 1px solid var(--hairline); border-radius: 16px;
  box-shadow: var(--shadow-lg); padding: 14px;
}
.mx-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 14px; font-weight: 700; color: var(--ink);
  padding: 2px 4px 10px;
}
/* 混音台在黑色播放条内部，覆盖其白色滑杆样式 */
.mx-card input[type="range"] {
  background: linear-gradient(90deg, var(--ink) 0%, var(--ink) var(--fill, 0%), var(--hairline) var(--fill, 0%));
}
.mx-card input[type="range"]::-webkit-slider-thumb { background: #fff; border-color: var(--ink); }

/* 紧凑播放栏 */
.playerbar.compact .pb-title { display: none; }
.playerbar.compact .pb-progress { max-width: 180px; }
.playerbar.compact .bpm-wrap { display: none; }
.playerbar.compact .pb-right .vol-wrap { width: 90px; }
</style>

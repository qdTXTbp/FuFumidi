<script setup>
import { computed, ref, reactive } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { getPlayer, getCtx, getSynth } from '../audio.js';
import { t } from '../core/i18n.js';
import { initMidiOutput, setMidiOutEnabled, midiOutOn, midiOutOff, midiAllOff, getMidiOutDeviceName } from '../core/midiout.js';

const app = useAppStore();
const state = app;
const isAudio = computed(() => state.isAudio);
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
  app.skip(-1);
}
function next() {
  app.skip(1);
}
const playMode = computed(() => state.playMode || 'order');
const modeIcon = computed(() => ({ order: 'modeOrder', shuffle: 'shuffle', repeatOne: 'repeat1', loopAll: 'refresh' }[playMode.value] || 'modeOrder'));
const modeTitle = computed(() => ({ order: '顺序播放', shuffle: '随机播放', repeatOne: '单曲循环', loopAll: '列表循环' }[playMode.value] || '播放模式'));
function cycleMode() { app.cyclePlayMode(); }

/* ---------------- 书签 & 睡眠定时 ---------------- */
const bkOpen = ref(false);
const bks = ref([]);
function refreshBks() { try { bks.value = app.bookmarksFor(); } catch (e) { bks.value = []; } }
function toggleBkList() { bkOpen.value = !bkOpen.value; sleepOpen.value = false; if (bkOpen.value) refreshBks(); }
function addBk() { app.addBookmark(); refreshBks(); }
function delBk(i) { app.removeBookmark(i); refreshBks(); }
function jumpBk(b) { try { app.jumpBookmarkSec(b.t); } catch (e) {} bkOpen.value = false; }
const sleepOpen = ref(false);
const nowTick = ref(Date.now());
setInterval(() => { nowTick.value = Date.now(); }, 1000);
const sleepLeftStr = computed(() => {
  if (!state.sleepUntil) return '';
  const left = Math.max(0, Math.round((state.sleepUntil - nowTick.value) / 60000));
  return ' ' + left + 'min';
});
const sleepTitle = computed(() => state.sleepUntil ? t('睡眠定时剩余约 ') + sleepLeftStr.value : t('睡眠定时'));
function setSleepMin(m) { app.setSleep(m); sleepOpen.value = false; }

/* ---------------- 音效调节（10 段 EQ + 低音增强 + 空间声） ---------------- */
const fxOpen = ref(false);
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  flat: { name: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bass: 0, spatial: 0 },
  pop: { name: '流行', gains: [-1, 1, 3, 4, 3, 1, -1, -1, -1, -2], bass: 2, spatial: 0.3 },
  rock: { name: '摇滚', gains: [4, 3, 1, 0, -1, 0, 2, 3, 4, 4], bass: 4, spatial: 0.2 },
  classical: { name: '古典', gains: [2, 1, 0, 0, 0, 0, -1, -1, 0, 2], bass: 1, spatial: 0.5 },
  jazz: { name: '爵士', gains: [2, 2, 1, 2, -1, -1, 0, 1, 2, 3], bass: 2, spatial: 0.4 },
  vocal: { name: '人声', gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1], bass: 0, spatial: 0.2 },
  bass: { name: '低音增强', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], bass: 8, spatial: 0 },
};
const fx = reactive({ enabled: false, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bass: 0, spatial: 0, preset: 'flat' });
function applyFx() {
  const syn = getSynth(); if (!syn) return;
  syn.setFxEnabled(fx.enabled); syn.setEqGains(fx.gains); syn.setBassBoost(fx.bass); syn.setSpatial(fx.spatial);
}
function fxSave() { try { localStorage.setItem('fufumidi_fx', JSON.stringify({ enabled: fx.enabled, gains: fx.gains, bass: fx.bass, spatial: fx.spatial, preset: fx.preset })); } catch (e) {} }
function fxLoad() {
  try {
    const s = JSON.parse(localStorage.getItem('fufumidi_fx') || 'null');
    if (s) { fx.enabled = !!s.enabled; if (Array.isArray(s.gains)) fx.gains = s.gains.slice(0, 10); fx.bass = s.bass || 0; fx.spatial = s.spatial || 0; fx.preset = s.preset || 'custom'; }
  } catch (e) {}
  applyFx();
}
fxLoad();
function fxToggle() { fx.enabled = !fx.enabled; applyFx(); fxSave(); }
function setEqGain(i, v) { fx.gains[i] = Math.round(v * 10) / 10; fx.preset = 'custom'; applyFx(); fxSave(); }
function setBass(v) { fx.bass = Math.round(v * 10) / 10; fx.preset = 'custom'; applyFx(); fxSave(); }
function setSpatial(v) { fx.spatial = Math.round(v * 100) / 100; applyFx(); fxSave(); }
function applyPreset(name) {
  const p = EQ_PRESETS[name]; if (!p) { fx.preset = 'custom'; fxSave(); return; }
  fx.preset = name; fx.enabled = true; fx.gains = p.gains.slice(); fx.bass = p.bass; fx.spatial = p.spatial;
  applyFx(); fxSave();
}
function toggleFxOpen() { fxOpen.value = !fxOpen.value; if (fxOpen.value) { fxLoad(); } }
const crossfadeOn = computed(() => localStorage.getItem('fufumidi_crossfade') !== '0');
function toggleCrossfade() {
  const on = localStorage.getItem('fufumidi_crossfade') !== '0';
  try { localStorage.setItem('fufumidi_crossfade', on ? '0' : '1'); } catch (e) {}
  toast(on ? t('曲尾淡出已关闭') : t('曲尾淡出已开启'), 'ok');
}
</script>

<template>
  <footer class="playerbar" :class="{ compact }">
    <div class="pb-main">
      <div class="pb-transport">
        <button class="tp-btn" :title="t('播放模式：') + modeTitle" aria-label="t('播放模式')" @click="cycleMode" :class="{ on: playMode !== 'order' }"><Icon :name="modeIcon" :size="15" /></button>
        <button class="tp-btn" :title="t('上一首')" aria-label="t('上一首')" @click="prev" :disabled="!currentSong"><Icon name="prev" :size="17" /></button>
        <button class="tp-play" :class="{ playing: state.playing }" :title="state.playing ? t('暂停') : t('播放')" @click="togglePlay">
          <Icon :name="state.playing ? 'pause' : 'play'" :size="20" />
        </button>
        <button class="tp-btn" :title="t('停止')" aria-label="t('停止')" @click="stopPlay" :disabled="!currentSong"><Icon name="stop" :size="16" /></button>
        <button class="tp-btn" :title="t('下一首')" aria-label="t('下一首')" @click="next" :disabled="!currentSong"><Icon name="next" :size="17" /></button>
        <button class="tp-btn" :title="t('添加书签（记录当前进度）')" @click="addBk" :disabled="!currentSong"><Icon name="target" :size="15" /></button>
        <button v-if="bks.length" class="tp-btn" :class="{ on: bkOpen }" :title="t('书签列表')" @click="toggleBkList"><Icon name="chevron" :size="14" /></button>
        <button class="tp-btn" :class="{ on: state.sleepUntil > 0 }" :title="sleepTitle" @click="sleepOpen = !sleepOpen; bkOpen = false"><Icon name="clock" :size="15" /></button>
      </div>
      <div v-if="bkOpen" class="pb-pop">
        <div v-for="(b, i) in bks" :key="i" class="pb-pop-row">
          <button class="pb-pop-jump" @click="jumpBk(b)"><Icon name="target" :size="12" /> {{ b.label }}</button>
          <button class="pb-pop-del" :title="t('删除书签')" @click="delBk(i)"><Icon name="trash" :size="12" /></button>
        </div>
        <div v-if="!bks.length" class="pb-pop-empty">{{ t('暂无书签，点击目标按钮在当前进度添加') }}</div>
      </div>
      <div v-if="sleepOpen" class="pb-pop">
        <button v-for="m in [15, 30, 60, 90]" :key="m" class="pb-pop-jump" @click="setSleepMin(m)">{{ m }} {{ t('分钟') }}</button>
        <button class="pb-pop-jump" @click="setSleepMin(0)">{{ t('关闭定时') }}</button>
        <div v-if="state.sleepUntil" class="pb-pop-empty">{{ t('剩余约 ') + Math.max(0, Math.round((state.sleepUntil - Date.now()) / 60000)) + t(' 分钟') }}</div>
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
      <button class="tp-btn" :class="{ 'toggle-on': state.loop }" :title="t('循环播放')" aria-label="t('循环播放')" @click="toggleLoop" :disabled="isAudio" :style="isAudio ? { opacity: .4 } : null"><Icon name="loop" :size="16" /></button>
      <button class="tp-btn" :class="{ 'toggle-on': state.metro }" title="节拍器" aria-label="t('节拍器')" @click="toggleMetro" :disabled="isAudio" :style="isAudio ? { opacity: .4 } : null"><Icon name="metro" :size="16" /></button>
      <button class="tp-btn" :class="{ 'toggle-on': mixerOpen }" :title="t('混音台')" aria-label="t('混音台')" @click="mixerOpen = !mixerOpen" :disabled="isAudio || !state.tracks.length" :style="isAudio ? { opacity: .4 } : null"><Icon name="cclane" :size="16" /></button>
      <button class="tp-btn" :class="{ 'toggle-on': fxOpen || fx.enabled }" :title="t('音效调节')" aria-label="t('音效调节')" @click="toggleFxOpen"><Icon name="cresc" :size="16" /></button>
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
    <!-- 必须 Teleport 到 body：.playerbar 带 backdrop-filter，会为 fixed 后代创建包含块，
         导致 fixed 覆盖层被限制在播放条内而无法正常弹出（与 SideBar 弹窗做法一致） -->
    <Teleport to="body">
    <Transition name="ov">
      <div v-if="mixerOpen" class="mx-overlay" @click.self="mixerOpen = false">
      <div class="mx-card">
        <div class="mx-head">
          <b>混音台</b>
          <button class="icon-btn" @click="mixerOpen = false" title="关闭"><Icon name="plus" :size="14" style="transform:rotate(45deg)" /></button>
        </div>
        <div class="muted small" style="padding:0 2px 8px">{{ t('音量/静音/独奏/声像作用于 MIDI 通道：同一通道上的多条轨会一起变化') }}</div>
        <div v-if="!state.tracks.length" class="muted small" style="padding:12px 4px">{{ t('当前曲目没有可混音的轨道') }}</div>
        <div v-for="(tr, i) in state.tracks" :key="i" class="mix-track">
          <span class="mt-color" :style="{ background: tr.color }"></span>
          <div class="mt-name">
            <b>{{ tr.name }}</b>
            <small>Ch {{ (tr.ch || 0) + 1 }} · 音色 #{{ tr.program }}{{ tr.isDrum ? t(' · 打击乐') : '' }} · {{ tr.noteCount }} 音符</small>
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
    </Transition>
    <!-- 音效调节弹窗 -->
    <Transition name="ov">
      <div v-if="fxOpen" class="mx-overlay" @click.self="fxOpen = false">
      <div class="mx-card">
        <div class="mx-head">
          <b>{{ t('音效调节') }}</b>
          <button class="icon-btn" @click="fxOpen = false" title="关闭"><Icon name="plus" :size="14" style="transform:rotate(45deg)" /></button>
        </div>
        <div class="eq-toolbar">
          <label class="eq-switch">
            <input type="checkbox" :checked="fx.enabled" @change="fxToggle"><span>{{ t('启用音效') }}</span>
          </label>
          <label class="eq-switch" :title="t('曲尾轻微淡出，让歌曲间的过渡更顺滑')">
            <input type="checkbox" :checked="crossfadeOn" @change="toggleCrossfade"><span>{{ t('曲尾淡出') }}</span>
          </label>
          <select class="eq-preset" :value="fx.preset" @change="applyPreset($event.target.value)">
            <option v-for="(p, k) in EQ_PRESETS" :key="k" :value="k">{{ p.name }}</option>
            <option value="custom">{{ t('自定义') }}</option>
          </select>
        </div>
        <div class="eq-bands">
          <div v-for="(f, i) in EQ_FREQS" :key="i" class="eq-band" :title="f + ' Hz'">
            <span class="eq-val">{{ (fx.gains[i] > 0 ? '+' : '') + (fx.gains[i] || 0) }}</span>
            <input class="eq-vslider" type="range" min="-12" max="12" step="0.5"
                   :value="fx.gains[i]" @input="setEqGain(i, parseFloat($event.target.value))">
            <span class="eq-hz">{{ f >= 1000 ? (f / 1000) + 'k' : f }}</span>
          </div>
        </div>
        <div class="eq-xrow">
          <span class="eq-lbl">{{ t('低音增强') }}</span>
          <input type="range" min="0" max="12" step="0.5" class="eq-hslider" :style="{ '--fill': (fx.bass / 12 * 100) + '%' }"
                 :value="fx.bass" @input="setBass(parseFloat($event.target.value))">
          <span class="eq-lbl">{{ t('空间声') }}</span>
          <input type="range" min="0" max="1" step="0.05" class="eq-hslider" :style="{ '--fill': (fx.spatial * 100) + '%' }"
                 :value="fx.spatial" @input="setSpatial(parseFloat($event.target.value))">
        </div>
        <div class="eq-note">{{ t('提示：开启「启用音效」后调节实时生效，设置自动保存。') }}</div>
      </div>
      </div>
    </Transition>
    </Teleport>
  </footer>
</template>

<style scoped>
.pb-pop {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 12px;
  z-index: 70;
  min-width: 190px;
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 10px;
  padding: 6px;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pb-pop-row { display: flex; gap: 4px; align-items: center; }
.pb-pop-jump { flex: 1; display: flex; align-items: center; gap: 6px; padding: 7px 10px; border: 0; background: transparent; color: var(--ink); border-radius: 7px; cursor: pointer; font-size: 12.5px; text-align: left; }
.pb-pop-jump:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.pb-pop-del { border: 0; background: transparent; color: var(--stone); cursor: pointer; padding: 6px; border-radius: 6px; }
.pb-pop-del:hover { color: #e26d5a; }
.pb-pop-empty { padding: 8px 10px; font-size: 12px; color: var(--stone); }
.eq-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 2px 10px; }
.eq-switch { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink); cursor: pointer; }
.eq-switch input { accent-color: var(--accent); }
.eq-preset { background: var(--surface); color: var(--ink); border: 1px solid var(--hairline); border-radius: 8px; padding: 5px 10px; font-size: 12.5px; }
.eq-bands { display: flex; gap: 10px; justify-content: space-between; padding: 8px 2px 4px; }
.eq-band { display: flex; flex-direction: column; align-items: center; gap: 5px; flex: 1; min-width: 0; }
.eq-vslider { writing-mode: vertical-lr; direction: rtl; width: 22px; height: 120px; accent-color: var(--accent); }
.eq-hz { font-size: 10px; color: var(--stone); }
.eq-val { font-size: 10px; color: var(--steel); min-height: 13px; }
.eq-xrow { display: flex; align-items: center; gap: 10px; padding: 12px 2px 2px; }
.eq-xrow input[type="range"] { flex: 1; accent-color: var(--accent); }
.eq-lbl { font-size: 12px; color: var(--steel); flex: none; }
.eq-note { padding: 10px 2px 0; font-size: 11.5px; color: var(--stone); }
.bpm-wrap { display: flex; align-items: center; gap: 6px; flex: none; }
.bpm-lbl { font-size: 10.5px; color: rgba(255, 255, 255, 0.55); font-weight: 600; }
.mx-overlay {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(10, 10, 10, 0.28);
  -webkit-backdrop-filter: blur(8px) saturate(1.4); backdrop-filter: blur(8px) saturate(1.4);
  display: flex; align-items: flex-end; justify-content: flex-end;
  padding: 0 14px calc(var(--playerbar-h) + 14px) 0;
}
.mx-card {
  width: 480px; max-width: calc(100vw - 28px); max-height: 58vh; overflow-y: auto;
  background: var(--glass-bg-strong);
  -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur);
  color: var(--ink);
  border: 1px solid color-mix(in srgb, #fff 26%, transparent);
  border-radius: 16px;
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

<script setup>
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import { state, currentSong, totalStr, curStr, togglePlay, stopPlay, seekRatio, setTempo, toggleLoop, toggleMetro, setVolume, selectSong } from '../store.js';

// 播放中 rAF 会逐帧改写 state.progress；若用户在拖动进度条，则改为显示本地拖动值，
// 避免手指/鼠标拖到哪又被拉回播放头位置（表现为“进度条拖不动”）。
const dragging = ref(false);
const dragRatio = ref(0);
const displayProgress = computed(() => (dragging.value ? dragRatio.value : state.progress));

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

function prev() {
  const i = state.songs.findIndex(s => s.id === state.currentId);
  if (i > 0) selectSong(state.songs[i - 1].id);
}
function next() {
  const i = state.songs.findIndex(s => s.id === state.currentId);
  if (i >= 0 && i < state.songs.length - 1) selectSong(state.songs[i + 1].id);
}
</script>

<template>
  <footer class="playerbar">
    <div class="pb-main">
      <div class="pb-transport">
        <button class="tp-btn" title="上一首" @click="prev" :disabled="!currentSong"><Icon name="prev" :size="17" /></button>
        <button class="tp-play" :title="state.playing ? '暂停' : '播放'" @click="togglePlay">
          <Icon :name="state.playing ? 'pause' : 'play'" :size="20" />
        </button>
        <button class="tp-btn" title="停止" @click="stopPlay" :disabled="!currentSong"><Icon name="stop" :size="16" /></button>
        <button class="tp-btn" title="下一首" @click="next" :disabled="!currentSong"><Icon name="next" :size="17" /></button>
      </div>
      <div class="pb-title">
        <b>{{ currentSong?.name || '未选择曲目' }}</b>
        <small>{{ currentSong ? (currentSong.song ? currentSong.song.tracks.length + ' 轨 · ' : '') + curStr + ' / ' + totalStr : '导入 MIDI 开始播放' }}</small>
      </div>
    </div>

    <div class="pb-progress">
      <div class="pb-time"><span>{{ curStr }}</span><span>{{ totalStr }}</span></div>
      <input id="pb-progress" name="pb-progress" type="range" min="0" max="1" step="0.0001" :style="pbStyle" :value="displayProgress"
             @pointerdown="onProgressDragStart" @pointerup="onProgressDragEnd" @pointercancel="onProgressDragEnd"
             @input="onProgressInput">
    </div>

    <div class="pb-right">
      <button class="tp-btn" :class="{ 'toggle-on': state.loop }" title="循环播放" @click="toggleLoop"><Icon name="loop" :size="16" /></button>
      <button class="tp-btn" :class="{ 'toggle-on': state.metro }" title="节拍器" @click="toggleMetro"><Icon name="metro" :size="16" /></button>

      <div class="row" style="gap:4px">
        <button class="chip-btn" @click="stepTempo(-0.05)" title="减速">−</button>
        <input id="pb-tempo" name="pb-tempo" class="num-input" type="number" min="0.25" max="4" step="0.05" v-model.number="state.tempo" style="width:56px;text-align:center" title="速度倍率">
        <button class="chip-btn" @click="stepTempo(0.05)" title="加速">＋</button>
      </div>

      <div class="vol-wrap">
        <span class="vol-ic"><Icon name="volume" :size="16" /></span>
        <input id="pb-volume" name="pb-volume" type="range" min="0" max="1" step="0.01" :style="volStyle" :value="state.volume" @input="setVolume(parseFloat($event.target.value))">
      </div>
    </div>
  </footer>
</template>

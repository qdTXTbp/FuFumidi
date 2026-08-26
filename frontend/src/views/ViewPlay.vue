<script setup>
import { computed } from 'vue';
import Icon from '../components/Icon.vue';
import PianoRoll from '../components/PianoRoll.vue';
import { useAppStore } from '../stores/app';
import { fmtTime } from '../core/util.js';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const currentSong = computed(() => app.currentSong);
const toggleTrackMute = (i) => app.toggleTrackMute(i);
const toggleTrackSolo = (i) => app.toggleTrackSolo(i);
const setTrackVol = (i, v) => app.setTrackVol(i, v);
const setTrackPan = (i, v) => app.setTrackPan(i, v);

const stats = computed(() => {
  const song = currentSong.value && currentSong.value.song;
  if (!song) return null;
  const sig = song.sigMap[0];
  const notes = song.tracks.reduce((a, t) => a + t.notes.length, 0);
  return {
    bpm: song.initialBpm,
    sig: sig ? sig.num + '/' + sig.den : '4/4',
    bars: song.bars,
    notes,
    dur: fmtTime(song.totalSec),
  };
});

function panStyle(i) {
  const v = state.tracks[i]?.pan || 0;
  return { '--fill': ((v + 1) / 2) * 100 + '%' };
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-ic"><Icon name="play2" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ currentSong?.name || t('演奏工作区') }}</div>
        <div class="page-sub">{{ currentSong ? t('钢琴卷帘预览 · 轨道混音 · 实时播放') : t('导入 MIDI 文件即可开始演奏与混音') }}</div>
      </div>
      <div v-if="stats" class="row" style="gap:8px;flex-wrap:wrap">
        <span class="tag accent">♩ {{ stats.bpm }} BPM</span>
        <span class="tag">{{ stats.sig }}</span>
        <span class="tag">{{ stats.bars }}{{ t(' 小节') }}</span>
        <span class="tag">{{ stats.notes }}{{ t(' 音符') }}</span>
        <span class="tag">{{ stats.dur }}</span>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!currentSong" class="empty card">
      <div class="empty-ic"><Icon name="music" :size="34" /></div>
      <b>{{ t('还没有载入曲目') }}</b>
      <p>{{ t('点击左侧「导入 MIDI」按钮，或直接把 .mid / .midi 文件拖进窗口，即可在此查看钢琴卷帘并实时播放。') }}</p>
    </div>

    <template v-else>
      <PianoRoll />

      <div class="grid" style="margin-top:16px;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
        <!-- 轨道混音 -->
        <div class="card">
          <div class="card-title"><span class="dot"></span>{{ t('轨道混音器') }}</div>
          <div class="mix-track" v-for="(tr, i) in state.tracks" :key="i">
            <span class="mt-color" :style="{ background: tr.color }"></span>
            <div class="mt-name">
              <b>{{ tr.name }}</b>
              <small>音色 #{{ tr.program }}{{ tr.isDrum ? t(' · 打击乐') : '' }} · {{ tr.noteCount }}{{ t(' 音符') }}</small>
            </div>
            <div class="mt-ctl">
              <button class="chip-btn" :class="{ 'on-solo': tr.solo }" :title="t('独奏')" @click="toggleTrackSolo(i)">S</button>
              <button class="chip-btn" :class="{ 'on-mute': tr.mute }" :title="t('静音')" @click="toggleTrackMute(i)">M</button>
            </div>
            <div class="mt-vol" :title="t('音量 ') + Math.round(tr.vol * 100) + '%'">
              <input :id="'mt-vol-' + i" :name="'mt-vol-' + i" type="range" min="0" max="1" step="0.01"
                     :style="{ '--fill': tr.vol * 100 + '%' }"
                     :value="tr.vol" @input="setTrackVol(i, parseFloat($event.target.value))">
            </div>
            <div style="width:70px;display:flex;align-items:center;gap:6px" :title="t('声像 ') + (tr.pan > 0 ? 'R' + Math.round(tr.pan * 100) : tr.pan < 0 ? 'L' + Math.round(-tr.pan * 100) : t('中'))">
              <span class="muted small">L</span>
              <input :id="'mt-pan-' + i" :name="'mt-pan-' + i" type="range" min="-1" max="1" step="0.01" :style="panStyle(i)"
                     :value="tr.pan" @input="setTrackPan(i, parseFloat($event.target.value))">
              <span class="muted small">R</span>
            </div>
          </div>
          <div v-if="!state.tracks.length" class="muted small">{{ t('该曲目没有可混音的轨道') }}</div>
        </div>

        <!-- 曲目信息 -->
        <div class="card">
          <div class="card-title"><span class="dot" style="background:var(--accent2)"></span>{{ t('曲目概览') }}</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div class="spread" v-for="(row, i) in [
              { k: t('曲名'), v: currentSong?.name },
              { k: t('速度'), v: stats?.bpm + ' BPM' },
              { k: t('拍号'), v: stats?.sig },
              { k: t('小节数'), v: stats?.bars },
              { k: t('音符数'), v: stats?.notes },
              { k: t('时长'), v: stats?.dur },
              { k: t('轨道数'), v: state.tracks.length },
            ]" :key="i">
              <span class="muted small">{{ row.k }}</span>
              <span class="small" style="font-weight:600">{{ row.v }}</span>
            </div>
          </div>
          <div class="row" style="margin-top:14px;gap:8px;flex-wrap:wrap">
            <span class="tag" v-for="(tr, i) in state.tracks.slice(0, 8)" :key="i" :style="{ color: tr.color, borderColor: tr.color + '55' }">
              {{ tr.name }}
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

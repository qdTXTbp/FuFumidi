<script setup>
import Icon from './Icon.vue';
import { state, VIEWS, setView } from '../store.js';
import { t } from '../core/i18n.js';

const ICONS = { home: 'home', play: 'play2', lyrics: 'music', edit: 'edit', viz: 'viz', analyze: 'chart', score: 'score', transcribe: 'transcribe', convert: 'convert' };

function openSettings() { state.ui.settingsOpen = true; }
function openHelp() { state.ui.guideOpen = true; }
</script>

<template>
  <header class="topbar">
    <button class="icon-btn" title="折叠 / 展开侧边栏" @click="state.sidebarOpen = !state.sidebarOpen">
      <Icon name="menu" :size="17" />
    </button>
    <div class="tab" v-for="v in VIEWS" :key="v.id" :class="{ active: state.view === v.id }" @click="setView(v.id)">
      <Icon :name="ICONS[v.id]" :size="14" />
      {{ t(v.label) }}
    </div>
    <div class="topbar-spacer"></div>
    <span class="tag" v-if="state.songs.length && state.currentId">
      <Icon name="music" :size="12" /> {{ state.songs.find(s => s.id === state.currentId)?.name }}
    </span>
    <button class="icon-btn" title="帮助" @click="openHelp">
      <Icon name="info" :size="17" />
    </button>
    <button class="icon-btn" title="设置" @click="openSettings">
      <Icon name="gear" :size="17" />
    </button>
  </header>
</template>

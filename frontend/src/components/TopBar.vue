<script setup>
import Icon from './Icon.vue';
import { state, VIEWS, setView } from '../store.js';

const ICONS = { home: 'home', play: 'play2', lyrics: 'music', edit: 'edit', viz: 'viz', analyze: 'chart', score: 'score', transcribe: 'transcribe', convert: 'convert' };
</script>

<template>
  <header class="topbar">
    <button class="icon-btn" title="折叠 / 展开侧边栏" @click="state.sidebarOpen = !state.sidebarOpen">
      <Icon name="menu" :size="17" />
    </button>
    <div class="tab" v-for="v in VIEWS" :key="v.id" :class="{ active: state.view === v.id }" @click="setView(v.id)">
      <Icon :name="ICONS[v.id]" :size="14" />
      {{ v.label }}
    </div>
    <div class="topbar-spacer"></div>
    <span class="tag" v-if="state.songs.length && state.currentId">
      <Icon name="music" :size="12" /> {{ state.songs.find(s => s.id === state.currentId)?.name }}
    </span>
  </header>
</template>

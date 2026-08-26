<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import SideBar from './components/SideBar.vue';
import TopBar from './components/TopBar.vue';
import PlayerBar from './components/PlayerBar.vue';
import ViewHome from './views/ViewHome.vue';
import ViewPlay from './views/ViewPlay.vue';
import ViewEdit from './views/ViewEdit.vue';
import ViewAnalyze from './views/ViewAnalyze.vue';
import ViewViz from './views/ViewViz.vue';
import ViewScore from './views/ViewScore.vue';
import ViewLyrics from './views/ViewLyrics.vue';
import ViewConvert from './views/ViewConvert.vue';
import ViewTranscribe from './views/ViewTranscribe.vue';
import ViewPlaceholder from './views/ViewPlaceholder.vue';
import { state, MIGRATED_VIEWS, startTickLoop, stopTickLoop, restoreSongs, togglePlay, seekRatio, setTempo, toggleLoop, toggleMetro } from './store.js';

function onKey(e) {
  // 忽略输入框内的快捷键
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') seekRatio(Math.max(0, state.progress - 0.02));
  else if (e.key === 'ArrowRight') seekRatio(Math.min(1, state.progress + 0.02));
  else if (e.key === 'l' || e.key === 'L') toggleLoop();
  else if (e.key === 'm' || e.key === 'M') toggleMetro();
  else if (e.key === '=' || e.key === '+') setTempo(state.tempo + 0.05);
  else if (e.key === '-' || e.key === '_') setTempo(state.tempo - 0.05);
}

onMounted(() => {
  startTickLoop();
  restoreSongs();
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  stopTickLoop();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="app-shell" :class="{ 'side-collapsed': !state.sidebarOpen }">
    <SideBar />
    <TopBar />
    <main class="app-main">
      <ViewHome v-if="state.view === 'home'" />
      <ViewPlay v-else-if="state.view === 'play'" />
      <ViewEdit v-else-if="state.view === 'edit'" />
      <ViewAnalyze v-else-if="state.view === 'analyze'" />
      <ViewViz v-else-if="state.view === 'viz'" />
      <ViewScore v-else-if="state.view === 'score'" />
      <ViewLyrics v-else-if="state.view === 'lyrics'" />
      <ViewConvert v-else-if="state.view === 'convert'" />
      <ViewTranscribe v-else-if="state.view === 'transcribe'" />
      <ViewPlaceholder v-else :view-id="state.view" />
    </main>
    <PlayerBar />
    <div class="toast-wrap" v-if="state.toast">
      <div class="toast" :class="state.toast.type">{{ state.toast.msg }}</div>
    </div>
  </div>
</template>

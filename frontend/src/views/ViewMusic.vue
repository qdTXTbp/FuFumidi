<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ViewPlay from './ViewPlay.vue';
import ViewLyrics from './ViewLyrics.vue';
import ViewEdit from './ViewEdit.vue';
import { t } from '../core/i18n.js';
const route = useRoute();
const router = useRouter();
const tabs = [
  { id: 'play', label: '演奏', ic: 'play2' },
  { id: 'lyrics', label: '歌词', ic: 'music' },
  { id: 'edit', label: '编辑', ic: 'edit' },
];
const comps = { play: ViewPlay, lyrics: ViewLyrics, edit: ViewEdit };
const validTab = (id) => tabs.some(x => x.id === id);
const tab = ref(validTab(String(route.query.tab || '')) ? String(route.query.tab) : tabs[0].id);
const cur = computed(() => comps[tab.value]);
function select(id) {
  tab.value = id;
  router.replace({ query: { ...route.query, tab: id } });
}
watch(() => route.query.tab, (v) => {
  const id = String(v || '');
  if (validTab(id)) tab.value = id;
});
</script>
<template>
  <div class="group-page">
    <div class="group-tabs">
      <button v-for="x in tabs" :key="x.id" class="gp-tab" :class="{ on: tab === x.id }" @click="select(x.id)">
        <Icon :name="x.ic" :size="14" /> {{ t(x.label) }}
      </button>
    </div>
    <Transition name="group-tab" mode="out-in">
      <KeepAlive><component :is="cur" /></KeepAlive>
    </Transition>
  </div>
</template>
<style scoped>
.group-page { min-height: 100%; }
.group-tabs { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--hairline); background: var(--canvas); position: sticky; top: 0; z-index: 30; }
.gp-tab { display: inline-flex; align-items: center; gap: 5px; padding: 7px 14px; border: 1px solid var(--hairline); background: transparent; color: var(--steel); border-radius: 999px; cursor: pointer; font-size: 13px; transition: all .14s; }
.gp-tab:hover { background: var(--surface-soft); color: var(--ink); }
.gp-tab.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--ink); font-weight: 600; }
</style>

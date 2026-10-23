<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ViewPlay from './ViewPlay.vue';
import ViewViz from './ViewViz.vue';
import ViewScore from './ViewScore.vue';
import { t } from '../core/i18n.js';
const route = useRoute();
const router = useRouter();
// 兼容旧深链：#/music?tab=edit|lyrics → 工作台
if (['edit', 'lyrics'].includes(String(route.query.tab || ''))) router.replace({ path: '/views', query: { ...route.query } });
const tabs = [
  { id: 'play', label: t('演奏'), ic: 'play2' },
  { id: 'viz', label: t('可视化'), ic: 'viz' },
  { id: 'score', label: t('乐谱'), ic: 'score' },
];
const comps = { play: ViewPlay, viz: ViewViz, score: ViewScore };
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
/* .group-page / .group-tabs / .gp-tab 统一由 styles.css 提供（三大类分组页共用），
   这里只声明本组特有的子视图高度约束 */
.group-page > :deep(.score-view) { flex: 1; min-height: 0; }
</style>

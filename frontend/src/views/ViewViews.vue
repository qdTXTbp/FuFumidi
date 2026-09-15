<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ViewViz from './ViewViz.vue';
import ViewAnalyze from './ViewAnalyze.vue';
import ViewScore from './ViewScore.vue';
import { t } from '../core/i18n.js';
const route = useRoute();
const router = useRouter();
const tabs = [
  { id: 'viz', label: t('可视化'), ic: 'viz' },
  { id: 'analyze', label: t('分析'), ic: 'chart' },
  { id: 'score', label: t('乐谱'), ic: 'score' },
];
const comps = { viz: ViewViz, analyze: ViewAnalyze, score: ViewScore };
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
/* .group-page / .group-tabs / .gp-tab 由 styles.css 统一提供 */
/* 乐谱视图需要受约束的高度（.score-scroll 内部滚动 + 跟随播放依赖 scrollTop），
   否则被 2 万 px 的谱面撑开、滚动全部落在外层 .app-main 上 */
.group-page > :deep(.score-view) { flex: 1; min-height: 0; }
</style>

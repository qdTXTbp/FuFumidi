<script setup>
import { ref, computed, watch, nextTick } from 'vue';
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
/** 分组页签的键盘模型：左右/上下键切换、Home/End 到首尾（role=tablist 的约定） */
function onTabKey(e, i) {
  const n = tabs.length;
  let next = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = n - 1;
  if (next < 0 || next === i) return;
  e.preventDefault(); e.stopPropagation();
  select(tabs[next].id);
  // tabindex 只在激活页签上，切完把焦点跟过去（否则焦点留在 tabindex=-1 的按钮上）
  const root = e.currentTarget && e.currentTarget.parentElement;
  nextTick(() => {
    const els = root ? root.querySelectorAll('.gp-tab') : [];
    if (els[next]) els[next].focus();
  });
}
watch(() => route.query.tab, (v) => {
  const id = String(v || '');
  if (validTab(id)) tab.value = id;
});
</script>
<template>
  <div class="group-page">
    <div class="group-tabs" role="tablist" :aria-label="t('视图')">
      <button v-for="(x, i) in tabs" :key="x.id" class="gp-tab" role="tab"
              :class="{ on: tab === x.id }" :aria-selected="tab === x.id ? 'true' : 'false'" :tabindex="tab === x.id ? 0 : -1"
              @click="select(x.id)" @keydown="onTabKey($event, i)">
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

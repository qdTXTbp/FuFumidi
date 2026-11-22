<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ViewTranscribe from './ViewTranscribe.vue';
import ViewConvert from './ViewConvert.vue';
import ViewScoreConvert from './ViewScoreConvert.vue';
import ViewCover from './ViewCover.vue';
import ViewSing from './ViewSing.vue';
import { t } from '../core/i18n.js';
const route = useRoute();
const router = useRouter();
const tabs = [
  { id: 'transcribe', label: t('转录'), ic: 'transcribe' },
  { id: 'convert', label: t('转换'), ic: 'convert' },
  { id: 'score', label: t('变谱'), ic: 'score' },
  { id: 'cover', label: t('翻唱'), ic: 'mic' },
  { id: 'singer', label: t('调教'), ic: 'utau' },
];
const comps = { transcribe: ViewTranscribe, convert: ViewConvert, score: ViewScoreConvert, cover: ViewCover, singer: ViewSing };
const validTab = (id) => tabs.some(x => x.id === id);
const tab = ref(validTab(String(route.query.tab || '')) ? String(route.query.tab) : tabs[0].id);
const cur = computed(() => comps[tab.value]);
const tabAnim = ref(false);
let tabAnimTimer = 0;
function playTabAnim() {
  tabAnim.value = false;
  clearTimeout(tabAnimTimer);
  requestAnimationFrame(() => {
    tabAnim.value = true;
    tabAnimTimer = window.setTimeout(() => { tabAnim.value = false; }, 220);
  });
}
function select(id) {
  if (tab.value !== id) playTabAnim();
  tab.value = id;
  router.replace({ query: { ...route.query, tab: id } });
}
watch(() => route.query.tab, (v) => {
  const id = String(v || '');
  if (validTab(id) && tab.value !== id) { playTabAnim(); tab.value = id; }
});
</script>
<template>
  <div class="group-page">
    <div class="group-tabs">
      <button v-for="x in tabs" :key="x.id" class="gp-tab" :class="{ on: tab === x.id }" :data-view="x.id" @click="select(x.id)">
        <Icon :name="x.ic" :size="14" /> {{ t(x.label) }}
      </button>
    </div>
    <!-- 不对旧页面做 out-in 离场（会卡住）；只让新页面做一个短入场反馈。 -->
    <div class="group-body" :class="{ 'tab-in': tabAnim }">
      <KeepAlive :max="5"><component :is="cur" /></KeepAlive>
    </div>
  </div>
</template>
<style scoped>
/* .group-page / .group-tabs / .gp-tab 由 styles.css 统一提供 */
.group-body.tab-in { animation: gp-tab-in .2s var(--ease-out) both; }
@keyframes gp-tab-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .group-body.tab-in { animation: none; } }
</style>

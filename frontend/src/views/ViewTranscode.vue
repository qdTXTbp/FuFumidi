<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ViewTranscribe from './ViewTranscribe.vue';
import ViewConvert from './ViewConvert.vue';
// 第三个入口：谱面 → MIDI（与「转录」「转换」并列）
import ViewScoreConvert from './ViewScoreConvert.vue';
import { t } from '../core/i18n.js';
const route = useRoute();
const router = useRouter();
const tabs = [
  { id: 'transcribe', label: t('转录'), ic: 'transcribe' },
  { id: 'convert', label: t('转换'), ic: 'convert' },
  // 「变谱」= 乐谱（MusicXML/MXL）→ MIDI；放在这里是因为用户对这一页的心智是
  // 「把别的东西变成 MIDI」。
  { id: 'score', label: t('变谱'), ic: 'score' },
];
const comps = { transcribe: ViewTranscribe, convert: ViewConvert, score: ViewScoreConvert };
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
</style>

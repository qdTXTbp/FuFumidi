<script setup>
// UTAU 工作台：声库制作 / 曲谱歌词 / 调声 / 合成渲染 四个子模块，共享 UTAU 工程
import { ref, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { useUtauStore } from '../stores/utau';
import { t } from '../core/i18n.js';
import ViewVoicebank from './ViewVoicebank.vue';
import UtauScore from '../components/utau/UtauScore.vue';
import UtauTune from '../components/utau/UtauTune.vue';
import UtauRender from '../components/utau/UtauRender.vue';

const store = useUtauStore();

const TABS = [
  { id: 'voicebank', label: '声库制作', ic: 'mic' },
  { id: 'score', label: '曲谱编辑', ic: 'edit' },
  { id: 'tune', label: '调声', ic: 'spark' },
  { id: 'render', label: '合成渲染', ic: 'convert' },
];
const tab = ref('voicebank');
const pending = ref(true);

onMounted(() => { store.init(); pending.value = false; });
</script>

<template>
  <div class="utau">
    <div class="utau-head">
      <div class="utau-title">
        <Icon name="utau" :size="16" />
        <b>UTAU 工作台</b>
        <span class="tag">{{ t('音MAD 制作') }}</span>
      </div>
      <div class="utau-tabs">
        <button v-for="tb in TABS" :key="tb.id" class="utau-tab" :class="{ on: tab === tb.id }" @click="tab = tb.id">
          <Icon :name="tb.ic" :size="13" /> {{ t(tb.label) }}
        </button>
      </div>
      <div class="utau-meta" v-if="!pending">
        <span class="muted small">{{ store.bpm }} BPM · 音源 {{ store.sampleNote }} · {{ store.notes.length }} 音符</span>
      </div>
    </div>

    <div class="utau-body">
      <ViewVoicebank v-if="tab === 'voicebank'" />
      <UtauScore v-else-if="tab === 'score'" />
      <UtauTune v-else-if="tab === 'tune'" />
      <UtauRender v-else-if="tab === 'render'" />
    </div>
  </div>
</template>

<style scoped>
.utau { padding: 0 0 0 0; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.utau-head { display: flex; align-items: center; gap: 14px; padding: 10px 18px; border-bottom: 1px solid var(--border); background: var(--canvas); }
.utau-title { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--ink); }
.utau-title b { font-size: 15px; }
.utau-tabs { display: flex; gap: 4px; margin-left: 8px; }
.utau-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--stone); font-size: 13px; cursor: pointer; }
.utau-tab:hover { background: var(--surface-muted); color: var(--ink); }
.utau-tab.on { background: var(--brand-soft); color: var(--brand-text); border-color: var(--brand); }
.utau-meta { margin-left: auto; white-space: nowrap; }
.utau-body { flex: 1; min-height: 0; overflow: auto; }
</style>
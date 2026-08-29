<script setup>
// UTAU 工作台：声库制作 / 曲谱歌词 / 调声 / 合成渲染 四个子模块，共享 UTAU 工程
import { ref, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { useUtauStore } from '../stores/utau';
import { t } from '../core/i18n.js';
import ViewVoicebank from './ViewVoicebank.vue';
import UtauLibrary from '../components/utau/UtauLibrary.vue';
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
      <div class="utau-meta" v-if="tab !== 'voicebank' && !pending" :title="store.voicebankDir">
        <span class="muted small">{{ store.voicebankDir ? store.voicebankDir : t('未选声库') }} · {{ store.bpm }} BPM · {{ store.notes.length }} {{ t('音符') }}</span>
      </div>
    </div>

    <div class="utau-body">
      <div v-if="tab === 'voicebank'" class="utau-vb">
        <section class="utau-sec">
          <UtauLibrary />
        </section>
        <section class="utau-sec">
          <div class="utau-sec-title"><Icon name="mic" :size="13" /> {{ t('自制声库') }}</div>
          <ViewVoicebank />
        </section>
      </div>
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
.utau-meta { margin-left: auto; white-space: nowrap; max-width: 46%; overflow: hidden; text-overflow: ellipsis; }
.utau-body { flex: 1; min-height: 0; overflow: auto; }
.utau-vb { padding: 16px 18px; display: flex; flex-direction: column; gap: 16px; }
.utau-sec { border: 1px solid var(--border); border-radius: 12px; background: var(--canvas); padding: 14px 16px; }
.utau-sec-title { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--ink); margin-bottom: 4px; }
</style>
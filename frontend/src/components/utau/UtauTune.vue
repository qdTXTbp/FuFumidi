<script setup>
// 调声参数：作用于当前选中音符（颤音/力度/音量），与曲谱联动
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { useUtauStore } from '../../stores/utau';
import { t } from '../../core/i18n.js';

const store = useUtauStore();
const n = computed(() => store.selected);

function patch(p) { if (n.value) store.updateNote(n.value.id, p); }
const u = v => Math.max(0, Math.min(200, parseFloat(v) || 100));
const vd = v => Math.max(5, Math.min(240, parseFloat(v) || 25));
const vf = v => Math.max(1, Math.min(12, parseFloat(v) || 5.5));
</script>

<template>
  <div class="utn">
    <div v-if="!n" class="muted small utn-empty">{{ t('先在「曲谱编辑」中选中一个音符。') }}</div>
    <div v-else class="utn-grid">
      <div class="utn-card util">
        <b>{{ t('力度') }}</b>
        <div class="utn-row"><span>{{ t('子音速度') }}</span><input type="number" class="text-input" :value="n.velocity" min="0" max="200" @input="e => patch({ velocity: u(e.target.value) })" /><em>{{ n.velocity }}</em></div>
        <div class="utn-row"><span>{{ t('音量 %') }}</span><input type="number" class="text-input" :value="n.volume" min="0" max="200" @input="e => patch({ volume: u(e.target.value) })" /><em>{{ n.volume }}</em></div>
      </div>

      <div class="utn-card util">
        <b>{{ t('颤音') }}</b>
        <label class="utn-switch">
          <input type="checkbox" :checked="!!n.vibrato" @change="e => patch({ vibrato: !!e.target.checked })" />
          <span>{{ n.vibrato ? t('开') : t('关') }}</span>
        </label>
        <div class="utn-row" :class="{ dim: !n.vibrato }"><span>{{ t('深度 ¢') }}</span><input type="number" class="text-input" :value="n.vibDepth" :disabled="!n.vibrato" @input="e => patch({ vibDepth: vd(e.target.value) })" /><em>{{ n.vibDepth }}</em></div>
        <div class="utn-row" :class="{ dim: !n.vibrato }"><span>{{ t('频率 Hz') }}</span><input type="number" class="text-input" :value="n.vibFreq" :disabled="!n.vibrato" @input="e => patch({ vibFreq: vf(e.target.value) })" /><em>{{ n.vibFreq }}</em></div>
      </div>

      <div class="utn-card">
        <b>{{ t('flags（预留）') }}</b>
        <input class="text-input utn-flags" :value="n.flags" placeholder="如 g-3B50Y90" @input="e => patch({ flags: e.target.value })" />
        <div class="muted small">{{ t('引擎渲染时应用（当前版本记入工程）。') }}</div>
      </div>

      <div class="utn-card neutral">
        <div class="utn-row wide"><span class="muted">{{ t('当前音符') }}</span><em>{{ n.lyric }} · 第 {{ n.startBeat }} 拍起 · {{ n.durBeat }} 拍</em></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.utn { padding: 14px 18px; }
.utn-empty { padding: 16px 2px; line-height: 1.6; }
.utn-grid { display: flex; flex-wrap: wrap; gap: 14px; }
.utn-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--canvas); min-width: 220px; }
.utn-card b { font-size: 13px; color: var(--ink); }
.utn-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--stone); }
.utn-row span { flex: 1; }
.utn-row em { width: 46px; text-align: right; font-style: normal; font-variant-numeric: tabular-nums; color: var(--ink); }
.utn-row input { width: 70px; padding: 3px 6px; font-size: 12px; }
.utn-flags { width: 100%; padding: 5px 8px; font-size: 12px; }
.utn-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink); cursor: pointer; }
.utn-row.dim { opacity: .5; }
.utn-row.wide { }
</style>
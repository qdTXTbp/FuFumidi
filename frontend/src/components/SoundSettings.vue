<script setup>
// 音效设置：分类音量 + 方案 + 自定义提示音风格；全部使用合成音，无需外部音频文件。
import { computed } from 'vue';
import Icon from './Icon.vue';
import { t } from '../core/i18n.js';
import {
  sfxConfig, SFX_CATEGORIES, SFX_SCHEMES,
  applySfxScheme, playSfx, playDoneChime, resetSfx, setSfxCategory, setSfxEnabled, setSfxMaster, saveSfxConfig,
} from '../core/sfx.js';

const CAT = {
  ui: { label: '界面交互', desc: '按钮与导航点击', test: 'click', icon: 'music' },
  task: { label: '任务通知', desc: '长任务完成/失败', test: 'success', icon: 'task' },
  chime: { label: '转录完成', desc: '转录批次结束提示', test: 'complete', icon: 'transcribe' },
};
const schemeLabel = { light: '轻量', standard: '标准', immersive: '沉浸', custom: '自定义' };
const styleLabel = { bright: '清亮', soft: '柔和', short: '短促' };
const schemeKeys = ['light', 'standard', 'immersive'];
const masterPct = computed({ get: () => Math.round(sfxConfig.master * 100), set: (v) => setSfxMaster(Number(v) / 100) });
function pct(id) { return Math.round((sfxConfig.categories[id]?.volume || 0) * 100); }
function onVol(id, ev) { setSfxCategory(id, { volume: Number(ev.target.value) / 100, enabled: true }); saveSfxConfig({ scheme: 'custom' }); }
function onToggle(id, ev) { setSfxCategory(id, { enabled: !!ev.target.checked }); saveSfxConfig({ scheme: 'custom' }); }
function preset(id) { applySfxScheme(id); }
function test(id) {
  if (id === 'chime') playDoneChime(false);
  else playSfx(CAT[id].test, id);
}
</script>

<template>
  <div class="sound-settings">
    <div class="ss-head">
      <div><b>{{ t('音效') }}</b><p>{{ t('本地合成，可随时关闭。') }}</p></div>
      <label class="ss-master"><input type="checkbox" :checked="sfxConfig.enabled" @change="setSfxEnabled($event.target.checked)" /><span>{{ t('启用音效') }}</span></label>
    </div>

    <div class="ss-block">
      <div class="ss-row"><span>{{ t('总音量') }}</span><b>{{ masterPct }}%</b></div>
      <input class="ss-range" type="range" min="0" max="100" step="1" v-model.number="masterPct" :aria-label="t('总音量')" />
      <div class="ss-presets">
        <span>{{ t('方案') }}</span>
        <button v-for="id in schemeKeys" :key="id" :class="{ on: sfxConfig.scheme === id }" @click="preset(id)">{{ t(schemeLabel[id]) }}</button>
        <button :class="{ on: sfxConfig.scheme === 'custom' }" @click="saveSfxConfig({ scheme: 'custom' })">{{ t('自定义') }}</button>
      </div>
    </div>

    <div class="ss-sec">{{ t('分类音量') }}</div>
    <div class="ss-list">
      <div v-for="id in ['ui','task','chime']" :key="id" class="ss-item">
        <span class="ss-ic"><Icon :name="CAT[id].icon" :size="15" /></span>
        <span class="ss-copy"><b>{{ t(CAT[id].label) }}</b><small>{{ t(CAT[id].desc) }}</small></span>
        <span class="ss-test">
          <button class="btn sm ghost" :disabled="!sfxConfig.enabled || !sfxConfig.categories[id].enabled" @click="test(id)">{{ t('试听') }}</button>
          <label class="ss-switch"><input type="checkbox" :checked="sfxConfig.categories[id].enabled" @change="onToggle(id, $event)" /><i></i></label>
          <span class="ss-pct">{{ pct(id) }}%</span>
        </span>
        <input class="ss-range" type="range" min="0" max="100" step="1" :value="pct(id)" :aria-label="t(CAT[id].label)" @input="onVol(id, $event)" />
      </div>
    </div>

    <div class="ss-sec">{{ t('提示音自定义') }}</div>
    <div class="ss-block">
      <div class="ss-row"><span>{{ t('转录完成提示音风格') }}</span>
        <select class="ss-select" :value="sfxConfig.chimeStyle" @change="saveSfxConfig({ chimeStyle: $event.target.value }); setSfxCategory('chime', { enabled: true })">
          <option v-for="(label, id) in styleLabel" :key="id" :value="id">{{ t(label) }}</option>
        </select>
      </div>
      <p class="ss-note">{{ t('跟随分类音量；可选清亮 / 柔和 / 短促。') }}</p>
    </div>

    <div class="ss-foot">
      <button class="btn sm ghost" @click="resetSfx">{{ t('恢复默认') }}</button>
      <span class="ss-note">{{ sfxConfig.enabled ? t('当前音效已启用') : t('当前音效已关闭') }}</span>
    </div>
  </div>
</template>

<style scoped>
.sound-settings { display: flex; flex-direction: column; gap: var(--sp-3); }
.ss-head { display: flex; align-items: flex-start; gap: var(--sp-4); }
.ss-head b { font-size: var(--fs-lg); }
.ss-head p { margin: var(--sp-1) 0 0; color: var(--text3); font-size: var(--fs-sm); line-height: 1.6; }
.ss-master { display: flex; align-items: center; gap: var(--sp-2); color: var(--text2); font-size: var(--fs-sm); white-space: nowrap; margin-left: auto; }
.ss-block { border: 1px solid var(--hairline); border-radius: var(--r-md); padding: var(--sp-3); background: var(--surface); display: flex; flex-direction: column; gap: var(--sp-2); }
.ss-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); color: var(--text2); font-size: var(--fs-sm); }
.ss-row b { color: var(--accent-sky); font: var(--fs-sm) var(--font-num); }
.ss-range { width: 100%; accent-color: var(--accent-sapphire); }
.ss-presets { display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; color: var(--text3); font-size: var(--fs-sm); }
.ss-presets button, .ss-select { border: 1px solid var(--hairline); background: var(--surface-soft); color: var(--text2); border-radius: var(--r-sm); padding: var(--sp-1) var(--sp-2); font-size: var(--fs-sm); }
.ss-presets button.on { border-color: var(--accent-sky); color: var(--text); background: color-mix(in srgb, var(--accent-sapphire) 12%, var(--surface)); }
.ss-sec { font-size: var(--fs-xs); color: var(--text3); letter-spacing: .1em; text-transform: uppercase; margin-top: var(--sp-2); }
.ss-list { display: flex; flex-direction: column; gap: var(--sp-2); }
.ss-item { display: grid; grid-template-columns: 24px minmax(0,1fr) auto; align-items: center; gap: var(--sp-2); padding: var(--sp-2); border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); }
.ss-ic { color: var(--accent-sky); display: grid; place-items: center; }
.ss-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ss-copy b { font-size: var(--fs-sm); color: var(--text); }
.ss-copy small { font-size: var(--fs-xs); color: var(--text3); }
.ss-test { display: flex; align-items: center; gap: var(--sp-1); }
.ss-switch { position: relative; width: 28px; height: 16px; display: inline-block; flex: none; }
.ss-switch input { opacity: 0; width: 0; height: 0; }
.ss-switch i { position: absolute; inset: 0; border-radius: var(--r-pill); background: var(--surface-soft); border: 1px solid var(--hairline); transition: background var(--dur-1); }
.ss-switch i::after { content: ""; position: absolute; width: 10px; height: 10px; left: 2px; top: 2px; border-radius: 50%; background: var(--text3); transition: transform var(--dur-1), background var(--dur-1); }
.ss-switch input:checked + i { background: color-mix(in srgb, var(--accent-sapphire) 45%, var(--surface-soft)); border-color: color-mix(in srgb, var(--accent-sky) 40%, var(--hairline)); }
.ss-switch input:checked + i::after { transform: translateX(12px); background: var(--accent-sky); }
.ss-pct { width: 34px; text-align: right; color: var(--text3); font-size: var(--fs-xs); font-family: var(--font-num); }
.ss-item .ss-range { grid-column: 1 / -1; margin-top: var(--sp-1); }
.ss-note { margin: 0; color: var(--text3); font-size: var(--fs-xs); line-height: 1.6; }
.ss-foot { display: flex; align-items: center; gap: var(--sp-3); }
</style>
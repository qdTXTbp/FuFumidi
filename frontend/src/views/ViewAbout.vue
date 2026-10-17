<script setup>
// P1-7 关于与许可：数据来自 scripts/gen-licenses.mjs 生成的 core/licenses.js
// （音色库来自 main/soundfonts.js REGISTRY，第三方二进制来自 docs/VENDOR.md）。
import { ref } from 'vue';
import Icon from '../components/Icon.vue';
import { LICENSES } from '../core/licenses.js';
import { t } from '../core/i18n.js';
import { useAppStore } from '../stores/app';

const app = useAppStore();
const data = ref(LICENSES || { app: {}, soundfonts: [], vendors: [], notes: [] });
function back() { try { app.setView('home'); } catch (e) { location.hash = '#/home'; } }
</script>

<template>
  <div class="page page-flat about-page">
    <div class="page-head">
      <div class="page-ic"><Icon name="info" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ t('关于与许可') }}</div>
        <div class="page-sub">{{ t('版本、内置音色库与第三方组件的许可证与来源') }}</div>
      </div>
      <button class="btn sm" @click="back">{{ t('返回') }}</button>
    </div>

    <div class="card about-card">
      <h4><Icon name="box" :size="14" /> {{ t('应用') }}</h4>
      <div class="about-row"><b>{{ data.app.name }}</b><span>{{ data.app.version }}</span><span class="muted">{{ data.app.license }}</span></div>
    </div>

    <div class="card about-card">
      <h4><Icon name="music" :size="14" /> {{ t('内置音色库') }}（{{ data.soundfonts.length }}）</h4>
      <div class="about-table">
        <div class="about-tr about-th"><span>{{ t('名称') }}</span><span>{{ t('版本') }}</span><span>{{ t('许可证') }}</span></div>
        <div class="about-tr" v-for="s in data.soundfonts" :key="s.id"><span>{{ s.name }}</span><span>{{ s.version }}</span><span class="muted">{{ s.license }}</span></div>
      </div>
    </div>

    <div class="card about-card">
      <h4><Icon name="import" :size="14" /> {{ t('内置第三方组件') }}（{{ data.vendors.length }}）</h4>
      <div class="about-table">
        <div class="about-tr about-th"><span>{{ t('文件') }}</span><span>{{ t('上游') }}</span><span>{{ t('许可证') }}</span></div>
        <div class="about-tr" v-for="v in data.vendors" :key="v.file"><span>{{ v.file }}</span><span class="muted">{{ v.upstream }} {{ v.version }}</span><span class="muted">{{ v.license }}</span></div>
      </div>
    </div>

    <div class="card about-card">
      <h4><Icon name="info" :size="14" /> {{ t('说明') }}</h4>
      <ul class="about-notes"><li v-for="(n, i) in data.notes" :key="i">{{ n }}</li></ul>
    </div>
  </div>
</template>

<style scoped>
.about-page { display: flex; flex-direction: column; gap: var(--sp-2); overflow-y: auto; }
.about-card { padding: var(--sp-3); }
.about-card h4 { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-2); }
.about-row { display: flex; align-items: center; gap: var(--sp-3); }
.about-table { display: flex; flex-direction: column; gap: var(--sp-1); }
.about-tr { display: grid; grid-template-columns: 1.2fr 1fr 1.6fr; gap: var(--sp-3); padding: var(--sp-1) 0; border-top: 1px solid var(--hairline); }
.about-th { color: var(--muted); border-top: none; }
.about-notes { margin: 0; padding-left: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-1); }
</style>

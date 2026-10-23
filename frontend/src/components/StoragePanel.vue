<script setup>
// P1-9 存储治理：分类占用 + 安全清理（曲库 protected；资产需显式勾选）
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import { t } from '../core/i18n.js';
import { useAppStore } from '../stores/app';

const app = useAppStore();
const bridge = window.fuBridge;
const CACHE_KEY = 'fufumidi_storage_report_v1';
const rawCache = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; } })();
const cacheFresh = !!(rawCache && rawCache.at && Date.now() - Number(rawCache.at) < 5 * 60 * 1000 && rawCache.report);
const cached = rawCache && rawCache.report ? rawCache.report : rawCache;
const loading = ref(!cached);
const report = ref(cached || null);
const includeAssets = ref(false);
const lastResult = ref(null);
const totalText = computed(() => {
  const b = report.value ? report.value.totalBytes : 0;
  return fmtSize(b);
});

function fmtSize(b) {
  const n = Number(b) || 0;
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  if (n >= 1 << 10) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function kindLabel(kind) {
  if (kind === 'protected') return t('曲库（不可清理）');
  if (kind === 'asset') return t('资产（需显式勾选）');
  return t('可重建');
}
async function refresh() {
  if (!bridge || !bridge.storage) return;
  if (!report.value) loading.value = true;
  try {
    report.value = await bridge.storage.report();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), report: report.value })); } catch (e) {}
  } catch (e) { if (!report.value) report.value = null; }
  loading.value = false;
}
async function cleanup() {
  if (!bridge || !bridge.storage) return;
  const ok = await app.confirmDialog({
    title: t('确认清理'),
    msg: t('将清空可重建的缓存/临时文件，并把日志保留最近几份。资产（模型/音色/声库）需要勾选「包含资产」才会删除。曲库永远不动。确定继续？'),
  });
  if (!ok) return;
  loading.value = true;
  try {
    const r = await bridge.storage.cleanup({ includeAssets: includeAssets.value });
    lastResult.value = r;
    await refresh();
    if (r && r.ok) app.toast(t('已释放：') + fmtSize(r.freedBytes), 'ok');
    else app.toast(t('清理失败：') + ((r && r.errors && r.errors[0]) || ''), 'warn');
  } catch (e) {
    app.toast(t('清理失败：') + String((e && e.message) || e), 'warn');
  }
  loading.value = false;
}
onMounted(() => { if (!cacheFresh) refresh(); });
</script>

<template>
  <div class="card storage-panel" data-guide="storage-panel">
    <div class="st-head">
      <Icon name="box" :size="15" />
      <b>{{ t('存储治理') }}</b>
      <span class="st-total">{{ t('总计') }} {{ totalText }}</span>
      <span class="grow"></span>
      <button class="btn sm" :disabled="loading" @click="refresh">{{ t('刷新') }}</button>
    </div>
    <div class="st-list">
      <div class="st-row st-th"><span>{{ t('分类') }}</span><span>{{ t('占用') }}</span><span>{{ t('文件数') }}</span><span>{{ t('说明') }}</span></div>
      <div class="st-row" v-for="a in (report ? report.areas : [])" :key="a.id" :data-area="a.id">
        <span>{{ a.label }}</span>
        <span class="st-num">{{ fmtSize(a.bytes) }}</span>
        <span class="st-num">{{ a.files }}</span>
        <span class="st-kind" :class="'k-' + a.kind">{{ kindLabel(a.kind) }}</span>
      </div>
      <div v-if="!report" class="st-empty">{{ loading ? t('读取中…') : t('无法读取存储报告') }}</div>
    </div>
    <div class="st-actions">
      <label class="st-check"><input type="checkbox" v-model="includeAssets" /> {{ t('包含已下载资产（模型 / 音色 / 声库）') }}</label>
      <span class="grow"></span>
      <button class="btn sm primary" :disabled="loading" @click="cleanup">{{ t('清理可重建项') }}</button>
    </div>
    <div v-if="lastResult" class="st-result">{{ t('上次清理释放：') }}{{ fmtSize(lastResult.freedBytes) }}</div>
  </div>
</template>

<style scoped>
.storage-panel { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); }
.st-head { display: flex; align-items: center; gap: var(--sp-2); }
.st-total { color: var(--muted); }
.grow { flex: 1; }
.st-list { display: flex; flex-direction: column; }
.st-row { display: grid; grid-template-columns: 1.4fr 0.8fr 0.6fr 1.4fr; gap: var(--sp-3); padding: var(--sp-1) 0; border-top: 1px solid var(--hairline); }
.st-th { color: var(--muted); border-top: none; }
.st-num { font-variant-numeric: tabular-nums; }
.st-kind.k-safe { color: var(--brand); }
.st-kind.k-asset { color: var(--muted); }
.st-kind.k-protected { color: var(--brand-coral); }
.st-actions { display: flex; align-items: center; gap: var(--sp-2); padding-top: var(--sp-2); border-top: 1px solid var(--hairline); }
.st-empty, .st-result { color: var(--muted); }
</style>

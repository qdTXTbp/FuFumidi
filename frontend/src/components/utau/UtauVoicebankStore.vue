<script setup>
// 声库资源中心：开源 / 免费 UTAU 声库一键下载安装。
// 装完直接落到 <数据根目录>/voicebanks/，可立即在 UTAU 工作台（曲谱与调声 / 合成渲染）选用。
// 所有条目都从作者或上游项目公开托管的仓库按需拉取，使用条款随条目展示。
import { ref, computed, onMounted, onActivated, onBeforeUnmount } from 'vue';
import Icon from '../Icon.vue';
import { useUtauStore } from '../../stores/utau';
import { t } from '../../core/i18n.js';

const emit = defineEmits(['installed']);
const store = useUtauStore();
const bridge = window.fuBridge;
const isDesktop = !!(bridge && bridge.utauVoicebankRegistry);

const list = ref([]);
const vbRoot = ref('');
const loading = ref(false);
const err = ref('');
const msg = ref('');
const busyId = ref('');
// id -> { percent, phase, error }
const prog = ref({});
let offProgress = null;

const installedCount = computed(() => list.value.filter(x => x.installed).length);

function fmtSize(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  if (v >= 1073741824) return (v / 1073741824).toFixed(1) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(v / 1024)) + ' KB';
}

async function load() {
  if (!isDesktop) return;
  loading.value = true;
  err.value = '';
  try {
    const r = await bridge.utauVoicebankRegistry();
    if (r && r.ok) { list.value = r.list || []; vbRoot.value = r.dir || ''; }
    else err.value = (r && r.error) || 'unknown';
  } catch (e) { err.value = String((e && e.message) || e); }
  finally { loading.value = false; }
}

// 声库目录变化后同步给全局 store（让 UTAU 工作台的声库列表立刻可见）
async function syncStore(activateDir) {
  try {
    const r = await bridge.utauListVoicebanks();
    if (r && r.ok) store.setVoicebanks(r.list || []);
  } catch (e) {}
  if (activateDir) store.setVoicebank(activateDir);
}

async function install(it) {
  if (!isDesktop) { err.value = t('请在桌面版下载安装声库。'); return; }
  if (busyId.value) return;
  busyId.value = it.id;
  err.value = '';
  msg.value = '';
  prog.value = { ...prog.value, [it.id]: { percent: 0, phase: 'download' } };
  try {
    const r = await bridge.utauDownloadVoicebank(it.id);
    if (r && r.ok) {
      await load();
      await syncStore(r.dir || '');
      msg.value = (r.existed ? t('该声库已安装：') : t('已安装并设为当前声库：')) + t(r.name || it.name);
      emit('installed', r.dir || '');
    } else if (r && r.canceled) {
      msg.value = t('已取消下载。');
    } else {
      err.value = t('安装失败：') + ((r && r.error) || 'unknown');
    }
  } catch (e) {
    err.value = t('安装失败：') + ((e && e.message) || e);
  } finally {
    busyId.value = '';
    const p = prog.value[it.id];
    if (p) prog.value = { ...prog.value, [it.id]: { ...p, phase: 'done' } };
  }
}

async function cancel(it) {
  try { await bridge.utauCancelVoicebankDownload(it.id); } catch (e) {}
}

function use(it) {
  store.setVoicebank(it.dir);
  msg.value = t('已设为当前声库：') + t(it.name);
}

async function remove(it) {
  if (!window.confirm(t('确定删除声库「') + t(it.name) + t('」？'))) return;
  try {
    const r = await bridge.utauDeleteVoicebank(it.dir);
    if (r && r.ok) {
      if (store.voicebankDir === it.dir) store.setVoicebank('');
      msg.value = t('已删除声库：') + t(it.name);
      await load();
      await syncStore('');
    } else {
      err.value = t('删除失败：') + ((r && r.error) || 'unknown');
    }
  } catch (e) { err.value = t('删除失败：') + ((e && e.message) || e); }
}

function openSite(it) {
  try { window.open(it.officialUrl, '_blank'); } catch (e) {}
}
function openDir() {
  try { if (bridge && bridge.openOutput) bridge.openOutput(vbRoot.value); } catch (e) {}
}

onMounted(() => {
  load();
  if (bridge && bridge.onVoicebankProgress) {
    offProgress = bridge.onVoicebankProgress((p) => {
      if (!p || !p.id) return;
      prog.value = { ...prog.value, [p.id]: { percent: p.percent || 0, phase: p.phase || 'download', error: p.error || '' } };
    });
  }
});
// KeepAlive 保活：切回本页时重新读取安装状态（可能在别处装过/删过）
onActivated(load);
onBeforeUnmount(() => { if (offProgress) { try { offProgress(); } catch (e) {} offProgress = null; } });
</script>

<template>
  <div class="vbs">
    <div class="vbs-head">
      <div class="vbs-head-txt">
        <b>{{ t('UTAU 声库（开源 / 免费）') }}</b>
        <span class="muted small">
          {{ t('一键下载安装，装完即可在「UTAU 工作台」直接演唱；内容全部来自作者或上游项目的公开仓库。') }}
        </span>
      </div>
      <div class="vbs-head-act">
        <span v-if="vbRoot" class="vbs-root" :title="vbRoot">{{ t('声库目录：') }}{{ vbRoot }}</span>
        <button class="btn sm ghost" @click="load" :disabled="loading || !isDesktop" :title="t('重新扫描声库目录')">
          <Icon name="refresh" :size="13" />{{ t('刷新') }}
        </button>
        <button class="btn sm ghost" @click="openDir" :disabled="!isDesktop">
          <Icon name="folder" :size="13" />{{ t('打开目录') }}
        </button>
      </div>
    </div>

    <div v-if="!isDesktop" class="vbs-note">{{ t('声库下载安装仅在桌面版可用。') }}</div>

    <div v-else class="vbs-grid">
      <div v-for="it in list" :key="it.id" class="vbs-card" :class="{ on: it.installed }">
        <div class="vbs-card-top">
          <Icon name="mic" :size="15" />
          <b class="vbs-name">{{ t(it.name) }}</b>
          <span class="vbs-badge" :class="{ ok: it.installed }">{{ it.installed ? t('已安装') : t('未安装') }}</span>
        </div>
        <div class="vbs-meta">
          <span>{{ it.author }}</span>
          <span class="vbs-dot">·</span>
          <span>{{ t(it.lang) }}</span>
          <span v-if="it.installed && it.size" class="vbs-dot">·</span>
          <span v-if="it.installed && it.size">{{ fmtSize(it.size) }}</span>
        </div>
        <div class="vbs-desc">{{ t(it.desc) }}</div>
        <div class="vbs-license" :title="t(it.license)">{{ t('使用条款：') }}{{ t(it.license) }}</div>

        <div v-if="prog[it.id] && busyId === it.id" class="vbs-prog">
          <div class="vbs-prog-bar"><i :style="{ width: (prog[it.id].percent || 0) + '%' }"></i></div>
          <span class="vbs-prog-txt">
            {{ prog[it.id].phase === 'extract' ? t('正在解包安装…') : t('下载中 ') + (prog[it.id].percent || 0) + '%' }}
          </span>
        </div>

        <div class="vbs-acts">
          <button v-if="!it.installed" class="btn sm primary" @click="install(it)" :disabled="!!busyId">
            <Icon name="download" :size="13" />{{ busyId === it.id ? t('安装中…') : t('下载并安装') }}
          </button>
          <button v-else class="btn sm primary" @click="use(it)">
            <Icon name="zap" :size="13" />{{ t('在 UTAU 工作台使用') }}
          </button>
          <button v-if="busyId === it.id" class="btn sm ghost" @click="cancel(it)">{{ t('取消') }}</button>
          <button v-if="it.installed" class="btn sm ghost danger" @click="remove(it)">
            <Icon name="trash" :size="13" />{{ t('删除') }}
          </button>
          <button class="btn sm ghost vbs-link" @click="openSite(it)" :title="it.officialUrl">{{ t('来源页') }}</button>
        </div>
      </div>
    </div>

    <div v-if="msg" class="vbs-msg ok">{{ msg }}</div>
    <div v-if="err" class="vbs-msg bad">{{ err }}</div>
    <div v-if="isDesktop && installedCount" class="muted small">
      {{ t('已安装 ') }}{{ installedCount }}{{ t(' 个声库，可在「UTAU 工作台 → 曲谱与调声 / 合成渲染」切换。') }}
    </div>
  </div>
</template>

<style scoped>
.vbs { display: flex; flex-direction: column; gap: 10px; }
.vbs-head { display: flex; align-items: flex-start; gap: 12px; justify-content: space-between; flex-wrap: wrap; }
.vbs-head-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.vbs-head-txt b { font-size: 14px; color: var(--ink); }
.vbs-head-act { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vbs-root { font-size: 11px; color: var(--stone); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vbs-note { font-size: 12px; color: var(--stone); }
.vbs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.vbs-card { display: flex; flex-direction: column; gap: 6px; padding: 11px 12px; border: 1px solid var(--hairline); border-radius: 12px; background: var(--surface); }
.vbs-card.on { border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline)); }
.vbs-card-top { display: flex; align-items: center; gap: 6px; color: var(--ink); }
.vbs-name { font-size: 13.5px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vbs-badge { margin-left: auto; flex: none; font-size: 10.5px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--hairline); color: var(--stone); }
.vbs-badge.ok { color: var(--accent); border-color: var(--accent); }
.vbs-meta { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--stone); flex-wrap: wrap; }
.vbs-dot { opacity: .55; }
.vbs-desc { font-size: 12px; color: var(--slate); line-height: 1.55; }
.vbs-license { font-size: 11px; color: var(--stone); line-height: 1.5; border-left: 2px solid var(--hairline); padding-left: 7px; }
.vbs-prog { display: flex; align-items: center; gap: 8px; }
.vbs-prog-bar { flex: 1; height: 4px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; }
.vbs-prog-bar i { display: block; height: 100%; background: var(--accent); transition: width .18s; }
.vbs-prog-txt { font-size: 11px; color: var(--stone); flex: none; font-variant-numeric: tabular-nums; }
.vbs-acts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.vbs-link { margin-left: auto; }
.vbs-msg { font-size: 12px; padding: 7px 10px; border-radius: 9px; border: 1px solid var(--hairline); }
.vbs-msg.ok { color: var(--ink); background: var(--surface-soft); }
.vbs-msg.bad { color: var(--error); border-color: color-mix(in srgb, var(--error) 35%, var(--hairline)); }
</style>

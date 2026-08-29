<script setup>
// 声库管理：导入现成 UTAU 声库(zip) / 选择当前声库 / 进入自制
import { ref, onMounted } from 'vue';
import Icon from '../Icon.vue';
import { useUtauStore } from '../../stores/utau';
import { t } from '../../core/i18n.js';

const store = useUtauStore();
const bridge = window.fuBridge;
const isDesktop = !!(bridge && bridge.utauListVoicebanks);
const busy = ref(false);
const msg = ref('');

async function refresh() {
  if (!bridge || !bridge.utauListVoicebanks) return;
  const r = await bridge.utauListVoicebanks();
  if (r && r.ok) store.setVoicebanks(r.list || []);
}

async function importZip() {
  if (!bridge || !bridge.utauImportVoicebankZip) { msg.value = t('请在桌面版导入声库 zip。'); return; }
  busy.value = true; msg.value = '';
  try {
    const r = await bridge.utauImportVoicebankZip();
    if (r && r.ok) { store.setVoicebank(r.dir); await refresh(); msg.value = t('已导入声库：') + r.name; }
    else if (r && r.canceled) { /* 用户取消 */ }
    else msg.value = t('导入失败：') + ((r && r.error) || 'unknown');
  } catch (e) { msg.value = t('导入失败：') + ((e && e.message) || e); }
  finally { busy.value = false; }
}
function choose(v) { store.setVoicebank(v.dir); msg.value = t('当前声库：') + v.name; }

onMounted(refresh);
</script>

<template>
  <div class="ul">
    <div class="ul-head">
      <div>
        <b>{{ t('声库') }}</b>
        <span class="muted small">{{ t('导入现成 UTAU 声库(.zip)，或自制声库') }}</span>
      </div>
      <button class="btn primary" @click="importZip" :disabled="busy || !isDesktop">
        <Icon name="download" :size="14" /> {{ busy ? t('导入中…') : t('导入声库 (.zip)') }}
      </button>
    </div>

    <div v-if="store.voicebanks.length" class="ul-list">
      <div v-for="v in store.voicebanks" :key="v.dir" class="ul-item" :class="{ on: store.voicebankDir === v.dir }" @click="choose(v)">
        <Icon name="folder" :size="14" />
        <span class="ul-name" :title="v.dir">{{ v.name }}</span>
        <em class="muted small">{{ v.dir }}</em>
        <span v-if="store.voicebankDir === v.dir" class="ul-on">{{ t('当前') }}</span>
      </div>
    </div>
    <div v-else class="muted small ul-empty">
      {{ isDesktop ? t('还没有导入声库。导入一个现成声库即可在「合成渲染」使用。') : t('网页版无法导入 zip 声库，请用桌面版。可先自制声库用于演示。') }}
    </div>

    <div v-if="msg" class="ul-msg">{{ msg }}</div>
  </div>
</template>

<style scoped>
.ul { display: flex; flex-direction: column; gap: 10px; }
.ul-head { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
.ul-head b { font-size: 14px; color: var(--ink); }
.ul-head > div { display: flex; flex-direction: column; gap: 2px; }
.ul-list { display: flex; flex-direction: column; gap: 6px; }
.ul-item { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; }
.ul-item:hover { background: var(--surface-muted); }
.ul-item.on { border-color: var(--brand); background: var(--brand-soft); }
.ul-name { font-weight: 600; font-size: 13px; color: var(--ink); }
.ul-item em { font-style: normal; color: var(--stone); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
.ul-on { margin-left: auto; font-size: 11px; color: var(--brand); border: 1px solid var(--brand); border-radius: 999px; padding: 1px 8px; }
.ul-empty { padding: 6px 2px; line-height: 1.6; }
.ul-msg { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-muted); font-size: 13px; color: var(--ink); }
</style>
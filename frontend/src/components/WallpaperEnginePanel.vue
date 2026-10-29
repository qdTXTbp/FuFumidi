<script setup>
// 外观 → Wallpaper Engine：扫描本地 WE 项目，应用为整窗背景（WebWallGL iframe）
import { computed, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { useSettingsStore } from '../stores/settings';
import { useVizBgStore } from '../stores/vizbg';
import { t } from '../core/i18n.js';

const app = useAppStore();
const settingsStore = useSettingsStore();
const vizBg = useVizBgStore();
const props = defineProps({ target: { type: String, default: 'app' } });
const bridge = window.fuBridge;
const busy = ref(false);
const detected = ref({ installed: false, installDir: '', libraries: [] });
const items = ref([]);
const error = ref('');
const kind = ref('all');
const appliedId = computed(() => props.target === 'viz' ? String((vizBg.bg && vizBg.bg.weId) || '') : String((settingsStore.settings && settingsStore.settings.wallpaper_we_id) || ''));
const shown = computed(() => items.value.filter((x) => kind.value === 'all' || x.type === kind.value));

async function load(force) {
  if (!bridge || !bridge.wallpaperEngine) { error.value = t('当前版本不支持 Wallpaper Engine 接入'); return; }
  busy.value = true; error.value = '';
  try {
    detected.value = await bridge.wallpaperEngine.detect();
    const r = await bridge.wallpaperEngine.inventory(!!force);
    if (r && r.ok) { items.value = r.items || []; if (!r.installed) error.value = r.error || t('未检测到 Wallpaper Engine'); }
    else error.value = (r && r.error) || t('扫描失败');
  } catch (e) { error.value = String((e && e.message) || e); }
  finally { busy.value = false; }
}
async function apply(it) {
  if (props.target === 'viz') { await vizBg.setWe(it.id, it.title); return; }
  const patch = {
    wallpaper_provider: 'wallpaper-engine',
    wallpaper_we_id: it.id,
    wallpaper_we_type: it.type,
    wallpaper_we_title: it.title,
    wallpaper_enabled: true,
    custom_wallpaper: '',
  };
  settingsStore.setLocal(patch);
  try { await settingsStore.save(patch); } catch (e) {}
  app.toast(t('已应用 Wallpaper Engine 壁纸'), 'ok');
  try { window.dispatchEvent(new CustomEvent('fufumidi:wallpaper-changed')); } catch (e) {}
}
function openFolder() { try { bridge.wallpaperEngine.openFolder(); } catch (e) {} }
onMounted(() => load(false));
const TYPES = { scene: t('场景'), web: t('网页'), video: t('视频'), application: t('应用') };
</script>

<template>
  <div class="we-panel">
    <div class="we-head">
      <span class="we-title"><Icon name="wallpaper" :size="14" /> Wallpaper Engine</span>
      <span class="we-state" :class="{ on: detected.installed }">{{ detected.installed ? t('已检测到') : t('未检测到') }}</span>
      <span class="we-grow"></span>
      <button class="btn sm ghost" :disabled="busy" @click="load(true)">{{ busy ? t('扫描中…') : t('重新扫描') }}</button>
      <button v-if="detected.installed" class="btn sm ghost" @click="openFolder">{{ t('打开目录') }}</button>
    </div>
    <p v-if="detected.installDir" class="we-path">{{ detected.installDir }}</p>
    <p v-if="error" class="we-error">{{ error }}</p>
    <div v-if="items.length" class="we-kinds">
      <button :class="{ on: kind === 'all' }" @click="kind = 'all'">{{ t('全部') }}</button>
      <button v-for="k in ['scene','web','video']" :key="k" :class="{ on: kind === k }" @click="kind = k">{{ TYPES[k] }}</button>
    </div>
    <div v-if="items.length" class="we-grid">
      <button v-for="it in shown" :key="it.id" class="we-card" :class="{ on: appliedId === it.id }" @click="apply(it)">
        <span class="we-thumb">
          <img v-if="it.preview" :src="it.preview" alt="" loading="lazy" />
          <Icon v-else name="wallpaper" :size="22" />
          <b>{{ TYPES[it.type] || it.type }}</b>
        </span>
        <span class="we-name" :title="it.title">{{ it.title }}</span>
      </button>
    </div>
    <p v-else-if="!busy && !error" class="we-empty">{{ t('没有可用的 Wallpaper Engine 壁纸') }}</p>
    <p class="we-hint">{{ t('场景 / 网页 / 视频壁纸由 WebWallGL 在应用内渲染；不复制 Workshop 文件。') }}</p>
  </div>
</template>

<style scoped>
.we-panel { display: flex; flex-direction: column; gap: var(--sp-2); }
.we-head { display: flex; align-items: center; gap: var(--sp-2); }
.we-title { display: inline-flex; align-items: center; gap: 5px; color: var(--text); font-size: var(--fs-sm); font-weight: 600; }
.we-state { color: var(--text3); font-size: var(--fs-xs); }
.we-state.on { color: var(--t-ok); }
.we-grow { flex: 1; }
.we-path { margin: 0; color: var(--text3); font-family: var(--font-num); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.we-error { margin: 0; color: var(--t-err); font-size: var(--fs-xs); }
.we-kinds { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
.we-kinds button { border: 1px solid var(--hairline); border-radius: var(--r-pill); background: var(--surface); color: var(--text3); padding: 2px 9px; font-size: var(--fs-xs); }
.we-kinds button.on { color: var(--text); border-color: color-mix(in srgb, var(--accent-sky) 45%, var(--hairline)); }
.we-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: var(--sp-2); max-height: 260px; overflow: auto; }
.we-card { display: flex; flex-direction: column; gap: 4px; padding: 0; border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); overflow: hidden; cursor: pointer; text-align: left; }
.we-card.on { border-color: var(--accent-sky); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-sky) 35%, transparent); }
.we-thumb { position: relative; display: flex; align-items: center; justify-content: center; aspect-ratio: 16 / 10; background: var(--surface-soft); color: var(--text3); }
.we-thumb img { width: 100%; height: 100%; object-fit: cover; }
.we-thumb b { position: absolute; right: 4px; bottom: 4px; padding: 1px 5px; border-radius: var(--r-sm); background: rgba(0,0,0,.55); color: #fff; font-size: 10px; font-weight: 500; }
.we-name { padding: 0 7px 6px; color: var(--text2); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.we-empty, .we-hint { margin: 0; color: var(--text3); font-size: var(--fs-xs); }
</style>
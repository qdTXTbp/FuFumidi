<script setup>
// 统一壁纸库：静态 + 动态 + 本地文件夹 + 在线站点，一站式下载/应用。
// 外部文件夹只登记路径（不复制）；下载统一走主进程 wall.* IPC。
import { computed, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { useSettingsStore } from '../stores/settings';
import { t } from '../core/i18n.js';

const app = useAppStore();
const settingsStore = useSettingsStore();
const bridge = window.fuBridge;
const source = ref('repo');       // repo | online | local
const kindFilter = ref('all');    // all | image | video
const repo = ref([]);
const online = ref([]);
const folders = ref([]);
const folderFiles = ref([]);
const query = ref('wallpaper');
const page = ref(1);
const lastPage = ref(1);
const loading = ref(false);
const busy = ref('');
const error = ref('');
const directUrl = ref('');
const folderPaths = ref(loadFolders());

function loadFolders() { try { const a = JSON.parse(localStorage.getItem('fufumidi_wallpaper_folders') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function saveFolders() { try { localStorage.setItem('fufumidi_wallpaper_folders', JSON.stringify(folderPaths.value)); } catch (e) {} }
function fileUrl(p) { if (!p) return ''; if (/^(https?:|file:|data:)/i.test(p)) return p; return 'file:///' + String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:'); }
function kindOf(x) { return x.kind || (x.image ? 'image' : 'video'); }
function thumbOf(x) { return x.thumb || (x.image ? fileUrl(x.image) : ''); }
const allItems = computed(() => {
  const local = [
    ...repo.value.filter(x => x.local).map(x => ({ ...x, kind: kindOf(x), local: true, _src: 'repo' })),
    ...folderFiles.value.map(x => ({ ...x, local: true, _src: 'folder', thumb: x.kind === 'image' ? fileUrl(x.path) : (x.thumb ? fileUrl(x.thumb) : '') })),
  ];
  const remote = repo.value.filter(x => !x.local && x.video).map(x => ({ ...x, kind: 'video', local: false, _src: 'repo' }));
  const on = online.value.map(x => ({ ...x, local: false, _src: 'online' }));
  if (source.value === 'repo') return remote;
  if (source.value === 'online') return on;
  return local;
});
const shown = computed(() => allItems.value.filter(x => kindFilter.value === 'all' || kindOf(x) === kindFilter.value));
const currentName = computed(() => String((settingsStore.settings && settingsStore.settings.custom_wallpaper) || '').replace(/^.*[\\/]/, ''));

async function loadRepo() {
  if (!bridge || !bridge.wallpaper) return;
  try { const r = await bridge.wallpaper.list(); if (r && r.ok) repo.value = r.list || []; } catch (e) {}
}
async function scanFolders() {
  if (!bridge || !bridge.wallpaper || !bridge.wallpaper.scanFolder) return;
  const out = [];
  for (const dir of folderPaths.value) {
    try { const r = await bridge.wallpaper.scanFolder(dir); if (r && r.ok) for (const it of r.list) out.push({ ...it, dir }); } catch (e) {}
  }
  folderFiles.value = out;
}
async function searchOnline(more = false) {
  if (!bridge || !bridge.wallpaper || !bridge.wallpaper.searchWallhaven) { error.value = t('当前版本不支持在线搜索'); return; }
  loading.value = true; error.value = '';
  try {
    const p = more ? page.value + 1 : 1;
    const r = await bridge.wallpaper.searchWallhaven(query.value.trim() || 'wallpaper', p);
    if (!r || !r.ok) { error.value = (r && r.error) || t('搜索失败'); return; }
    page.value = r.page || p; lastPage.value = r.last || 1;
    online.value = more ? online.value.concat(r.list || []) : (r.list || []);
  } catch (e) { error.value = String((e && e.message) || e); } finally { loading.value = false; }
}
function pickSource(s) { source.value = s; if (s === 'online' && !online.value.length) searchOnline(false); }
async function applyLocal(path, kind) {
  const patch = { custom_wallpaper: path, wallpaper_enabled: true, wallpaper_kind: kind };
  settingsStore.setLocal(patch);
  try { await settingsStore.save(patch); } catch (e) {}
  app.toast(t('壁纸已应用'), 'ok');
}
async function downloadAndApply(item) {
  if (!bridge || !bridge.wallpaper) return;
  if (item.local) { await applyLocal(item.image || item.video || item.path, kindOf(item)); return; }
  busy.value = item.id || item.name || 'wallpaper';
  try {
    let r;
    if (kindOf(item) === 'image') r = await bridge.wallpaper.downloadUrl(item.image || item.remote || item.path, item.name);
    else r = await bridge.wallpaper.download(item.video || item.remote, item.name);
    if (!r || !r.ok) { app.toast(t('下载失败：') + String((r && r.error) || ''), 'error'); return; }
    await applyLocal(r.path, r.kind || kindOf(item));
    await loadRepo();
  } catch (e) { app.toast(t('下载失败：') + String((e && e.message) || e), 'error'); } finally { busy.value = ''; }
}
async function useDirectUrl() {
  const url = directUrl.value.trim();
  if (!/^https?:\/\//i.test(url)) { app.toast(t('请输入 http(s) 壁纸直链'), 'warn'); return; }
  if (!bridge || !bridge.wallpaper || !bridge.wallpaper.downloadUrl) { app.toast(t('当前版本不支持'), 'error'); return; }
  busy.value = url;
  try {
    const name = (url.split('/').pop() || 'wallpaper').split('?')[0];
    const r = await bridge.wallpaper.downloadUrl(url, name);
    if (r && r.ok) { await applyLocal(r.path, r.kind); directUrl.value = ''; }
    else app.toast(t('下载失败：') + String((r && r.error) || ''), 'error');
  } catch (e) { app.toast(t('下载失败：') + String((e && e.message) || e), 'error'); } finally { busy.value = ''; }
}
async function addFolder() {
  if (!bridge || !bridge.pickDirectory || !bridge.wallpaper || !bridge.wallpaper.scanFolder) return;
  const dir = await bridge.pickDirectory();
  if (!dir) return;
  if (!folderPaths.value.includes(dir)) { folderPaths.value.push(dir); saveFolders(); await scanFolders(); app.toast(t('已链接外部壁纸文件夹（不复制文件）'), 'ok'); }
}
function removeFolder(dir) { folderPaths.value = folderPaths.value.filter(x => x !== dir); saveFolders(); scanFolders(); }
function openSite(url) { try { if (bridge && bridge.openExternal) bridge.openExternal(url); else window.open(url, '_blank'); } catch (e) {} }
function isCurrent(x) { return !!(settingsStore.settings && settingsStore.settings.custom_wallpaper === (x.image || x.video || x.path)); }
onMounted(async () => { await settingsStore.load(); await loadRepo(); await scanFolders(); });
</script>

<template>
  <div class="wlib">
    <div class="wlib-top">
      <div class="wlib-src">
        <button :class="{ on: source === 'repo' }" @click="pickSource('repo')">{{ t('动态壁纸库') }}</button>
        <button :class="{ on: source === 'online' }" @click="pickSource('online')">{{ t('在线静态壁纸') }}</button>
        <button :class="{ on: source === 'local' }" @click="pickSource('local')">{{ t('本地 / 文件夹') }}</button>
      </div>
      <span class="wlib-state">{{ currentName || t('未选择壁纸') }}</span>
    </div>

    <div class="wlib-tools">
      <template v-if="source === 'online'">
        <div class="wlib-search"><Icon name="search" :size="13" /><input v-model="query" :placeholder="t('搜索 Wallhaven…')" @keydown.enter="searchOnline(false)" /><button v-if="query" @click="query = ''"><Icon name="close" :size="11" /></button></div>
        <button class="btn sm" :disabled="loading" @click="searchOnline(false)">{{ loading ? t('搜索中…') : t('搜索') }}</button>
      </template>
      <template v-else-if="source === 'local'">
        <button class="btn sm" @click="addFolder"><Icon name="folder" :size="13" />{{ t('链接外部文件夹') }}</button>
        <span class="wlib-hint">{{ t('只登记路径，不复制到工具目录') }}</span>
      </template>
      <span class="wlib-grow"></span>
      <div class="wlib-kind">
        <button :class="{ on: kindFilter === 'all' }" @click="kindFilter = 'all'">{{ t('全部') }}</button>
        <button :class="{ on: kindFilter === 'image' }" @click="kindFilter = 'image'">{{ t('静态') }}</button>
        <button :class="{ on: kindFilter === 'video' }" @click="kindFilter = 'video'">{{ t('动态') }}</button>
      </div>
    </div>

    <div class="wlib-sites">
      <span>{{ t('来源') }}</span>
      <button @click="openSite('https://wallhaven.cc/')">Wallhaven</button>
      <button @click="openSite('https://www.pexels.com/zh-cn/videos/')">Pexels</button>
      <button @click="openSite('https://pixabay.com/videos/')">Pixabay</button>
      <button @click="openSite('https://coverr.co/')">Coverr</button>
      <button @click="openSite('https://unsplash.com/')">Unsplash</button>
    </div>

    <div class="wlib-direct">
      <input v-model="directUrl" :placeholder="t('粘贴图片 / 视频直链，工具内下载')" @keydown.enter="useDirectUrl" />
      <button class="btn sm" :disabled="!!busy" @click="useDirectUrl">{{ t('下载并应用') }}</button>
    </div>

    <div v-if="source === 'local' && folderPaths.length" class="wlib-folders">
      <span v-for="d in folderPaths" :key="d" class="wlib-folder" :title="d">{{ d.split(/[\\/]/).pop() }}<button @click="removeFolder(d)"><Icon name="close" :size="10" /></button></span>
    </div>

    <div v-if="error" class="wlib-error">{{ error }}</div>
    <div v-if="loading" class="wlib-loading"><span class="spinner"></span>{{ t('正在加载…') }}</div>
    <div v-else-if="!shown.length" class="wlib-empty"><Icon name="wallpaper" :size="26" /><span>{{ t('这里还没有壁纸') }}</span></div>
    <div v-else class="wlib-grid">
      <button v-for="(it, i) in shown" :key="it.path || it.image || it.video || i" class="wlib-card" :class="{ busy: busy && busy === (it.id || it.name || 'wallpaper') }" @click="downloadAndApply(it)">
        <img v-if="thumbOf(it)" :src="thumbOf(it)" loading="lazy" alt="" />
        <span v-else class="wlib-ph"><Icon name="wallpaper" :size="22" /></span>
        <span class="wlib-badge">{{ kindOf(it) === 'image' ? t('静态') : t('动态') }}</span>
        <span v-if="isCurrent(it)" class="wlib-current"><Icon name="check" :size="12" /></span>
        <span class="wlib-name">{{ it.name }}</span>
      </button>
    </div>
    <div v-if="source === 'online' && online.length" class="wlib-more">
      <button class="btn sm ghost" :disabled="loading || page >= lastPage" @click="searchOnline(true)">{{ page >= lastPage ? t('没有更多了') : t('加载更多') }}</button>
    </div>
  </div>
</template>

<style scoped>
.wlib { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.wlib-top { display: flex; align-items: center; gap: var(--sp-2); }
.wlib-src { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--hairline); border-radius: var(--r-pill); background: var(--surface-soft); }
.wlib-src button { border: 0; background: transparent; color: var(--text3); border-radius: var(--r-pill); padding: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); cursor: pointer; }
.wlib-src button.on { background: color-mix(in srgb, var(--accent-sapphire) 22%, var(--surface)); color: var(--text); }
.wlib-state { margin-left: auto; color: var(--text3); font-size: var(--fs-xs); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wlib-tools { display: flex; align-items: center; gap: var(--sp-2); min-height: 26px; }
.wlib-search { flex: 1; display: flex; align-items: center; gap: var(--sp-1); padding: 2px var(--sp-2); border: 1px solid var(--hairline); border-radius: var(--r-pill); background: var(--surface-soft); color: var(--text3); }
.wlib-search input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); outline: none; font-size: var(--fs-xs); }
.wlib-search button { border: 0; background: transparent; color: var(--text3); cursor: pointer; padding: 0; }
.wlib-hint { color: var(--text3); font-size: var(--fs-xs); }
.wlib-grow { flex: 1; }
.wlib-kind { display: flex; gap: var(--sp-1); }
.wlib-kind button { border: 1px solid var(--hairline); background: transparent; color: var(--text3); border-radius: var(--r-pill); padding: 2px var(--sp-2); font-size: var(--fs-xs); cursor: pointer; }
.wlib-kind button.on { color: var(--text); border-color: color-mix(in srgb, var(--accent-sky) 35%, var(--hairline)); }
.wlib-sites { display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; color: var(--text3); font-size: var(--fs-xs); }
.wlib-sites button { border: 0; background: transparent; color: var(--accent-sky); cursor: pointer; padding: 0 var(--sp-1); font-size: var(--fs-xs); }
.wlib-direct { display: flex; gap: var(--sp-2); }
.wlib-direct input { flex: 1; min-width: 0; border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--surface-soft); color: var(--text); padding: var(--sp-1) var(--sp-2); font-size: var(--fs-xs); }
.wlib-folders { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
.wlib-folder { display: inline-flex; align-items: center; gap: var(--sp-1); border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 1px var(--sp-2); color: var(--text2); font-size: var(--fs-xs); }
.wlib-folder button { border: 0; background: transparent; color: var(--text3); cursor: pointer; padding: 0; display: grid; place-items: center; }
.wlib-error { color: var(--t-err); font-size: var(--fs-xs); }
.wlib-loading, .wlib-empty { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); min-height: 100px; color: var(--text3); font-size: var(--fs-xs); }
.wlib-empty { flex-direction: column; }
.wlib-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); max-height: 260px; overflow-y: auto; padding: 1px; }
@media (max-width: 620px) { .wlib-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.wlib-card { position: relative; aspect-ratio: 16/10; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--surface-soft); padding: 0; cursor: pointer; }
.wlib-card:hover { border-color: var(--accent-sky); }
.wlib-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wlib-ph { width: 100%; height: 100%; display: grid; place-items: center; color: var(--text3); }
.wlib-badge { position: absolute; left: var(--sp-1); top: var(--sp-1); padding: 1px var(--sp-1); border-radius: var(--r-xs); background: color-mix(in srgb, var(--canvas) 70%, transparent); color: var(--text2); font-size: var(--fs-xs); }
.wlib-current { position: absolute; right: var(--sp-1); top: var(--sp-1); color: var(--accent-sky); }
.wlib-name { position: absolute; left: 0; right: 0; bottom: 0; padding: 2px var(--sp-1); background: color-mix(in srgb, var(--canvas) 72%, transparent); color: var(--text2); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.wlib-more { display: flex; justify-content: center; }
</style>
<script setup>
// 壁纸库：从 GitHub Media 仓库获取壁纸缩略图列表，点击缩略图下载并应用
import { ref, onMounted } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { useSettingsStore } from '../stores/settings';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const settingsStore = useSettingsStore();
const toast = (m, type) => app.toast(m, type);
const bridge = window.fuBridge;
const list = ref([]);
const loading = ref(true);
const error = ref('');
const busyIdx = ref(-1);
const progress = ref(0);
const importing = ref(false);
const importProgress = ref(0);

function closeWallpaperGallery() { state.ui.wallpaperOpen = false; }
async function setWallpaperPath(path) {
  // 先乐观更新本地设置，立即触发 App 动态壁纸加载，再持久化
  settingsStore.setLocal({ custom_wallpaper: path, wallpaper_enabled: true });
  try { await settingsStore.save({ custom_wallpaper: path, wallpaper_enabled: true }); } catch (e) {}
}

async function load() {
  loading.value = true; error.value = '';
  try {
    if (!bridge || !bridge.wallpaper || !bridge.wallpaper.list) throw new Error('no bridge');
    const r = await bridge.wallpaper.list();
    if (r && r.ok && Array.isArray(r.list)) {
      list.value = r.list.filter(x => x && x.video);
      if (!list.value.length) error.value = t('壁纸库为空');
    } else {
      error.value = (r && r.error) || t('获取壁纸列表失败');
    }
  } catch (e) {
    error.value = String((e && e.message) || e);
  } finally { loading.value = false; }
}

async function pick(item, i) {
  if (busyIdx.value >= 0) return;
  busyIdx.value = i; progress.value = 0;
  try {
    toast(t('正在应用壁纸…'));
    // 远程壁纸直接使用远程视频流，不再阻塞等待完整下载
    let finalPath = item.video;
    if (!item.local && item.video && /^https?:/.test(item.video)) {
      // 后台尝试缓存副本；不阻塞 UI，失败也不影响应用远程流
      try {
        bridge.wallpaper.download(item.video, item.name).then((r) => {
          if (r && r.ok && r.path) {
            toast(t('壁纸已缓存到本地'), 'ok');
          }
        }).catch(() => {});
      } catch (e) {}
    }
    await setWallpaperPath(finalPath);
    toast(t('壁纸已应用'), 'ok');
    closeWallpaperGallery();
  } catch (e) {
    toast(t('应用失败：') + String((e && e.message) || e), 'error');
  } finally { busyIdx.value = -1; }
}

async function addLocalWallpaper(p) {
  if (!bridge || !bridge.wallpaper || !bridge.wallpaper.addLocal) {
    // 老版本 IPC 回退：直接以原路径应用
    await setWallpaperPath(p);
    return;
  }
  const r = await bridge.wallpaper.addLocal(p);
  if (!r || !r.ok || !r.path) {
    toast(t('导入失败：') + String((r && r.error) || 'unknown'), 'error');
    throw new Error('addLocal failed');
  }
  await setWallpaperPath(r.path);
}

async function localImport() {
  if (!bridge || !bridge.pickFile || importing.value) return;
  const p = await bridge.pickFile({ filters: [{ name: t('视频'), extensions: ['mp4', 'webm', 'mov'] }] });
  if (!p) return;
  importing.value = true;
  importProgress.value = 0;
  let unsubscribe = null;
  try {
    if (bridge.wallpaper && bridge.wallpaper.onAddLocalProgress) {
      unsubscribe = bridge.wallpaper.onAddLocalProgress((ev) => {
        if (ev && typeof ev.progress === 'number') importProgress.value = ev.progress;
      });
    }
    await addLocalWallpaper(p);
    toast(t('已导入本地壁纸'), 'ok');
    closeWallpaperGallery();
  } catch (e) {
    toast(t('导入失败：') + String((e && e.message) || e), 'error');
  } finally {
    if (unsubscribe) unsubscribe();
    importing.value = false;
  }
}

async function removeLocalItem(item, i) {
  try {
    if (!bridge || !bridge.wallpaper || !bridge.wallpaper.removeLocal) {
      toast(t('删除失败：') + t('当前环境不支持删除壁纸'), 'error');
      return;
    }
    const r = await bridge.wallpaper.removeLocal(item.name || item.video);
    if (!r || !r.ok) {
      toast(t('删除失败：') + String((r && r.error) || 'unknown'), 'error');
      return;
    }
    list.value.splice(i, 1);
    const cfg = await settingsStore.load();
    if (cfg.custom_wallpaper === item.video) {
      await settingsStore.save({ wallpaper_enabled: false, custom_wallpaper: '' });
    }
    toast(t('已删除壁纸'), 'ok');
  } catch (e) {
    toast(t('删除失败：') + String((e && e.message) || e), 'error');
  }
}

onMounted(load);
</script>

<template>
  <div class="overlay" v-focus-trap role="dialog" aria-modal="true" :aria-label="t('壁纸库')" aria-describedby="wp-gallery-note" @click.self="closeWallpaperGallery" @keydown.esc="closeWallpaperGallery">
    <div class="overlay-card wp-gallery">
      <div class="settings-head">
        <Icon name="wallpaper" :size="17" />
        <span class="settings-title">{{ t('壁纸库') }}</span>
        <button class="icon-btn" style="margin-left:auto;width:30px;height:30px" :title="t('关闭')" aria-label="t('关闭')" @click="closeWallpaperGallery">
          <Icon name="close" :size="15" />
        </button>
      </div>
      <p id="wp-gallery-note" class="ov-note">{{ t('从 GitHub 下载壁纸，点击缩略图即可下载并应用；每次下载一张，需要更多可再次进入。') }}</p>

      <div v-if="loading" class="wp-loading"><span class="spinner"></span>{{ t('正在加载壁纸列表…') }}</div>
      <div v-else-if="error" class="wp-error">
        <p>{{ error }}</p>
        <button class="btn sm" @click="load">{{ t('重试') }}</button>
      </div>
      <div v-else-if="list.length" class="wp-grid">
        <button class="wp-card" v-for="(item, i) in list" :key="item.name"
                :class="{ busy: busyIdx === i }" @click="pick(item, i)" :disabled="busyIdx >= 0">
          <img v-if="item.thumb" :src="item.thumb" loading="lazy" alt="" />
          <div class="wp-card-ph" v-else><Icon name="wallpaper" :size="26" /></div>
          <div class="wp-card-mask" v-if="busyIdx === i">
            <span class="spinner"></span>
            <b>{{ Math.round(progress) }}%</b>
          </div>
          <div class="wp-card-dl" v-else><Icon name="download" :size="16" /></div>
          <button v-if="item.local" class="wp-card-del" :title="t('删除壁纸')" aria-label="t('删除壁纸')" @click.stop="removeLocalItem(item, i)">
            <Icon name="trash" :size="13" />
          </button>
        </button>
      </div>

            <div v-if="importing" class="wp-import-progress">
        <div class="wp-import-bar"><div class="pfill" :style="{ width: (importProgress * 100) + '%' }"></div></div>
        <span>{{ Math.round(importProgress * 100) }}%</span>
      </div>
<div class="wp-foot">
        <button class="btn sm ghost" @click="localImport"><Icon name="import" :size="13" /> {{ t('导入本地视频') }}</button>
        <span class="muted small">{{ t('缩略图来自 GitHub Media 仓库') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wp-gallery { width: 640px; max-width: 92vw; }
.wp-loading, .wp-error { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 46px 0; color: var(--stone); font-size: 13px; flex-direction: column; }
.wp-error button { margin-top: 4px; }
.wp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; max-height: 46vh; overflow-y: auto; padding: 2px; }
@media (max-width: 560px) { .wp-grid { grid-template-columns: repeat(2, 1fr); } }
.wp-card {
  position: relative;
  aspect-ratio: 16 / 9;
  border: 1px solid var(--hairline);
  border-radius: 12px;
  overflow: hidden;
  padding: 0;
  cursor: pointer;
  background: var(--surface-soft);
  transition: transform 0.15s, border-color 0.15s, box-shadow 0.18s;
}
.wp-card:hover { transform: translateY(-2px); border-color: var(--border-strong); box-shadow: var(--shadow); }
.wp-card:active { transform: scale(0.98); }
.wp-card:disabled { cursor: wait; }
.wp-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wp-card-ph { width: 100%; height: 100%; display: grid; place-items: center; color: var(--stone); }
.wp-card-del {
  position: absolute; left: 8px; bottom: 8px;
  width: 26px; height: 26px; border-radius: 50%;
  border: none; cursor: pointer;
  background: rgba(0,0,0,.45); color: #fff;
  display: grid; place-items: center;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  opacity: 0; transition: opacity 0.15s;
}
.wp-card:hover .wp-card-del { opacity: 1; }
.wp-card-del:hover { background: rgba(200, 40, 40, .75); }
.wp-card-dl {
  position: absolute; right: 8px; bottom: 8px;
  width: 30px; height: 30px; border-radius: 50%;
  background: rgba(0,0,0,.45); color: #fff;
  display: grid; place-items: center;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  opacity: 0; transition: opacity 0.15s;
}
.wp-card:hover .wp-card-dl { opacity: 1; }
.wp-card-mask {
  position: absolute; inset: 0;
  background: rgba(10, 10, 10, 0.55);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  color: #fff; font-size: 12px;
}
.wp-card-mask .spinner { border-color: rgba(255,255,255,0.35); border-top-color: #fff; }
.spinner {
  width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid rgba(10, 10, 10, 0.14); border-top-color: var(--accent);
  animation: wp-spin 0.7s linear infinite;
}
@keyframes wp-spin { to { transform: rotate(360deg); } }
.wp-import-progress { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 4px 0; }
.wp-import-progress .wp-import-bar { flex: 1; height: 6px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; }
.wp-import-progress .pfill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.12s linear; }
.wp-import-progress span { font-size: 11px; color: var(--stone); min-width: 40px; text-align: right; }
.wp-foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--hairline-soft); }
.wp-foot .muted { margin-left: auto; font-size: 10.5px; }
</style>

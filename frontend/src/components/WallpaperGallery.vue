<script setup>
// 壁纸库：从 GitHub Media 仓库获取壁纸缩略图列表，点击缩略图下载并应用
// 设计：只显示缩略图（不显示名称），每次下载一张，需要更多可再次进入选择
import { ref, onMounted } from 'vue';
import Icon from './Icon.vue';
import { addWallpaperSource, closeWallpaperGallery, toast, setWallpaperEnabled } from '../store.js';
import { t } from '../core/i18n.js';

const bridge = window.fuBridge;
const list = ref([]);
const loading = ref(true);
const error = ref('');
const busyIdx = ref(-1);
const progress = ref(0);

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
    toast(t('正在下载壁纸…'));
    const r = await bridge.wallpaper.download(item.video, item.name);
    if (r && r.ok && r.path) {
      addWallpaperSource(r.path, true);
      setWallpaperEnabled(true);
      toast(t('壁纸已下载并应用'), 'ok');
      closeWallpaperGallery();
    } else {
      toast(t('下载失败：') + ((r && r.error) || ''), 'error');
    }
  } catch (e) {
    toast(t('下载失败：') + String((e && e.message) || e), 'error');
  } finally { busyIdx.value = -1; }
}

function localImport() {
  if (bridge && bridge.pickFile) {
    bridge.pickFile({ filters: [{ name: '视频', extensions: ['mp4', 'webm', 'mov'] }] })
      .then(p => {
        if (!p) return;
        addWallpaperSource(p, true);
        setWallpaperEnabled(true);
        toast(t('已导入本地壁纸'), 'ok');
        closeWallpaperGallery();
      }).catch(() => {});
  }
}

onMounted(load);
</script>

<template>
  <div class="overlay" @click.self="closeWallpaperGallery">
    <div class="overlay-card wp-gallery">
      <div class="settings-head">
        <Icon name="wallpaper" :size="17" />
        <span class="settings-title">{{ t('壁纸库') }}</span>
        <button class="icon-btn" style="margin-left:auto;width:30px;height:30px" :title="t('关闭')" @click="closeWallpaperGallery">
          <Icon name="close" :size="15" />
        </button>
      </div>
      <p class="ov-note">{{ t('从 GitHub 下载壁纸，点击缩略图即可下载并应用；每次下载一张，需要更多可再次进入。') }}</p>

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
        </button>
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
.wp-card-dl {
  position: absolute; right: 8px; bottom: 8px;
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--glass-dark); color: #fff;
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
  border: 2px solid rgba(10, 10, 10, 0.14); border-top-color: var(--brand-blue);
  animation: wp-spin 0.7s linear infinite;
}
@keyframes wp-spin { to { transform: rotate(360deg); } }
.wp-foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--hairline-soft); }
.wp-foot .muted { margin-left: auto; font-size: 10.5px; }
</style>

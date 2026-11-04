// 3D 钢琴独立页（2026-11-04 用户要求：从可视化里独立出来，不再作为 viz 的一个模式）。
// 复用 Piano3D 组件；这里只负责页面外壳：曲目上下文、全屏、返回可视化入口。
<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import Piano3D from '../components/viz/Piano3D.vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
// ★ Piano3D 的 prop 约定是「曲目包装对象」（内部读 props.song.song），
//   不是裸 song —— 传错会一直显示"载入一首 MIDI"（2026-11-04 截图实测）。
const current = computed(() => app.currentSong || null);
const songName = computed(() => (current.value && current.value.name) || t('未选择曲目'));
const full = ref(false);
function onFullscreenChange() { full.value = !!document.fullscreenElement; }
onMounted(() => { try { document.addEventListener('fullscreenchange', onFullscreenChange); } catch (e) {} });
onBeforeUnmount(() => { try { document.removeEventListener('fullscreenchange', onFullscreenChange); } catch (e) {} });

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) { document.exitFullscreen(); full.value = false; return; }
    const el = document.querySelector('.piano3d-page');
    if (el && el.requestFullscreen) { el.requestFullscreen().then(() => { full.value = true; }).catch(() => {}); return; }
  } catch (e) { /* fallthrough */ }
  app.toast(t('全屏不可用'), 'warn');
}
function openViz() { app.setView('viz'); }
</script>

<template>
  <div class="page piano3d-page" :class="{ 'is-full': full }">
    <div class="p3d-head">
      <span class="p3d-ic"><Icon name="expand" :size="20" /></span>
      <div>
        <div class="page-title">{{ t('3D 钢琴') }}</div>
        <div class="page-sub">{{ t('自由演奏 / 音游 / 键位与录音，独立页面') }}</div>
      </div>
      <div class="p3d-page-actions">
        <span class="piano-song" :title="songName">{{ songName }}</span>
        <button class="btn sm ghost" data-guide="piano3d-to-viz" @click="openViz"><Icon name="viz" :size="13" /> {{ t('打开可视化') }}</button>
        <button class="btn sm" data-guide="piano3d-fullscreen" @click="toggleFullscreen"><Icon name="expand" :size="13" /> {{ t('全屏') }}</button>
      </div>
    </div>
    <div class="piano3d-shell">
      <Piano3D :song="current" />
    </div>
  </div>
</template>

<style scoped>
.piano3d-page { display: flex; flex-direction: column; gap: var(--sp-3); height: 100%; min-height: 0; padding: 12px 14px 10px; }
/* 全局已把 .page-head 隐藏（品牌规范：页面标题贴片退出界面），这里用本页自己的头部 */
.p3d-head { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; flex: none; }
.p3d-ic { width: 36px; height: 36px; flex: none; border-radius: var(--r-md); display: grid; place-items: center;
  color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sky) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-sky) 24%, var(--hairline)); }
.p3d-page-actions { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; flex-wrap: wrap; }
.piano-song { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text3); font-size: var(--fs-sm); }
.piano3d-shell { flex: 1 1 auto; min-height: 0; border: 1px solid var(--hairline); border-radius: var(--r-lg); overflow: hidden; background: var(--panel); }
.piano3d-page.is-full { background: var(--canvas); padding: 8px; }
.piano3d-page.is-full .piano3d-shell { border-radius: 0; }
</style>

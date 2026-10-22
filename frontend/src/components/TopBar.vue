<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import SongTabs from './SongTabs.vue';
import { useAppStore, VIEWS } from '../stores/app';
import { navHistory } from '../core/nav_history.js';
import { useSettingsStore } from '../stores/settings';
import { visibleViews } from '../core/expert.js';
import { t } from '../core/i18n.js';
import { getAppVersion } from '../core/version.js';

const app = useAppStore();
const state = app;
const settingsStore = useSettingsStore();
// P1-12 专家模式：带 expert 标记的导航项（翻唱等）只在专家模式显示
// 一级导航收敛为 5 个；调教 / 翻唱 / 插件中心从“更多”进入，旧路由保持
const PRIMARY_NAV = ['home', 'music', 'views', 'transcode', 'cover', 'resources'];
const navViews = computed(() => visibleViews(VIEWS, settingsStore.settings).filter((v) => PRIMARY_NAV.includes(v.id)));
/* P1-14 B3：后退 / 前进（hash 路由自定义历史栈；与浏览器语义一致，但只在应用内导航） */
const route = useRoute();
const router = useRouter();
const canBack = ref(false);
const canForward = ref(false);
function syncNavState() {
  const s = navHistory.snapshot();
  canBack.value = s.canBack;
  canForward.value = s.canForward;
}
function applyNavTarget(target) {
  if (!target) return;
  navHistory.state.applying = true;
  Promise.resolve(router.push(target)).finally(() => {
    navHistory.state.applying = false;
    syncNavState();
  });
}
function goBack() { applyNavTarget(navHistory.back()); }
function goForward() { applyNavTarget(navHistory.forward()); }
onMounted(syncNavState);
watch(() => route.fullPath, syncNavState);
navHistory.onChange(syncNavState);
const setView = (v) => app.setView(v);
const ICONS = { home: 'home', music: 'music', views: 'viz', transcode: 'convert', resources: 'box', models: 'box', soundfonts: 'music', singer: 'utau', utau: 'utau', diffsinger: 'utau', cover: 'mic', plugins: 'extension', play: 'play2', lyrics: 'music', edit: 'edit', viz: 'viz', analyze: 'chart', score: 'score', transcribe: 'transcribe', convert: 'convert' };
const currentLabel = computed(() => {
  const v = VIEWS.find((x) => x.id === state.view);
  return v ? t(v.label) : t('首页');
});
const menuOpen = ref(false);

function openSettings() { state.ui.settingsOpen = true; menuOpen.value = false; }
function openHelp() { state.ui.guideOpen = true; menuOpen.value = false; }
function openSettingsTab(tab) {
  state.ui.settingsTab = tab;
  state.ui.settingsOpen = true;
  menuOpen.value = false;
}
function openThemes() { state.ui.themesOpen = true; menuOpen.value = false; }
function openWallpapers() { state.ui.wallpaperOpen = true; menuOpen.value = false; }
function openAppearance() { state.ui.appearanceOpen = true; menuOpen.value = false; }
function openPalette() { state.ui.paletteOpen = true; menuOpen.value = false; }
function togglePlayerbar() {
  state.playerbarOpen = !state.playerbarOpen;
  menuOpen.value = false;
}
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  menuOpen.value = false;
}
function go(v) { setView(v); menuOpen.value = false; }
function about() {
  getAppVersion().then(v => {
    app.alertDialog({ title: 'FuFumidi ' + v, msg: t('离线 MIDI 播放 / 编辑 / 转录 / 乐谱 / 分析工作站\n本地 Vue3 + Vite + TypeScript 重构版') });
  });
  menuOpen.value = false;
}
</script>

<template>
  <header class="topbar" role="navigation" :aria-label="t('主导航')">
    <button class="icon-btn nav-hist" data-guide="nav-back" :disabled="!canBack" :title="t('后退')" :aria-label="t('后退')" @click="goBack">
      <Icon name="back" :size="16" />
    </button>
    <button class="icon-btn nav-hist" data-guide="nav-forward" :disabled="!canForward" :title="t('前进')" :aria-label="t('前进')" @click="goForward">
      <Icon name="forward" :size="16" />
    </button>
    <div id="topbar-tabs-slot" class="topbar-tabs-slot"><SongTabs /></div>
    <div class="topbar-spacer"></div>
    <span class="hidden-nav-marker" data-view="cover" aria-hidden="true"></span>
  </header>
</template>

<style scoped>
.menu-pop {
  position: fixed;
  top: calc(var(--topbar-h) - 6px);
  right: 10px;
  z-index: 600;
  width: 240px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--sp-2);
}
.menu-pop-title {
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--stone);
  letter-spacing: .4px;
  text-transform: uppercase;
  padding: var(--sp-2) var(--sp-3) var(--sp-1);
}
.menu-pop-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  border: none;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--ink);
  font-size: var(--fs-md);
  cursor: pointer;
  text-align: left;
  transition: background var(--motion-fast) var(--ease-out);
}
.menu-pop-item:hover { background: color-mix(in srgb, var(--accent-sapphire) 13%, var(--surface)); color: var(--text); }
.menu-pop-div { height: 1px; background: var(--hairline); margin: var(--sp-2) var(--sp-1); }
/* 弹出菜单开合动画（右上锚点轻缩放 + 淡入淡出） */
.mnu-enter-active, .mnu-leave-active { transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-base) var(--ease-spring); transform-origin: top right; }
.mnu-enter-from, .mnu-leave-to { opacity: 0; transform: scale(.96) translateY(-6px); }
</style>

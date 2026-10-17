<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
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
const navViews = computed(() => visibleViews(VIEWS, settingsStore.settings));
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
    <button class="icon-btn" :title="t('折叠 / 展开侧边栏')" :aria-label="t('折叠 / 展开侧边栏')" @click="toggleSidebar">
      <Icon name="panel" :size="17" />
    </button>
    <button class="icon-btn nav-hist" data-guide="nav-back" :disabled="!canBack" :title="t('后退')" :aria-label="t('后退')" @click="goBack">
      <Icon name="back" :size="16" />
    </button>
    <button class="icon-btn nav-hist" data-guide="nav-forward" :disabled="!canForward" :title="t('前进')" :aria-label="t('前进')" @click="goForward">
      <Icon name="forward" :size="16" />
    </button>
    <div class="tab" v-for="v in navViews" :key="v.id" :class="{ active: state.view === v.id }" :aria-current="state.view === v.id ? 'page' : null" :data-view="v.id"
         :title="v.hint ? t(v.hint) : null" @click="setView(v.id)">
      <Icon :name="ICONS[v.id]" :size="14" />
      {{ t(v.label) }}
    </div>
    <div class="topbar-spacer"></div>
    <span class="tag" v-if="state.songs.length && state.currentId">
      <Icon name="music" :size="12" /> {{ state.songs.find(s => s.id === state.currentId)?.name }}
    </span>
    <button class="icon-btn" :class="{ active: state.playerbarOpen }" :title="t('隐藏 / 显示底部播放栏')" :aria-label="t('隐藏 / 显示底部播放栏')" @click="togglePlayerbar">
      <Icon name="player" :size="16" />
    </button>
    <button class="icon-btn" data-guide="topbar-wallpaper" :title="t('动态壁纸')" :aria-label="t('动态壁纸')" @click="openWallpapers">
      <Icon name="wallpaper" :size="16" />
    </button>
    <button class="icon-btn" data-guide="topbar-help" :title="t('帮助')" :aria-label="t('帮助')" @click="openHelp">
      <Icon name="info" :size="17" />
    </button>
    <button class="icon-btn" data-guide="topbar-settings" :title="t('设置')" :aria-label="t('设置')" @click="openSettings">
      <Icon name="gear" :size="17" />
    </button>
    <button class="icon-btn" data-guide="topbar-more" :title="t('更多')" :aria-label="t('更多')" @click="menuOpen = !menuOpen">
      <Icon name="menu" :size="17" />
    </button>

    <Teleport to="body">
    <Transition name="mnu">
    <div v-if="menuOpen" class="menu-pop" @click.self="menuOpen = false">
      <div class="menu-pop-title">{{ t('快速跳转') }}</div>
      <button class="menu-pop-item" @click="go('transcribe')"><Icon name="transcribe" :size="14" /> {{ t('音频转 MIDI（转录）') }}</button>
      <button class="menu-pop-item" @click="go('convert')"><Icon name="convert" :size="14" /> {{ t('格式转换 / 导出音频') }}</button>
      <button class="menu-pop-item" @click="go('viz')"><Icon name="viz" :size="14" /> {{ t('可视化分析') }}</button>
      <button class="menu-pop-item" @click="go('analyze')"><Icon name="chart" :size="14" /> {{ t('MIDI 分析器') }}</button>
      <button class="menu-pop-item" @click="go('score')"><Icon name="score" :size="14" /> {{ t('乐谱视图') }}</button>
      <div class="menu-pop-div"></div>
      <button class="menu-pop-item" @click="openHelp"><Icon name="palette" :size="14" /> {{ t('新手引导 / 帮助') }}</button>
      <button class="menu-pop-item" @click="togglePlayerbar"><Icon name="menu" :size="14" /> {{ state.playerbarOpen ? t('隐藏播放栏') : t('显示播放栏') }}</button>
      <button class="menu-pop-item" @click="toggleSidebar"><Icon name="menu" :size="14" /> {{ t('切换侧边栏') }}</button>
      <div class="menu-pop-div"></div>
      <div class="menu-pop-title">{{ t('设置') }}</div>
      <button class="menu-pop-item" @click="openSettingsTab('appearance')"><Icon name="gear" :size="14" /> {{ t('应用设置') }}</button>
      <button class="menu-pop-item" @click="openThemes"><Icon name="palette" :size="14" /> {{ t('主题库') }}</button>
      <button class="menu-pop-item" @click="openWallpapers"><Icon name="wallpaper" :size="14" /> {{ t('动态壁纸') }}</button>
      <button class="menu-pop-item" @click="openPalette"><Icon name="kbd" :size="14" /> {{ t('命令面板') }}</button>
      <button class="menu-pop-item" @click="openSettingsTab('keys')"><Icon name="kbd" :size="14" /> {{ t('快捷键') }}</button>
      <div class="menu-pop-div"></div>
      <div class="menu-pop-title">{{ t('帮助') }}</div>
      <button class="menu-pop-item" @click="about"><Icon name="info" :size="14" /> {{ t('关于本工具') }}</button>
    </div>
    </Transition>
    </Teleport>
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
.menu-pop-item:hover { background: var(--surface-soft); }
.menu-pop-div { height: 1px; background: var(--hairline); margin: var(--sp-2) var(--sp-1); }
/* 弹出菜单开合动画（右上锚点轻缩放 + 淡入淡出） */
.mnu-enter-active, .mnu-leave-active { transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-base) var(--ease-spring); transform-origin: top right; }
.mnu-enter-from, .mnu-leave-to { opacity: 0; transform: scale(.96) translateY(-6px); }
</style>

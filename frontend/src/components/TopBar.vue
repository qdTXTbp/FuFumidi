<script setup>
import { ref } from 'vue';
import Icon from './Icon.vue';
import { useAppStore, VIEWS } from '../stores/app';
import { t } from '../core/i18n.js';
import { getAppVersion } from '../core/version.js';

const app = useAppStore();
const state = app;
const setView = (v) => app.setView(v);
const ICONS = { home: 'home', play: 'play2', lyrics: 'music', edit: 'edit', viz: 'viz', analyze: 'chart', score: 'score', transcribe: 'transcribe', convert: 'convert', resources: 'box' };
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
    window.alert('FuFumidi ' + v + '\n' + t('离线 MIDI 播放 / 编辑 / 转录 / 乐谱 / 分析工作站\n本地 Vue3 + Vite + TypeScript 重构版'));
  });
  menuOpen.value = false;
}
</script>

<template>
  <header class="topbar" role="navigation" aria-label="t('主导航')">
    <button class="icon-btn" :title="t('折叠 / 展开侧边栏')" aria-label="t('折叠 / 展开侧边栏')" @click="toggleSidebar">
      <Icon name="panel" :size="17" />
    </button>
    <div class="tab" v-for="v in VIEWS" :key="v.id" :class="{ active: state.view === v.id }" :aria-current="state.view === v.id ? 'page' : null" :data-view="v.id" @click="setView(v.id)">
      <Icon :name="ICONS[v.id]" :size="14" />
      {{ t(v.label) }}
    </div>
    <div class="topbar-spacer"></div>
    <span class="tag" v-if="state.songs.length && state.currentId">
      <Icon name="music" :size="12" /> {{ state.songs.find(s => s.id === state.currentId)?.name }}
    </span>
    <button class="icon-btn" :class="{ active: state.playerbarOpen }" :title="t('隐藏 / 显示底部播放栏')" aria-label="t('隐藏 / 显示底部播放栏')" @click="togglePlayerbar">
      <Icon name="player" :size="16" />
    </button>
    <button class="icon-btn" :title="t('动态壁纸')" aria-label="t('动态壁纸')" @click="openWallpapers">
      <Icon name="wallpaper" :size="16" />
    </button>
    <button class="icon-btn" :title="t('帮助')" aria-label="t('帮助')" @click="openHelp">
      <Icon name="info" :size="17" />
    </button>
    <button class="icon-btn" :title="t('设置')" aria-label="t('设置')" @click="openSettings">
      <Icon name="gear" :size="17" />
    </button>
    <button class="icon-btn" :title="t('更多')" aria-label="t('更多')" @click="menuOpen = !menuOpen">
      <Icon name="menu" :size="17" />
    </button>

    <Teleport to="body">
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
      <div class="menu-pop-title">设置</div>
      <button class="menu-pop-item" @click="openSettingsTab('appearance')"><Icon name="gear" :size="14" /> {{ t('应用设置') }}</button>
      <button class="menu-pop-item" @click="openThemes"><Icon name="palette" :size="14" /> {{ t('主题库') }}</button>
      <button class="menu-pop-item" @click="openWallpapers"><Icon name="wallpaper" :size="14" /> {{ t('动态壁纸') }}</button>
      <button class="menu-pop-item" @click="openPalette"><Icon name="kbd" :size="14" /> {{ t('命令面板') }}</button>
      <button class="menu-pop-item" @click="openSettingsTab('keys')"><Icon name="kbd" :size="14" /> {{ t('快捷键') }}</button>
      <div class="menu-pop-div"></div>
      <div class="menu-pop-title">帮助</div>
      <button class="menu-pop-item" @click="about"><Icon name="info" :size="14" /> {{ t('关于本工具') }}</button>
    </div>
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
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  padding: 8px;
}
.menu-pop-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--stone);
  letter-spacing: .4px;
  text-transform: uppercase;
  padding: 8px 10px 4px;
}
.menu-pop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--ink);
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
  transition: background .12s;
}
.menu-pop-item:hover { background: var(--surface-soft); }
.menu-pop-div { height: 1px; background: var(--hairline); margin: 6px 4px; }
</style>

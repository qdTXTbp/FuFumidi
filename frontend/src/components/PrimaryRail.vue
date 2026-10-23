<script setup>
// 一级导航轨道：与视觉验证稿一致的五入口（首页 / 曲库 / 工作台 / 创作 / 资源）。
// 只做导航；调教 / 翻唱 / 插件中心仍可从顶栏“更多”或创作入口进入。
import { computed } from 'vue';
import Icon from './Icon.vue';
import logoUrl from '../assets/logo.png';
import { useAppStore, viewParentOf } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const active = computed(() => viewParentOf(state.view));
const items = [
  { id: 'home', label: '首页', icon: 'home' },
  { id: 'music', label: '音乐', icon: 'music' },
  { id: 'views', label: '工作台', icon: 'viz' },
  { id: 'transcode', label: '创作', icon: 'convert' },
  { id: 'resources', label: '资源', icon: 'box' },
];
function go(id) { app.setView(id); }
function openPalette() { state.ui.paletteOpen = true; }
function openAppearance() { state.ui.appearanceOpen = true; }
function openSettings() { state.ui.settingsOpen = true; }
function openGuide() { state.ui.guideOpen = true; }
function toggleSidebar() { state.sidebarOpen = !state.sidebarOpen; }
function togglePlayerbar() { state.playerbarOpen = !state.playerbarOpen; }
</script>

<template>
  <nav class="primary-rail" :aria-label="t('主导航')">
    <button class="rail-logo" :title="t('首页')" :aria-label="t('首页')" @click="go('home')">
      <img :src="logoUrl" alt="FuFumidi" />
    </button>
    <div class="rail-items">
      <button v-for="it in items" :key="it.id" class="rail-item" :class="{ on: active === it.id }"
              :title="t(it.label)" :aria-label="t(it.label)" :aria-current="active === it.id ? 'page' : null" @click="go(it.id)">
        <Icon :name="it.icon" :size="20" />
        <span class="rail-label">{{ t(it.label) }}</span>
      </button>
    </div>
    <div class="rail-spacer"></div>
    <button class="rail-tool" :title="t('命令面板')" :aria-label="t('命令面板')" @click="openPalette"><Icon name="search" :size="18" /></button>
    <button class="rail-tool" data-guide="topbar-wallpaper" :title="t('外观')" :aria-label="t('外观')" @click="openAppearance"><Icon name="palette" :size="18" /></button>
    <button class="rail-tool" data-guide="topbar-help" :title="t('帮助')" :aria-label="t('帮助')" @click="openGuide"><Icon name="info" :size="18" /></button>
    <button class="rail-tool" data-guide="topbar-settings" :title="t('设置')" :aria-label="t('设置')" @click="openSettings"><Icon name="gear" :size="18" /></button>
    <button class="rail-tool" data-guide="rail-sidebar" :title="t('侧边栏')" :aria-label="t('侧边栏')" @click="toggleSidebar"><Icon name="panel" :size="18" /></button>
    <button class="rail-tool" data-guide="rail-player" :title="t('播放栏')" :aria-label="t('播放栏')" @click="togglePlayerbar"><Icon name="player" :size="18" /></button>
  </nav>
</template>

<style scoped>
.primary-rail { grid-area: rail; width: 64px; display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); padding: var(--sp-2) 0; border-right: 1px solid var(--hairline); background-color: color-mix(in srgb, var(--canvas) 72%, transparent); backdrop-filter: var(--glass-blur); position: relative; z-index: 8; }
.rail-logo { width: 38px; height: 38px; padding: 0; border-radius: var(--r-md); overflow: hidden; border: 1px solid color-mix(in srgb, var(--ornament) 55%, var(--hairline)); background: var(--surface); flex: none; margin-bottom: var(--sp-2); box-shadow: 0 6px 20px color-mix(in srgb, var(--canvas) 50%, transparent); }
.rail-logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rail-items { display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); width: 100%; }
.rail-item { position: relative; width: 44px; height: 42px; border-radius: var(--r-md); border: 1px solid transparent; background: transparent; color: var(--text3); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; cursor: pointer; transition: background var(--dur-1), color var(--dur-1), border-color var(--dur-1); }
.rail-item:hover { background: color-mix(in srgb, var(--accent-sky) 8%, var(--surface)); color: var(--text2); }
.rail-item.on { color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sapphire) 16%, transparent); border-color: color-mix(in srgb, var(--accent-sky) 24%, transparent); }
.rail-item.on::before { content: ""; position: absolute; left: -10px; top: 11px; bottom: 11px; width: 2px; border-radius: var(--r-pill); background: var(--accent-sky); }
.rail-label { font-size: var(--fs-xs); line-height: 1; white-space: nowrap; }
.rail-spacer { flex: 1; }
.rail-tool { width: 36px; height: 34px; border-radius: var(--r-sm); border: 1px solid transparent; background: transparent; color: var(--text3); display: grid; place-items: center; cursor: pointer; }
.rail-tool:hover { color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sapphire) 10%, var(--surface)); }
@media (max-width: 900px) { .rail-label { display: none; } }
</style>
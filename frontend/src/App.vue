<script setup>
import { onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute } from 'vue-router';
import Icon from './components/Icon.vue';
import SideBar from './components/SideBar.vue';
import TopBar from './components/TopBar.vue';
import PlayerBar from './components/PlayerBar.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ThemeLibrary from './components/ThemeLibrary.vue';
import WallpaperGallery from './components/WallpaperGallery.vue';
import CommandPalette from './components/CommandPalette.vue';
import GuideOverlay from './components/GuideOverlay.vue';
import { ref } from 'vue';
import { useAppStore, VIEWS } from './stores/app';
import { usePlaylistStore } from './stores/playlist';
import { useSettingsStore } from './stores/settings';
import { setLang, t } from './core/i18n.js';
import { applyTheme, loadTheme } from './core/theme.js';
import { viewFromPath } from './router';

const app = useAppStore();
const state = app;
const playlistStore = usePlaylistStore();
const settingsStore = useSettingsStore();
const wallpaperPromptOpen = ref(false);
const route = useRoute();

const wpUrl = ref('');
const wpEnabled = ref(false);
const bgVideo = ref(null);
// 动态壁纸无缝循环：原生 loop 在循环切换时有黑屏/卡顿，改为临近结尾提前 seek 到开头偏后位置（跳过首帧解码延迟与黑帧）
function onBgTime() {
  const v = bgVideo.value;
  if (!v || !v.duration || !isFinite(v.duration)) return;
  if (v.currentTime > v.duration - 0.4) v.currentTime = 0.35;
}
function wpFileUrl(p) {
  if (!p) return '';
  if (/^(https?:|file:|data:)/i.test(p)) return p;
  const norm = String(p).replace(/\\/g, '/');
  return 'file:///' + norm.replace(/^([A-Za-z]):/, '$1:');
}
async function loadWallpaper() {
  try {
    const s = await settingsStore.load();
    wpUrl.value = wpFileUrl(s.custom_wallpaper || '');
    wpEnabled.value = !!(s.wallpaper_enabled && s.custom_wallpaper);
  } catch (e) {}
}
watch(() => settingsStore.settings, () => {
  const s = settingsStore.settings;
  wpUrl.value = wpFileUrl(s.custom_wallpaper || '');
  wpEnabled.value = !!(s.wallpaper_enabled && s.custom_wallpaper);
}, { deep: true });
watch(() => route.path, (p) => {
  const v = viewFromPath(p);
  if (VIEWS.some(x => x.id === v)) state.view = v;
}, { immediate: true });
const startTickLoop = () => app.startTickLoop();
const stopTickLoop = () => app.stopTickLoop();
const restoreSongs = () => app.restoreSongs();
const togglePlay = () => app.togglePlay();
const seekRatio = (r) => app.seekRatio(r);
const setTempo = (v) => app.setTempo(v);
const toggleLoop = () => app.toggleLoop();
const toggleMetro = () => app.toggleMetro();

const bridge = window.fuBridge;

// 字号 / 密度即时应用
function applyDisplayPrefs(s) {
  const fsMap = { standard: '', large: '15px', xlarge: '17px' };
  document.body.style.fontSize = fsMap[s.font_size === 'large' || s.font_size === 'xlarge' ? s.font_size : 'standard'] || '';
  document.body.dataset.density = s.density === 'compact' ? 'compact' : 'comfortable';
}

// 启动初始化：主题（防闪烁）→ 语言/字号/密度（settings 兜底）→ 完整性检验 → 新手引导
async function initGlobal() {
  // 1) 主题：localStorage 同步读取先应用（防闪烁），settings 仅兜底
  const lt = loadTheme();
  applyTheme(lt.name, lt.accent);
  let s = {};
  if (bridge && bridge.getSettings) {
    try { s = await bridge.getSettings() || {}; } catch (e) {}
  }
  let hasLsTheme = false;
  try { hasLsTheme = localStorage.getItem('fufumidi_theme') != null; } catch (e) {}
  if (!hasLsTheme && s.theme) applyTheme(s.theme, s.accent || '');

  // 2) 语言 / 字号 / 密度（localStorage 优先，settings 兜底）
  let lang = 'zh', font = null, density = null;
  try {
    lang = localStorage.getItem('fufumidi_lang') || s.lang || 'zh';
    font = localStorage.getItem('fufumidi_font');
    density = localStorage.getItem('fufumidi_density');
  } catch (e) { lang = s.lang || 'zh'; }
  setLang(lang);
  applyDisplayPrefs({ font_size: font || s.font_size, density: density || s.density });

  // 3) 完整性检验（后台静默，由设置面板警告条展示 + 一键修复）
  if (bridge && bridge.checkIntegrity) {
    bridge.checkIntegrity().then(r => {
      state.integrity = { ok: !!(r && r.ok), issues: (r && r.issues) || [], error: (r && r.error) || '' };
    }).catch(() => { state.integrity = { ok: true, issues: [], error: '' }; });
  }

  // 4) 新手引导：首次启动展示
  let guideDone = false;
  try { guideDone = !!localStorage.getItem('fufumidi_guide_done'); } catch (e) {}
  if (!guideDone && !s.guide_done) state.ui.guideOpen = true;

  // 5) 首次启动壁纸询问（仅一次，未设置壁纸时）
  if (!s.wallpaper_prompt_done && !s.custom_wallpaper) {
    setTimeout(() => {
      if (!settingsStore.settings.custom_wallpaper && !state.ui.wallpaperOpen) wallpaperPromptOpen.value = true;
    }, 1200);
  }
}

function goDownloadWallpaper() {
  wallpaperPromptOpen.value = false;
  state.ui.wallpaperOpen = true;
  settingsStore.save({ wallpaper_prompt_done: true }).catch(() => {});
}
function dismissWallpaperPrompt() {
  wallpaperPromptOpen.value = false;
  settingsStore.save({ wallpaper_prompt_done: true }).catch(() => {});
}

function onKey(e) {
  // 全局系统快捷键（优先于输入框拦截：Ctrl+K 命令面板、Esc 关闭浮层）
  if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    state.ui.paletteOpen = !state.ui.paletteOpen;
    return;
  }
  if (e.key === 'Escape') {
    if (state.ui.paletteOpen || state.ui.settingsOpen || state.ui.themesOpen || state.ui.guideOpen) {
      state.ui.paletteOpen = false;
      state.ui.settingsOpen = false;
      state.ui.themesOpen = false;
      state.ui.guideOpen = false;
      return;
    }
  }
  // F1 帮助 / 新手引导（即使焦点在输入框也优先响应）
  if (e.key === 'F1') { e.preventDefault(); state.ui.guideOpen = true; return; }
  // Ctrl+1..9 快速切换视图
  if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    const v = VIEWS[parseInt(e.key, 10) - 1];
    if (v) app.setView(v.id);
    return;
  }
  // 忽略输入框内的快捷键
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') seekRatio(Math.max(0, state.progress - 0.02));
  else if (e.key === 'ArrowRight') seekRatio(Math.min(1, state.progress + 0.02));
  else if (e.key === 'l' || e.key === 'L') toggleLoop();
  else if (e.key === 'm' || e.key === 'M') toggleMetro();
  else if (e.key === '=' || e.key === '+') setTempo(state.tempo + 0.05);
  else if (e.key === '-' || e.key === '_') setTempo(state.tempo - 0.05);
}

onMounted(() => {
  startTickLoop();
  restoreSongs();
  playlistStore.hydrateFromDb();
  initGlobal();
  loadWallpaper();
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  stopTickLoop();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <video v-if="wpEnabled && wpUrl" :key="wpUrl" ref="bgVideo" class="app-wallpaper" :src="wpUrl" autoplay muted playsinline preload="auto" @timeupdate="onBgTime"></video>
  <div class="app-shell" :class="{ 'side-collapsed': !state.sidebarOpen, 'no-player': !state.playerbarOpen, 'wallpaper-on': wpEnabled && wpUrl }">
    <SideBar />
    <TopBar />
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <Transition name="view" mode="out-in">
          <KeepAlive>
            <component :is="Component" />
          </KeepAlive>
        </Transition>
      </router-view>
    </main>
    <PlayerBar v-if="state.playerbarOpen" />
    <div class="toast-wrap" v-if="state.toast && state.toast.msg" role="status" aria-live="polite">
      <div class="toast" :class="state.toast.type">{{ state.toast.msg }}</div>
    </div>

    <!-- 全局系统功能浮层 -->
    <div v-if="wallpaperPromptOpen" class="overlay" role="dialog" aria-modal="true" :aria-label="t('发现动态壁纸')" @click.self="dismissWallpaperPrompt">
      <div class="overlay-card wp-prompt">
        <div class="wp-prompt-ic"><Icon name="wallpaper" :size="30" /></div>
        <b class="wp-prompt-title">{{ t('发现动态壁纸') }}</b>
        <p class="wp-prompt-desc">{{ t('首次使用：是否从 GitHub 下载一张壁纸？下载后可在顶栏按钮切换，需要更多可再次从壁纸库选择或自行导入。') }}</p>
        <div class="wp-prompt-actions">
          <button class="btn primary" @click="goDownloadWallpaper">{{ t('去下载壁纸') }}</button>
          <button class="btn ghost" @click="dismissWallpaperPrompt">{{ t('暂不') }}</button>
        </div>
      </div>
    </div>

    <SettingsPanel v-if="state.ui.settingsOpen" />
    <ThemeLibrary v-if="state.ui.themesOpen" />
    <WallpaperGallery v-if="state.ui.wallpaperOpen" />
    <CommandPalette v-if="state.ui.paletteOpen" />
    <GuideOverlay v-if="state.ui.guideOpen" />
  </div>
</template>

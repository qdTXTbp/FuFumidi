<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import SideBar from './components/SideBar.vue';
import TopBar from './components/TopBar.vue';
import PlayerBar from './components/PlayerBar.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ThemeLibrary from './components/ThemeLibrary.vue';
import CommandPalette from './components/CommandPalette.vue';
import GuideOverlay from './components/GuideOverlay.vue';
import WallpaperGallery from './components/WallpaperGallery.vue';
import ViewHome from './views/ViewHome.vue';
import ViewPlay from './views/ViewPlay.vue';
import ViewEdit from './views/ViewEdit.vue';
import ViewAnalyze from './views/ViewAnalyze.vue';
import ViewViz from './views/ViewViz.vue';
import ViewScore from './views/ViewScore.vue';
import ViewLyrics from './views/ViewLyrics.vue';
import ViewConvert from './views/ViewConvert.vue';
import ViewTranscribe from './views/ViewTranscribe.vue';
import ViewPlaceholder from './views/ViewPlaceholder.vue';
import Icon from './components/Icon.vue';
import { state, MIGRATED_VIEWS, startTickLoop, stopTickLoop, restoreSongs, loadPlaylists, loadWallpaper, wallpaperSrc, maybePromptWallpaper, markWallpaperPrompted, goDownloadWallpaper, togglePlay, seekRatio, setTempo, toggleLoop, toggleMetro } from './store.js';
import { setLang, t } from './core/i18n.js';
import { applyTheme, loadTheme } from './core/theme.js';

const bridge = window.fuBridge;

// 动态壁纸无缝循环：原生 loop 在循环切换时有黑屏/卡顿，
// 改为临近结尾时提前 seek 到开头偏后位置（跳过首帧解码延迟与开头黑帧）
const bgVideo = ref(null);
function onBgTime() {
  const v = bgVideo.value;
  if (!v || !v.duration || !isFinite(v.duration)) return;
  if (v.currentTime > v.duration - 0.4) v.currentTime = 0.35;
}

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
  loadPlaylists();
  loadWallpaper();
  initGlobal();
  // 首次启动：稍后询问是否从 GitHub 下载一张壁纸（只弹一次）
  setTimeout(maybePromptWallpaper, 1200);
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  stopTickLoop();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="app-shell" :class="{ 'side-collapsed': !state.sidebarOpen }">
    <!-- 动态壁纸：全屏背景视频（静音无缝循环，毛玻璃组件透出其画面） -->
    <video v-if="wallpaperSrc" ref="bgVideo" class="app-wallpaper" :src="wallpaperSrc"
           autoplay muted playsinline preload="auto" @timeupdate="onBgTime"></video>
    <SideBar />
    <TopBar />
    <main class="app-main">
      <Transition name="view" mode="out-in">
        <ViewHome v-if="state.view === 'home'" key="home" />
        <ViewPlay v-else-if="state.view === 'play'" key="play" />
        <ViewEdit v-else-if="state.view === 'edit'" key="edit" />
        <ViewAnalyze v-else-if="state.view === 'analyze'" key="analyze" />
        <ViewViz v-else-if="state.view === 'viz'" key="viz" />
        <ViewScore v-else-if="state.view === 'score'" key="score" />
        <ViewLyrics v-else-if="state.view === 'lyrics'" key="lyrics" />
        <ViewConvert v-else-if="state.view === 'convert'" key="convert" />
        <ViewTranscribe v-else-if="state.view === 'transcribe'" key="transcribe" />
        <ViewPlaceholder v-else :view-id="state.view" :key="state.view" />
      </Transition>
    </main>
    <PlayerBar />
    <div class="toast-wrap" v-if="state.toast">
      <div class="toast" :class="state.toast.type">{{ state.toast.msg }}</div>
    </div>

    <!-- 全局系统功能浮层 -->
    <SettingsPanel v-if="state.ui.settingsOpen" />
    <ThemeLibrary v-if="state.ui.themesOpen" />
    <CommandPalette v-if="state.ui.paletteOpen" />
    <GuideOverlay v-if="state.ui.guideOpen" />
    <WallpaperGallery v-if="state.ui.wallpaperGalleryOpen" />

    <!-- 首次启动：询问是否从 GitHub 下载一张壁纸 -->
    <div v-if="state.ui.wallpaperPrompt" class="overlay">
      <div class="overlay-card wp-prompt">
        <div class="wp-prompt-ic"><Icon name="wallpaper" :size="30" /></div>
        <b class="wp-prompt-title">{{ t('发现动态壁纸') }}</b>
        <p class="wp-prompt-desc">{{ t('首次使用：是否从 GitHub 下载一张壁纸？下载后可在顶栏按钮切换，需要更多可再次从壁纸库选择或自行导入。') }}</p>
        <div class="wp-prompt-actions">
          <button class="btn primary" @click="goDownloadWallpaper">{{ t('去下载壁纸') }}</button>
          <button class="btn ghost" @click="markWallpaperPrompted()">{{ t('暂不需要') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

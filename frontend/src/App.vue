<script setup>
import { onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue';
import SideBar from './components/SideBar.vue';
import TopBar from './components/TopBar.vue';
import PlayerBar from './components/PlayerBar.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ThemeLibrary from './components/ThemeLibrary.vue';
import CommandPalette from './components/CommandPalette.vue';
import GuideOverlay from './components/GuideOverlay.vue';
// 视图按需加载：降低首屏体积，乐谱/可视化/转换等重模块延迟初始化
const ViewHome = defineAsyncComponent(() => import('./views/ViewHome.vue'));
const ViewPlay = defineAsyncComponent(() => import('./views/ViewPlay.vue'));
const ViewEdit = defineAsyncComponent(() => import('./views/ViewEdit.vue'));
const ViewAnalyze = defineAsyncComponent(() => import('./views/ViewAnalyze.vue'));
const ViewViz = defineAsyncComponent(() => import('./views/ViewViz.vue'));
const ViewScore = defineAsyncComponent(() => import('./views/ViewScore.vue'));
const ViewLyrics = defineAsyncComponent(() => import('./views/ViewLyrics.vue'));
const ViewConvert = defineAsyncComponent(() => import('./views/ViewConvert.vue'));
const ViewTranscribe = defineAsyncComponent(() => import('./views/ViewTranscribe.vue'));
const ViewPlaceholder = defineAsyncComponent(() => import('./views/ViewPlaceholder.vue'));
import { useAppStore } from './stores/app';
import { setLang } from './core/i18n.js';
import { applyTheme, loadTheme } from './core/theme.js';

const app = useAppStore();
const state = app;
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
  initGlobal();
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  stopTickLoop();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="app-shell" :class="{ 'side-collapsed': !state.sidebarOpen, 'no-player': !state.playerbarOpen }">
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
    <PlayerBar v-if="state.playerbarOpen" />
    <div class="toast-wrap" v-if="state.toast">
      <div class="toast" :class="state.toast.type">{{ state.toast.msg }}</div>
    </div>

    <!-- 全局系统功能浮层 -->
    <SettingsPanel v-if="state.ui.settingsOpen" />
    <ThemeLibrary v-if="state.ui.themesOpen" />
    <CommandPalette v-if="state.ui.paletteOpen" />
    <GuideOverlay v-if="state.ui.guideOpen" />
  </div>
</template>

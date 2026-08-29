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
  applyTheme(lt.name, lt.accent, lt.mode);
  let s = {};
  if (bridge && bridge.getSettings) {
    try { s = await bridge.getSettings() || {}; } catch (e) {}
  }
  let hasLsTheme = false;
  try { hasLsTheme = localStorage.getItem('fufumidi_theme') != null; } catch (e) {}
  if (!hasLsTheme && s.theme) applyTheme(s.theme, s.accent || '', lt.mode);

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

  // 6) 启动时自动检查更新：有新版则弹窗询问是否更新（仅桌面端）
  startupUpdateCheck();
}

/* 简单版本号比较（支持 x.y.z，逐段数值比较，避免 '3.1.10' < '3.1.8' 的字典序问题） */
function verNum(v) {
  const m = String(v || '').replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
  return ((m[0] || 0) * 1000000) + ((m[1] || 0) * 1000) + (m[2] || 0);
}

/* 启动自动检查更新：GitHub latest 对比当前版本，有新版则弹窗询问（仅桌面端） */
async function startupUpdateCheck() {
  if (!bridge || typeof bridge.updateCheck !== 'function') return;
  let r = null;
  try { r = await bridge.updateCheck(); } catch (e) { return; }
  if (!r || !r.ok) return; // 检查失败静默，不打扰用户
  const cur = String(r.current || '');
  const latest = String(r.latest || '');
  if (!latest || verNum(latest) <= verNum(cur)) return;
  setTimeout(() => {
    if (state.dialog) return; // 已有其他弹窗时不叠加
    const notes = String(r.notes || '').trim();
    const msg = t('发现新版本 ') + latest + t('，当前 ') + cur + t('。\n是否现在更新？') +
      (notes ? '\n\n' + t('更新内容') + '：\n' + notes.slice(0, 200) : '');
    app.confirmDialog({ title: t('发现新版本'), msg, okText: t('立即更新'), cancelText: t('暂不更新') })
      .then(ok => {
        if (!ok) return;
        if (!bridge || !bridge.update || typeof bridge.update.launchUpdater !== 'function') {
          app.toast(t('当前环境不支持增量更新器'), 'warn');
          return;
        }
        bridge.update.launchUpdater(latest).then(rr => {
          if (!rr || !rr.ok) app.toast((rr && rr.error) || t('更新器启动失败'), 'error');
        }).catch(() => {});
      });
  }, 2500);
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

// 全局 Web 弹窗（confirm/alert/prompt）提交/取消
function submitDialog() {
  if (!state.dialog) return;
  if (state.dialog.kind === 'prompt') app.dialogResolve(state.dialog.value);
  else app.dialogResolve(true);
}
function cancelDialog() {
  app.dialogCancel();
}

// 导入目标歌单选择浮层：默认选中当前激活歌单（真实歌单），否则仅全部曲目
const importTarget = ref('all');
const newImportPlName = ref('');
watch(() => state.importPick, (v) => {
  if (v) {
    const active = playlistStore.activePlaylist;
    importTarget.value = active ? active.id : 'all';
    newImportPlName.value = '';
  }
});
function confirmImportTargetModal(targetId) {
  app.confirmImportTarget(targetId, newImportPlName.value);
}
function cancelImportTargetModal() {
  app.cancelImportTarget();
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

function onBeforeUnload() {
  // 尽力冲刷 SQLite 写队列；主进程退出前还有宽限期兜底
  playlistStore.flushDb();
}

onMounted(() => {
  startTickLoop();
  restoreSongs();
  playlistStore.hydrateFromDb();
  initGlobal();
  loadWallpaper();
  window.addEventListener('keydown', onKey);
  // 退出/刷新前冲刷 SQLite 写队列，避免歌单/收藏最后一步未落盘
  window.addEventListener('beforeunload', onBeforeUnload);
});
onBeforeUnmount(() => {
  stopTickLoop();
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<template>
  <video v-if="wpEnabled && wpUrl" :key="wpUrl" ref="bgVideo" class="app-wallpaper" :src="wpUrl" autoplay muted playsinline preload="auto" @timeupdate="onBgTime"></video>
  <div class="app-shell" :style="{ '--sidebar-w': state.sidebarWidth + 'px' }" :class="{ 'side-collapsed': !state.sidebarOpen, 'no-player': !state.playerbarOpen, 'wallpaper-on': wpEnabled && wpUrl, resizing: state.sidebarResizing }">
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
    <div class="toast-wrap" v-if="state.toastMsg && state.toastMsg.msg" role="status" aria-live="polite">
      <div class="toast" :class="state.toastMsg.type">{{ state.toastMsg.msg }}</div>
    </div>

    <!-- 全局系统功能浮层 -->
    <Transition name="ov">
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
    </Transition>

    <Transition name="ov">
      <SettingsPanel v-if="state.ui.settingsOpen" />
    </Transition>
    <Transition name="ov">
      <ThemeLibrary v-if="state.ui.themesOpen" />
    </Transition>
    <Transition name="ov">
      <WallpaperGallery v-if="state.ui.wallpaperOpen" />
    </Transition>
    <Transition name="ov">
      <CommandPalette v-if="state.ui.paletteOpen" />
    </Transition>
    <Transition name="ov">
      <GuideOverlay v-if="state.ui.guideOpen" />
    </Transition>
  </div>

  <!-- 全局 Web 弹窗：统一替代 window.confirm / alert / prompt -->
  <Teleport to="body">
    <Transition name="ov">
      <div v-if="state.dialog" class="ed-modal-mask" role="dialog" aria-modal="true" :aria-label="state.dialog.title" @click.self="cancelDialog" @keydown.esc="cancelDialog">
        <div class="ed-modal" style="width:min(380px,92vw)">
          <div class="ed-modal-head">
            <b>{{ state.dialog.title }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" aria-label="t('关闭')" @click="cancelDialog"><Icon name="close" :size="14" /></button>
          </div>
          <div class="small" style="padding:4px 2px;line-height:1.6;color:var(--ink);white-space:pre-wrap">{{ state.dialog.msg }}</div>
          <input v-if="state.dialog.kind === 'prompt'" id="global-prompt-input" name="global-prompt-input" v-model="state.dialog.value" class="text-input" style="width:100%" :aria-label="state.dialog.title" @keydown.enter.prevent="submitDialog" @keydown.esc.stop="cancelDialog" />
          <div class="ed-modal-foot">
            <button v-if="state.dialog.kind !== 'alert'" class="btn sm ghost" @click="cancelDialog">{{ state.dialog.cancelText || t('取消') }}</button>
            <button class="btn sm primary" @click="submitDialog">{{ state.dialog.okText || t('确定') }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 导入目标歌单选择：按钮/拖放/命令面板导入前询问归入哪个歌单（含批量） -->
  <Teleport to="body">
    <Transition name="ov">
      <div v-if="state.importPick" class="ed-modal-mask" role="dialog" aria-modal="true" :aria-label="t('导入到歌单')" @click.self="cancelImportTargetModal" @keydown.esc="cancelImportTargetModal">
        <div class="ed-modal" style="width:min(360px,92vw)">
          <div class="ed-modal-head">
            <b>{{ t('导入到歌单') }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" aria-label="t('关闭')" @click="cancelImportTargetModal"><Icon name="close" :size="14" /></button>
          </div>
          <div class="small" style="padding:0 2px;line-height:1.6;color:var(--ink)">
            {{ t('选择导入 ') + state.importPick.items.length + t(' 个文件到：') }}
          </div>
          <div class="imp-pl-list">
            <label class="imp-pl-item">
              <input type="radio" v-model="importTarget" value="all" />
              <span>{{ t('全部曲目（仅加入资料库）') }}</span>
            </label>
            <label class="imp-pl-item" v-for="pl in playlistStore.playlists" :key="pl.id">
              <input type="radio" v-model="importTarget" :value="pl.id" />
              <span>{{ pl.name }}</span>
            </label>
          </div>
          <div class="imp-pl-new">
            <input v-model="newImportPlName" class="text-input" style="flex:1;min-width:0" :placeholder="t('或输入新歌单名并新建…')" @keydown.enter.prevent="confirmImportTargetModal('__new__')" />
            <button class="btn sm" style="padding:4px 10px" @click="confirmImportTargetModal('__new__')">{{ t('新建并导入') }}</button>
          </div>
          <div class="ed-modal-foot">
            <button class="btn sm ghost" @click="cancelImportTargetModal">{{ t('取消') }}</button>
            <button class="btn sm primary" @click="confirmImportTargetModal(importTarget)">{{ t('确定') }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 全局 Web 弹窗（与 SideBar/ViewEdit 的 ed-modal 一致） */
.ed-modal-mask { position: fixed; inset: 0; background: rgba(10,10,10,0.35); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.ed-modal { width: min(380px, 92vw); background: var(--canvas); border-radius: 14px; box-shadow: 0 24px 64px rgba(16,24,40,0.2); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.ed-modal-head { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--ink); }
.ed-modal-head b { font-size: 15px; }
.ed-modal-foot { display: flex; justify-content: flex-end; gap: 8px; }
.imp-pl-list { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto; }
.imp-pl-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 14px; color: var(--ink); }
.imp-pl-item:has(input:checked) { border-color: var(--brand); background: var(--brand-soft); }
.imp-pl-item input:checked + span { color: var(--brand); font-weight: 600; }
.imp-pl-item input { accent-color: var(--brand); }
.imp-pl-new { display: flex; gap: 8px; align-items: center; }
</style>

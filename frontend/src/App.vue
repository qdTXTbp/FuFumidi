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
import ChangeLogOverlay from './components/ChangeLogOverlay.vue';
import { ref, computed, reactive } from 'vue';
import { useAppStore, VIEWS } from './stores/app';
import { usePlaylistStore } from './stores/playlist';
import { useSettingsStore } from './stores/settings';
import { setLang, t } from './core/i18n.js';
import { getAppVersion } from './core/version.js';
import { getBuiltinChangeLogs, fetchRemoteChangeLog } from './core/changelog.js';
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

  // 6) 更新完成后首次启动：展示更新日志（对比上次记录的版本号）
  checkChangeLog();

  // 7) 启动时自动检查更新：有新版则弹窗询问是否更新（仅桌面端）
  startupUpdateCheck();
}

/* 更新完成后首次启动检测：当前版本 > 上次记录版本 → 展示更新日志 */
const SEEN_KEY = 'fufumidi_seen_version';
async function checkChangeLog() {
  let ver = '';
  try { ver = await getAppVersion(); } catch (e) {}
  const cur = String(ver || '').replace(/^v/i, '');
  const curNum = verNum(cur);
  if (!curNum) return;
  let seen = 0;
  try { seen = parseInt(localStorage.getItem(SEEN_KEY) || '0', 10); } catch (e) {}
  if (curNum <= seen) return; // 非升级（或已展示过）
  // 先记录版本，避免展示失败导致每次启动重复弹
  try { localStorage.setItem(SEEN_KEY, String(curNum)); } catch (e) {}
  // 内置 changelog 为主，远端 release 说明补充内置缺失的版本
  let logs = getBuiltinChangeLogs(seen || 0, curNum);
  if (!logs.length) {
    const remote = await fetchRemoteChangeLog(cur);
    if (remote) logs = [remote];
  } else {
    // 当前版本若不在内置数据中，尝试远端补充
    if (!logs.some(g => g.ver === cur)) {
      const remote = await fetchRemoteChangeLog(cur);
      if (remote) logs = logs.concat(remote);
    }
  }
  if (!logs.length) return;
  state.changelog = { from: seen || null, to: cur, logs };
  // 若新手引导开着则等它关闭后再展示，避免启动叠加
  if (state.ui.guideOpen) {
    const off = watch(() => state.ui.guideOpen, (v) => {
      if (!v) { off(); state.ui.changelogOpen = true; }
    });
  } else {
    setTimeout(() => { state.ui.changelogOpen = true; }, 800);
  }
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
        app.toast(t('正在启动增量更新器，完成后自动重启…'));
        bridge.update.launchUpdater(latest).then(rr => {
          if (!rr || !rr.ok) app.toast((rr && rr.error) || t('更新失败，当前安装未受影响'), 'error');
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
    if (state.ui.paletteOpen || state.ui.settingsOpen || state.ui.themesOpen || state.ui.guideOpen || state.ui.changelogOpen) {
      state.ui.paletteOpen = false;
      state.ui.settingsOpen = false;
      state.ui.themesOpen = false;
      state.ui.guideOpen = false;
      state.ui.changelogOpen = false;
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

/* ---------------- GPU 安装常驻通知条 ---------------- */
let offGpuProg = null;
let gpuBarTimer = null;
let offUpdateProg = null;
let updLastPct = -1;
// 安装进度（任意页面都可见）：App.vue 全局订阅 gpu:progress 写入 store
function onGpuProgressGlobal(p) {
  if (!p) return;
  const gi = state.gpuInstall;
  if (p.done) gi.percent = 100;
  else if (p.percent != null && p.percent >= 0) gi.percent = p.percent;
  if (p.text) gi.text = String(p.text);
  if (p.error) gi.error = String(p.error);
}
// 安装中常驻显示；完成后保留 10 秒展示结果
const gpuBarVisible = computed(() => {
  const gi = state.gpuInstall;
  return gi.active || (gi.done && Date.now() - gi.ts < 10000);
});
watch(() => state.gpuInstall.done, (v) => {
  if (!v) return;
  clearTimeout(gpuBarTimer);
  gpuBarTimer = setTimeout(() => { state.gpuInstall.done = false; }, 10000);
});
function openGpuSettings() {
  state.ui.settingsTab = 'gpu';
  state.ui.settingsOpen = true;
}
function dismissGpuBar() {
  clearTimeout(gpuBarTimer);
  // 安装进行中不允许关闭：避免后台仍在安装但界面状态被清掉，导致重复触发安装
  if (state.gpuInstall.active) return;
  state.gpuInstall.done = false;
}

/* ---------------- 模型下载：顶部通知条（任意页面可见） ---------------- */
const dlProg = reactive({});            // id -> {active, percent, speed, received, total, done, error}
const dlModelNames = ref({});
const dlPeek = ref(false);              // 收起为顶部细条（露出一点）
const dlExpanded = ref(false);          // 点击展开详细下载数据
let dlHideTimer = null;
let prevDlCount = 0;
const activeDls = computed(() => Object.entries(dlProg).filter(([id, v]) => v && v.active).map(([id, v]) => ({ id, ...v, name: (dlModelNames.value[id] && dlModelNames.value[id].name) || id })));
const overallPct = computed(() => { const d = activeDls.value; if (!d.length) return 0; return Math.round(d.reduce((s, x) => s + (x.percent || 0), 0) / d.length); });
async function ensureDlNames() {
  try { const arr = await bridge.modelList() || []; const m = {}; for (const x of arr) if (x && x.id) m[x.id] = x; dlModelNames.value = m; } catch (e) {}
}
function applyDl(p) {
  if (!p || !p.id) return;
  const cur = dlProg[p.id] || {};
  dlProg[p.id] = {
    ...cur, ...p,
    active: !!(p.done ? false : (p.active !== false ? (cur.active !== false) : true)),
  };
  if (p.done) dlProg[p.id].active = false;
  if (p.error) dlProg[p.id].active = false;
  if (p.done) ensureDlNames();
  const c = activeDls.value.length;
  if (c > prevDlCount && !dlExpanded.value) { dlPeek.value = false; armHide(); }   // 新下载开始：弹出并重新计时
  prevDlCount = c;
  if (c === 0) { dlPeek.value = false; dlExpanded.value = false; }
}
function armHide() {
  clearTimeout(dlHideTimer);
  dlHideTimer = setTimeout(() => { if (!dlExpanded.value) dlPeek.value = true; }, 5000);
}
function revealDl() { if (dlPeek.value) dlPeek.value = false; armHide(); }
function onDlLeave() { if (!dlExpanded.value) armHide(); }
function toggleDl() {
  if (dlPeek.value) { revealDl(); return; }
  dlExpanded.value = !dlExpanded.value;
  if (dlExpanded.value) clearTimeout(dlHideTimer); else armHide();
}
function cancelDl(id) { if (bridge && bridge.modelCancel) bridge.modelCancel(id); dlProg[id] = { ...(dlProg[id] || {}), active: false, paused: true }; }
function dlHuman(n) { if (!n) return '—'; if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB'; if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB'; if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB'; return n + ' B'; }
function dlSpeed(bps) { if (!bps) return ''; return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' MB/s' : (bps / 1e3).toFixed(0) + ' KB/s'; }

onMounted(() => {
  startTickLoop();
  restoreSongs();
  playlistStore.hydrateFromDb();
  initGlobal();
  loadWallpaper();
  if (bridge && bridge.onGpuProgress) offGpuProg = bridge.onGpuProgress(onGpuProgressGlobal);
  // 模型下载进度（顶部通知条）
  if (bridge && bridge.onModelProgress) offDlProg = bridge.onModelProgress(applyDl);
  ensureDlNames();
  // 更新包下载进度提示（主进程预下载阶段）
  if (bridge && bridge.onUpdateProgress) {
    offUpdateProg = bridge.onUpdateProgress((p) => {
      if (!p) return;
      const pct = p.percent;
      if (p.done) { updLastPct = -1; app.toast(t('更新包已下载，正在安装…')); }
      else if (pct != null && pct >= 0 && pct >= updLastPct + 5) { updLastPct = pct; app.toast(t('正在下载更新包 ') + pct + '%'); }
    });
  }
  window.addEventListener('keydown', onKey);
  // 退出/刷新前冲刷 SQLite 写队列，避免歌单/收藏最后一步未落盘
  window.addEventListener('beforeunload', onBeforeUnload);
});
onBeforeUnmount(() => {
  stopTickLoop();
  if (offGpuProg) { try { offGpuProg(); } catch (e) {} offGpuProg = null; }
  if (offUpdateProg) { try { offUpdateProg(); } catch (e) {} offUpdateProg = null; }
  if (offDlProg) { try { offDlProg(); } catch (e) {} offDlProg = null; }
  clearTimeout(gpuBarTimer);
  clearTimeout(dlHideTimer);
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
    <Transition name="pb">
      <PlayerBar v-if="state.playerbarOpen" />
    </Transition>
    <div class="toast-wrap" v-if="state.toastMsg && state.toastMsg.msg" role="status" aria-live="polite">
      <div class="toast" :class="state.toastMsg.type">{{ state.toastMsg.msg }}</div>
    </div>

    <!-- GPU 安装常驻通知条：任意页面可见，点击跳转设置 → GPU -->
    <Transition name="ov">
      <div v-if="gpuBarVisible" class="gpu-bar" :class="{ err: state.gpuInstall.done && !state.gpuInstall.ok }" role="status" @click="openGpuSettings">
        <Icon :name="state.gpuInstall.done ? (state.gpuInstall.ok ? 'zap' : 'close') : 'zap'" :size="17" />
        <div class="gpu-bar-body">
          <div class="gpu-bar-title">
            {{ state.gpuInstall.done
              ? (state.gpuInstall.ok ? t('GPU 加速安装完成') : t('GPU 加速安装失败'))
              : t('正在安装 GPU 加速') + (state.gpuInstall.kind ? '（' + (state.gpuInstall.kind === 'cuda' ? 'CUDA cu128' : 'DirectML') + '）' : '') }}
          </div>
          <div v-if="!state.gpuInstall.done" class="gpu-bar-track">
            <div class="gpu-bar-fill" :style="{ width: Math.min(100, state.gpuInstall.percent || 0) + '%' }"></div>
          </div>
          <div v-else class="gpu-bar-msg">{{ state.gpuInstall.ok ? t('增强包已就绪，点击查看详情') : (state.gpuInstall.error || t('安装失败，点击查看详情')) }}</div>
          <div v-if="!state.gpuInstall.done && state.gpuInstall.text" class="gpu-bar-tip">{{ state.gpuInstall.text }}</div>
        </div>
        <button class="gpu-bar-x" :title="t('关闭')" aria-label="t('关闭')" @click.stop="dismissGpuBar"><Icon name="close" :size="13" /></button>
      </div>
    </Transition>

    <!-- 模型下载：顶部通知条（5 秒无人触碰收起为顶部细条，悬停下滑，点击展开详情） -->
    <Transition name="dlnoti">
      <div v-if="activeDls.length" class="dl-noti" :class="{ peek: dlPeek }">
        <div class="dl-stack" :class="{ open: dlExpanded }" @mouseenter="revealDl" @mouseleave="onDlLeave">
          <button class="dl-bar" @click="toggleDl">
            <Icon name="download" :size="15" />
            <b class="dl-anypct">{{ overallPct }}%</b>
            <span class="dl-cnt">{{ activeDls.length }} {{ t('个下载中') }}</span>
            <i class="dl-caret">{{ dlExpanded ? '▲' : '▼' }}</i>
          </button>
          <div class="dl-panel">
            <div v-for="d in activeDls" :key="d.id" class="dl-item">
              <div class="dl-name" :title="d.id">{{ d.name }}</div>
              <div class="dl-pbar"><i :style="{ width: (d.percent || 0) + '%' }"></i></div>
              <div class="dl-meta">
                <span class="pct">{{ (d.percent || 0) }}%</span>
                <span v-if="d.speed" class="spd">⚡ {{ dlSpeed(d.speed) }}</span>
                <span class="sz">{{ dlHuman(d.received) }} / {{ dlHuman(d.total) }}</span>
                <button class="btn sm ghost danger" style="margin-left:auto" @click.stop="cancelDl(d.id)">{{ t('取消') }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>

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
    <Transition name="ov">
      <ChangeLogOverlay v-if="state.ui.changelogOpen" />
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

/* GPU 安装常驻通知条 */
.gpu-bar { position: fixed; right: 16px; bottom: 76px; z-index: 980; width: min(340px, 90vw);
  display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 12px;
  background: var(--canvas, #fff); border: 1px solid var(--border, rgba(0,0,0,.12));
  box-shadow: 0 12px 32px rgba(16,24,40,.18); cursor: pointer; }
.gpu-bar > svg { color: var(--brand, #4B3FE3); margin-top: 1px; flex: none; }
.gpu-bar.err > svg { color: #d33; }
.gpu-bar-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.gpu-bar-title { font-size: 13px; font-weight: 600; color: var(--ink, #171717); }
.gpu-bar-track { height: 6px; border-radius: 3px; background: var(--border, rgba(0,0,0,.1)); overflow: hidden; }
.gpu-bar-fill { height: 100%; background: linear-gradient(90deg, #4f94e0, #8fc0f0); transition: width .25s; }
.gpu-bar.err .gpu-bar-fill { background: #d33; }
.gpu-bar-msg { font-size: 12px; color: var(--text-muted, #666); line-height: 1.5; word-break: break-all; }
.gpu-bar-tip { font-size: 11px; color: var(--text-muted, #888); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gpu-bar-x { flex: none; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; background: transparent; color: var(--text-muted, #888); cursor: pointer; }
.gpu-bar-x:hover { background: var(--surface-muted, #EFEFF2); color: var(--ink, #171717); }

/* ===== 模型下载：顶部通知条 ===== */
.dl-noti { position: fixed; top: 0; left: 50%; transform: translate(-50%, 0); z-index: 990;
  display: flex; flex-direction: column; align-items: center; pointer-events: none;
  transition: transform .42s cubic-bezier(.22,.72,.22,1); padding-bottom: 12px; }
.dl-noti.peek { transform: translate(-50%, calc(-100% + 26px)); }   /* 上移露出 26px 细条 */
.dl-stack { pointer-events: auto; display: flex; flex-direction: column; align-items: center; }
.dl-bar { display: inline-flex; align-items: center; gap: 9px; padding: 10px 18px; border: none; border-radius: 999px;
  background: linear-gradient(135deg, var(--accent), var(--brand-coral)); color: #fff; font-size: 12.5px; font-weight: 700;
  cursor: pointer; box-shadow: var(--shadow-lg); transition: transform .18s ease, box-shadow .2s ease; }
.dl-bar:hover { box-shadow: var(--shadow-xl, 0 14px 34px rgba(0,0,0,.28)); }
.dl-bar:active { transform: scale(.96); }
.dl-anypct { font-variant-numeric: tabular-nums; }
.dl-cnt { font-weight: 600; opacity: .96; }
.dl-caret { font-style: normal; font-size: 9px; opacity: .85; }
.dl-panel { width: 400px; max-width: 92vw; margin-top: 8px; background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: 14px; box-shadow: var(--shadow-lg); padding: 4px 14px 8px; overflow: hidden;
  max-height: 0; opacity: 0; transform: translateY(-6px);
  transition: max-height .3s cubic-bezier(.2,.7,.3,1), opacity .24s ease, transform .26s ease; }
.dl-stack.open .dl-panel { max-height: 340px; opacity: 1; transform: translateY(0); overflow-y: auto; }
.dl-item { padding: 7px 0; border-bottom: 1px solid var(--hairline-soft); }
.dl-item:last-child { border-bottom: none; }
.dl-name { font-size: 12px; color: var(--ink); font-weight: 600; margin-bottom: 5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 6px; }
.dl-pbar { height: 6px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; }
.dl-pbar i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--brand-coral));
  border-radius: 999px; transition: width .25s ease; }
.dl-meta { display: flex; align-items: center; gap: 12px; font-size: 10.5px; color: var(--stone); margin-top: 4px; font-family: var(--mono); }
.dl-meta .pct { color: var(--ink); font-weight: 700; }
.dlnoti-enter-active, .dlnoti-leave-active { transition: opacity .24s ease; }
.dlnoti-enter-from, .dlnoti-leave-to { opacity: 0; }
</style>

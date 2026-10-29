<script setup>
import { onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { navHistory, readSession, writeSession, parseDeepLink } from './core/nav_history.js';
import Icon from './components/Icon.vue';
import SideBar from './components/SideBar.vue';
import PrimaryRail from './components/PrimaryRail.vue';
import TopBar from './components/TopBar.vue';
import { useTabsStore } from './stores/tabs';
import PlayerBar from './components/PlayerBar.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ThemeLibrary from './components/ThemeLibrary.vue';
import WallpaperGallery from './components/WallpaperGallery.vue';
import CommandPalette from './components/CommandPalette.vue';
import GuideOverlay from './components/GuideOverlay.vue';
import AppearancePanel from './components/AppearancePanel.vue';
import ChangeLogOverlay from './components/ChangeLogOverlay.vue';
import TaskCenter from './components/TaskCenter.vue';
import { ref, computed, reactive } from 'vue';

/* 全局 UI 缩放只走 core/display.js 的单一入口（Electron setZoomFactor / CSS zoom）。
   过去这里还监听 workspace.layout.scale 再写一次 documentElement.style.zoom，两套缩放会相乘；
   现在 App 不再直接施缩放，ViewEdit 的“界面缩放”菜单改为调用同一函数。 */
import { useAppStore, VIEWS, viewParentOf } from './stores/app';
import { usePlaylistStore } from './stores/playlist';
import { useSettingsStore } from './stores/settings';
import { setLang, t, browserLang } from './core/i18n.js';
import { applyDisplayPrefs as applyDisplayPrefsShared, loadDisplayPrefs } from './core/display.js';
import { applyMaterial } from './core/material.js';
import { installSfxClicks } from './core/sfx.js';
import { playbackPrefs, applyPlaybackSettings } from './core/playback_prefs.js';
import { holdRate, isEditableTarget } from './core/transport_keys.js';
import { getAppVersion, cmpVersion, getUpdateChannel } from './core/version.js';
import { getBuiltinChangeLogs, fetchRemoteChangeLog } from './core/changelog.js';
import { applyTheme, loadTheme } from './core/theme.js';
import { viewFromPath } from './router';

const app = useAppStore();
const state = app;
const playlistStore = usePlaylistStore();
const tabsStore = useTabsStore();
const settingsStore = useSettingsStore();
const wallpaperPromptOpen = ref(false);
const route = useRoute();
const router = useRouter();
// P1-14 B3：启动时先同步抓一次会话（避免首帧路由 watcher 写入把上次会话覆盖掉）
const bootSession = readSession();
// E2E 调试钩子：曲目标签（正常安装版不存在）
try {
  if (window.fuBridge && window.fuBridge.e2e) {
    window.__fufumidiTabs = () => ({ tabs: tabsStore.tabs.map((x) => ({ id: x.id, name: x.name })), activeId: tabsStore.activeId });
  }
} catch (e) {}
// E2E 调试钩子：只在测试实例里暴露历史栈（正常安装版不存在）
try { if (window.fuBridge && window.fuBridge.e2e) window.__fufumidiNav = navHistory; } catch (e) {}

const wpUrl = ref('');
const wpEnabled = ref(false);
const wpProvider = ref('native');
const wpWeUrl = ref('');
const wpWeId = ref('');
const weFrame = ref(null);
let weReq = 0;
let offWpTasks = null;
const bgVideo = ref(null);
const wpKind = ref('video');
const wpFit = ref('cover');
const wpDim = ref(18);
const wpBlur = ref(0);
const isVideoPath = (p) => /\.(mp4|webm|mov)(\?.*)?$/i.test(String(p || ''));
const wallpaperStyle = computed(() => ({
  objectFit: wpFit.value === 'contain' ? 'contain' : 'cover',
  filter: wpBlur.value > 0 ? 'blur(' + wpBlur.value + 'px)' : 'none',
}));
const wallpaperScrimStyle = computed(() => ({ opacity: String(Math.max(0, Math.min(60, Number(wpDim.value) || 0)) / 60) }));
// 动态壁纸无缝循环：原生 loop 在循环切换时有黑屏/卡顿，改为临近结尾提前 seek 到开头偏后位置（跳过首帧解码延迟与黑帧）
function onBgTime() {
  const v = bgVideo.value;
  if (!v || !v.duration || !isFinite(v.duration)) return;
  if (v.currentTime > v.duration - 0.4) v.currentTime = 0.35;
}
// 壁纸冻结自愈：主线程长任务（切页 / 乐谱重绘 / 转录渲染）后，muted 自动播放视频可能停摆
// （paused=false 但 currentTime 不再前进，解码管线停止送帧且不会自行恢复）。心跳检测到
// 停滞时轻微回退 seek 重新触发解码；窗口隐藏时跳过（Chromium 隐藏页暂停送帧属正常行为）。
let wpTimer = 0, wpLast = -1, wpStall = 0;
function wpWatchdog() {
  const v = bgVideo.value;
  if (!v || !wpEnabled.value || document.hidden || v.paused || v.readyState < 2 || !v.duration || !isFinite(v.duration)) { wpLast = -1; wpStall = 0; return; }
  if (v.currentTime === wpLast) {
    if (++wpStall >= 4) { // 约 2s 无推进视为停摆
      wpStall = 0;
      try { v.currentTime = v.currentTime > 0.1 ? v.currentTime - 0.1 : 0.1; v.play().catch(() => {}); } catch (e) {}
    }
  } else wpStall = 0;
  wpLast = v.currentTime;
}
watch(wpEnabled, (on) => {
  clearInterval(wpTimer);
  wpTimer = 0;
  if (on) wpTimer = setInterval(wpWatchdog, 500);
}, { immediate: true });
onBeforeUnmount(() => clearInterval(wpTimer));
function wpFileUrl(p) {
  if (!p) return '';
  if (/^(https?:|file:|data:)/i.test(p)) return p;
  const norm = String(p).replace(/\\/g, '/');
  return 'file:///' + norm.replace(/^([A-Za-z]):/, '$1:');
}
async function refreshWeWallpaper(id) {
  const req = ++weReq;
  if (!id || !bridge || !bridge.wallpaperEngine) { wpWeUrl.value = ''; return; }
  try {
    const r = await bridge.wallpaperEngine.view(String(id));
    if (req !== weReq) return;
    wpWeUrl.value = r && r.ok ? String(r.url || '') : '';
  } catch (e) { if (req === weReq) wpWeUrl.value = ''; }
}
function applyWeSettings(s) {
  const we = !!(s && s.wallpaper_provider === 'wallpaper-engine' && s.wallpaper_we_id && s.wallpaper_enabled);
  wpProvider.value = we ? 'wallpaper-engine' : 'native';
  wpWeId.value = we ? String(s.wallpaper_we_id) : '';
  wpEnabled.value = we ? true : !!(s && s.wallpaper_enabled && s.custom_wallpaper);
  if (we) { wpUrl.value = ''; void refreshWeWallpaper(wpWeId.value); }
  else { wpWeUrl.value = ''; wpUrl.value = wpFileUrl((s && s.custom_wallpaper) || ''); }
}
function sendWe(action) {
  try { if (weFrame.value && weFrame.value.contentWindow) weFrame.value.contentWindow.postMessage({ type: 'fufumidi-wallpaper-ctl', action }, '*'); } catch (e) {}
}
function syncWePause() {
  try {
    const s = settingsStore.settings || {};
    if (s.wallpaper_we_pause_on_transcribe === false) { sendWe('resume'); return; }
    sendWe(window.__fufumidiTranscribing ? 'pause' : 'resume');
  } catch (e) {}
}

onMounted(() => {
  try {
    if (bridge && bridge.tasks && bridge.tasks.onUpdate) {
      offWpTasks = bridge.tasks.onUpdate((ev) => {
        try {
          const tasks = (ev && ev.tasks) || [];
          window.__fufumidiTranscribing = tasks.some((x) => x && x.status === 'running' && x.kind === 'transcribe');
          syncWePause();
        } catch (e) {}
      });
    }
    if (bridge && bridge.tasks && bridge.tasks.list) bridge.tasks.list().then((tasks) => {
      window.__fufumidiTranscribing = (tasks || []).some((x) => x && x.status === 'running' && x.kind === 'transcribe');
      syncWePause();
    }).catch(() => {});
  } catch (e) {}
});
onBeforeUnmount(() => { try { if (offWpTasks) offWpTasks(); } catch (e) {} offWpTasks = null; });

async function loadWallpaper() {
  try {
    const s = await settingsStore.load();
    wpUrl.value = wpFileUrl(s.custom_wallpaper || '');
    wpEnabled.value = !!(s.wallpaper_enabled && s.custom_wallpaper);
    wpKind.value = s.wallpaper_kind || (isVideoPath(s.custom_wallpaper) ? 'video' : 'image');
    wpFit.value = s.wallpaper_fit || 'cover';
    wpDim.value = Number.isFinite(Number(s.wallpaper_dim)) ? Number(s.wallpaper_dim) : 18;
    wpBlur.value = Number.isFinite(Number(s.wallpaper_blur)) ? Number(s.wallpaper_blur) : 0;
  applyMaterial(s.ui_material);
  applyWeSettings(s);
  } catch (e) {}
}
watch(() => settingsStore.settings, () => {
  const s = settingsStore.settings;
  wpUrl.value = wpFileUrl(s.custom_wallpaper || '');
  wpEnabled.value = !!(s.wallpaper_enabled && s.custom_wallpaper);
    wpKind.value = s.wallpaper_kind || (isVideoPath(s.custom_wallpaper) ? 'video' : 'image');
    wpFit.value = s.wallpaper_fit || 'cover';
    wpDim.value = Number.isFinite(Number(s.wallpaper_dim)) ? Number(s.wallpaper_dim) : 18;
    wpBlur.value = Number.isFinite(Number(s.wallpaper_blur)) ? Number(s.wallpaper_blur) : 0;
  applyMaterial(s.ui_material);
  applyWeSettings(s);
  // 播放偏好（跳过空白 / 步长 / 长按倍数）：设置页一改就同步到播放器
  applyPlaybackSettings(s);
  app.applyPlaybackPrefs();
}, { deep: true });
watch(() => route.path, (p) => {
  state.view = viewParentOf(viewFromPath(p));
}, { immediate: true });
/* P1-14 多标签页：当前曲目变化 → 打开/聚焦同名标签（标签栏只做切换入口，不复制数据） */
watch(() => state.currentId, (id) => {
  if (!id) return;
  const item = (state.songs || []).find((s) => s.id === id);
  if (item) tabsStore.open(id, item.name || id);
}, { immediate: true });

/* P1-14 B3：导航历史 + 会话持久化（只记视图 hash；曲目恢复仍走曲库原有逻辑） */
let sessionTimer = 0;
function saveSessionNow() {
  try {
    writeSession({ hash: route.fullPath || '/home', songId: (state.currentSong && state.currentSong.id) || '' });
  } catch (e) {}
}
watch(() => route.fullPath, (p) => {
  if (p && !navHistory.state.applying) navHistory.push(p);
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSessionNow, 400);
}, { immediate: true });
// 启动后恢复上次视图：仅当本次是从首页启动（没有深链接/文件关联抢入口）且上次不是首页
function restoreSessionView() {
  try {
    const cur = route.fullPath || '/';
    if (cur && cur !== '/home' && cur !== '/' && cur !== '') return;
    const s = bootSession;
    if (!s || s.hash === cur || s.hash === '/home') return;
    if (!parseDeepLink(s.hash).valid) return;
    navHistory.state.applying = true;
    Promise.resolve(router.replace(s.hash)).finally(() => {
      navHistory.state.applying = false;
      navHistory.push(String(route.fullPath || s.hash));
      saveSessionNow();
    });
  } catch (e) {}
}
const startTickLoop = () => app.startTickLoop();
const stopTickLoop = () => app.stopTickLoop();
const restoreSongs = () => app.restoreSongs();
const togglePlay = () => app.togglePlay();
const seekRatio = (r) => app.seekRatio(r);
// 方向键短按：按偏好步长跳（秒 / 百分比 / 小节）
const APP_SEEK_STEP = (dir) => app.seekByStep(dir);
const setTempo = (v) => app.setTempo(v);
const toggleLoop = () => app.toggleLoop();
const toggleMetro = () => app.toggleMetro();

const bridge = window.fuBridge;

/* 字号 / 密度 / 全局缩放：取值域与落点都在 core/display.js（设置面板用的是同一份），
   这里只负责"启动时先按 localStorage 应用一次"（防闪烁）。 */
function applyDisplayPrefs(s) { applyDisplayPrefsShared(s); }

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
  // 语言“首次启动”语义：安装后的第一次运行才按浏览器语言确定并记住；
  // 更新/覆盖安装会保留本地存储，不会重置用户语言（见 setLang / browserLang）。
  let lang = 'zh', font = null, density = null;
  try {
    const stored = localStorage.getItem('fufumidi_lang');
    const sLang = (s && s.lang) || '';
    if (stored) {
      lang = stored;                       // 用户已设定过（或更新后保留）→ 用它
    } else if (sLang) {
      lang = sLang;                        // 设置里存过 → 用它
    } else {
      lang = browserLang();                // 安装后首次启动 → 按浏览器语言
      try { localStorage.setItem('fufumidi_lang', lang); } catch (e) {}
    }
    font = localStorage.getItem('fufumidi_font');
    density = localStorage.getItem('fufumidi_density');
  } catch (e) { lang = (s && s.lang) || 'zh'; }
  setLang(lang);
  /* 三件一起应用：localStorage 优先、settings 兜底（缩放同理，见 core/display.js） */
  const dp = loadDisplayPrefs();
  applyDisplayPrefs({
    font_size: font || s.font_size || dp.font_size,
    density: density || s.density || dp.density,
    ui_scale: dp.ui_scale || s.ui_scale,
  });

  // 减少动态效果（外观抽屉持久化）：启动即同步
  try { if (localStorage.getItem('fufumidi_reduce_motion') === '1') document.documentElement.classList.add('reduce-motion'); } catch (e) {}

  // 3) 完整性检验（后台静默，由设置面板警告条展示 + 一键修复）
  if (bridge && bridge.checkIntegrity) {
    bridge.checkIntegrity().then(r => {
      state.integrity = { ok: !!(r && r.ok), issues: (r && r.issues) || [], error: (r && r.error) || '' };
    }).catch(() => { state.integrity = { ok: true, issues: [], error: '' }; });
  }

  // 4) 新手引导：首次启动展示
  let guideDone = false;
  let guideUiSeen = false;
  try { guideDone = !!localStorage.getItem('fufumidi_guide_done'); } catch (e) {}
  try { guideUiSeen = !!localStorage.getItem('fufumidi_guide_ui4_seen'); } catch (e) {}
  // UI 改版后的首次启动也弹一次新版引导；E2E 实例不弹，避免遮挡自动用例。
  const guideE2E = !!(window.fuBridge && window.fuBridge.e2e);
  if (!guideE2E && (!guideUiSeen || (!guideDone && !s.guide_done))) state.ui.guideOpen = true;

  // 5) 首次启动壁纸询问（仅一次，未设置壁纸时）
  if (!s.wallpaper_prompt_done && !s.custom_wallpaper) {
    setTimeout(() => {
      if (!settingsStore.settings.custom_wallpaper && !state.ui.wallpaperOpen && !state.ui.guideOpen) wallpaperPromptOpen.value = true;
    }, 1200);
  }

  // 6) 更新完成后首次启动：展示更新日志（对比上次记录的版本号）
  checkChangeLog();

  // 7) 启动时自动检查更新：有新版则弹窗询问是否更新（仅桌面端）
  startupUpdateCheck();
}

/* 更新完成后首次启动检测：当前版本 > 上次记录版本 → 展示更新日志 */
const SEEN_KEY = 'fufumidi_seen_version';
// 旧版本把版本号折算成数字存进 SEEN_KEY（major*1e6+minor*1e3+patch）。直接沿用这个数字
// 会永远大于任何 4.x 版本号，导致升级后既不弹日志、也判断不出"这次到底升没升"。
function seenFromLegacyNum(n) {
  const num = Number(n) || 0;
  if (!num) return '';
  return Math.floor(num / 1000000) + '.' + (Math.floor(num / 1000) % 1000) + '.' + (num % 1000);
}
async function checkChangeLog() {
  let ver = '';
  try { ver = await getAppVersion(); } catch (e) {}
  const cur = String(ver || '').replace(/^v/i, '');
  if (!cur) return;
  // 存字符串做语义化比较：存数字会把 4.4.0-beta.1 与 4.4.0 视作同一版本，从测试版升正式版就不弹了
  let seen = '';
  try { seen = String(localStorage.getItem(SEEN_KEY) || ''); } catch (e) {}
  if (/^\d+$/.test(seen)) seen = seenFromLegacyNum(seen);
  if (seen && cmpVersion(cur, seen) <= 0) return; // 非升级（或已展示过）
  // 先记录版本，避免展示失败导致每次启动重复弹
  try { localStorage.setItem(SEEN_KEY, cur); } catch (e) {}
  // 内置 changelog 为主，远端 release 说明补充内置缺失的版本
  let logs = getBuiltinChangeLogs(seen, cur);
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

/* 启动自动检查更新：对比当前版本，有新版则弹窗询问（仅桌面端）。
   通道（正式 / 测试）来自设置，主进程按通道给出 latest 与它实际命中的通道。 */
async function startupUpdateCheck() {
  if (!bridge || typeof bridge.updateCheck !== 'function') return;
  let r = null;
  try { r = await bridge.updateCheck(getUpdateChannel()); } catch (e) { return; }
  if (!r || !r.ok) return; // 检查失败静默，不打扰用户
  const cur = String(r.current || '');
  const latest = String(r.latest || '');
  if (!latest || cmpVersion(latest, cur) <= 0) return;
  setTimeout(() => {
    if (state.dialog) return; // 已有其他弹窗时不叠加
    const notes = String(r.notes || '').trim();
    const msg = t('发现新版本 ') + latest + t('，当前 ') + cur + t('。\n是否现在更新？') +
      (notes ? '\n\n' + t('更新内容') + t('：') + '\n' + notes.slice(0, 200) : '');
    app.confirmDialog({ title: t('发现新版本'), msg, okText: t('立即更新'), cancelText: t('暂不更新') })
      .then(ok => {
        if (!ok) return;
        if (!bridge || !bridge.update || typeof bridge.update.launchUpdater !== 'function') {
          app.toast(t('当前环境不支持增量更新器'), 'warn');
          return;
        }
        app.toast(t('正在启动增量更新器，完成后自动重启…'));
        // 更新器要按「这个 latest 实际来自哪个通道」去下载：测试通道下若当时没有测试版，
        // latest 其实是正式版，必须用正式锚点，否则会下载错包。
        bridge.update.launchUpdater(r.channel || getUpdateChannel()).then(rr => {
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

/* ---------------- 方向键：短按=按步长跳；长按=倍数播放（用户 2026-10-14）----------------
   为什么这样分派：短按要"精确挪一小段"，长按要"快速掠过"。
   · → 长按：临时把播放速度切到 N 倍（player.setScale，工程 BPM 不动）；
   · ← 长按：**快退且不出声** —— MIDI 播放器不能倒放，只能反复 seek，
     所以先把播放暂停（记住原来是否在播），松手后再从新位置继续。
   抽成 core/transport_keys.js 的纯函数是为了能单测（holdRate / seekTarget）。 */
let _holdTimer = null;
let _rewindTimer = null;
let _heldDir = 0;
let _wasPlaying = false;

function _clearHoldTimers() {
  if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
  if (_rewindTimer) { clearInterval(_rewindTimer); _rewindTimer = null; }
}

function _endHold() {
  _clearHoldTimers();
  const dir = _heldDir;
  _heldDir = 0;
  if (!dir) return;
  if (dir > 0) {
    app.setTemporaryRate(1);            // 恢复原速（state.tempo 从未被改过）
  } else if (_wasPlaying) {
    app.togglePlay();                   // 快退结束：恢复播放（从新位置继续）
  }
  _wasPlaying = false;
}

function onArrowHold(e, dir, isDown) {
  if (!isDown) { _endHold(); return; }
  e.preventDefault();
  if (e.repeat || _heldDir === dir) return;      // 长按的重复事件交给定时器
  _endHold();                                   // 换了方向：先收尾上一次
  _heldDir = dir;
  APP_SEEK_STEP(dir);                           // 短按立刻跳一步（手感：按下去就有反应）
  if (state.isAudio) return;                    // 音频曲目不做倍数播放（那是音频元素的语速）
  _holdTimer = setTimeout(() => {
    _holdTimer = null;
    if (_heldDir !== dir) return;
    if (dir > 0) {
      app.setTemporaryRate(playbackPrefs.holdRate);
    } else {
      _wasPlaying = !!state.playing;
      if (_wasPlaying) app.togglePlay();        // 快退不出声
      const perTick = Math.max(0.2, Number(playbackPrefs.seekStep) * Number(playbackPrefs.holdRate) * 0.1);
      _rewindTimer = setInterval(() => {
        const cur = Number(state.curSec) || 0;
        app.seekSec(Math.max(0, cur - perTick));
      }, 100);
    }
  }, playbackPrefs.holdDelayMs);
}

function onKeyUp(e) {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") _endHold();
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
  // 忽略输入框内的快捷键（方向键在输入框里要能移光标，见 isEditableTarget 的说明）
  if (isEditableTarget(e.target)) return;
  // 编辑器/调教画布内部：数字键 1..9 是时值/力度快捷键、N/P 是编辑动作，
  // 不能再被全局「切歌单 / 上一首下一首」抢走。
  const inEditorSurface = !!(e.target && e.target.closest && e.target.closest('.editor-canvas, .piano-roll, .ed-toolbar, .sing-editor, .pianoroll, .utau-editor'));
  if (inEditorSurface && (/^[1-9]$/.test(e.key) || /^[nNpP]$/.test(e.key))) return;
  // 系统级全局热键触发时，主进程会顺手发一个同名的合成按键事件；
  // 这里放行，避免同一次按键被处理两遍（播放/暂停、上一首/下一首会跳两次）。
  if (e.__fromGlobalHotkey) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // 步长可配（设置 → 快捷键）；按住不放 → 倍数播放（→ 快进；← 快退且不出声）
    onArrowHold(e, e.key === 'ArrowRight' ? 1 : -1, true);
  }
  else if (e.key === 'l' || e.key === 'L') toggleLoop();
  else if (e.key === 'm' || e.key === 'M') toggleMetro();
  else if (e.key === '=' || e.key === '+') setTempo(state.tempo + 0.05);
  else if (e.key === '-' || e.key === '_') setTempo(state.tempo - 0.05);
  /* ---- 后台/前台通用的播放控制（不依赖底部播放栏，任何页面都能用）---- */
  else if (e.key === 'N' || e.key === 'n') { e.preventDefault(); void playNeighbor(1); }
  else if (e.key === 'P' || e.key === 'p') { e.preventDefault(); void playNeighbor(-1); }
  else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); app.cyclePlayMode(); }
  /* ---- 歌单快捷键：数字 1..9 切到第 N 个歌单（侧栏里标了编号）---- */
  else if (/^[1-9]$/.test(e.key)) {
    const pl = playlistStore.playlists[parseInt(e.key, 10) - 1];
    if (pl) {
      e.preventDefault();
      playlistStore.select(pl.id);
      // 切歌单要看得见：顺手落到曲库页（虚拟视图除外，它本来就属于曲库）
      app.setView('music');
    }
  }
}

/** 上一首 / 下一首：走 store 的邻居选择（已按播放模式处理随机/单曲/列表循环） */
async function playNeighbor(dir) {
  const id = app.pickNeighborId(dir);
  if (!id) return;
  await app.playSongById(id);
}

/* ---------------- 操作系统级全局热键（用户自己录制，默认不注册） ----------------
   主进程 globalShortcut 触发 → 这里执行动作；同时补发一个带标记的合成按键，
   让所有页面的既有 onKey 监听（视觉反馈等）保持一致，但被上面的 __fromGlobalHotkey 拦一次。 */
let _hotkeyOff = null;
function setupGlobalHotkeys() {
  const b = window.fuBridge;
  if (!b || typeof b.onHotkeyAction !== 'function') return;
  _hotkeyOff = b.onHotkeyAction((act) => {
    try {
      if (act === 'toggle') { togglePlay(); synthesizeKey(' '); }
      else if (act === 'next') { void playNeighbor(1); synthesizeKey('n'); }
      else if (act === 'prev') { void playNeighbor(-1); synthesizeKey('p'); }
      else if (act === 'cycleMode') { state.cyclePlayMode(); synthesizeKey('o'); }
      else if (act === 'plPrev') stepPlaylist(-1);
      else if (act === 'plNext') stepPlaylist(1);
    } catch (e) { /* 全局热键不该因为某个动作报错就死掉 */ }
  });
}

/** 在自建歌单之间走一步（全局热键用）；虚拟视图（全部曲目/收藏…）下从第一个歌单开始 */
function stepPlaylist(dir) {
  const list = playlistStore.playlists || [];
  if (!list.length) return;
  const cur = list.findIndex((p) => p.id === playlistStore.activePlaylistId);
  const next = cur < 0
    ? (dir > 0 ? 0 : list.length - 1)
    : (cur + dir + list.length) % list.length;
  playlistStore.select(list[next].id);
  app.setView('music');
  app.toast(list[next].name, 'ok');
}

function synthesizeKey(k) {
  try {
    const ev = new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : 'Key' + k.toUpperCase(), bubbles: true });
    ev.__fromGlobalHotkey = true;
    window.dispatchEvent(ev);
  } catch (e) {}
}

function onBeforeUnload() {
  // 尽力冲刷 SQLite 写队列；主进程退出前还有宽限期兜底
  playlistStore.flushDb();
}

onMounted(() => setupGlobalHotkeys());

// P1-5：输入框/下拉/文本域只有 placeholder 当标签，读屏器读不到名字。
// 不逐文件改 68 处；运行期给没有 label 的控件补 aria-label（placeholder/title），
// 新增浮层由 MutationObserver 继续补。
let _a11yObserver = null;
function labelA11yFields(root) {
  const scope = root && root.querySelectorAll ? root : document;
  for (const el of scope.querySelectorAll('input, textarea, select')) {
    if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.closest('label')) continue;
    const text = el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if (text) el.setAttribute('aria-label', text);
  }
}
onMounted(() => {
  labelA11yFields();
  try {
    _a11yObserver = new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) labelA11yFields(n);
    });
    _a11yObserver.observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
});
onBeforeUnmount(() => { try { _a11yObserver && _a11yObserver.disconnect(); } catch (e) {} _a11yObserver = null; });

/* E2E 测试钩子（scripts/e2e）：只在 FUFUMIDI_E2E=1 的实例里注册，正常安装版不存在。
   用途：让交互回放能在**隔离数据根**里造一首最小 MIDI，从而进入编辑页/跑手势脚本，
   不依赖用户曲库。接口刻意做小：hasSong / importMidi / songCount。 */
onMounted(() => {
  try { installSfxClicks(); } catch (e) {}
  try {
    if (!window.fuBridge || !window.fuBridge.e2e) return;
    window.__fufumidiE2E = {
      hasSong: () => !!(app.currentSong && app.currentSong.song),
      song: () => (app.currentSong && app.currentSong.song) || null,
      songCount: () => (Array.isArray(app.songs) ? app.songs.length : 0),
      importMidi: (name, bytes) => app.importFiles([{ name: String(name || 'e2e.mid'), bytes: new Uint8Array(bytes) }]),
    };
  } catch (e) { /* 测试钩子失败不影响应用 */ }
});
onBeforeUnmount(() => { if (_hotkeyOff) { try { _hotkeyOff(); } catch (e) {} _hotkeyOff = null; } });

/* ---------------- GPU 安装常驻通知条 ---------------- */
let offGpuProg = null;
let gpuBarTimer = null;
let offUpdateProg = null;
let offOpenFile = null;  // 双击 .mid 关联打开的订阅取消函数
let offDlProg = null;   // 模型下载进度订阅取消函数（此前未声明，严格模式下赋值抛 ReferenceError，
                        // 中断 onMounted 后续初始化：更新进度订阅/键盘快捷键/退出前 SQLite 落盘）
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
// 安装中常驻显示；完成后保留 10 秒展示结果。用户手动收起后不再弹出。
const gpuBarVisible = computed(() => {
  const gi = state.gpuInstall;
  if (gi.dismissed) return false;
  return gi.active || (gi.done && Date.now() - gi.ts < 10000);
});
watch(() => state.gpuInstall.done, (v) => {
  if (!v) return;
  clearTimeout(gpuBarTimer);
  gpuBarTimer = setTimeout(() => { state.gpuInstall.done = false; }, 10000);
});
/* 富提示里的动作按钮：点完就收起提示（动作本身可能切视图/开设置） */
function runToastAction() {
  const a = state.toastMsg && state.toastMsg.action;
  state.toastDismiss();
  if (a && typeof a.run === 'function') { try { a.run(); } catch (e) { /* 动作失败不影响提示收起 */ } }
}
function openGpuSettings() {
  state.ui.settingsTab = 'gpu';
  state.ui.settingsOpen = true;
}
function dismissGpuBar() {
  clearTimeout(gpuBarTimer);
  // 只收起浮层，不影响后台任务（安装/下载继续，可在「设置 → GPU」查看状态）；
  // 标记 dismissed 后进度事件不会再把浮层弹回来（原先 active 时直接 return，× 点不动）
  if (state.gpuInstall.active) { state.gpuInstall.dismissed = true; return; }
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
  // DiffSinger AI 声库（id 前缀 dsms:）不在 modelList 里，展示名直接用主进程发来的 label
  // （形如「神里绫华（原神）」），避免全局条只显示裸 id。
  if (p.label) dlModelNames.value[p.id] = { ...(dlModelNames.value[p.id] || {}), name: p.label };
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
function cancelDl(id) {
  // DiffSinger AI 声库走独立取消通道（modelCancel 只认常规模型 id）
  if (typeof id === 'string' && id.startsWith('dsms:')) {
    if (bridge && bridge.diffsingerMsCancelDownload) bridge.diffsingerMsCancelDownload(id.slice(5));
  } else if (bridge && bridge.modelCancel) bridge.modelCancel(id);
  dlProg[id] = { ...(dlProg[id] || {}), active: false, paused: true };
}
function dlHuman(n) { if (!n) return '—'; if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB'; if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB'; if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB'; return n + ' B'; }
function dlSpeed(bps) { if (!bps) return ''; return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' MB/s' : (bps / 1e3).toFixed(0) + ' KB/s'; }

onMounted(() => {
  startTickLoop();
  // 曲终自动切歌（播放模式：顺序/随机/单曲循环/列表循环）
  window.__fufumidiAutoNext = () => { try { state.handleTrackEnd(); } catch (e) {} };
  // settings 尽早加载（同步 active_soundfont 引用）：restoreSongs→selectSong→ensureAudio
  // 会读该引用选择音色库，曾因晚于音频初始化导致重启后回退内置音色（另有 localStorage 兜底）
  loadWallpaper();
  Promise.resolve(restoreSongs()).finally(() => {
    try {
      tabsStore.hydrate((state.songs || []).map((s) => s.id));
      if (state.currentId) tabsStore.open(state.currentId, (state.songs.find((s) => s.id === state.currentId) || {}).name || state.currentId);
    } catch (e) {}
  });
  setTimeout(restoreSessionView, 350);   // 等首屏路由/曲库恢复稳定后再套用会话
  playlistStore.hydrateFromDb();
  initGlobal();
  if (bridge && bridge.onGpuProgress) offGpuProg = bridge.onGpuProgress(onGpuProgressGlobal);
  // 模型下载进度（顶部通知条）
  if (bridge && bridge.onModelProgress) offDlProg = bridge.onModelProgress(applyDl);
  // ★ 双击 .mid（文件关联）打开：主进程把文件内容经 'open-file' 发过来。
  //   此前**整个前端没有任何地方订阅它** —— 消息发出去没人收，双击等于完全没反应。
  //   实测复现：双击后应用开在首页、曲库里找不到该曲目、既不加载也不播放。
  if (bridge && bridge.onOpenFile) {
    offOpenFile = bridge.onOpenFile(async (bytes, name) => {
      try { await app.importFiles([{ name: name, bytes: bytes }]); }
      catch (e) { try { app.toast(t('打开失败：') + ((e && e.message) || e), 'warn'); } catch (e2) {} }
    });
    // 兜底：冷启动时主进程的 600ms 定时器可能早于本订阅，那一次 send 会永久丢失。
    // 所以再主动取一次「待打开的文件」（取走即清；重复导入由 importFiles 的指纹去重兜住）。
    // （onMounted 的回调不是 async，所以这里用 IIFE 包一层才允许 await）
    if (bridge.takePendingOpenFile) {
      (async () => {
        try {
          const pend = await bridge.takePendingOpenFile();
          if (pend && pend.bytes) await app.importFiles([{ name: pend.name, bytes: new Uint8Array(pend.bytes) }]);
        } catch (e) {}
      })();
    }
  }
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
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', _endHold);            // 切窗口时别把倍率/快退留在半路上
app.setSkipNotice((from, to) => app.toast(t('已跳过 ') + Math.round(to - from) + t(' 秒空白')));
  // 关窗/刷新前保存播放断点
  window.addEventListener('beforeunload', () => { try { state.saveResumePos(); } catch (e) {} });
  // 托盘控制（播放/暂停、下一首）
  if (bridge && bridge.onTrayControl) bridge.onTrayControl((act) => {
    if (act === 'playpause') app.togglePlay();
    else if (act === 'next') app.skip(1);
  });
  // 退出/刷新前冲刷 SQLite 写队列，避免歌单/收藏最后一步未落盘
  window.addEventListener('beforeunload', onBeforeUnload);
});
onBeforeUnmount(() => {
  stopTickLoop();
  if (offGpuProg) { try { offGpuProg(); } catch (e) {} offGpuProg = null; }
  if (offUpdateProg) { try { offUpdateProg(); } catch (e) {} offUpdateProg = null; }
  if (offDlProg) { try { offDlProg(); } catch (e) {} offDlProg = null; }
  if (offOpenFile) { try { offOpenFile(); } catch (e) {} offOpenFile = null; }
  clearTimeout(gpuBarTimer);
  clearTimeout(dlHideTimer);
  window.removeEventListener('keydown', onKey);
window.removeEventListener('keyup', onKeyUp);
window.removeEventListener('blur', _endHold);
_endHold();
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<template>
  <template v-if="wpEnabled && wpProvider === 'wallpaper-engine' && wpWeUrl">
    <iframe ref="weFrame" class="app-wallpaper app-wallpaper-engine" :src="wpWeUrl" allow="autoplay" @load="syncWePause"></iframe>
  </template>
  <template v-else-if="wpEnabled && wpUrl">
    <img v-if="wpKind === 'image'" :key="wpUrl" class="app-wallpaper" :src="wpUrl" alt="" :style="wallpaperStyle" />
    <video v-else :key="wpUrl" ref="bgVideo" class="app-wallpaper" :src="wpUrl" autoplay muted playsinline preload="auto" :style="wallpaperStyle" @timeupdate="onBgTime"></video>
  </template>
  <div class="app-shell" :style="{ '--sidebar-w': state.sidebarWidth + 'px' }" :class="{ 'side-collapsed': !state.sidebarOpen, 'no-player': !state.playerbarOpen, 'wallpaper-on': wpEnabled && (wpUrl || wpWeUrl), resizing: state.sidebarResizing, immersive: state.ui.immersive }">
    <PrimaryRail />
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
    <!-- 全应用唯一的提示出口（P1-4）：普通提示是胶囊，带「下一步/详情/动作」时是卡片 -->
    <div class="toast-wrap" v-if="state.toastMsg && state.toastMsg.msg" role="status" aria-live="polite">
      <div class="toast" :class="[state.toastMsg.type, { rich: state.toastMsg.rich }]">
        <div class="toast-body">
          <div class="toast-line">
            <span>{{ state.toastMsg.msg }}</span>
            <button v-if="state.toastMsg.action" class="toast-act" @click="runToastAction">{{ state.toastMsg.action.label }}</button>
            <button v-if="state.toastMsg.detail" class="toast-more" @click="state.toastExpand()">{{ state.toastMsg.expanded ? t('收起') : t('详情') }}</button>
            <button v-if="state.toastMsg.rich" class="toast-x" :title="t('关闭')" @click="state.toastDismiss()">×</button>
          </div>
          <div v-if="state.toastMsg.hint" class="toast-hint">{{ state.toastMsg.hint }}</div>
          <pre v-if="state.toastMsg.expanded && state.toastMsg.detail" class="toast-detail">{{ state.toastMsg.detail }}</pre>
        </div>
      </div>
    </div>

    <!-- GPU 安装常驻通知条：任意页面可见，点击跳转设置 → GPU -->
    <Transition name="ov">
      <div v-if="gpuBarVisible" class="gpu-bar" :class="{ err: state.gpuInstall.done && !state.gpuInstall.ok }" role="status" @click="openGpuSettings">
        <Icon :name="state.gpuInstall.done ? (state.gpuInstall.ok ? 'zap' : 'close') : 'zap'" :size="17" />
        <div class="gpu-bar-body">
          <div class="gpu-bar-title">
            {{ state.gpuInstall.done
              ? (state.gpuInstall.ok ? t('GPU 加速安装完成') : t('GPU 加速安装失败'))
              : t('正在安装 GPU 加速') + (state.gpuInstall.kind ? t('（') + (state.gpuInstall.kind === 'cuda' ? 'CUDA cu128' : 'DirectML') + t('）') : '') }}
          </div>
          <div v-if="!state.gpuInstall.done" class="gpu-bar-track">
            <div class="gpu-bar-fill" :style="{ transform: 'scaleX(' + ((Math.min(100, state.gpuInstall.percent || 0)) / 100) + ')' }"></div>
          </div>
          <div v-else class="gpu-bar-msg">{{ state.gpuInstall.ok ? t('增强包已就绪，点击查看详情') : (state.gpuInstall.error || t('安装失败，点击查看详情')) }}</div>
          <div v-if="!state.gpuInstall.done && state.gpuInstall.text" class="gpu-bar-tip">{{ state.gpuInstall.text }}</div>
        </div>
        <button class="gpu-bar-x" :title="t('关闭')" :aria-label="t('关闭')" @click.stop="dismissGpuBar"><Icon name="close" :size="13" /></button>
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
              <!-- 主进程在测速后会发 text（如「选用 国内源 CNB（cnb.cool）（31.2 MB/s）」）。
                   此前这条信息只进内存、界面从不显示，用户无法确认是否真走了国内源。 -->
              <div v-if="d.text" class="dl-src" :title="d.text">{{ d.text }}</div>
              <div class="dl-pbar"><i :style="{ transform: 'scaleX(' + (((d.percent || 0)) / 100) + ')' }"></i></div>
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
      <AppearancePanel v-if="state.ui.appearanceOpen" />
    <GuideOverlay v-if="state.ui.guideOpen" />
    </Transition>
    <Transition name="ov">
      <ChangeLogOverlay v-if="state.ui.changelogOpen" />
    </Transition>
    <!-- C2：全局长任务中心（任何页面都能看进度/取消）；必须是 Transition 的兄弟节点，
         放进 Transition 里会被当成第二个子节点（切换时被一起移除）。 -->
    <TaskCenter />
  </div>

  <!-- 全局 Web 弹窗：统一替代 window.confirm / alert / prompt -->
  <Teleport to="body">
    <Transition name="ov">
      <div v-if="state.dialog" class="ed-modal-mask" role="dialog" aria-modal="true" :aria-label="state.dialog.title" @click.self="cancelDialog" @keydown.esc="cancelDialog">
        <div class="ed-modal" style="width:min(380px,92vw)">
          <div class="ed-modal-head">
            <b>{{ state.dialog.title }}</b>
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="cancelDialog"><Icon name="close" :size="14" /></button>
          </div>
          <div class="small" style="padding:var(--sp-1) 2px;line-height:1.6;color:var(--ink);white-space:pre-wrap">{{ state.dialog.msg }}</div>
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
            <button class="icon-btn" style="margin-left:auto" :title="t('关闭')" :aria-label="t('关闭')" @click="cancelImportTargetModal"><Icon name="close" :size="14" /></button>
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
            <button class="btn sm" style="padding:var(--sp-1) var(--sp-3)" @click="confirmImportTargetModal('__new__')">{{ t('新建并导入') }}</button>
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
.ed-modal { width: min(380px, 92vw); background: var(--canvas); border-radius: var(--r-lg); box-shadow: 0 24px 64px rgba(16,24,40,0.2); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
.ed-modal-head { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-lg); color: var(--ink); }
.ed-modal-head b { font-size: var(--fs-lg); }
.ed-modal-foot { display: flex; justify-content: flex-end; gap: var(--sp-2); }
.imp-pl-list { display: flex; flex-direction: column; gap: var(--sp-1); max-height: 260px; overflow-y: auto; }
.imp-pl-item { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md); cursor: pointer; font-size: var(--fs-lg); color: var(--ink); }
.imp-pl-item:has(input:checked) { border-color: var(--brand); background: var(--brand-soft); }
.imp-pl-item input:checked + span { color: var(--brand); font-weight: 600; }
.imp-pl-item input { accent-color: var(--brand); }
.imp-pl-new { display: flex; gap: var(--sp-2); align-items: center; }

/* GPU 安装常驻通知条 */
.gpu-bar { position: fixed; right: 16px; bottom: calc(var(--playerbar-h) + 8px); z-index: 980; width: min(340px, 90vw);
  display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-radius: var(--r-md);
  background: var(--canvas, var(--surface)); border: 1px solid var(--border, rgba(0,0,0,.12));
  box-shadow: 0 12px 32px rgba(16,24,40,.18); cursor: pointer; }
/* 播放栏收起时（no-player）通知条贴底，避免悬空 */
.app-shell.no-player .gpu-bar { bottom: 16px; }
.gpu-bar > svg { color: var(--brand, var(--data-6)); margin-top: 1px; flex: none; }
.gpu-bar.err > svg { color: var(--t-err); }
.gpu-bar-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.gpu-bar-title { font-size: var(--fs-md); font-weight: 600; color: var(--ink, var(--ink)); }
.gpu-bar-track { height: 6px; border-radius: var(--r-sm); background: var(--border, rgba(0,0,0,.1)); overflow: hidden; }
.gpu-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: transform var(--motion-base) var(--ease-out); }
.gpu-bar.err .gpu-bar-fill { background: var(--t-err); }
.gpu-bar-msg { font-size: var(--fs-sm); color: var(--text-muted, var(--stone)); line-height: 1.5; word-break: break-all; }
.gpu-bar-tip { font-size: var(--fs-xs); color: var(--text-muted, var(--stone)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gpu-bar-x { flex: none; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-muted, var(--stone)); cursor: pointer; }
.gpu-bar-x:hover { background: var(--surface-muted, var(--surface-soft)); color: var(--ink, var(--ink)); }

/* ===== 模型下载：顶部通知条 ===== */
.dl-noti { position: fixed; top: 0; left: 50%; transform: translate(-50%, 0); z-index: 995;
  display: flex; flex-direction: column; align-items: center; pointer-events: none;
  transition: transform var(--motion-slow) var(--ease-out); padding-bottom: var(--sp-3); }
.dl-noti.peek { transform: translate(-50%, calc(-100% + 26px)); }   /* 上移露出 26px 细条 */
/* 折叠用 grid-template-rows 0fr↔1fr：max-height 会在内容比 340px 矮时"提前到位"、看着一顿一顿；
   grid 行高则一路跟内容走，展开/收起都是同一条曲线。 */
.dl-stack { pointer-events: auto; display: grid; grid-template-rows: auto 0fr; justify-items: center;
  transition: grid-template-rows var(--motion-base) var(--ease-out); }
.dl-stack.open { grid-template-rows: auto 1fr; }
.dl-bar { display: inline-flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border: none; border-radius: var(--r-pill);
  background: linear-gradient(135deg, var(--accent), var(--brand-coral)); color: var(--on-accent); font-size: var(--fs-md); font-weight: 700;
  cursor: pointer; box-shadow: var(--shadow-lg); transition: transform var(--motion-base) var(--ease-out), box-shadow var(--motion-base) var(--ease-out); }
.dl-bar:hover { box-shadow: var(--shadow-xl, 0 14px 34px rgba(0,0,0,.28)); }
.dl-bar:active { transform: scale(.96); }
.dl-anypct { font-variant-numeric: tabular-nums; }
.dl-cnt { font-weight: 600; opacity: .96; }
.dl-caret { font-style: normal; font-size: var(--fs-xs); opacity: .85; }
.dl-panel { width: 400px; max-width: 92vw; background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-lg); box-shadow: var(--shadow-lg); padding: var(--sp-3) var(--sp-4) var(--sp-2); overflow: hidden; min-height: 0;
  opacity: 0; transform: translateY(-6px);
  transition: opacity var(--motion-base) var(--ease-out), transform var(--motion-base) var(--ease-out); }
.dl-stack.open .dl-panel { max-height: 340px; opacity: 1; transform: translateY(0); overflow-y: auto; }
.dl-item { padding: var(--sp-2) 0; border-bottom: 1px solid var(--hairline-soft); }
.dl-item:last-child { border-bottom: none; }
.dl-name { font-size: var(--fs-sm); color: var(--ink); font-weight: 600; margin-bottom: var(--sp-1);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: var(--sp-2); }
/* 实际选中的下载源（主进程测速结果）。过长时省略，完整内容在 title 里 */
.dl-src { font-size: var(--fs-xs); color: var(--stone); margin: -2px 0 var(--sp-1); font-family: var(--mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: var(--sp-2); }
.dl-pbar { height: 6px; border-radius: var(--r-pill); background: var(--surface-soft); overflow: hidden; }
.dl-pbar i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--brand-coral));
  border-radius: var(--r-pill); transition: transform var(--motion-base) var(--ease-out); }
.dl-meta { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-xs); color: var(--stone); margin-top: var(--sp-1); font-family: var(--mono); }
.dl-meta .pct { color: var(--ink); font-weight: 700; }
.dlnoti-enter-active, .dlnoti-leave-active { transition: opacity var(--motion-base) var(--ease-out); }
.dlnoti-enter-from, .dlnoti-leave-to { opacity: 0; }
</style>

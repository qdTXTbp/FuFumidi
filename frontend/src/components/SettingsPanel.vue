<script setup>
// 设置面板（全局系统功能）：外观 / 引擎 / 功能 / 快捷键 / 插件 + 完整性检验警告条
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { useSettingsStore } from '../stores/settings';
import { t, setLang, getLang } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const toast = (m, t) => app.toast(m, t);
// 当前版本号（与 SideBar 左下角一致）
const appVersion = 'v3.1.1';
import { THEMES, themeById, applyTheme, saveTheme, loadMode, setMode } from '../core/theme.js';

const bridge = window.fuBridge;
const settingsStore = useSettingsStore();

const TABS = [
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'gpu', label: 'GPU', icon: 'zap' },
  { id: 'feature', label: '功能', icon: 'folder' },
  { id: 'keys', label: '快捷键', icon: 'kbd' },
  { id: 'plugins', label: '插件', icon: 'spark' },
  { id: 'update', label: '更新', icon: 'download' },
];
const tab = ref('appearance');

/* ---------------- 设置导航胶囊指示器 ---------------- */
const tabsRef = ref(null);
const ind = reactive({ x: 0, w: 0 });
function moveInd() {
  nextTick(() => {
    const el = tabsRef.value;
    if (!el) return;
    const btn = el.querySelector('.ov-tab.active');
    if (!btn) return;
    ind.x = btn.offsetLeft;
    ind.w = btn.offsetWidth;
  });
}
watch(tab, moveInd);

/* ---------------- 表单 ---------------- */
const form = reactive({
  theme: 'fufu', accent: '', mode: 'light',
  font_size: 'standard', density: 'comfortable', lang: 'zh',
  engine_path: '', engine_mode: 'universal', perf_mode: 'quality', batch_concurrency: 'auto',
  output_dir: '', name_rule: '', watch_dir: '', watch_enabled: false, file_assoc: true,
});

/* ---------------- 更新 ---------------- */
const upd = reactive({
  status: '',
});

/* ---------------- GPU 加速 ---------------- */

const isCustomTheme = computed(() => !THEMES.some(x => x.id === form.theme));
const themeOpts = computed(() => {
  const list = THEMES.slice();
  if (isCustomTheme.value) list.push({ id: form.theme, name: t('自定义主题'), desc: '' });
  return list;
});

const rustInfo = ref({ available: false, version: '', binary: null });

/* ---------------- 插件 ---------------- */
const plugins = ref([]);
const pluginLog = ref('');

/* ---------------- 快捷键（只读展示） ---------------- */
const KEYMAP = [
  { keys: ['Space'], label: t('播放 / 暂停') },
  { keys: ['←', '→'], label: t('快退 / 快进') },
  { keys: ['L'], label: t('切换循环') },
  { keys: ['M'], label: t('切换节拍器') },
  { keys: ['+', '−'], label: t('加速 / 减速') },
  { keys: ['Ctrl', 'K'], label: t('打开命令面板') },
  { keys: ['F1'], label: t('打开新手引导 / 帮助') },
  { keys: ['Ctrl', '1-9'], label: t('切换首页/演奏/歌词/编辑等视图') },
  { keys: ['Ctrl', 'Z'], label: t('撤销（编辑器）') },
  { keys: ['Ctrl', 'Y'], label: t('重做（编辑器）') },
  { keys: ['Ctrl', 'A'], label: t('全选音符（编辑器）') },
  { keys: ['Ctrl', 'C'], label: t('复制选中音符（编辑器）') },
  { keys: ['Ctrl', 'V'], label: t('粘贴到播放头（编辑器）') },
  { keys: ['Ctrl', 'S'], label: t('导出当前 MIDI（编辑器）') },
  { keys: ['Delete', 'Backspace'], label: t('删除选中音符') },
  { keys: ['V'], label: t('选择工具（编辑器）') },
  { keys: ['B'], label: t('画笔工具（编辑器）') },
  { keys: ['E'], label: t('橡皮工具（编辑器）') },
  { keys: ['Ctrl', '滚轮'], label: t('编辑器缩放') },
  { keys: ['Shift', '滚轮'], label: t('编辑器横向平移') },
  { keys: ['Alt', '拖拽'], label: t('编辑器调整力度') },
  { keys: ['Shift', '拖拽'], label: t('吸附到音符（歌词/编辑器）') },
  { keys: ['Ctrl', '拖拽'], label: t('吸附到网格') },
];

/* ---------------- 初始化 ---------------- */
async function load() {
  let s = {};
  try { s = await settingsStore.load() || {}; } catch (e) {}
  let lsTheme = null, lsAccent = null;
  try { lsTheme = localStorage.getItem('fufumidi_theme'); lsAccent = localStorage.getItem('fufumidi_accent'); } catch (e) {}
  form.theme = lsTheme || s.theme || 'fufu';
  form.accent = lsAccent || s.accent || '';
  form.mode = loadMode();
  form.font_size = s.font_size || 'standard';
  form.density = s.density || 'comfortable';
  form.lang = getLang();
  form.engine_path = s.engine_path || '';
  form.engine_mode = s.engine_mode || 'universal';
  form.perf_mode = s.perf_mode || 'quality';
  form.batch_concurrency = s.batch_concurrency || 'auto';
  form.output_dir = s.output_dir || '';
  form.name_rule = s.name_rule || '{name}_{engine}_{date}';
  form.watch_dir = s.watch_dir || '';
  form.watch_enabled = !!s.watch_enabled;
  form.file_assoc = s.file_assoc !== false;
  if (state.integrity === null) runIntegrity();
  loadPlugins();
  loadRust();
  initGpu();
}

/* ---------------- 外观 ---------------- */
function applyDisplay(font, density) {
  if (typeof document === 'undefined') return;
  const fsMap = { standard: '', large: '15px', xlarge: '17px' };
  document.body.style.fontSize = fsMap[font] || '';
  document.body.dataset.density = density === 'compact' ? 'compact' : 'comfortable';
}
function onThemeChange() {
  applyTheme(form.theme, form.accent, form.mode);
  toast(t('已应用主题：') + t(themeById(form.theme).name));
}
function onModeChange() {
  setMode(form.mode);
  toast(t('已切换为') + (form.mode === 'dark' ? t('深色模式') : t('浅色模式')), 'ok');
}
function onAccentInput(e) { applyTheme(form.theme, e.target.value, form.mode); }
function resetAccent() { form.accent = ''; applyTheme(form.theme, '', form.mode); }
function onFontSize() { applyDisplay(form.font_size, form.density); }
function onDensity() { applyDisplay(form.font_size, form.density); }
function onLang() {
  setLang(form.lang);
  try { localStorage.setItem('fufumidi_lang', form.lang); } catch (e) {}
}

/* ---------------- 更新 ---------------- */
// 简化更新：只显示当前版本号 + 检查更新。检查到新版本 → 弹窗询问是否更新。
async function updLaunch() {
  if (!bridge || !bridge.updateCheck) { upd.status = '当前环境不支持检查更新'; return; }
  upd.status = '正在检查更新…';
  try {
    const r = await bridge.updateCheck();
    if (!r || !r.ok) { upd.status = (r && r.error) || '检查失败'; return; }
    const cur = String(r.current || '');
    const latest = String(r.latest || '');
    if (cur === latest) {
      upd.status = '已是最新版本（' + cur + '）';
      return;
    }
    if (!bridge.update || !bridge.update.launchUpdater) { upd.status = '当前环境不支持增量更新器'; return; }
    const ok = window.confirm(t('发现新版本 ') + latest + t('，当前 ') + cur + t('。\n是否启动更新器增量更新？'));
    if (!ok) { upd.status = '已取消'; return; }
    upd.status = '正在启动更新器…';
    const rr = await bridge.update.launchUpdater();
    if (rr && rr.ok) {
      upd.status = '更新器已启动，应用即将退出并更新…';
      setTimeout(() => { try { window.close(); } catch (e) {} }, 800);
    } else {
      upd.status = (rr && rr.error) || '启动失败';
    }
  } catch (e) {
    upd.status = '检查更新失败：' + ((e && e.message) || e);
  }
}

/* ---------------- GPU 加速 ---------------- */
const gpu = reactive({
  detect: null,        // {vendor,name,blackwell,needCu128,available,backend}
  installed: '检测中…',
  installedKind: null,
  busy: false,
  status: '',
  progress: null,
  progressText: '',
});
const gpuInstalled = computed(() => !!gpu.installedKind);
const gpuCard = computed(() => {
  const d = gpu.detect;
  if (!d) return t('检测中…');
  if (d.name) return d.name;
  if (d.vendor) return d.vendor.toUpperCase();
  return t('未检测到独立显卡');
});
const gpuRecommended = computed(() => {
  const d = gpu.detect;
  if (!d || !d.vendor) return t('不可用（CPU）');
  if (d.vendor === 'nvidia') return 'CUDA' + (d.needCu128 ? '（cu128 · RTX 50 系）' : '');
  if (d.vendor === 'amd' || d.vendor === 'intel') return 'DirectML';
  return t('不可用');
});

function gpuSetProgress(p, txt) {
  gpu.progress = p;
  gpu.progressText = txt || '';
}
async function gpuRefreshInstalled() {
  if (!bridge || !bridge.gpuStatus) { gpu.installed = t('未知'); return; }
  try {
    const r = await bridge.gpuStatus();
    if (r && r.ok) {
      if (r.cuda && r.directml) gpu.installed = 'CUDA + DirectML 已安装';
      else if (r.cuda) gpu.installed = 'CUDA 已安装';
      else if (r.directml) gpu.installed = 'DirectML 已安装';
      else gpu.installed = t('未安装');
      gpu.installedKind = r.cuda ? 'cuda' : (r.directml ? 'directml' : null);
    } else { gpu.installed = t('未安装'); gpu.installedKind = null; }
  } catch (e) { gpu.installed = t('未知'); gpu.installedKind = null; }
}
async function gpuLoadDetect() {
  if (!bridge || !bridge.probe) { gpu.detect = null; return; }
  try {
    const r = await bridge.probe();
    const g = (r && r.gpu) || {};
    gpu.detect = { vendor: g.vendor || null, name: g.name || '', blackwell: !!g.blackwell, needCu128: !!g.need_cu128, available: !!g.available, backend: g.backend || '' };
  } catch (e) { gpu.detect = null; }
}
async function gpuAutoInstall() {
  if (!bridge || !bridge.gpuInstallAuto) { gpu.status = t('当前环境不支持安装 GPU 加速'); return; }
  gpu.busy = true;
  gpu.status = '';
  gpuSetProgress(0, t('正在检测显卡…'));
  const un = bridge.onGpuProgress ? bridge.onGpuProgress((p) => {
    if (!p) return;
    if (p.done) gpuSetProgress(100, t('安装完成'));
    else if (p.text) gpuSetProgress(gpu.progress || 2, p.text);
    else if (p.percent != null && p.percent >= 0) gpuSetProgress(p.percent, (p.percent) + '%');
  }) : null;
  try {
    const r = await bridge.gpuInstallAuto();
    if (r && r.ok) {
      gpu.status = r.already ? t('GPU 加速已安装（无需重复安装）') : t('GPU 加速安装完成');
      if (r.gpu) gpu.detect = r.gpu;
      if (r.already) gpuSetProgress(100, '');
    } else {
      gpu.status = t('安装失败：') + ((r && r.error) || t('未知'));
      if (r && r.gpu) gpu.detect = r.gpu;
      gpuSetProgress(null, '');
    }
    await gpuRefreshInstalled();
  } catch (e) {
    gpu.status = t('安装失败：') + String((e && e.message) || e);
    gpuSetProgress(null, '');
  } finally {
    if (un) un();
    gpu.busy = false;
  }
}
async function gpuImportLocal() {
  if (!bridge || !bridge.pickZip || !bridge.gpuImportLocal) { gpu.status = t('当前环境不支持本地导入'); return; }
  gpu.busy = true;
  try {
    const p = await bridge.pickZip();
    if (!p) return;
    gpu.status = t('正在导入本地包…');
    gpuSetProgress(1, t('正在导入…'));
    const r = await bridge.gpuImportLocal(p);
    gpu.status = (r && r.ok) ? t('本地包已导入隔离环境') : (t('导入失败：') + ((r && r.error) || t('未知')));
    gpuSetProgress(null, '');
    await gpuRefreshInstalled();
    await gpuLoadDetect();
  } catch (e) {
    gpu.status = t('导入失败：') + String((e && e.message) || e);
    gpuSetProgress(null, '');
  } finally {
    gpu.busy = false;
  }
}
async function gpuUninstall() {
  if (!bridge || !bridge.gpuUninstall) { gpu.status = t('当前环境不支持卸载'); return; }
  const kind = gpu.installedKind || 'directml';
  gpu.busy = true;
  gpu.status = t('正在卸载…');
  gpuSetProgress(10, t('正在卸载…'));
  try {
    const r = await bridge.gpuUninstall(kind);
    gpu.status = (r && r.ok) ? t('已卸载（不影响内置功能）') : (t('卸载失败：') + ((r && r.error) || t('未知')));
    gpuSetProgress(null, '');
    await gpuRefreshInstalled();
  } catch (e) {
    gpu.status = t('卸载失败：') + String((e && e.message) || e);
    gpuSetProgress(null, '');
  } finally {
    gpu.busy = false;
  }
}
function initGpu() {
  if (gpu._init) return;
  gpu._init = true;
  gpuRefreshInstalled();
  gpuLoadDetect();
}

/* ---------------- 功能 ---------------- */
async function pickDir(key) {
  if (!bridge || !bridge.pickDirectory) return;
  try {
    const p = await bridge.pickDirectory();
    if (p) form[key] = p;
  } catch (e) {}
}
function resetGuide() {
  try { localStorage.removeItem('fufumidi_guide_done'); } catch (e) {}
  if (bridge && bridge.saveSettings) bridge.saveSettings({ guide_done: false }).catch(() => {});
  state.ui.guideOpen = true;
}

/* ---------------- 快捷键 ---------------- */
function resetKeys() { toast(t('恢复默认快捷键')); }

/* ---------------- 可选 Rust 核心 ---------------- */
async function loadRust() {
  if (bridge && typeof bridge.rustStatus === 'function') {
    try {
      const r = await bridge.rustStatus();
      rustInfo.value = { available: !!(r && r.available), version: (r && r.version) || '', binary: (r && r.binary) || null };
    } catch (e) {}
  }
}

/* ---------------- 插件 ---------------- */
async function loadPlugins() {
  if (!bridge || !bridge.plugins) return;
  try { plugins.value = await bridge.plugins.list() || []; } catch (e) { plugins.value = []; }
}
async function togglePlugin(p) {
  if (!bridge || !bridge.plugins) return;
  try { await bridge.plugins.setEnabled(p.id, p.enabled); } catch (e) { p.enabled = !p.enabled; }
}
async function rescanPlugins() {
  if (!bridge || !bridge.plugins) return;
  try { plugins.value = await bridge.plugins.rescan() || []; } catch (e) {}
}
function openDocs() { if (bridge && bridge.plugins && bridge.plugins.openDocs) bridge.plugins.openDocs(); }
function openPluginDir() { if (bridge && bridge.plugins && bridge.plugins.openDir) bridge.plugins.openDir(); }
function onPluginLog(p) {
  const line = p && p.line != null ? String(p.line) : JSON.stringify(p || '');
  pluginLog.value = line + '\n' + pluginLog.value;
  if (pluginLog.value.length > 4000) pluginLog.value = pluginLog.value.slice(0, 4000);
}
function onFolderWatch(full) {
  toast(t('监视到新文件：') + String(full || '').split(/[\\/]/).pop());
}

/* ---------------- 完整性检验 ---------------- */
async function runIntegrity() {
  if (!bridge || !bridge.checkIntegrity) return;
  try {
    const r = await bridge.checkIntegrity();
    state.integrity = { ok: !!(r && r.ok), issues: (r && r.issues) || [], error: (r && r.error) || '' };
  } catch (e) { state.integrity = { ok: true, issues: [], error: String(e.message || e) }; }
}
async function repairIntegrity() {
  const issues = (state.integrity && state.integrity.issues || []).filter(i => i.canRepair !== false);
  if (!issues.length || !bridge || !bridge.repairIntegrity) return;
  try {
    await bridge.repairIntegrity(issues.map(i => i.id));
    toast(t('修复完成'));
  } catch (e) { toast(t('修复失败：') + String(e.message || e), 'error'); }
  runIntegrity();
}
const integrityOk = computed(() => !!(state.integrity && state.integrity.ok));

/* ---------------- 保存 / 取消 ---------------- */
function apply() {
  saveTheme(form.theme, form.accent, form.mode);
  applyDisplay(form.font_size, form.density);
  setLang(form.lang);
  try {
    localStorage.setItem('fufumidi_lang', form.lang);
    localStorage.setItem('fufumidi_font', form.font_size);
    localStorage.setItem('fufumidi_density', form.density);
  } catch (e) {}
  const payload = {
    theme: form.theme, accent: form.accent, ui_mode: form.mode,
    font_size: form.font_size, density: form.density, lang: form.lang,
    engine_path: form.engine_path, engine_mode: form.engine_mode,
    perf_mode: form.perf_mode, batch_concurrency: form.batch_concurrency,
    batch_concurrency_manual: form.batch_concurrency !== 'auto',
    output_dir: form.output_dir, name_rule: form.name_rule,
    watch_dir: form.watch_dir, watch_enabled: form.watch_enabled,
    file_assoc: form.file_assoc,
  };
  let saved = false;
  settingsStore.save(payload).then(() => { if (!saved) toast(t('设置已保存')); }).catch(() => toast(t('设置保存失败'), 'error'));
  saved = true;
  // 监视文件夹（立即应用）
  if (bridge && bridge.setFolderWatch) {
    bridge.setFolderWatch(form.watch_dir, form.watch_enabled).catch(() => {});
  }
  // MIDI 文件关联（Windows 注册表，立即应用）
  if (bridge && bridge.fileAssoc) {
    bridge.fileAssoc(form.file_assoc).catch(() => {});
  }
  if (!saved) toast(t('设置已保存（仅本次会话）'));
  state.ui.settingsOpen = false;
}
function cancel() { state.ui.settingsOpen = false; }

/* ---------------- 生命周期 ---------------- */
watch(() => state.ui.settingsTab, v => {
  if (TABS.some(t => t.id === v)) tab.value = v;
});
let offWatch = null, offPlgLog = null;
onMounted(() => {
  load();
  moveInd();
  if (bridge && bridge.onFolderWatch) offWatch = bridge.onFolderWatch(onFolderWatch);
  if (bridge && bridge.plugins && bridge.plugins.onLog) offPlgLog = bridge.plugins.onLog(onPluginLog);
});
onBeforeUnmount(() => { try { offWatch && offWatch(); } catch (e) {} try { offPlgLog && offPlgLog(); } catch (e) {} });
</script>

<template>
  <div class="overlay" v-focus-trap role="dialog" aria-modal="true" :aria-label="t('设置')" @click.self="cancel" @keydown.esc="cancel">
    <div class="overlay-card settings-card">
      <div class="settings-head">
        <Icon name="gear" :size="17" />
        <span class="settings-title">{{ t('应用设置') }}</span>
      </div>

      <div class="settings-tabs" ref="tabsRef">
        <span class="settings-ind" :style="{ transform: `translateX(${ind.x}px)`, width: ind.w + 'px' }"></span>
        <button class="ov-tab" v-for="tb in TABS" :key="tb.id" :class="{ active: tab === tb.id }" @click="tab = tb.id">
          {{ t(tb.label) }}
        </button>
      </div>

      <!-- 完整性检验警告条 -->
      <div class="integrity-bar" v-if="state.integrity && !state.integrity.ok">
        <div class="integrity-head">
          <Icon name="info" :size="14" />
          <span class="integrity-title">{{ t('完整性检查发现以下问题') }}（{{ state.integrity.issues.length }}）</span>
          <button class="btn sm danger" @click="repairIntegrity">{{ t('一键修复') }}</button>
        </div>
        <div class="integrity-list">
          <div v-for="iss in state.integrity.issues" :key="iss.id">
            · {{ iss.id }} <i v-if="iss.path">{{ iss.path }}</i>
          </div>
        </div>
      </div>
      <div class="integrity-ok" v-else-if="state.integrity && state.integrity.ok">
        <span style="color:var(--success-text)">✓</span> {{ t('没有问题，一切正常') }}
      </div>

      <div class="settings-body">
        <!-- ============ 外观 ============ -->
        <div v-if="tab === 'appearance'">
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('界面模式') }}</div>
              <div class="fr-hint">{{ t('浅色明亮 · 深色护眼') }}</div>
            </div>
            <div class="fr-ctl">
              <div class="radio-pill">
                <span :class="{ on: form.mode === 'light' }" @click="form.mode = 'light'; onModeChange()">{{ t('浅色') }}</span>
                <span :class="{ on: form.mode === 'dark' }" @click="form.mode = 'dark'; onModeChange()">{{ t('深色') }}</span>
              </div>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('界面主题') }}</div>
              <div class="fr-hint">{{ t('从主题库选择，或在此切换') }}</div>
            </div>
            <div class="fr-ctl">
              <select v-model="form.theme" class="ov-input" style="width:150px" @change="onThemeChange">
                <option v-for="th in themeOpts" :key="th.id" :value="th.id">{{ t(th.name) }}</option>
              </select>
              <button class="btn sm" @click="state.ui.themesOpen = true">🎨 {{ t('主题库') }}</button>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('动态壁纸') }}</div>
              <div class="fr-hint">{{ t('从壁纸库下载视频作为背景，或导入本地视频') }}</div>
            </div>
            <div class="fr-ctl">
              <button class="btn sm" @click="state.ui.wallpaperOpen = true">🖼 {{ t('壁纸库') }}</button>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('强调色') }}</div>
              <div class="fr-hint">{{ t('自定义主题的主色调') }}</div>
            </div>
            <div class="fr-ctl">
              <input type="color" class="ov-input" v-model="form.accent" @input="onAccentInput" />
              <button class="btn sm" @click="resetAccent">{{ t('还原默认') }}</button>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('界面字号') }}</div>
              <div class="fr-hint">{{ t('标准 / 大 / 超大') }}</div>
            </div>
            <div class="fr-ctl">
              <div class="radio-pill">
                <span :class="{ on: form.font_size === 'standard' }" @click="form.font_size = 'standard'; onFontSize()">{{ t('标准') }}</span>
                <span :class="{ on: form.font_size === 'large' }" @click="form.font_size = 'large'; onFontSize()">{{ t('大') }}</span>
                <span :class="{ on: form.font_size === 'xlarge' }" @click="form.font_size = 'xlarge'; onFontSize()">{{ t('超大') }}</span>
              </div>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('界面密度') }}</div>
              <div class="fr-hint">{{ t('控件与间距紧凑度') }}</div>
            </div>
            <div class="fr-ctl">
              <div class="radio-pill">
                <span :class="{ on: form.density === 'compact' }" @click="form.density = 'compact'; onDensity()">{{ t('紧凑') }}</span>
                <span :class="{ on: form.density === 'comfortable' }" @click="form.density = 'comfortable'; onDensity()">{{ t('舒适') }}</span>
              </div>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('界面语言') }}</div>
              <div class="fr-hint">Language</div>
            </div>
            <div class="fr-ctl">
              <div class="radio-pill">
                <span :class="{ on: form.lang === 'zh' }" @click="form.lang = 'zh'; onLang()">{{ t('中文') }}</span>
                <span :class="{ on: form.lang === 'en' }" @click="form.lang = 'en'; onLang()">English</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ============ GPU 加速 ============ -->
        <div v-else-if="tab === 'gpu'">
          <p class="ov-note">{{ t('一键自动检测显卡并安装对应的 GPU 加速（NVIDIA → CUDA，AMD/Intel → DirectML）。安装后转录与分离任务将明显提速。') }}</p>
          <div class="gpu-panel">
            <div class="gpu-detect">
              <div class="gpu-row"><span class="gpu-k">{{ t('显卡') }}</span><span class="gpu-v">{{ gpuCard }}</span></div>
              <div class="gpu-row"><span class="gpu-k">{{ t('推荐加速') }}</span><span class="gpu-v">{{ gpuRecommended }}</span></div>
              <div class="gpu-row"><span class="gpu-k">{{ t('安装状态') }}</span><span class="gpu-v">{{ gpu.installed }}</span></div>
              <div v-if="gpu.detect && gpu.detect.needCu128" class="gpu-warn">{{ t('检测到 RTX 50 系（Blackwell）显卡，将自动安装 CUDA 12.8（cu128）加速包') }}</div>
            </div>
            <button class="btn primary gpu-install" @click="gpuAutoInstall" :disabled="gpu.busy">
              {{ gpu.busy ? t('正在安装…') : (gpuInstalled ? t('GPU 加速已安装 · 点击重装/升级') : t('安装 GPU 加速')) }}
            </button>
            <div v-if="gpu.status" class="gpu-status">{{ gpu.status }}</div>
            <div v-if="gpu.progress != null" class="gpu-prog">
              <div style="height:8px;background:var(--surface-soft);border-radius:999px;overflow:hidden;border:1px solid var(--hairline)">
                <div style="height:100%;width:0%;background:linear-gradient(90deg,#4f94e0,#8fc0f0);transition:width .2s" :style="{ width: Math.min(100, (gpu.progress || 0)) + '%' }"></div>
              </div>
              <div class="gpu-prog-text">{{ gpu.progressText }}</div>
            </div>
            <div class="gpu-extra">
              <button class="btn sm" @click="gpuImportLocal" :disabled="gpu.busy">{{ t('本地导入 ZIP') }}</button>
              <button v-if="gpuInstalled" class="btn sm danger" @click="gpuUninstall" :disabled="gpu.busy">{{ t('卸载') }}</button>
            </div>
          </div>
        </div>

        <!-- ============ 功能 ============ -->
        <div v-else-if="tab === 'feature'">
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('默认引擎模式') }}</div>
              <div class="fr-hint">{{ t('转录新音频时默认使用的识别引擎') }}</div>
            </div>
            <div class="fr-ctl">
              <select v-model="form.engine_mode" class="ov-input" style="width:200px">
                <option value="universal">{{ t('通用识别（basic_pitch）') }}</option>
                <option value="piano">{{ t('钢琴专用（piano_transcription）') }}</option>
                <option value="separate">{{ t('人声分离（demucs）') }}</option>
              </select>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('默认性能模式') }}</div>
              <div class="fr-hint">{{ t('质量越高耗时越长') }}</div>
            </div>
            <div class="fr-ctl">
              <select v-model="form.perf_mode" class="ov-input" style="width:200px">
                <option value="quality">{{ t('最高质量') }}</option>
                <option value="balanced">{{ t('均衡') }}</option>
                <option value="fast">{{ t('高性能') }}</option>
              </select>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('默认输出目录') }}</div>
              <div class="fr-hint">{{ t('转录结果的保存位置') }}</div>
            </div>
            <div class="fr-ctl">
              <input v-model="form.output_dir" class="ov-input mono" style="width:240px" :placeholder="t('留空 = 系统临时目录')" />
              <button class="btn sm" @click="pickDir('output_dir')">{{ t('浏览') }}</button>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('导出命名规则') }}</div>
              <div class="fr-hint">{{ t('{name}_{engine}_{date} · 可自定义') }}</div>
            </div>
            <div class="fr-ctl">
              <input v-model="form.name_rule" class="ov-input mono" style="width:240px" placeholder="{name}_{engine}_{date}" />
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('批量并发转录') }}</div>
              <div class="fr-hint">{{ t('同时处理的任务数，低配建议 1') }}</div>
            </div>
            <div class="fr-ctl">
              <select v-model="form.batch_concurrency" class="ov-input" style="width:160px">
                <option value="auto">{{ t('自动（推荐）') }}</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="4">4</option>
              </select>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('监视文件夹') }}</div>
              <div class="fr-hint">{{ t('放入音频自动加入转录队列') }}</div>
            </div>
            <div class="fr-ctl" style="flex-wrap:wrap">
              <input v-model="form.watch_dir" class="ov-input mono" style="width:200px" :placeholder="t('选择要监视的文件夹')" />
              <button class="btn sm" @click="pickDir('watch_dir')">{{ t('浏览') }}</button>
              <label class="switch-row">
                <input type="checkbox" v-model="form.watch_enabled" />
                <span></span>
              </label>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('新手引导') }}</div>
              <div class="fr-hint">{{ t('重新观看首次启动引导') }}</div>
            </div>
            <div class="fr-ctl">
              <button class="btn sm danger" @click="resetGuide">{{ t('重置引导') }}</button>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('可选 Rust 核心') }}</div>
              <div class="fr-hint">{{ rustInfo.available ? ('v' + rustInfo.version + ' · ' + (rustInfo.binary || '')) : t('未编译/未安装，自动使用 Python + Electron 模式') }}</div>
            </div>
            <div class="fr-ctl">
              <span :class="['plg-tag', rustInfo.available ? 'on' : 'off']">{{ rustInfo.available ? t('已启用') : t('未启用') }}</span>
            </div>
          </div>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('MIDI 文件关联') }}</div>
              <div class="fr-hint">{{ t('双击 .mid / .midi 文件时自动用 FuFumidi 打开') }}</div>
            </div>
            <div class="fr-ctl">
              <label class="switch-row">
                <input type="checkbox" v-model="form.file_assoc" />
                <span></span>
              </label>
            </div>
          </div>
        </div>

        <!-- ============ 快捷键 ============ -->
        <div v-else-if="tab === 'keys'">
          <p class="ov-note">{{ t('点击右侧快捷键可重新录制；按 Esc 取消，修改自动保存。') }}</p>
          <div class="kbd-row" v-for="k in KEYMAP" :key="k.keys.join('+')">
            <b>{{ k.label }}</b>
            <div class="kbd-keys">
              <span class="kbd-key" v-for="key in k.keys" :key="key">{{ key }}</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;margin-top:12px">
            <button class="btn sm" @click="resetKeys">{{ t('恢复默认快捷键') }}</button>
          </div>
        </div>

        <!-- ============ 插件 ============ -->
        <div v-else-if="tab === 'plugins'">
          <p class="ov-note">
            {{ t('插件用于扩展 FuFumidi 功能：将插件目录放入') }} <b>{{ t('用户目录/fufumidi/plugins/<插件名>/') }}</b>
            {{ t('，内含 plugin.json 清单与入口脚本，重载后即可在此启用。插件由你主动安装并运行，等同于本地可信代码。') }}
          </p>
          <div class="plg-head">
            <span>{{ t('已安装插件') }}（{{ plugins.length }}）</span>
            <button class="btn sm" @click="rescanPlugins">{{ t('重新扫描') }}</button>
          </div>
          <div v-if="!plugins.length" class="state-box">{{ t('无') }}</div>
          <div class="plg-item" v-for="p in plugins" :key="p.id">
            <div class="plg-info">
              <b>{{ p.name }} <span class="muted small">v{{ p.version }}</span></b>
              <small>{{ p.description || p.id }}</small>
            </div>
            <span :class="['plg-tag', p.enabled ? 'on' : 'off']">{{ p.enabled ? t('已启用') : t('已禁用') }}</span>
            <label class="switch-row">
              <input type="checkbox" :checked="p.enabled" @change="e => { p.enabled = e.target.checked; togglePlugin(p); }" />
              <span></span>
            </label>
          </div>
          <div class="plg-head">{{ t('插件日志') }}</div>
          <div class="plg-log">{{ pluginLog || t('无') }}</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn sm" @click="openPluginDir">{{ t('打开插件目录') }}</button>
            <a class="plg-docs" @click="openDocs">{{ t('开发者文档') }} ↗</a>
          </div>
        </div>

        <!-- ============ 更新 ============ -->
        <div v-else-if="tab === 'update'">
          <p class="ov-note">{{ t('检查更新：发现新版本后弹窗询问，确认后增量下载并自动替换。') }}</p>
          <div class="field-row">
            <div>
              <div class="fr-label">{{ t('当前版本') }}</div>
              <div class="fr-hint">{{ appVersion }}</div>
            </div>
            <div class="fr-ctl">
              <button class="btn sm primary" @click="updLaunch">{{ t('检查更新') }}</button>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
            <span style="font-size:12px;color:var(--stone)">{{ upd.status }}</span>
          </div>
        </div>
      </div>

      <div class="settings-foot">
        <button class="btn" @click="cancel">{{ t('取消') }}</button>
        <button class="btn primary" @click="apply">{{ t('保存') }}</button>
      </div>
    </div>
  </div>
</template>

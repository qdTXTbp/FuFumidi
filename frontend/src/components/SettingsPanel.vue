<script setup>
// 设置面板（全局系统功能）：外观 / 引擎 / 功能 / 快捷键 / 插件 + 完整性检验警告条
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { state, toast } from '../store.js';
import { t, setLang, getLang } from '../core/i18n.js';
import { THEMES, themeById, applyTheme, saveTheme } from '../core/theme.js';

const bridge = window.fuBridge;

const TABS = [
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'engine', label: '引擎', icon: 'zap' },
  { id: 'feature', label: '功能', icon: 'folder' },
  { id: 'keys', label: '快捷键', icon: 'kbd' },
  { id: 'plugins', label: '插件', icon: 'spark' },
];
const tab = ref('appearance');

/* ---------------- 表单 ---------------- */
const form = reactive({
  theme: 'fufu', accent: '',
  font_size: 'standard', density: 'comfortable', lang: 'zh',
  engine_path: '', engine_mode: 'universal',
  output_dir: '', name_rule: '', watch_dir: '', watch_enabled: false, file_assoc: true,
});

const isCustomTheme = computed(() => !THEMES.some(x => x.id === form.theme));
const themeOpts = computed(() => {
  const list = THEMES.slice();
  if (isCustomTheme.value) list.push({ id: form.theme, name: t('自定义主题'), desc: '' });
  return list;
});

/* ---------------- 引擎状态 ---------------- */
const pyState = reactive({ busy: false, text: '' });
const models = ref([]);
const depState = reactive({ busy: false, text: '' });
const depBusy = ref(false);

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
];

/* ---------------- 初始化 ---------------- */
async function load() {
  let s = {};
  if (bridge && bridge.getSettings) { try { s = await bridge.getSettings() || {}; } catch (e) {} }
  let lsTheme = null, lsAccent = null;
  try { lsTheme = localStorage.getItem('fufumidi_theme'); lsAccent = localStorage.getItem('fufumidi_accent'); } catch (e) {}
  form.theme = lsTheme || s.theme || 'fufu';
  form.accent = lsAccent || s.accent || '';
  form.font_size = s.font_size || 'standard';
  form.density = s.density || 'comfortable';
  form.lang = getLang();
  form.engine_path = s.engine_path || '';
  form.engine_mode = s.engine_mode || 'universal';
  form.output_dir = s.output_dir || '';
  form.name_rule = s.name_rule || '{name}_{engine}_{date}';
  form.watch_dir = s.watch_dir || '';
  form.watch_enabled = !!s.watch_enabled;
  form.file_assoc = s.file_assoc !== false;
  if (state.integrity === null) runIntegrity();
  refreshModels();
  loadPlugins();
}

/* ---------------- 外观 ---------------- */
function applyDisplay(font, density) {
  if (typeof document === 'undefined') return;
  const fsMap = { standard: '', large: '15px', xlarge: '17px' };
  document.body.style.fontSize = fsMap[font] || '';
  document.body.dataset.density = density === 'compact' ? 'compact' : 'comfortable';
}
function onThemeChange() {
  applyTheme(form.theme, form.accent);
  toast(t('已应用主题：') + t(themeById(form.theme).name));
}
function onAccentInput(e) { applyTheme(form.theme, e.target.value); }
function resetAccent() { form.accent = ''; applyTheme(form.theme, ''); }
function onFontSize() { applyDisplay(form.font_size, form.density); }
function onDensity() { applyDisplay(form.font_size, form.density); }
function onLang() {
  setLang(form.lang);
  try { localStorage.setItem('fufumidi_lang', form.lang); } catch (e) {}
}

/* ---------------- 引擎 ---------------- */
function autoPy() {
  form.engine_path = '';
  pyState.text = t('已清空路径，将使用自动检测 / 内置运行时');
}
async function testEngine() {
  if (!bridge || !bridge.probe) { pyState.text = t('引擎异常：') + 'no bridge'; return; }
  pyState.busy = true;
  pyState.text = t('正在检查…');
  try {
    const r = await bridge.probe();
    if (r && r.ok) pyState.text = t('引擎正常：') + (r.python || r.version || '');
    else pyState.text = t('引擎异常：') + (r && (r.error || r.raw || JSON.stringify(r)) || 'unknown');
  } catch (e) { pyState.text = t('引擎异常：') + String(e.message || e); }
  pyState.busy = false;
}
async function refreshModels() {
  if (bridge && bridge.modelList) { try { models.value = await bridge.modelList() || []; } catch (e) { models.value = []; } }
}
function fmtSize(b) {
  if (!b) return '—';
  if (b > 1 << 30) return (b / (1 << 30)).toFixed(1) + ' GB';
  if (b > 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}
async function checkDeps() {
  if (!bridge || !bridge.depCheck) return;
  depBusy.value = true;
  depState.text = t('正在检查…');
  try {
    const r = await bridge.depCheck();
    if (r && r.ok) depState.text = t('依赖检查通过');
    else depState.text = t('依赖检查异常：') + String((r && (r.error || r.raw)) || 'unknown').slice(-400);
  } catch (e) { depState.text = t('依赖检查异常：') + String(e.message || e); }
  depBusy.value = false;
}
async function installDeps() {
  if (!bridge || !bridge.depInstall) return;
  depBusy.value = true;
  depState.text = t('正在安装（国内镜像优先）…');
  try {
    const r = await bridge.depInstall('all');
    if (r && r.ok) depState.text = t('依赖安装完成');
    else depState.text = t('依赖安装失败：') + String((r && (r.error || r.raw)) || 'unknown').slice(-400);
  } catch (e) { depState.text = t('依赖安装失败：') + String(e.message || e); }
  depBusy.value = false;
}
async function exportDiag() {
  if (!bridge || !bridge.diagExport) return;
  try {
    const r = await bridge.diagExport();
    if (r && r.canceled) toast(t('导出已取消'));
    else if (r && r.ok) toast(t('诊断包已导出'));
    else toast(t('导出失败：') + String((r && r.error) || 'unknown'), 'error');
  } catch (e) { toast(t('导出失败：') + String(e.message || e), 'error'); }
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
  saveTheme(form.theme, form.accent);
  applyDisplay(form.font_size, form.density);
  setLang(form.lang);
  try {
    localStorage.setItem('fufumidi_lang', form.lang);
    localStorage.setItem('fufumidi_font', form.font_size);
    localStorage.setItem('fufumidi_density', form.density);
  } catch (e) {}
  const payload = {
    theme: form.theme, accent: form.accent,
    font_size: form.font_size, density: form.density, lang: form.lang,
    engine_path: form.engine_path, engine_mode: form.engine_mode,
    output_dir: form.output_dir, name_rule: form.name_rule,
    watch_dir: form.watch_dir, watch_enabled: form.watch_enabled,
    file_assoc: form.file_assoc,
  };
  let saved = false;
  if (bridge && bridge.saveSettings) {
    bridge.saveSettings(payload).then(() => { if (!saved) toast(t('设置已保存')); }).catch(() => toast(t('设置保存失败'), 'error'));
    saved = true;
  }
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
let offWatch = null, offPlgLog = null;
onMounted(() => {
  load();
  if (bridge && bridge.onFolderWatch) offWatch = bridge.onFolderWatch(onFolderWatch);
  if (bridge && bridge.plugins && bridge.plugins.onLog) offPlgLog = bridge.plugins.onLog(onPluginLog);
});
onBeforeUnmount(() => { try { offWatch && offWatch(); } catch (e) {} try { offPlgLog && offPlgLog(); } catch (e) {} });
</script>

<template>
  <div class="overlay" @click.self="cancel">
    <div class="overlay-card settings-card">
      <div class="settings-head">
        <Icon name="gear" :size="17" />
        <span class="settings-title">{{ t('应用设置') }}</span>
      </div>

      <div class="settings-tabs">
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

        <!-- ============ 引擎 ============ -->
        <div v-else-if="tab === 'engine'">
          <div class="field-row top">
            <div>
              <div class="fr-label">{{ t('Python 解释器路径') }}</div>
              <div class="fr-hint">{{ t('依赖本地 Python（librosa / torch / demucs）') }}</div>
            </div>
            <div class="fr-ctl col">
              <input v-model="form.engine_path" class="ov-input mono" style="width:300px" :placeholder="t('留空 = 自动检测')" />
              <div style="display:flex;gap:6px">
                <button class="btn sm" @click="autoPy">{{ t('自动检测') }}</button>
                <button class="btn sm" @click="testEngine" :disabled="pyState.busy">{{ t('测试引擎') }}</button>
              </div>
              <div class="state-box" v-if="pyState.text">{{ pyState.text }}</div>
            </div>
          </div>
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
          <div class="field-row top">
            <div style="flex:none">
              <div class="fr-label">{{ t('内置模型') }}</div>
              <div class="fr-hint">{{ t('模型清单；量化缺失自动回退原始模型') }}</div>
            </div>
            <div class="fr-ctl col stretch">
              <div class="state-box" v-if="models.length">
                <div class="model-item" v-for="m in models" :key="m.name">
                  <span class="mi-name">{{ m.name }}</span>
                  <span class="mi-note">{{ m.note }}</span>
                  <span class="mi-size">{{ fmtSize(m.size) }}</span>
                  <span :class="m.exists ? 'mi-ok' : 'mi-missing'">{{ m.exists ? t('已就绪') : t('缺失') }}</span>
                </div>
              </div>
              <button class="btn sm" @click="refreshModels">{{ t('刷新模型清单') }}</button>
            </div>
          </div>
          <div class="field-row top">
            <div style="flex:none">
              <div class="fr-label">{{ t('运行期依赖') }}</div>
              <div class="fr-hint">{{ t('缺失时自动检测并一键补全（国内镜像优先）') }}</div>
            </div>
            <div class="fr-ctl col stretch">
              <div class="state-box" v-if="depState.text">{{ depState.text }}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="btn sm" @click="checkDeps" :disabled="depBusy">{{ t('检查依赖') }}</button>
                <button class="btn sm primary" @click="installDeps" :disabled="depBusy">{{ t('一键补全缺失依赖') }}</button>
                <button class="btn sm" @click="exportDiag">{{ t('导出诊断包') }}</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ============ 功能 ============ -->
        <div v-else-if="tab === 'feature'">
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
          <a class="plg-docs" @click="openDocs">{{ t('开发者文档') }} ↗</a>
        </div>
      </div>

      <div class="settings-foot">
        <button class="btn" @click="cancel">{{ t('取消') }}</button>
        <button class="btn primary" @click="apply">{{ t('保存') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
// 资源中心：Python 依赖 / 模型运行时 / 模型文件 / 诊断与配置
// - Python 依赖：程序运行所需包（universal 组）
// - 模型运行时：模型推理所需包（piano / separate / muscriptor / aria / transkun 组）+ Rust 核心
// - 模型文件：内置模型清单（权重状态 + 运行时包状态，缺包可一键安装）
// - 诊断与配置：诊断包导出、配置导入导出
import { ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ViewModels from './ViewModels.vue';
import ViewSoundfonts from './ViewSoundfonts.vue';
import UtauVoicebankStore from '../components/utau/UtauVoicebankStore.vue';
import { useAppStore } from '../stores/app';
import { useSettingsStore } from '../stores/settings';
import { t } from '../core/i18n.js';

const route = useRoute();
const router = useRouter();
const rcTabs = ['model', 'soundfonts', 'resources'];
const rcTab = ref(rcTabs.includes(String(route.query.tab || '')) ? String(route.query.tab) : 'model'); // 'model' | 'soundfonts' | 'resources'
function selectRc(id) {
  rcTab.value = id;
  router.replace({ query: { ...route.query, tab: id } });
}
watch(() => route.query.tab, (v) => {
  const id = String(v || '');
  if (rcTabs.includes(id)) rcTab.value = id;
});

const app = useAppStore();
const toast = (m, type) => app.toast(m, type);
const settingsStore = useSettingsStore();
const bridge = window.fuBridge;

/* ---------------- 检查结果弹窗 ---------------- */
const resultOpen = ref(false);
const resultTitle = ref('');
const resultText = ref('');
const checking = ref(false);
const busyText = ref(t('正在检查…'));
function showResult(title, text) {
  resultTitle.value = title;
  resultText.value = text || t('无结果');
  checking.value = false;
  resultOpen.value = true;
}
function beginCheck(title, busy) {
  resultTitle.value = title;
  resultText.value = '';
  checking.value = true;
  busyText.value = busy || t('正在检查…');
  resultOpen.value = true;
}
function fmtGroups(groups, names) {
  const lines = [];
  for (const g of names) {
    const info = groups && groups[g];
    if (!info) { lines.push('[' + g + '] ' + t('未知')); continue; }
    if (info.ok) { lines.push('[' + g + '] ' + t('通过')); continue; }
    const parts = [];
    if (info.missing && info.missing.length) parts.push(t('缺失：') + info.missing.join(', '));
    if (info.broken && info.broken.length) parts.push(t('已损坏（可点「补全」重装）：') + info.broken.join(', '));
    lines.push('[' + g + '] ' + (parts.join('；') || t('未知')));
  }
  return lines.join('\n');
}

// 转录模型运行时的依赖组定义（组 → 依赖包说明）
const MODEL_DEP_GROUPS = [
  { id: 'piano', label: '钢琴转录（piano_transcription_inference + torch）' },
  { id: 'separate', label: '人声分离（demucs + torch）' },
  { id: 'muscriptor', label: 'MuScriptor 通用转录（muscriptor）' },
  { id: 'aria', label: 'Aria-AMT 钢琴（ariautils）' },
  { id: 'transkun', label: 'Transkun 钢琴（transkun）' },
];
const MODEL_DEP_LABEL = Object.fromEntries(MODEL_DEP_GROUPS.map(g => [g.id, g.label]));
function fmtGroupsPretty(groups, names) {
  const lines = [];
  for (const g of names) {
    const info = groups && groups[g];
    const label = t(MODEL_DEP_LABEL[g] || g);
    if (!info) { lines.push('[' + label + '] ' + t('未知')); continue; }
    if (info.ok) { lines.push('[' + label + '] ' + t('通过')); continue; }
    const parts = [];
    if (info.missing && info.missing.length) parts.push(t('缺失：') + info.missing.join(', '));
    if (info.broken && info.broken.length) parts.push(t('已损坏（可点「补全」重装）：') + info.broken.join(', '));
    lines.push('[' + label + '] ' + (parts.join('；') || t('未知')));
  }
  return lines.join('\n');
}

/* ---------------- Python 依赖（程序运行包） ---------------- */
const enginePath = ref('');
const pyState = reactive({ busy: false, text: '' });
const rtBusy = ref(false);
const pyBusy = ref(false);

async function loadPath() {
  try {
    const s = await settingsStore.load() || {};
    enginePath.value = s.engine_path || '';
  } catch (e) {}
}
function savePath() {
  settingsStore.save({ engine_path: enginePath.value }).catch(() => {});
}
function autoPy() {
  enginePath.value = '';
  savePath();
}
async function testEngine() {
  if (!bridge || !bridge.probe) { showResult(t('测试引擎'), t('引擎异常：') + 'no bridge'); return; }
  pyState.busy = true;
  beginCheck(t('测试引擎'));
  try {
    const r = await bridge.probe();
    if (r && r.ok) resultText.value = t('引擎正常：') + (r.python || r.version || '');
    else resultText.value = t('引擎异常：') + (r && (r.error || r.raw || JSON.stringify(r)) || 'unknown');
  } catch (e) { resultText.value = t('引擎异常：') + String(e.message || e); }
  checking.value = false;
  pyState.busy = false;
}
// 检查程序运行所需包（universal 组）
async function checkRuntime() {
  if (!bridge || !bridge.depCheck) { showResult(t('检查 Python 依赖'), t('当前环境不支持检查依赖')); return; }
  rtBusy.value = true;
  beginCheck(t('检查 Python 依赖'));
  try {
    const r = await bridge.depCheck();
    if (r && r.result && r.result.groups) resultText.value = fmtGroups(r.result.groups, ['universal']);
    else resultText.value = String((r && (r.error || r.raw)) || 'unknown').slice(-600);
  } catch (e) { resultText.value = t('依赖检查异常：') + String(e.message || e); }
  checking.value = false;
  rtBusy.value = false;
}
// 补全程序运行所需包
async function installRuntime() {
  if (!bridge || !bridge.depInstall) { showResult(t('补全 Python 依赖'), t('当前环境不支持安装依赖')); return; }
  pyBusy.value = true;
  beginCheck(t('补全 Python 依赖'), t('正在安装…'));
  try {
    const r = await bridge.depInstall('universal');
    if (r && r.ok) resultText.value = t('依赖安装完成');
    else resultText.value = t('依赖安装失败：') + String((r && (r.error || r.raw)) || 'unknown').slice(-600);
  } catch (e) { resultText.value = t('依赖安装失败：') + String(e.message || e); }
  checking.value = false;
  pyBusy.value = false;
}

/* ---------------- 模型运行时（模型推理包 + Rust 核心） ---------------- */
const modelBusy = ref(false);
const modelInstallBusy = ref(false);
const rustInfo = ref({ available: false, version: '', binary: null });

// 检查模型运行所需包（钢琴 / 分离 / MuScriptor / Aria / Transkun 组）
const MODEL_GROUP_IDS = MODEL_DEP_GROUPS.map(g => g.id);
async function checkModels() {
  if (!bridge || !bridge.depCheck) { showResult(t('检查模型依赖'), t('当前环境不支持检查依赖')); return; }
  modelBusy.value = true;
  beginCheck(t('检查模型依赖'));
  try {
    const r = await bridge.depCheck();
    if (r && r.result && r.result.groups) resultText.value = fmtGroupsPretty(r.result.groups, MODEL_GROUP_IDS);
    else resultText.value = String((r && (r.error || r.raw)) || 'unknown').slice(-600);
  } catch (e) { resultText.value = t('依赖检查异常：') + String(e.message || e); }
  checking.value = false;
  modelBusy.value = false;
}
// 补全模型运行所需包（全部转录模型组）
async function installModels() {
  if (!bridge || !bridge.depInstall) { showResult(t('补全模型依赖'), t('当前环境不支持安装依赖')); return; }
  modelInstallBusy.value = true;
  beginCheck(t('补全模型依赖'), t('正在安装…'));
  const parts = [];
  try {
    for (const g of MODEL_GROUP_IDS) {
      resultText.value = parts.length
        ? parts.join('\n') + '\n' + t('正在安装：') + t(MODEL_DEP_LABEL[g] || g) + '…'
        : t('正在安装：') + t(MODEL_DEP_LABEL[g] || g) + '…';
      const r = await bridge.depInstall(g);
      parts.push('[' + t(MODEL_DEP_LABEL[g] || g) + '] ' + ((r && r.ok) ? t('完成') : t('失败：') + String((r && (r.error || r.raw)) || 'unknown')));
      resultText.value = parts.join('\n');
    }
    refreshModels();
  } catch (e) { parts.push(t('依赖安装失败：') + String(e.message || e)); resultText.value = parts.join('\n'); }
  checking.value = false;
  modelInstallBusy.value = false;
}
async function loadRust() {
  if (bridge && typeof bridge.rustStatus === 'function') {
    try {
      const r = await bridge.rustStatus();
      rustInfo.value = { available: !!(r && r.available), version: (r && r.version) || '', binary: (r && r.binary) || null };
    } catch (e) {}
  }
}

/* ---------------- 曲库文件 + Rust 核心 ---------------- */
const lib = reactive({
  files: 0, bytes: 0, dir: '',
  verifyBusy: false, verifyResult: null, orphanCount: 0,
  dupeBusy: false, dupeResult: null,
  err: '',
});
async function loadLibStats() {
  try {
    if (!bridge || !bridge.midiStats) return;
    const r = await bridge.midiStats();
    if (r && r.ok) { lib.files = r.count || 0; lib.bytes = r.bytes || 0; lib.dir = r.dir || ''; }
  } catch (e) {}
}
async function verifyLibrary() {
  if (!bridge || !bridge.verifyMidi) return;
  lib.verifyBusy = true; lib.err = '';
  try {
    const r = await bridge.verifyMidi();
    lib.verifyResult = r || null;
    if (!r || !r.ok) lib.err = (r && r.error) || 'unknown';
    else {
      const bad = r.badCount || 0;
      toast(bad ? t('体检完成：发现 ') + bad + t(' 个无法解析的文件') : t('体检完成：全部曲目文件可正常解析'),
        bad ? 'warn' : 'ok');
      if (bad) await pruneBadFiles(r.bad || []);
      // 反向一致性：磁盘上不应存在「曲库已没有对应曲目」的孤儿文件
      const orphans = await cleanOrphanFiles(r.files || []);
      lib.orphanCount = orphans;
    }
    loadLibStats();
  } catch (e) { lib.err = String(e); }
  lib.verifyBusy = false;
}
/** 清理孤儿文件：磁盘上存在但曲库已无对应曲目的 .mid（保证文件与曲目一一对应） */
async function cleanOrphanFiles(files) {
  try {
    const known = new Set((app.songs || [])
      .filter((s) => s.meta && s.meta.path)
      .map((s) => String(s.meta.path).toLowerCase()));
    const orphans = (files || []).filter((f) => !known.has(String(f.file || '').toLowerCase()));
    for (const f of orphans) { try { await bridge.deleteMidi(f.file); } catch (e) {} }
    if (orphans.length) toast(t('已清理 ') + orphans.length + t(' 个无主文件'), 'ok');
    return orphans.length;
  } catch (e) { return 0; }
}
/** 把体检发现的问题文件对应的曲目从曲库清理掉（避免留下打不开的空壳） */
async function pruneBadFiles(bad) {
  try {
    const paths = new Set((bad || []).map((b) => String(b.file || '').toLowerCase()));
    if (!paths.size) return;
    const victims = (app.songs || []).filter((s) => s.meta && s.meta.path && paths.has(String(s.meta.path).toLowerCase()));
    for (const s of victims) await app.removeSong(s.id, { deleteFile: true });
    if (victims.length) toast(t('已清理 ') + victims.length + t(' 个损坏曲目'), 'ok');
  } catch (e) {}
}
async function findDupes() {
  if (!bridge || !bridge.dupeMidi) return;
  lib.dupeBusy = true; lib.err = '';
  try {
    const r = await bridge.dupeMidi();
    lib.dupeResult = r || null;
    if (!r || !r.ok) lib.err = (r && r.error) || 'unknown';
    else toast(r.dupeGroups ? t('发现 ') + r.dupeGroups + t(' 组重复文件') : t('未发现重复文件'), r.dupeGroups ? 'warn' : 'ok');
  } catch (e) { lib.err = String(e); }
  lib.dupeBusy = false;
}
function revealLibDir() { try { bridge && bridge.openDataRoot && bridge.openDataRoot('midi'); } catch (e) {} }

/* ---------------- 诊断与配置 ---------------- */
async function exportDiag() {
  if (!bridge || !bridge.diagExport) return;
  try {
    const r = await bridge.diagExport();
    if (r && r.canceled) toast(t('导出已取消'));
    else if (r && r.ok) toast(t('诊断包已导出'));
    else toast(t('导出失败：') + String((r && r.error) || 'unknown'), 'error');
  } catch (e) { toast(t('导出失败：') + String(e.message || e), 'error'); }
}
async function exportConfig() {
  if (!bridge || !bridge.saveBinary) { toast(t('当前环境不支持导出配置'), 'warn'); return; }
  try {
    const s = await settingsStore.load() || {};
    const data = new TextEncoder().encode(JSON.stringify(s, null, 2));
    const r = await bridge.saveBinary({ name: 'FuFumidi-配置.json', data: Array.from(data) });
    if (r && r.ok) toast(t('配置已导出：') + r.path, 'ok');
    else if (r && !r.canceled) toast(t('配置导出失败'), 'warn');
  } catch (e) { toast(t('配置导出失败：') + (e.message || e), 'warn'); }
}
async function importConfig() {
  if (!bridge || !bridge.pickFile || !bridge.readBinary) { toast(t('当前环境不支持导入配置'), 'warn'); return; }
  try {
    const p = await bridge.pickFile({ filters: [{ name: t('FuFumidi 配置'), extensions: ['json'] }] });
    if (!p) return;
    const bytes = await bridge.readBinary(p);
    const cfg = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(bytes)));
    if (!cfg || typeof cfg !== 'object') throw new Error('bad config');
    const cur = await settingsStore.load() || {};
    await settingsStore.save(Object.assign({}, cur, cfg));
    toast(t('配置已导入'), 'ok');
    loadPath();
  } catch (e) { toast(t('配置导入失败：') + (e.message || e), 'warn'); }
}

/* ---------------- 模型文件 ---------------- */
const models = ref([]);
const modelChannel = ref('huggingface');
const modelProg = reactive({});
const hfToken = ref('');
const hfTokenVisible = ref(false);
const depGroups = ref(null);      // dep:check 缓存：模型运行时依赖组状态（muscriptor/aria/transkun…）
const modelRtBusy = ref(false);
async function loadHfToken() {
  try { const s = await settingsStore.load() || {}; hfToken.value = s.hf_token || ''; } catch (e) {}
}
function saveHfToken() {
  settingsStore.save({ hf_token: hfToken.value.trim() }).catch(() => {});
  toast(t('HF Token 已保存'), 'ok');
}
let offModelProg = null;
// 恢复进行中的下载状态：切回来时把仍在后台下载的模型标记为「下载中」
function restoreDownloads(list) {
  for (const m of list || []) {
    if (m && m.id && m.active && !(modelProg[m.id] && modelProg[m.id].active)) {
      modelProg[m.id] = { percent: modelProg[m.id] ? modelProg[m.id].percent : 0, active: true, error: '' };
    }
  }
}
async function refreshModels() {
  if (bridge && bridge.modelList) { try { const arr = await bridge.modelList() || []; models.value = arr; restoreDownloads(arr); } catch (e) { models.value = []; } }
  // 同步刷新模型运行时依赖组状态，用于标记「权重已就绪但缺运行时包」的模型
  if (bridge && bridge.depCheck) {
    try { const r = await bridge.depCheck(); depGroups.value = (r && r.result && r.result.groups) || null; }
    catch (e) { depGroups.value = null; }
  }
}
// 模型运行时缺失的包列表；null=尚未检查（返回时前端不展示该状态）
function runtimeMissingOf(m) {
  if (!m || !m.runtime || !depGroups.value) return null;
  const g = depGroups.value[m.runtime];
  if (!g) return null;
  return g.ok ? [] : (g.missing || []);
}
function runtimeOk(m) {
  const missing = runtimeMissingOf(m);
  return Array.isArray(missing) && missing.length === 0;
}
// 一键安装该模型的运行时依赖包（dep 组）
async function installModelRuntime(m) {
  if (!bridge || !bridge.depInstall || !m.runtime) return;
  modelRtBusy.value = true;
  const label = t(MODEL_DEP_LABEL[m.runtime] || m.runtime);
  toast(t('正在安装 ') + label + t(' 运行时…'));
  try {
    const r = await bridge.depInstall(m.runtime);
    if (r && r.ok) toast(t('已安装 ') + label + t(' 运行时'), 'ok');
    else toast(t('安装失败：') + String((r && (r.error || r.raw)) || 'unknown').slice(-200), 'error');
  } catch (e) { toast(t('安装失败：') + String(e.message || e), 'error'); }
  await refreshModels();
  modelRtBusy.value = false;
}
function downloadModel(m) {
  if (!bridge || !bridge.modelDownload) { toast(t('当前环境不支持下载模型'), 'warn'); return; }
  if ((modelProg[m.id] && modelProg[m.id].active) || (m && m.active)) return;
  modelProg[m.id] = { percent: 0, active: true, error: '' };
  bridge.modelDownload(m.id, modelChannel.value).then((r) => {
    if (r && r.ok) { modelProg[m.id] = { percent: 100, active: false }; toast(t('已下载：') + m.name, 'ok'); }
    else { modelProg[m.id] = { percent: 0, active: false, error: (r && r.error) || t('下载失败') }; toast(t('下载失败：') + ((r && r.error) || ''), 'error'); }
    refreshModels();
  }).catch((e) => {
    modelProg[m.id] = { percent: 0, active: false, error: String((e && e.message) || e) };
    toast(t('下载失败：') + String((e && e.message) || e), 'error');
  });
}
async function importLocalModel() {
  if (!bridge || !bridge.pickModelArchive || !bridge.modelImportLocal) { toast(t('当前环境不支持导入本地模型'), 'warn'); return; }
  try {
    const p = await bridge.pickModelArchive();
    if (!p) return;
    toast(t('正在导入本地模型压缩包…'), 'info');
    const r = await bridge.modelImportLocal(p);
    if (r && r.ok) {
      toast(t('已导入模型：') + r.model + t('（') + fmtSize(r.size) + t('）'), 'ok');
      refreshModels();
    } else {
      toast(t('导入失败：') + ((r && r.error) || ''), 'error');
    }
  } catch (e) {
    toast(t('导入失败：') + String((e && e.message) || e), 'error');
  }
}
function fmtSize(b) {
  if (!b) return '—';
  if (b > 1 << 30) return (b / (1 << 30)).toFixed(1) + ' GB';
  if (b > 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

/* ---------------- GPU 加速状态 ---------------- */
const gpuInfo = reactive({ available: false, backend: '', name: '', blackwell: false, need_cu128: false, loaded: false });
async function loadGpu() {
  if (bridge && bridge.probe) {
    try {
      const r = await bridge.probe();
      const g = (r && r.gpu) || {};
      gpuInfo.available = !!g.available;
      gpuInfo.backend = g.backend || '';
      gpuInfo.name = g.name || '';
      gpuInfo.blackwell = !!g.blackwell;
      gpuInfo.need_cu128 = !!g.need_cu128;
    } catch (e) {}
    gpuInfo.loaded = true;
  }
}

onMounted(() => {
  loadPath();
  refreshModels();
  loadRust();
  loadGpu();
  loadHfToken();
  loadLibStats();
  if (bridge && bridge.onModelProgress) {
    offModelProg = bridge.onModelProgress((p) => {
      if (p && p.id) {
        if (p.done) modelProg[p.id] = { percent: 100, active: false };
        else if (p.error) modelProg[p.id] = { percent: 0, active: false, error: p.error };
        else modelProg[p.id] = { percent: p.percent || 0, active: true };
      }
    });
  }
});
onBeforeUnmount(() => { if (offModelProg) { try { offModelProg(); } catch (e) {} offModelProg = null; } });
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-ic"><Icon name="box" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ t('资源中心') }}</div>
        <div class="page-sub">{{ t('模型管理 · 音色工坊 · 资源管理') }}</div>
      </div>
    </div>

    <div class="rc-tabs">
      <button class="rc-tab" :class="{ on: rcTab === 'model' }" @click="selectRc('model')">{{ t('模型管理') }}</button>
      <button class="rc-tab" :class="{ on: rcTab === 'soundfonts' }" @click="selectRc('soundfonts')">{{ t('音色工坊') }}</button>
      <button class="rc-tab" :class="{ on: rcTab === 'resources' }" @click="selectRc('resources')">{{ t('资源管理') }}</button>
    </div>

    <Transition name="group-tab" mode="out-in">
      <div :key="rcTab" class="rc-tab-content">
      <template v-if="rcTab === 'model'">
      <ViewModels />

      <div class="card res-sec">
        <div class="res-sec-head"><Icon name="settings" :size="15" /> {{ t('模型下载设置') }}</div>
        <div class="field-row top">
          <div>
            <div class="fr-label">HuggingFace Token</div>
            <div class="fr-hint">{{ t('下载需授权的模型（MuScriptor 等）时必填') }}</div>
          </div>
          <div class="fr-ctl col">
            <div style="display:flex;gap:6px;width:100%">
              <input :type="hfTokenVisible ? 'text' : 'password'" v-model="hfToken" class="ov-input mono" style="flex:1;min-width:200px" :placeholder="t('hf_xxxx（huggingface.co/settings/tokens 创建）')" @change="saveHfToken" />
              <button class="btn sm" @click="hfTokenVisible = !hfTokenVisible">{{ hfTokenVisible ? t('隐藏') : t('显示') }}</button>
              <button class="btn sm" @click="saveHfToken">{{ t('保存') }}</button>
            </div>
            <div class="fr-hint" style="margin-top:4px">{{ t('使用前需先在 huggingface.co 对应模型页接受许可协议，否则返回 401') }}</div>
          </div>
        </div>
        <div class="field-row">
          <div>
            <div class="fr-label">{{ t('下载渠道') }}</div>
            <div class="fr-hint">{{ t('MuScriptor / Aria-AMT 权重：HuggingFace 官方或 hf-mirror 镜像') }}</div>
          </div>
          <div class="fr-ctl">
            <div class="radio-pill">
              <span :class="{ on: modelChannel === 'huggingface' }" @click="modelChannel = 'huggingface'">HuggingFace</span>
              <span :class="{ on: modelChannel === 'hf-mirror' }" @click="modelChannel = 'hf-mirror'">hf-mirror</span>
            </div>
          </div>
        </div>
        <div class="field-row">
          <div>
            <div class="fr-label">{{ t('本地模型压缩包') }}</div>
            <div class="fr-hint">{{ t('可导入本地 .zip / .7z / .tar 模型包') }}</div>
          </div>
          <div class="fr-ctl">
            <button class="btn sm" @click="importLocalModel">{{ t('导入本地模型压缩包') }}</button>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="rcTab === 'soundfonts'">
      <ViewSoundfonts />
    </template>

    <template v-else>
    <!-- ============ Python 依赖 ============ -->
    <div class="card res-sec">
      <div class="res-sec-head"><Icon name="zap" :size="15" /> {{ t('Python 依赖') }}</div>
      <div class="field-row top">
        <div>
          <div class="fr-label">{{ t('Python 解释器路径') }}</div>
          <div class="fr-hint">{{ t('依赖本地 Python（librosa / torch / demucs）') }}</div>
        </div>
        <div class="fr-ctl col">
          <input v-model="enginePath" class="ov-input mono" style="width:100%;max-width:340px" :placeholder="t('留空 = 自动检测')" @change="savePath" />
          <div style="display:flex;gap:6px">
            <button class="btn sm" @click="autoPy">{{ t('自动检测') }}</button>
            <button class="btn sm" @click="testEngine" :disabled="pyState.busy">{{ pyState.busy ? t('正在检查…') : t('测试引擎') }}</button>
          </div>
        </div>
      </div>
      <div class="field-row">
        <div>
          <div class="fr-label">{{ t('程序运行依赖') }}</div>
          <div class="fr-hint">{{ t('程序运行所需包（numpy / librosa / onnxruntime 等）') }}</div>
        </div>
        <div class="fr-ctl">
          <button class="btn sm" @click="checkRuntime" :disabled="rtBusy">{{ rtBusy ? t('正在检查…') : t('检查依赖') }}</button>
          <button class="btn sm primary" @click="installRuntime" :disabled="pyBusy">{{ pyBusy ? t('正在安装…') : t('一键补全缺失依赖') }}</button>
        </div>
      </div>
    </div>

    <!-- ============ 模型运行时 ============ -->
    <div class="card res-sec">
      <div class="res-sec-head"><Icon name="spark" :size="15" /> {{ t('模型运行时') }}</div>
      <div class="field-row">
        <div>
          <div class="fr-label">{{ t('模型运行依赖') }}</div>
          <div class="fr-hint">{{ t('模型推理所需包：钢琴(piano_transcription)、分离(demucs)、MuScriptor(muscriptor)、Aria-AMT(ariautils)、Transkun(transkun)') }}</div>
        </div>
        <div class="fr-ctl">
          <button class="btn sm" @click="checkModels" :disabled="modelBusy">{{ modelBusy ? t('正在检查…') : t('检查依赖') }}</button>
          <button class="btn sm primary" @click="installModels" :disabled="modelInstallBusy">{{ modelInstallBusy ? t('正在安装…') : t('一键补全缺失依赖') }}</button>
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
    </div>


    <!-- ============ GPU 加速 ============ -->
    <div class="card res-sec">
      <div class="res-sec-head"><Icon name="zap" :size="15" /> {{ t('GPU 加速') }}</div>
      <div class="field-row">
        <div>
          <div class="fr-label">{{ t('推理加速') }}</div>
          <div class="fr-hint">{{ gpuInfo.loaded ? (gpuInfo.available ? (gpuInfo.name + ' · ' + (gpuInfo.backend === 'cuda' ? 'CUDA' : gpuInfo.backend || '')) : t('未启用（可在设置 → GPU 中下载增强包）')) : t('检测中…') }}</div>
        </div>
        <div class="fr-ctl">
          <span v-if="gpuInfo.available" :class="['plg-tag', 'on']">{{ t('已启用') }}</span>
          <span v-else :class="['plg-tag', 'off']">{{ t('未启用') }}</span>
        </div>
      </div>
      <div v-if="gpuInfo.blackwell" class="field-row">
        <div>
          <div class="fr-label">{{ t('Blackwell GPU（RTX 50 系）') }}</div>
          <div class="fr-hint">{{ gpuInfo.need_cu128 ? t('当前 CUDA 运行时低于 12.8，无法在 Blackwell 上运行，需下载 cu128 增强包') : t('CUDA 12.8+ 已就绪') }}</div>
        </div>
        <div class="fr-ctl">
          <span :class="['plg-tag', gpuInfo.need_cu128 ? 'off' : 'on']">{{ gpuInfo.need_cu128 ? t('需 cu128') : t('就绪') }}</span>
        </div>
      </div>
    </div>

    <!-- ============ 曲库文件与 Rust 核心 ============ -->
    <div class="card res-sec">
      <div class="res-sec-head"><Icon name="box" :size="15" /> {{ t('曲库文件与 Rust 核心') }}</div>
      <div class="field-row top">
        <div>
          <div class="fr-label">{{ t('曲库 MIDI 文件') }}</div>
          <div class="fr-hint">{{ t('每个曲目都对应一个真实 .mid 文件，集中存放在数据目录的 midi/ 下。') }}</div>
        </div>
        <div class="fr-ctl col">
          <div class="lib-stats">
            <span class="lib-badge">{{ lib.files }} {{ t('个文件') }}</span>
            <span class="lib-badge">{{ fmtSize(lib.bytes) }}</span>
            <span v-if="rustInfo.available" class="lib-badge on">Rust {{ rustInfo.version || '—' }}</span>
            <span v-else class="lib-badge off">{{ t('纯 JS 模式') }}</span>
          </div>
          <div class="lib-path" :title="lib.dir">{{ lib.dir || t('（尚未创建）') }}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn sm" @click="revealLibDir">{{ t('打开曲库目录') }}</button>
            <button class="btn sm primary" :disabled="lib.verifyBusy" @click="verifyLibrary">{{ lib.verifyBusy ? t('体检中…') : t('曲库文件体检') }}</button>
            <button class="btn sm" :disabled="lib.dupeBusy" @click="findDupes">{{ lib.dupeBusy ? t('检测中…') : t('检测重复文件') }}</button>
          </div>
        </div>
      </div>
      <div v-if="lib.verifyResult" class="lib-result">
        <div>{{ t('体检引擎：') }}<b>{{ lib.verifyResult.engine === 'rust' ? 'Rust 核心' : 'JS 回退' }}</b>
          · {{ t('文件 ') }}{{ lib.verifyResult.count }} · {{ t('总音符 ') }}{{ lib.verifyResult.totalNotes }}
          · {{ t('异常 ') }}<b :class="{ bad: lib.verifyResult.badCount }">{{ lib.verifyResult.badCount }}</b>
          <span v-if="lib.orphanCount"> · {{ t('已清理无主文件 ') }}<b>{{ lib.orphanCount }}</b></span>
        </div>
        <div v-if="lib.verifyResult.badCount" class="lib-bad">
          <div v-for="b in lib.verifyResult.bad.slice(0, 6)" :key="b.file">· {{ b.file }}</div>
          <div v-if="lib.verifyResult.badCount > 6">… {{ t('等 ') }}{{ lib.verifyResult.badCount }}{{ t(' 个') }}</div>
        </div>
      </div>
      <div v-if="lib.dupeResult" class="lib-result">
        <div>{{ t('重复检测引擎：') }}<b>{{ lib.dupeResult.engine === 'rust' ? 'Rust 核心' : 'JS 回退' }}</b>
          · {{ t('扫描 ') }}{{ lib.dupeResult.count }}{{ t(' 个文件') }} · {{ t('重复组 ') }}<b :class="{ bad: lib.dupeResult.dupeGroups }">{{ lib.dupeResult.dupeGroups }}</b>
          · {{ t('可清理 ') }}{{ lib.dupeResult.dupeFiles }}
        </div>
        <div v-for="(g, gi) in lib.dupeResult.groups.slice(0, 3)" :key="gi" class="lib-bad">
          <div v-for="f in g" :key="f.file">· {{ f.file }}</div>
        </div>
      </div>
      <div v-if="lib.err" class="lib-err">{{ lib.err }}</div>
    </div>

    <!-- ============ UTAU 声库资源（开源 / 免费，一键安装） ============ -->
    <div class="card res-sec">
      <div class="res-sec-head"><Icon name="mic" :size="15" /> {{ t('UTAU 声库资源') }}</div>
      <UtauVoicebankStore />
    </div>

    <!-- ============ 诊断与配置 ============ -->
    <div class="card res-sec">
      <div class="res-sec-head"><Icon name="save" :size="15" /> {{ t('诊断与配置') }}</div>
      <div class="field-row">
        <div>
          <div class="fr-label">{{ t('诊断包') }}</div>
          <div class="fr-hint">{{ t('导出引擎 / 依赖 / 环境诊断信息') }}</div>
        </div>
        <div class="fr-ctl">
          <button class="btn sm" @click="exportDiag">{{ t('导出诊断包') }}</button>
        </div>
      </div>
      <div class="field-row">
        <div>
          <div class="fr-label">{{ t('配置管理') }}</div>
          <div class="fr-hint">{{ t('导出 / 导入全部设置（含路径与转录偏好）') }}</div>
        </div>
        <div class="fr-ctl">
          <button class="btn sm" @click="exportConfig">{{ t('导出配置') }}</button>
          <button class="btn sm" @click="importConfig">{{ t('导入配置') }}</button>
        </div>
      </div>
    </div>
    </template>
      </div>
    </Transition>

    <!-- 检查结果弹窗 -->
    <Transition name="ov">
      <div v-if="resultOpen" class="overlay" role="dialog" aria-modal="true" :aria-label="resultTitle" @click.self="resultOpen = false" @keydown.esc="resultOpen = false">
      <div class="overlay-card res-result">
        <div class="settings-head">
          <Icon name="info" :size="17" />
          <span class="settings-title">{{ resultTitle }}</span>
          <button class="icon-btn" style="margin-left:auto;width:30px;height:30px" :title="t('关闭')" @click="resultOpen = false"><Icon name="close" :size="15" /></button>
        </div>
        <div v-if="checking" class="res-result-loading">
          <span class="res-spinner"></span>{{ busyText }}
        </div>
        <pre v-show="!checking || resultText" class="res-result-text">{{ resultText }}</pre>
        <div style="display:flex;justify-content:flex-end;margin-top:12px">
          <button class="btn sm primary" @click="resultOpen = false">{{ t('关闭') }}</button>
        </div>
      </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.rc-tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
.rc-tab { border: 1px solid var(--hairline); background: var(--canvas); color: var(--steel); padding: 7px 14px; border-radius: var(--radius-full, 999px); font-size: 13px; cursor: pointer; transition: all .14s; white-space: nowrap; }
.rc-tab:hover { background: var(--surface-soft); color: var(--ink); }
.rc-tab.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--ink); font-weight: 600; }
/* 标签页内容容器：统一去掉末个子卡片的悬挂外边距，避免底部出现多余空白 */
.rc-tab-content > :last-child { margin-bottom: 0; }
.res-sec { margin-bottom: 14px; }
.res-sec-head {
  display: flex; align-items: center; gap: 7px;
  font-size: 13.5px; font-weight: 700; color: var(--ink);
  margin-bottom: 12px; letter-spacing: -0.2px;
}
.res-result { width: 520px; max-width: 92vw; }
.res-result-loading {
  display: flex; align-items: center; gap: 10px;
  color: var(--stone); font-size: 13px;
  padding: 24px 0; justify-content: center;
}
.res-spinner {
  width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid rgba(10, 10, 10, 0.14); border-top-color: var(--accent);
  animation: res-spin 0.7s linear infinite;
}
@keyframes res-spin { to { transform: rotate(360deg); } }
/* 高度交给全局 .overlay-card .res-result-text{flex:1}：这里不再自设 max-height，
   否则会与全局规则同特异度打架，导致弹窗下方留大片空白 */
.res-result-text {
  white-space: pre-wrap; word-break: break-word;
  font-family: var(--mono); font-size: 12px; line-height: 1.7;
  color: var(--slate); background: var(--surface-soft);
  border: 1px solid var(--hairline); border-radius: 10px;
  padding: 12px 14px; overflow: auto;
  margin: 0;
}
.res-bar { flex: 1; min-width: 90px; height: 5px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; margin: 4px 0 0; }
.res-bar-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.15s linear; }
.res-bar-err { flex-basis: 100%; font-size: 10.5px; color: var(--error); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 曲库文件与 Rust 核心 */
.lib-stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 440px; }
.lib-badge { padding: 1px 8px; border-radius: 999px; background: var(--surface-soft); color: var(--slate); font-size: 10.5px; font-family: var(--mono); white-space: nowrap; }
.lib-badge.on { background: var(--success-bg); color: var(--success-text); }
.lib-badge.off { background: var(--surface-soft); color: var(--stone); }
.lib-path { font-family: var(--mono); font-size: 10.5px; color: var(--stone); max-width: 440px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-result { font-size: 12px; color: var(--slate); line-height: 1.8; padding: 8px 10px; margin-top: 8px; border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface-soft); }
.lib-result b { color: var(--ink); font-family: var(--mono); }
.lib-result b.bad { color: var(--error); }
.lib-bad { font-family: var(--mono); font-size: 10.5px; color: var(--stone); word-break: break-all; margin-top: 2px; }
.lib-err { margin-top: 8px; font-size: 11.5px; color: var(--error); word-break: break-all; }
</style>

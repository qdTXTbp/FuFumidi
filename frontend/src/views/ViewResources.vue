<script setup>
// 资源中心：Python 依赖 / 模型运行时 / 模型文件 / 诊断与配置
// - Python 依赖：程序运行所需包（universal 组）
// - 模型运行时：模型推理所需包（piano / separate / muscriptor / aria / transkun 组）+ Rust 核心
// - 模型文件：内置模型清单（权重状态 + 运行时包状态，缺包可一键安装）
// - 诊断与配置：诊断包导出、配置导入导出
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { useSettingsStore } from '../stores/settings';
import { t } from '../core/i18n.js';

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
    if (info.ok) lines.push('[' + g + '] ' + t('通过'));
    else lines.push('[' + g + '] ' + t('缺失：') + ((info.missing || []).join(', ') || t('未知')));
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
    const label = MODEL_DEP_LABEL[g] || g;
    if (!info) { lines.push('[' + label + '] ' + t('未知')); continue; }
    if (info.ok) lines.push('[' + label + '] ' + t('通过'));
    else lines.push('[' + label + '] ' + t('缺失：') + ((info.missing || []).join(', ') || t('未知')));
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
        ? parts.join('\n') + '\n' + t('正在安装：') + (MODEL_DEP_LABEL[g] || g) + '…'
        : t('正在安装：') + (MODEL_DEP_LABEL[g] || g) + '…';
      const r = await bridge.depInstall(g);
      parts.push('[' + (MODEL_DEP_LABEL[g] || g) + '] ' + ((r && r.ok) ? t('完成') : t('失败：') + String((r && (r.error || r.raw)) || 'unknown')));
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
    const p = await bridge.pickFile({ filters: [{ name: 'FuFumidi 配置', extensions: ['json'] }] });
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
  const label = MODEL_DEP_LABEL[m.runtime] || m.runtime;
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
      toast(t('已导入模型：') + r.model + '（' + fmtSize(r.size) + '）', 'ok');
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
      <div>
        <div class="page-title">{{ t('资源中心') }}</div>
        <div class="page-sub">{{ t('Python 依赖 · 模型运行时 · 模型文件') }}</div>
      </div>
    </div>

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

    <!-- ============ 模型文件 ============ -->
    <div class="card res-sec">
      <div class="res-sec-head"><Icon name="folder" :size="15" /> {{ t('模型文件') }}</div>
      <div class="field-row top">
        <div>
          <div class="fr-label">HuggingFace Token</div>
          <div class="fr-hint">{{ t('仅 Aria-AMT 等 HuggingFace 模型下载需要，MuScriptor 走 GitHub 镜像无需 Token') }}</div>
        </div>
        <div class="fr-ctl col">
          <div style="display:flex;gap:6px;width:100%">
            <input :type="hfTokenVisible ? 'text' : 'password'" v-model="hfToken" class="ov-input mono" style="flex:1;min-width:200px" placeholder="hf_xxxx（huggingface.co/settings/tokens 创建）" @change="saveHfToken" />
            <button class="btn sm" @click="hfTokenVisible = !hfTokenVisible">{{ hfTokenVisible ? t('隐藏') : t('显示') }}</button>
            <button class="btn sm" @click="saveHfToken">{{ t('保存') }}</button>
          </div>
          <div class="fr-hint" style="margin-top:4px">{{ t('MuScriptor（Small/Medium/Large）已改为 GitHub 镜像分卷下载，无需 HuggingFace 授权；HF Token 仅 Aria-AMT 等模型需要') }}</div>
        </div>
      </div>
      <div class="field-row">
        <div>
          <div class="fr-label">{{ t('下载渠道') }}</div>
          <div class="fr-hint">{{ t('MuScriptor 走 GitHub 镜像分卷下载（自动测速选源）；Aria-AMT 走 HuggingFace 官方或 hf-mirror') }}</div>
        </div>
        <div class="fr-ctl">
          <div class="radio-pill">
            <span :class="{ on: modelChannel === 'huggingface' }" @click="modelChannel = 'huggingface'">HuggingFace</span>
            <span :class="{ on: modelChannel === 'hf-mirror' }" @click="modelChannel = 'hf-mirror'">hf-mirror</span>
          </div>
        </div>
      </div>
      <div class="field-row top">
        <div style="flex:none">
          <div class="fr-label">{{ t('内置模型') }}</div>
          <div class="fr-hint">{{ t('点击缺失模型即可下载 · Basic Pitch 随 Release 内置') }}</div>
        </div>
        <div class="fr-ctl col stretch">
          <div class="state-box" v-if="models.length">
            <div class="model-item" v-for="m in models" :key="m.id || m.name">
              <span class="mi-name">{{ m.name }}</span>
              <span class="mi-note">{{ m.note }}</span>
              <span class="mi-size">{{ fmtSize(m.size) }}</span>
              <span v-if="m.gated" class="mi-gated" :title="t('需在 HuggingFace 接受协议并填写 Token')">{{ t('需授权') }}</span>
              <span :class="m.exists ? 'mi-ok' : 'mi-missing'">{{ m.exists ? t('已就绪') : t('缺失') }}</span>
              <!-- 权重已就绪但缺运行时包：模型依赖检查的一部分 -->
              <template v-if="m.exists && m.runtime && depGroups">
                <span :class="runtimeOk(m) ? 'mi-ok' : 'mi-missing'" :title="(runtimeMissingOf(m) || []).join(', ')">{{ runtimeOk(m) ? t('运行时就绪') : t('缺运行时包') }}</span>
                <button v-if="!runtimeOk(m)" class="btn sm" style="margin-left:auto;flex:none" :disabled="modelRtBusy" @click="installModelRuntime(m)">{{ t('一键安装') }}</button>
              </template>
              <template v-if="m.downloadable && !m.exists">
                <button class="btn sm" @click="downloadModel(m)" :disabled="(modelProg[m.id] && modelProg[m.id].active) || m.active" style="margin-left:auto;flex:none">
                  {{ ((modelProg[m.id] && modelProg[m.id].active) || m.active) ? ((modelProg[m.id] && modelProg[m.id].percent) || 0) + '%' : t('下载') }}
                </button>
              </template>
              <div v-if="modelProg[m.id] && modelProg[m.id].active" class="res-bar"><div class="res-bar-fill" :style="{ width: (modelProg[m.id].percent || 0) + '%' }"></div></div>
              <div v-else-if="modelProg[m.id] && modelProg[m.id].error" class="res-bar-err">{{ modelProg[m.id].error }}</div>
            </div>
          </div>
          <div class="state-box" v-else>{{ t('暂无模型信息') }}</div>
          <button class="btn sm" @click="refreshModels">{{ t('刷新模型清单') }}</button>
          <button class="btn sm primary" @click="importLocalModel" style="margin-left:8px">{{ t('导入本地模型压缩包') }}</button>
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
.res-sec { padding: 18px 20px; margin-bottom: 14px; }
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
.res-result-text {
  white-space: pre-wrap; word-break: break-word;
  font-family: var(--mono); font-size: 12px; line-height: 1.7;
  color: var(--slate); background: var(--surface-soft);
  border: 1px solid var(--hairline); border-radius: 10px;
  padding: 12px 14px; max-height: 52vh; overflow: auto;
  margin: 0;
}
.res-bar { flex: 1; min-width: 90px; height: 5px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; margin: 4px 0 0; }
.res-bar-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.15s linear; }
.res-bar-err { flex-basis: 100%; font-size: 10.5px; color: var(--error); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>

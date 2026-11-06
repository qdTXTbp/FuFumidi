<script setup>
// 模型管理：独立页面，卡片式管理全部模型（转录 / 人声分离 / 其它）
// - 卡片：用处 + 架构徽标 + 大小 + 状态
// - 点击卡片 → 右侧详情抽屉（含下载/删除）
// - 下载中关闭抽屉 → 全屏弹窗实时显示 速度 + 进度（可取消）
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import Icon from '../components/Icon.vue';
import DiffSingerCatalog from './DiffSingerCatalog.vue';
import ModelCatalog from '../components/models/ModelCatalog.vue';
import UtauVoicebankStore from '../components/utau/UtauVoicebankStore.vue';
import RvcModelPanel from '../components/cover/RvcModelPanel.vue';
import { useAppStore } from '../stores/app';
import { useVoicebankStore } from '../stores/voicebank';
import { t } from '../core/i18n.js';
import { DL, downloadState, manifestBytes, expectedBytes } from '../core/model-download.js';
import { useModelDownloadStore } from '../stores/modelDownloads';

const app = useAppStore();
const vbStore = useVoicebankStore();
const dlStore = useModelDownloadStore();   // 下载状态跨页共享（App.vue 的全局下载条读同一份）
const toast = (m, type) => app.toast(m, type);
const bridge = window.fuBridge;

/* ---------------- 分类 --------------- */
/* ---------------- 分类 ----------------
 * ★ 2026-10-14 按用户要求改成**两级**：顶层 4 类，「调教」下面再分声库 / 音色 / 调教模型。
 *   理由：声库（DiffSinger/UTAU）、音色（GPT-SoVITS）、hnsep 这些东西的共同点是
 *   「让工具唱起来」，跟「转录 / 分离」不是一类。原来摊平成 6 个顶层页签时，
 *   用户得先知道 hnsep 是干什么的才能找到它。
 */
const TABS = computed(() => [
  { id: 'transcribe', label: t('转录模型'), ic: 'transcribe' },
  { id: 'separate', label: t('人声分离'), ic: 'mic' },
  { id: 'other', label: t('修复·VR'), ic: 'box' },
  { id: 'tuning', label: t('调教'), ic: 'spark' },
]);
/** 调教下面的二级分类。id **不是** kind —— 声库那两类各走自己的目录组件。 */
const TUNING_SUBS = computed(() => [
  { id: 'models', label: t('调教模型'), ic: 'box' },
  { id: 'ds', label: t('声库 · DiffSinger'), ic: 'spark' },
  { id: 'utau', label: t('声库 · UTAU'), ic: 'mic' },
  { id: 'rvc', label: t('RVC 模型'), ic: 'mic' },
]);
const TUNING_INFO = computed(() => ({
  models: { title: t('调教模型'), desc: t('歌声合成所需的基础模型与运行时。') },
  ds: { title: t('DiffSinger 声库'), desc: t('下载声库后，在调教页直接选歌手。') },
  utau: { title: t('UTAU 声库'), desc: t('开源声库，一键安装到本地。') },
  rvc: { title: t('RVC 模型'), desc: t('翻唱用的角色音色；应用不内置、不代下载。') },
}));
/** 二级分类里哪一个是卡片网格（其余是独立目录组件 / 独立面板，没有 kind） */
const SUB_KIND = { models: 'tuning' };
// 深链：?m=<页签或二级 id> 直接落到某个分类（翻唱页「去导入模型」带 ?m=rvc 过来）
const route = useRoute();
const curTab = ref('transcribe');
const curSub = ref('models');
const deepLink = String(route.query.m || '');
if (deepLink === 'rvc') { curTab.value = 'tuning'; curSub.value = 'rvc'; }
else if (['ds', 'utau', 'models'].includes(deepLink)) { curTab.value = 'tuning'; curSub.value = deepLink; }
/** 网格实际按哪个 kind 过滤：调教下看二级，其余看顶层 */
const listKind = computed(() => (curTab.value === 'tuning' ? (SUB_KIND[curSub.value] || '') : curTab.value));
const showDs = computed(() => curTab.value === 'tuning' && curSub.value === 'ds');
const showUtau = computed(() => curTab.value === 'tuning' && curSub.value === 'utau');
const showRvc = computed(() => curTab.value === 'tuning' && curSub.value === 'rvc');
const showGrid = computed(() => (curTab.value === 'tuning' ? !!SUB_KIND[curSub.value] : true));
/** 「调教模型」页用共享目录壳（与两个声库页同形），走 ModelCatalog 而不是通用网格 */
const isTuningGrid = computed(() => curTab.value === 'tuning' && !!SUB_KIND[curSub.value]);
/** 二级页 → 用户元数据的 kind（白名单见 main/usermeta.js 的 KINDS）。
    注意不是 SUB_KIND：SUB_KIND 是 model:list 的 kind，这里是「用户改动的归属」。 */
const META_KIND = { rvc: 'rvc', models: 'model' };
const metaKind = computed(() => META_KIND[curSub.value] || 'model');

/* ---------------- 模型列表与进度 ---------------- */
const list = ref([]);
// 下载进度在 store 里（不是本页局部状态）：切页/暂停后回来仍能看到「下载中/已暂停」
const prog = dlStore.prog;
const loading = ref(false);
const detail = ref(null);             // 当前选中模型（详情抽屉）

const tabbedList = computed(() => list.value.filter(m => m.kind === listKind.value));
// DiffSinger 声库不在 modelList 里，数量从共享 store 取（由 DiffSingerCatalog 拉目录后写入）；
// 未加载完成前显示「…」而非 0，避免误报「可下载声库数量为 0」。
function countFor(tb) {
  // 调教 = 声库 + 音色 + 模型，其中 UTAU 声库的数字来自它自己的注册表 ——
  // 硬凑一个合计数只会给出一个错的数字，不如显示「…」。
  if (tb === 'tuning') return null;
  if (tb === 'ds') return vbStore.dsLoaded ? vbStore.dsAvailable : null;
  if (tb === 'utau') return null;
  return list.value.filter(m => m.kind === tb).length;
}
function cnt(n) { return n == null ? '…' : String(n); }

function kindIcon(m) { return (m.kind === 'separate' || m.kind === 'tts' || m.kind === 'rvc') ? 'mic' : (m.kind === 'transcribe') ? 'music' : 'box'; }
/** kind → 给用户看的分类名（详情抽屉用）。
 *  ★ 新增 kind **必须**来这里加一行 —— 漏了会把它显示成「修复工具」，
 *    分类名写错比不显示更糟。 */
function kindLabel(k) {
  if (k === 'separate') return t('人声分离');
  if (k === 'transcribe') return t('转录模型');
  if (k === 'tts') return t('音色');
  if (k === 'rvc') return t('RVC 模型');
  if (k === 'tuning') return t('调教模型');
  return t('修复工具');
}
/** 外部门户（论坛 / 网盘 / Spaces）：不能一键下载，只把用户送去该去的地方 */
function openExternal(m) {
  if (!m || !m.url) return;
  try { if (bridge.openExternal) bridge.openExternal(m.url); else window.open(m.url, '_blank'); } catch (e) {}
}

function human(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}
function speedTxt(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' MB/s' : (bps / 1e3).toFixed(0) + ' KB/s';
}

async function refresh() {
  if (!bridge || !bridge.modelList) return;
  try { list.value = (await bridge.modelList()) || []; } catch (e) { list.value = []; }
  dlStore.setNames(list.value);       // 顶部全局下载条要显示模型名
  dlStore.syncActive(list.value);     // model_list.active 兜底（本地暂停/失败/完成优先）
  // 抽屉持有的是对象引用；列表刷新后换成新对象，避免显示旧体积/旧字段
  if (detail.value) {
    const fresh = list.value.find((x) => x && x.id === detail.value.id);
    if (fresh) detail.value = fresh;
  }
}
let refreshTimer = null;
/** 下载结束后合并刷新，避免一连串 done 事件触发多次 model_list。 */
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 260);
}
// 完成/失败后刷新列表（暂停、取消不算结束，不刷新，避免把「已暂停」显示成未安装）
watch(() => dlStore.refreshTick, () => scheduleRefresh());

/* ---------------- 下载（三态：下载中 / 已暂停 / 下载失败） ----------------
 * 状态与动作都在 stores/modelDownloads：本页只负责 toast 与列表刷新。
 * 暂停：modelPause(id) 保留断点；继续 = 用**同一个** modelDownload 重入（后端从 .part 续传）。 */

/** 三态判定：卡片 / 抽屉共用（纯函数在 core/model-download.js，已单测） */
function dlState(m) { return downloadState(m, m && m.id ? prog[m.id] : undefined); }
function isDownloading(m) { return dlState(m) === DL.DOWNLOADING; }
function isPaused(m) { return dlState(m) === DL.PAUSED; }
function isFailed(m) { return dlState(m) === DL.FAILED; }
function pct(m) { return Math.max(0, Math.min(100, Math.round(Number(m && prog[m.id] && prog[m.id].percent) || 0))); }
function stateClass(m) {
  const s = dlState(m);
  if (s === DL.INSTALLED) return 'on';
  if (s === DL.DOWNLOADING) return 'run';
  if (s === DL.PAUSED) return 'pause';
  if (s === DL.FAILED) return 'bad';
  return 'off';
}
function stateLabel(m) {
  const s = dlState(m);
  if (s === DL.INSTALLED) return t('已安装');
  if (s === DL.DOWNLOADING) return pct(m) + '%';
  if (s === DL.PAUSED) return t('已暂停');
  if (s === DL.FAILED) return t('下载失败');
  return t('未安装');
}
/** 体积：未下载时给清单大小（分卷合计）或 minSize，**不再显示 0**。 */
function sizeLabel(m) {
  if (!m) return '';
  const e = expectedBytes(m, prog[m.id]);
  if (e.live) return human(e.received) + ' / ' + human(e.bytes);
  if (!e.bytes) return dlState(m) === DL.INSTALLED ? human(m.size) : '';
  return (e.isMin ? '≥ ' : '') + human(e.bytes);
}
function progressHint(m) {
  if (!m) return '';
  if (isPaused(m)) return t('已暂停（断点已保留，继续时会接着下）');
  return (prog[m.id] && prog[m.id].text) || '';
}
/** 分卷清单合计（详情抽屉「清单大小」行）：只有确切清单才显示，minSize 不冒充清单。 */
function manifestLabel(m) {
  const b = manifestBytes(m);
  return b.bytes && b.source !== 'minSize' ? human(b.bytes) : '';
}
/** type 字段（Tauri 契约）→ 用户可读的类型名；未知值原样显示，不吞掉。 */
const TYPE_LABEL = {
  file: '单文件',
  parts: '分卷',
  zip: '压缩包（解包）',       // Tauri model_service 用 zip 表示解包型运行时包
  unpack: '压缩包（解包）',    // Electron 旧值
  ghsplit: 'GitHub 分卷仓库',
  hf: 'HuggingFace 仓库',
  rvc: 'RVC 模型',
};
function typeLabel(ty) {
  const k = String(ty || '');
  return TYPE_LABEL[k] ? t(TYPE_LABEL[k]) : k;
}

async function startDownload(m) {
  if (!m || !m.id) return;
  if (!bridge || !bridge.modelDownload) { app.toast(t('当前环境不支持下载模型'), 'warn'); return; }
  if (m.downloadable === false) { app.toast(t('该模型随包自带，无需下载'), 'warn'); return; }
  if (isDownloading(m)) return;
  const r = await dlStore.start(m);
  if (r && (r.active || r.stale)) return;          // 已在下载 / 被更新的尝试取代
  if (r && r.paused) return;                        // 用户主动暂停，不弹失败
  if (r && r.canceled) return;                      // 取消是中性动作
  if (r && r.refused === 'bundled') { app.toast(t('该模型随包自带，无需下载'), 'warn'); return; }
  if (r && r.ok) app.toast(t('已下载：') + m.name, 'ok');
  else app.toast(t('下载失败：') + ((r && r.error) || ''), 'warn');
}
async function pauseDownload(id) {
  if (!prog[id] || !prog[id].active) return;
  if (!bridge || !bridge.modelPause) { app.toast(t('当前环境不支持暂停下载'), 'warn'); return; }
  const r = await dlStore.pause(id);
  if (r && r.ok === false) app.toast(t('暂停失败：') + ((r && r.error) || ''), 'warn');
}
async function cancelDownload(id) {
  if (!id) return;
  await dlStore.cancel(id);
}
function deleteModel(m) {
  if (!bridge || !bridge.modelDelete) return;
  if (isDownloading(m) || isPaused(m)) { app.toast(t('请先取消下载再删除'), 'warn'); return; }
  if (!window.confirm(t('删除模型「') + m.name + t('」？'))) return;
  bridge.modelDelete(m.id).then(() => { dlStore.forget(m.id); refresh(); toast(t('已删除'), 'ok'); }).catch(() => toast(t('删除失败'), 'warn'));
}

/* ---------------- 运行时包（2026-10-21 统一下载/管理通道） ----------------
 * hFT-Transformer / YourMT3+ / MIROS 都是「解包型」条目：主进程
 * main/models.js 的 installUnpackEntry 统一处理（下载 → 校验 → 解包 →
 * unpackMarker 验收 → 清理临时产物），界面这里只负责把形态说清楚。 */
const RUNTIME_BUNDLE_IDS = ['hft_transformer', 'yourmt3', 'miros'];
function isRuntimeBundle(m) {
  return !!m && (RUNTIME_BUNDLE_IDS.indexOf(m.id) >= 0 || !!m.unpack);
}
/** 分卷描述：有 partSizes 按实际大小算，没有再只报片数（不再硬编码 25MB）。 */
function partsText(m) {
  const n = Number(m && m.parts) || 0;
  if (!n) return '';
  const sizes = (m && m.partSizes) || [];
  if (sizes.length === n) {
    const each = sizes[0];
    // 末片通常小一截，均片大小时给范围
    const min = Math.min.apply(null, sizes);
    const max = Math.max.apply(null, sizes);
    const one = human(min);
    // 用「 · 合计」而不是中文括号，EN/JA 界面下也不会冒出未翻译的中文
    return n + ' × ~' + one + (max !== min ? ' · ' + human(sizes.reduce((a, b) => a + b, 0)) : '');
  }
  return String(n);
}

/* ---------------- 下载详情抽屉（下载进度通知已移到全局顶部） ---------------- */
function closeDetail() {
  detail.value = null;
}

/* ---------------- 生命周期 ---------------- */
// 预取 DiffSinger 声库目录统计：即使不进 DiffSinger 页签，页签徽标也能显示真实
// 可下载数量（此前恒为 0）。失败静默 —— 点进页签时 DiffSingerCatalog 会再拉一次。
async function prefetchDiffSingerStats() {
  if (!bridge || !bridge.diffsingerMsCatalog) return;
  try {
    const r = await bridge.diffsingerMsCatalog();
    if (r && r.ok && r.stats) {
      vbStore.setDiffsingerStats(r.stats);
      let installed = 0;
      for (const w of (r.works || [])) for (const c of (w.categories || [])) for (const m of (c.models || [])) if (m.installed) installed++;
      vbStore.setDiffsingerInstalled(installed);
    }
  } catch (e) {}
}
onMounted(async () => {
  dlStore.ensureEvents();             // 全局只订阅一次（App.vue 也会调，幂等）
  dlStore.ensureNames();
  await refresh();                    // refresh 里 syncActive 会用 model_list.active 兜底
  loading.value = false;
  prefetchDiffSingerStats();
});
onBeforeUnmount(() => {
  // 事件订阅在 store，不随本页卸载；这里只清本页的合并刷新计时器
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
});
</script>

<template>
  <div class="page page-flat vm-page">
    <div class="page-head page-head-sm">
      <div class="page-ic"><Icon name="box" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ t('模型管理') }}</div>
        <div class="page-sub">{{ TABS.map(tb => tb.label + ' ' + cnt(countFor(tb.id))).join(' · ') }}</div>
      </div>
      <button v-if="!showDs" class="btn sm ghost" @click="refresh">{{ t('刷新') }}</button>
    </div>

    <!-- 分类页签 -->
    <div class="vm-tabs">
      <button v-for="tb in TABS" :key="tb.id" class="vm-tab" :data-guide="'vm-tab-' + tb.id" :class="{ active: curTab === tb.id }" @click="curTab = tb.id">
        <span class="tb-ic"><Icon :name="tb.ic" :size="14" /></span>{{ tb.label }}<span class="tb-cnt">{{ cnt(countFor(tb.id)) }}</span>
      </button>
    </div>

    <!-- 调教的二级分类：声库 / 音色 / 调教模型 -->
    <div v-if="curTab === 'tuning'" class="vm-subtabs">
      <button v-for="sb in TUNING_SUBS" :key="sb.id" class="vm-subtab" :data-guide="'vm-sub-' + sb.id"
              :class="{ active: curSub === sb.id }" @click="curSub = sb.id">
        <span class="tb-ic"><Icon :name="sb.ic" :size="13" /></span>{{ sb.label }}
      </button>
    </div>

    <!-- 醒目提示：下载依赖补全 + 下载慢换源，合并成**一条**（两条提示占了两行，
         信息密度低、还各带一个图标，视觉上比内容更抢眼） -->
    <!-- 依赖提示只对转录 / 分离那类推理模型有意义；调教页收的是声库、音色与自包含 ONNX，
         对它们不适用（用户要求去掉），所以 tuning 页不显示。 -->
    <div v-if="!showDs && curTab !== 'tuning'" class="vm-dep-tip">
      <span class="vm-dep-ic"><Icon name="zap" :size="14" /></span>
      <span>{{ t('下载后请到「资源管理」补全依赖（否则模型可能无法使用）；下载慢可在设置页切换下载源') }}</span>
    </div>

    <div v-if="curTab === 'tuning'" class="vm-tuning-shell">
      <div class="vm-tuning-head">
        <span class="vm-tuning-ic"><Icon :name="(TUNING_SUBS.find(x => x.id === curSub) || {}).ic || 'box'" :size="18" /></span>
        <div class="vm-tuning-copy"><b>{{ TUNING_INFO[curSub] ? TUNING_INFO[curSub].title : t('调教') }}</b><small>{{ TUNING_INFO[curSub] ? TUNING_INFO[curSub].desc : '' }}</small></div>
        <span class="vm-grow"></span>
        <button class="btn sm ghost" @click="refresh">{{ t('刷新') }}</button>
      </div>
      <div class="vm-tuning-body">
    <!-- DiffSinger 声库目录（独立板块，非模型卡片的 kind 分组） -->
    <DiffSingerCatalog v-if="showDs" />

    <!-- UTAU 声库（开源 / 免费）：一键下载安装，装完可在「调教」里直接选来唱 -->
    <div v-else-if="showUtau" class="vm-utau">
      <UtauVoicebankStore />
    </div>

    <!-- 翻唱模型（RVC）：导入 / 已导入 / 在线目录，自带面板 -->
    <div v-else-if="showRvc" class="vm-rvc">
      <RvcModelPanel />
    </div>

    <!-- 调教模型：与两个声库页**同一套**目录壳（来源条 → 搜索筛选 → 分组 → 卡片网格） -->
    <ModelCatalog v-else-if="isTuningGrid" :items="tabbedList" :prog="prog" group-key="arch" :kind="metaKind"
                  icon="box"
                  :title="t('调教模型')"
                  :note="t('调教（歌声合成）用到的模型。Worldline v11 的谐波分离模型就在这里下载。')"
                  :empty-text="t('没有符合条件的调教模型')"
                  @download="startDownload" @remove="deleteModel"
                  @pause="(it) => pauseDownload(it.id)" @resume="startDownload"
                  @cancel="(it) => cancelDownload(it.id)" @openExternal="openExternal" />
      </div>
    </div>

    <!-- 卡片网格（转录 / 分离 / 修复·VR 沿用） -->
    <Transition v-else-if="showGrid" name="vmfade" mode="out-in">
      <div class="vm-grid" :key="listKind">
        <div v-for="(m, i) in tabbedList" :key="m.id" class="vm-card" :class="{ inst: m.exists, down: isDownloading(m) || isPaused(m), fail: isFailed(m) }" :style="{ animationDelay: (i * 40) + 'ms' }" @click="detail = m">
          <div class="vm-top" :class="'k-' + (m.kind || 'other')"></div>
          <div class="vm-head">
            <span class="vm-ic"><Icon :name="kindIcon(m)" :size="15" /></span>
            <span class="vm-arch">{{ m.arch || t('未知架构') }}</span>
          </div>
          <div class="vm-name-line"><div class="vm-name">{{ m.name }}</div><span v-if="m.best" class="vm-best" :title="t('该领域效果最佳')">👑 {{ m.best }}</span></div>
          <div class="vm-use">{{ m.use || m.note || '' }}</div>
          <!-- group / runtime / 分卷（Tauri 契约新增字段）：没有就不占位 -->
          <div v-if="m.group || m.runtime || m.parts" class="vm-tags">
            <span v-if="m.group" class="vm-tag">{{ m.group }}</span>
            <span v-if="m.runtime" class="vm-tag mono" :title="t('运行时')">{{ m.runtime }}</span>
            <span v-if="m.parts" class="vm-tag">{{ t('分卷') }} {{ partsText(m) }}</span>
          </div>
          <div class="vm-foot">
            <template v-if="m.external">
              <span class="pill">{{ t('外部来源') }}</span>
              <button class="btn sm" @click.stop="openExternal(m)">{{ t('打开来源') }}</button>
            </template>
            <template v-else>
              <span class="pill" :class="stateClass(m)">{{ stateLabel(m) }}</span>
              <span class="vm-size">{{ sizeLabel(m) }}</span>
            </template>
          </div>
          <div v-if="isDownloading(m) || isPaused(m)" class="mini-bar" :class="{ paused: isPaused(m) }"><i :style="{ transform: 'scaleX(' + (pct(m) / 100) + ')' }"></i></div>
          <!-- 三态操作：下载中 [暂停][取消] · 已暂停 [继续][取消] · 失败 [重试] -->
          <div v-if="!m.external && (isDownloading(m) || isPaused(m) || isFailed(m))" class="vm-dl-acts" @click.stop>
            <template v-if="isDownloading(m)">
              <button class="btn sm ghost" @click.stop="pauseDownload(m.id)">{{ t('暂停') }}</button>
              <button class="btn sm ghost danger" @click.stop="cancelDownload(m.id)">{{ t('取消') }}</button>
            </template>
            <template v-else-if="isPaused(m)">
              <button class="btn sm primary" @click.stop="startDownload(m)">{{ t('继续') }}</button>
              <button class="btn sm ghost danger" @click.stop="cancelDownload(m.id)">{{ t('取消') }}</button>
            </template>
            <template v-else>
              <button class="btn sm" @click.stop="startDownload(m)">{{ t('重试') }}</button>
              <span class="vm-err-inline" :title="prog[m.id] && prog[m.id].error">{{ (prog[m.id] && prog[m.id].error) || t('下载失败') }}</span>
            </template>
          </div>
        </div>
        <div v-if="!tabbedList.length" class="vm-empty">
          <div class="vm-empty-ic"><Icon name="box" :size="30" /></div>
          <b>{{ t('该分类暂无模型') }}</b>
        </div>
      </div>
    </Transition>

    <!-- 详情抽屉 -->
    <Transition name="dr">
      <div v-if="detail" class="vm-scrim" @click.self="closeDetail">
        <div class="vm-drawer">
          <div class="vm-drawer-head">
            <span class="dm-ic"><Icon :name="kindIcon(detail)" :size="16" /></span>
            <div class="dm-title">
              <b>{{ detail.name }}</b>
              <small>{{ detail.arch }} · {{ kindLabel(detail.kind) }}</small>
            </div>
            <button class="icon-btn" style="margin-left:auto" @click="closeDetail"><Icon name="close" :size="15" /></button>
          </div>

          <div class="vm-drawer-body">
            <div class="vm-hero">
              <div class="hero-use">{{ detail.use || detail.note || '—' }}</div>
            </div>
            <div class="vm-meta">
              <div class="meta-row"><span class="meta-k">{{ t('架构') }}</span><span>{{ detail.arch || '—' }}</span></div>
              <div class="meta-row"><span class="meta-k">{{ t('分类') }}</span><span>{{ kindLabel(detail.kind) }}</span></div>
              <!-- Tauri 模型契约新增字段：group / runtime / type 有就显示，没有不占位 -->
              <div v-if="detail.group" class="meta-row"><span class="meta-k">{{ t('分组') }}</span><span class="mono">{{ detail.group }}</span></div>
              <div v-if="detail.runtime" class="meta-row"><span class="meta-k">{{ t('运行时') }}</span><span class="mono">{{ detail.runtime }}</span></div>
              <div v-if="detail.type" class="meta-row"><span class="meta-k">{{ t('类型') }}</span><span>{{ typeLabel(detail.type) }}</span></div>
              <!-- 大小：未下载时给清单大小 / minSize，不再是 0 -->
              <div class="meta-row"><span class="meta-k">{{ t('大小') }}</span><span>{{ sizeLabel(detail) || '—' }}</span></div>
              <div v-if="detail.repo" class="meta-row"><span class="meta-k">{{ t('来源') }}</span><span class="mono">{{ detail.repo }}</span></div>
              <!-- ★ 2026-10-21：分卷大小不再硬编码 25MB —— MIROS 的分片是 ~900MB/片，
                   写死会让用户以为下 6×25MB。有 partSizes 就按实际算，没有再只报片数。 -->
              <div v-if="detail.parts" class="meta-row"><span class="meta-k">{{ t('分卷') }}</span><span>{{ partsText(detail) }}</span></div>
              <div v-if="!detail.exists && manifestLabel(detail)" class="meta-row"><span class="meta-k">{{ t('清单大小') }}</span><span>{{ manifestLabel(detail) }}</span></div>
              <!-- 运行时包（hFT / YourMT3+ / MIROS）：解包型条目，下的是「运行时 + 权重」一整套 -->
              <div v-if="isRuntimeBundle(detail)" class="meta-row"><span class="meta-k">{{ t('运行时包') }}</span><span>{{ t('运行时包（含依赖 + 权重，解包后即用）') }}</span></div>
            </div>
            <p class="vm-note">{{ detail.note }}</p>

            <div v-if="isDownloading(detail) || isPaused(detail)" class="vm-prog-box">
              <div class="vm-prog-bar" :class="{ paused: isPaused(detail) }"><i :style="{ transform: 'scaleX(' + (pct(detail) / 100) + ')' }"></i></div>
              <div class="vm-prog-txt">
                <span class="pc">{{ pct(detail) }}%</span>
                <span v-if="isPaused(detail)" class="vm-paused">{{ t('已暂停') }}</span>
                <span v-else-if="prog[detail.id].speed">⚡ {{ speedTxt(prog[detail.id].speed) }}</span>
                <span>{{ human(prog[detail.id].received) }} / {{ human(prog[detail.id].total) }}</span>
              </div>
              <div v-if="progressHint(detail)" class="vm-prog-hint">{{ progressHint(detail) }}</div>
            </div>
            <div v-if="isFailed(detail)" class="vm-err">{{ prog[detail.id].error || t('下载失败') }}</div>
          </div>

          <div class="vm-drawer-foot">
            <template v-if="detail.external">
              <button class="btn sm primary" @click="openExternal(detail)">{{ t('打开来源') }}</button>
            </template>
            <template v-else-if="isDownloading(detail)">
              <button class="btn sm ghost" @click="pauseDownload(detail.id)">{{ t('暂停下载') }}</button>
              <button class="btn sm ghost danger" @click="cancelDownload(detail.id)">{{ t('取消下载') }}</button>
            </template>
            <template v-else-if="isPaused(detail)">
              <button class="btn sm primary" @click="startDownload(detail)">{{ t('继续下载') }}</button>
              <button class="btn sm ghost danger" @click="cancelDownload(detail.id)">{{ t('取消下载') }}</button>
            </template>
            <template v-else-if="isFailed(detail)">
              <button v-if="detail.exists" class="btn sm ghost danger" @click="deleteModel(detail)">{{ t('删除') }}</button>
              <button class="btn sm primary" @click="startDownload(detail)">{{ t('重试') }}</button>
            </template>
            <template v-else>
              <button v-if="detail.exists" class="btn sm ghost danger" @click="deleteModel(detail)">{{ t('删除') }}</button>
              <span v-if="detail.downloadable === false" class="pill off">{{ t('随包自带') }}</span>
              <button v-else class="btn sm primary" @click="startDownload(detail)">{{ detail.exists ? t('重新下载') : t('下载') }}</button>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.vm-page { }
/* UTAU 声库页签：声库卡片网格自带样式，这里只给一层容器间距 */
.vm-utau { margin-top: 4px; }
/* 翻唱模型页签：面板自带间距 */
.vm-rvc { margin-top: 4px; }

/* ===== 页签 ===== */
/*** 页签：与全局 .btn/.tab 一致的轻量 pill 风格，去掉厚重渐变与强投影 ***/
.vm-tabs { display: flex; gap: var(--sp-2); margin-bottom: 16px; flex-wrap: wrap; }

/* ===== 依赖补全醒目提示 ===== */
.vm-dep-tip { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: 14px; padding: 9px 14px; border-radius: var(--r-lg); border: 1px solid color-mix(in srgb, var(--brand-coral) 38%, transparent); background: color-mix(in srgb, var(--brand-coral) 11%, var(--surface)); color: var(--ink); font-size: var(--fs-md); font-weight: 700; line-height: 1.5; }
.vm-dep-ic { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; border-radius: 50%; background: color-mix(in srgb, var(--brand-coral) 18%, transparent); color: var(--brand-coral); flex: none; }

.vm-tab { display: inline-flex; align-items: center; gap: var(--sp-2); padding: 6px 14px; border: 1px solid var(--hairline); border-radius: var(--r-pill); background: transparent; color: var(--steel); font-size: var(--fs-md); font-weight: 600; cursor: pointer; transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.vm-tab:hover { background: var(--surface-soft); color: var(--ink); }
.vm-tab .tb-ic { display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center; border-radius: 50%; background: var(--surface-soft); color: var(--steel); transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out); }
.vm-tab.active { background: color-mix(in srgb, var(--brand-coral) 15%, var(--surface)); border-color: color-mix(in srgb, var(--brand-coral) 32%, transparent); color: var(--ink); }
.vm-tab.active .tb-ic { background: color-mix(in srgb, var(--brand-coral) 18%, transparent); color: var(--brand-coral); }
.vm-tab .tb-cnt { font-size: var(--fs-xs); font-style: normal; background: var(--surface-soft); color: var(--stone); border-radius: var(--r-lg); padding: 0 7px; line-height: 16px; }
.vm-tab.active .tb-cnt { background: color-mix(in srgb, var(--brand-coral) 14%, transparent); color: var(--brand-coral); }

/* ===== 卡片网格 ===== */
.vm-import { grid-column: 1 / -1; display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; padding: 10px 12px; border: 1px dashed var(--hairline); border-radius: var(--r-md); background: var(--surface-soft); }
.vm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(238px, 1fr)); gap: var(--sp-4); }
.vm-card { position: relative; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--r-lg); padding: 14px 16px 12px; background: var(--surface); cursor: pointer; display: flex; flex-direction: column; gap: var(--sp-2); min-height: 128px; transition: transform var(--motion-base) var(--ease-out), box-shadow var(--motion-base) var(--ease-out), border-color var(--motion-base) var(--ease-out); }
.vm-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lg); border-color: color-mix(in srgb, var(--brand-coral) 40%, transparent); }
.vm-card.inst { border-color: color-mix(in srgb, var(--ok, var(--t-ok)) 45%, transparent); }
.vm-card.down { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }
.vm-top { position: absolute; left: 0; right: 0; top: 0; height: 4px; }
.vm-top.k-transcribe { background: linear-gradient(90deg, var(--data-7), var(--data-1)); }
.vm-top.k-separate { background: linear-gradient(90deg, var(--t-info), var(--t-info)); }
.vm-top.k-other { background: linear-gradient(90deg, var(--data-4), var(--data-5)); }
.vm-top.k-tts { background: linear-gradient(90deg, var(--data-6), var(--data-7)); }
.vm-top.k-tuning { background: linear-gradient(90deg, var(--data-2), var(--data-1)); }
/* 调教的二级页签：比顶层轻一档（胶囊、小一号），避免和顶层抢层级 */
.vm-subtabs { display: flex; gap: var(--sp-2); margin: -6px 0 14px; flex-wrap: wrap; }
.vm-subtab { display: inline-flex; align-items: center; gap: var(--sp-1); padding: 4px 11px; border: 1px solid var(--hairline); border-radius: var(--r-pill); background: var(--surface); color: var(--slate); font-size: var(--fs-sm); cursor: pointer; }
.vm-subtab .tb-ic { display: inline-flex; width: 17px; height: 17px; align-items: center; justify-content: center; }
.vm-subtab:hover { background: var(--surface-soft); color: var(--ink); }
.vm-subtab.active { background: color-mix(in srgb, var(--brand-coral) 12%, var(--surface)); border-color: color-mix(in srgb, var(--brand-coral) 42%, var(--hairline)); color: var(--ink); }

.vm-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.vm-ic { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: var(--r-md); background: var(--surface-soft); color: var(--brand-coral); font-size: var(--fs-lg); }
.vm-arch { font-size: var(--fs-xs); font-weight: 600; color: var(--stone); text-transform: uppercase; letter-spacing: .2px; font-family: var(--mono); transition: color var(--motion-fast) var(--ease-out); }
.vm-card:hover .vm-arch { color: var(--brand-coral); }
.vm-name { font-size: var(--fs-md); font-weight: 700; color: var(--ink); }
.vm-name-line { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.vm-best { display: inline-flex; align-items: center; gap: 2px; font-size: var(--fs-xs); font-weight: 700; color: var(--t-warn); background: linear-gradient(135deg, var(--data-2), var(--data-3)); padding: 1px 6px; border-radius: var(--r-lg); line-height: 15px; }
.vm-use { font-size: var(--fs-sm); color: var(--slate); line-height: 1.6; flex: 1; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.vm-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }
.pill { font-size: var(--fs-xs); font-weight: 700; padding: 2px 8px; border-radius: var(--r-lg); letter-spacing: .2px; }
.pill.on { background: color-mix(in srgb, var(--ok,var(--t-ok)) 14%, transparent); color: var(--ok,var(--t-ok)); }
.pill.run { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
.pill.off { background: var(--surface-soft); color: var(--stone); }
.vm-size { font-size: var(--fs-xs); color: var(--stone); font-family: var(--mono); }
.pill.pause { background: color-mix(in srgb, var(--t-warn) 16%, transparent); color: var(--t-warn); }
.pill.bad { background: color-mix(in srgb, var(--error) 14%, transparent); color: var(--error); }
/* group / runtime / 分卷：契约新增字段的小标签（没有就不渲染） */
.vm-tags { display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; }
.vm-tag { font-size: var(--fs-xs); line-height: 16px; padding: 0 6px; border-radius: var(--r-sm); background: var(--surface-soft); color: var(--stone); }
.vm-tag.mono { font-family: var(--mono); }
/* 三态操作条：暂停 / 继续 / 取消 / 重试 */
.vm-dl-acts { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: 2px; }
.vm-err-inline { flex: 1; min-width: 0; font-size: var(--fs-xs); color: var(--error); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vm-card.fail { border-color: color-mix(in srgb, var(--error) 38%, transparent); }
.mini-bar { height: 4px; border-radius: var(--r-pill); background: var(--surface-soft); overflow: hidden; margin-top: 4px; }
.mini-bar i { display: block; height: 100%; border-radius: var(--r-pill); background: linear-gradient(90deg, var(--accent), var(--brand-coral)); transition: transform var(--motion-base) var(--ease-out); }
.mini-bar.paused i { background: linear-gradient(90deg, color-mix(in srgb, var(--t-warn) 80%, var(--brand-coral)), var(--t-warn)); }
.vm-empty { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; gap: var(--sp-3); padding: 56px 0; color: var(--stone); }
.vm-empty-ic { opacity: .35; }

/* ===== 抽屉 ===== */
.vm-scrim { position: fixed; inset: 0; background: rgba(8,10,16,.45); -webkit-backdrop-filter: blur(8px) saturate(1.4); backdrop-filter: blur(8px) saturate(1.4); z-index: 130; display: flex; align-items: center; justify-content: center; padding: 24px; }
.scrim-bg { background: linear-gradient(160deg, rgba(16,18,28,.6), rgba(8,10,16,.5)); }
.vm-drawer { width: 440px; max-width: 94vw; max-height: 88vh; background: var(--glass-bg-strong); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); border: 1px solid color-mix(in srgb, var(--on-accent) 26%, transparent); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; overflow: hidden; }
.vm-drawer-head { display: flex; align-items: center; gap: var(--sp-3); padding: 14px 16px; border-bottom: 1px solid var(--hairline); }
.dm-ic { display: inline-flex; width: 34px; height: 34px; flex:none; align-items: center; justify-content: center; border-radius: var(--r-md); background: linear-gradient(135deg, var(--brand-coral), color-mix(in srgb, var(--brand-coral) 70%, var(--data-6))); color: var(--on-accent); }
.dm-title { display: flex; flex-direction: column; min-width: 0; }
.dm-title b { font-size: var(--fs-lg); color: var(--ink); }
.dm-title small { font-size: var(--fs-xs); color: var(--stone); }
.vm-drawer-body { padding: 14px 16px 8px; overflow-y: auto; }
.vm-hero { background: linear-gradient(135deg, color-mix(in srgb, var(--brand-coral) 8%, transparent), color-mix(in srgb, var(--data-6) 8%, transparent)); border: 1px solid color-mix(in srgb, var(--brand-coral) 22%, transparent); border-radius: var(--r-md); padding: 12px 14px; margin-bottom: 12px; }
.hero-use { font-size: var(--fs-md); color: var(--ink); line-height: 1.65; }
.vm-meta { border: 1px solid var(--hairline); border-radius: var(--r-md); padding: 4px 14px; }
.meta-row { display: flex; align-items: center; gap: var(--sp-3); padding: 8px 0; border-bottom: 1px dashed var(--hairline); font-size: var(--fs-sm); color: var(--ink); }
.meta-row:last-child { border-bottom: 0; }
.meta-k { color: var(--stone); width: 52px; flex: none; font-size: var(--fs-sm); }
.meta-row .mono { font-family: var(--mono); color: var(--slate); overflow: hidden; text-overflow: ellipsis; }
.vm-note { font-size: var(--fs-sm); color: var(--stone); margin: 10px 2px; line-height: 1.65; }
.vm-drawer-foot { display: flex; justify-content: flex-end; gap: var(--sp-2); padding: 12px 16px; border-top: 1px solid var(--hairline); background: var(--surface); }
.df-group { display: flex; gap: var(--sp-2); }

/* ===== 进度 ===== */
.vm-prog-box { margin-top: 8px; }
.vm-prog-bar { height: 8px; border-radius: var(--r-pill); background: var(--surface-soft); overflow: hidden; }
.vm-prog-bar i { display: block; height: 100%; border-radius: var(--r-pill); background: linear-gradient(90deg, var(--accent), var(--brand-coral)); transition: transform var(--motion-base) var(--ease-out); }
.vm-prog-bar.paused i { background: linear-gradient(90deg, color-mix(in srgb, var(--t-warn) 75%, var(--brand-coral)), var(--t-warn)); }
.vm-prog-txt { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-xs); color: var(--stone); margin-top: 6px; }
.vm-prog-txt .vm-paused { color: var(--t-warn); font-weight: 700; }
.vm-prog-hint { margin-top: 4px; font-size: var(--fs-xs); color: var(--stone); line-height: 1.5; }
.vm-prog-txt .pc { font-weight: 800; font-size: var(--fs-md); color: var(--ink); font-family: var(--mono); }
.vm-prog-name { font-size: var(--fs-sm); font-weight: 600; color: var(--ink); margin-bottom: 5px; }
.vm-err { color: var(--error); font-size: var(--fs-sm); margin-top: 8px; }

/* ===== 弹窗 ===== */
.vm-pop { width: 480px; max-width: 92vw; max-height: 70vh; background: var(--glass-bg-strong); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); border: 1px solid color-mix(in srgb, var(--on-accent) 26%, transparent); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; overflow: hidden; }
.vm-pop-body { padding: 10px 16px 14px; overflow-y: auto; }
.dd-item { padding: 10px 0; border-bottom: 1px dashed var(--hairline); }
.dd-item:last-child { border-bottom: 0; }

/* ===== 动画（整套应用风格：每次交互皆有流畅过渡） ===== */
@keyframes vmUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.vm-card { animation: vmUp var(--motion-slow) var(--ease-out) both; }
.vmcard-empty { animation: none; }
.vmfade-enter-active, .vmfade-leave-active { transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.vmfade-enter-from, .vmfade-leave-to { opacity: 0; transform: translateY(6px); }
/* 抽屉：右侧滑入滑出 */
.dr-enter-active, .dr-leave-active { transition: opacity var(--motion-base) var(--ease-out); }
.dr-enter-from, .dr-leave-to { opacity: 0; }
.dr-enter-active .vm-drawer, .dr-leave-active .vm-drawer { transition: transform var(--motion-slow) var(--ease-out); }
.dr-enter-from .vm-drawer, .dr-leave-to .vm-drawer { transform: translateX(100%); }

/* 调教页统一壳：四个子页面共用同一顶部信息条与内容起点 */
.vm-tuning-shell { display: flex; flex-direction: column; gap: var(--sp-3); }
.vm-tuning-head { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border: 1px solid color-mix(in srgb, var(--ornament) 22%, var(--hairline)); border-radius: var(--r-md); background: color-mix(in srgb, var(--surface) 42%, transparent); backdrop-filter: var(--glass-blur); }
.vm-tuning-ic { width: 34px; height: 34px; border-radius: var(--r-sm); display: grid; place-items: center; color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sapphire) 14%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent-sky) 22%, var(--hairline)); flex: none; }
.vm-tuning-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.vm-tuning-copy b { font-size: var(--fs-md); color: var(--text); }
.vm-tuning-copy small { font-size: var(--fs-xs); color: var(--text3); }
.vm-grow { flex: 1; }
.vm-tuning-body { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.vm-tuning-body :deep(.ds-bar), .vm-tuning-body :deep(.vb-bar), .vm-tuning-body :deep(.sm-bar), .vm-tuning-body :deep(.mc-bar) {
  border-radius: var(--r-md);
  border: 1px solid var(--hairline);
  background: color-mix(in srgb, var(--surface) 52%, transparent);
  padding: var(--sp-2) var(--sp-3);
}
.vm-tuning-body :deep(.ds-work-head), .vm-tuning-body :deep(.vb-work-head) {
  margin-top: 0;
}

/* 调教四个子页统一：顶部来源说明由 vm-tuning-head 负责，内部来源标题不再重复 */
.vm-tuning-body :deep(.ds-src), .vm-tuning-body :deep(.vb-src) {
  border: 0;
  background: transparent;
  padding: 0;
  min-height: 0;
  justify-content: flex-end;
}
.vm-tuning-body :deep(.ds-src-txt), .vm-tuning-body :deep(.vb-src-txt), .vm-tuning-body :deep(.mc-src),
.vm-tuning-body :deep(.ds-src-ic), .vm-tuning-body :deep(.vb-src-ic), .vm-tuning-body :deep(.mc-src-ic) {
  display: none;
}
.vm-tuning-body :deep(.ds-bar), .vm-tuning-body :deep(.vb-bar), .vm-tuning-body :deep(.mc-bar) {
  border-radius: var(--r-md);
  border: 1px solid var(--hairline);
  background: color-mix(in srgb, var(--surface) 52%, transparent);
  padding: var(--sp-2) var(--sp-3);
  margin-top: var(--sp-1);
}
/* 调教页视觉收敛（2026-10-23）：去掉“贴片”式标题条，页签改成两段紧凑分段控件 */
.vm-tuning-head {
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
  padding: 0 !important;
  gap: var(--sp-2);
  margin-bottom: var(--sp-1);
}
.vm-tuning-ic {
  width: auto;
  height: auto;
  border: 0;
  background: transparent;
  color: var(--accent-sky);
}
.vm-tuning-copy b { font-size: var(--fs-lg); }
.vm-tuning-copy small { font-size: var(--fs-xs); }

.vm-tabs {
  display: flex;
  gap: 2px;
  width: max-content;
  max-width: 100%;
  padding: 2px;
  margin-bottom: var(--sp-2);
  border: 1px solid var(--hairline);
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--surface) 54%, transparent);
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
}
.vm-tabs::-webkit-scrollbar { display: none; }
.vm-tab {
  border: 0;
  background: transparent;
  border-radius: var(--r-pill);
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-sm);
  font-weight: 500;
  flex: none;
}
.vm-tab:hover { background: color-mix(in srgb, var(--accent-sky) 8%, transparent); }
.vm-tab.active {
  border: 0;
  background: color-mix(in srgb, var(--accent-sapphire) 22%, var(--surface));
  color: var(--text);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-sky) 28%, transparent);
}
.vm-tab.active .tb-ic { background: transparent; color: var(--accent-sky); }
.vm-tab .tb-ic { background: transparent; width: auto; height: auto; }
.vm-tab .tb-cnt { background: color-mix(in srgb, var(--surface) 60%, transparent); }

.vm-subtabs {
  display: flex;
  gap: 2px;
  width: max-content;
  max-width: 100%;
  padding: 2px;
  margin: 0 0 var(--sp-3);
  border: 1px solid var(--hairline);
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--surface) 42%, transparent);
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
}
.vm-subtabs::-webkit-scrollbar { display: none; }
.vm-subtab {
  border: 0;
  background: transparent;
  border-radius: var(--r-pill);
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-sm);
  flex: none;
}
.vm-subtab.active {
  background: color-mix(in srgb, var(--accent-sky) 14%, var(--surface));
  border: 0;
  color: var(--text);
}
</style>
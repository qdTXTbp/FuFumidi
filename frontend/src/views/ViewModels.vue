<script setup>
// 模型管理：独立页面，卡片式管理全部模型（转录 / 人声分离 / 其它）
// - 卡片：用处 + 架构徽标 + 大小 + 状态
// - 点击卡片 → 右侧详情抽屉（含下载/删除）
// - 下载中关闭抽屉 → 全屏弹窗实时显示 速度 + 进度（可取消）
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import Icon from '../components/Icon.vue';
import DiffSingerCatalog from './DiffSingerCatalog.vue';
import ModelCatalog from '../components/models/ModelCatalog.vue';
import UtauVoicebankStore from '../components/utau/UtauVoicebankStore.vue';
import RvcModelPanel from '../components/cover/RvcModelPanel.vue';
import { useAppStore } from '../stores/app';
import { useVoicebankStore } from '../stores/voicebank';
import { t } from '../core/i18n.js';

const app = useAppStore();
const vbStore = useVoicebankStore();
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
const prog = reactive({});            // id -> {active, percent, speed, received, total, done, error}
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
}
function setProg(p) {
  const cur = prog[p.id] || {};
  prog[p.id] = { ...cur, ...p, active: !!(p.done ? false : (p.active !== false ? cur.active !== false : true)) };
  if (p.done) prog[p.id].active = false;
  if (p.error) prog[p.id].active = false;
}
function onProgress(p) {
  if (!p || !p.id) return;
  setProg(p);
}

/* ---------------- 下载 ---------------- */
function startDownload(m) {
  if (!bridge || !bridge.modelDownload) return;
  if (prog[m.id] && prog[m.id].active) return;
  prog[m.id] = { active: true, percent: 0, speed: 0, received: 0, total: 0 };
  bridge.modelDownload(m.id, 'huggingface').then(r => {
    prog[m.id] = { active: false, percent: 100, done: true, speed: 0 };
    if (!r || !r.ok) { prog[m.id].error = (r && r.error) || t('下载失败'); prog[m.id].done = false; }
    refresh();
  }).catch(e => {
    prog[m.id] = { active: false, done: false, error: String((e && e.message) || e) };
  });
}
function cancelDownload(id) {
  if (bridge && bridge.modelCancel) bridge.modelCancel(id);
}
function deleteModel(m) {
  if (!bridge || !bridge.modelDelete) return;
  if (!window.confirm(t('删除模型「') + m.name + t('」？'))) return;
  bridge.modelDelete(m.id).then(() => { refresh(); toast(t('已删除'), 'ok'); }).catch(() => toast(t('删除失败'), 'warn'));
}

/* ---------------- 下载详情抽屉（下载进度通知已移到全局顶部） ---------------- */
function closeDetail() {
  detail.value = null;
}

/* ---------------- 生命周期 ---------------- */
let off = null;
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
  await refresh();
  loading.value = false;
  for (const m of list.value) { if (m.active) prog[m.id] = { ...(prog[m.id] || {}), active: true, percent: prog[m.id] ? prog[m.id].percent : 0 }; }
  if (bridge && bridge.onModelProgress) off = bridge.onModelProgress(onProgress);
  prefetchDiffSingerStats();
});
onBeforeUnmount(() => { if (off) try { off(); } catch (e) {} });
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
                  @cancel="(it) => cancelDownload(it.id)" @openExternal="openExternal" />
      </div>
    </div>

    <!-- 卡片网格（转录 / 分离 / 修复·VR 沿用） -->
    <Transition v-else-if="showGrid" name="vmfade" mode="out-in">
      <div class="vm-grid" :key="listKind">
        <div v-for="(m, i) in tabbedList" :key="m.id" class="vm-card" :class="{ inst: m.exists, down: prog[m.id] && prog[m.id].active }" :style="{ animationDelay: (i * 40) + 'ms' }" @click="detail = m">
          <div class="vm-top" :class="'k-' + (m.kind || 'other')"></div>
          <div class="vm-head">
            <span class="vm-ic"><Icon :name="kindIcon(m)" :size="15" /></span>
            <span class="vm-arch">{{ m.arch || t('未知架构') }}</span>
          </div>
          <div class="vm-name-line"><div class="vm-name">{{ m.name }}</div><span v-if="m.best" class="vm-best" :title="t('该领域效果最佳')">👑 {{ m.best }}</span></div>
          <div class="vm-use">{{ m.use || m.note || '' }}</div>
          <div class="vm-foot">
            <template v-if="m.external">
              <span class="pill">{{ t('外部来源') }}</span>
              <button class="btn sm" @click.stop="openExternal(m)">{{ t('打开来源') }}</button>
            </template>
            <template v-else>
              <span class="pill" :class="m.exists ? 'on' : (prog[m.id] && prog[m.id].active ? 'run' : 'off')">{{ m.exists ? t('已安装') : (prog[m.id] && prog[m.id].active ? (prog[m.id].percent || 0) + '%' : t('未安装')) }}</span>
              <span class="vm-size">{{ human(prog[m.id] && prog[m.id].received || m.size) }}</span>
            </template>
          </div>
          <div v-if="prog[m.id] && prog[m.id].active" class="mini-bar"><i :style="{ transform: 'scaleX(' + (((prog[m.id].percent || 0)) / 100) + ')' }"></i></div>
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
              <div class="meta-row"><span class="meta-k">{{ t('大小') }}</span><span>{{ human(detail.size) }}</span></div>
              <div v-if="detail.repo" class="meta-row"><span class="meta-k">{{ t('来源') }}</span><span class="mono">{{ detail.repo }}</span></div>
              <div v-if="detail.parts" class="meta-row"><span class="meta-k">{{ t('分卷') }}</span><span>{{ detail.parts }} × 25MB</span></div>
            </div>
            <p class="vm-note">{{ detail.note }}</p>

            <div v-if="prog[detail.id] && prog[detail.id].active" class="vm-prog-box">
              <div class="vm-prog-bar"><i :style="{ transform: 'scaleX(' + (((prog[detail.id].percent || 0)) / 100) + ')' }"></i></div>
              <div class="vm-prog-txt">
                <span class="pc">{{ (prog[detail.id].percent || 0) }}%</span>
                <span v-if="prog[detail.id].speed">⚡ {{ speedTxt(prog[detail.id].speed) }}</span>
                <span>{{ human(prog[detail.id].received) }} / {{ human(prog[detail.id].total) }}</span>
              </div>
            </div>
            <div v-if="prog[detail.id] && prog[detail.id].error" class="vm-err">{{ prog[detail.id].error }}</div>
          </div>

          <div class="vm-drawer-foot">
            <div v-if="detail.external" class="df-group">
              <button class="btn sm primary" @click="openExternal(detail)">{{ t('打开来源') }}</button>
            </div>
            <div v-else-if="!(prog[detail.id] && prog[detail.id].active)" class="df-group">
              <button v-if="detail.exists" class="btn sm ghost danger" @click="deleteModel(detail)">{{ t('删除') }}</button>
              <button class="btn sm primary" @click="startDownload(detail)">{{ detail.exists ? t('重新下载') : t('下载') }}</button>
            </div>
            <button v-else class="btn sm ghost danger" @click="cancelDownload(detail.id)">{{ t('取消下载') }}</button>
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
.mini-bar { height: 4px; border-radius: var(--r-pill); background: var(--surface-soft); overflow: hidden; margin-top: 4px; }
.mini-bar i { display: block; height: 100%; border-radius: var(--r-pill); background: linear-gradient(90deg, var(--accent), var(--brand-coral)); transition: transform var(--motion-base) var(--ease-out); }
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
.vm-prog-txt { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-xs); color: var(--stone); margin-top: 6px; }
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
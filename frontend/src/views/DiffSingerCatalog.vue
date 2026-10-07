<script setup>
// DiffSinger 声库目录（资源中心 · 模型管理 → DiffSinger）
// ------------------------------------------------------------
// 数据源：ModelScope aihobbyist/ACG-DiffSinger-VoiceDB
//   - 清单由 scripts/diffsinger-ms/sync.mjs 从官方 API 抽取，完整列出、不遗漏；
//   - 分组：作品（原神 / 崩坏：星穹铁道）→ 目录（地区 / 部分）→ 角色；
//   - 搜索：模型名称 / 分类 / 说明 全字段匹配；筛选：作品 + 目录 + 状态；
//   - 下载：直连 ModelScope 官方地址（全球同源），完成后自动解压注册。
import { ref, reactive, computed, onMounted, onActivated, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { useVoicebankStore } from '../stores/voicebank';
import { useSingerStore } from '../stores/singer';
import { t } from '../core/i18n.js';

const app = useAppStore();
const vbStore = useVoicebankStore();
const singerStore = useSingerStore();
const toast = (m, type) => app.toast(m, type);
const bridge = window.fuBridge;

const loading = ref(false);
const data = ref(null);
const errMsg = ref('');
const query = ref('');
const workFilter = ref('all');
const catFilter = ref('all');
const stateFilter = ref('all');   // all | available | installed | placeholder

const prog = reactive({});        // name -> {active, percent, received, total, error}

/* ---------------- 数据加载 ---------------- */
// 把目录统计回写共享 store，供 ViewModels 页签徽标 / 页面副标题显示真实数量
// （此前 countFor('diffsinger') 恒为 0，用户看到「可下载声库数量为 0」）
function publishStats() {
  if (!data.value) return;
  const st = data.value.stats || {};
  vbStore.setDiffsingerStats(st);
  let installed = 0;
  for (const w of (data.value.works || [])) {
    for (const c of (w.categories || [])) {
      for (const m of (c.models || [])) if (m.installed) installed++;
    }
  }
  vbStore.setDiffsingerInstalled(installed);
}

async function refresh() {
  if (!bridge || !bridge.diffsingerMsCatalog) { errMsg.value = t('当前环境不支持声库目录'); return; }
  loading.value = true;
  try {
    const r = await bridge.diffsingerMsCatalog();
    if (r && r.ok) { data.value = r; errMsg.value = ''; publishStats(); }
    else errMsg.value = (r && r.error) || t('加载失败');
  } catch (e) {
    errMsg.value = String((e && e.message) || e);
  } finally {
    loading.value = false;
  }
}

/* ---------------- 分组与统计 ---------------- */
const works = computed(() => (data.value && data.value.works) || []);
const stats = computed(() => (data.value && data.value.stats) || { total: 0, available: 0, placeholder: 0, works: [] });

function countWork(w) {
  return w.categories.reduce((s, c) => s + c.models.length, 0);
}

/** 当前作品下的所有目录（供目录筛选下拉） */
const catOptions = computed(() => {
  const seen = [];
  for (const w of works.value) {
    if (workFilter.value !== 'all' && w.id !== workFilter.value) continue;
    for (const c of w.categories) if (!seen.includes(c.label)) seen.push(c.label);
  }
  return seen;
});

/** 按「作品 → 目录 → 模型」逐层应用搜索与筛选 */
const filteredWorks = computed(() => {
  const q = query.value.trim().toLowerCase();
  const out = [];
  for (const w of works.value) {
    if (workFilter.value !== 'all' && w.id !== workFilter.value) continue;
    const cats = [];
    for (const c of w.categories) {
      if (catFilter.value !== 'all' && c.label !== catFilter.value) continue;
      const models = c.models.filter((m) => {
        if (stateFilter.value === 'available' && m.placeholder) return false;
        if (stateFilter.value === 'installed' && !m.installed) return false;
        if (stateFilter.value === 'placeholder' && !m.placeholder) return false;
        if (!q) return true;
        return (m.name + ' ' + m.category + ' ' + m.desc + ' ' + m.work).toLowerCase().includes(q);
      });
      if (models.length) cats.push({ ...c, models });
    }
    if (cats.length) out.push({ ...w, categories: cats });
  }
  return out;
});

const shownCount = computed(() => filteredWorks.value.reduce((s, w) => s + w.categories.reduce((x, c) => x + c.models.length, 0), 0));
const hasFilter = computed(() => !!(query.value.trim() || workFilter.value !== 'all' || catFilter.value !== 'all' || stateFilter.value !== 'all'));

function resetFilters() {
  query.value = '';
  workFilter.value = 'all';
  catFilter.value = 'all';
  stateFilter.value = 'all';
}
function pickWork(id) {
  workFilter.value = id;
  catFilter.value = 'all';
}

/* ---------------- 工具 ---------------- */
function human(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}

/* ---------------- 下载 ---------------- */
function isBusy(name) { return !!(prog[name] && prog[name].active); }

/** 目录 + 歌手下拉数据源一起刷新：装完/删完声库后，
 *  歌声合成页（ViewSing）的歌手下拉读的是 singer store 的 banks —— 不刷它就是「装了选不到」。 */
async function refreshAll() {
  await refresh();
  await singerStore.loadBanks();
}

function startDownload(m) {
  if (!bridge || !bridge.diffsingerMsDownload) return;
  if (m.placeholder) { toast(t('该声库上游尚未上传权重，暂不可下载'), 'warn'); return; }
  if (isBusy(m.name)) return;
  prog[m.name] = { active: true, percent: 0, received: 0, total: m.size || 0, error: '' };
  bridge.diffsingerMsDownload({ name: m.name, path: m.path }).then((r) => {
    if (r && r.ok) {
      prog[m.name] = { active: false, percent: 100, done: true, received: 0, total: 0, error: '' };
      toast(t('已安装：') + m.name, 'ok');
      refreshAll();
    } else if (r && r.canceled) {
      prog[m.name] = { active: false, percent: 0, received: 0, total: 0, error: '' };
    } else {
      prog[m.name] = { active: false, percent: 0, received: 0, total: 0, error: (r && r.error) || t('下载失败') };
      toast(prog[m.name].error, 'warn');
    }
  }).catch((e) => {
    prog[m.name] = { active: false, percent: 0, received: 0, total: 0, error: String((e && e.message) || e) };
  });
}
function cancelDownload(name) {
  if (bridge && bridge.diffsingerMsCancelDownload) bridge.diffsingerMsCancelDownload(name);
}

function onProgress(p) {
  if (!p || !p.id) return;
  const cur = prog[p.id] || {};
  const next = {
    ...cur,
    percent: p.percent || 0,
    received: p.received || 0,
    total: p.total || cur.total || 0,
    speed: p.speed || 0,
    phase: p.phase || cur.phase || '',
    text: p.text || '',
    error: p.error || '',
  };
  if (p.done || p.phase === 'done') { next.active = false; next.percent = 100; next.done = true; next.phase = 'done'; }
  else if (p.phase === 'error') { next.active = false; next.error = p.error || t('下载失败'); }
  else if (p.phase === 'canceled') { next.active = false; next.percent = 0; }
  else next.active = true;
  prog[p.id] = next;
  if (p.phase === 'done') refreshAll();
}

/** 阶段文案：下载 / 解压 / 安装（与全局通知条进度语义一致） */
function phaseText(name) {
  const st = prog[name];
  if (!st) return '';
  if (st.phase === 'extract') return st.text || t('正在解压…');
  if (st.done) return t('安装完成');
  if (st.error) return st.error;
  return st.text || t('正在下载…');
}
function fmtSpeed(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' MB/s' : (bps / 1e3).toFixed(0) + ' KB/s';
}

let off = null;
onMounted(async () => {
  await refresh();
  if (bridge && bridge.onDiffsingerMsProgress) off = bridge.onDiffsingerMsProgress(onProgress);
});
onBeforeUnmount(() => { if (off) try { off(); } catch (e) {} });
// KeepAlive 保活：视图被缓存，切回来不会重跑 onMounted。别处（导入 zip / 删除声库）
// 改过声库目录后，这里的「已安装」标记与体积会停在旧值 —— 激活时重拉一次目录。
// 加 loading 守卫，避免和进行中的请求叠加。
onActivated(() => { if (!loading.value) refresh(); });
</script>

<template>
  <div class="ds-cat">
    <!-- 顶部：来源说明 + 统计 -->
    <div class="ds-src">
      <span class="ds-src-ic"><Icon name="spark" :size="14" /></span>
      <div class="ds-src-txt">
        <b>{{ t('DiffSinger 声库目录') }}</b>
        <small>
          {{ t('来源') }}：ModelScope ·
          {{ data && data.author ? data.author : '@红血球AE3803' }} ·
          {{ data && data.license ? data.license : 'CC-BY-NC-4.0' }} ·
          {{ t('共') }} {{ stats.total }} {{ t('个声库，其中可用') }} {{ stats.available }} {{ t('个') }}
          <template v-if="stats.placeholder"> · {{ stats.placeholder }} {{ t('个上游占位待发布') }}</template>
        </small>
      </div>
      <button class="btn sm ghost" @click="refresh">{{ t('刷新') }}</button>
    </div>

    <!-- 搜索 + 筛选 -->
    <div class="ds-bar">
      <div class="ds-search">
        <Icon name="search" :size="14" />
        <input v-model="query" type="text" :placeholder="t('搜索模型名称 / 分类 / 角色…')" />
        <button v-if="query" class="ds-clr" @click="query = ''"><Icon name="close" :size="12" /></button>
      </div>
      <select v-model="workFilter" class="ds-sel">
        <option value="all">{{ t('全部作品') }}</option>
        <option v-for="w in stats.works || []" :key="w.id" :value="w.id">{{ w.label }}（{{ w.models }}）</option>
      </select>
      <select v-model="catFilter" class="ds-sel">
        <option value="all">{{ t('全部分类') }}</option>
        <option v-for="c in catOptions" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="stateFilter" class="ds-sel">
        <option value="all">{{ t('全部状态') }}</option>
        <option value="available">{{ t('仅可用') }}</option>
        <option value="installed">{{ t('已安装') }}</option>
        <option value="placeholder">{{ t('占位待发布') }}</option>
      </select>
      <button v-if="hasFilter" class="btn sm ghost" @click="resetFilters">{{ t('清除筛选') }}</button>
    </div>

    <!-- 作品快捷切换 -->
    <div class="ds-works">
      <button class="ds-wchip" :class="{ active: workFilter === 'all' }" @click="pickWork('all')">
        {{ t('全部') }} <i>{{ stats.total }}</i>
      </button>
      <button v-for="w in stats.works || []" :key="w.id" class="ds-wchip" :class="{ active: workFilter === w.id }" @click="pickWork(w.id)">
        {{ w.label }} <i>{{ w.models }}</i>
      </button>
      <span class="ds-shown">{{ t('显示') }} {{ shownCount }} / {{ stats.total }}</span>
    </div>

    <!-- 错误 / 加载 -->
    <div v-if="errMsg" class="ds-err"><Icon name="info" :size="14" /> {{ errMsg }}</div>
    <div v-else-if="loading && !data" class="ds-loading">{{ t('正在加载声库目录…') }}</div>

    <!-- 分组列表：作品 → 目录 → 模型卡片 -->
    <div v-else class="ds-groups">
      <section v-for="w in filteredWorks" :key="w.id" class="ds-work">
        <div class="ds-work-head">
          <span class="ds-work-ic"><Icon name="music" :size="15" /></span>
          <b>{{ w.label }}</b>
          <span class="ds-work-cnt">{{ countWork(w) }} {{ t('个声库') }} · {{ w.categories.length }} {{ t('个分类') }}</span>
        </div>

        <div v-for="c in w.categories" :key="c.source" class="ds-cat-block">
          <div class="ds-cat-head">
            <Icon name="folder" :size="13" />
            <b>{{ c.label }}</b>
            <span v-if="c.desc" class="ds-cat-desc">{{ c.desc }}</span>
            <span class="ds-cat-cnt">{{ c.models.length }}</span>
          </div>
          <div class="ds-grid">
            <div
              v-for="m in c.models"
              :key="m.path"
              class="ds-card"
              :class="{ ph: m.placeholder, inst: m.installed, down: isBusy(m.name) }"
            >
              <div class="ds-card-top">
                <span class="ds-name" :title="m.name">{{ m.name }}</span>
                <span v-if="m.installed" class="ds-badge inst">{{ t('已安装') }}</span>
                <span v-else-if="m.placeholder" class="ds-badge ph">{{ t('待发布') }}</span>
              </div>
              <div class="ds-catline">
                <span class="ds-tag">{{ m.work }}</span>
                <span class="ds-tag">{{ m.category }}</span>
              </div>
              <div class="ds-desc">{{ m.desc }}</div>
              <div class="ds-foot">
                <span class="ds-size">{{ m.placeholder ? t('无权重') : human(m.size) }}</span>
                <div class="ds-acts">
                  <button
                    v-if="isBusy(m.name)"
                    class="ds-btn cancel"
                    @click="cancelDownload(m.name)"
                  >{{ t('取消') }} {{ prog[m.name].percent || 0 }}%</button>
                  <button
                    v-else-if="!m.placeholder"
                    class="ds-btn"
                    :class="{ re: m.installed }"
                    @click="startDownload(m)"
                  ><Icon name="download" :size="12" /> {{ m.installed ? t('重新下载') : t('下载') }}</button>
                  <span v-else class="ds-btn dis">{{ t('暂不可用') }}</span>
                </div>
              </div>
              <div v-if="isBusy(m.name)" class="ds-prog">
                <div class="ds-prog-line">
                  <span class="ds-prog-ph">{{ phaseText(m.name) }}</span>
                  <span v-if="prog[m.name].speed" class="ds-prog-spd">⚡ {{ fmtSpeed(prog[m.name].speed) }}</span>
                </div>
                <div class="ds-bar-mini"><i :style="{ width: (prog[m.name].percent || 0) + '%' }"></i></div>
                <div class="ds-prog-meta">
                  <span>{{ prog[m.name].percent || 0 }}%</span>
                  <span v-if="!prog[m.name].phase || prog[m.name].phase === 'download'">{{ human(prog[m.name].received) }} / {{ human(prog[m.name].total) }}</span>
                </div>
              </div>
              <div v-if="prog[m.name] && prog[m.name].error" class="ds-card-err">{{ prog[m.name].error }}</div>
            </div>
          </div>
        </div>
      </section>

      <div v-if="!filteredWorks.length" class="ds-empty">
        <div class="ds-empty-ic"><Icon name="search" :size="28" /></div>
        <b>{{ t('没有匹配的声库') }}</b>
        <button v-if="hasFilter" class="btn sm ghost" @click="resetFilters">{{ t('清除筛选') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ds-cat { display: flex; flex-direction: column; gap: 14px; }

/* 来源说明条 */
.ds-src { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1px solid var(--hairline); border-radius: 12px; background: var(--surface-soft); }
.ds-src-ic { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: 50%; background: color-mix(in srgb, var(--brand-coral) 14%, transparent); color: var(--brand-coral); flex: 0 0 auto; }
.ds-src-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ds-src-txt b { font-size: 13px; color: var(--ink); }
.ds-src-txt small { font-size: 11.5px; color: var(--stone); }

/* 搜索与筛选条 */
.ds-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ds-search { display: flex; align-items: center; gap: 7px; flex: 1 1 240px; min-width: 200px; padding: 0 10px; height: 32px; border: 1px solid var(--hairline); border-radius: 9px; background: var(--surface); color: var(--stone); }
.ds-search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--ink); font-size: 12.5px; min-width: 0; }
.ds-search input::placeholder { color: var(--stone); }
.ds-clr { display: inline-flex; border: 0; background: transparent; color: var(--stone); cursor: pointer; padding: 2px; border-radius: 50%; }
.ds-clr:hover { color: var(--ink); background: var(--surface-soft); }
.ds-sel { height: 32px; padding: 0 8px; border: 1px solid var(--hairline); border-radius: 9px; background: var(--surface); color: var(--ink); font-size: 12.5px; cursor: pointer; max-width: 190px; }

/* 作品快捷切换 */
.ds-works { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ds-wchip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border: 1px solid var(--hairline); border-radius: 999px; background: transparent; color: var(--steel); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
.ds-wchip:hover { background: var(--surface-soft); color: var(--ink); }
.ds-wchip i { font-style: normal; font-size: 10.5px; color: var(--stone); background: var(--surface-soft); border-radius: 20px; padding: 0 6px; line-height: 15px; }
.ds-wchip.active { background: color-mix(in srgb, var(--brand-coral) 15%, var(--surface)); border-color: color-mix(in srgb, var(--brand-coral) 32%, transparent); color: var(--ink); }
.ds-wchip.active i { background: color-mix(in srgb, var(--brand-coral) 14%, transparent); color: var(--brand-coral); }
.ds-shown { margin-left: auto; font-size: 11.5px; color: var(--stone); }

/* 分组 */
.ds-groups { display: flex; flex-direction: column; gap: 20px; }
.ds-work-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--hairline); }
.ds-work-ic { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: 7px; background: color-mix(in srgb, var(--brand-coral) 12%, transparent); color: var(--brand-coral); }
.ds-work-head b { font-size: 14px; color: var(--ink); }
.ds-work-cnt { font-size: 11.5px; color: var(--stone); }

.ds-cat-block { margin-bottom: 14px; }
.ds-cat-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; color: var(--steel); }
.ds-cat-head b { font-size: 12.5px; color: var(--ink); }
.ds-cat-desc { font-size: 11px; color: var(--stone); }
.ds-cat-cnt { margin-left: auto; font-size: 11px; color: var(--stone); }

/* 模型卡片网格 */
.ds-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 9px; }
.ds-card { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 10px 11px; border: 1px solid var(--hairline); border-radius: 11px; background: var(--surface); overflow: hidden; transition: border-color .15s, background .15s; }
.ds-card:hover { border-color: color-mix(in srgb, var(--brand-coral) 30%, var(--hairline)); }
.ds-card.inst { background: color-mix(in srgb, var(--brand-coral) 4%, var(--surface)); border-color: color-mix(in srgb, var(--brand-coral) 22%, var(--hairline)); }
.ds-card.ph { opacity: .62; }
.ds-card.down { border-color: color-mix(in srgb, var(--brand-coral) 45%, var(--hairline)); }
.ds-card-top { display: flex; align-items: center; gap: 6px; }
.ds-name { font-size: 13px; font-weight: 650; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-badge { font-size: 10px; padding: 1px 6px; border-radius: 20px; line-height: 15px; flex: 0 0 auto; margin-left: auto; }
.ds-badge.inst { background: color-mix(in srgb, var(--brand-coral) 15%, transparent); color: var(--brand-coral); }
.ds-badge.ph { background: var(--surface-soft); color: var(--stone); }
.ds-catline { display: flex; gap: 5px; flex-wrap: wrap; }
.ds-tag { font-size: 10px; padding: 1px 6px; border-radius: 5px; background: var(--surface-soft); color: var(--stone); }
.ds-desc { font-size: 11.5px; color: var(--steel); line-height: 1.45; min-height: 32px; }
.ds-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; }
.ds-size { font-size: 11px; color: var(--stone); font-variant-numeric: tabular-nums; }
.ds-acts { margin-left: auto; }
.ds-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border: 1px solid color-mix(in srgb, var(--brand-coral) 34%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--brand-coral) 12%, transparent); color: var(--brand-coral); font-size: 11.5px; font-weight: 600; cursor: pointer; transition: background .15s; }
.ds-btn:hover { background: color-mix(in srgb, var(--brand-coral) 20%, transparent); }
.ds-btn.re { border-color: var(--hairline); background: transparent; color: var(--steel); }
.ds-btn.re:hover { background: var(--surface-soft); color: var(--ink); }
.ds-btn.cancel { border-color: color-mix(in srgb, var(--brand-coral) 45%, transparent); background: transparent; color: var(--brand-coral); }
.ds-btn.dis { border-color: var(--hairline); background: transparent; color: var(--stone); cursor: not-allowed; }
.ds-bar-mini { height: 3px; border-radius: 2px; background: var(--surface-soft); overflow: hidden; }
.ds-bar-mini i { display: block; height: 100%; background: var(--brand-coral); transition: width .25s ease; }

/* 卡片内进度：阶段文案 + 实时速度 + 字节数（与全局顶部通知条一致） */
.ds-prog { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.ds-prog-line { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--stone); }
.ds-prog-ph { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.ds-prog-spd { flex: 0 0 auto; color: var(--brand-coral); font-variant-numeric: tabular-nums; }
.ds-prog-meta { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--stone); font-variant-numeric: tabular-nums; }
/* 解压/安装阶段无字节进度，给进度条加流光表示“仍在工作” */
.ds-card.down .ds-bar-mini i { background: linear-gradient(90deg, var(--brand-coral), color-mix(in srgb, var(--brand-coral) 55%, #fff), var(--brand-coral)); background-size: 200% 100%; animation: ds-flow 1.2s linear infinite; }
@keyframes ds-flow { to { background-position: -200% 0; } }
.ds-card-err { font-size: 10.5px; color: #c0392b; line-height: 1.35; }

/* 空态与提示 */
.ds-err { display: flex; align-items: center; gap: 7px; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--brand-coral) 30%, var(--hairline)); border-radius: 10px; background: color-mix(in srgb, var(--brand-coral) 6%, var(--surface)); color: var(--ink); font-size: 12.5px; }
.ds-loading { padding: 32px; text-align: center; color: var(--stone); font-size: 13px; }
.ds-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 44px 16px; color: var(--stone); }
.ds-empty-ic { color: var(--stone); opacity: .55; }
.ds-empty b { font-size: 13px; color: var(--steel); }
</style>

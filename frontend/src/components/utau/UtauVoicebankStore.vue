<script setup>
// 声库资源中心：开源 / 免费 UTAU 声库一键下载安装。
// 装完直接落到 <数据根目录>/voicebanks/，可立即在 UTAU 工作台（曲谱与调声 / 合成渲染）选用。
// 所有条目都从作者或上游项目公开托管的仓库按需拉取，使用条款随条目展示。
import { ref, computed, onMounted, onActivated, onBeforeUnmount } from 'vue';
import Icon from '../Icon.vue';
import { useSingerStore } from '../../stores/singer';
import { t } from '../../core/i18n.js';
import ItemMetaEditor from '../models/ItemMetaEditor.vue';
// 用户元数据：名字/作者/标签/分类 + 排序/顶置（四页共用一张表，见 core/usermeta.js）
import {
  loadUserMeta, orderList, displayName, authorOf, tagsOf, isPinned, togglePin, saveOrder, searchHay,
} from '../../core/usermeta.js';

loadUserMeta();      // 进页面读一次用户改动（异步，不阻塞渲染）

const emit = defineEmits(['installed']);
const store = useSingerStore();
const bridge = window.fuBridge;
const isDesktop = !!(bridge && bridge.utauVoicebankRegistry);

const list = ref([]);
const vbRoot = ref('');
const loading = ref(false);
const err = ref('');
const msg = ref('');
const busyId = ref('');
// id -> { percent, phase, error }
const prog = ref({});
let offProgress = null;

const installedCount = computed(() => list.value.filter(x => x.installed).length);

function fmtSize(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  if (v >= 1073741824) return (v / 1073741824).toFixed(1) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(v / 1024)) + ' KB';
}

async function load() {
  if (!isDesktop) return;
  loading.value = true;
  err.value = '';
  try {
    const r = await bridge.utauVoicebankRegistry();
    if (r && r.ok) { list.value = r.list || []; vbRoot.value = r.dir || ''; external.value = r.external || []; }
    else err.value = (r && r.error) || 'unknown';
  } catch (e) { err.value = String((e && e.message) || e); }
  finally { loading.value = false; }
}

// 声库目录变化后刷新**统一**声库列表（singer store 是唯一来源）
async function syncStore() {
  try { await store.loadBanks(); } catch (e) { /* 列表刷新失败不阻塞制作流程 */ }
}

async function install(it) {
  if (!isDesktop) { err.value = t('请在桌面版下载安装声库。'); return; }
  if (busyId.value) return;
  busyId.value = it.id;
  err.value = '';
  msg.value = '';
  prog.value = { ...prog.value, [it.id]: { percent: 0, phase: 'download', retry: 0, error: '', active: true } };
  try {
    const r = await bridge.utauDownloadVoicebank(it.id);
    if (r && r.ok) {
      await load();
      await syncStore(r.dir || '');
      msg.value = (r.existed ? t('该声库已安装：') : t('已安装并设为当前声库：')) + t(r.name || it.name);
      emit('installed', r.dir || '');
    } else if (r && r.canceled) {
      msg.value = t('已取消下载。');
    } else {
      err.value = t('安装失败：') + ((r && r.error) || 'unknown');
    }
  } catch (e) {
    err.value = t('安装失败：') + ((e && e.message) || e);
  } finally {
    busyId.value = '';
    const p = prog.value[it.id];
    if (p) prog.value = { ...prog.value, [it.id]: { ...p, phase: 'done', active: false } };
  }
}

async function cancel(it) {
  try { await bridge.utauCancelVoicebankDownload(it.id); } catch (e) {}
}

/**
 * 「使用」= 把这条声库挂到**当前轨道**上。
 *
 * ★ 引擎是轨道级属性，所以没有「全局当前声库」这回事 ——
 *   切到哪条轨，就把它设成那条轨的歌手。
 */
function use(it) {
  const tr = store.activeTrack;
  if (!tr) { msg.value = t('没有可用的轨道'); return; }
  store.patchTrack(tr.id, {
    engine: 'utau', singer: it.dir, singerName: it.name,
  });
  msg.value = t('已挂到当前轨道：') + t(it.name);
}

async function remove(it) {
  if (!window.confirm(t('确定删除声库「') + t(it.name) + t('」？'))) return;
  try {
    const r = await bridge.utauDeleteVoicebank(it.dir);
    if (r && r.ok) {
      msg.value = t('已删除声库：') + t(it.name);
      await load();
      await syncStore();
    } else {
      err.value = t('删除失败：') + ((r && r.error) || 'unknown');
    }
  } catch (e) { err.value = t('删除失败：') + ((e && e.message) || e); }
}

function openSite(it) {
  try { window.open(it.officialUrl, '_blank'); } catch (e) {}
}
function openDir() {
  try { if (bridge && bridge.openOutput) bridge.openOutput(vbRoot.value); } catch (e) {}
}

onMounted(() => {
  load();
  if (bridge && bridge.onVoicebankProgress) {
    offProgress = bridge.onVoicebankProgress((p) => {
      if (!p || !p.id) return;
      const prev = prog.value[p.id] || {};
      // ★ 进度只增不减：主进程换源/续传时若真的从 0 重来，也不让进度条往回跳。
      const pct = Math.max(Number(prev.percent) || 0, Number(p.percent) || 0);
      prog.value = {
        ...prog.value,
        [p.id]: {
          percent: p.done ? 100 : pct,
          phase: p.phase || 'download',
          error: p.error || '',
          retry: p.retry || 0,
          active: !p.done && !p.error ? true : (p.done ? false : !!prev.active),
        },
      };
    });
  }
});
// KeepAlive 保活：切回本页时重新读取安装状态（可能在别处装过/删过）
onActivated(load);
onBeforeUnmount(() => { if (offProgress) { try { offProgress(); } catch (e) {} offProgress = null; } });
/* ---------------- 搜索 / 筛选 / 分组 ----------------
 * ★ UI 模板与 DiffSingerCatalog.vue **一一对应**（用户要求两个声库页统一）：
 *   ds-src ↔ vb-src · ds-bar ↔ vb-bar · ds-works ↔ vb-works · ds-groups ↔ vb-groups
 *   ds-work ↔ vb-work · ds-cat-block ↔ vb-cat-block · ds-grid ↔ vb-grid · ds-card ↔ vb-card
 *   改视觉时**两边一起改**，否则两个声库页会越差越远。
 */
const external = ref([]);      // 渠道索引（多数免费声库不在 GitHub，见 main/utau.js 的 VB_EXTERNAL）
const query = ref('');
const langFilter = ref('all');
const stateFilter = ref('all');

/** 本地导入现成声库 zip。
 *  ★ 主进程的 utau:importVoicebankZip **一直都在**，只是界面从来没入口 ——
 *    见 scripts/audit-bridge-contract.cjs 里那条 TODO。免费声库绝大多数在 BOOTH /
 *    BowlRoll / 网盘，没有直链，所以这条本地通路是必需的，不是补充。 */
async function importZip() {
  if (!isDesktop) { err.value = t('请在桌面版导入声库。'); return; }
  err.value = ''; msg.value = '';
  try {
    const r = await bridge.utauImportVoicebankZip();
    if (!r || r.canceled) return;
    if (!r.ok) { err.value = t('导入失败：') + ((r && r.error) || 'unknown'); return; }
    await load();
    await syncStore(r.dir || '');
    msg.value = t('已导入声库：') + (r.name || '');
    emit('installed', r.dir || '');
  } catch (e) { err.value = String((e && e.message) || e); }
}

function openUrl(u) {
  if (!u) return;
  try { if (bridge && bridge.openExternal) bridge.openExternal(u); else window.open(u, '_blank'); } catch (e) {}
}

/** 把 it.lang 的「日本語 · 単独音（CV）」拆成 语言 + 形式 —— 分组按这两级 */
function splitLang(it) {
  const s = String((it && it.lang) || '');
  const i = s.indexOf('·');
  if (i < 0) return { lang: s || '其它', form: '' };
  return { lang: s.slice(0, i).trim() || '其它', form: s.slice(i + 1).trim() };
}
function hit(it) {
  if (stateFilter.value === 'installed' && !it.installed) return false;
  if (stateFilter.value === 'missing' && it.installed) return false;
  if (langFilter.value !== 'all' && splitLang(it).lang !== langFilter.value) return false;
  const q = query.value.trim().toLowerCase();
  if (!q) return true;
  // 名字 / 作者 / 标签 / 分类 + 原始字段一起搜（导入项靠标签才找得到）
  return searchHay('utau', it, [it.lang, it.desc].map(v => String(t(v || ''))).join(' ')).includes(q);
}
/** 先把用户排序与顶置套上再过滤 —— 顺序才与看到的卡片一致。 */
const ordered = computed(() => orderList('utau', list.value));
const shown = computed(() => ordered.value.filter(hit));
const shownCount = computed(() => shown.value.length);
const hasFilter = computed(() => !!query.value.trim() || langFilter.value !== 'all' || stateFilter.value !== 'all');
function resetFilters() { query.value = ''; langFilter.value = 'all'; stateFilter.value = 'all'; }

/* ---------------- 顶置 / 拖拽排序 / 编辑条目信息（用户要求：四页一致） ---------------- */
const dragId = ref('');
const editItem = ref(null);
function dragStart(it, ev) {
  dragId.value = it.id;
  try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(it.id)); } catch (e) {}
}
function dragEnd() { dragId.value = ''; }
async function dropOn(it) {
  const from = dragId.value;
  dragId.value = '';
  if (!from || !it || from === it.id) return;
  // 过滤/搜索中禁止拖拽：那时列表只是子集，写顺序会与没显示的条目交错，结果无法解释
  if (hasFilter.value) return;
  const ids = ordered.value.map((x) => x.id);
  const i = ids.indexOf(from);
  const j = ids.indexOf(it.id);
  if (i < 0 || j < 0) return;
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  await saveOrder('utau', ids);
}
async function pin(it) { await togglePin('utau', it.id); }
// 本组件没有 toast（它用行内状态文字），保存成功后 usermeta.js 已自行刷新表，这里只需关闭
function onEditClose() { editItem.value = null; }
const langs = computed(() => {
  const m = new Map();
  for (const it of list.value) { const k = splitLang(it).lang; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
});
/** 分组：语言 → 形式 → 条目（对应 DiffSinger 的 作品 → 分类 → 卡片） */
const groups = computed(() => {
  const out = [];
  for (const it of shown.value) {
    const { lang, form } = splitLang(it);
    let g = out.find(x => x.lang === lang);
    if (!g) { g = { lang, forms: [] }; out.push(g); }
    const key = form || '未标注形式';
    let f = g.forms.find(x => x.form === key);
    if (!f) { f = { form: key, items: [] }; g.forms.push(f); }
    f.items.push(it);
  }
  return out;
});
function groupCount(g) { return g.forms.reduce((n, f) => n + f.items.length, 0); }
function phaseText(id) {
  const p = prog.value[id] || {};
  if (p.phase === 'extract') return t('解压中…');
  if (p.phase === 'done') return t('完成');
  if (p.retry) return t('重试中…') + p.retry;
  return t('下载中…');
}
function sizeMb(v) { return v ? (v / 1048576).toFixed(1) + ' MB' : ''; }
</script>

<template>
  <div class="vb-cat">
    <div class="vb-src">
      <span class="vb-src-ic"><Icon name="mic" :size="14" /></span>
      <div class="vb-src-txt">
        <b>{{ t('UTAU 声库（开源 / 免费）') }}</b>
        <small>{{ t('按需从作者或上游项目公开托管的仓库拉取，使用条款随条目展示、由使用者自行遵守；装好后可直接在「调教」里选用。') }}</small>
      </div>
      <div class="vb-head-act">
        <span v-if="vbRoot" class="vb-root" :title="vbRoot">{{ vbRoot }}</span>
        <button class="btn sm ghost" @click="load" :disabled="loading || !isDesktop" :title="t('重新扫描声库目录')">{{ t('刷新') }}</button>
        <button class="btn sm ghost" @click="importZip" :disabled="!isDesktop || !!busyId" :title="t('导入从 BOOTH / BowlRoll / 网盘下载的声库 zip')"><Icon name="box" :size="13" /> {{ t('导入本地 zip') }}</button>
        <button class="btn sm ghost" @click="openDir" :disabled="!isDesktop"><Icon name="folder" :size="13" /> {{ t('打开目录') }}</button>
      </div>
    </div>

    <div v-if="!isDesktop" class="vb-note">{{ t('声库下载安装仅在桌面版可用。') }}</div>

    <template v-else>
      <div class="vb-bar">
        <div class="vb-search">
          <Icon name="search" :size="13" />
          <input v-model="query" :placeholder="t('搜索声库 / 作者 / 语言')" />
          <button v-if="query" class="vb-clr" @click="query = ''"><Icon name="close" :size="12" /></button>
        </div>
        <select v-model="langFilter" class="vb-sel">
          <option value="all">{{ t('全部语言') }}</option>
          <option v-for="l in langs" :key="l.id" :value="l.id">{{ l.id }} ({{ l.n }})</option>
        </select>
        <select v-model="stateFilter" class="vb-sel">
          <option value="all">{{ t('全部状态') }}</option>
          <option value="installed">{{ t('已安装') }}</option>
          <option value="missing">{{ t('未安装') }}</option>
        </select>
      </div>

      <div class="vb-works">
        <button class="vb-wchip" :class="{ active: langFilter === 'all' }" @click="langFilter = 'all'">{{ t('全部') }}</button>
        <button v-for="l in langs" :key="l.id" class="vb-wchip" :class="{ active: langFilter === l.id }" @click="langFilter = l.id">{{ l.id }}<i>{{ l.n }}</i></button>
        <span class="vb-shown">{{ t('显示') }} {{ shownCount }} / {{ list.length }}</span>
      </div>

      <div v-if="err" class="vb-err"><Icon name="info" :size="14" /> {{ err }}</div>
      <div v-else-if="loading && !list.length" class="vb-loading">{{ t('正在读取声库目录…') }}</div>

      <div v-else class="vb-groups">
        <section v-for="(g, gi) in groups" :key="g.lang" class="vb-work" :style="{ '--wi': gi }">
          <div class="vb-work-head">
            <span class="vb-work-ic"><Icon name="mic" :size="15" /></span>
            <b>{{ g.lang }}</b>
            <span class="vb-work-cnt">{{ groupCount(g) }} {{ t('个声库') }} · {{ g.forms.length }} {{ t('种形式') }}</span>
          </div>
          <div v-for="f in g.forms" :key="f.form" class="vb-cat-block">
            <div class="vb-cat-head">
              <b>{{ f.form }}</b>
              <span class="vb-cat-cnt">{{ f.items.length }}</span>
            </div>
            <div class="vb-grid">
              <div v-for="it in f.items" :key="it.id" class="vb-card"
                     :class="{ inst: it.installed, down: busyId === it.id, pinned: isPinned('utau', it), dragging: dragId === it.id }"
                     :draggable="!hasFilter"
                     @dragstart="dragStart(it, $event)" @dragend="dragEnd" @dragover.prevent @drop.prevent="dropOn(it)">
                <div class="vb-card-top">
                  <span class="vb-name" :title="displayName('utau', it)">{{ t(displayName('utau', it)) }}</span>
                  <button class="cat-pin" :class="{ on: isPinned('utau', it) }" @click.stop="pin(it)"
                          :title="isPinned('utau', it) ? t('取消顶置') : t('顶置')">📌</button>
                  <span class="vb-badge" :class="{ inst: it.installed }">{{ it.installed ? t('已安装') : t('未安装') }}</span>
                </div>
                <div class="vb-catline">
                  <span class="vb-tag">{{ authorOf('utau', it) || it.author }}</span>
                  <span v-if="it.installed && it.size" class="vb-tag">{{ sizeMb(it.size) }}</span>
                  <span v-for="tg in tagsOf('utau', it)" :key="tg" class="cat-tag meta">{{ tg }}</span>
                </div>
                <div class="vb-desc">{{ t(it.desc) }}</div>
                <div class="vb-license" :title="t(it.license)">{{ t('使用条款：') }}{{ t(it.license) }}</div>
                <div class="vb-foot">
                  <div class="vb-acts">
                    <button v-if="busyId === it.id" class="vb-btn cancel" @click="cancel(it)">{{ t('取消') }} {{ (prog[it.id] && prog[it.id].percent) || 0 }}%</button>
                    <button v-else-if="!it.installed" class="vb-btn" @click="install(it)" :disabled="!!busyId"><Icon name="download" :size="12" /> {{ t('下载安装') }}</button>
                    <template v-else>
                      <button class="vb-btn" @click="use(it)">{{ t('去使用') }}</button>
                      <button class="vb-btn re" @click="remove(it)"><Icon name="trash" :size="12" /></button>
                    </template>
                    <button class="vb-btn re" @click="openSite(it)" :title="it.officialUrl">{{ t('来源页') }}</button>
                    <button class="vb-btn re" @click="editItem = it" :title="t('编辑条目信息')">{{ t('编辑') }}</button>
                  </div>
                </div>
                <div v-if="busyId === it.id" class="vb-prog">
                  <div class="vb-prog-line"><span class="vb-prog-ph">{{ phaseText(it.id) }}</span></div>
                  <div class="vb-bar-mini"><i :style="{ width: ((prog[it.id] && prog[it.id].percent) || 0) + '%' }"></i></div>
                  <div class="vb-prog-meta"><span>{{ (prog[it.id] && prog[it.id].percent) || 0 }}%</span><span>{{ (prog[it.id] && prog[it.id].error) || '' }}</span></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div v-if="!shownCount" class="vb-empty">
          <div class="vb-empty-ic"><Icon name="search" :size="28" /></div>
          <b>{{ t('没有符合条件的声库') }}</b>
          <button v-if="hasFilter" class="btn sm ghost" @click="resetFilters">{{ t('清除筛选') }}</button>
        </div>

        <section v-if="external.length" class="vb-work">
          <div class="vb-work-head">
            <span class="vb-work-ic"><Icon name="box" :size="15" /></span>
            <b>{{ t('更多免费声库去哪儿找') }}</b>
            <span class="vb-work-cnt">{{ t('官方配布页与索引站；多数声库不在 GitHub 上，需手动下载后放进声库目录') }}</span>
          </div>
          <div class="vb-grid">
            <div v-for="e in external" :key="e.id" class="vb-card">
              <div class="vb-card-top">
                <span class="vb-name" :title="e.name">{{ e.name }}</span>
                <span class="vb-badge">{{ e.kind }}</span>
              </div>
              <div class="vb-desc">{{ t(e.note) }}</div>
              <div class="vb-foot">
                <div class="vb-acts"><button class="vb-btn re" @click="openUrl(e.url)">{{ t('打开来源') }}</button></div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div v-if="msg" class="vb-msg ok">{{ msg }}</div>
      <div v-if="installedCount" class="muted small">
        {{ t('已安装 ') }}{{ installedCount }}{{ t(' 个声库，可在「调教 → 声库 · UTAU」里选用。') }}
      </div>
    </template>
  </div>
  <ItemMetaEditor v-if="editItem" kind="utau" :item="editItem" :raw-name="editItem.name" @close="onEditClose" />
</template>

<style scoped>
/* ★ 以下规则**逐条镜像** DiffSingerCatalog.vue 的 .ds-*（同名去前缀）——
   用户要求两个声库页的 UI 模板统一。改视觉时两边一起改，否则会越差越远。 */
.vb-cat { display: flex; flex-direction: column; gap: 14px; }
.vb-src { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1px solid var(--hairline); border-radius: 12px; background: var(--surface-soft); }
.vb-src-ic { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: 50%; background: color-mix(in srgb, var(--brand-coral) 14%, transparent); color: var(--brand-coral); flex: 0 0 auto; }
.vb-src-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.vb-src-txt b { font-size: 13px; color: var(--ink); }
.vb-src-txt small { font-size: 11.5px; color: var(--stone); }
.vb-head-act { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 0 0 auto; }
.vb-root { font-size: 11px; color: var(--stone); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vb-note { font-size: 12px; color: var(--stone); }
.vb-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.vb-search { display: flex; align-items: center; gap: 7px; flex: 1 1 240px; min-width: 200px; padding: 0 10px; height: 32px; border: 1px solid var(--hairline); border-radius: 9px; background: var(--surface); color: var(--stone); }
.vb-search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--ink); font-size: 12.5px; min-width: 0; }
.vb-search input::placeholder { color: var(--stone); }
.vb-clr { display: inline-flex; border: 0; background: transparent; color: var(--stone); cursor: pointer; padding: 2px; border-radius: 50%; }
.vb-clr:hover { color: var(--ink); background: var(--surface-soft); }
.vb-sel { height: 32px; padding: 0 8px; border: 1px solid var(--hairline); border-radius: 9px; background: var(--surface); color: var(--ink); font-size: 12.5px; cursor: pointer; max-width: 190px; }
.vb-works { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vb-wchip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border: 1px solid var(--hairline); border-radius: 999px; background: transparent; color: var(--steel); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: background .18s ease, color .18s ease, border-color .18s ease, transform .18s ease; }
.vb-wchip:hover { background: var(--surface-soft); color: var(--ink); transform: translateY(-1px); }
.vb-wchip i { font-style: normal; font-size: 10.5px; color: var(--stone); background: var(--surface-soft); border-radius: 20px; padding: 0 6px; line-height: 15px; }
.vb-wchip.active { background: color-mix(in srgb, var(--brand-coral) 15%, var(--surface)); border-color: color-mix(in srgb, var(--brand-coral) 32%, transparent); color: var(--ink); }
.vb-wchip.active i { background: color-mix(in srgb, var(--brand-coral) 14%, transparent); color: var(--brand-coral); }
.vb-shown { margin-left: auto; font-size: 11.5px; color: var(--stone); }
.vb-groups { display: flex; flex-direction: column; gap: 20px; }
.vb-work { animation: vbWorkIn .3s cubic-bezier(.2,.7,.3,1) both; animation-delay: calc(min(var(--wi, 0), 6) * 55ms); }
@keyframes vbWorkIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.vb-work-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--hairline); }
.vb-work-ic { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: 7px; background: color-mix(in srgb, var(--brand-coral) 12%, transparent); color: var(--brand-coral); }
.vb-work-head b { font-size: 14px; color: var(--ink); }
.vb-work-cnt { font-size: 11.5px; color: var(--stone); }
.vb-cat-block { margin-bottom: 14px; }
.vb-cat-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; color: var(--steel); }
.vb-cat-head b { font-size: 12.5px; color: var(--ink); }
.vb-cat-cnt { margin-left: auto; font-size: 11px; color: var(--stone); }
.vb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 9px; }
.vb-card { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 10px 11px; border: 1px solid var(--hairline); border-radius: 11px; background: var(--surface); overflow: hidden; transition: border-color .15s, background .15s, transform .15s, box-shadow .15s; }
.vb-card:hover { border-color: color-mix(in srgb, var(--brand-coral) 30%, var(--hairline)); transform: translateY(-2px); box-shadow: var(--shadow-sm, 0 4px 14px rgba(0,0,0,.08)); }
.vb-card.inst { background: color-mix(in srgb, var(--brand-coral) 4%, var(--surface)); border-color: color-mix(in srgb, var(--brand-coral) 22%, var(--hairline)); }
.vb-card.down { border-color: color-mix(in srgb, var(--brand-coral) 45%, var(--hairline)); }
.vb-card-top { display: flex; align-items: center; gap: 6px; }
.vb-name { font-size: 13px; font-weight: 650; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vb-badge { font-size: 10px; padding: 1px 6px; border-radius: 20px; line-height: 15px; flex: 0 0 auto; margin-left: auto; background: var(--surface-soft); color: var(--stone); }
.vb-badge.inst { background: color-mix(in srgb, var(--brand-coral) 15%, transparent); color: var(--brand-coral); }
.vb-catline { display: flex; gap: 5px; flex-wrap: wrap; }
.vb-tag { font-size: 10px; padding: 1px 6px; border-radius: 5px; background: var(--surface-soft); color: var(--stone); }
.vb-desc { font-size: 11.5px; color: var(--steel); line-height: 1.45; min-height: 32px; }
.vb-license { font-size: 10.5px; color: var(--stone); line-height: 1.45; border-left: 2px solid var(--hairline); padding-left: 7px; }
.vb-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; }
.vb-acts { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.vb-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border: 1px solid color-mix(in srgb, var(--brand-coral) 34%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--brand-coral) 12%, transparent); color: var(--brand-coral); font-size: 11.5px; font-weight: 600; cursor: pointer; transition: background .15s; }
.vb-btn:hover { background: color-mix(in srgb, var(--brand-coral) 20%, transparent); }
.vb-btn.re { border-color: var(--hairline); background: transparent; color: var(--steel); }
.vb-btn.re:hover { background: var(--surface-soft); color: var(--ink); }
.vb-btn.cancel { border-color: color-mix(in srgb, var(--brand-coral) 45%, transparent); background: transparent; color: var(--brand-coral); }
.vb-bar-mini { height: 3px; border-radius: 2px; background: var(--surface-soft); overflow: hidden; }
.vb-bar-mini i { display: block; height: 100%; background: linear-gradient(90deg, var(--brand-coral), color-mix(in srgb, var(--brand-coral) 55%, #fff), var(--brand-coral)); background-size: 200% 100%; transition: width .25s ease; }
.vb-prog { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.vb-prog-line { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--stone); }
.vb-prog-ph { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.vb-prog-meta { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--stone); font-variant-numeric: tabular-nums; }
.vb-err { display: flex; align-items: center; gap: 7px; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--brand-coral) 30%, var(--hairline)); border-radius: 10px; background: color-mix(in srgb, var(--brand-coral) 6%, var(--surface)); color: var(--ink); font-size: 12.5px; }
.vb-loading { padding: 32px; text-align: center; color: var(--stone); font-size: 13px; }
.vb-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 44px 16px; color: var(--stone); }
.vb-empty-ic { color: var(--stone); opacity: .55; }
.vb-empty b { font-size: 13px; color: var(--steel); }
.vb-msg { font-size: 12px; padding: 7px 10px; border-radius: 9px; border: 1px solid var(--hairline); }
.vb-msg.ok { color: var(--ink); background: var(--surface-soft); }
.vb-msg.bad { color: var(--error); border-color: color-mix(in srgb, var(--error) 35%, var(--hairline)); }
</style>

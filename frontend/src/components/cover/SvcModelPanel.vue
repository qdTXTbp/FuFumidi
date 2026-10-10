<script setup>
// 翻唱模型（SVC）：导入 + 已导入管理 + 在线目录（按语言分组）
//
// ★ 应用不内置、不代下载：两个社区仓库都是 CC-BY-NC-4.0（禁商用、必须署名训练者），
//   分发不在我们这边。目录只做索引，把用户送到 ModelScope，下载完再用「导入」放进应用。
// ★ 导入文件夹 = **登记引用，不复制**（权重 + index 近 180MB/角色，复制纯属浪费磁盘）；
//   删除时只注销条目，不动用户的原文件。zip / 逐个选文件才落到应用目录里。
import { ref, computed, onMounted } from 'vue';
import Icon from '../Icon.vue';
import { t } from '../../core/i18n.js';
import { useAppStore } from '../../stores/app';

const app = useAppStore();
const bridge = window.fuBridge;
const toast = (m, type) => { try { app.toast(m, type || 'info'); } catch (e) {} };

const models = ref([]);
const catalog = ref(null);
const root = ref('');
const loading = ref(false);
const busy = ref(false);

/* ---- 在线目录：语言 / 作品筛选 + 搜索 ---- */
const lang = ref('');
const work = ref('');
const q = ref('');
const showCatalog = ref(false);

const langs = computed(() => (catalog.value && catalog.value.langs) || []);
const works = computed(() => (catalog.value && catalog.value.works) || []);
const filtered = computed(() => {
  const all = (catalog.value && catalog.value.models) || [];
  const kw = String(q.value || '').trim().toLowerCase();
  const out = all.filter((m) => {
    if (lang.value && m.lang !== lang.value) return false;
    if (work.value && m.work !== work.value) return false;
    if (kw && !((m.name || '') + ' ' + (m.work || '')).toLowerCase().includes(kw)) return false;
    return true;
  });
  return out.slice(0, 300);   // 959 条全渲染会卡；搜索/筛选后再看细节
});

function human(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}
function srTxt(sr) { return sr ? (sr / 1000) + 'k' : '?'; }

/* ---- 列表 ---- */
async function refresh() {
  if (!bridge || !bridge.svcList) return;
  loading.value = true;
  try {
    const r = await bridge.svcList();
    if (r && r.ok) { models.value = r.models || []; root.value = r.root || ''; }
  } catch (e) {}
  loading.value = false;
}
async function loadCatalog() {
  if (!bridge || !bridge.svcCatalog) return;
  try {
    const r = await bridge.svcCatalog();
    if (r && r.ok) catalog.value = r.catalog || null;
  } catch (e) {}
}
async function refreshCatalog() {
  if (!bridge || !bridge.svcRefreshCatalog) return;
  busy.value = true;
  const r = await bridge.svcRefreshCatalog().catch(() => null);
  busy.value = false;
  if (r && r.ok) { await loadCatalog(); toast(t('刷新目录') + '：' + r.count + ' 个模型', 'ok'); }
  else toast((r && r.error) || t('失败'), 'warn');
}

/* ---- 导入 ---- */
async function importFolder() {
  if (!bridge || !bridge.svcPickFolder) return toast(t('请使用桌面版 FuFumidi'), 'warn');
  const picked = await bridge.svcPickFolder();
  if (!picked || picked.canceled) return;
  const r = await bridge.svcImportFolder(picked.dir, {}).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  if (r && r.ok) { toast(t('已导入') + '：' + r.model.name, 'ok'); await refresh(); await probe(r.model.id); }
  else toast((r && r.error) || t('失败'), 'warn');
}

async function importFiles() {
  if (!bridge || !bridge.svcPickFiles) return toast(t('请使用桌面版 FuFumidi'), 'warn');
  const picked = await bridge.svcPickFiles();
  if (!picked || picked.canceled || !picked.files) return;
  // 按扩展名归类（手填元数据的兜底：认得出的先认，认不出的用户自己在卡片上校正）
  const files = {};
  for (const p of picked.files) {
    const low = String(p).toLowerCase();
    if (low.endsWith('.pth') || low.endsWith('.pt')) files.model = files.model || p;
    else if (low.endsWith('.index')) files.index = p;
    else if (low.endsWith('.yaml') || low.endsWith('.yml')) files.config = p;
  }
  if (!files.model) return toast(t('没认出权重文件（.pth / .pt）'), 'warn');
  const r = await bridge.svcImportFiles(files, { name: String(files.model).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') })
    .catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  if (r && r.ok) { toast(t('已导入') + '：' + r.model.name, 'ok'); await refresh(); await probe(r.model.id); }
  else toast((r && r.error) || t('失败'), 'warn');
}

async function importZip() {
  if (!bridge || !bridge.svcPickZip) return toast(t('请使用桌面版 FuFumidi'), 'warn');
  const picked = await bridge.svcPickZip();
  if (!picked || picked.canceled) return;
  busy.value = true;
  const r = await bridge.svcImportZip(picked.path, {}).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  busy.value = false;
  if (r && r.ok) { toast(t('已导入') + '：' + r.model.name, 'ok'); await refresh(); await probe(r.model.id); }
  else toast((r && r.error) || t('失败'), 'warn');
}

/** 校正：让引擎读权重，把真实的 version / f0 / 采样率回写清单 */
async function probe(id) {
  if (!bridge || !bridge.svcProbe) return;
  const r = await bridge.svcProbe(id).catch(() => null);
  if (r && r.ok) {
    if (r.patched && Object.keys(r.patched).length) toast(t('校正完成') + '：' + JSON.stringify(r.patched), 'ok');
    await refresh();
  }
  // 失败不弹错：环境没装 SVC 推理包时 probe 必然失败，这不该打扰用户
}

async function remove(m) {
  if (!window.confirm(t('删除') + '「' + m.name + '」？' + (m.external ? '（' + t('引用式导入：删除只注销条目，不会删你的原文件') + '）' : ''))) return;
  const r = await bridge.svcRemove(m.id).catch(() => null);
  if (r && r.ok) { toast(t('已删除'), 'ok'); await refresh(); }
  else toast((r && r.error) || t('删除失败'), 'warn');
}

function openCatalogPage() {
  const site = (catalog.value && catalog.value.repos && catalog.value.repos[0] && catalog.value.repos[0].site)
    || 'https://www.modelscope.cn/models/aihobbyist/RVC_Model_Collection';
  try { if (bridge.svcOpenCatalogPage) bridge.svcOpenCatalogPage(site); else window.open(site, '_blank'); } catch (e) {}
}

onMounted(async () => { await refresh(); await loadCatalog(); });
</script>

<template>
  <div class="sm-wrap">
    <!-- 授权提示：CC-BY-NC-4.0 + 不代下载 -->
    <div class="sm-lic">
      <span class="sm-lic-ic"><Icon name="info" :size="14" /></span>
      <span>{{ t('CC-BY-NC-4.0：禁止商用，必须署名训练者。应用不内置下载 —— 请自行下载后再用「导入」放进应用。') }}</span>
    </div>

    <!-- 导入 -->
    <div class="sm-bar">
      <button class="btn sm primary" :disabled="busy" @click="importFolder"><Icon name="folder" :size="13" /> {{ t('选文件夹（登记引用，不复制）') }}</button>
      <button class="btn sm" :disabled="busy" @click="importFiles"><Icon name="import" :size="13" /> {{ t('逐个选文件（手填元数据）') }}</button>
      <button class="btn sm" :disabled="busy" @click="importZip"><Icon name="box" :size="13" /> {{ t('导入 zip') }}</button>
      <button class="btn sm ghost" @click="refresh"><Icon name="refresh" :size="13" /> {{ t('刷新') }}</button>
      <span class="muted small sm-root">{{ root }}</span>
    </div>

    <!-- 已导入 -->
    <div class="sm-sec">
      <div class="sm-sec-t">{{ t('已导入的模型') }}（{{ models.length }}）</div>
      <div v-if="!models.length" class="sm-empty">
        <Icon name="box" :size="26" />
        <b>{{ t('还没有导入任何翻唱模型') }}</b>
        <span class="muted small">{{ t('还没有导入翻唱模型，去「模型管理 → 翻唱模型」导入一个') }}</span>
      </div>
      <div v-else class="sm-grid">
        <div v-for="m in models" :key="m.id" class="sm-card" :class="{ off: !m.ready }">
          <div class="sm-card-head">
            <span class="sm-ic"><Icon name="mic" :size="14" /></span>
            <b>{{ m.name }}</b>
            <span class="sm-arch">{{ (m.engine || '').toUpperCase() }}<template v-if="m.version"> · {{ m.version }}</template><template v-if="m.sr"> · {{ srTxt(m.sr) }}</template></span>
          </div>
          <div class="sm-meta">
            <span v-if="m.work">{{ m.work }}</span>
            <span v-if="m.lang && m.lang !== '未标语言'">{{ m.lang }}</span>
            <span>{{ human(m.size) }}</span>
            <span v-if="m.external" class="sm-tag">引用</span>
          </div>
          <div class="sm-note" :class="{ warn: !m.ready }">{{ m.ready ? (m.external ? t('引用式导入：删除只注销条目，不会删你的原文件') : t('已安装')) : (m.missing && m.missing.length ? t('缺文件') + '：' + m.missing.join('、') : t('引擎未识别')) }}</div>
          <div class="sm-ops">
            <button class="btn sm ghost" @click="probe(m.id)">{{ t('校正（读取权重真实参数）') }}</button>
            <button class="btn sm ghost danger" @click="remove(m)">{{ t('删除') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 在线目录（只做索引，不含权重） -->
    <div class="sm-sec">
      <div class="sm-sec-t sm-sec-tog" @click="showCatalog = !showCatalog">
        <span>{{ t('在线目录（只做索引，不含权重）') }}<template v-if="catalog">（{{ catalog.models.length }}）</template></span>
        <span class="sm-caret">{{ showCatalog ? '−' : '+' }}</span>
      </div>
      <template v-if="showCatalog">
        <div class="sm-bar">
          <select class="text-input sm-sel" v-model="lang">
            <option value="">{{ t('全部语言') }}</option>
            <option v-for="l in langs" :key="l" :value="l">{{ l }}</option>
          </select>
          <select class="text-input sm-sel" v-model="work">
            <option value="">{{ t('全部') }}</option>
            <option v-for="w in works" :key="w" :value="w">{{ w }}</option>
          </select>
          <input class="text-input sm-sel" v-model="q" :placeholder="t('搜索角色 / 作品')" />
          <button class="btn sm ghost" :disabled="busy" @click="refreshCatalog">{{ t('刷新目录') }}</button>
          <button class="btn sm" @click="openCatalogPage">{{ t('去 ModelScope 下载') }}</button>
          <span v-if="filtered.length > 299" class="muted small">（仅显示前 300 条，用搜索缩小范围）</span>
        </div>
        <div class="sm-cat">
          <div v-for="m in filtered" :key="m.id" class="sm-cat-row">
            <b>{{ m.name }}</b>
            <span class="muted small">{{ m.work }}<template v-if="m.lang && m.lang !== '未标语言'"> · {{ m.lang }}</template> · {{ srTxt(m.sr) }}</span>
            <span class="muted small mono">{{ human(m.pthSize) }}<template v-if="m.indexSize"> + {{ human(m.indexSize) }}</template></span>
            <span v-if="m.engine === 'ddsp'" class="sm-tag warn">{{ t('DDSP-SVC 尚未支持（.sf_pkg 是 SVC-Fusion 专用封装）') }}</span>
            <button class="btn sm ghost" @click="openCatalogPage">{{ t('去 ModelScope 下载') }}</button>
          </div>
          <div v-if="!filtered.length" class="sm-empty"><b>{{ t('该分类暂无模型') }}</b></div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sm-wrap { display: flex; flex-direction: column; gap: 14px; }
.sm-lic { display: flex; align-items: center; gap: 9px; padding: 9px 14px; border-radius: var(--radius-lg); border: 1px solid color-mix(in srgb, var(--brand-coral) 38%, transparent); background: color-mix(in srgb, var(--brand-coral) 11%, var(--surface)); color: var(--ink); font-size: 12.5px; line-height: 1.5; }
.sm-lic-ic { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; border-radius: 50%; background: color-mix(in srgb, var(--brand-coral) 18%, transparent); color: var(--brand-coral); flex: none; }
.sm-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sm-root { margin-left: auto; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
.sm-sel { max-width: 200px; }
.sm-sec { display: flex; flex-direction: column; gap: 8px; }
.sm-sec-t { font-size: 12.5px; font-weight: 700; color: var(--ink); }
.sm-sec-tog { display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; }
.sm-caret { color: var(--stone); font-weight: 700; }
.sm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(258px, 1fr)); gap: 12px; }
.sm-card { border: 1px solid var(--hairline); border-radius: var(--radius-lg); padding: 12px 14px; background: var(--surface); display: flex; flex-direction: column; gap: 6px; }
.sm-card.off { border-color: color-mix(in srgb, var(--error) 40%, transparent); }
.sm-card-head { display: flex; align-items: center; gap: 8px; }
.sm-ic { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: 8px; background: var(--surface-soft); color: var(--brand-coral); flex: none; }
.sm-arch { margin-left: auto; font-size: 10.5px; font-weight: 700; color: var(--stone); font-family: var(--mono); }
.sm-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--slate); }
.sm-tag { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 20px; background: var(--surface-soft); color: var(--stone); }
.sm-tag.warn { background: color-mix(in srgb, var(--error) 14%, transparent); color: var(--error); }
.sm-note { font-size: 11px; color: var(--stone); line-height: 1.6; }
.sm-note.warn { color: var(--error); }
.sm-ops { display: flex; gap: 8px; margin-top: 2px; }
.sm-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 0; color: var(--stone); }
.sm-cat { border: 1px solid var(--hairline); border-radius: var(--radius-lg); max-height: 420px; overflow: auto; }
.sm-cat-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px dashed var(--hairline); font-size: 12px; color: var(--ink); }
.sm-cat-row:last-child { border-bottom: 0; }
.sm-cat-row .mono { font-family: var(--mono); margin-left: auto; }
</style>

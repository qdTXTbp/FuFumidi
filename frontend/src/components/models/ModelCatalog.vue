<template>
  <!-- 资源中心「音色 / 调教模型」两页的共享目录壳（与两个声库页同形）：
       来源条（icon + 标题 + 说明 + actions 插槽）→ 搜索筛选 → 按 group-key 分组 → 卡片网格。
       纯展示组件：所有动作经事件上抛（download / remove / cancel / openExternal）。 -->
  <div class="mc">
    <div class="mc-src">
      <span class="mc-src-ic"><Icon :name="icon" :size="14" /></span>
      <div class="mc-src-txt">
        <b>{{ title }}</b>
        <small v-if="note">{{ note }}</small>
      </div>
      <div class="mc-actions"><slot name="actions" /></div>
    </div>

    <div class="mc-bar">
      <div class="mc-search">
        <Icon name="search" :size="14" />
        <input v-model="query" type="text" :placeholder="t('搜索名称 / 架构 / 用途…')" />
        <button v-if="query" class="mc-clr" @click="query = ''"><Icon name="close" :size="12" /></button>
      </div>
      <select v-model="stateFilter" class="mc-sel">
        <option value="all">{{ t('全部状态') }}</option>
        <option value="installed">{{ t('仅已安装') }}</option>
        <option value="free">{{ t('仅未安装') }}</option>
      </select>
      <span class="mc-shown">{{ t('显示') }} {{ flat.length }} / {{ items.length }}</span>
    </div>

    <div v-if="groups.length" class="mc-groups">
      <section v-for="(g, gi) in groups" :key="g.key" class="mc-group" :style="{ '--gi': gi }">
        <div class="mc-group-head">
          <Icon name="folder" :size="13" />
          <b>{{ g.key }}</b>
          <span class="mc-group-cnt">{{ g.items.length }}</span>
        </div>
        <div class="vm-grid">
          <div
            v-for="(m, i) in g.items"
            :key="m.id"
            class="vm-card"
            :class="{ inst: m.exists, down: isDownloading(m) || isPaused(m), fail: isFailed(m) }"
            :style="{ animationDelay: (i * 40) + 'ms' }"
          >
            <div class="vm-top" :class="'k-' + (m.kind || 'other')"></div>
            <div class="vm-head">
              <span class="vm-ic"><Icon :name="icon" :size="15" /></span>
              <span class="vm-arch">{{ m[groupKey] || t('未知架构') }}</span>
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
                <button class="btn sm" @click.stop="$emit('openExternal', m)">{{ t('打开来源') }}</button>
              </template>
              <template v-else-if="isDownloading(m)">
                <span class="pill run">{{ pct(m) }}%</span>
                <button class="btn sm ghost" @click.stop="$emit('pause', m)">{{ t('暂停') }}</button>
                <button class="btn sm" @click.stop="$emit('cancel', m.id)">{{ t('取消') }}</button>
              </template>
              <template v-else-if="isPaused(m)">
                <span class="pill pause">{{ t('已暂停') }}</span>
                <button class="btn sm primary" @click.stop="$emit('resume', m)">{{ t('继续') }}</button>
                <button class="btn sm" @click.stop="$emit('cancel', m.id)">{{ t('取消') }}</button>
              </template>
              <template v-else-if="isFailed(m)">
                <span class="pill bad">{{ t('下载失败') }}</span>
                <button class="btn sm" @click.stop="$emit('download', m)">{{ t('重试') }}</button>
              </template>
              <template v-else-if="m.exists">
                <span class="pill on">{{ t('已安装') }}</span>
                <button class="btn sm" @click.stop="$emit('remove', m)">{{ t('删除') }}</button>
              </template>
              <template v-else>
                <span class="pill off">{{ t('未安装') }}</span>
                <button class="btn sm" @click.stop="$emit('download', m)">{{ t('下载') }}</button>
              </template>
            </div>
            <!-- 未下载时给清单大小 / minSize（不再显示 0）；下载中给实时已收/总量 -->
            <div v-if="sizeLabel(m)" class="vm-size">{{ sizeLabel(m) }}</div>
            <div v-if="isFailed(m) && prog[m.id] && prog[m.id].error" class="vm-err" :title="prog[m.id].error">{{ prog[m.id].error }}</div>
            <div v-if="isDownloading(m) || isPaused(m)" class="mini-bar" :class="{ paused: isPaused(m) }"><i :style="{ transform: 'scaleX(' + (pct(m) / 100) + ')' }"></i></div>
          </div>
        </div>
      </section>
    </div>
    <div v-else class="vm-empty">
      <div class="vm-empty-ic"><Icon :name="icon" :size="30" /></div>
      <b>{{ emptyText || t('没有符合条件的条目') }}</b>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import Icon from '../Icon.vue';
import { t } from '../../core/i18n.js';
import { DL, downloadState, expectedBytes, manifestBytes } from '../../core/model-download.js';

const props = defineProps({
  items: { type: Array, default: () => [] },
  prog: { type: Object, default: () => ({}) },
  groupKey: { type: String, default: 'arch' },
  kind: { type: String, default: 'model' },
  icon: { type: String, default: 'box' },
  title: { type: String, default: '' },
  note: { type: String, default: '' },
  emptyText: { type: String, default: '' },
});
defineEmits(['download', 'remove', 'cancel', 'pause', 'resume', 'openExternal']);

const query = ref('');
const stateFilter = ref('all');

/* ---------------- 下载三态（与 ViewModels 同一套语义，见 core/model-download.js） ---------------- */
function human(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + ' GB';
  if (v >= 1e6) return (v / 1e6).toFixed(0) + ' MB';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + ' KB';
  return v + ' B';
}
function entryOf(m) { return props.prog[m.id]; }
function stateOf(m) { return downloadState(m, entryOf(m)); }
function isDownloading(m) { return stateOf(m) === DL.DOWNLOADING; }
function isPaused(m) { return stateOf(m) === DL.PAUSED; }
function isFailed(m) { return stateOf(m) === DL.FAILED; }
function pct(m) { return Math.max(0, Math.min(100, Math.round(Number(entryOf(m) && entryOf(m).percent) || 0))); }
function sizeLabel(m) {
  const e = expectedBytes(m, entryOf(m));
  if (e.live) return human(e.received) + ' / ' + human(e.bytes);
  if (!e.bytes) return stateOf(m) === DL.INSTALLED ? human(m.size) : '';
  return (e.isMin ? '≥ ' : '') + human(e.bytes);
}
/* 分卷描述：与 ViewModels 的 partsText 同逻辑（声库页/模型页各自 scoped，不跨组件引） */
function partsText(m) {
  const n = Number(m && m.parts) || 0;
  if (!n) return '';
  const sizes = (m && Array.isArray(m.partSizes)) ? m.partSizes : [];
  if (sizes.length === n) {
    const min = Math.min.apply(null, sizes);
    const max = Math.max.apply(null, sizes);
    return n + ' × ~' + human(min) + (max !== min ? ' · ' + human(manifestBytes(m).bytes) : '');
  }
  return String(n);
}

const flat = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (props.items || []).filter((m) => {
    if (stateFilter.value === 'installed' && !m.exists) return false;
    if (stateFilter.value === 'free' && m.exists) return false;
    if (!q) return true;
    return [m.name, m[props.groupKey], m.use, m.note].some((s) => String(s || '').toLowerCase().includes(q));
  });
});

const groups = computed(() => {
  const by = new Map();
  for (const m of flat.value) {
    const k = String(m[props.groupKey] || t('其他'));
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(m);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh')).map(([key, list]) => ({ key, items: list }));
});
</script>

<style scoped>
.mc { display: flex; flex-direction: column; gap: var(--sp-4); }
.mc-src { display: flex; align-items: center; gap: var(--sp-3); padding: 12px 14px; border: 1px solid var(--hairline); border-radius: var(--r-lg); background: var(--surface); }
.mc-src-ic { display: inline-flex; width: 30px; height: 30px; align-items: center; justify-content: center; border-radius: var(--r-md); background: var(--surface-soft); color: var(--brand-coral); flex: none; }
.mc-src-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mc-src-txt b { font-size: var(--fs-md); color: var(--ink); }
.mc-src-txt small { font-size: var(--fs-sm); color: var(--slate); line-height: 1.6; }
.mc-actions { display: flex; gap: var(--sp-2); flex: none; }

.mc-bar { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.mc-search { position: relative; flex: 1; min-width: 220px; display: flex; align-items: center; gap: var(--sp-2); padding: 7px 12px; border: 1px solid var(--hairline); border-radius: var(--r-pill); background: var(--surface); color: var(--stone); }
.mc-search input { flex: 1; border: none; outline: none; background: transparent; color: var(--ink); font-size: var(--fs-sm); }
.mc-clr { border: none; background: transparent; color: var(--stone); cursor: pointer; display: inline-flex; padding: 2px; }
.mc-sel { padding: 7px 10px; border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); color: var(--ink); font-size: var(--fs-sm); }
.mc-shown { font-size: var(--fs-xs); color: var(--stone); margin-left: auto; }

.mc-groups { display: flex; flex-direction: column; gap: var(--sp-5); }
.mc-group { display: flex; flex-direction: column; gap: var(--sp-3); animation: mc-in var(--motion-base) var(--ease-out) both; animation-delay: calc(var(--gi) * 40ms); }
@keyframes mc-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.mc-group-head { display: flex; align-items: center; gap: var(--sp-2); color: var(--slate); }
.mc-group-head b { font-size: var(--fs-md); color: var(--ink); }
.mc-group-cnt { font-size: var(--fs-xs); font-weight: 700; color: var(--stone); background: var(--surface-soft); border-radius: var(--r-lg); padding: 1px 8px; }

.vm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(238px, 1fr)); gap: var(--sp-4); }
.vm-card { position: relative; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--r-lg); padding: 14px 16px 12px; background: var(--surface); display: flex; flex-direction: column; gap: var(--sp-2); min-height: 128px; transition: transform var(--motion-base) var(--ease-out), box-shadow var(--motion-base) var(--ease-out), border-color var(--motion-base) var(--ease-out); animation: mc-card-in var(--motion-base) var(--ease-out) both; }
@keyframes mc-card-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.vm-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lg); border-color: color-mix(in srgb, var(--brand-coral) 40%, transparent); }
.vm-card.inst { border-color: color-mix(in srgb, var(--ok, var(--t-ok)) 45%, transparent); }
.vm-card.down { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }
.vm-card.fail { border-color: color-mix(in srgb, var(--error) 38%, transparent); }
.vm-top { position: absolute; left: 0; right: 0; top: 0; height: 4px; }
.vm-top.k-transcribe { background: linear-gradient(90deg, var(--data-7), var(--data-1)); }
.vm-top.k-separate { background: linear-gradient(90deg, var(--t-info), var(--t-info)); }
.vm-top.k-other { background: linear-gradient(90deg, var(--data-4), var(--data-5)); }
.vm-top.k-tts { background: linear-gradient(90deg, var(--data-6), var(--data-7)); }
.vm-top.k-tuning { background: linear-gradient(90deg, var(--data-2), var(--data-1)); }
.vm-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.vm-ic { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: var(--r-md); background: var(--surface-soft); color: var(--brand-coral); font-size: var(--fs-lg); }
.vm-arch { font-size: var(--fs-xs); font-weight: 600; color: var(--stone); text-transform: uppercase; letter-spacing: .2px; font-family: var(--mono); }
.vm-name { font-size: var(--fs-md); font-weight: 700; color: var(--ink); }
.vm-name-line { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.vm-best { display: inline-flex; align-items: center; gap: 2px; font-size: var(--fs-xs); font-weight: 700; color: var(--t-warn); background: linear-gradient(135deg, var(--data-2), var(--data-3)); padding: 1px 6px; border-radius: var(--r-lg); line-height: 15px; }
.vm-use { font-size: var(--fs-sm); color: var(--slate); line-height: 1.6; flex: 1; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.vm-tags { display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; }
.vm-tag { font-size: var(--fs-xs); line-height: 16px; padding: 0 6px; border-radius: var(--r-sm); background: var(--surface-soft); color: var(--stone); }
.vm-tag.mono { font-family: var(--mono); }
.vm-size { font-size: var(--fs-xs); color: var(--stone); font-family: var(--mono); }
.vm-err { font-size: var(--fs-xs); color: var(--error); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vm-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; gap: var(--sp-2); flex-wrap: wrap; }
.pill { font-size: var(--fs-xs); font-weight: 700; padding: 2px 8px; border-radius: var(--r-lg); letter-spacing: .2px; white-space: nowrap; }
.pill.on { background: color-mix(in srgb, var(--ok,var(--t-ok)) 14%, transparent); color: var(--ok,var(--t-ok)); }
.pill.run { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
.pill.pause { background: color-mix(in srgb, var(--t-warn) 16%, transparent); color: var(--t-warn); }
.pill.bad { background: color-mix(in srgb, var(--error) 14%, transparent); color: var(--error); }
.pill.off { background: var(--surface-soft); color: var(--stone); }
.mini-bar { height: 3px; border-radius: var(--r-sm); background: var(--surface-soft); overflow: hidden; }
.mini-bar i { display: block; height: 100%; background: var(--accent); transform-origin: left center; transition: transform var(--motion-fast) linear; }
.mini-bar.paused i { background: var(--t-warn); }

.vm-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-3); padding: 48px 20px; color: var(--stone); }
.vm-empty-ic { opacity: .5; }
.vm-empty b { font-size: var(--fs-md); color: var(--slate); }
</style>

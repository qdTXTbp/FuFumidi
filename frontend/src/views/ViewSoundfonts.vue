<script setup>
// 音色工坊：选择 / 下载 / 管理 SF2 音色库，并持久化「播放时使用」的选择
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { useSettingsStore } from '../stores/settings';
import { setActiveSoundfontRef } from '../audio.js';
import { t } from '../core/i18n.js';

const app = useAppStore();
const settings = useSettingsStore();
const toast = (m, type) => app.toast(m, type);
const bridge = window.fuBridge;

const registry = ref([]);
const customs = ref([]);
const sfDir = ref('');
const loading = ref(false);
const busySf = ref(false);          // 大音色加载遮罩（解析需短暂占用主线程）
const activePath = ref('internal');   // 当前启用的音色来源（'internal' 或 SF2 路径）
const prog = reactive({});            // 下载进度 { id: { percent, active, error } }
let offProg = null;
const previewBuf = reactive({});      // 预览按钮忙碌态

function fmtSize(b) {
  if (!b) return '—';
  if (b > 1 << 30) return (b / (1 << 30)).toFixed(1) + ' GB';
  if (b > 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

async function refresh() {
  loading.value = true;
  try {
    if (bridge && bridge.sfWorkshop && bridge.sfWorkshop.list) {
      const r = await bridge.sfWorkshop.list() || { registry: [], customs: [], dir: '' };
      registry.value = r.registry || [];
      customs.value = r.customs || [];
      sfDir.value = r.dir || '';
    } else {
      // 网页端：无主进程，仅展示内置 GeneralUser 说明
      registry.value = [];
      customs.value = [];
    }
  } catch (e) {
    toast(t('获取音色清单失败：') + String(e.message || e), 'error');
  }
  loading.value = false;
  await loadActive();
}

async function loadActive() {
  try {
    const s = await settings.load() || {};
    activePath.value = (s && s.active_soundfont) || 'internal';
  } catch (e) {}
}

const usingInternal = computed(() => activePath.value === 'internal' || !activePath.value);

function isActive(item) {
  return item && item.path && activePath.value === item.path;
}

// 启用某音色（立即生效 + 持久化）；失败自动重试一次（大 sf2 首载偶发失败）
async function enable(item) {
  if (!item || !item.path) { toast(t('该音色尚未就绪，请先下载或导入'), 'warn'); return; }
  busySf.value = true;
  try {
    let r = await setActiveSoundfontRef(item.path);
    // 首次失败：等一小段（音频上下文/刚下载完成就绪）自动重试一次
    if (!(r && r.using === 'sf2')) {
      await new Promise(res => setTimeout(res, 400));
      r = await setActiveSoundfontRef(item.path);
    }
    if (r && r.using === 'sf2') {
      await settings.save({ active_soundfont: item.path });
      activePath.value = item.path;
      toast(t('已启用音色「') + item.name + '」', 'ok');
    } else {
      // 加载失败：回退默认合成器并提示具体原因，避免“显示已启用实则未生效”
      await settings.save({ active_soundfont: 'internal' });
      activePath.value = 'internal';
      toast(t('「') + item.name + t('」加载失败，已回退默认合成器：') + ((r && r.error) || t('未知原因')) + t('。可重启应用后再试一次。'), 'warn');
    }
  } finally {
    busySf.value = false;
  }
}

function enableInternal() {
  setActiveSoundfontRef('internal').then(() => settings.save({ active_soundfont: 'internal' }));
  activePath.value = 'internal';
  toast(t('已使用默认合成器'), 'ok');
}

async function download(item) {
  if (!bridge || !bridge.sfWorkshop || !item || !item.id) return;
  if (prog[item.id] && prog[item.id].active) return;
  prog[item.id] = { percent: 0, active: true, error: '' };
  toast(t('开始下载「') + item.name + '」…');
  try {
    const r = await bridge.sfWorkshop.download(item.id);
    if (r && r.ok) {
      prog[item.id] = { percent: 100, active: false };
      toast(t('音色「') + item.name + '」下载完成' + (r.existed ? '（已存在）' : ''), 'ok');
    } else {
      prog[item.id] = { percent: 0, active: false, error: (r && r.error) || t('下载失败') };
      toast(t('下载失败：') + ((r && r.error) || ''), 'error');
    }
    await refresh();
  } catch (e) {
    prog[item.id] = { percent: 0, active: false, error: String(e.message || e) };
    toast(t('下载失败：') + String(e.message || e), 'error');
  }
}

async function cancelDownload(item) {
  if (bridge && bridge.sfWorkshop) { try { await bridge.sfWorkshop.cancel(item.id); } catch (e) {} }
  prog[item.id] = { percent: 0, active: false };
}

async function importLocal() {
  if (!bridge || !bridge.sfWorkshop || !bridge.sfWorkshop.import) { toast(t('请使用桌面版导入音色'), 'warn'); return; }
  try {
    const r = await bridge.sfWorkshop.import();
    if (r && r.ok) { toast(t('已导入音色「') + r.name + '」', 'ok'); await refresh(); }
    else if (r && !r.canceled) toast(t('导入失败：') + ((r && r.error) || ''), 'error');
  } catch (e) { toast(t('导入失败：') + String(e.message || e), 'error'); }
}

async function removeItem(item) {
  const isActiveNow = isActive(item);
  const r = await (bridge.sfWorkshop.remove(item.id));
  if (r && r.ok) {
    toast(t('已删除音色「') + item.name + '」', 'ok');
    if (isActiveNow) { await settings.save({ active_soundfont: 'internal' }); setActiveSoundfontRef('internal'); activePath.value = 'internal'; toast(t('已回退到默认合成器'), 'warn'); }
    await refresh();
  } else {
    toast(t('删除失败：') + ((r && r.error) || ''), 'error');
  }
}

function openDir() {
  if (bridge && bridge.sfWorkshop && bridge.sfWorkshop.openDir) { bridge.sfWorkshop.openDir(); }
}

async function preview(item) {
  previewBuf[item.id] = true;
  const prev = activePath.value;
  try {
    busySf.value = true;
    const r = await setActiveSoundfontRef(item.path);
    if (!r || r.using !== 'sf2') throw new Error((r && r.error) || t('音色不可用'));
    const { getSynth, getCtx } = await import('../audio.js');
    const ctx = getCtx(); const syn = getSynth();
    if (syn && ctx) {
      if (ctx.resume) ctx.resume();
      await new Promise(res => setTimeout(res, 60));
      syn.preview(67, 0, 100, 0.5);   // G4 钢琴
      setTimeout(() => syn.preview(72, 0, 100, 0.5), 300);
      setTimeout(() => syn.preview(76, 0, 100, 0.7), 600);
    }
    toast(t('已预览「') + item.name + '」音色', 'ok');
  } catch (e) {
    toast(t('预览失败：') + String(e.message || e), 'error');
  } finally {
    previewBuf[item.id] = false;
    busySf.value = false;
    // 预览后恢复原选择，不影响用户当前使用的音色
    setActiveSoundfontRef(prev || 'internal');
  }
}

onMounted(() => {
  refresh();
  if (bridge && bridge.sfWorkshop && bridge.sfWorkshop.onProgress) {
    offProg = bridge.sfWorkshop.onProgress((p) => {
      if (p && p.id) {
        if (p.done) prog[p.id] = { percent: 100, active: false };
        else if (p.error) prog[p.id] = { percent: 0, active: false, error: p.error };
        else prog[p.id] = { percent: p.percent || 0, active: true, error: '' };
      }
    });
  }
});
onBeforeUnmount(() => { if (offProg) { try { offProg(); } catch (e) {} offProg = null; } });
</script>

<template>
  <div class="page">
    <!-- 大音色解析需短暂占用主线程，期间给出遮罩提示，避免误以为卡死 -->
    <Transition name="fade">
    <div v-if="busySf" class="sf-busy-mask">
      <div class="sf-busy-box">
        <Icon name="music" :size="18" />
        <span>{{ t('正在加载音色库…首次解析大音色需要几秒，请稍候') }}</span>
      </div>
    </div>
    </Transition>
    <div class="page-head">
      <div class="page-ic"><Icon name="music" :size="20" /></div>
      <div>
        <div class="page-title">{{ t('音色工坊') }}</div>
        <div class="page-sub">{{ t('选择播放 MIDI 时使用的音色库 · 支持 SF2 下载 / 导入 / 默认合成器') }}</div>
      </div>
    </div>

    <!-- ============ 当前音色 ============ -->
    <div class="card sf-card active-card">
      <div class="sf-head">
        <Icon name="spark" :size="15" />
        <span>{{ t('当前使用的音色') }}</span>
        <span class="sf-active-name">{{ usingInternal ? t('默认合成器') : (activePath.split(/[\\/]/).pop() || '') }}</span>
      </div>
      <div class="sf-active-hint">
        {{ usingInternal
          ? t('正在使用内置 Web Audio 合成器（无外部音色文件，兼容性最好）。')
          : t('正在使用所选 SF2 音色库播放，切换后立即生效并长期保存。') }}
      </div>
      <div class="sf-actions" style="margin-top:12px">
        <button class="btn sm" @click="enableInternal" :disabled="usingInternal">{{ t('使用默认合成器') }}</button>
        <button class="btn sm" @click="openDir" :disabled="!sfDir">{{ t('打开音色目录') }}</button>
        <button class="btn sm primary" @click="importLocal">{{ t('导入 .sf2 音色') }}</button>
      </div>
      <div class="sf-hint" v-if="!bridge">{{ t('网页版暂不支持音色工坊内置下载，请使用桌面版体验完整功能。') }}</div>
    </div>

    <!-- ============ 内置精选 ============ -->
    <div class="card sf-card">
      <div class="sf-head">
        <Icon name="box" :size="15" />
        <span>{{ t('内置精选音色库') }}</span>
        <em class="sf-sub">{{ registry.length + ' 款' }}</em>
      </div>
      <div v-if="loading" class="sf-empty">{{ t('加载中…') }}</div>
      <div v-else-if="!registry.length" class="sf-empty">{{ bridge ? t('暂无音色库信息') : t('请使用桌面版') }}</div>
      <div v-else class="sf-grid">
        <div v-for="item in registry" :key="item.id" class="sf-tile" :class="{ active: isActive(item) }">
          <div class="sf-tile-top">
            <div class="sf-tile-name">{{ item.name }}<span v-if="item.version" class="sf-ver"> v{{ item.version }}</span></div>
            <span v-if="item.downloaded" :class="['plg-tag', 'on']">{{ item.builtin ? t('内置') : t('已下载') }}</span>
          </div>
          <div class="sf-tile-desc">{{ item.desc }}</div>
          <div class="sf-tile-meta">{{ fmtSize(item.expected) }} · {{ item.license }}</div>
          <div v-if="item.size" class="sf-tile-meta" style="color:var(--ok)">{{ t('本地 ') + fmtSize(item.size) }}</div>
          <div class="sf-tile-bar" v-if="prog[item.id] && prog[item.id].active">
            <div class="sf-tile-fill" :style="{ width: (prog[item.id].percent || 0) + '%' }"></div>
          </div>
          <div class="sf-tile-err" v-else-if="prog[item.id] && prog[item.id].error">{{ prog[item.id].error }}</div>
          <div class="sf-tile-actions">
            <template v-if="prog[item.id] && prog[item.id].active">
              <span class="sf-pct">{{ prog[item.id].percent || 0 }}%</span>
              <button class="btn sm ghost" @click="cancelDownload(item)">{{ t('取消') }}</button>
            </template>
            <template v-else>
              <button v-if="!item.downloaded" class="btn sm primary" @click="download(item)" :disabled="!bridge">{{ t('下载') }}</button>
              <button v-if="item.downloaded" class="btn sm primary" :class="{ on: isActive(item) }" @click="enable(item)" :disabled="busySf">{{ isActive(item) ? t('使用中') : t('启用') }}</button>
              <button v-if="item.downloaded && !isActive(item)" class="btn sm ghost" :disabled="previewBuf[item.id]" @click="preview(item)">{{ previewBuf[item.id] ? t('试听…') : t('试听') }}</button>
              <button v-if="item.downloaded && !item.builtin" class="btn sm ghost danger" @click="removeItem(item)">{{ t('删除') }}</button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 我的音色（自定义导入） ============ -->
    <div class="card sf-card">
      <div class="sf-head">
        <Icon name="folder" :size="15" />
        <span>{{ t('我的音色') }}</span>
        <em class="sf-sub">{{ customs.length + ' 个' }}</em>
      </div>
      <div v-if="!customs.length" class="sf-empty">{{ t('还没有自定义音色，点击「导入 .sf2 音色」添加本地音色文件。') }}</div>
      <div v-else class="sf-grid">
        <div v-for="item in customs" :key="item.id" class="sf-tile" :class="{ active: isActive(item) }">
          <div class="sf-tile-top">
            <div class="sf-tile-name">{{ item.name }}</div>
            <span v-if="item.downloaded" :class="['plg-tag', 'on']">{{ t('已导入') }}</span>
          </div>
          <div class="sf-tile-desc">{{ item.desc }}</div>
          <div class="sf-tile-meta">{{ fmtSize(item.size) }}</div>
          <div class="sf-tile-actions">
            <button class="btn sm primary" :class="{ on: isActive(item) }" @click="enable(item)" :disabled="busySf">{{ isActive(item) ? t('使用中') : t('启用') }}</button>
            <button v-if="!isActive(item)" class="btn sm ghost" :disabled="previewBuf[item.id]" @click="preview(item)">{{ previewBuf[item.id] ? t('试听…') : t('试听') }}</button>
            <button class="btn sm ghost danger" @click="removeItem(item)">{{ t('删除') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sf-card { padding: 18px 20px; margin-bottom: 14px; }
.sf-head { display: flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 700; color: var(--ink); margin-bottom: 12px; letter-spacing: -0.2px; }
.sf-head em.sf-sub { font-style: normal; font-size: 11.5px; font-weight: 500; color: var(--stone); margin-left: 2px; }
.sf-active-name { margin-left: auto; font-size: 13px; font-weight: 600; color: var(--accent); word-break: break-all; text-align: right; }
.sf-active-hint { font-size: 12px; color: var(--stone); line-height: 1.7; }
.sf-hint { font-size: 11.5px; color: var(--amber); margin-top: 10px; }
.sf-empty { font-size: 12.5px; color: var(--stone); padding: 14px 2px; }
.sf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; margin-top: 4px; }
.sf-tile {
  border: 1px solid var(--hairline); border-radius: 12px; padding: 12px 14px;
  background: color-mix(in srgb, var(--surface-soft) 45%, transparent);
  display: flex; flex-direction: column; gap: 7px; transition: border-color 0.15s, box-shadow 0.15s;
}
.sf-tile.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.sf-tile-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.sf-tile-name { font-size: 13.5px; font-weight: 700; color: var(--ink); line-height: 1.3; }
.sf-ver { font-size: 11px; font-weight: 500; color: var(--stone); margin-left: 4px; }
.sf-tile-desc { font-size: 12px; color: var(--slate); line-height: 1.6; min-height: 36px; }
.sf-tile-meta { font-size: 11px; color: var(--stone); }
.sf-tile-actions { display: flex; align-items: center; gap: 6px; margin-top: auto; flex-wrap: wrap; padding-top: 2px; }
.sf-tile-actions .btn { flex: 1; justify-content: center; }
.sf-tile-actions .btn.ghost { flex: 0 1 auto; }
.sf-tile-actions .btn.danger { flex: 0 1 auto; }
.sf-pct { font-size: 11.5px; color: var(--accent); font-variant-numeric: tabular-nums; }
.sf-tile-bar { height: 5px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; }
.sf-tile-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.15s linear; }
.sf-tile-err { font-size: 10.5px; color: var(--error); word-break: break-all; }
.sf-busy-mask { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--bg) 55%, transparent); backdrop-filter: blur(2px); }
/* 加载遮罩淡入淡出 */
.fade-enter-active, .fade-leave-active { transition: opacity .18s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.sf-busy-box { display: flex; align-items: center; gap: 10px; background: var(--surface); color: var(--ink); font-size: 13px; font-weight: 600; padding: 14px 20px; border-radius: 12px; border: 1px solid var(--hairline); box-shadow: 0 8px 30px rgba(0,0,0,0.14); animation: sf-busy-pulse 1.2s ease-in-out infinite; }
@keyframes sf-busy-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
</style>
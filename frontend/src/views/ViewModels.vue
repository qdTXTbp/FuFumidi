<script setup>
// 模型管理：独立页面，卡片式管理全部模型（转录 / 人声分离 / 其它）
// - 卡片：用处 + 架构徽标 + 大小 + 状态
// - 点击卡片 → 右侧详情抽屉（含下载/删除）
// - 下载中关闭抽屉 → 全屏弹窗实时显示 速度 + 进度（可取消）
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const toast = (m, type) => app.toast(m, type);
const bridge = window.fuBridge;

/* ---------------- 分类 ---------------- */
const TABS = [
  { id: 'transcribe', label: t('转录模型'), ic: 'transcribe' },
  { id: 'separate', label: t('人声分离'), ic: 'mic' },
  { id: 'other', label: t('修复·VR'), ic: 'box' },
];
const curTab = ref('transcribe');

/* ---------------- 模型列表与进度 ---------------- */
const list = ref([]);
const prog = reactive({});            // id -> {active, percent, speed, received, total, done, error}
const loading = ref(false);
const detail = ref(null);             // 当前选中模型（详情抽屉）

const tabbedList = computed(() => list.value.filter(m => m.kind === curTab.value));
function countFor(tb) { return list.value.filter(m => m.kind === tb).length; }

function kindIcon(m) { return (m.kind === 'separate') ? 'mic' : (m.kind === 'transcribe') ? 'music' : 'box'; }

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
onMounted(async () => {
  await refresh();
  loading.value = false;
  for (const m of list.value) { if (m.active) prog[m.id] = { ...(prog[m.id] || {}), active: true, percent: prog[m.id] ? prog[m.id].percent : 0 }; }
  if (bridge && bridge.onModelProgress) off = bridge.onModelProgress(onProgress);
});
onBeforeUnmount(() => { if (off) try { off(); } catch (e) {} });
</script>

<template>
  <div class="page vm-page">
    <div class="page-head">
      <div class="page-ic"><Icon name="box" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ t('模型管理') }}</div>
        <div class="page-sub">{{ TABS.map(tb => tb.label + ' ' + countFor(tb.id)).join(' · ') }}</div>
      </div>
      <button class="btn sm ghost" @click="refresh">{{ t('刷新') }}</button>
    </div>

    <!-- 分类页签 -->
    <div class="vm-tabs">
      <button v-for="tb in TABS" :key="tb.id" class="vm-tab" :class="{ active: curTab === tb.id }" @click="curTab = tb.id">
        <span class="tb-ic"><Icon :name="tb.ic" :size="14" /></span>{{ tb.label }}<span class="tb-cnt">{{ countFor(tb.id) }}</span>
      </button>
    </div>

    <!-- 卡片网格 -->
    <Transition name="vmfade" mode="out-in">
      <div class="vm-grid" :key="curTab">
        <div v-for="(m, i) in tabbedList" :key="m.id" class="vm-card" :class="{ inst: m.exists, down: prog[m.id] && prog[m.id].active }" :style="{ animationDelay: (i * 40) + 'ms' }" @click="detail = m">
          <div class="vm-top" :class="'k-' + (m.kind || 'other')"></div>
          <div class="vm-head">
            <span class="vm-ic"><Icon :name="kindIcon(m)" :size="15" /></span>
            <span class="vm-arch">{{ m.arch || t('未知架构') }}</span>
          </div>
          <div class="vm-name-line"><div class="vm-name">{{ m.name }}</div><span v-if="m.best" class="vm-best" title="该领域效果最佳">👑 {{ m.best }}</span></div>
          <div class="vm-use">{{ m.use || m.note || '' }}</div>
          <div class="vm-foot">
            <span class="pill" :class="m.exists ? 'on' : (prog[m.id] && prog[m.id].active ? 'run' : 'off')">{{ m.exists ? t('已安装') : (prog[m.id] && prog[m.id].active ? (prog[m.id].percent || 0) + '%' : t('未安装')) }}</span>
            <span class="vm-size">{{ human(prog[m.id] && prog[m.id].received || m.size) }}</span>
          </div>
          <div v-if="prog[m.id] && prog[m.id].active" class="mini-bar"><i :style="{ width: (prog[m.id].percent || 0) + '%' }"></i></div>
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
              <small>{{ detail.arch }} · {{ detail.kind === 'separate' ? t('人声分离') : (detail.kind === 'transcribe' ? t('转录模型') : t('修复工具')) }}</small>
            </div>
            <button class="icon-btn" style="margin-left:auto" @click="closeDetail"><Icon name="close" :size="15" /></button>
          </div>

          <div class="vm-drawer-body">
            <div class="vm-hero">
              <div class="hero-use">{{ detail.use || detail.note || '—' }}</div>
            </div>
            <div class="vm-meta">
              <div class="meta-row"><span class="meta-k">{{ t('架构') }}</span><span>{{ detail.arch || '—' }}</span></div>
              <div class="meta-row"><span class="meta-k">{{ t('分类') }}</span><span>{{ detail.kind === 'separate' ? t('人声分离') : (detail.kind === 'transcribe' ? t('转录模型') : t('修复工具')) }}</span></div>
              <div class="meta-row"><span class="meta-k">{{ t('大小') }}</span><span>{{ human(detail.size) }}</span></div>
              <div v-if="detail.repo" class="meta-row"><span class="meta-k">{{ t('来源') }}</span><span class="mono">{{ detail.repo }}</span></div>
              <div v-if="detail.parts" class="meta-row"><span class="meta-k">{{ t('分卷') }}</span><span>{{ detail.parts }} × 25MB</span></div>
            </div>
            <p class="vm-note">{{ detail.note }}</p>

            <div v-if="prog[detail.id] && prog[detail.id].active" class="vm-prog-box">
              <div class="vm-prog-bar"><i :style="{ width: (prog[detail.id].percent || 0) + '%' }"></i></div>
              <div class="vm-prog-txt">
                <span class="pc">{{ (prog[detail.id].percent || 0) }}%</span>
                <span v-if="prog[detail.id].speed">⚡ {{ speedTxt(prog[detail.id].speed) }}</span>
                <span>{{ human(prog[detail.id].received) }} / {{ human(prog[detail.id].total) }}</span>
              </div>
            </div>
            <div v-if="prog[detail.id] && prog[detail.id].error" class="vm-err">{{ prog[detail.id].error }}</div>
          </div>

          <div class="vm-drawer-foot">
            <div v-if="!(prog[detail.id] && prog[detail.id].active)" class="df-group">
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

/* ===== 页签 ===== */
/*** 页签：与全局 .btn/.tab 一致的轻量 pill 风格，去掉厚重渐变与强投影 ***/
.vm-tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.vm-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border: 1px solid var(--hairline); border-radius: 999px; background: transparent; color: var(--steel); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
.vm-tab:hover { background: var(--surface-soft); color: var(--ink); }
.vm-tab .tb-ic { display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center; border-radius: 50%; background: var(--surface-soft); color: var(--steel); transition: all .15s ease; }
.vm-tab.active { background: color-mix(in srgb, var(--brand-coral) 15%, var(--surface)); border-color: color-mix(in srgb, var(--brand-coral) 32%, transparent); color: var(--ink); }
.vm-tab.active .tb-ic { background: color-mix(in srgb, var(--brand-coral) 18%, transparent); color: var(--brand-coral); }
.vm-tab .tb-cnt { font-size: 10.5px; font-style: normal; background: var(--surface-soft); color: var(--stone); border-radius: 20px; padding: 0 7px; line-height: 16px; }
.vm-tab.active .tb-cnt { background: color-mix(in srgb, var(--brand-coral) 14%, transparent); color: var(--brand-coral); }

/* ===== 卡片网格 ===== */
.vm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(238px, 1fr)); gap: 14px; }
.vm-card { position: relative; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--radius-lg); padding: 14px 16px 12px; background: var(--surface); cursor: pointer; display: flex; flex-direction: column; gap: 6px; min-height: 128px; transition: transform .18s cubic-bezier(.2,.7,.3,1), box-shadow .18s, border-color .18s; }
.vm-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lg); border-color: color-mix(in srgb, var(--brand-coral) 40%, transparent); }
.vm-card.inst { border-color: color-mix(in srgb, var(--ok, #22c55e) 45%, transparent); }
.vm-card.down { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }
.vm-top { position: absolute; left: 0; right: 0; top: 0; height: 4px; }
.vm-top.k-transcribe { background: linear-gradient(90deg, #f093fb, #f5576c); }
.vm-top.k-separate { background: linear-gradient(90deg, #4facfe, #00f2fe); }
.vm-top.k-other { background: linear-gradient(90deg, #43e97b, #38f9d7); }
.vm-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.vm-ic { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: 8px; background: var(--surface-soft); color: var(--brand-coral); font-size: 15px; }
.vm-arch { font-size: 10.5px; font-weight: 600; color: var(--stone); text-transform: uppercase; letter-spacing: .2px; font-family: var(--mono); transition: color .15s; }
.vm-card:hover .vm-arch { color: var(--brand-coral); }
.vm-name { font-size: 13.5px; font-weight: 700; color: var(--ink); }
.vm-name-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vm-best { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; font-weight: 700; color: #b45309; background: linear-gradient(135deg, #ffd700, #ffed4e); padding: 1px 6px; border-radius: 20px; line-height: 15px; }
.vm-use { font-size: 11.5px; color: var(--slate); line-height: 1.6; flex: 1; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.vm-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }
.pill { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 20px; letter-spacing: .2px; }
.pill.on { background: color-mix(in srgb, var(--ok,#22c55e) 14%, transparent); color: var(--ok,#16a34a); }
.pill.run { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
.pill.off { background: var(--surface-soft); color: var(--stone); }
.vm-size { font-size: 11px; color: var(--stone); font-family: var(--mono); }
.mini-bar { height: 4px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; margin-top: 4px; }
.mini-bar i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--brand-coral)); transition: width .2s linear; }
.vm-empty { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 56px 0; color: var(--stone); }
.vm-empty-ic { opacity: .35; }

/* ===== 抽屉 ===== */
.vm-scrim { position: fixed; inset: 0; background: rgba(8,10,16,.45); -webkit-backdrop-filter: blur(8px) saturate(1.4); backdrop-filter: blur(8px) saturate(1.4); z-index: 130; display: flex; align-items: center; justify-content: center; padding: 24px; }
.scrim-bg { background: linear-gradient(160deg, rgba(16,18,28,.6), rgba(8,10,16,.5)); }
.vm-drawer { width: 440px; max-width: 94vw; max-height: 88vh; background: var(--glass-bg-strong); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); border: 1px solid color-mix(in srgb, #fff 26%, transparent); border-radius: 16px; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; overflow: hidden; }
.vm-drawer-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--hairline); }
.dm-ic { display: inline-flex; width: 34px; height: 34px; flex:none; align-items: center; justify-content: center; border-radius: 10px; background: linear-gradient(135deg, var(--brand-coral), color-mix(in srgb, var(--brand-coral) 70%, #8b5cf6)); color: #fff; }
.dm-title { display: flex; flex-direction: column; min-width: 0; }
.dm-title b { font-size: 14px; color: var(--ink); }
.dm-title small { font-size: 10.5px; color: var(--stone); }
.vm-drawer-body { padding: 14px 16px 8px; overflow-y: auto; }
.vm-hero { background: linear-gradient(135deg, color-mix(in srgb, var(--brand-coral) 8%, transparent), color-mix(in srgb, #8b5cf6 8%, transparent)); border: 1px solid color-mix(in srgb, var(--brand-coral) 22%, transparent); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
.hero-use { font-size: 12.5px; color: var(--ink); line-height: 1.65; }
.vm-meta { border: 1px solid var(--hairline); border-radius: 12px; padding: 4px 14px; }
.meta-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--hairline); font-size: 12px; color: var(--ink); }
.meta-row:last-child { border-bottom: 0; }
.meta-k { color: var(--stone); width: 52px; flex: none; font-size: 11.5px; }
.meta-row .mono { font-family: var(--mono); color: var(--slate); overflow: hidden; text-overflow: ellipsis; }
.vm-note { font-size: 11.5px; color: var(--stone); margin: 10px 2px; line-height: 1.65; }
.vm-drawer-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--hairline); background: var(--surface); }
.df-group { display: flex; gap: 8px; }

/* ===== 进度 ===== */
.vm-prog-box { margin-top: 8px; }
.vm-prog-bar { height: 8px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; }
.vm-prog-bar i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--brand-coral)); transition: width .2s linear; }
.vm-prog-txt { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--stone); margin-top: 6px; }
.vm-prog-txt .pc { font-weight: 800; font-size: 13px; color: var(--ink); font-family: var(--mono); }
.vm-prog-name { font-size: 12px; font-weight: 600; color: var(--ink); margin-bottom: 5px; }
.vm-err { color: var(--error); font-size: 11.5px; margin-top: 8px; }

/* ===== 弹窗 ===== */
.vm-pop { width: 480px; max-width: 92vw; max-height: 70vh; background: var(--glass-bg-strong); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); border: 1px solid color-mix(in srgb, #fff 26%, transparent); border-radius: 16px; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; overflow: hidden; }
.vm-pop-body { padding: 10px 16px 14px; overflow-y: auto; }
.dd-item { padding: 10px 0; border-bottom: 1px dashed var(--hairline); }
.dd-item:last-child { border-bottom: 0; }

/* ===== 动画（整套应用风格：每次交互皆有流畅过渡） ===== */
@keyframes vmUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.vm-card { animation: vmUp .42s cubic-bezier(.2, .7, .3, 1) both; }
.vmcard-empty { animation: none; }
.vmfade-enter-active, .vmfade-leave-active { transition: opacity .16s ease, transform .16s ease; }
.vmfade-enter-from, .vmfade-leave-to { opacity: 0; transform: translateY(6px); }
/* 抽屉：右侧滑入滑出 */
.dr-enter-active, .dr-leave-active { transition: opacity .26s ease; }
.dr-enter-from, .dr-leave-to { opacity: 0; }
.dr-enter-active .vm-drawer, .dr-leave-active .vm-drawer { transition: transform .34s cubic-bezier(.2,.7,.3,1); }
.dr-enter-from .vm-drawer, .dr-leave-to .vm-drawer { transform: translateX(100%); }
</style>
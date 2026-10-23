<script setup>
// 全局任务中心：转录 / 下载 / 渲染 / 导出 / 更新 / OMR 等长任务的统一入口。
// 数据仍来自主进程 tasks store；前端只展示与取消，不复制业务逻辑。
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import Icon from './Icon.vue';
import { t } from '../core/i18n.js';
import { useTasksStore } from '../stores/tasks';
import { useAppStore } from '../stores/app';
import { playSfx } from '../core/sfx.js';

const tasksStore = useTasksStore();
const app = useAppStore();
const open = ref(false);
const filter = ref('all');
const expandedId = ref('');
const hidden = ref([]);
const now = ref(Date.now());

const list = computed(() => tasksStore.tasks.filter((x) => !hidden.value.includes(x.id)));
const running = computed(() => list.value.filter((x) => x.status === 'running'));
const finished = computed(() => list.value.filter((x) => x.status !== 'running'));
const activeCount = computed(() => running.value.length);
const shown = computed(() => (filter.value === 'active' ? running.value : list.value));
const STATUS_LABEL = { running: '进行中', done: '已完成', error: '失败', canceled: '已取消' };
const KIND_LABEL = { transcribe: '转录', download: '下载', model: '模型', render: '渲染', export: '导出', update: '更新', omr: '识谱', separate: '分离', convert: '转换', task: '任务' };
const KIND_ICON = { transcribe: 'transcribe', convert: 'convert', render: 'play2', export: 'download', download: 'download', model: 'download', update: 'download', omr: 'score', separate: 'music', task: 'task' };

let off = null;
let timer = 0;
const prev = new Map();
onMounted(async () => {
  await tasksStore.refresh();
  try {
    const tasks = window.fuBridge && window.fuBridge.tasks;
    if (tasks && tasks.onUpdate && !off) off = tasks.onUpdate((ev) => tasksStore.applyEvent(ev));
  } catch (e) {}
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => { try { if (off) off(); } catch (e) {} off = null; clearInterval(timer); });

// 外部取消/结束后自动切到“全部”，否则已完成任务在“进行中”页签里看不到。
watch(activeCount, (n, old) => {
  if (old > 0 && n === 0 && finished.value.length) filter.value = 'all';
});

// 页面不在前台时也能知道结果：只有 running → done/error 的迁移才提示。
watch(() => list.value.map((x) => x.id + ':' + x.status).join('|'), () => {
  for (const it of list.value) {
    const old = prev.get(it.id);
    prev.set(it.id, it.status);
    if (!old) continue;
    if (old === 'running' && it.status === 'done') { app.toast(t('任务完成：') + it.title, 'ok'); if (it.kind !== 'transcribe') playSfx('success', 'task'); }
    else if (old === 'running' && it.status === 'error') { app.toast(t('任务失败：') + it.title + (it.error ? ' · ' + it.error : ''), 'warn'); if (it.kind !== 'transcribe') playSfx('error', 'task'); }
  }
});

async function toggleOpen() {
  open.value = !open.value;
  if (open.value) await tasksStore.refresh();
}
async function doCancel(it) {
  const r = await tasksStore.cancel(it.id);
  filter.value = 'all';
  if (!r || !r.ok) app.toast(t('取消失败：') + ((r && r.error) || ''), 'warn');
}
function dismissFinished() {
  hidden.value = [...hidden.value, ...finished.value.map((x) => x.id)];
  app.toast(t('已收起完成的任务'), 'ok');
}
function fmtProgress(p) { return Math.max(0, Math.min(100, Math.round((Number(p) || 0) * 100))) + '%'; }
function fmtDur(ms) { const s = Math.max(0, Math.round((Number(ms) || 0) / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function elapsed(it) { return fmtDur((it.endedAt || now.value) - it.startedAt); }
function eta(it) { const p = Number(it.progress) || 0; if (p <= 0 || p >= 1) return ''; return t('剩余约 ') + fmtDur((now.value - it.startedAt) / p * (1 - p)); }
function kindLabel(k) { return t(KIND_LABEL[k] || k || '任务'); }
function iconOf(k) { return KIND_ICON[k] || 'task'; }
</script>

<template>
  <div class="task-center" data-guide="task-center">
    <button class="tc-fab" :class="{ on: activeCount > 0 }" data-guide="task-center-btn" :title="t('任务中心')" :aria-label="t('任务中心')" :aria-expanded="open" @click="toggleOpen">
      <Icon name="task" :size="15" />
      <span v-if="activeCount" class="tc-badge">{{ activeCount }}</span>
    </button>
    <Transition name="fade">
      <div v-if="open" class="tc-panel card" role="dialog" :aria-label="t('任务中心')">
        <div class="tc-head">
          <b>{{ t('任务中心') }}</b>
          <span class="tc-count">{{ running.length }} {{ t('进行中') }}</span>
          <span class="tc-grow"></span>
          <button class="btn sm ghost" v-if="finished.length" @click="dismissFinished">{{ t('收起完成') }}</button>
          <button class="icon-btn" :title="t('关闭')" :aria-label="t('关闭')" @click="open = false"><Icon name="close" :size="14" /></button>
        </div>
        <div class="tc-tabs" role="tablist">
          <button :class="{ on: filter === 'active' }" @click="filter = 'active'">{{ t('进行中') }} <i v-if="running.length">{{ running.length }}</i></button>
          <button :class="{ on: filter === 'all' }" @click="filter = 'all'">{{ t('全部') }} <i v-if="list.length">{{ list.length }}</i></button>
        </div>
        <div v-if="!shown.length" class="tc-empty"><Icon name="task" :size="20" /><span>{{ filter === 'active' ? t('当前没有进行中的任务') : t('暂无任务') }}</span></div>
        <div v-else class="tc-list">
          <div v-for="it in shown" :key="it.id" class="tc-item" :class="{ expanded: expandedId === it.id }">
            <button class="tc-main" @click="expandedId = expandedId === it.id ? '' : it.id">
              <span class="tc-kind"><Icon :name="iconOf(it.kind)" :size="13" /></span>
              <span class="tc-title-wrap">
                <span class="tc-title">{{ it.title }}</span>
                <span class="tc-sub">{{ kindLabel(it.kind) }} · {{ elapsed(it) }}<template v-if="eta(it)"> · {{ eta(it) }}</template></span>
              </span>
              <span class="tc-status" :class="'st-' + it.status">{{ t(STATUS_LABEL[it.status] || it.status) }}</span>
            </button>
            <div class="tc-bar"><i :style="{ transform: 'scaleX(' + (Number(it.progress) || 0) + ')' }"></i></div>
            <div class="tc-foot">
              <span>{{ fmtProgress(it.progress) }}</span>
              <span v-if="it.error" class="tc-error">{{ it.error }}</span>
              <span class="tc-grow"></span>
              <button v-if="it.status === 'running' && it.cancelable" class="btn sm ghost" @click="doCancel(it)">{{ t('取消') }}</button>
            </div>
            <div v-if="expandedId === it.id" class="tc-detail">
              <div v-if="it.error" class="tc-error">{{ it.error }}</div>
              <div v-for="(l, i) in (it.logs || []).slice(-6)" :key="i" class="tc-log">{{ l }}</div>
              <div v-if="!it.error && !(it.logs && it.logs.length)" class="tc-log muted">{{ t('暂无更多详情') }}</div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.task-center { position: fixed; right: var(--sp-3); bottom: 64px; z-index: 60; }
.tc-fab { position: relative; display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--r-pill); border: 1px solid var(--hairline); background: var(--surface); color: var(--text2); cursor: pointer; box-shadow: var(--shadow-sm); }
.tc-fab.on { border-color: color-mix(in srgb, var(--accent-sky) 40%, var(--hairline)); color: var(--accent-sky); }
.tc-badge { position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; padding: 0 var(--sp-1); border-radius: var(--r-sm); background: var(--accent-sapphire); color: var(--on-sapphire); font-size: var(--fs-xs); line-height: 16px; text-align: center; }
.tc-panel { position: absolute; right: 0; bottom: 46px; width: 380px; max-height: 60vh; overflow-y: auto; padding: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); box-shadow: var(--shadow-lg); }
.tc-head { display: flex; align-items: center; gap: var(--sp-2); }
.tc-count { color: var(--text3); font-size: var(--fs-xs); font-family: var(--font-num); }
.tc-grow { flex: 1; }
.tc-tabs { display: flex; gap: var(--sp-1); border-bottom: 1px solid var(--hairline); padding-bottom: var(--sp-1); }
.tc-tabs button { border: 0; background: transparent; color: var(--text3); padding: var(--sp-1) var(--sp-2); border-radius: var(--r-sm); font-size: var(--fs-xs); }
.tc-tabs button.on { color: var(--text); background: color-mix(in srgb, var(--accent-sapphire) 12%, var(--surface)); }
.tc-tabs i { font-style: normal; color: var(--accent-sky); margin-left: 3px; }
.tc-empty { color: var(--text3); display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-4); justify-content: center; }
.tc-list { display: flex; flex-direction: column; gap: var(--sp-2); }
.tc-item { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2); border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); }
.tc-item.expanded { border-color: color-mix(in srgb, var(--accent-sky) 26%, var(--hairline)); }
.tc-main { display: flex; align-items: center; gap: var(--sp-2); width: 100%; border: 0; background: transparent; padding: 0; text-align: left; cursor: pointer; color: var(--text); }
.tc-kind { width: 22px; height: 22px; border-radius: var(--r-sm); display: grid; place-items: center; color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sapphire) 10%, var(--surface-soft)); flex: none; }
.tc-title-wrap { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.tc-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); color: var(--text); }
.tc-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text3); font-size: var(--fs-xs); font-family: var(--font-num); }
.tc-status { color: var(--text3); font-size: var(--fs-xs); flex: none; }
.tc-status.st-running { color: var(--accent-sky); }
.tc-status.st-error { color: var(--t-err); }
.tc-status.st-done { color: var(--t-ok); }
.tc-bar { height: 3px; background: var(--surface-soft); border-radius: var(--r-sm); overflow: hidden; }
.tc-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent-sapphire), var(--accent-sky)); transform-origin: left center; transition: transform var(--dur-1) linear; }
.tc-foot { display: flex; align-items: center; gap: var(--sp-2); color: var(--text3); font-size: var(--fs-xs); font-family: var(--font-num); }
.tc-error { color: var(--t-err); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.tc-detail { border-top: 1px solid var(--hairline); padding-top: var(--sp-2); display: flex; flex-direction: column; gap: 3px; }
.tc-log { color: var(--text3); font-size: var(--fs-xs); font-family: var(--font-num); line-height: 1.5; word-break: break-all; }
</style>
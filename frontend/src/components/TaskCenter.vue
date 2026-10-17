<script setup>
// C2 TaskCenter 前端：全局浮动按钮 + 任务面板（转录/下载/渲染/导出/更新/OMR 统一进度与取消）。
// 数据来自主进程 taskcenter（离开页面不丢）；事件 push 由 preload 转发（task:update，10Hz）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { t } from '../core/i18n.js';
import { useTasksStore } from '../stores/tasks';

const tasksStore = useTasksStore();
const open = ref(false);

const list = computed(() => tasksStore.tasks);
const running = computed(() => list.value.filter((x) => x.status === 'running'));
const activeCount = computed(() => running.value.length);
const STATUS_LABEL = { running: '进行中', done: '已完成', error: '失败', canceled: '已取消' };

let off = null;
onMounted(async () => {
  await tasksStore.refresh();
  try {
    const tasks = window.fuBridge && window.fuBridge.tasks;
    if (tasks && tasks.onUpdate && !off) off = tasks.onUpdate((ev) => tasksStore.applyEvent(ev));
  } catch (e) {}
});
onBeforeUnmount(() => { try { if (off) off(); } catch (e) {} off = null; });

async function doCancel(it) {
  const r = await tasksStore.cancel(it.id);
  if (!r || !r.ok) { try { window.__fufumidiToast?.(t('取消失败：') + ((r && r.error) || ''), 'warn'); } catch (e) {} }
}
function fmtProgress(p) { return Math.max(0, Math.min(100, Math.round((Number(p) || 0) * 100))) + '%'; }
</script>

<template>
  <div class="task-center" data-guide="task-center">
    <button class="tc-fab" :class="{ on: activeCount > 0 }" data-guide="task-center-btn"
            :title="t('任务中心')" @click="open = !open">
      <Icon name="gear" :size="14" />
      <span v-if="activeCount" class="tc-badge">{{ activeCount }}</span>
    </button>
    <Transition name="fade">
      <div v-if="open" class="tc-panel card">
        <div class="tc-head">
          <b>{{ t('任务中心') }}</b>
          <span class="tc-grow"></span>
          <button class="btn sm" @click="open = false">{{ t('关闭') }}</button>
        </div>
        <div v-if="!list.length" class="tc-empty">{{ t('暂无任务') }}</div>
        <div v-else class="tc-list">
          <div v-for="it in list" :key="it.id" class="tc-item">
            <div class="tc-row">
              <span class="tc-title">{{ it.title }}</span>
              <span class="tc-status" :class="'st-' + it.status">{{ t(STATUS_LABEL[it.status] || it.status) }}</span>
            </div>
            <div class="tc-bar"><i :style="{ transform: 'scaleX(' + (Number(it.progress) || 0) + ')' }"></i></div>
            <div class="tc-row tc-sub">
              <span>{{ fmtProgress(it.progress) }}<template v-if="it.error"> · {{ it.error }}</template></span>
              <span class="tc-grow"></span>
              <button v-if="it.status === 'running' && it.cancelable" class="btn sm" @click="doCancel(it)">{{ t('取消') }}</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.task-center { position: fixed; right: var(--sp-3); bottom: 64px; z-index: 60; }
.tc-fab { position: relative; display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--r-pill); border: 1px solid var(--hairline); background: var(--surface); color: var(--text-2); cursor: pointer; }
.tc-fab.on { border-color: var(--brand); color: var(--brand); }
.tc-badge { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 var(--sp-1); border-radius: var(--r-sm); background: var(--brand-coral); color: var(--on-brand); font-size: var(--fs-xs); line-height: 16px; text-align: center; }
.tc-panel { position: absolute; right: 0; bottom: 44px; width: 320px; max-height: 50vh; overflow-y: auto; padding: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); }
.tc-head { display: flex; align-items: center; gap: var(--sp-2); }
.tc-grow { flex: 1; }
.tc-empty { color: var(--muted); }
.tc-list { display: flex; flex-direction: column; gap: var(--sp-2); }
.tc-item { display: flex; flex-direction: column; gap: var(--sp-1); padding: 6px 0; border-top: 1px solid var(--hairline); }
.tc-row { display: flex; align-items: center; gap: var(--sp-2); }
.tc-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-status { color: var(--muted); }
.tc-status.st-running { color: var(--brand); }
.tc-status.st-error { color: var(--brand-coral); }
.tc-bar { height: 4px; background: var(--surface-soft); border-radius: var(--r-sm); overflow: hidden; }
.tc-bar i { display: block; height: 100%; background: var(--brand); transform-origin: left center; }
.tc-sub { color: var(--muted); }
</style>

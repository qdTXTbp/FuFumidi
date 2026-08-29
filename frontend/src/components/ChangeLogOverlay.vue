<script setup>
// 更新日志浮层：更新完成后首次启动展示（从上次记录版本到当前版本的所有更新内容）
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;

function close() { state.ui.changelogOpen = false; }
</script>

<template>
  <div class="cl-mask" role="dialog" aria-modal="true" :aria-label="t('更新内容')" @click.self="close">
    <div class="cl-card">
      <div class="cl-head">
        <div class="cl-title">
          <Icon name="spark" :size="18" />
          <b>{{ t('更新内容') }}</b>
          <span v-if="state.changelog && state.changelog.from" class="cl-range">
            {{ state.changelog.from }} → {{ state.changelog.to }}
          </span>
        </div>
        <button class="icon-btn" :title="t('关闭')" aria-label="t('关闭')" @click="close"><Icon name="close" :size="14" /></button>
      </div>
      <div class="cl-body">
        <template v-if="state.changelog && state.changelog.logs && state.changelog.logs.length">
          <div v-for="g in state.changelog.logs" :key="g.ver" class="cl-group">
            <div class="cl-ver">v{{ g.ver }}</div>
            <ul class="cl-items">
              <li v-for="(it, i) in g.items" :key="i">{{ it }}</li>
            </ul>
          </div>
        </template>
        <div v-else class="cl-empty">{{ t('暂无更新说明') }}</div>
      </div>
      <div class="cl-foot">
        <button class="btn primary" @click="close">{{ t('知道了') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cl-mask { position: fixed; inset: 0; background: rgba(10,10,10,0.4); display: flex; align-items: center; justify-content: center; z-index: 990; }
.cl-card { width: min(480px, 92vw); max-height: min(72vh, 640px); background: var(--canvas); border-radius: 14px;
  box-shadow: 0 24px 64px rgba(16,24,40,0.24); display: flex; flex-direction: column; overflow: hidden; }
.cl-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; }
.cl-title { display: flex; align-items: center; gap: 8px; font-size: 15px; color: var(--ink); }
.cl-title svg { color: var(--brand); }
.cl-range { font-size: 12px; color: var(--text-muted, #888); font-weight: 500; }
.cl-head .icon-btn { margin-left: auto; }
.cl-body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 18px 8px; }
.cl-group { margin-bottom: 14px; }
.cl-ver { font-size: 13px; font-weight: 700; color: var(--brand-text, var(--brand)); margin-bottom: 6px; }
.cl-items { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
.cl-items li { font-size: 12.5px; line-height: 1.65; color: var(--ink, #333); }
.cl-empty { padding: 24px 0; text-align: center; color: var(--text-muted, #888); font-size: 13px; }
.cl-foot { padding: 10px 16px 14px; display: flex; justify-content: flex-end; }
</style>

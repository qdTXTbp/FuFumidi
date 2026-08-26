<script setup>
// 新手引导：首次启动展示；3 个实操场景跳转对应视图；localStorage 记录完成状态
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const setView = (v) => app.setView(v);

const bridge = window.fuBridge;

// 标记引导已完成（localStorage + 设置持久化）
function markDone() {
  try { localStorage.setItem('fufumidi_guide_done', '1'); } catch (e) {}
  if (bridge && typeof bridge.saveSettings === 'function') {
    bridge.saveSettings({ guide_done: true }).catch(() => {});
  }
}
function go(view) { setView(view); markDone(); state.ui.guideOpen = false; }
function skip() { markDone(); state.ui.guideOpen = false; }
</script>

<template>
  <div class="overlay" @click.self="skip">
    <div class="guide-card">
      <div class="guide-head">
        <span class="guide-count">{{ t('实操引导') }}</span>
        <button class="icon-btn" title="关闭" @click="skip"><Icon name="plus" :size="16" style="transform:rotate(45deg)" /></button>
      </div>
      <div class="guide-body">
        <div class="guide-desc">{{ t('选择一个场景，跟着步骤完成一次真实操作。完成操作后会自动进入下一步，可随时跳过。') }}</div>
        <button class="guide-btn primary" @click="go('transcribe')">
          🎹 {{ t('转录实操') }}
          <small>{{ t('导入音频 → 选择引擎 → 开始转录') }}</small>
        </button>
        <button class="guide-btn primary" @click="go('edit')">
          ✏️ {{ t('编辑实操') }}
          <small>{{ t('选中音符 → 调整力度') }}</small>
        </button>
        <button class="guide-btn primary" @click="go('score')">
          🎼 {{ t('乐谱实操') }}
          <small>{{ t('打开菜单 → 导出 MusicXML') }}</small>
        </button>
      </div>
      <div class="guide-foot">
        <button class="guide-btn ghost" @click="skip">{{ t('跳过 / 关闭') }}</button>
      </div>
    </div>
  </div>
</template>

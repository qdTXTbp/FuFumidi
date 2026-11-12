<script setup>
// 通用日志面板：自动滚动到底部 + 完整弹窗查看 + 一键复制。
// 数据源仍在父组件（lines prop），清空通过 @clear 事件交回父级处理。
// lines 元素两种格式都认：字符串，或 { txt, isErr }（isErr 红色显示）。
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { t } from '../core/i18n.js';

const props = defineProps({
  title: { type: String, default: '' },
  lines: { type: Array, default: () => [] },
  clearable: { type: Boolean, default: true },
  collapsible: { type: Boolean, default: true },
});
const emit = defineEmits(['clear']);

const scrollEl = ref(null);
const mScrollEl = ref(null);
/* stick = 用户本来就在底部附近 → 新日志来了自动跟着滚到底；
   用户手动往上翻了就不再打扰（改由「回到底部」按钮接手）。 */
const stick = ref(true);
const collapsed = ref(false);
const modalOpen = ref(false);
const copied = ref(false);
let copyTimer = null;

const texts = computed(() =>
  props.lines.map((l) => (typeof l === 'string' ? l : String(l && l.txt != null ? l.txt : l)))
);
const nearBottom = (el) => !el || el.scrollHeight - el.scrollTop - el.clientHeight < 28;

function onScroll() { stick.value = nearBottom(scrollEl.value); }
function onModalScroll() { stick.value = nearBottom(mScrollEl.value); }

watch(
  () => props.lines.length,
  () => {
    if (!stick.value) return;
    nextTick(() => {
      const a = scrollEl.value, b = mScrollEl.value;
      if (a) a.scrollTop = a.scrollHeight;
      if (modalOpen.value && b) b.scrollTop = b.scrollHeight;
    });
  }
);
watch(collapsed, (c) => { if (c) { stick.value = true; scrollBoth(); } });
watch(modalOpen, (v) => {
  if (v) { stick.value = true; window.addEventListener('keydown', onKey); nextTick(() => { const b = mScrollEl.value; if (b) b.scrollTop = b.scrollHeight; }); }
  else window.removeEventListener('keydown', onKey);
});
function scrollBoth() {
  nextTick(() => {
    const a = scrollEl.value, b = mScrollEl.value;
    if (a) a.scrollTop = a.scrollHeight;
    if (b) b.scrollTop = b.scrollHeight;
  });
}
function jumpBottom() { stick.value = true; scrollBoth(); }
function toggleCollapse() { collapsed.value = !collapsed.value; }

async function copyAll() {
  const text = texts.value.join('\n');
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch (e) { ok = false; }
  if (!ok) ok = legacyCopy(text);
  if (ok) {
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 1400);
  }
}
function legacyCopy(text) {
  // Electron/受限环境下的兜底：隐藏 textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (e) { return false; }
}
function openModal() { modalOpen.value = true; }
function closeModal() { modalOpen.value = false; }
function onKey(e) { if (e.key === 'Escape') closeModal(); }
function doClear() { stick.value = true; emit('clear'); scrollBoth(); }

onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); clearTimeout(copyTimer); });
</script>

<template>
  <div class="lp">
    <div class="lp-head">
      <span class="lp-title">{{ title }}</span><span class="lp-count">{{ lines.length }}{{ t(' 行') }}</span>
      <span style="flex:1"></span>
      <button v-if="texts.length" class="lp-btn" :class="{ ok: copied }" :title="t(copied ? '已复制' : '复制日志')" @click="copyAll">
        <Icon :name="copied ? 'check' : 'copy'" :size="13" />
      </button>
      <button v-if="texts.length" class="lp-btn" :title="t('查看完整日志')" @click="openModal"><Icon name="expand" :size="13" /></button>
      <button v-if="clearable && lines.length" class="lp-btn" :title="t('清空')" @click="doClear"><Icon name="trash" :size="13" /></button>
      <button v-if="collapsible" class="lp-btn" :title="t('展开/收起')" @click="toggleCollapse">
        <Icon name="chevron" :size="13" :style="collapsed ? '' : 'transform:rotate(180deg)'" />
      </button>
    </div>
    <div v-show="!collapsed" ref="scrollEl" class="lp-scroll" @scroll="onScroll">
      <div v-if="!texts.length" class="lp-empty">{{ t('暂无日志') }}</div>
      <div v-for="(txt, i) in texts" :key="i" :class="{ err: lines[i] && typeof lines[i] === 'object' && lines[i].isErr }">{{ txt }}</div>
    </div>
    <button v-show="!stick && texts.length && !collapsed" class="lp-jump" @click="jumpBottom"><Icon name="chevron" :size="11" style="transform:rotate(180deg)" /> {{ t('回到底部') }}</button>

    <!-- 完整日志弹窗 -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="modalOpen" class="lp-modal" @click.self="closeModal">
          <div class="lp-modal-card">
            <div class="lp-modal-head">
              <b class="lp-modal-title">{{ title || t('日志') }}</b>
              <span class="lp-count">{{ lines.length }}{{ t(' 行') }}</span>
              <span style="flex:1"></span>
              <button class="btn sm" :disabled="!texts.length" @click="copyAll"><Icon :name="copied ? 'check' : 'copy'" :size="13" /> {{ t(copied ? '已复制' : '复制全部') }}</button>
              <button class="btn sm ghost" v-if="clearable" :disabled="!texts.length" @click="doClear"><Icon name="trash" :size="13" /> {{ t('清空') }}</button>
              <button class="lp-btn" :title="t('关闭')" @click="closeModal"><Icon name="close" :size="14" /></button>
            </div>
            <div ref="mScrollEl" class="lp-modal-body" @scroll="onModalScroll">
              <div v-if="!texts.length" class="lp-empty">{{ t('暂无日志') }}</div>
              <div v-for="(txt, i) in texts" :key="i" :class="{ err: lines[i] && typeof lines[i] === 'object' && lines[i].isErr }">{{ txt }}</div>
            </div>
            <div class="lp-modal-foot">
              <span>{{ t(copied ? '已复制到剪贴板' : '点击「复制全部」可一键复制日志') }}</span>
              <span style="flex:1"></span>
              <button v-show="!stick && texts.length" class="lp-jump" @click="jumpBottom"><Icon name="chevron" :size="11" style="transform:rotate(180deg)" /> {{ t('回到底部') }}</button>
              <button class="btn sm primary" @click="closeModal">{{ t('关闭') }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.lp { border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); margin-top: 10px; overflow: hidden; position: relative; }
.lp-head { display: flex; align-items: center; gap: var(--sp-2); padding: 6px 10px; font-size: var(--fs-xs); color: var(--slate); border-bottom: 1px solid var(--hairline-soft); }
.lp-title { color: var(--ink); font-weight: 600; }
.lp-count { color: var(--stone); }
.lp-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: none; background: transparent; color: var(--slate); border-radius: var(--r-sm); cursor: pointer; transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
.lp-btn:hover { background: var(--surface-soft); color: var(--ink); }
.lp-btn.ok { color: var(--ok, #22c55e); }
.lp-scroll { max-height: 220px; min-height: 40px; overflow-y: auto; padding: 8px 12px; font-family: var(--mono); font-size: var(--fs-xs); color: var(--slate); line-height: 1.6; user-select: text; }
.lp-scroll .err { color: var(--error); }
.lp-empty { color: var(--stone); font-style: italic; }
.lp-jump { position: absolute; right: 10px; bottom: 8px; display: inline-flex; align-items: center; gap: var(--sp-1); padding: 4px 10px; font-size: var(--fs-xs); color: var(--ink); background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--r-pill); box-shadow: var(--shadow-sm, 0 2px 8px rgba(0,0,0,0.12)); cursor: pointer; }
.lp-jump:hover { color: var(--brand-blue); border-color: var(--brand-blue); }

.lp-modal { position: fixed; inset: 0; z-index: 130; background: rgba(0,0,0,0.35); -webkit-backdrop-filter: blur(8px) saturate(1.4); backdrop-filter: blur(8px) saturate(1.4); display: flex; align-items: center; justify-content: center; padding: 24px; }
.lp-modal-card { width: 880px; max-width: 94vw; height: 78vh; background: var(--glass-bg-strong); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); border: 1px solid color-mix(in srgb, var(--on-accent) 26%, transparent); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; overflow: hidden; }
.lp-modal-head { display: flex; align-items: center; gap: var(--sp-2); padding: 10px 14px; border-bottom: 1px solid var(--hairline); font-size: var(--fs-md); color: var(--ink); }
.lp-modal-title { font-size: var(--fs-md); }
.lp-modal-body { flex: 1; overflow-y: auto; padding: 12px 16px; font-family: var(--mono); font-size: var(--fs-xs); color: var(--slate); line-height: 1.7; user-select: text; }
.lp-modal-body .err { color: var(--error); }
.lp-modal-foot { display: flex; align-items: center; gap: var(--sp-2); padding: 10px 14px; border-top: 1px solid var(--hairline); font-size: var(--fs-xs); color: var(--stone); }
.lp-modal-foot .lp-jump { position: static; }
</style>

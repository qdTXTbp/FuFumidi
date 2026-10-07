<script setup>
// 命令面板（M3，Ctrl+Shift+P）：把菜单条里的动作 + 工具 + 工作区预设汇成一个可搜索的列表。
//
// ★ 为什么要有它：到 M2 为止动作已经有 60+ 个，菜单条解决了「放哪」，但没解决「叫什么」——
//   用户记得住操作本身、记不住它在哪个菜单下。命令面板只要求「输入片段」。
//   数据源就是 M1 建的 menuGroups（同一份动作表），不另维护一份。
import { ref, computed, watch, nextTick } from 'vue';
import { t } from '../../core/i18n.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  commands: { type: Array, default: () => [] },   // [{ group, label, hint, disabled, run }]
});
const emit = defineEmits(['close']);
const q = ref('');
const active = ref(0);
const inputEl = ref(null);

/** 打分：连续子串 > 子序列；空查询按原顺序全给 */
function score(label, query) {
  const s = label.toLowerCase(), t = query.toLowerCase();
  if (!t) return 1;
  const i = s.indexOf(t);
  if (i >= 0) return 1000 - i;
  let k = 0;
  for (const ch of s) { if (ch === t[k]) k++; if (k === t.length) return 100; }
  return 0;
}
const list = computed(() => {
  const out = [];
  props.commands.forEach((c, i) => {
    const sc = score(c.label, q.value) || score(c.group + ' ' + c.label, q.value) * 0.5;
    if (sc > 0) out.push({ ...c, _sc: sc, _i: i });
  });
  out.sort((a, b) => b._sc - a._sc || a._i - b._i);
  return out.slice(0, 60);
});
watch(() => props.open, async (v) => {
  if (v) { q.value = ''; active.value = 0; await nextTick(); if (inputEl.value) inputEl.value.focus(); }
});
watch(list, () => { if (active.value >= list.value.length) active.value = 0; });
function move(d) {
  const n = list.value.length; if (!n) return;
  active.value = (active.value + d + n) % n;
}
function runOne(c) {
  if (!c || c.disabled) return;
  emit('close');
  try { c.run(); } catch (e) { /* 动作内部自己提示 */ }
}
function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); runOne(list.value[active.value]); }
  else if (e.key === 'Escape') { e.preventDefault(); emit('close'); }
}
</script>

<template>
  <Transition name="ov">
  <div v-if="open" class="cp-mask" @click.self="emit('close')">
    <div class="cp-card">
      <div class="cp-head">
        <span class="cp-ic">⌘</span>
        <input ref="inputEl" v-model="q" class="cp-input" :placeholder="t('输入命令名：量化 / 参数工具 / 全屏 / 工作区…')" @keydown="onKey" />
        <span class="cp-count">{{ list.length }}</span>
      </div>
      <div class="cp-list">
        <button v-for="(c, i) in list" :key="c.group + c.label + i" class="cp-item"
                :class="{ on: i === active, dis: c.disabled }"
                @mouseenter="active = i" @click="runOne(c)">
          <span class="cp-group">{{ c.group }}</span>
          <span class="cp-label">{{ c.label }}</span>
          <span v-if="c.hint" class="cp-hint">{{ c.hint }}</span>
        </button>
        <div v-if="!list.length" class="cp-empty">{{ t('没有匹配的命令') }}</div>
      </div>
      <div class="cp-foot">{{ t('↑↓ 选择 · 回车执行 · Esc 关闭') }}</div>
    </div>
  </div>
  </Transition>
</template>

<style scoped>
/* 自带外壳样式：.ed-modal* 是别的组件的作用域样式，借不到（M2 踩过） */
.cp-mask { position: fixed; inset: 0; background: rgba(10, 10, 10, 0.28); display: flex; align-items: flex-start; justify-content: center; z-index: var(--z-modal); padding-top: 12vh; }
.cp-card { width: min(620px, 92vw); background: var(--canvas); border-radius: 14px; box-shadow: 0 24px 64px rgba(16, 24, 40, .24);
  display: flex; flex-direction: column; overflow: hidden; }
.cp-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--hairline); }
.cp-ic { color: var(--stone); font-size: 13px; }
.cp-input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--ink); font-size: 14px; }
.cp-count { font-size: 11px; color: var(--stone); font-family: var(--mono); }
.cp-list { max-height: 52vh; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 1px; }
.cp-item { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; padding: 7px 10px; border: 0; border-radius: 8px;
  background: transparent; color: var(--ink); font-size: 12.5px; cursor: pointer; }
.cp-item.on { background: var(--surface-soft); }
.cp-item.dis { opacity: .45; cursor: default; }
.cp-group { flex: none; width: 68px; font-size: 10.5px; color: var(--stone); }
.cp-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-hint { flex: none; font-size: 10.5px; color: var(--stone); font-family: var(--mono); }
.cp-empty { padding: 18px; text-align: center; color: var(--stone); font-size: 12px; }
.cp-foot { padding: 6px 14px 10px; font-size: 10.5px; color: var(--stone); }
</style>

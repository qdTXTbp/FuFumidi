<script setup lang="ts">
// ============================================================
// 编辑工作台的**菜单条**（文件 / 编辑 / 视图 / 工具 / 帮助）
// ============================================================
// ★ 为什么要有它：以前低频动作全塞在工具条的「更多 ▾」里，找一次要展开一个两屏高的面板。
//   菜单条给出 DAW 式的稳定位置（Cubase/MuseScore 都是这个 IA），并且工具条只需要留高频动作。
// 交互：点击开合、悬停切换（打开状态下）、Esc 关闭、点击外部关闭。
import { ref, onMounted, onBeforeUnmount } from 'vue';

export interface MenuItem { label: string; hint?: string; run: () => void; disabled?: boolean; sep?: boolean; }
export interface MenuGroup { label: string; items: MenuItem[]; }
const props = defineProps<{ groups: MenuGroup[] }>();
const open = ref(-1);

function toggle(i: number) { open.value = open.value === i ? -1 : i; }
function hover(i: number) { if (open.value >= 0) open.value = i; }
function run(it: MenuItem) { if (it.disabled) return; open.value = -1; try { it.run(); } catch (e) { /* 动作内部自己提示 */ } }
function close() { open.value = -1; }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
function onDoc(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (el && el.closest && el.closest('.ed-menubar')) return;
  close();
}
onMounted(() => { window.addEventListener('keydown', onKey); document.addEventListener('mousedown', onDoc); });
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDoc); });
</script>

<template>
  <div class="ed-menubar">
    <div v-for="(g, i) in groups" :key="g.label" class="mb-group" :class="{ on: open === i }">
      <button class="mb-btn" @click="toggle(i)" @mouseenter="hover(i)">{{ g.label }}</button>
      <Transition name="mb-pop">
        <div v-if="open === i" class="mb-pop">
          <template v-for="(it, k) in g.items" :key="k">
            <div v-if="it.sep" class="mb-sep"></div>
            <button v-else class="mb-item" :class="{ dis: it.disabled }" @click="run(it)">
              <span class="mb-lb">{{ it.label }}</span>
              <span v-if="it.hint" class="mb-hint">{{ it.hint }}</span>
            </button>
          </template>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.ed-menubar { display: flex; align-items: center; gap: 2px; padding: 2px 2px 4px; }
.mb-group { position: relative; }
.mb-btn { font-size: 12.5px; padding: 4px 10px; border-radius: 7px; cursor: pointer; color: var(--ink);
  border: 1px solid transparent; background: transparent; transition: background .16s ease, border-color .16s ease; }
.mb-group.on .mb-btn, .mb-btn:hover { background: var(--surface-soft, rgba(127,127,127,.12)); border-color: var(--hairline); }
.mb-pop { position: absolute; z-index: 60; top: calc(100% + 4px); left: 0; min-width: 208px; padding: 6px;
  background: var(--surface); border: 1px solid var(--hairline); border-radius: 10px; box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,.18));
  display: flex; flex-direction: column; gap: 1px; }
.mb-item { display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left; padding: 5px 9px;
  border: 0; border-radius: 7px; background: transparent; color: var(--ink); font-size: 12.5px; cursor: pointer;
  transition: background .14s ease; }
.mb-item:hover { background: color-mix(in srgb, var(--brand-coral, #ff7a59) 14%, transparent); }
.mb-item.dis { opacity: .45; cursor: default; }
.mb-lb { flex: 1; }
.mb-hint { font-size: 10.5px; color: var(--stone); font-variant-numeric: tabular-nums; }
.mb-sep { height: 1px; margin: 4px 6px; background: var(--hairline); }
.mb-pop-enter-active { transition: opacity .16s ease, transform .16s cubic-bezier(.2,.7,.3,1); }
.mb-pop-leave-active { transition: opacity .12s ease, transform .12s ease; }
.mb-pop-enter-from { opacity: 0; transform: translateY(-4px) scale(.98); }
.mb-pop-leave-to { opacity: 0; transform: translateY(-2px); }
</style>

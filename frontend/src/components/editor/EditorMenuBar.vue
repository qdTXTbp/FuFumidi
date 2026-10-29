<script setup lang="ts">
// ============================================================
// 编辑工作台的**菜单条**（文件 / 编辑 / 视图 / 工具 / 帮助）
// ============================================================
// ★ 为什么要有它：以前低频动作全塞在工具条的「更多 ▾」里，找一次要展开一个两屏高的面板。
//   菜单条给出 DAW 式的稳定位置（Cubase/MuseScore 都是这个 IA），并且工具条只需要留高频动作。
// 交互：点击开合、悬停切换（打开状态下）、Esc 关闭、点击外部关闭。
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue';

export interface MenuItem { label: string; hint?: string; run: () => void; disabled?: boolean; sep?: boolean; }
export interface MenuGroup { label: string; items: MenuItem[]; }
const props = defineProps<{ groups: MenuGroup[] }>();
const open = ref(-1);
const rootEl = ref<HTMLElement | null>(null);

/** 当前打开菜单里的可操作项（禁用项会被跳过；菜单项的 .dis 只是样式，按钮本身没 disabled） */
function menuItems(): HTMLElement[] {
  const root = rootEl.value;
  if (!root) return [];
  const pop = root.querySelector('.mb-group.on .mb-pop');
  if (!pop) return [];
  return Array.from(pop.querySelectorAll('button:not(.dis)')) as HTMLElement[];
}
function focusFirstItem() {
  const items = menuItems();
  if (items.length) items[0].focus();
}
/** 打开菜单时把焦点送进菜单：键盘用户点开「文件」后能直接回车，不用再 Tab 一次 */
async function openGroup(i: number) {
  open.value = i;
  await nextTick();
  focusFirstItem();
}
function toggle(i: number) {
  if (open.value === i) { open.value = -1; return; }
  void openGroup(i);
}
function hover(i: number) {
  if (open.value < 0 || open.value === i) return;
  // 焦点已经在菜单里（键盘在用）时换菜单，焦点要跟着走；鼠标乱滑时不抢焦点
  const ae = document.activeElement as HTMLElement | null;
  const hadFocus = !!(ae && ae.closest && ae.closest('.mb-pop'));
  open.value = i;
  if (hadFocus) nextTick(focusFirstItem);
}
function run(it: MenuItem) { if (it.disabled) return; closeToButton(); try { it.run(); } catch (e) { /* 动作内部自己提示 */ } }
function close() { open.value = -1; }
/** Esc / 选中项执行完：把焦点还给所属的菜单按钮（否则焦点掉回 body） */
function closeToButton() {
  const i = open.value;
  open.value = -1;
  if (i < 0 || !rootEl.value) return;
  const btn = rootEl.value.querySelectorAll<HTMLElement>('.mb-btn')[i];
  if (btn) btn.focus();
}
/** 菜单键盘模型：上下键在项间移动，左右键换菜单，Esc 关闭并还焦点，Tab 收起菜单不困住焦点 */
function onMenuKey(e: KeyboardEvent) {
  if (open.value < 0) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeToButton(); return; }
  if (e.key === 'Tab') { e.preventDefault(); closeToButton(); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault(); e.stopPropagation();
    const n = props.groups.length;
    if (!n) return;
    const next = (open.value + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    void openGroup(next);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = menuItems();
  if (!items.length) return;
  e.preventDefault(); e.stopPropagation();
  const i = items.indexOf(document.activeElement as HTMLElement);
  let n = 0;
  if (e.key === 'ArrowUp') n = i <= 0 ? items.length - 1 : i - 1;
  else if (e.key === 'ArrowDown') n = (i < 0 || i === items.length - 1) ? 0 : i + 1;
  else if (e.key === 'End') n = items.length - 1;
  items[n].focus();
}
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
  <div class="ed-menubar" ref="rootEl" @keydown="onMenuKey">
    <div v-for="(g, i) in groups" :key="g.label" class="mb-group" :class="{ on: open === i }">
      <button class="mb-btn" :aria-haspopup="'menu'" :aria-expanded="open === i ? 'true' : 'false'" @click="toggle(i)" @mouseenter="hover(i)">{{ g.label }}</button>
      <Transition name="mb-pop">
        <div v-if="open === i" class="mb-pop" role="menu" :aria-label="g.label">
          <template v-for="(it, k) in g.items" :key="k">
            <div v-if="it.sep" class="mb-sep"></div>
            <button v-else class="mb-item" role="menuitem" :aria-disabled="it.disabled ? 'true' : undefined" :class="{ dis: it.disabled }" @click="run(it)">
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
.mb-btn { font-size: var(--fs-md); padding: 4px 10px; border-radius: var(--r-sm); cursor: pointer; color: var(--ink);
  border: 1px solid transparent; background: transparent; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.mb-group.on .mb-btn, .mb-btn:hover { background: var(--surface-soft, rgba(127,127,127,.12)); border-color: var(--hairline); }
.mb-pop { position: absolute; z-index: 60; top: calc(100% + 4px); left: 0; min-width: 208px; padding: 6px;
  background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--r-md); box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,.18));
  display: flex; flex-direction: column; gap: 1px; }
.mb-item { display: flex; align-items: baseline; gap: var(--sp-3); width: 100%; text-align: left; padding: 5px 9px;
  border: 0; border-radius: var(--r-sm); background: transparent; color: var(--ink); font-size: var(--fs-md); cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out); }
.mb-item:hover { background: color-mix(in srgb, var(--brand-coral, var(--data-1)) 14%, transparent); }
.mb-item.dis { opacity: .45; cursor: default; }
.mb-lb { flex: 1; }
.mb-hint { font-size: var(--fs-xs); color: var(--stone); font-variant-numeric: tabular-nums; }
.mb-sep { height: 1px; margin: 4px 6px; background: var(--hairline); }
.mb-pop-enter-active { transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.mb-pop-leave-active { transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.mb-pop-enter-from { opacity: 0; transform: translateY(-4px) scale(.98); }
.mb-pop-leave-to { opacity: 0; transform: translateY(-2px); }
</style>

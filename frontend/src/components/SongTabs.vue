<script setup>
// 多标签页：已打开曲目的浏览器式标签栏（切换 / 关闭 / 关闭全部 / 拖拽排序 / 键盘）。
// 标签只是曲目入口，不复制 song 数据；关闭标签不会删除曲目。
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { useTabsStore } from '../stores/tabs';
import { useRouter } from 'vue-router';
import { isEditableTarget } from '../core/transport_keys.js';
import { t } from '../core/i18n.js';

const app = useAppStore();
const store = useTabsStore();
const router = useRouter();
const visible = computed(() => store.tabs.length >= 1);
const dragIndex = ref(-1);
const tabMenu = ref(null);
const tabMenuEl = ref(null);
const allMenuEl = ref(null);
const allBtnEl = ref(null);
// 关闭菜单后焦点回到打开它的控件（标签 / 「全部标签」按钮）：否则焦点掉回 body
const menuReturnEl = ref(null);
const scrollEl = ref(null);
const canLeft = ref(false);
const canRight = ref(false);
const allMenu = ref(false);
function menuPoint(el) {
  try { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.bottom + 2) }; }
  catch (err) { return { x: 12, y: 12 }; }
}
/** 右键与 Shift+F10 共用：给菜单一个落点，并记住来源控件 */
function openTabMenu(e, tb) {
  const pt = (e.clientX || e.clientY) ? { x: e.clientX, y: e.clientY } : menuPoint(e.currentTarget);
  menuReturnEl.value = e.currentTarget || null;
  tabMenu.value = { x: pt.x, y: pt.y, tab: tb };
  focusMenu(tabMenuEl);
}
function closeTabMenu() { tabMenu.value = null; restoreMenuFocus(); }
async function focusMenu(elRef) {
  await nextTick();
  const el = elRef && elRef.value;
  if (!el) return;
  const first = el.querySelector('button:not([disabled])');
  if (first) first.focus();
}
function restoreMenuFocus() {
  const el = menuReturnEl.value;
  menuReturnEl.value = null;
  try { if (el && el.isConnected && typeof el.focus === 'function') el.focus(); } catch (e) {}
}
/** 菜单内方向键 / Home / End；Esc 关闭并还焦点；Tab 离开即收起（非模态菜单的约定） */
function onMenuKey(e, elRef, close) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key === 'Tab') { e.preventDefault(); close(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  // 模板里 ref 会被解包成 DOM 元素，脚本里是 ref 对象 —— 两种都认
  const root = elRef && elRef.value ? elRef.value : (elRef && elRef.querySelector ? elRef : null);
  if (!root) return;
  const items = Array.from(root.querySelectorAll('button:not([disabled])'));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  let n = 0;
  if (e.key === 'ArrowUp') n = i <= 0 ? items.length - 1 : i - 1;
  else if (e.key === 'ArrowDown') n = (i < 0 || i === items.length - 1) ? 0 : i + 1;
  else if (e.key === 'End') n = items.length - 1;
  items[n].focus();
}
/** 标签栏的键盘模型：tablist 用左右方向键在标签间移动并切换，Home/End 到首尾，Delete 关闭 */
function onTabKey(e, tb, i) {
  const list = store.tabs;
  if (!list.length) return;
  if (e.key === 'F10' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); openTabMenu(e, tb); return; }
  let next = -1;
  if (e.key === 'ArrowRight') next = (i + 1) % list.length;
  else if (e.key === 'ArrowLeft') next = (i - 1 + list.length) % list.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = list.length - 1;
  if (next >= 0) {
    e.preventDefault(); e.stopPropagation();
    const target = list[next];
    if (!target) return;
    pick(target.id);
    // 切换后焦点跟到新标签（tabindex 只在激活项上，不然焦点会留在 -1 的节点上）
    nextTick(() => {
      const root = scrollEl.value;
      const el = root && root.querySelectorAll('.song-tab')[next];
      if (el && el.focus) el.focus();
    });
    return;
  }
  if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); closeTab(e, tb.id); }
}
async function menuGroup() { const tb = tabMenu.value && tabMenu.value.tab; closeTabMenu(); if (tb) await editGroup(tb); }
function menuUngroup() { const tb = tabMenu.value && tabMenu.value.tab; closeTabMenu(); if (!tb) return; delete groups.value[tb.id]; try { localStorage.setItem(GROUP_KEY, JSON.stringify(groups.value)); } catch (e) {} }
function menuClose() { const tb = tabMenu.value && tabMenu.value.tab; closeTabMenu(); if (tb) closeTab({ stopPropagation() {} }, tb.id); }
function menuCloseOthers() { const tb = tabMenu.value && tabMenu.value.tab; closeTabMenu(); if (tb) closeOthers({ stopPropagation() {} }, tb.id); }
function menuPin() { const tb = tabMenu.value && tabMenu.value.tab; closeTabMenu(); if (tb) togglePin(tb.id); }
function menuCloseRight() { const tb = tabMenu.value && tabMenu.value.tab; closeTabMenu(); if (tb) closeRight(tb.id); }
const dragOver = ref(-1);
const expanded = ref(false);
const GROUP_KEY = 'fufumidi_tab_groups_v1';
const groups = ref((() => { try { const j = JSON.parse(localStorage.getItem(GROUP_KEY) || '{}'); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } })());
function groupOf(id) { return groups.value[id] || ''; }
async function editGroup(tb) {
  const cur = groupOf(tb.id);
  const name = await app.promptDialog({ title: t('标签分组'), msg: t('给这个标签设置分组名；留空取消分组'), value: cur });
  if (name === null) return;
  const v = String(name).trim();
  if (v) groups.value[tb.id] = v; else delete groups.value[tb.id];
  try { localStorage.setItem(GROUP_KEY, JSON.stringify(groups.value)); } catch (e) {}
}
// 所有标签都渲染在可滚动条里，不再折叠成「更多」；溢出用左右箭头和全部标签菜单。
function groupColor(id) {
  const name = groupOf(id);
  if (!name) return 'transparent';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return 'hsl(' + h + ' 64% 58%)';
}
function updateArrows() {
  const el = scrollEl.value; if (!el) return;
  canLeft.value = el.scrollLeft > 2;
  canRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
}
function scrollTabs(dir) { const el = scrollEl.value; if (!el) return; el.scrollBy({ left: dir * Math.max(180, el.clientWidth * 0.55), behavior: 'smooth' }); }
function onWheel(e) { const el = scrollEl.value; if (!el) return; if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault(); } }
function ensureActiveVisible() {
  const el = scrollEl.value; if (!el) return;
  const node = el.querySelector('.song-tab.on');
  if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  nextTick(updateArrows);
}
function togglePin(id) { store.togglePin(id); nextTick(updateArrows); }
function closeRight(id) { store.closeRight(id); if (store.activeId) pick(store.activeId); }
function openAllMenu() {
  allMenu.value = !allMenu.value;
  if (allMenu.value) { menuReturnEl.value = allBtnEl.value; focusMenu(allMenuEl); }
  else restoreMenuFocus();
}
function closeAllMenu() { allMenu.value = false; restoreMenuFocus(); }
function pickFromAll(id) { closeAllMenu(); pick(id); }

async function pick(id) {
  if (!store.activate(id)) return;
  try { await app.selectSong(id); } catch (e) {}
}
async function closeTab(e, id) {
  e.stopPropagation();
  const wasActive = store.activeId === id;
  store.close(id);
  if (wasActive && store.activeId) await pick(store.activeId);
}
function closeOthers(e, id) {
  e.stopPropagation();
  store.closeOthers(id);
  pick(id);
}
function closeAll() {
  store.clear();
}
function openLibrary() {
  app.setView('music');
}
function onDragStart(e, i) {
  dragIndex.value = i;
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch (err) {}
}
function onDragOver(e, i) {
  e.preventDefault();
  dragOver.value = i;
  try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
}
function onDrop(e, i) {
  e.preventDefault();
  if (dragIndex.value >= 0) store.move(dragIndex.value, i);
  dragIndex.value = -1; dragOver.value = -1;
}
function onDragEnd() { dragIndex.value = -1; dragOver.value = -1; }

async function cycle(dir) {
  if (store.tabs.length < 2) return;
  const cur = store.tabs.findIndex((x) => x.id === store.activeId);
  const next = store.tabs[(cur + dir + store.tabs.length) % store.tabs.length];
  if (next) await pick(next.id);
}
function onKeydown(e) {
  if (isEditableTarget(e.target)) return;
  // Esc 关掉本组件自己的两个浮层，再交给全局（App.vue 的 Esc 白名单不含它们）
  if (e.key === 'Escape') {
    if (tabMenu.value) { e.preventDefault(); e.stopPropagation(); closeTabMenu(); return; }
    if (allMenu.value) { e.preventDefault(); e.stopPropagation(); closeAllMenu(); return; }
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && String(e.key).toLowerCase() === 'w' && store.activeId) {
    e.preventDefault();
    const active = store.activeId;
    store.close(active);
    if (store.activeId) pick(store.activeId);
    return;
  }
  if (mod && e.key === 'Tab') {
    e.preventDefault();
    cycle(e.shiftKey ? -1 : 1);
  }
}
let ro = null;
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true);
  nextTick(updateArrows);
  try { ro = new ResizeObserver(updateArrows); if (scrollEl.value) ro.observe(scrollEl.value); } catch (e) {}
});
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown, true); try { ro && ro.disconnect(); } catch (e) {} });
watch(() => store.activeId, () => nextTick(ensureActiveVisible));
watch(() => store.tabs.length, () => nextTick(() => { updateArrows(); ensureActiveVisible(); }));
</script>

<template>
  <div v-if="visible" class="song-tabs" data-guide="song-tabs" role="tablist" :aria-label="t('已打开曲目')">
    <button class="st-arrow" :disabled="!canLeft" :title="t('向左滚动标签')" :aria-label="t('向左滚动标签')" @click="scrollTabs(-1)"><Icon name="back" :size="12" /></button>
    <div ref="scrollEl" class="st-scroll" @scroll="updateArrows" @wheel="onWheel">
      <div v-for="(tb, i) in store.tabs" :key="tb.id" class="song-tab" :class="{ on: store.activeId === tb.id, dragging: dragIndex === i, over: dragOver === i, pinned: tb.pinned }"
           :style="{ '--tab-group': groupColor(tb.id) }"
           role="tab" :aria-selected="store.activeId === tb.id" :tabindex="store.activeId === tb.id ? 0 : -1" :data-song-id="tb.id" :title="tb.name + (groupOf(tb.id) ? ' · ' + groupOf(tb.id) : '')"
           draggable="true" @click="pick(tb.id)" @keydown.enter="pick(tb.id)" @keydown.space.stop.prevent="pick(tb.id)"
           @keydown="onTabKey($event, tb, i)"
           @auxclick="$event.button === 1 && closeTab($event, tb.id)"
           @contextmenu.prevent="openTabMenu($event, tb)" @dragstart="onDragStart($event, i)" @dragover="onDragOver($event, i)" @drop="onDrop($event, i)" @dragend="onDragEnd">
        <Icon v-if="tb.pinned" name="pin" :size="10" class="st-pin" />
        <span v-if="groupOf(tb.id)" class="st-group" :title="t('分组：') + groupOf(tb.id)" :style="{ color: groupColor(tb.id), borderColor: groupColor(tb.id) }">{{ groupOf(tb.id).slice(0, 4) }}</span>
        <span class="st-name">{{ tb.name }}</span>
        <span v-if="tb.pinned" class="st-lock">{{ t('固定') }}</span>
        <button v-else class="st-close" data-guide="song-tab-close" :title="t('关闭此标签')" :aria-label="t('关闭此标签')" @click="closeTab($event, tb.id)">
          <Icon name="close" :size="10" />
        </button>
      </div>
    </div>
    <button class="st-arrow" :disabled="!canRight" :title="t('向右滚动标签')" :aria-label="t('向右滚动标签')" @click="scrollTabs(1)"><Icon name="forward" :size="12" /></button>
    <button ref="allBtnEl" class="st-tool st-all" :title="t('全部标签')" :aria-label="t('全部标签')" aria-haspopup="menu" :aria-expanded="allMenu ? 'true' : 'false'" @click="openAllMenu"><Icon name="menu" :size="14" /><span>{{ store.tabs.length }}</span></button>
    <button v-if="store.tabs.length" class="st-tool" :title="t('关闭全部标签（保留固定）')" :aria-label="t('关闭全部标签（保留固定）')" @click="closeAll"><Icon name="close" :size="12" /></button>
  </div>

  <Teleport to="body">
    <div v-if="tabMenu" class="st-menu-mask" @click="closeTabMenu" @contextmenu.prevent="closeTabMenu"></div>
    <div v-if="tabMenu" ref="tabMenuEl" class="st-menu" role="menu" :aria-label="t('操作')" :style="{ left: tabMenu.x + 'px', top: tabMenu.y + 'px' }"
         @keydown="onMenuKey($event, tabMenuEl, closeTabMenu)">
      <button class="st-menu-item" @click="menuPin"><Icon name="pin" :size="12" /> {{ tabMenu.tab.pinned ? t('取消固定') : t('固定标签') }}</button>
      <button class="st-menu-item" @click="menuGroup"><Icon name="folder" :size="12" /> {{ t('设置分组') }}</button>
      <button v-if="groupOf(tabMenu.tab.id)" class="st-menu-item" @click="menuUngroup"><Icon name="minus" :size="12" /> {{ t('取消分组') }}</button>
      <span class="st-menu-sep"></span>
      <button class="st-menu-item" @click="menuClose"><Icon name="close" :size="12" /> {{ t('关闭标签') }}</button>
      <button class="st-menu-item" @click="menuCloseOthers"><Icon name="close" :size="12" /> {{ t('关闭其他标签') }}</button>
      <button class="st-menu-item" @click="menuCloseRight"><Icon name="forward" :size="12" /> {{ t('关闭右侧标签') }}</button>
    </div>
    <div v-if="allMenu" class="st-menu-mask" @click="closeAllMenu"></div>
    <div v-if="allMenu" ref="allMenuEl" class="st-menu st-all-menu" role="menu" :aria-label="t('全部标签')"
         @keydown="onMenuKey($event, allMenuEl, closeAllMenu)">
      <div class="st-menu-title" role="presentation">{{ t('全部标签') }}（{{ store.tabs.length }}）</div>
      <button v-for="tb in store.tabs" :key="tb.id" class="st-menu-item st-all-item" :class="{ on: store.activeId === tb.id }" @click="pickFromAll(tb.id)">
        <Icon :name="tb.pinned ? 'pin' : 'music'" :size="12" />
        <span class="st-all-name">{{ tb.name }}</span>
        <span v-if="groupOf(tb.id)" class="st-all-group" :style="{ color: groupColor(tb.id) }">{{ groupOf(tb.id) }}</span>
        <Icon v-if="store.activeId === tb.id" name="check" :size="12" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.song-tabs { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--hairline); background: color-mix(in srgb, var(--surface) 70%, var(--canvas)); overflow: hidden; flex: none; min-height: 34px; }
.st-scroll { display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0; }
.st-scroll::-webkit-scrollbar { display: none; }
.song-tab { display: flex; align-items: center; gap: var(--sp-1); max-width: 240px; box-sizing: border-box; padding: 3px var(--sp-2); border: 1px solid transparent; border-radius: var(--r-sm); color: var(--text3); background: transparent; cursor: pointer; font-size: var(--fs-xs); flex: none; transition: background var(--dur-1), border-color var(--dur-1); }
.song-tab:hover { background: var(--surface-soft); color: var(--text2); }
.song-tab.on { border-color: color-mix(in srgb, var(--accent-sky) 27%, var(--hairline)); color: var(--text); background: color-mix(in srgb, var(--accent-sapphire) 12%, var(--surface)); box-shadow: inset 0 -2px 0 var(--accent-sky); }
.song-tab.dragging { opacity: .45; }
.song-tab.over { border-color: var(--accent-sky); }
.st-group { flex: none; max-width: 42px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--accent-sapphire) 18%, transparent); color: var(--accent-sky); font-size: var(--fs-xs); }
.st-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: none; background: transparent; color: inherit; cursor: pointer; border-radius: var(--r-sm); padding: 0; opacity: .5; }
.song-tab:hover .st-close, .song-tab.on .st-close { opacity: 1; }
.st-close:hover { background: var(--surface-soft); }
.st-tool { width: 24px; height: 24px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text3); display: grid; place-items: center; flex: none; cursor: pointer; }
.st-tool:hover { color: var(--accent-sky); border-color: var(--hairline); background: var(--surface-soft); }
.st-more { width: auto; min-width: 28px; padding: 0 5px; font-size: var(--fs-xs); font-family: var(--font-num); color: var(--text2); }
.st-menu-mask { position: fixed; inset: 0; z-index: calc(var(--z-overlay) - 1); }
.st-menu { position: fixed; z-index: var(--z-overlay); min-width: 150px; padding: 4px; border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 1px; }
.st-menu-item { display: flex; align-items: center; gap: var(--sp-2); border: 0; background: transparent; color: var(--text2); padding: 6px 8px; border-radius: var(--r-sm); font-size: var(--fs-sm); text-align: left; cursor: pointer; }
.st-menu-item:hover { background: var(--surface-soft); color: var(--text); }
.st-menu-sep { height: 1px; background: var(--hairline); margin: 3px 4px; }

/* tabs v2：更高命中区、可滚动条 + 左右箭头、全部标签菜单、固定/分组色 */
.song-tabs { min-height: 38px; gap: 3px; padding: 2px 5px; }
.st-scroll { gap: 4px; padding: 2px 0; scroll-behavior: smooth; }
.song-tab { height: 28px; max-width: 230px; padding: 0 6px 0 9px; border-radius: var(--r-sm) var(--r-sm) 0 0; background: color-mix(in srgb, var(--surface) 58%, transparent); position: relative; }
.song-tab:hover { background: var(--surface-soft); border-color: color-mix(in srgb, var(--accent-sky) 22%, var(--hairline)); }
.song-tab.on { background: var(--surface); border-color: color-mix(in srgb, var(--accent-sky) 38%, var(--hairline)); border-bottom-color: var(--surface); box-shadow: 0 2px 0 var(--surface), inset 0 2px 0 var(--accent-sky); }
.song-tab.pinned { border-left: 2px solid var(--accent-sky); }
.song-tab::before { content: ''; position: absolute; left: 0; top: 5px; bottom: 5px; width: 2px; border-radius: 2px; background: var(--tab-group, transparent); }
.st-pin { flex: none; color: var(--accent-sky); }
.st-lock { flex: none; font-size: 9px; color: var(--text3); opacity: .7; }
.st-group { max-width: 40px; padding: 0 3px; border: 1px solid; border-radius: var(--r-sm); font-size: 9px; line-height: 14px; background: transparent; }
.st-close { width: 20px; height: 20px; opacity: .55; }
.st-close:hover { background: color-mix(in srgb, var(--accent-red) 18%, var(--surface-soft)); color: var(--text); }
.st-arrow { width: 22px; height: 26px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text3); display: grid; place-items: center; flex: none; cursor: pointer; }
.st-arrow:hover:not(:disabled) { color: var(--accent-sky); border-color: var(--hairline); background: var(--surface-soft); }
.st-arrow:disabled { opacity: .25; cursor: default; }
.st-all { width: auto; padding: 0 6px; gap: 3px; font-size: 10px; font-family: var(--font-num); }
.st-menu { min-width: 220px; max-width: 300px; max-height: 420px; overflow: auto; }
.st-all-menu { top: 40px; right: 8px; left: auto !important; }
.st-menu-title { padding: 5px 8px 7px; color: var(--text3); font-size: var(--fs-xs); border-bottom: 1px solid var(--hairline); margin-bottom: 3px; }
.st-menu-item { min-height: 30px; }
.st-menu-item.on { background: var(--surface-soft); box-shadow: inset 2px 0 0 var(--accent-sky); }
.st-all-item { justify-content: flex-start; }
.st-all-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-all-group { flex: none; max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; opacity: .8; }
@media (max-width: 760px) { .song-tab { max-width: 150px; } .st-arrow { display: none; } }
</style>
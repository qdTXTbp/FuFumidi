<script setup>
// 多标签页：已打开曲目的浏览器式标签栏（切换 / 关闭 / 关闭全部 / 拖拽排序 / 键盘）。
// 标签只是曲目入口，不复制 song 数据；关闭标签不会删除曲目。
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
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
const dragOver = ref(-1);

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
onMounted(() => window.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <div v-if="visible" class="song-tabs" data-guide="song-tabs" role="tablist" :aria-label="t('已打开曲目')">
    <div class="st-scroll">
      <div v-for="(tb, i) in store.tabs" :key="tb.id" class="song-tab" :class="{ on: store.activeId === tb.id, dragging: dragIndex === i, over: dragOver === i }"
           role="tab" :aria-selected="store.activeId === tb.id" :tabindex="store.activeId === tb.id ? 0 : -1" :data-song-id="tb.id" :title="tb.name"
           draggable="true" @click="pick(tb.id)" @keydown.enter="pick(tb.id)" @keydown.space.prevent="pick(tb.id)"
           @auxclick.prevent="closeTab($event, tb.id)" @dblclick.stop="closeOthers($event, tb.id)"
           @dragstart="onDragStart($event, i)" @dragover="onDragOver($event, i)" @drop="onDrop($event, i)" @dragend="onDragEnd">
        <span class="st-name">{{ tb.name }}</span>
        <button class="st-close" data-guide="song-tab-close" :title="t('关闭此标签')" :aria-label="t('关闭此标签')" @click="closeTab($event, tb.id)">
          <Icon name="plus" :size="10" :style="{ transform: 'rotate(45deg)' }" />
        </button>
      </div>
    </div>
    <button class="st-tool" data-guide="song-tab-new" :title="t('打开曲库')" :aria-label="t('打开曲库')" @click="openLibrary"><Icon name="plus" :size="12" /></button>
    <button v-if="store.tabs.length > 1" class="st-tool" :title="t('关闭全部标签')" :aria-label="t('关闭全部标签')" @click="closeAll"><Icon name="close" :size="12" /></button>
  </div>
</template>

<style scoped>
.song-tabs { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--hairline); background: color-mix(in srgb, var(--surface) 70%, var(--canvas)); overflow: hidden; flex: none; min-height: 34px; }
.st-scroll { display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0; }
.st-scroll::-webkit-scrollbar { display: none; }
.song-tab { display: flex; align-items: center; gap: var(--sp-1); max-width: 220px; padding: 3px var(--sp-2); border: 1px solid transparent; border-radius: var(--r-sm); color: var(--text3); background: transparent; cursor: pointer; font-size: var(--fs-xs); flex: none; transition: background var(--dur-1), border-color var(--dur-1); }
.song-tab:hover { background: var(--surface-soft); color: var(--text2); }
.song-tab.on { border-color: color-mix(in srgb, var(--accent-sky) 27%, var(--hairline)); color: var(--text); background: color-mix(in srgb, var(--accent-sapphire) 12%, var(--surface)); box-shadow: inset 0 -2px 0 var(--accent-sky); }
.song-tab.dragging { opacity: .45; }
.song-tab.over { border-color: var(--accent-sky); }
.st-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-close { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: none; background: transparent; color: inherit; cursor: pointer; border-radius: var(--r-sm); padding: 0; opacity: .5; }
.song-tab:hover .st-close, .song-tab.on .st-close { opacity: 1; }
.st-close:hover { background: var(--surface-soft); }
.st-tool { width: 24px; height: 24px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text3); display: grid; place-items: center; flex: none; cursor: pointer; }
.st-tool:hover { color: var(--accent-sky); border-color: var(--hairline); background: var(--surface-soft); }
</style>
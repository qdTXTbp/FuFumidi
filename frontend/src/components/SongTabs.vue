<script setup>
// P1-14 多标签页：已打开曲目的标签栏（切换 / 关闭；关闭不会删曲目）
import { computed } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { useTabsStore } from '../stores/tabs';
import { t } from '../core/i18n.js';

const app = useAppStore();
const store = useTabsStore();
const visible = computed(() => store.tabs.length >= 2);   // 单曲目时不占垂直空间

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
</script>

<template>
  <div v-if="visible" class="song-tabs" data-guide="song-tabs" role="tablist">
    <div v-for="tb in store.tabs" :key="tb.id" class="song-tab" :class="{ on: store.activeId === tb.id }"
         role="tab" :aria-selected="store.activeId === tb.id" :data-song-id="tb.id"
         :title="tb.name" @click="pick(tb.id)" @auxclick.prevent>
      <span class="st-name">{{ tb.name }}</span>
      <button class="st-close" data-guide="song-tab-close" :title="t('关闭此标签')"
              @click="closeTab($event, tb.id)" @dblclick.stop="closeOthers($event, tb.id)">
        <Icon name="plus" :size="10" :style="{ transform: 'rotate(45deg)' }" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.song-tabs { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-3);
             border-bottom: 1px solid var(--hairline); background: var(--surface); overflow-x: auto; flex: none; }
.song-tab { display: flex; align-items: center; gap: var(--sp-1); max-width: 220px; padding: 2px var(--sp-2);
            border: 1px solid var(--hairline); border-radius: var(--r-sm); color: var(--steel);
            background: var(--canvas); cursor: pointer; font-size: var(--fs-sm); flex: none; }
.song-tab:hover { background: var(--surface-soft); color: var(--ink); }
.song-tab.on { border-color: var(--accent); color: var(--ink); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.song-tab .st-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.song-tab .st-close { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
                      border: none; background: transparent; color: inherit; cursor: pointer; border-radius: var(--r-sm); padding: 0; }
.song-tab .st-close:hover { background: var(--surface-soft); }
</style>

// ============================================================
// P1-14 多标签页（曲目标签）
// ============================================================
// 目标：像浏览器标签那样在**已打开的曲目**之间切换，而不必回曲库重新找。
// 边界（v1）：
//   · 标签只是"曲目切换入口"，不复制 song 数据（内存里仍只有一份曲库）；
//   · 编排页撤销栈已按曲目隔离（core/history_stack.js 的 tabbed registry，P1-13）；
//     编辑器（钢琴卷帘）的撤销仍由各自的编辑器实例负责（切走的曲目再切回来是重新进入编辑器）；
//   · 关闭标签不会关闭/删除曲目，只从标签栏移除；
//   · 持久化到 localStorage（刷新后标签栏还在；启动时只保留曲库里仍存在的曲目）。
import { defineStore } from 'pinia';
import { ref } from 'vue';

type Tab = { id: string; name: string; pinned?: boolean };

const KEY = 'fufumidi.song-tabs.v1';
const MAX_TABS = 12;

function read(): { tabs: Tab[]; activeId: string } {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { tabs: [], activeId: '' };
    const j = JSON.parse(raw);
    const tabs: Tab[] = (Array.isArray(j.tabs) ? j.tabs : [])
      .filter((t: any) => t && t.id && typeof t.name === 'string')
      .slice(0, MAX_TABS)
      .map((t: any) => ({ id: String(t.id), name: String(t.name), pinned: !!t.pinned }));
    const activeId = tabs.some((t) => t.id === j.activeId) ? String(j.activeId) : (tabs[0] ? tabs[0].id : '');
    return { tabs, activeId };
  } catch (e) { return { tabs: [], activeId: '' }; }
}
function write(tabs: Tab[], activeId: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ tabs, activeId })); } catch (e) {}
}

export const useTabsStore = defineStore('songTabs', () => {
  const boot = read();
  const tabs = ref<Tab[]>(boot.tabs as Tab[]);
  const activeId = ref<string>(String(boot.activeId || ''));

  function persist() { write(tabs.value, activeId.value); }

  /** 打开/聚焦一个曲目标签（已存在则只激活） */
  function open(id: string | number, name: string) {
    const sid = String(id || '');
    if (!sid) return;
    const hit = tabs.value.find((t) => t.id === sid);
    if (hit) {
      if (name && hit.name !== name) hit.name = String(name);
      activeId.value = sid;
    } else {
      tabs.value.push({ id: sid, name: String(name || sid) });
      if (tabs.value.length > MAX_TABS) tabs.value.splice(0, tabs.value.length - MAX_TABS);
      activeId.value = sid;
    }
    persist();
  }

  /** 激活已存在的标签；不存在返回 false（调用方据此决定是否 selectSong） */
  function activate(id: string | number) {
    const sid = String(id || '');
    if (!tabs.value.some((t) => t.id === sid)) return false;
    activeId.value = sid;
    persist();
    return true;
  }

  /** 关闭标签；若关的是当前标签，自动选一个邻居作为 active（调用方负责 selectSong） */
  function close(id: string | number) {
    const sid = String(id || '');
    const i = tabs.value.findIndex((t) => t.id === sid);
    if (i < 0) return false;
    tabs.value.splice(i, 1);
    if (activeId.value === sid) {
      const next = tabs.value[Math.min(i, tabs.value.length - 1)];
      activeId.value = next ? next.id : '';
    }
    persist();
    return true;
  }

  /** 固定/取消固定标签：固定的标签排在视觉左侧，关闭全部时保留 */
  function togglePin(id: string | number) {
    const sid = String(id || '');
    const hit = tabs.value.find((t) => t.id === sid);
    if (!hit) return false;
    hit.pinned = !hit.pinned;
    persist();
    return true;
  }

  /** 关闭右侧未固定的标签；当前激活若被关掉则回退到 [id] */
  function closeRight(id: string | number) {
    const sid = String(id || '');
    const i = tabs.value.findIndex((t) => t.id === sid);
    if (i < 0) return 0;
    const before = tabs.value.length;
    tabs.value = tabs.value.filter((t, idx) => idx <= i || t.pinned);
    if (!tabs.value.some((t) => t.id === activeId.value)) {
      const fallback = tabs.value[Math.min(i, tabs.value.length - 1)];
      activeId.value = fallback ? fallback.id : '';
    }
    persist();
    return before - tabs.value.length;
  }

  function closeOthers(id: string | number) {
    const sid = String(id || '');
    tabs.value = tabs.value.filter((t) => t.id === sid || t.pinned);
    activeId.value = tabs.value.length ? sid : '';
    persist();
  }

  /** 拖拽重排标签；不改变当前激活项 */
  function move(from: number, to: number) {
    const i = Math.max(0, Math.min(tabs.value.length - 1, Number(from)));
    const j = Math.max(0, Math.min(tabs.value.length - 1, Number(to)));
    if (i === j || i < 0 || j < 0) return;
    const [item] = tabs.value.splice(i, 1);
    if (!item) return;
    tabs.value.splice(j, 0, item);
    persist();
  }

  /** 启动时与曲库对齐：清掉已不在曲库里的标签；返回被清掉的 id */
  function hydrate(availableIds: Array<string | number> = []) {
    const ok = new Set((availableIds || []).map(String));
    const before = tabs.value.length;
    tabs.value = tabs.value.filter((t: { id: string }) => ok.has(t.id));
    if (!tabs.value.some((t: { id: string }) => t.id === activeId.value)) activeId.value = tabs.value[0] ? tabs.value[0].id : '';
    persist();
    return before - tabs.value.length;
  }

  function clear(keepPinned = true) { tabs.value = keepPinned ? tabs.value.filter((t) => t.pinned) : []; activeId.value = tabs.value[0] ? tabs.value[0].id : ''; persist(); }

  return { tabs, activeId, open, activate, close, closeOthers, closeRight, togglePin, move, hydrate, clear, maxTabs: MAX_TABS };
});

// ============================================================
// 兼容层：旧组件继续从 store.js 导入，实际状态已迁至 Pinia stores/app
// ============================================================
import { computed } from 'vue';
import { pinia } from './stores/pinia';
import { useAppStore, VIEWS, MIGRATED_VIEWS } from './stores/app';
import { usePlaylistStore } from './stores/playlist';

export { VIEWS, MIGRATED_VIEWS };

// 全局状态（Pinia store 实例，props 与旧 state 兼容）
export const state = useAppStore(pinia);

const store = state;

// 计算属性兼容
export const currentSong = computed(() => store.currentSong);
export const totalStr = computed(() => store.totalStr);
export const curStr = computed(() => store.curStr);

// —— 函数兼容包装 ——
export function toast(msg, type = 'info') { return store.toast(msg, type); }

export async function importFiles(items) { return store.importFiles(items); }
export async function restoreSongs() { return store.restoreSongs(); }
export async function removeSong(id) { return store.removeSong(id); }
export async function selectSong(id) { return store.selectSong(id); }

export function togglePlay() { return store.togglePlay(); }
export function stopPlay() { return store.stopPlay(); }
export function seekRatio(r) { return store.seekRatio(r); }
export function setTempo(v) { return store.setTempo(v); }
export function toggleLoop() { return store.toggleLoop(); }
export function toggleMetro() { return store.toggleMetro(); }
export function setVolume(v) { return store.setVolume(v); }

export function setTrackVol(i, v) { return store.setTrackVol(i, v); }
export function toggleTrackMute(i) { return store.toggleTrackMute(i); }
export function toggleTrackSolo(i) { return store.toggleTrackSolo(i); }
export function setTrackPan(i, v) { return store.setTrackPan(i, v); }

export function setView(v) { return store.setView(v); }
export function startTickLoop() { return store.startTickLoop(); }
export function stopTickLoop() { return store.stopTickLoop(); }

// —— 歌单兼容（实际已由 stores/playlist 负责，保留导出以防外部引用） ——
function pl() { return usePlaylistStore(pinia); }
export function createPlaylist(name) { return pl().create(name); }
export function selectPlaylist(id) { return pl().select(id); }
export function deletePlaylist(id) {
  const p = pl();
  if (id === 'favorites') return { ok: false, error: '收藏不能删除' };
  const before = p.playlists.length;
  p.remove(id);
  return { ok: true, cleared: before === 1 };
}
export function addSongsToActivePlaylist(ids) { return pl().addSongs(ids); }
export function removeSongsFromPlaylist(ids) { return pl().removeFromAllPlaylists(ids); }
export function removeSongsFromActivePlaylist(ids) { return pl().removeSongs(ids); }
export function moveActivePlaylistSong(dragId, targetId, before) { return pl().moveSong(dragId, targetId, before); }
export function removeSongsFromLibrary(ids) {
  for (const id of ids || []) store.removeSong(id);
  pl().removeFromAllPlaylists(ids || []);
}

// —— URL hash 恢复（原 store.js 行为） ——
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => store.applyHash());
  store.applyHash();
  window.__fufumidiOnEnd = () => {
    store.playing = false;
    store.curSec = 0;
    store.progress = 0;
  };
}

// Pinia：歌单状态与持久化
import { defineStore } from 'pinia';

export interface Playlist {
  id: string;
  name: string;
  songIds: string[];
}

const LS_PLAYLISTS = 'fufumidi_playlists_v1';
const LS_ACTIVE = 'fufumidi_active_playlist';

function loadPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(LS_PLAYLISTS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch (e) {}
  return [{ id: 'default', name: '默认歌单', songIds: [] }];
}

export const usePlaylistStore = defineStore('playlist', {
  state: () => ({
    playlists: loadPlaylists() as Playlist[],
    activePlaylistId: (localStorage.getItem(LS_ACTIVE) || 'default') as string,
    search: '',
    favOnly: false,
    batchOn: false,
    batchSelection: [] as string[],
  }),
  getters: {
    activePlaylist(state): Playlist | null {
      if (state.activePlaylistId === 'favorites') return null;
      return state.playlists.find(p => p.id === state.activePlaylistId) || null;
    },
    songIds(state): string[] {
      const p = state.playlists.find(x => x.id === state.activePlaylistId);
      return p ? p.songIds : [];
    },
  },
  actions: {
    persist() {
      try { localStorage.setItem(LS_PLAYLISTS, JSON.stringify(this.playlists)); } catch (e) {}
      try { localStorage.setItem(LS_ACTIVE, this.activePlaylistId); } catch (e) {}
    },
    create(name: string) {
      const id = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this.playlists.push({ id, name: name || '未命名歌单', songIds: [] });
      this.activePlaylistId = id;
      this.persist();
      return id;
    },
    select(id: string) {
      if (id === 'favorites' || this.playlists.some(p => p.id === id)) {
        this.activePlaylistId = id;
        this.persist();
      }
    },
    remove(id: string) {
      if (id === 'favorites') return;
      if (this.playlists.length <= 1) {
        const def = this.playlists[0];
        def.songIds = [];
        this.activePlaylistId = def.id;
      } else {
        const i = this.playlists.findIndex(p => p.id === id);
        if (i >= 0) this.playlists.splice(i, 1);
        if (this.activePlaylistId === id) this.activePlaylistId = this.playlists[0].id;
      }
      this.persist();
    },
    addSongs(ids: string[]) {
      const list = this.activePlaylist || this.playlists.find(p => p.id === 'default') || this.playlists[0];
      if (!list) return;
      for (const id of ids) if (id && !list.songIds.includes(id)) list.songIds.push(id);
      this.persist();
    },
    removeSongs(ids: string[]) {
      const set = new Set(ids);
      const list = this.activePlaylist;
      if (list) {
        list.songIds = list.songIds.filter(id => !set.has(id));
        this.persist();
      }
    },
    removeFromAllPlaylists(ids: string[]) {
      const set = new Set(ids);
      for (const p of this.playlists) p.songIds = p.songIds.filter(id => !set.has(id));
      this.persist();
    },
    moveSong(dragId: string, targetId: string, before: boolean) {
      const list = this.activePlaylist;
      if (!list) return;
      const ids = list.songIds;
      const fi = ids.indexOf(dragId), ti = ids.indexOf(targetId);
      if (fi < 0 || ti < 0 || fi === ti) return;
      ids.splice(fi, 1);
      const t = ids.indexOf(targetId);
      ids.splice(before ? t : t + 1, 0, dragId);
      this.persist();
    },
    moveSongToEnd(dragId: string) {
      const list = this.activePlaylist;
      if (!list) return;
      const ids = list.songIds;
      const fi = ids.indexOf(dragId);
      if (fi < 0) return;
      ids.splice(fi, 1);
      ids.push(dragId);
      this.persist();
    },
    moveSongToIndex(dragId: string, index: number) {
      const list = this.activePlaylist;
      if (!list) return;
      const ids = list.songIds;
      const fi = ids.indexOf(dragId);
      if (fi < 0) return;
      const max = ids.length - 1;
      const to = Math.max(0, Math.min(max, Math.round(index) || 0));
      if (fi === to) return;
      ids.splice(fi, 1);
      ids.splice(to, 0, dragId);
      this.persist();
    },
    movePlaylist(dragId: string, targetId: string, before: boolean) {
      const fi = this.playlists.findIndex(p => p.id === dragId);
      const ti = this.playlists.findIndex(p => p.id === targetId);
      if (fi < 0 || ti < 0 || fi === ti) return;
      const arr = this.playlists.slice();
      const [item] = arr.splice(fi, 1);
      const t = arr.findIndex(p => p.id === targetId);
      arr.splice(before ? t : t + 1, 0, item);
      this.playlists = arr;
      this.persist();
    },
    movePlaylistToEnd(dragId: string) {
      const fi = this.playlists.findIndex(p => p.id === dragId);
      if (fi < 0) return;
      const arr = this.playlists.slice();
      const [item] = arr.splice(fi, 1);
      arr.push(item);
      this.playlists = arr;
      this.persist();
    },
    toggleBatch() {
      this.batchOn = !this.batchOn;
      if (!this.batchOn) this.batchSelection = [];
    },
    setBatchSelected(ids: string[]) { this.batchSelection = ids.slice(); },
  },
});

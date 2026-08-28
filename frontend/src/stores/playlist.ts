// Pinia：歌单状态与持久化
import { defineStore } from 'pinia';
import { t } from '../core/i18n';

export interface Playlist {
  id: string;
  name: string;
  songIds: string[];
}

const LS_PLAYLISTS = 'fufumidi_playlists_v1';
const LS_ACTIVE = 'fufumidi_active_playlist';
const LS_FAVS = 'fufumidi_favs';

function loadFavs(): string[] {
  try {
    const raw = localStorage.getItem(LS_FAVS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((x: any) => typeof x === 'string');
    }
  } catch (e) {}
  return [];
}

async function dbPlaylistsAll(): Promise<Playlist[]> {
  const b = (window as any).fuBridge;
  if (b && typeof b.dbPlaylistsList === 'function') {
    try {
      const arr = await b.dbPlaylistsList();
      if (Array.isArray(arr) && arr.length) return arr as Playlist[];
    } catch (e) {}
  }
  return [];
}
function dbPlaylistPut(pl: Playlist) {
  const b = (window as any).fuBridge;
  if (b && typeof b.dbPlaylistsPut === 'function') {
    try { b.dbPlaylistsPut(pl); } catch (e) {}
  }
}

function loadPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(LS_PLAYLISTS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch (e) {}
  return [{ id: 'default', name: t('默认歌单'), songIds: [] }];
}

export const usePlaylistStore = defineStore('playlist', {
  state: () => ({
    playlists: loadPlaylists() as Playlist[],
    activePlaylistId: (localStorage.getItem(LS_ACTIVE) || 'default') as string,
    search: '',
    favOnly: false,
    batchOn: false,
    batchSelection: [] as string[],
    favorites: loadFavs() as string[],
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
      for (const p of this.playlists) dbPlaylistPut(p);
    },
    async hydrateFromDb() {
      const db = await dbPlaylistsAll();
      if (!db.length) {
        // 首次从 localStorage 迁移到 SQLite
        for (const p of this.playlists) dbPlaylistPut(p);
        return false;
      }
      this.playlists = db;
      if (!db.some(p => p.id === this.activePlaylistId)) {
        const def = db.find(p => p.id === 'default');
        this.activePlaylistId = def ? def.id : (db[0]?.id || 'default');
        try { localStorage.setItem(LS_ACTIVE, this.activePlaylistId); } catch (e) {}
      }
      this.persist();
      return true;
    },
    create(name: string) {
      const id = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this.playlists.push({ id, name: name || t('未命名歌单'), songIds: [] });
      this.activePlaylistId = id;
      this.persist();
      return id;
    },
    select(id: string) {
      if (id === 'all' || id === 'favorites' || this.playlists.some(p => p.id === id)) {
        this.activePlaylistId = id;
        this.persist();
      }
    },
    rename(id: string, name: string) {
      const p = this.playlists.find(x => x.id === id);
      if (!p) return;
      p.name = name || p.name;
      this.persist();
    },
    remove(id: string) {
      if (id === 'favorites') return;
      if (this.playlists.length <= 1) {
        const def = this.playlists[0];
        if (def) { def.songIds = []; this.activePlaylistId = def.id; }
      } else {
        const i = this.playlists.findIndex(p => p.id === id);
        if (i >= 0) this.playlists.splice(i, 1);
        if (this.activePlaylistId === id) {
          const first = this.playlists[0];
          if (first) this.activePlaylistId = first.id;
        }
      }
      this.persist();
    },
    addSongs(ids: string[]) {
      const list = this.activePlaylist || this.playlists.find(p => p.id === 'default') || this.playlists[0];
      if (!list) return;
      for (const id of ids) if (id && !list.songIds.includes(id)) list.songIds.push(id);
      this.persist();
    },
    addToPlaylist(plId: string, ids: string[]) {
      const p = this.playlists.find(x => x.id === plId);
      if (!p) return;
      for (const id of ids) if (id && !p.songIds.includes(id)) p.songIds.push(id);
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
      const item = arr.splice(fi, 1)[0];
      if (!item) return;
      const t = arr.findIndex(p => p.id === targetId);
      arr.splice(before ? t : t + 1, 0, item);
      this.playlists = arr;
      this.persist();
    },
    movePlaylistToEnd(dragId: string) {
      const fi = this.playlists.findIndex(p => p.id === dragId);
      if (fi < 0) return;
      const arr = this.playlists.slice();
      const item = arr.splice(fi, 1)[0];
      if (!item) return;
      arr.push(item);
      this.playlists = arr;
      this.persist();
    },
    toggleBatch() {
      this.batchOn = !this.batchOn;
      if (!this.batchOn) this.batchSelection = [];
    },
    setBatchSelected(ids: string[]) { this.batchSelection = ids.slice(); },

    /* ---------------- 收藏 ---------------- */
    isFavorite(id: string): boolean {
      return this.favorites.includes(id);
    },
    toggleFavorite(id: string) {
      const i = this.favorites.indexOf(id);
      if (i >= 0) this.favorites.splice(i, 1);
      else this.favorites.push(id);
      this.persistFavs();
    },
    persistFavs() {
      try { localStorage.setItem(LS_FAVS, JSON.stringify(this.favorites)); } catch (e) {}
      const b = (window as any).fuBridge;
      if (b && b.dbKvSet) { try { b.dbKvSet('favorites', this.favorites.slice()); } catch (e) {} }
    },
    async hydrateFavorites() {
      const b = (window as any).fuBridge;
      if (!b || typeof b.dbKvGet !== 'function') return;
      try {
        const v = await b.dbKvGet('favorites');
        if (Array.isArray(v)) {
          this.favorites = v.filter((x: any) => typeof x === 'string');
          try { localStorage.setItem(LS_FAVS, JSON.stringify(this.favorites)); } catch (e) {}
        } else {
          this.persistFavs(); // 迁移旧 localStorage 收藏到 SQLite
        }
      } catch (e) {}
    },
  },
});

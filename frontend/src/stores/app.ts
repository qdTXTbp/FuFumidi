// Pinia 应用主 Store：播放 / 歌单 / 混音 / UI / 导入恢复
// 所有组件直接使用 Pinia store，store.js 兼容层已移除
import { defineStore } from 'pinia';
import { ensureAudio } from '../audio';
import { parseMidi, buildSong } from '../core/midi';
import { TRACK_COLORS, fmtTime } from '../core/util';
import { usePlaylistStore } from './playlist';
import { bridge } from '../api';
import { t } from '../core/i18n';

export const VIEWS = [
  { id: 'home', label: '首页', ic: 'home' },
  { id: 'play', label: '演奏', ic: 'play2' },
  { id: 'lyrics', label: '歌词', ic: 'music' },
  { id: 'edit', label: '编辑', ic: 'edit' },
  { id: 'viz', label: '可视化', ic: 'viz' },
  { id: 'analyze', label: '分析', ic: 'chart' },
  { id: 'score', label: '乐谱', ic: 'score' },
  { id: 'transcribe', label: '转录', ic: 'transcribe' },
  { id: 'convert', label: '转换', ic: 'convert' },
  { id: 'resources', label: '资源中心', ic: 'box' },
  { id: 'utau', label: 'UTAU', ic: 'utau' },
];

const DB_NAME = 'fufumidi-db', DB_VER = 1, STORE_SONGS = 'songs';
let _dbP: Promise<any> | null = null;
let _toastTimer: any = null;
let _raf: number | null = null;
// 全局 Web 弹窗（confirm/alert/prompt）：resolve 回调存模块级，避免放进响应式状态
let _dlgResolve: ((v: any) => void) | null = null;

/* 侧边栏宽度：可拖动调整，带范围限制 */
export const SIDEBAR_DEFAULT_W = 240;
export const SIDEBAR_MIN_W = 200;
export const SIDEBAR_MAX_W = 520;
function readSidebarWidth(): number {
  try {
    const v = parseInt(localStorage.getItem('fufumidi_sidebar_w') || '', 10);
    if (Number.isFinite(v) && v >= SIDEBAR_MIN_W && v <= SIDEBAR_MAX_W) return v;
  } catch (e) {}
  return SIDEBAR_DEFAULT_W;
}

function openDb(): Promise<any> {
  if (_dbP) return _dbP;
  _dbP = new Promise((res) => {
    let req: any;
    try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { res(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SONGS)) db.createObjectStore(STORE_SONGS, { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => res(null);
    req.onblocked = () => res(null);
  });
  return _dbP;
}
async function idbAll(store: string): Promise<any[]> {
  const db = await openDb();
  return new Promise((res) => {
    if (!db) return res([]);
    try {
      const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    } catch (e) { res([]); }
  });
}
async function idbGet(store: string, id: string): Promise<any> {
  const db = await openDb();
  return new Promise((res) => {
    if (!db) return res(null);
    try {
      const rq = db.transaction(store, 'readonly').objectStore(store).get(id);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}
async function idbPut(store: string, val: any): Promise<boolean> {
  const db = await openDb();
  return new Promise((res) => {
    if (!db) return res(false);
    try {
      const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val);
      tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false);
    } catch (e) { res(false); }
  });
}
async function idbDelete(store: string, id: string): Promise<boolean> {
  const db = await openDb();
  return new Promise((res) => {
    if (!db) return res(false);
    try {
      const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id);
      tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false);
    } catch (e) { res(false); }
  });
}

/* ---------------- SQLite 持久化（桌面版优先，回退 IndexedDB） ---------------- */
async function dbSongsAll(): Promise<any[]> {
  if (bridge && typeof bridge.dbSongsList === 'function') {
    try { const arr = await bridge.dbSongsList(); if (Array.isArray(arr)) return arr; } catch (e) {}
  }
  return [];
}
async function dbSongPut(rec: any): Promise<void> {
  if (bridge && typeof bridge.dbSongsPut === 'function') {
    try { await bridge.dbSongsPut(rec); } catch (e) {}
  }
}
async function dbSongDelete(id: string): Promise<void> {
  if (bridge && typeof bridge.dbSongsDelete === 'function') {
    try { await bridge.dbSongsDelete(id); } catch (e) {}
  }
}

function cryptoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* 内容指纹：名称 + 大小 + FNV-1a 哈希，用于导入去重 */
function contentFp(name: string, bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    const b = bytes[i] ?? 0;
    h = (h ^ b) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (name || '').trim().toLowerCase() + '|' + len + '|' + h.toString(16);
}
function fpOf(song: any, name: string): string {
  if (song.meta && song.meta.fp) return song.meta.fp;
  if (song.__bytes) return contentFp(name, song.__bytes);
  return '';
}

export const useAppStore = defineStore('app', {
  state: () => ({
    view: 'play' as string,
    sidebarOpen: true,
    sidebarResizing: false,
    sidebarWidth: readSidebarWidth(),
    playerbarOpen: true,
    playlists: [] as any[],
    activePlaylistId: 'default' as string,
    playlistSearch: '',
    playlistSort: 'added' as string,
    playlistFavOnly: false,
    songs: [] as any[],
    currentId: null as string | null,
    playing: false,
    curSec: 0,
    totalSec: 0,
    progress: 0,
    tempo: 1,
    loop: false,
    metro: false,
    volume: 0.85,
    tracks: [] as any[],
    toastMsg: '' as any,
    confirm: null as any,
    dialog: null as any, // { kind:'confirm'|'alert'|'prompt', title, msg, okText, cancelText, value }
    importPick: null as { items: any[] } | null, // 导入目标歌单选择浮层（待导入的 item 列表）
    fileBusy: false,
    ui: {
      settingsOpen: false,
      settingsTab: 'appearance',
      themesOpen: false,
      wallpaperOpen: false,
      guideOpen: false,
      paletteOpen: false,
      changelogOpen: false,
    },
    integrity: null as any,
    changelog: null as any, // 更新日志数据 { from, to, logs: [{ver, items}] }
  }),
  getters: {
    currentSong(state): any {
      return state.songs.find((s: any) => s.id === state.currentId) || null;
    },
    totalStr(state): string {
      return fmtTime(state.totalSec);
    },
    curStr(state): string {
      return fmtTime(state.curSec);
    },
    /* 当前视图下的播放队列：全部曲目 / 收藏 / 歌单，并按搜索过滤 */
    queueSongs(state): any[] {
      const pl = usePlaylistStore();
      let list: any[];
      if (pl.activePlaylistId === 'all') {
        list = state.songs;
      } else if (pl.activePlaylistId === 'favorites') {
        const favs = new Set(pl.favorites);
        list = state.songs.filter(s => favs.has(s.id));
      } else {
        const ids = pl.songIds;
        const order = new Map(ids.map((id, idx) => [id, idx]));
        list = state.songs
          .filter(s => ids.includes(s.id))
          .slice()
          .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
      }
      const q = (pl.search || '').trim().toLowerCase();
      if (q) list = list.filter(s => String(s.name || '').toLowerCase().includes(q));
      return list;
    },
  },
  actions: {
    toast(msg: string, type = 'info') {
      this.toastMsg = { msg, type };
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => (this.toastMsg = ''), 2800);
    },
    /* ---------------- 全局 Web 弹窗（取代 window.confirm/alert/prompt） ---------------- */
    confirmDialog(cfg: any = {}): Promise<boolean> {
      return new Promise((resolve) => {
        _dlgResolve = (v) => resolve(!!v);
        this.dialog = { kind: 'confirm', title: cfg.title || t('提示'), msg: cfg.msg || '', okText: cfg.okText || t('确定'), cancelText: cfg.cancelText || t('取消'), value: '' };
      });
    },
    alertDialog(cfg: any = {}): Promise<void> {
      return new Promise((resolve) => {
        _dlgResolve = () => resolve(undefined);
        this.dialog = { kind: 'alert', title: cfg.title || t('提示'), msg: cfg.msg || '', okText: cfg.okText || t('确定'), value: '' };
      });
    },
    promptDialog(cfg: any = {}): Promise<string | null> {
      return new Promise((resolve) => {
        _dlgResolve = (v) => resolve(v);
        this.dialog = { kind: 'prompt', title: cfg.title || t('输入'), msg: cfg.msg || '', okText: cfg.okText || t('确定'), cancelText: cfg.cancelText || t('取消'), value: cfg.value ?? '' };
      });
    },
    // 确认/提交：confirm 返回 true，alert 返回，prompt 返回输入值
    dialogResolve(value: any = true) {
      const r = _dlgResolve;
      _dlgResolve = null;
      this.dialog = null;
      if (r) r(value);
    },
    // 取消/关闭：prompt 返回 null，confirm 返回 false，alert 直接关闭
    dialogCancel() {
      const r = _dlgResolve;
      _dlgResolve = null;
      const kind = this.dialog && this.dialog.kind;
      this.dialog = null;
      if (!r) return;
      if (kind === 'prompt') r(null);
      else if (kind === 'alert') r(undefined);
      else r(false);
    },
    async importFiles(items: any[], target?: string) {
      // target: 歌单 id | 'all'（仅加入资料库/全部曲目，不归入任何歌单）
      //         | undefined（沿用当前激活歌单，否则默认歌单）
      let ok = 0, dup = 0;
      const imported: string[] = [];
      for (const it of items) {
        const name = it.name.replace(/\.(mid|midi|kar|rmi)$/i, '');
        const bytes = it.bytes ? new Uint8Array(it.bytes) : null;
        // 内容与名字相同的曲目不重复导入
        if (bytes) {
          const fp = contentFp(name, bytes);
          const exists = this.songs.some(x => {
            if (x.meta.fp && x.meta.fp === fp) return true;
            if (String(x.name || '') !== name) return false;
            const xf = fpOf(x, name);
            return !!xf && xf === fp;
          });
          if (exists) { dup++; continue; }
        }
        let mid: any;
        try { mid = parseMidi(bytes); } catch (e: any) { this.toast(t('无法解析 ') + it.name + '：' + e.message, 'warn'); continue; }
        const song: any = buildSong(mid, { name });
        const item = {
          id: cryptoId(),
          name: song.name,
          song,
          __bytes: bytes,
          meta: { size: it.bytes.byteLength, time: Date.now(), tracks: song.tracks.length, dur: song.totalSec, fp: bytes ? contentFp(name, bytes) : '' },
        };
        this.songs.push(item);
        imported.push(item.id);
        await idbPut(STORE_SONGS, { id: item.id, name: it.name, size: item.meta.size, time: item.meta.time, dur: item.meta.dur, fp: item.meta.fp, bytes: it.bytes });
        await dbSongPut({ id: item.id, name: it.name, size: item.meta.size, time: item.meta.time, dur: item.meta.dur, fp: item.meta.fp, bytes: Array.from(it.bytes as any) });
        ok++;
      }
      // 批量归入目标歌单（全部曲目即全局资料库，无需额外归入）
      if (ok > 0 && imported.length) {
        const plStore = usePlaylistStore();
        if (target && target !== 'all') {
          plStore.addToPlaylist(target, imported);
        } else if (!target) {
          const active = plStore.activePlaylist;
          if (active) plStore.addToPlaylist(active.id, imported);
          else plStore.addToPlaylist('default', imported);
        }
      }
      if (ok > 0) {
        const last = this.songs[this.songs.length - 1];
        await this.selectSong(last.id);
        let suffix = dup ? t('，跳过 ') + dup + t(' 首重复') : '';
        if (target && target !== 'all') {
          const plName = usePlaylistStore().playlists.find(p => p.id === target)?.name;
          if (plName) suffix = t(' 到「') + plName + t('」') + suffix;
        }
        this.toast(t('已导入 ') + ok + t(' 首 MIDI') + suffix);
      } else if (dup > 0) {
        this.toast(t('所选曲目已在资料库中，未重复导入'), 'warn');
      } else if (items.length) {
        this.toast(t('没有可导入的 MIDI 文件'), 'warn');
      }
    },
    // 用户主动导入（按钮/拖放/命令面板）：先选目标歌单，确认后再真正导入
    importWithPicker(items: any[]) {
      if (!items || !items.length) return;
      this.importPick = { items };
    },
    confirmImportTarget(targetId: string, newName?: string) {
      const p = this.importPick;
      this.importPick = null;
      if (!p || !p.items.length) return;
      if (targetId === '__new__' && newName && newName.trim()) {
        const plStore = usePlaylistStore();
        targetId = plStore.create(newName.trim());
      }
      this.importFiles(p.items, targetId);
    },
    cancelImportTarget() {
      this.importPick = null;
    },
    async restoreSongs() {
      const sqliteRecs = await dbSongsAll();
      let recs = sqliteRecs;
      if (!recs.length) {
        recs = await idbAll(STORE_SONGS);
        // 首次从 IndexedDB 迁移到 SQLite（桌面版）
        if (recs.length) {
          for (const r of recs) await dbSongPut({ id: r.id, name: r.name, size: r.size || 0, time: r.time || 0, dur: r.dur || 0, fp: r.fp || '', bytes: Array.from(r.bytes || []) });
        }
      }
      for (const r of recs) {
        if (!r || !r.id || this.songs.some((s: any) => s.id === r.id)) continue;
        this.songs.push({
          id: r.id,
          name: String(r.name || t('未命名')).replace(/\.(mid|midi|kar|rmi)$/i, ''),
          song: null,
          meta: { size: r.size || 0, time: r.time || 0, dur: r.dur || 0, fp: r.fp || '' },
          __bytes: r.bytes || null,
        });
      }
      if (!this.songs.length) return;
      let active: string | null = null;
      try { active = localStorage.getItem('fufumidi_active'); } catch (e) {}
      if (active && this.songs.some((s: any) => s.id === active)) await this.selectSong(active);
      else await this.selectSong(this.songs[this.songs.length - 1].id);
    },
    async removeSong(id: string) {
      const i = this.songs.findIndex((s: any) => s.id === id);
      if (i < 0) return;
      const wasCurrent = this.currentId === id;
      const { player } = ensureAudio();
      if (wasCurrent) { player.stop(); this.playing = false; this.currentId = null; this.tracks = []; }
      this.songs.splice(i, 1);
      await idbDelete(STORE_SONGS, id);
      await dbSongDelete(id);
      if (wasCurrent) { try { localStorage.removeItem('fufumidi_active'); } catch (e) {} }
      if (this.songs.length) {
        // 优先选择当前队列中的下一首，避免跳出歌单/搜索结果
        const q = this.queueSongs;
        if (q.length) await this.selectSong(q[0].id);
        else await this.selectSong(this.songs[0].id);
      }
    },
    async selectSong(id: string) {
      const item = this.songs.find((s: any) => s.id === id);
      if (!item) return;
      if (!item.song) {
        let lastErr = null;
        const tryParse = (bytes: any): boolean => {
          try {
            const b = Array.isArray(bytes) ? new Uint8Array(bytes) : bytes;
            const mid = parseMidi(b);
            item.song = buildSong(mid, { name: item.name });
            item.meta.tracks = item.song.tracks.length;
            return true;
          } catch (e: any) { lastErr = e; return false; }
        };
        // 1) 内存中的字节缓冲（本会话导入时缓存）
        //    解析失败说明该缓冲损坏（如 SQLite 大文件字节数组异常），清掉避免下次再用坏缓存
        if (item.__bytes && !tryParse(item.__bytes)) item.__bytes = null;
        // 2) IndexedDB 原生字节（最可靠，转录/导入时原生 Uint8Array 无损存储）
        if (!item.song) { const r = await idbGet(STORE_SONGS, id); if (r && r.bytes) tryParse(r.bytes); }
        // 3) SQLite 字节（兜底，JSON 数字数组对较大 MIDI 可能丢失）
        if (!item.song) { const all = await dbSongsAll(); const r = all.find((x: any) => x.id === id); if (r && r.bytes) tryParse(r.bytes); }
        if (!item.song) this.toast(t('无法解析已保存的 MIDI：') + (lastErr && lastErr.message || ''), 'warn');
      }
      if (!item.song) return;
      try { localStorage.setItem('fufumidi_active', id); } catch (e) {}
      const { player } = ensureAudio();
      player.stop();
      this.currentId = id;
      this.playing = false;
      this.curSec = 0;
      this.progress = 0;
      player.load(item.song);
      player.setScale(this.tempo);
      player.setLoop(this.loop, 0, item.song.totalTicks);
      player.setMetronome(this.metro);
      this.totalSec = item.song.totalSec;
      this.tracks = item.song.tracks.map((tr: any, i: number) => ({
        index: i,
        name: tr.name,
        program: tr.program,
        isDrum: tr.isDrum,
        vol: 1,
        mute: false,
        solo: false,
        pan: 0,
        color: TRACK_COLORS[i % TRACK_COLORS.length],
        noteCount: tr.notes.length,
      }));
    },
    togglePlay() {
      const { player } = ensureAudio();
      if (!this.currentSong) { this.toast(t('请先导入一首 MIDI'), 'warn'); return; }
      if (this.playing) {
        player.pause();
        this.playing = false;
      } else {
        player.play();
        this.playing = true;
      }
    },
    stopPlay() {
      const { player } = ensureAudio();
      player.stop();
      this.playing = false;
      this.curSec = 0;
      this.progress = 0;
    },
    seekRatio(r: number) {
      const s = this.currentSong && this.currentSong.song;
      if (!s) return;
      const { player } = ensureAudio();
      r = Math.max(0, Math.min(1, r));
      player.seekTick(s.secToTick(r * s.totalSec));
      this.curSec = player.currentSec();
      this.progress = r;
    },
    setTempo(v: number) {
      this.tempo = Math.max(0.25, Math.min(4, v));
      const { player } = ensureAudio();
      if (this.currentSong) player.setScale(this.tempo);
    },
    toggleLoop() {
      this.loop = !this.loop;
      const s = this.currentSong && this.currentSong.song;
      const { player } = ensureAudio();
      if (s) player.setLoop(this.loop, 0, s.totalTicks);
    },
    toggleMetro() {
      this.metro = !this.metro;
      const { player } = ensureAudio();
      player.setMetronome(this.metro);
    },
    setVolume(v: number) {
      this.volume = Math.max(0, Math.min(1, v));
      const { player } = ensureAudio();
      player.syn.setVolume(this.volume);
    },
    setTrackVol(i: number, v: number) {
      if (!this.tracks[i]) return;
      this.tracks[i].vol = v;
      const { player } = ensureAudio();
      player.syn.setTrackVol(i, v);
    },
    toggleTrackMute(i: number) {
      if (!this.tracks[i]) return;
      this.tracks[i].mute = !this.tracks[i].mute;
      const { player } = ensureAudio();
      player.syn.setTrackMute(i, this.tracks[i].mute);
    },
    toggleTrackSolo(i: number) {
      if (!this.tracks[i]) return;
      this.tracks[i].solo = !this.tracks[i].solo;
      const { player } = ensureAudio();
      player.syn.setTrackSolo(i, this.tracks[i].solo);
    },
    setTrackPan(i: number, v: number) {
      if (!this.tracks[i]) return;
      this.tracks[i].pan = v;
      const { player } = ensureAudio();
      player.syn.setTrackPan(i, v);
    },
    setView(v: string) {
      this.view = VIEWS.some(x => x.id === v) ? v : 'home';
      this.syncHash();
    },
    setSidebarWidth(w: number) {
      const v = Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, w)));
      this.sidebarWidth = v;
      try { localStorage.setItem('fufumidi_sidebar_w', String(v)); } catch (e) {}
    },
    syncHash() {
      if (typeof location === 'undefined') return;
      const target = '#/' + this.view;
      if (location.hash !== target) {
        try { location.hash = target; } catch (e) {}
      }
    },
    startTickLoop() {
      if (_raf) return;
      const tick = () => {
        if (this.playing) {
          const { player } = ensureAudio();
          const s = this.currentSong && this.currentSong.song;
          if (player && s) {
            this.curSec = player.currentSec();
            this.progress = s.totalTicks ? player.currentTick() / s.totalTicks : 0;
          }
        }
        _raf = requestAnimationFrame(tick);
      };
      _raf = requestAnimationFrame(tick);
    },
    stopTickLoop() {
      if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    },
  },
});

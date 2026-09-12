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
  { id: 'music', label: '音乐', ic: 'music' },
  { id: 'views', label: '视图', ic: 'viz' },
  { id: 'transcode', label: '转译', ic: 'convert' },
  { id: 'resources', label: '资源中心', ic: 'box' },
  { id: 'utau', label: 'UTAU', ic: 'utau' },
];

// 旧子视图 ID → 所属分组父视图，保留内部跳转（如“同步到乐谱”“打开播放”）
export const OLD_VIEW_TO_PARENT: Record<string, string> = {
  play: 'music', lyrics: 'music', edit: 'music',
  viz: 'views', analyze: 'views', score: 'views',
  transcribe: 'transcode', convert: 'transcode',
};

export function viewParentOf(v: string): string {
  return OLD_VIEW_TO_PARENT[v] || (VIEWS.some(x => x.id === v) ? v : 'home');
}

const DB_NAME = 'fufumidi-db', DB_VER = 1, STORE_SONGS = 'songs';
let _dbP: Promise<any> | null = null;
let _toastTimer: any = null;
let _raf: number | null = null;
// 正在预解析的下一首曲目 id（无缝播放：切歌时省去 parseMidi 耗时）
const _preloading = new Set<string>();
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
async function idbKeys(store: string): Promise<any[]> {
  const db = await openDb();
  return new Promise((res) => {
    if (!db) return res([]);
    try {
      const rq = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
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

/**
 * 把任意来源的曲目字节归一化成 Uint8Array。
 *
 * 曲目字节有三种来源形态：file:readBinary 经 IPC 回来的是 ArrayBuffer、
 * IndexedDB 里可能存着这种 ArrayBuffer、SQLite 里存的是 number[]。
 * 不归一化会出现两类问题：
 *   - Array.from(ArrayBuffer) 得到空数组 → 迁移到 SQLite 时字节丢失；
 *   - number[] 直接当 Uint8Array 用（Blob / parseMidi）会失败。
 */
function toBytes(v: any): Uint8Array | null {
  if (!v) return null;
  if (v instanceof Uint8Array) return v.length ? v : null;
  if (v instanceof ArrayBuffer) return v.byteLength ? new Uint8Array(v) : null;
  if (ArrayBuffer.isView(v)) {
    const t = new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength);
    return t.length ? t : null;
  }
  if (Array.isArray(v)) return v.length ? Uint8Array.from(v) : null;
  return null;
}

export const useAppStore = defineStore('app', {
  state: () => ({
    view: 'home' as string,
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
    // 播放模式：order 顺序 / shuffle 随机 / repeatOne 单曲循环 / loopAll 列表循环
    playMode: (localStorage.getItem('fufumidi_playmode') || 'order') as string,
    sleepUntil: 0 as number, // 睡眠定时到期时间戳（ms），0=未启用
    sleepTimer: null as any,
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
    gpuInstall: { active: false, percent: 0, text: '', kind: null as string | null, done: false, ok: false, error: '', ts: 0, dismissed: false }, // 常驻 GPU 安装进度（dismissed：用户已收起浮层，后台任务继续）
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
    /* 当前视图下的播放队列：全部曲目 / 收藏 / 智能列表 / 歌单，并按搜索过滤 */
    isAudio(state): boolean {
      return !!(state.currentSong && state.currentSong.kind === 'audio');
    },
    queueSongs(state): any[] {
      const pl = usePlaylistStore();
      const stats = (): Record<string, { c: number; last: number }> => { try { return JSON.parse(localStorage.getItem('fufumidi_stats') || '{}'); } catch (e) { return {}; } };
      let list: any[];
      if (pl.activePlaylistId === 'all') {
        list = state.songs;
      } else if (pl.activePlaylistId === 'favorites') {
        const favs = new Set(pl.favorites);
        list = state.songs.filter(s => favs.has(s.id));
      } else if (pl.activePlaylistId === 'recent') {
        const st = stats();
        list = state.songs.filter(s => st[s.id] && st[s.id].last)
          .slice().sort((a, b) => (st[b.id].last || 0) - (st[a.id].last || 0)).slice(0, 100);
      } else if (pl.activePlaylistId === 'most') {
        const st = stats();
        list = state.songs.filter(s => st[s.id] && st[s.id].c > 0)
          .slice().sort((a, b) => (st[b.id].c || 0) - (st[a.id].c || 0)).slice(0, 100);
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
      let ok = 0, dup = 0, linked = 0;
      const imported: string[] = [];
      for (const it of items) {
        // 音频曲目（播客/有声书/音乐音频）：不解析 MIDI，按 <audio> 播放
        if (/\.(mp3|wav|flac|m4a|ogg|aac|opus)$/i.test(it.name || '')) {
          const aname = String(it.name).replace(/\.[^.]+$/, '');
          const abytes = it.bytes ? new Uint8Array(it.bytes) : null;
          const aitem = {
            id: cryptoId(),
            name: aname,
            kind: 'audio',
            song: null,
            __bytes: abytes,
            meta: { size: it.bytes ? it.bytes.byteLength : 0, time: Date.now(), tracks: 0, dur: 0, fp: abytes ? contentFp(aname, abytes) : '' },
          };
          this.songs.push(aitem);
          imported.push(aitem.id);
          if (it.bytes) {
            // 归一化成 Uint8Array 再落库：readBinary 经 IPC 回来的是 ArrayBuffer，
            // 原样存进 IndexedDB 后，云同步的 pickBytes 认不出（它只认 Uint8Array/数组），
            // 会把这类曲目判成"本机没有 MIDI 内容"。SQLite 侧 Array.from(ArrayBuffer) 也会得到空数组。
            idbPut(STORE_SONGS, { id: aitem.id, name: it.name, size: aitem.meta.size, time: aitem.meta.time, dur: 0, fp: aitem.meta.fp, bytes: abytes, kind: 'audio' });
            dbSongPut({ id: aitem.id, name: it.name, size: aitem.meta.size, time: aitem.meta.time, dur: 0, fp: aitem.meta.fp, bytes: Array.from(abytes as any), kind: 'audio' });
          }
          ok++;
          continue;
        }
        const name = it.name.replace(/\.(mid|midi|kar|rmi)$/i, '');
        const bytes = it.bytes ? new Uint8Array(it.bytes) : null;
        // 内容与名字相同的曲目不重复导入；若指定了目标歌单，则把已有曲目直接加入该歌单
        if (bytes) {
          const fp = contentFp(name, bytes);
          const existed = this.songs.find(x => {
            if (x.meta.fp && x.meta.fp === fp) return true;
            if (String(x.name || '') !== name) return false;
            const xf = fpOf(x, name);
            return !!xf && xf === fp;
          });
          if (existed) {
            if (target && target !== 'all') { imported.push(existed.id); linked++; }
            else { dup++; }
            continue;
          }
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
        await idbPut(STORE_SONGS, { id: item.id, name: it.name, size: item.meta.size, time: item.meta.time, dur: item.meta.dur, fp: item.meta.fp, bytes });
        await dbSongPut({ id: item.id, name: it.name, size: item.meta.size, time: item.meta.time, dur: item.meta.dur, fp: item.meta.fp, bytes: Array.from(bytes as any) });
        ok++;
      }
      // 批量归入目标歌单（全部曲目即全局资料库，无需额外归入）
      if ((ok > 0 || linked > 0) && imported.length) {
        const plStore = usePlaylistStore();
        if (target && target !== 'all') {
          plStore.addToPlaylist(target, imported);
        } else if (!target) {
          const active = plStore.activePlaylist;
          if (active) plStore.addToPlaylist(active.id, imported);
          else plStore.addToPlaylist('default', imported);
        }
      }
      if (ok > 0 || linked > 0) {
        if (ok > 0) {
          const last = this.songs[this.songs.length - 1];
          await this.selectSong(last.id);
        }
        let suffix = dup ? t('，跳过 ') + dup + t(' 首重复') : '';
        if (linked) suffix = t('，加入歌单 ') + linked + t(' 首已有曲目') + suffix;
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
      // 取 SQLite 与 IndexedDB 的并集，而不是"有 SQLite 就只读 SQLite"。
      // 只读一边时，任一次写入没落库（历史上迁移就把 ArrayBuffer 写成了空字节数组），
      // 那部分曲目会从界面消失，但云同步是"IndexedDB 优先 + 补 SQLite"仍看得到它们，
      // 于是界面数量与云备份数量长期对不上。这里以 SQLite 为基准，把 IndexedDB 里缺的补进来。
      const sqliteRecs = await dbSongsAll();
      const byId = new Map<string, any>();
      for (const r of sqliteRecs) if (r && r.id) byId.set(String(r.id), r);

      const backfill: any[] = [];
      // 只读主键做比对：直接 getAll() 会把整库 MIDI 字节都读进内存，几百首时开销很大
      for (const k of await idbKeys(STORE_SONGS)) {
        if (k === undefined || k === null) continue;
        const id = String(k);
        const cur = byId.get(id);
        if (cur && toBytes(cur.bytes)) continue;   // SQLite 那份已完整，无需回填
        const r = await idbGet(STORE_SONGS, k);
        if (!r || !r.id) continue;
        const merged = cur ? { ...cur, bytes: r.bytes } : r;
        byId.set(id, merged);
        // 仅在确实能从 IndexedDB 补到字节时才回写，避免对"两边都没字节"的记录反复写库
        if (toBytes(merged.bytes)) backfill.push(merged);
      }
      // 回写 SQLite：补齐缺失记录、修正空字节记录（IndexedDB 里的 ArrayBuffer 必须先归一化，
      // 否则 Array.from(ArrayBuffer) 又会写成空数组）。写完即收敛，不会每次启动都重写。
      for (const r of backfill) {
        const rb = toBytes(r.bytes)!;
        await dbSongPut({ id: r.id, name: r.name, size: r.size || 0, time: r.time || 0, dur: r.dur || 0, fp: r.fp || '', bytes: Array.from(rb) });
      }

      for (const r of byId.values()) {
        if (!r || !r.id || this.songs.some((s: any) => s.id === r.id)) continue;
        this.songs.push({
          id: r.id,
          name: String(r.name || t('未命名')).replace(/\.(mid|midi|kar|rmi)$/i, ''),
          kind: r.kind || 'midi',
          song: null,
          meta: { size: r.size || 0, time: r.time || 0, dur: r.dur || 0, fp: r.fp || '' },
          __bytes: toBytes(r.bytes),
        });
      }
      if (!this.songs.length) return;
      // 启动自愈：清理歌单/收藏中指向已不存在曲目的悬空引用（历史版本删除曲目时未同步所致）
      try {
        usePlaylistStore().pruneMissing(new Set(this.songs.map((s: any) => s.id)));
      } catch (e) {}
      let active: string | null = null;
      try { active = localStorage.getItem('fufumidi_active'); } catch (e) {}
      if (active && this.songs.some((s: any) => s.id === active)) await this.selectSong(active);
      else await this.selectSong(this.songs[this.songs.length - 1].id);
    },
    /** 云同步用：仅从内存移除曲目（DB 侧由同步逻辑负责），不触发其它副作用 */
    dropSongsLocal(ids: string[]) {
      const set = new Set(ids || []);
      if (!set.size) return;
      this.songs = this.songs.filter((s: any) => !set.has(s.id));
    },
    /** 云同步用：把 DB 中新增的曲目补进内存（保持当前选中/播放不变） */
    async mergeSongsFromDb() {
      const recs = await dbSongsAll();
      for (const r of recs) {
        if (!r || !r.id || this.songs.some((s: any) => s.id === r.id)) continue;
        this.songs.push({
          id: r.id,
          name: String(r.name || t('未命名')).replace(/\.(mid|midi|kar|rmi)$/i, ''),
          kind: r.kind || 'midi',
          song: null,
          meta: { size: r.size || 0, time: r.time || 0, dur: r.dur || 0, fp: r.fp || '' },
          __bytes: toBytes(r.bytes),
        });
      }
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
      // 同步清理歌单与收藏中的引用：否则会残留悬空 id，歌单显示数大于实际曲目数
      try {
        const plStore = usePlaylistStore();
        plStore.removeFromAllPlaylists([id]);
        const fi = plStore.favorites.indexOf(id);
        if (fi >= 0) { plStore.favorites.splice(fi, 1); plStore.persistFavs(); }
      } catch (e) {}
      if (wasCurrent) { try { localStorage.removeItem('fufumidi_active'); } catch (e) {} }
      if (this.songs.length) {
        // 优先选择当前队列中的下一首，避免跳出歌单/搜索结果
        const q = this.queueSongs;
        if (q.length) await this.selectSong(q[0].id);
        else await this.selectSong(this.songs[0].id);
      }
    },
    // 音频曲目播放元素：接入合成器效果链（EQ/空间声对音频同样生效）
    ensureAudioEl(): any {
      if (this.audioEl) return this.audioEl;
      const el = new Audio();
      el.preload = 'auto';
      try {
        const { ctx, synth } = ensureAudio();
        const src = ctx.createMediaElementSource(el);
        src.connect(synth.fxIn);
      } catch (e) {}
      try { el.volume = this.volume; } catch (e) {}
      this.audioEl = el;
      return el;
    },
    async selectSong(id: string) {
      // 切歌前保存上一首的断点（≥30s 且未播完）
      try {
        if (this.currentId && this.curSec >= 30) {
          const s0 = this.currentSong && this.currentSong.song;
          const p0 = Math.floor(this.curSec || 0);
          if (s0 && (!s0.totalSec || p0 < s0.totalSec * 0.95)) {
            const m0 = JSON.parse(localStorage.getItem('fufumidi_resume') || '{}');
            m0[this.currentId] = p0;
            localStorage.setItem('fufumidi_resume', JSON.stringify(m0));
          }
        }
      } catch (e) {}
      const item = this.songs.find((s: any) => s.id === id);
      if (!item) return;
      // 音频曲目：不经 MIDI 解析/player，改走 <audio> 元素（仍接 EQ 效果链）
      if (item.kind === 'audio') {
        const el = this.ensureAudioEl();
        try { localStorage.setItem('fufumidi_active', id); } catch (e) {}
        this.currentId = id; this.playing = false; this.curSec = 0; this.progress = 0; this.tracks = []; this.totalSec = 0;
        (async () => {
          let bytes: any = item.__bytes;
          if (!bytes) { const r = await idbGet(STORE_SONGS, id); if (r && r.bytes) { bytes = new Uint8Array(r.bytes); item.__bytes = bytes; } }
          if (!bytes) { try { const all = await dbSongsAll(); const r = all.find((x: any) => x.id === id); if (r && r.bytes) { bytes = new Uint8Array(r.bytes); item.__bytes = bytes; } } catch (e) {} }
          if (bytes) {
            try { if (this._audioUrl) URL.revokeObjectURL(this._audioUrl); } catch (e) {}
            this._audioUrl = URL.createObjectURL(new Blob([bytes]));
            el.src = this._audioUrl;
          }
          el.onended = () => { try { window.__fufumidiAutoNext(); } catch (e) {} };
        })();
        try {
          const rp = JSON.parse(localStorage.getItem('fufumidi_resume') || '{}');
          const pos = rp[id];
          if (pos && pos >= 30) { el.addEventListener('loadedmetadata', () => { try { el.currentTime = Math.min(pos, (el.duration || pos) * 0.98); } catch (e) {} }, { once: true }); this.toast(t('已恢复上次进度 ') + fmtTime(Math.floor(pos)), 'ok'); }
        } catch (e) {}
        return;
      }
      if (!item.song) {
        let lastErr = null;
        const tryParse = (bytes: any): boolean => {
          try {
            const b = toBytes(bytes);
            if (!b) throw new Error('字节为空');
            const mid = parseMidi(b);
            item.song = buildSong(mid, { name: item.name });
            item.meta.tracks = item.song.tracks.length;
            return true;
          } catch (e: any) { lastErr = e; return false; }
        };
        // 1) 内存中的字节缓冲（本会话导入时缓存）
        //    解析失败说明该缓冲损坏（如 SQLite 大文件字节数组异常），清掉避免下次再用坏缓存
        if (item.__bytes && !tryParse(item.__bytes)) item.__bytes = null;
        // 2) IndexedDB 原生字节（最可靠；形态可能是 Uint8Array 或早期版本存入的 ArrayBuffer，由 toBytes 统一）
        if (!item.song) { const r = await idbGet(STORE_SONGS, id); if (r && r.bytes) tryParse(r.bytes); }
        // 3) SQLite 字节（兜底，JSON 数字数组对较大 MIDI 可能丢失）
        if (!item.song) { const all = await dbSongsAll(); const r = all.find((x: any) => x.id === id); if (r && r.bytes) tryParse(r.bytes); }
        if (!item.song) this.toast(t('无法解析已保存的 MIDI：') + ((lastErr as any)?.message || ''), 'warn');
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
      // 断点续播：上次播放 ≥30s 且未播完 → 自动跳到上次位置
      try {
        const rp = JSON.parse(localStorage.getItem('fufumidi_resume') || '{}');
        const pos = rp[id];
        if (pos && pos >= 30 && item.song.totalSec && pos < item.song.totalSec * 0.95) {
          player.seekTick(item.song.secToTick(pos));
          this.curSec = player.currentSec();
          this.progress = Math.min(1, pos / item.song.totalSec);
          this.toast(t('已恢复上次进度 ') + fmtTime(Math.floor(pos)), 'ok');
        }
      } catch (e) {}
    },
    togglePlay() {
      // 音频曲目：走 <audio>
      if (this.isAudio) {
        const el = this.ensureAudioEl();
        if (!el.src) { this.toast(t('请先选择音频文件'), 'warn'); return; }
        ensureAudio(); // 确保 ctx/EQ 就绪（媒体源已接入效果链）
        if (this.playing) { el.pause(); this.playing = false; this.saveResumePos(); }
        else { el.play(); this.playing = true; this.trackPlay(); }
        return;
      }
      const { player } = ensureAudio();
      if (!this.currentSong) { this.toast(t('请先导入一首 MIDI'), 'warn'); return; }
      if (this.playing) {
        player.pause();
        this.playing = false;
        this.saveResumePos(); // 暂停即记录断点
      } else {
        player.play();
        this.playing = true;
        this.trackPlay(); // 播放统计
      }
    },
    stopPlay() {
      if (this.isAudio && this.audioEl) { this.audioEl.pause(); this.audioEl.currentTime = 0; this.playing = false; this.curSec = 0; this.progress = 0; this.clearResumePos(this.currentId); return; }
      const { player } = ensureAudio();
      player.stop();
      this.playing = false;
      this.curSec = 0;
      this.progress = 0;
      try { if (this.currentId) this.clearResumePos(this.currentId); } catch (e) {} // 手动停止 = 下次从头播
    },
    /* ---------------- 播放模式（顺序/随机/单曲循环/列表循环） ---------------- */
    cyclePlayMode() {
      const seq = ['order', 'shuffle', 'repeatOne', 'loopAll'];
      const i = seq.indexOf(this.playMode);
      this.playMode = seq[(i + 1) % seq.length] || 'order';
      try { localStorage.setItem('fufumidi_playmode', this.playMode); } catch (e) {}
      const label: Record<string, string> = { order: '顺序播放', shuffle: '随机播放', repeatOne: '单曲循环', loopAll: '列表循环' };
      this.toast(t(label[this.playMode] || this.playMode), 'ok');
    },
    // 按模式计算下一首目标 id；dir: 1 下一首 / -1 上一首；返回 null 表示维持当前（单曲循环）或无处可去
    pickNeighborId(dir: number): string | null {
      const q = this.queueSongs;
      if (!q.length) return null;
      const cur = this.currentId;
      const idx = q.findIndex((s: any) => s.id === cur);
      if (this.playMode === 'shuffle') {
        if (q.length === 1) return q[0].id;
        let r: any;
        do { r = q[Math.floor(Math.random() * q.length)]; } while (r.id === cur && q.length > 1);
        return r.id;
      }
      if (this.playMode === 'repeatOne' && dir === 1) return cur || q[0].id;
      if (idx < 0) return dir > 0 ? q[0].id : q[q.length - 1].id;
      let ni = idx + dir;
      if (ni < 0) ni = this.playMode === 'loopAll' ? q.length - 1 : 0;
      if (ni >= q.length) ni = this.playMode === 'loopAll' ? 0 : q.length - 1;
      return q[ni].id;
    },
    // 载入并播放指定曲目（上一首/下一首/自动切歌共用）
    async playSongById(id: string) {
      await this.selectSong(id);
      const { player } = ensureAudio();
      player.play();
      this.playing = true;
      this.preloadNext();
      try { // 播放统计（最近/最常播放）
        if (id) {
          const st = JSON.parse(localStorage.getItem('fufumidi_stats') || '{}');
          const e = st[id] || { c: 0, last: 0 };
          st[id] = { c: (e.c || 0) + 1, last: Date.now() };
          localStorage.setItem('fufumidi_stats', JSON.stringify(st));
        }
      } catch (e) {}
    },
    // 无缝播放：播放期间按当前模式预解析下一首，自动切歌时无需再等 parseMidi
    preloadNext() {
      try {
        if (this.playMode === 'shuffle') return;
        const nid = this.pickNeighborId(1);
        if (!nid || nid === this.currentId) return;
        const item = this.songs.find((s: any) => s.id === nid);
        if (!item || item.song || item.kind === 'audio' || _preloading.has(nid)) return;
        _preloading.add(nid);
        (async () => {
          try {
            let bytes: any = item.__bytes;
            if (!bytes) { const r = await idbGet(STORE_SONGS, nid); if (r && r.bytes) bytes = r.bytes; }
            if (bytes && !item.song) {
              try {
                const b = toBytes(bytes);
                if (!b) throw new Error('字节为空');
                item.song = buildSong(parseMidi(b), { name: item.name });
                item.meta.tracks = item.song.tracks.length;
              } catch (e) { item.__bytes = null; }
            }
          } catch (e) {} finally { _preloading.delete(nid); }
        })();
      } catch (e) {}
    },
    trackPlay() {
      const id = this.currentId; if (!id) return;
      try {
        const st = JSON.parse(localStorage.getItem('fufumidi_stats') || '{}');
        const e = st[id] || { c: 0, last: 0 };
        st[id] = { c: (e.c || 0) + 1, last: Date.now() };
        localStorage.setItem('fufumidi_stats', JSON.stringify(st));
      } catch (e) {}
    },
    skip(dir: number) {
      const id = this.pickNeighborId(dir);
      if (id) this.playSongById(id);
      else if (dir < 0) { const { player } = ensureAudio(); player.seekTick(0); }
    },
    // 曲终自动处理：按播放模式决定「下一首 / 重播 / 停止」
    async handleTrackEnd() {
      const q = this.queueSongs;
      const mode = this.playMode;
      if (mode === 'repeatOne') { await this.playSongById(this.currentId); return; }
      const idx = q.findIndex((s: any) => s.id === this.currentId);
      if (mode === 'shuffle') {
        if (q.length === 1) { await this.playSongById(q[0].id); return; }
        let r: any;
        do { r = q[Math.floor(Math.random() * q.length)]; } while (r.id === this.currentId && q.length > 1);
        await this.playSongById(r.id);
        return;
      }
      const ni = idx + 1;
      if (ni >= 0 && ni < q.length) { await this.playSongById(q[ni].id); return; }
      if (mode === 'loopAll' && q.length) { await this.playSongById(q[0].id); return; }
      // 顺序播完：复位
      this.playing = false;
      this.curSec = 0;
      this.progress = 0;
      try { if (this.currentId) this.clearResumePos(this.currentId); } catch (e) {}
    },
    /* ---------------- 断点续播 / 书签 / 睡眠定时 ---------------- */
    resumeMap(): Record<string, number> { try { return JSON.parse(localStorage.getItem('fufumidi_resume') || '{}'); } catch (e) { return {}; } },
    // 保存当前曲目播放位置（≥30s 且未播完时记录）
    saveResumePos() {
      if (!this.currentId) return;
      const pos = Math.floor(this.curSec || 0);
      const s = this.currentSong && this.currentSong.song;
      if (!s || pos < 30 || (s.totalSec && pos > s.totalSec * 0.95)) { this.clearResumePos(this.currentId); return; }
      try { const m = this.resumeMap(); m[this.currentId] = pos; localStorage.setItem('fufumidi_resume', JSON.stringify(m)); } catch (e) {}
    },
    clearResumePos(id: string) { try { const m = this.resumeMap(); if (m[id]) { delete m[id]; localStorage.setItem('fufumidi_resume', JSON.stringify(m)); } } catch (e) {} },
    bookmarksFor(): any[] {
      try { const m = JSON.parse(localStorage.getItem('fufumidi_bookmarks') || '{}'); return Array.isArray(m[this.currentId]) ? m[this.currentId] : []; } catch (e) { return []; }
    },
    addBookmark(label?: string) {
      if (!this.currentId) { this.toast(t('请先播放一首 MIDI'), 'warn'); return; }
      const pos = Math.floor(this.curSec || 0);
      try {
        const m = JSON.parse(localStorage.getItem('fufumidi_bookmarks') || '{}');
        const arr = Array.isArray(m[this.currentId]) ? m[this.currentId] : [];
        arr.push({ t: pos, label: label || fmtTime(pos) });
        m[this.currentId] = arr;
        localStorage.setItem('fufumidi_bookmarks', JSON.stringify(m));
        this.toast(t('已添加书签 ') + fmtTime(pos), 'ok');
      } catch (e) {}
    },
    removeBookmark(idx: number) {
      try {
        const m = JSON.parse(localStorage.getItem('fufumidi_bookmarks') || '{}');
        const arr = m[this.currentId] || [];
        arr.splice(idx, 1);
        m[this.currentId] = arr;
        localStorage.setItem('fufumidi_bookmarks', JSON.stringify(m));
      } catch (e) {}
    },
    setSleep(min: number) {
      if (this.sleepTimer) { clearInterval(this.sleepTimer); this.sleepTimer = null; }
      if (!min) { this.sleepUntil = 0; this.setVolume(this.volume); try { window.__fufumidiSleepFade = false; } catch (e) {} this.toast(t('已取消睡眠定时'), 'ok'); return; }
      this.sleepUntil = Date.now() + min * 60000;
      this.toast(t('睡眠定时：') + min + t(' 分钟后停止播放'), 'ok');
      this.sleepTimer = setInterval(() => {
        const left = this.sleepUntil - Date.now();
        if (left <= 0) {
          clearInterval(this.sleepTimer); this.sleepTimer = null; this.sleepUntil = 0;
          try { window.__fufumidiSleepFade = false; } catch (e) {}
          try { const { player } = ensureAudio(); player.pause(); } catch (e) {}
          try { if (this.isAudio && this.audioEl) this.audioEl.pause(); } catch (e) {} // 音频曲目同样停止
          this.playing = false;
          this.setVolume(this.volume);
          this.toast(t('睡眠定时到，已停止播放'), 'ok');
          return;
        }
        // 最后 15 秒线性淡出（标记睡眠淡出，避免与曲尾淡出叠加）
        if (left < 15000) { try { window.__fufumidiSleepFade = true; } catch (e) {} this.setVolume(Math.max(0.02, this.volume * (left / 10000))); }
        else { try { window.__fufumidiSleepFade = false; } catch (e) {} this.setVolume(this.volume); }
      }, 500);
    },
    jumpBookmarkSec(sec: number) {
      if (!this.currentSong || !this.currentSong.song) return;
      const s = this.currentSong.song;
      const r = Math.max(0, Math.min(1, sec / (s.totalSec || 1)));
      this.seekRatio(r);
    },
    /* ---------------- 曲目标签与封面（存 localStorage，不改动 MIDI 文件） ---------------- */
    tagsMap(): Record<string, any> { try { return JSON.parse(localStorage.getItem('fufumidi_tags') || '{}'); } catch (e) { return {}; } },
    songTags(id?: string) { const m = this.tagsMap(); return (id && m[id]) || {}; },
    setSongTags(id: string, patch: any) {
      try {
        const m = this.tagsMap();
        m[id] = Object.assign(m[id] || {}, patch);
        localStorage.setItem('fufumidi_tags', JSON.stringify(m));
      } catch (e) {}
    },
    async editTags(id: string) {
      const s = this.songs.find((x: any) => x.id === id);
      if (!s) return;
      const t0 = this.songTags(id);
      const artist = await this.promptDialog({ title: t('艺术家'), value: t0.artist || '' });
      if (artist === null) return;
      const album = await this.promptDialog({ title: t('专辑'), value: t0.album || '' });
      if (album === null) return;
      const genre = await this.promptDialog({ title: t('流派'), value: t0.genre || '' });
      if (genre === null) return;
      this.setSongTags(id, { artist: artist.trim(), album: album.trim(), genre: genre.trim() });
      let cover = t0.cover || '';
      const wantCover = await this.confirmDialog({ title: t('专辑封面'), msg: t('是否为这首歌设置封面图片？'), okText: t('选择图片'), cancelText: t('跳过') });
      if (wantCover && bridge && bridge.pickCover) {
        const r = await bridge.pickCover();
        if (r && r.ok && r.dataUrl) cover = r.dataUrl;
      }
      this.setSongTags(id, { cover });
      this.toast(t('标签已保存'), 'ok');
    },
    seekRatio(r: number) {
      // 音频曲目：直接设置 currentTime
      if (this.isAudio && this.audioEl) {
        const d = this.audioEl.duration || 0;
        if (d) this.audioEl.currentTime = Math.max(0, Math.min(d * 0.999, r * d));
        this.curSec = this.audioEl.currentTime; this.progress = r;
        return;
      }
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
      try { window.__fufumidiBaseVol = this.volume; } catch (e) {}
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
      if (v !== this.view && this.playing) {
        // 播放中切页：预排最多 2s 音频再切入。目标视图的同步初始化（乐谱渲染、
        // 可视化挂载等）可能阻塞主线程数百毫秒~1s+，远超 0.18s 预排窗口，此前
        // 会出现断流卡顿；预排音符由 Web Audio 渲染线程发声，不受阻塞影响。
        try { const { player } = ensureAudio(); player.bumpAhead(); } catch (e) {}
      }
      this.view = viewParentOf(v);
      // v 为旧子视图 id（play/lyrics/edit/viz/analyze/score/transcribe/convert）时，
      // tab 应为该子视图 id 本身；OLD_VIEW_TO_PARENT 的值是父视图名，不能当 tab 用
      const tab = OLD_VIEW_TO_PARENT[v] ? v : '';
      this.syncHash(tab);
    },
    setSidebarWidth(w: number) {
      const v = Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, w)));
      this.sidebarWidth = v;
      try { localStorage.setItem('fufumidi_sidebar_w', String(v)); } catch (e) {}
    },
    syncHash(tab = '') {
      if (typeof location === 'undefined') return;
      const target = '#/' + this.view + (tab ? '?tab=' + encodeURIComponent(tab) : '');
      if (location.hash !== target) {
        try { location.hash = target; } catch (e) {}
      }
    },
    startTickLoop() {
      if (_raf) return;
      let last = 0;
      const tick = () => {
        // 播放进度以 ~30fps 节流写入响应式状态：原来 60fps 逐帧写 reactive 会让所有依赖
        // 组件（播放栏时间/进度条等）每帧重算，是播放时主线程持续占用、切界面卡顿的
        // 主因之一。30fps 对进度显示无视觉差别，响应式开销减半。逐帧平滑动画的视图
        // （可视化/歌词/卷帘）各自有独立绘制循环直接读 player，不受影响。
        const now = performance.now();
        if (this.playing && !document.hidden && now - last >= 33) {
          last = now;
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

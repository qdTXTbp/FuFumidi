// 全局状态 store（Vue reactive）——播放、歌单、混音、UI
import { reactive, computed } from 'vue';
import { ensureAudio } from './audio.js';
import { parseMidi, buildSong } from './core/midi.js';
import { TRACK_COLORS, fmtTime } from './core/util.js';
import { usePlaylistStore } from './stores/playlist';

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
];

// 已迁移到 Vue 的视图（其余走占位页）
export const MIGRATED_VIEWS = ['home', 'play', 'analyze', 'viz', 'score', 'lyrics', 'convert', 'transcribe', 'edit'];

export const state = reactive({
  view: 'play',
  sidebarOpen: true,
  playerbarOpen: true,

  // 歌单（多个播放列表 / 批量管理）
  playlists: [],
  activePlaylistId: 'default',
  playlistSearch: '',
  playlistSort: 'added',
  playlistFavOnly: false,

  // 歌单
  songs: [],
  currentId: null,

  // 播放状态
  playing: false,
  curSec: 0,
  totalSec: 0,
  progress: 0,
  tempo: 1,
  loop: false,
  metro: false,
  volume: 0.85,

  // 轨道混音
  tracks: [],

  // UI
  toast: '',
  confirm: null,
  fileBusy: false,
  // 全局系统功能（设置面板 / 主题库 / 命令面板 / 新手引导）
  ui: {
    settingsOpen: false,
    settingsTab: 'appearance',
    themesOpen: false,
    guideOpen: false,
    paletteOpen: false,
  },
  // 完整性检验结果（App 挂载时后台检查；设置面板展示警告条）
  integrity: null, // { ok, issues: [], error } | null
});

/* ---------------- 歌单持久化初始化 ---------------- */
const PL_LS = 'fufumidi_playlists_v1';
const PL_ACTIVE_LS = 'fufumidi_active_playlist';
function _loadPlaylists() {
  try {
    const raw = localStorage.getItem(PL_LS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) { state.playlists = arr; return; }
    }
  } catch (e) {}
  state.playlists = [{ id: 'default', name: '默认歌单', songIds: [] }];
}
_loadPlaylists();
try {
  const a = localStorage.getItem(PL_ACTIVE_LS);
  if (a && state.playlists.some(p => p.id === a)) state.activePlaylistId = a;
} catch (e) {}

function persistPlaylists() {
  try { localStorage.setItem(PL_LS, JSON.stringify(state.playlists)); } catch (e) {}
  try { localStorage.setItem(PL_ACTIVE_LS, state.activePlaylistId); } catch (e) {}
}
export function createPlaylist(name) {
  const id = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.playlists.push({ id, name: name || '未命名歌单', songIds: [] });
  state.activePlaylistId = id;
  persistPlaylists();
  return id;
}
export function selectPlaylist(id) {
  if (id === 'favorites') { state.activePlaylistId = 'favorites'; persistPlaylists(); return; }
  if (state.playlists.some(p => p.id === id)) { state.activePlaylistId = id; persistPlaylists(); }
}
export function deletePlaylist(id) {
  if (id === 'favorites') return { ok: false, error: '收藏不能删除' };
  if (state.playlists.length <= 1) {
    const def = state.playlists[0];
    def.songIds = [];
    state.activePlaylistId = def.id;
    persistPlaylists();
    return { ok: true, cleared: true };
  }
  const i = state.playlists.findIndex(p => p.id === id);
  if (i < 0) return { ok: false };
  state.playlists.splice(i, 1);
  if (state.activePlaylistId === id) state.activePlaylistId = state.playlists[0].id;
  persistPlaylists();
  return { ok: true };
}
export function addSongsToActivePlaylist(ids) {
  const pid = state.activePlaylistId;
  const list = state.playlists.find(p => p.id === pid);
  if (!list) return;
  for (const id of ids) {
    if (id && !list.songIds.includes(id)) list.songIds.push(id);
  }
  persistPlaylists();
}
export function removeSongsFromPlaylist(ids) {
  const idSet = new Set(ids || []);
  for (const p of state.playlists) p.songIds = p.songIds.filter(id => !idSet.has(id));
  persistPlaylists();
}
export function removeSongsFromActivePlaylist(ids) {
  const idSet = new Set(ids || []);
  const list = state.playlists.find(p => p.id === state.activePlaylistId);
  if (list) {
    list.songIds = list.songIds.filter(id => !idSet.has(id));
    persistPlaylists();
  }
}
export function moveActivePlaylistSong(dragId, targetId, before) {
  const list = state.playlists.find(p => p.id === state.activePlaylistId);
  if (!list) return;
  const ids = list.songIds;
  const fi = ids.indexOf(dragId), ti = ids.indexOf(targetId);
  if (fi < 0 || ti < 0 || fi === ti) return;
  ids.splice(fi, 1);
  const t = ids.indexOf(targetId);
  ids.splice(before ? t : t + 1, 0, dragId);
  persistPlaylists();
}
export function removeSongsFromLibrary(ids) {
  for (const id of ids || []) removeSong(id);
  removeSongsFromPlaylist(ids);
}

export const currentSong = computed(() =>
  state.songs.find(s => s.id === state.currentId) || null
);

export const totalStr = computed(() => fmtTime(state.totalSec));
export const curStr = computed(() => fmtTime(state.curSec));

let _toastTimer = null;
export function toast(msg, type = 'info') {
  state.toast = { msg, type };
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => (state.toast = ''), 2800);
}

/* ---------------- 歌单持久化（IndexedDB 存原始 MIDI 字节，刷新不丢） ---------------- */
const DB_NAME = 'fufumidi-db', DB_VER = 1, STORE_SONGS = 'songs';
let _dbP = null;
function openDb() {
  if (_dbP) return _dbP;
  _dbP = new Promise((res) => {
    let req;
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
async function idbAll(store) {
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
async function idbGet(store, id) {
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
async function idbPut(store, val) {
  const db = await openDb();
  return new Promise((res) => {
    if (!db) return res(false);
    try {
      const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val);
      tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false);
    } catch (e) { res(false); }
  });
}
async function idbDelete(store, id) {
  const db = await openDb();
  return new Promise((res) => {
    if (!db) return res(false);
    try {
      const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id);
      tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false);
    } catch (e) { res(false); }
  });
}

/* ---------------- 导入 ---------------- */
export async function importFiles(items) {
  // items: [{name, bytes(Uint8Array)}]
  let ok = 0;
  for (const it of items) {
    let mid;
    try { mid = parseMidi(it.bytes); } catch (e) { toast('无法解析 ' + it.name + '：' + e.message, 'warn'); continue; }
    const song = buildSong(mid, { name: it.name.replace(/\.(mid|midi|kar|rmi)$/i, '') });
    const item = {
      id: cryptoId(),
      name: song.name,
      song,
      meta: { size: it.bytes.byteLength, time: Date.now(), tracks: song.tracks.length },
    };
    state.songs.push(item);
    // 加入当前歌单（通过 Pinia 歌单 store，收藏视图时加入默认歌单）
    try {
      const plStore = usePlaylistStore();
      plStore.addSongs([item.id]);
    } catch (e) {}
    // 原始字节写入 IndexedDB，刷新后仍可恢复
    await idbPut(STORE_SONGS, { id: item.id, name: it.name, size: item.meta.size, time: item.meta.time, bytes: it.bytes });
    ok++;
  }
  if (ok > 0) {
    const last = state.songs[state.songs.length - 1];
    await selectSong(last.id);
    toast(`已导入 ${ok} 首 MIDI`);
  } else if (items.length) {
    toast('没有可导入的 MIDI 文件', 'warn');
  }
}

/* 启动时从 IndexedDB 恢复歌单（仅元数据，音符数据在选中时懒加载解析） */
export async function restoreSongs() {
  const recs = await idbAll(STORE_SONGS);
  for (const r of recs) {
    if (!r || !r.id || state.songs.some(s => s.id === r.id)) continue;
    state.songs.push({
      id: r.id,
      name: String(r.name || '未命名').replace(/\.(mid|midi|kar|rmi)$/i, ''),
      song: null,
      meta: { size: r.size || 0, time: r.time || 0 },
    });
  }
  if (!state.songs.length) return;
  let active = null;
  try { active = localStorage.getItem('fufumidi_active'); } catch (e) {}
  if (active && state.songs.some(s => s.id === active)) await selectSong(active);
  else await selectSong(state.songs[state.songs.length - 1].id);
}

export async function removeSong(id) {
  const i = state.songs.findIndex(s => s.id === id);
  if (i < 0) return;
  const wasCurrent = state.currentId === id;
  const { player } = ensureAudio();
  if (wasCurrent) { player.stop(); state.playing = false; state.currentId = null; state.tracks = []; }
  state.songs.splice(i, 1);
  await idbDelete(STORE_SONGS, id);
  if (wasCurrent) { try { localStorage.removeItem('fufumidi_active'); } catch (e) {} }
  if (state.songs.length) await selectSong(state.songs[0].id);
}

/* ---------------- 播放控制 ---------------- */
export async function selectSong(id) {
  const item = state.songs.find(s => s.id === id);
  if (!item) return;
  if (!item.song) {
    // 从 IndexedDB 读取原始字节并解析（刷新恢复时懒加载）
    const rec = await idbGet(STORE_SONGS, id);
    if (rec && rec.bytes) {
      try {
        const mid = parseMidi(rec.bytes);
        item.song = buildSong(mid, { name: item.name });
        item.meta.tracks = item.song.tracks.length;
      } catch (e) {
        toast('无法解析已保存的 MIDI：' + e.message, 'warn');
      }
    }
  }
  if (!item.song) return;
  try { localStorage.setItem('fufumidi_active', id); } catch (e) {}
  const { player } = ensureAudio();
  player.stop();
  state.currentId = id;
  state.playing = false;
  state.curSec = 0;
  state.progress = 0;
  player.load(item.song);
  player.setScale(state.tempo);
  player.setLoop(state.loop, 0, item.song.totalTicks);
  player.setMetronome(state.metro);
  state.totalSec = item.song.totalSec;
  state.tracks = item.song.tracks.map((tr, i) => ({
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
}

export function togglePlay() {
  const { player } = ensureAudio();
  if (!currentSong.value) { toast('请先导入一首 MIDI', 'warn'); return; }
  if (state.playing) {
    player.pause();
    state.playing = false;
  } else {
    player.play();
    state.playing = true;
  }
}

export function stopPlay() {
  const { player } = ensureAudio();
  player.stop();
  state.playing = false;
  state.curSec = 0;
  state.progress = 0;
}

export function seekRatio(r) {
  const s = currentSong.value && currentSong.value.song;
  if (!s) return;
  const { player } = ensureAudio();
  // 直接按基础秒数换算 tick，避免受变速倍率影响
  r = Math.max(0, Math.min(1, r));
  player.seekTick(s.secToTick(r * s.totalSec));
  // 暂停时也立即刷新进度显示（rAF 仅在播放中同步）
  state.curSec = player.currentSec();
  state.progress = r;
}

export function setTempo(v) {
  state.tempo = Math.max(0.25, Math.min(4, v));
  const { player } = ensureAudio();
  if (currentSong.value) player.setScale(state.tempo);
}

export function toggleLoop() {
  state.loop = !state.loop;
  const s = currentSong.value && currentSong.value.song;
  const { player } = ensureAudio();
  if (s) player.setLoop(state.loop, 0, s.totalTicks);
}

export function toggleMetro() {
  state.metro = !state.metro;
  const { player } = ensureAudio();
  player.setMetronome(state.metro);
}

export function setVolume(v) {
  state.volume = Math.max(0, Math.min(1, v));
  const { player } = ensureAudio();
  player.syn.setVolume(state.volume);
}

/* ---------------- 轨道混音 ---------------- */
export function setTrackVol(i, v) {
  if (!state.tracks[i]) return;
  state.tracks[i].vol = v;
  const { player } = ensureAudio();
  player.syn.setTrackVol(i, v);
}
export function toggleTrackMute(i) {
  if (!state.tracks[i]) return;
  state.tracks[i].mute = !state.tracks[i].mute;
  const { player } = ensureAudio();
  player.syn.setTrackMute(i, state.tracks[i].mute);
}
export function toggleTrackSolo(i) {
  if (!state.tracks[i]) return;
  state.tracks[i].solo = !state.tracks[i].solo;
  const { player } = ensureAudio();
  player.syn.setTrackSolo(i, state.tracks[i].solo);
}
export function setTrackPan(i, v) {
  if (!state.tracks[i]) return;
  state.tracks[i].pan = v;
  const { player } = ensureAudio();
  player.syn.setTrackPan(i, v);
}

/* ---------------- 工具 ---------------- */
// 视图切换：同步到 URL hash（#/view），刷新/回退后不丢当前页面
export function setView(v) {
  state.view = VIEWS.some(x => x.id === v) ? v : 'home';
  syncHash();
}
function syncHash() {
  if (typeof location === 'undefined') return;
  const target = '#/' + state.view;
  if (location.hash !== target) {
    try { history.replaceState(null, '', target); } catch (e) { location.hash = target; }
  }
}
function applyHash() {
  if (typeof location === 'undefined') return;
  const h = (location.hash || '').replace(/^#\/?/, '');
  if (h && VIEWS.some(x => x.id === h) && state.view !== h) state.view = h;
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', applyHash);
  applyHash(); // 启动时从 URL hash 恢复当前视图
}

function cryptoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* rAF 播放指针同步（由 App 挂载时启动） */
let _raf = null;
export function startTickLoop() {
  if (_raf) return;
  const tick = () => {
    if (state.playing) {
      const { player } = ensureAudio();
      const s = currentSong.value && currentSong.value.song;
      if (player && s) {
        state.curSec = player.currentSec();
        // 用 tick 比例计算进度（不受变速倍率影响）
        state.progress = s.totalTicks ? player.currentTick() / s.totalTicks : 0;
      }
    }
    _raf = requestAnimationFrame(tick);
  };
  _raf = requestAnimationFrame(tick);
}
export function stopTickLoop() {
  if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
}

// 供 audio.js 回调：播放结束复位 UI
if (typeof window !== 'undefined') {
  window.__fufumidiOnEnd = () => {
    state.playing = false;
    state.curSec = 0;
    state.progress = 0;
  };
}

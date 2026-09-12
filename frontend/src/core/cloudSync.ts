// ============================================================
// 云同步核心（渲染层）：账号 + 歌单/曲目双向同步
//
// 设计要点（跨端对齐）：
// - 稳定标识统一用「文件名（含扩展名）」，与手机端曲库一致；
//   电脑端本地仍用自己的随机 id，两者通过文件名映射。
// - 曲目字节：电脑端 SQLite 里存的是 bytes(number[])，传输用 base64。
// - 删除：本地删除后下次同步上报墓碑(deleted)，从而传播到其他设备。
// - 冲突：登录时本机与云端都有存档 -> 交给界面选择保留哪一侧。
// ============================================================

// 主用自定义域名（国内可直连），失败自动回退 workers.dev 兜底
const BASES = [
  'https://fusync.de5.net',
  'https://fufumidi-cloud-sync.fumivoice.workers.dev',
];
let activeBase: string = BASES[0] || '';

const ACC_KEY = 'cloud_account';
const DEV_KEY = 'cloud_device_id';
const LINKED_KEY = 'cloud_linked_users';
const KNOWN_SONGS_KEY = 'cloud_known_songs';
const KNOWN_PLAYLISTS_KEY = 'cloud_known_playlists';
const PL_STATE_KEY = 'cloud_playlist_state';

const MIDI_RE = /\.(mid|midi|kar|rmi|smf)$/i;
// 每批搬运的曲目数：与后端 MAX_BATCH 保持一致，避免单个请求/响应过大
const BATCH = 6;
// 单次请求超时：没有超时时，请求一旦挂起就会永远停在「同步中」，用户无法判断是慢还是卡死
const REQ_TIMEOUT_MS = 60000;

/* ---------------- 同步进度（供界面显示） ---------------- */
export interface SyncProgress {
  /** prepare=读本地/比对，upload=上传字节，download=下载字节，playlist=写歌单，done=完成 */
  phase: 'prepare' | 'upload' | 'download' | 'playlist' | 'done';
  text: string;
  done?: number;
  total?: number;
}
let _onProgress: ((p: SyncProgress) => void) | null = null;
/** 注册进度回调（同步结束后传 null 注销） */
export function setSyncProgressHandler(fn: ((p: SyncProgress) => void) | null) { _onProgress = fn; }
function report(phase: SyncProgress['phase'], text: string, done?: number, total?: number) {
  try { _onProgress?.({ phase, text, done, total }); } catch (e) {}
}

function br(): any { return (window as any).fuBridge; }

function cryptoId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------- base64 <-> 字节 ---------------- */
function bytesToB64(src: any): string {
  if (!src) return '';
  const arr: number[] = Array.isArray(src) ? src : Array.from(src as Uint8Array);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    s += String.fromCharCode.apply(null, arr.slice(i, i + chunk) as any);
  }
  return btoa(s);
}
function b64ToBytes(b64: string): number[] {
  if (!b64) return [];
  const bin = atob(b64);
  const out = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- HTTP（主域名 + 回退） ---------------- */
function hostOf(base: string): string {
  return base.replace(/^https?:\/\//, '');
}
/** 取响应片段用于报错：折叠空白并截断，避免把整页 HTML 塞进提示 */
function snippet(text: string): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '空响应';
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

async function httpJson(path: string, opts: { method?: string; token?: string; body?: any } = {}): Promise<any> {
  const { method = 'GET', token, body } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const candidates = [activeBase, ...BASES.filter((b) => b !== activeBase)];
  const failures: string[] = [];
  for (const base of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(base + path, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }

      if (!data) {
        // 非 JSON：多为网关错误页 / WAF 挑战页 / 运营商劫持页（状态码可能是 200），
        // 也可能来自 Worker 超限（Error 1102）。这类失败源于链路而非业务，
        // 换备用域名重试往往能通；把所有尝试理由汇总报出，便于定位真正原因。
        failures.push(`${hostOf(base)}（HTTP ${res.status} 非 JSON 响应：${snippet(text)}）`);
        continue;
      }
      if (data.ok === false) {
        // 服务端明确给出的业务错误（未登录、密码错误、人机验证失败…）：换域名结果一样，直接抛出
        const err: any = new Error(data.error || `HTTP ${res.status}`);
        err.business = true;
        throw err;
      }
      if (!res.ok) {
        failures.push(`${hostOf(base)}（HTTP ${res.status}：${snippet(text)}）`);
        continue;
      }
      activeBase = base;
      return data;
    } catch (e: any) {
      if (e && e.business) throw e;
      failures.push(`${hostOf(base)}（${(e && e.message) || '连接失败'}）`);
    }
  }
  throw new Error('无法连接云服务，已尝试：' + failures.join('；'));
}

/* ---------------- 本地数据读取 ---------------- */
interface LocalSong {
  id: string; name: string; size?: number; time?: number; dur?: number; fp?: string; bytes?: number[]; kind?: string;
}

async function localSongs(): Promise<LocalSong[]> {
  // 优先 IndexedDB（曲库真实来源），再补上 SQLite 中不在 IDB 的记录。
  // 只读 SQLite 会让云同步认为本机没有任何曲目（实测该库长期为空），电脑端因此永远传不上去。
  const out: LocalSong[] = [];
  const seen = new Set<string>();
  for (const r of (await idbSongs()).values()) {
    seen.add(r.id);
    out.push(r as LocalSong);
  }
  const b = br();
  if (!b || typeof b.dbSongsList !== 'function') return out;
  try {
    const arr = await b.dbSongsList();
    for (const s of (Array.isArray(arr) ? arr : [])) {
      if (!s || !s.id || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  } catch (e) {}
  return out;
}
async function localPlaylists(): Promise<any[]> {
  // 歌单的真实来源是渲染层 localStorage（见 stores/playlist.ts 的 persist()），
  // SQLite 只是备份来源。此前只读 SQLite，一旦它尚未回填就会上传空歌单，
  // 导致云端 playlists 长期为空、手机端看不到歌单结构。
  try {
    const raw = localStorage.getItem('fufumidi_playlists_v1');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch (e) {}
  const b = br();
  if (!b || typeof b.dbPlaylistsList !== 'function') return [];
  try { const arr = await b.dbPlaylistsList(); return Array.isArray(arr) ? arr : []; } catch (e) { return []; }
}

/** 归一化字节来源：SQLite 里可能是 number[]，IndexedDB 里是 Uint8Array */
function pickBytes(v: any): Uint8Array | null {
  if (!v) return null;
  if (v instanceof Uint8Array) return v.length ? v : null;
  if (Array.isArray(v)) return v.length ? new Uint8Array(v) : null;
  return null;
}

interface IdbSong {
  id: string; name: string; size?: number; time?: number; dur?: number; fp?: string; bytes?: Uint8Array;
}

/**
 * 曲库的真实来源：IndexedDB `fufumidi-db` / `songs`。
 * 导入时文件名与原始字节都写在这里，界面启动也是从这里恢复曲库
 * （见 store.js 的 restoreSongs）；SQLite 只是备份副本，可能长期为空。
 * 因此「本地有哪些曲目、有没有字节」必须以它为准。
 */
function idbSongs(): Promise<Map<string, IdbSong>> {
  return new Promise((resolve) => {
    const out = new Map<string, IdbSong>();
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open('fufumidi-db', 1); } catch (e) { return resolve(out); }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      try {
        const rq = db.transaction('songs', 'readonly').objectStore('songs').getAll();
        rq.onsuccess = () => {
          for (const r of rq.result || []) {
            if (!r || !r.id) continue;
            out.set(String(r.id), {
              id: String(r.id),
              name: String(r.name || ''),
              size: Number(r.size) || 0,
              time: Number(r.time) || 0,
              dur: Number(r.dur) || 0,
              fp: r.fp || '',
              bytes: pickBytes(r.bytes) || undefined,
            });
          }
          resolve(out);
        };
        rq.onerror = () => resolve(out);
      } catch (e) { resolve(out); }
    };
    req.onerror = () => resolve(out);
    req.onblocked = () => resolve(out);
  });
}

/** 从 IndexedDB 删除曲目记录：IDB 是曲库真实来源，删除必须同步到这里，否则下次同步会把它复活 */
function idbDeleteSongs(ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open('fufumidi-db', 1); } catch (e) { return resolve(); }
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('songs', 'readwrite');
        const store = tx.objectStore('songs');
        for (const id of ids) store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch (e) { resolve(); }
    };
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/** 写入 IndexedDB：下载回来的曲目也要进曲库真实来源，否则重启后列表里看不到 */
function idbPutSongs(rows: any[]): Promise<void> {
  if (!rows.length) return Promise.resolve();
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open('fufumidi-db', 1); } catch (e) { return resolve(); }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('songs', 'readwrite');
        const store = tx.objectStore('songs');
        for (const r of rows) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch (e) { resolve(); }
    };
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function kvGet(key: string): Promise<any> {
  const b = br();
  if (!b || typeof b.dbKvGet !== 'function') return Promise.resolve(null);
  return b.dbKvGet(key).catch(() => null);
}
function kvSet(key: string, value: any): Promise<any> {
  const b = br();
  if (!b || typeof b.dbKvSet !== 'function') return Promise.resolve(false);
  return b.dbKvSet(key, value).catch(() => false);
}

async function deviceId(): Promise<string> {
  let d = await kvGet(DEV_KEY);
  if (!d) { d = cryptoId() + cryptoId(); await kvSet(DEV_KEY, d); }
  return d;
}

/** 归一化云曲目标识：文件名（无扩展名时补 .mid） */
function cloudKeyOf(name: string): string {
  const n = String(name || '').trim();
  if (!n) return '';
  return /\.[a-z0-9]+$/i.test(n) ? n : `${n}.mid`;
}

/* ---------------- 账号 ---------------- */
export async function getAccount(): Promise<{ email: string; userId: string; token: string } | null> {
  return (await kvGet(ACC_KEY)) || null;
}
async function setAccount(a: any) { await kvSet(ACC_KEY, a); }

export async function cloudStatus() {
  const acc = await getAccount();
  return { ok: true, account: acc ? { email: acc.email, userId: acc.userId } : null };
}

/** 云同步曲目的落盘目录（与本地曲库分开），供界面展示 */
export async function cloudSongsDir(): Promise<string> {
  const b = br();
  if (!b || typeof b.dbCloudSongDir !== 'function') return '';
  try { return String(await b.dbCloudSongDir()) || ''; } catch (e) { return ''; }
}

export interface CloudSyncOutcome {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  localN?: number;
  cloudN?: number;
  uploadedSongs?: number;
  downloadedSongs?: number;
  uploadedPlaylists?: number;
  appliedSongs?: number;
  appliedPlaylists?: number;
  /** 本地拿不到字节、因而无法备份的曲目数（需要提示用户） */
  missingBytes?: number;
  removedSongIds?: string[];
  playlists?: any[];
  changed?: boolean;
  /** 冲突对比用：本机/云端的曲目数 */
  localSongs?: number;
  cloudSongs?: number;
}

/* ---------------- 同步主流程 ---------------- */
async function syncInner(acc: any, mode: 'merge' | 'push' | 'pull'): Promise<CloudSyncOutcome> {
  const b = br();
  const now = Date.now();

  report('prepare', '正在读取本机曲库…');
  const songs = await localSongs();
  const playlists = await localPlaylists();
  report('prepare', `本机 ${songs.length} 首，正在与云端比对…`);

  const knownSongs: string[] = (await kvGet(KNOWN_SONGS_KEY)) || [];
  const knownPls: string[] = (await kvGet(KNOWN_PLAYLISTS_KEY)) || [];
  const plState: Record<string, { hash: string; ts: number }> = (await kvGet(PL_STATE_KEY)) || {};

  // ---- 曲目字节来源：记录内嵌 bytes 优先，缺失时回退 IndexedDB ----
  const idbMap = await idbSongs();
  const bytesById = new Map<string, Uint8Array>();
  for (const s of songs) {
    const own = pickBytes(s.bytes) || idbMap.get(s.id)?.bytes;
    if (own) bytesById.set(s.id, own);
  }

  // ---- 组装曲目元数据（不含字节；字节由 /songs/put 分批上传）----
  const songMeta: any[] = [];
  const localNames = new Set<string>();
  const metaByKey = new Map<string, { local: LocalSong; updatedAt: number; meta: any; hasBytes: boolean }>();
  const missingBytes: string[] = []; // 本地确实拿不到字节的曲目：只登记，不伪造空壳
  for (const s of songs) {
    const key = cloudKeyOf(s.name);
    if (!key || !MIDI_RE.test(key)) continue; // 仅同步 MIDI 类曲目
    localNames.add(key);
    const bytes = bytesById.get(s.id);
    const meta = { size: bytes ? bytes.length : (Number(s.size) || 0), dur: s.dur || 0, fp: s.fp || '', localId: s.id };
    const updatedAt = Number(s.time) || 0;
    songMeta.push({ id: key, name: key, meta, updatedAt, deleted: false });
    metaByKey.set(key, { local: s, updatedAt, meta, hasBytes: !!bytes });
    if (!bytes) missingBytes.push(key);
  }
  if (mode !== 'pull') {
    for (const k of knownSongs) {
      if (!localNames.has(k)) songMeta.push({ id: k, name: k, meta: null, updatedAt: now, deleted: true });
    }
  }

  // ---- 组装歌单（本地 id -> 文件名），时间戳仅在内容变化时更新 ----
  const idToName = new Map<string, string>();
  for (const s of songs) idToName.set(s.id, cloudKeyOf(s.name));

  const plPayload: any[] = [];
  const localPlIds = new Set<string>();
  const nextPlState: Record<string, { hash: string; ts: number }> = {};
  for (const p of playlists) {
    localPlIds.add(p.id);
    const names = (p.songIds || []).map((id: string) => idToName.get(id)).filter(Boolean);
    const hash = JSON.stringify([p.name || '', names]);
    const prev = plState[p.id];
    const ts = prev && prev.hash === hash ? prev.ts : now;
    nextPlState[p.id] = { hash, ts };
    plPayload.push({ id: p.id, name: p.name || '', songIds: names, updatedAt: ts, deleted: false });
  }
  if (mode !== 'pull') {
    for (const id of knownPls) {
      if (!localPlIds.has(id)) plPayload.push({ id, name: '', songIds: [], updatedAt: now, deleted: true });
    }
  }

  // ---- 请求服务器（只搬元数据，响应因此很小）----
  const res = await httpJson('/sync', {
    method: 'POST',
    token: acc.token,
    body: { deviceId: await deviceId(), mode, songs: songMeta, playlists: plPayload },
  });

  const cloudSongs: any[] = res.songs || [];
  const cloudMap = new Map<string, any>();
  for (const r of cloudSongs) if (r && r.id) cloudMap.set(String(r.id), r);

  // ---- 分批上传本地新增/有更新的字节 ----
  const toUpload: string[] = [];
  if (mode !== 'pull') {
    for (const [key, info] of metaByKey) {
      if (!info.hasBytes) continue;
      const sv = cloudMap.get(key);
      // 云端没有、云端只有空壳(!hasData)、或本地更新 -> 都需要把字节送上去
      if (!sv || !sv.hasData || info.updatedAt > (Number(sv.updatedAt) || 0)) toUpload.push(key);
    }
  }
  let uploadedSongs = 0;
  if (toUpload.length) report('upload', `准备上传 ${toUpload.length} 首…`, 0, toUpload.length);
  for (let i = 0; i < toUpload.length; i += BATCH) {
    const batch = toUpload.slice(i, i + BATCH).map((key) => {
      const info = metaByKey.get(key)!;
      return { id: key, name: key, meta: info.meta, updatedAt: info.updatedAt, data: bytesToB64(bytesById.get(info.local.id)) };
    });
    const r = await httpJson('/songs/put', { method: 'POST', token: acc.token, body: { songs: batch } });
    uploadedSongs += Number(r.saved) || 0;
    report('upload', `已上传 ${Math.min(i + BATCH, toUpload.length)}/${toUpload.length} 首…`, Math.min(i + BATCH, toUpload.length), toUpload.length);
  }

  // ---- 应用下发曲目：处理墓碑，并挑出需要下载字节的曲目 ----
  const removedSongIds: string[] = [];
  const keepNames = new Set<string>();
  const toDownload: string[] = [];
  const byName = new Map<string, LocalSong>();
  {
    const fresh = await localSongs();
    for (const s of fresh) byName.set(cloudKeyOf(s.name), s);

    for (const r of cloudSongs) {
      const key = String(r.id || '');
      if (!key) continue;
      if (!MIDI_RE.test(key)) continue; // 只接收 MIDI 类，避免把音频塞进 MIDI 解析
      const exist = byName.get(key);
      if (r.deleted) {
        if (exist) { await b.dbSongsDelete(exist.id); removedSongIds.push(exist.id); byName.delete(key); }
        continue;
      }
      keepNames.add(key);
      // 云端确实有字节，且本地没有或更旧 -> 需要下载（无字节的云端行不再伪造空曲目）
      if (r.hasData && (!exist || (Number(r.updatedAt) || 0) > (Number(exist.time) || 0))) toDownload.push(key);
    }

    // pull：云端权威，本机多余的 MIDI 曲目全部删除
    if (mode === 'pull') {
      for (const s of fresh) {
        const key = cloudKeyOf(s.name);
        if (!MIDI_RE.test(key)) continue;
        if (!keepNames.has(key)) { await b.dbSongsDelete(s.id); removedSongIds.push(s.id); }
      }
    }
  }

  // 删除同步到 IndexedDB（曲库真实来源），否则被删的曲目下次同步会复活
  await idbDeleteSongs(removedSongIds);

  // ---- 分批下载字节并落盘 ----
  let downloadedSongs = 0;
  const idbRows: any[] = [];
  if (toDownload.length) report('download', `准备下载 ${toDownload.length} 首…`, 0, toDownload.length);
  for (let i = 0; i < toDownload.length; i += BATCH) {
    const ids = toDownload.slice(i, i + BATCH);
    const r = await httpJson('/songs/get', { method: 'POST', token: acc.token, body: { ids } });
    for (const item of (r.songs || [])) {
      const key = String(item.id || '');
      const bytes = b64ToBytes(item.data || '');
      if (!key || !bytes.length) continue;
      const sv = cloudMap.get(key);
      const exist = byName.get(key);
      const id = exist ? exist.id : cryptoId();
      const row = {
        id, name: key, size: bytes.length,
        time: Number(sv && sv.updatedAt) || now,
        dur: (sv && sv.meta && sv.meta.dur) || (exist && exist.dur) || 0,
        fp: (sv && sv.meta && sv.meta.fp) || (exist && exist.fp) || '',
        bytes, kind: 'midi',
      };
      await b.dbSongsPut(row);
      // 落盘到云同步独立目录：与本地曲库分开存放，用户可直接查看/取用同步下来的 MIDI
      if (typeof b.dbCloudSongPut === 'function') {
        try { await b.dbCloudSongPut(key, bytes); } catch (e) {}
      }
      // IDB 存 Uint8Array，SQLite 侧沿用数组形式
      idbRows.push({ ...row, bytes });
      if (!exist) byName.set(key, { id, name: key } as LocalSong);
      downloadedSongs++;
      report('download', `已下载 ${downloadedSongs}/${toDownload.length} 首…`, downloadedSongs, toDownload.length);
    }
  }
  await idbPutSongs(idbRows);
  if (toDownload.length) report('download', `已下载 ${toDownload.length}/${toDownload.length} 首`, toDownload.length, toDownload.length);
  report('playlist', '正在写入歌单…');

  // ---- 应用下发的歌单（把文件名映射回本地曲目 id）----
  const nameToId = new Map<string, string>();
  for (const s of await localSongs()) nameToId.set(cloudKeyOf(s.name), s.id);

  const retPls: any[] = res.playlists || [];
  const finalPls: any[] = [];
  const keepPlIds = new Set<string>();
  for (const r of retPls) {
    if (r.deleted) continue;
    const id = String(r.id || '');
    if (!id) continue;
    keepPlIds.add(id);
    const ids = (r.songIds || []).map((n: string) => nameToId.get(n)).filter(Boolean);
    const pl = { id, name: r.name || '', songIds: ids };
    await b.dbPlaylistsPut(pl);
    finalPls.push(pl);
    if (!nextPlState[id]) nextPlState[id] = { hash: JSON.stringify([pl.name, r.songIds || []]), ts: Number(r.updatedAt) || now };
  }

  // 服务器未下发的本地歌单：pull 时按云端权威删除，其余保留
  const localPlsNow = await localPlaylists();
  for (const p of localPlsNow) {
    if (keepPlIds.has(p.id)) continue;
    if (mode === 'pull' && p.id !== 'default') { await b.dbPlaylistsDelete(p.id); continue; }
    finalPls.push(p);
  }

  // ---- 记录本次已知集合（供下次生成墓碑）----
  const knownSongsNext = Array.from(new Set([...(mode === 'pull' ? [] : knownSongs), ...localNames, ...keepNames]));
  const knownPlsNext = Array.from(new Set([...(mode === 'pull' ? [] : knownPls), ...localPlIds, ...keepPlIds]));
  await kvSet(KNOWN_SONGS_KEY, knownSongsNext);
  await kvSet(KNOWN_PLAYLISTS_KEY, knownPlsNext);
  await kvSet(PL_STATE_KEY, nextPlState);

  report('done', '同步完成');
  return {
    ok: true,
    uploadedSongs,
    downloadedSongs,
    uploadedPlaylists: plPayload.filter((x) => !x.deleted).length,
    appliedSongs: downloadedSongs,
    appliedPlaylists: finalPls.length,
    missingBytes: missingBytes.length,
    removedSongIds,
    playlists: finalPls,
    changed: uploadedSongs > 0 || downloadedSongs > 0 || (res.playlists || []).length > 0 || removedSongIds.length > 0 || mode !== 'merge',
  };
}

/** 本设备已关联（同步过）的账号集合：同一账号再次登录不再误报冲突 */
async function linkedUsers(): Promise<string[]> {
  const arr = (await kvGet(LINKED_KEY)) || [];
  return Array.isArray(arr) ? arr : [];
}
async function markLinked(userId: string) {
  if (!userId) return;
  const list = await linkedUsers();
  if (!list.includes(userId)) await kvSet(LINKED_KEY, [...list, userId]);
}

/** 本机存档规模（用于冲突对比展示）。
 *  电脑端总会存在一个空的「默认歌单」，它不算"有存档"，
 *  否则全新设备登录会被误判为"两边都有存档"而多弹一次冲突。 */
async function localCounts() {
  const songs = (await localSongs()).filter((s) => MIDI_RE.test(cloudKeyOf(s.name)));
  const pls = (await localPlaylists()).filter(
    (p) => p.id !== 'default' || (p.songIds || []).length > 0,
  );
  return { localSongs: songs.length, localPlaylists: pls.length };
}

/** 登录后对齐本机与云端：冲突则交界面选择，否则自动建档/合并 */
async function reconcile(acc: any, counts: any): Promise<CloudSyncOutcome> {
  const { localSongs: ls, localPlaylists: lp } = await localCounts();
  const cloudSongs = Number(counts && counts.cloudSongs) || 0;
  const cloudPls = Number(counts && counts.cloudPlaylists) || 0;
  // 有曲目或有歌单都算"有存档"（只有曲目没有歌单也要能建档）
  const hasLocal = ls > 0 || lp > 0;
  const hasCloud = cloudSongs > 0 || cloudPls > 0;

  // 已关联过的账号：正常同步，不打扰
  if ((await linkedUsers()).includes(acc.userId)) {
    const mode = (!hasCloud && hasLocal) ? 'push' : 'merge';
    return await syncInner(acc, mode as any);
  }

  // 首次在本设备登录该账号：两边都有存档 -> 交给用户选择
  if (hasLocal && hasCloud) {
    return { ok: true, conflict: true, localN: lp, cloudN: cloudPls, localSongs: ls, cloudSongs };
  }

  let out: CloudSyncOutcome = { ok: true, localSongs: ls, cloudSongs };
  if (!hasCloud && hasLocal) out = await syncInner(acc, 'push');
  else if (hasCloud && !hasLocal) out = await syncInner(acc, 'pull');
  await markLinked(acc.userId);
  return out;
}

async function doAuth(path: string, email: string, password: string, turnstile?: string | null): Promise<CloudSyncOutcome> {
  try {
    const res = await httpJson(path, {
      method: 'POST',
      body: { email, password, turnstile: turnstile || null, deviceId: await deviceId() },
    });
    if (!res.token) return { ok: false, error: '服务器未发放会话' };
    const acc = { email: res.email || email, userId: res.userId, token: res.token };
    await setAccount(acc);
    const out = await reconcile(acc, res);
    return { ...out, ok: out.ok !== false };
  } catch (e: any) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

export function cloudLogin(email: string, password: string, turnstile?: string | null) {
  return doAuth('/auth/login', email, password, turnstile);
}
export function cloudRegister(email: string, password: string, turnstile?: string | null) {
  return doAuth('/auth/register', email, password, turnstile);
}

export async function cloudLogout(): Promise<CloudSyncOutcome> {
  const acc = await getAccount();
  if (acc && acc.token) { try { await httpJson('/auth/logout', { method: 'POST', token: acc.token }); } catch (e) {} }
  await setAccount(null);
  // 保留"已关联账号"记录：退出后再登同一账号不应再次要求选择存档
  return { ok: true };
}

export interface CloudCounts {
  ok: boolean;
  error?: string;
  localSongs: number;
  localPlaylists: number;
  cloudSongs: number;
  cloudPlaylists: number;
}

/** 手动同步前的存档对话：取回本机与云端规模，供用户选择以哪一侧为准。 */
export async function cloudFetchCounts(): Promise<CloudCounts> {
  const local = await localCounts();
  const acc = await getAccount();
  if (!acc || !acc.token) return { ok: false, error: '未登录', ...local, cloudSongs: 0, cloudPlaylists: 0 };
  try {
    const res = await httpJson('/counts', { token: acc.token });
    return {
      ok: true, ...local,
      cloudSongs: Number(res.cloudSongs) || 0,
      cloudPlaylists: Number(res.cloudPlaylists) || 0,
    };
  } catch (e: any) {
    return { ok: false, error: e && e.message ? e.message : String(e), ...local, cloudSongs: 0, cloudPlaylists: 0 };
  }
}

export async function cloudSync(mode: 'merge' | 'push' | 'pull' = 'merge'): Promise<CloudSyncOutcome> {
  const acc = await getAccount();
  if (!acc || !acc.token) return { ok: false, error: '未登录' };
  try { return await syncInner(acc, mode); }
  catch (e: any) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

/** 冲突解决：local=保留本机覆盖云端；cloud=保留云端覆盖本机 */
export async function cloudResolveConflict(choose: 'local' | 'cloud'): Promise<CloudSyncOutcome> {
  const acc = await getAccount();
  if (!acc || !acc.token) return { ok: false, error: '未登录' };
  try {
    const out = await syncInner(acc, choose === 'cloud' ? 'pull' : 'push');
    await markLinked(acc.userId);
    return out;
  } catch (e: any) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

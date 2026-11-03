// ============================================================
// 主进程 SQLite 持久化服务（sql.js WASM，无原生编译）
// 如 sql.js 加载失败则自动回退为 JSON 文件存储，不影响主流程。
// 后续前端可在不破坏现有 IndexedDB 的情况下逐步迁移。
// ============================================================
'use strict';

const path = require('path');
const fs = require('fs');

function createDbService({ app, path: p, fs: f }) {
  const dbDir = p.join(app.getPath('userData'), 'fufumidi');
  const dbPath = p.join(dbDir, 'fufumidi.sqlite');
  const jsonPath = p.join(dbDir, 'fufumidi-db.json');
  let db = null;
  let mode = 'none';
  let jsonData = { kv: {}, songs: {}, playlists: {} };
  // 写入队列：串行化 SQLite 写入；持久化与写入解耦（见下方去抖）。
  let writeQ = Promise.resolve();
  function enqueueWrite(fn) {
    writeQ = writeQ.then(fn).catch(() => {});
    return writeQ;
  }

  /* ---------------- 持久化：去抖 + 异步落盘 ----------------
     sql.js 的持久化是「导出整个数据库再写盘」：60 MiB 级的库每次约 70 ms，而改一个设置、
     存一次草稿都会触发 persist()。原来每次写都同步 export + writeFileSync，等于把主线程
     按库大小反复冻结。这里改成：
       · 800 ms 合并一次（同一批写只落一次盘）；
       · export 仍在内存里同步完成（快，约 10 ms），写盘走 fs.promises，不阻塞主线程；
       · close() 前必须 flush，保证退出不丢数据。
     注：旧实现 close() 引用了从未声明的 persistTimer/persistPromise/persistNow，
     会抛 ReferenceError 被上层吞掉 —— 退出冲刷实际从未执行（本文件 2026-11-03 修复）。 */
  const PERSIST_DEBOUNCE_MS = 800;
  let persistTimer = null;
  let persistPromise = Promise.resolve();
  let persistNow = null;

  function writeFileAsync(file, data, enc) {
    try {
      if (f.promises && typeof f.promises.writeFile === 'function') return f.promises.writeFile(file, data, enc);
    } catch (e) { /* fallthrough */ }
    return new Promise((resolve, reject) => {
      try { f.writeFile(file, data, enc, (e) => (e ? reject(e) : resolve())); } catch (e) { reject(e); }
    });
  }

  function flushPersist() {
    const run = async () => {
      try {
        if (mode === 'sqlite' && db) {
          const data = db.export();
          await writeFileAsync(dbPath, Buffer.from(data));
        } else if (mode === 'json') {
          await writeFileAsync(jsonPath, JSON.stringify(jsonData), 'utf8');
        }
      } catch (e) {
        try { require('./log').write('WARN', 'db persist failed', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ }
      }
    };
    persistPromise = persistPromise.then(run, run);
    return persistPromise;
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; flushPersist(); }, PERSIST_DEBOUNCE_MS);
    // 测试/脚本里不要让计时器拖住进程退出；close() 会显式 flush。
    try { if (persistTimer && typeof persistTimer.unref === 'function') persistTimer.unref(); } catch (e) { /* ignore */ }
  }

  persistNow = flushPersist;

  async function init() {
    if (db || mode !== 'none') return db;
    try {
      f.mkdirSync(dbDir, { recursive: true });
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs({
        locateFile: (file) => p.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
      });
      const bytes = f.existsSync(dbPath) ? f.readFileSync(dbPath) : null;
      db = bytes ? new SQL.Database(bytes) : new SQL.Database();
      db.run('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
      db.run('CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, name TEXT, data TEXT, meta TEXT, updated_at INTEGER)');
      db.run('CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT, song_ids TEXT)');
      mode = 'sqlite';
      return db;
    } catch (e) {
      mode = 'json';
      try { jsonData = JSON.parse(f.readFileSync(jsonPath, 'utf8')); } catch (e2) { try { require('./log').write('WARN', 'optional failure', String((e2 && e2.stack) || e2)); } catch (_) { /* log failure ignored */ } }
      return null;
    }
  }

  /* 旧名保留为兼容入口：真正的落盘走去抖队列（flushPersist）。 */
  function persist() { schedulePersist(); }

  async function kvGet(key) {
    await init();
    if (mode === 'sqlite' && db) {
      const stmt = db.prepare('SELECT value FROM kv WHERE key = ?');
      stmt.bind([key]);
      if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row.value ? JSON.parse(row.value) : null; }
      stmt.free(); return null;
    }
    return jsonData.kv[key] ?? null;
  }

  async function kvSet(key, value) {
    await enqueueWrite(async () => {
      await init();
      if (mode === 'sqlite' && db) {
        db.run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]);
      } else {
        jsonData.kv[key] = value;
      }
      schedulePersist();
    });
    return true;
  }

  async function songPut(item) {
    if (!item || !item.id) return false;
    const row = JSON.stringify(item);
    await enqueueWrite(async () => {
      await init();
      if (mode === 'sqlite' && db) {
        db.run('INSERT INTO songs(id,name,data,meta,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,meta=excluded.meta,updated_at=excluded.updated_at', [item.id, item.name || '', row, JSON.stringify(item.meta || {}), Date.now()]);
      } else {
        jsonData.songs[item.id] = item;
      }
      schedulePersist();
    });
    return true;
  }

  async function songsAll() {
    await init();
    if (mode === 'sqlite' && db) {
      const rs = db.exec('SELECT data FROM songs ORDER BY updated_at DESC');
      const rows = rs && rs[0] ? rs[0].values : [];
      return rows.map(r => { try { return JSON.parse(r[0]); } catch (e) { return null; } }).filter(Boolean);
    }
    return Object.values(jsonData.songs);
  }

  async function songDelete(id) {
    await enqueueWrite(async () => {
      await init();
      if (mode === 'sqlite' && db) {
        db.run('DELETE FROM songs WHERE id = ?', [id]);
      } else {
        delete jsonData.songs[id];
      }
      schedulePersist();
    });
    return true;
  }

  async function playlistPut(item) {
    if (!item || !item.id) return false;
    await enqueueWrite(async () => {
      await init();
      if (mode === 'sqlite' && db) {
        db.run('INSERT INTO playlists(id,name,song_ids) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,song_ids=excluded.song_ids', [item.id, item.name || '', JSON.stringify(item.songIds || [])]);
      } else {
        jsonData.playlists[item.id] = item;
      }
      schedulePersist();
    });
    return true;
  }

  async function playlistsAll() {
    await init();
    if (mode === 'sqlite' && db) {
      const rs = db.exec('SELECT id,name,song_ids FROM playlists');
      const rows = rs && rs[0] ? rs[0].values : [];
      return rows.map(([id, name, songIds]) => ({ id, name, songIds: JSON.parse(songIds || '[]') }));
    }
    return Object.values(jsonData.playlists);
  }

  async function playlistDelete(id) {
    if (!id) return false;
    await enqueueWrite(async () => {
      await init();
      if (mode === 'sqlite' && db) {
        db.run('DELETE FROM playlists WHERE id = ?', [id]);
      } else {
        delete jsonData.playlists[id];
      }
      schedulePersist();
    });
    return true;
  }

  async function status() {
    await init();
    return { ok: true, mode, dbPath, jsonPath };
  }

  // 云同步曲目落盘目录：与本地曲库分开存放，便于查看、备份与单独清理
  const cloudSongsDir = p.join(dbDir, 'cloud-songs');
  function cloudSongsDirPath() { return cloudSongsDir; }
  async function cloudSongPut(name, bytes) {
    try {
      const file = String(name || '').trim();
      if (!file) return false;
      f.mkdirSync(cloudSongsDir, { recursive: true });
      // 只保留纯文件名，避免云端 id 里的路径分隔符写到目录之外
      const safe = file.replace(/[\\/:*?"<>|]/g, '_');
      f.writeFileSync(p.join(cloudSongsDir, safe), Buffer.from(bytes || []));
      return true;
    } catch (e) {
      return false;
    }
  }

  function registerDbIpc({ ipcMain }) {
    ipcMain.handle('db:status', () => status());
    ipcMain.handle('db:kv:get', (_e, key) => kvGet(key));
    ipcMain.handle('db:kv:set', (_e, key, value) => kvSet(key, value));
    ipcMain.handle('db:songs:list', () => songsAll());
    ipcMain.handle('db:songs:put', (_e, item) => songPut(item));
    ipcMain.handle('db:songs:delete', (_e, id) => songDelete(id));
    ipcMain.handle('db:playlists:list', () => playlistsAll());
    ipcMain.handle('db:playlists:put', (_e, item) => playlistPut(item));
    ipcMain.handle('db:playlists:delete', (_e, id) => playlistDelete(id));
    // 云同步：把下发的曲目落盘到独立目录，并返回该目录路径（界面展示用）
    ipcMain.handle('db:cloud-song:put', (_e, name, bytes) => cloudSongPut(name, bytes));
    ipcMain.handle('db:cloud-song:dir', () => cloudSongsDirPath());
  }

  async function close() {
    // 退出顺序：取消待触发的去抖计时器 → 等所有内存写完成 → 强制 flush 一次 → 关库。
    if (persistTimer) { try { clearTimeout(persistTimer); } catch (e) { /* ignore */ } persistTimer = null; }
    try { await writeQ; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    try { await flushPersist(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    try { await persistPromise; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    try { if (db) { db.close(); db = null; } } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    return true;
  }

  return { init, status, kvGet, kvSet, songPut, songsAll, songDelete, playlistPut, playlistsAll, registerDbIpc, close, flushPersist, cloudSongPut, cloudSongsDirPath };
}

module.exports = { createDbService };

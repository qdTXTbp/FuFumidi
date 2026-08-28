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
  // 写入队列：串行化 SQLite 写入 + persist 导出，close() 前先冲刷，避免退出丢数据
  let writeQ = Promise.resolve();
  function enqueueWrite(fn) {
    writeQ = writeQ.then(fn).catch(() => {});
    return writeQ;
  }

  function saveJson() {
    try {
      f.mkdirSync(dbDir, { recursive: true });
      f.writeFileSync(jsonPath, JSON.stringify(jsonData), 'utf8');
    } catch (e) {}
  }

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
      try { jsonData = JSON.parse(f.readFileSync(jsonPath, 'utf8')); } catch (e2) {}
      return null;
    }
  }

  function persist() {
    if (mode === 'sqlite' && db) {
      const data = db.export();
      try { f.writeFileSync(dbPath, Buffer.from(data)); } catch (e) {}
    } else if (mode === 'json') {
      saveJson();
    }
  }

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
      persist();
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
      persist();
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
      persist();
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
      persist();
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

  async function status() {
    await init();
    return { ok: true, mode, dbPath, jsonPath };
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
  }

  function close() {
    // 先等待写入队列落盘，再关闭数据库（避免退出时歌单/收藏写丢失）
    return writeQ.then(() => {
      try { if (db) { db.close(); db = null; } } catch (e) {}
    });
  }

  return { init, status, kvGet, kvSet, songPut, songsAll, songDelete, playlistPut, playlistsAll, registerDbIpc, close };
}

module.exports = { createDbService };

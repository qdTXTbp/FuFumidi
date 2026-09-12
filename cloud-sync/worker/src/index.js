// ============================================================
// 云端同步后端入口：路由 + 双向同步
// 同步模型：每条记录以 updated_at 做 last-write-wins（较新者胜），
// 服务器为裁决者。删除用 deleted=1 墓碑传播到其他端。
// 客户端上传其拥有/改动的全部记录，服务器合并后把"服务器较新"
// 及"客户端尚未拥有"的记录回传，实现双向同步。
// ============================================================
import { json, error, ok, nowMs } from './util.js';
import { createAuth, cloudCounts } from './auth.js';
import { buildStorage } from './storage.js';
import { turnstileHtml } from './turnstilePage.js';

// 构建标记：用于确认线上实际跑的是哪一版代码（/health 会返回它）
const BUILD = 'chunked-sync';

// 单批曲目上限：分开发送/拉取字节，避免一次请求或响应过大
// （Workers 对请求体、内存与单次调用子请求数都有上限，整包同步 500+ 首会中途被杀）
const MAX_BATCH = 8;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const auth = createAuth(env);
    const storage = buildStorage(env);

    if (request.method === 'OPTIONS') return cors();

    try {
      // ---------- 账号 ----------
      if (path === '/health') {
        const provider = (env && env.STORAGE_PROVIDER) || 'r2';
        return ok({ status: 'up', build: BUILD, usingR2: provider === 'r2' && !!(env && env.BUCKET), time: nowMs() });
      }

      // 托管的 Turnstile 页面：两端用 iframe / WebView 加载以取得人机验证 token
      if (path === '/turnstile') {
        const html = turnstileHtml(env.TURNSTILE_SITE_KEY || '0x4AAAAAAEw9YF870FXnrS6y');
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      if (path === '/auth/register' && request.method === 'POST') {
        return withCors(await auth.register(await request.json()));
      }
      if (path === '/auth/login' && request.method === 'POST') {
        return withCors(await auth.login(await request.json()));
      }

      // ---------- 需登录 ----------
      const { user, err } = await auth.requireAuth(request);
      if (err) return withCors(err);

      if (path === '/auth/logout' && request.method === 'POST') {
        return withCors(await auth.logout(user.tokenHash));
      }
      if (path === '/me' && request.method === 'GET') {
        return withCors(ok({ userId: user.id }));
      }
      if (path === '/sync' && request.method === 'POST') {
        return withCors(await handleSync(env, storage, user.id, await request.json()));
      }
      // 云端存档数量：手动同步时让用户在选择前看到两边规模
      if (path === '/counts' && request.method === 'GET') {
        return withCors(ok(await cloudCounts(env, user.id)));
      }
      // 曲目字节分批上传 / 下载：/sync 只搬元数据，字节走这里，避免单次请求过大
      if (path === '/songs/put' && request.method === 'POST') {
        return withCors(await handleSongsPut(storage, user.id, await request.json()));
      }
      if (path === '/songs/get' && request.method === 'POST') {
        return withCors(await handleSongsGet(storage, user.id, await request.json()));
      }

      return withCors(error('Not Found', 404));
    } catch (e) {
      console.error('[sync] error', e);
      // 回一段异常摘要而不是堆栈：用户反馈「服务器内部错误」时能直接给出原因，
      // 又不至于把文件路径/行号之类的实现细节暴露出去。
      const detail = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160);
      return withCors(error('服务器内部错误：' + detail, 500));
    }
  },
};

// ---------------- 双向同步 ----------------
async function handleSync(env, storage, userId, body) {
  const incoming = body || {};
  const inSongs = incoming.songs || [];
  const inPlaylists = incoming.playlists || [];
  const t = nowMs();

  // 服务器现有全量元数据（不含 MIDI 字节：字节由 /songs/get 分批下发）
  const [svSongs, svPlaylists] = await Promise.all([
    storage.listSongMeta(userId),
    env.DB.prepare('SELECT id,name,song_ids,updated_at,deleted FROM playlists WHERE user_id=?')
      .bind(userId).all().then((r) => r.results.map((x) => ({
        id: x.id, name: x.name || '', songIds: safeParseJson(x.song_ids, []),
        updatedAt: x.updated_at, deleted: !!x.deleted,
      }))),
  ]);

  const svSongMap = new Map(svSongs.map((s) => [s.id, s]));
  const svPlayMap = new Map(svPlaylists.map((p) => [p.id, p]));

  // 归档模式：pull=云端覆盖本机；push=本机覆盖云端；merge=按时间戳双向合并（默认）
  const mode = incoming.mode === 'push' ? 'push' : incoming.mode === 'pull' ? 'pull' : 'merge';

  // 写入统一收集后批量提交：逐条写会产生几百次子请求，500+ 首时必超 Workers 上限
  const songWrites = [];
  const plWrites = [];

  if (mode === 'pull') {
    // 云端权威：把云端有效存档整份下发，客户端以它为唯一基准
    return ok({
      songs: svSongs.filter((s) => !s.deleted),
      playlists: svPlaylists.filter((p) => !p.deleted),
      serverTime: t,
    });
  }

  if (mode === 'push') {
    // 本机权威：云端被覆盖为客户端全量，其余旧的云端项做墓碑清理
    // 注意：这里只搬元数据，字节已由客户端分批 /songs/put 落盘
    const inSongSet = new Set(inSongs.filter((s) => !s.deleted).map((s) => s.id));
    const inPlaySet = new Set(inPlaylists.filter((p) => !p.deleted).map((p) => p.id));
    for (const it of inSongs) {
      if (it.deleted) continue;
      songWrites.push({
        user_id: userId, id: it.id, name: it.name || '',
        meta: it.meta != null ? (typeof it.meta === 'string' ? it.meta : JSON.stringify(it.meta)) : null,
        updated_at: it.updatedAt || t, deleted: false,
      });
    }
    for (const sv of svSongMap.values()) {
      if (inSongSet.has(sv.id) || sv.deleted) continue;
      songWrites.push({ user_id: userId, id: sv.id, name: sv.name || '', meta: null, updated_at: t, deleted: true });
    }
    for (const it of inPlaylists) {
      if (it.deleted) continue;
      plWrites.push({ id: it.id, name: it.name || '', songIds: it.songIds || [], updatedAt: it.updatedAt || t, deleted: false });
    }
    for (const sv of svPlayMap.values()) {
      if (inPlaySet.has(sv.id) || sv.deleted) continue;
      plWrites.push({ id: sv.id, name: sv.name || '', songIds: [], updatedAt: t, deleted: true });
    }
    await flushWrites(env, storage, userId, songWrites, plWrites);
    return ok({ songs: [], playlists: [], serverTime: t });
  }

  // 需要回传给客服端的"服务器较新/新增"项
  const retSongs = [];
  const retPlaylists = [];

  // ---------- 歌曲 ----------
  const inSongMap = new Map(inSongs.map((s) => [s.id, s]));
  for (const it of inSongs) {
    const sv = svSongMap.get(it.id);
    if (!sv) {
      if (!it.deleted) {
        songWrites.push({
          user_id: userId, id: it.id, name: it.name || '',
          meta: it.meta != null ? (typeof it.meta === 'string' ? it.meta : JSON.stringify(it.meta)) : null,
          updated_at: it.updatedAt || t, deleted: false,
        });
      }
      continue;
    }
    const cv = it.updatedAt || 0;
    if (cv > sv.updatedAt) {
      songWrites.push({
        user_id: userId, id: it.id, name: it.name || '',
        meta: it.meta != null ? (typeof it.meta === 'string' ? it.meta : JSON.stringify(it.meta)) : (sv.meta ? JSON.stringify(sv.meta) : null),
        updated_at: cv, deleted: !!it.deleted,
      });
    } else if (cv < sv.updatedAt) {
      retSongs.push(sv); // 服务器较新 -> 回传（元数据；字节由客户端按 hasData 分批拉取）
    }
  }
  // 服务器有、客服端没上传的项：非删除 -> 回传（新端补全/下发）；删除 -> 不比上传
  for (const sv of svSongMap.values()) {
    if (inSongMap.has(sv.id)) continue;
    if (!sv.deleted) retSongs.push(sv);
  }

  // ---------- 歌单 ----------
  const inPlayMap = new Map(inPlaylists.map((p) => [p.id, p]));
  for (const it of inPlaylists) {
    const sv = svPlayMap.get(it.id);
    if (!sv) {
      if (!it.deleted) {
        plWrites.push({
          id: it.id, name: it.name || '', songIds: it.songIds || [],
          updatedAt: it.updatedAt || t, deleted: false,
        });
      }
      continue;
    }
    const cv = it.updatedAt || 0;
    if (cv > sv.updatedAt) {
      plWrites.push({
        id: it.id, name: it.name || '', songIds: it.songIds || [],
        updatedAt: cv, deleted: !!it.deleted,
      });
    } else if (cv < sv.updatedAt) {
      retPlaylists.push(sv);
    }
  }
  for (const sv of svPlayMap.values()) {
    if (inPlayMap.has(sv.id)) continue;
    if (!sv.deleted) retPlaylists.push(sv);
  }

  await flushWrites(env, storage, userId, songWrites, plWrites);

  return ok({
    songs: retSongs,
    playlists: retPlaylists,
    serverTime: t,
  });
}

/** 批量落盘：曲目元数据走 storage 的批量接口，歌单用 DB.batch 一次提交 */
async function flushWrites(env, storage, userId, songs, playlists) {
  if (songs.length) await storage.putSongMetaMany(songs);
  if (!playlists.length) return;
  const stmts = playlists.map((p) => env.DB.prepare(
    `INSERT INTO playlists(user_id,id,name,song_ids,updated_at,deleted) VALUES(?1,?2,?3,?4,?5,?6)
     ON CONFLICT(user_id,id) DO UPDATE SET
       name=excluded.name, song_ids=excluded.song_ids,
       updated_at=excluded.updated_at, deleted=excluded.deleted`
  ).bind(userId, p.id, p.name, JSON.stringify(p.songIds || []), p.updatedAt, p.deleted ? 1 : 0));
  for (let i = 0; i < stmts.length; i += 60) {
    await env.DB.batch(stmts.slice(i, i + 60));
  }
}

// ---------------- 曲目字节：分批上传 / 下载 ----------------
// 这两条路由专门搬运 MIDI 字节，单批最多 MAX_BATCH 首。
// 这样 500+ 首的曲库也不会因为"单次请求/响应过大"而在中途被打断。
async function handleSongsPut(storage, userId, body) {
  const list = (body && body.songs) || [];
  if (!Array.isArray(list) || !list.length) return error('缺少 songs');
  if (list.length > MAX_BATCH) return error(`每批最多 ${MAX_BATCH} 首`, 400);
  let saved = 0;
  for (const it of list) {
    if (!it || !it.id || it.data == null) continue; // 没有字节的曲目不上传，避免写入"空壳"
    await storage.putSongBlob({
      user_id: userId,
      id: it.id,
      name: it.name || '',
      data: b64ToBytes(it.data),
      meta: it.meta != null ? (typeof it.meta === 'string' ? it.meta : JSON.stringify(it.meta)) : null,
      updated_at: it.updatedAt || nowMs(),
    });
    saved++;
  }
  return ok({ saved });
}

async function handleSongsGet(storage, userId, body) {
  const ids = ((body && body.ids) || []).filter((x) => typeof x === 'string' && x);
  if (!ids.length) return error('缺少 ids');
  if (ids.length > MAX_BATCH) return error(`每批最多 ${MAX_BATCH} 首`, 400);
  return ok({ songs: await storage.getSongBlobs(userId, ids) });
}

function safeParseJson(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function cors() { return new Response(null, { status: 204, headers: CORS }); }
function withCors(res) { const r = new Response(res.body, { status: res.status, headers: { ...res.headers, ...CORS } }); return r; }
// ============================================================
// 存储适配层：歌曲 MIDI 文件体的持久化，可切换 D1 或 R2。
// 当前默认 R2（用户已开通 R2，MIDI 文件体存 R2）。
//
// 拆成三类接口，避免"一次拉全量"把内存/子请求打爆：
//   - listSongMeta  只读元数据（不碰 R2），供 /sync 使用
//   - putSongBlob   写入单首的字节（写 R2 + 记 blob_size）
//   - getSongBlobs  按 id 批量取字节，供分批下载
// ============================================================

import { bytesToB64 } from './util.js';

// 单次 DB.batch 里的语句条数：整批算一次子请求，避免几百条写各自成请求
const BATCH_STMTS = 60;

const metaOf = (r) => ({
  id: r.id,
  name: r.name || '',
  meta: r.meta ? JSON.parse(r.meta) : null,
  updatedAt: r.updated_at,
  deleted: !!r.deleted,
  // hasData 依据真实 blob 长度，而不是客户端上报的 meta.size
  hasData: (r.blob_size || 0) > 0,
});

// ---------- D1 实现 ----------
async function d1ListSongMeta(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT id,name,meta,updated_at,deleted,length(data) AS blob_size FROM songs WHERE user_id = ?'
  ).bind(userId).all();
  return results.map(metaOf);
}

async function d1PutSongMeta(env, row) {
  return d1PutSongMetaMany(env, [row]);
}

async function d1PutSongMetaMany(env, rows) {
  const stmts = rows.map((row) => env.DB.prepare(
    `INSERT INTO songs (user_id,id,name,data,meta,updated_at,deleted) VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(user_id,id) DO UPDATE SET
       name=excluded.name, meta=excluded.meta,
       updated_at=excluded.updated_at, deleted=excluded.deleted`
  ).bind(row.user_id, row.id, row.name, null, row.meta, row.updated_at, row.deleted ? 1 : 0));
  for (let i = 0; i < stmts.length; i += BATCH_STMTS) {
    await env.DB.batch(stmts.slice(i, i + BATCH_STMTS));
  }
  return rows.length;
}

async function d1GetSongBlobs(env, userId, ids) {
  const out = [];
  for (const id of ids) {
    const r = await env.DB.prepare(
      'SELECT id,data,meta,updated_at,deleted FROM songs WHERE user_id=? AND id=?'
    ).bind(userId, id).first();
    if (!r || r.deleted || !r.data) continue;
    out.push({ id: r.id, data: bytesToB64(new Uint8Array(r.data)), meta: r.meta ? JSON.parse(r.meta) : null, updatedAt: r.updated_at });
  }
  return out;
}

// ---------- R2 实现 ----------
const keyOf = (userId, id) => `user/${userId}/songs/${id}`;

async function r2ListSongMeta(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT id,name,meta,updated_at,deleted,blob_size FROM songs WHERE user_id = ?'
  ).bind(userId).all();
  return results.map(metaOf);
}

/** 只写元数据（不触碰 R2 对象与 blob_size），用于 /sync */
async function r2PutSongMeta(env, row) {
  return r2PutSongMetaMany(env, [row]);
}

/**
 * 批量写元数据。
 *
 * 必须走 DB.batch：一次 /sync 可能带上几百首曲目的元数据，
 * 若逐条 .run() 就是几百次子请求，会直接撞上 Workers 的单次调用子请求上限
 * （免费版 50）——这正是 526 首只写进 121 首的原因之一。
 * DB.batch 把整批打包成一次子请求。
 */
async function r2PutSongMetaMany(env, rows) {
  const stmts = rows.map((row) => env.DB.prepare(
    `INSERT INTO songs (user_id,id,name,data,meta,updated_at,deleted,blob_size) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(user_id,id) DO UPDATE SET
       name=excluded.name, meta=excluded.meta,
       updated_at=excluded.updated_at, deleted=excluded.deleted`
  ).bind(row.user_id, row.id, row.name, null, row.meta, row.updated_at, row.deleted ? 1 : 0, 0));
  for (let i = 0; i < stmts.length; i += BATCH_STMTS) {
    await env.DB.batch(stmts.slice(i, i + BATCH_STMTS));
  }
  // 墓碑：连带删除 R2 对象（数量通常很少，单独发即可）
  for (const row of rows) {
    if (row.deleted) await env.BUCKET.delete(keyOf(row.user_id, row.id));
  }
  return rows.length;
}

/** 写入单首字节：R2 + 元数据 + blob_size（分批上传的落点） */
async function r2PutSongBlob(env, row) {
  const bytes = row.data;
  const size = bytes ? bytes.length : 0;
  if (bytes) {
    await env.BUCKET.put(keyOf(row.user_id, row.id), bytes, { httpMetadata: { contentType: 'audio/midi' } });
  }
  await env.DB.prepare(
    `INSERT INTO songs (user_id,id,name,data,meta,updated_at,deleted,blob_size) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(user_id,id) DO UPDATE SET
       name=excluded.name, meta=excluded.meta,
       updated_at=excluded.updated_at, deleted=0, blob_size=excluded.blob_size`
  ).bind(row.user_id, row.id, row.name, null, row.meta, row.updated_at, 0, size).run();
}

async function r2GetSongBlobs(env, userId, ids) {
  const out = [];
  // 单批数量由调用方限制（见 index.js 的 MAX_BATCH），这里并发取即可
  const got = await Promise.all(
    ids.map(async (id) => {
      const obj = await env.BUCKET.get(keyOf(userId, id));
      if (!obj) return null;
      // arrayBuffer() 返回 ArrayBuffer，必须包成 Uint8Array —— bytesToB64 依赖 .subarray
      return { id, data: bytesToB64(new Uint8Array(await obj.arrayBuffer())) };
    })
  );
  for (const g of got) if (g && g.data) out.push(g);
  return out;
}

export function buildStorage(env) {
  // 变量/绑定都在 env 上（不是在 globalThis）
  const provider = (env && env.STORAGE_PROVIDER) || 'r2';
  if (provider === 'r2' && env.BUCKET) {
    return {
      listSongMeta: (userId) => r2ListSongMeta(env, userId),
      putSongMeta: (row) => r2PutSongMeta(env, row),
      putSongMetaMany: (rows) => r2PutSongMetaMany(env, rows),
      putSongBlob: (row) => r2PutSongBlob(env, row),
      getSongBlobs: (userId, ids) => r2GetSongBlobs(env, userId, ids),
    };
  }
  return {
    listSongMeta: (userId) => d1ListSongMeta(env, userId),
    putSongMeta: (row) => d1PutSongMeta(env, row),
    putSongMetaMany: (rows) => d1PutSongMetaMany(env, rows),
    putSongBlob: (row) => d1PutSongMeta(env, { ...row, data: row.data }),
    getSongBlobs: (userId, ids) => d1GetSongBlobs(env, userId, ids),
  };
}

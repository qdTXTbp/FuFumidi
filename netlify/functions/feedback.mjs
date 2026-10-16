// Netlify Functions v2 入口：POST /feedback
//
// 为什么附件上限是 4 MB：Netlify 同步函数请求体上限 6 MB，而客户端协议是 base64 JSON
// （膨胀 4/3）—— 4 MB 原始字节 ≈ 5.4 MB 请求体，留出余量。超限返回 413 并给可操作的建议，
// 客户端会走既有的"自动存本地 + 网页提交"兜底。
import { createFeedback, sha256Hex, repoFromEnv, branchFromEnv } from '../lib/feedback-core.mjs';

const MAX_ATT = 4 * 1024 * 1024;
const MAX_BODY = 6 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** 内存兜底：Blobs 不可用时至少能挡住同一实例内的连击（Lambda 热实例会保留） */
function kvInMemory() {
  const m = new Map();
  return {
    async get(key) {
      const e = m.get(key.join(':'));
      if (e && e.exp && e.exp < Date.now()) return { value: null };
      return { value: e ? e.value : null };
    },
    async set(key, value, opts) {
      const expireIn = (opts && opts.expireIn) || 0;
      m.set(key.join(':'), { value, exp: expireIn ? Date.now() + expireIn : 0 });
    },
  };
}

/** 限流存储：Netlify Blobs。手写过期时间，不依赖 Blobs 的 TTL 参数（版本间差异）。
 *
 *  ★ 用**动态 import + 兜底**：第一次部署时构建没装依赖，静态 import 让每个请求都 502
 *    （实测 "Cannot find package '@netlify/blobs'"）—— 反馈通道绝不能因为限流组件而整体不可用，
 *    拿不到 Blobs 就退回内存限流。 */
async function kvStore() {
  try {
    const mod = await import('@netlify/blobs');
    const store = mod.getStore({ name: 'fufumidi-feedback-rl', consistency: 'strong' });
    // 试读一次，确认真的可用（拿到 store 但后端不通的情况也要能降级）
    await store.get('__probe__');
    return blobKv(store);
  } catch (e) {
    console.warn('[feedback] Netlify Blobs 不可用，限流降级为内存模式：' + String(e && e.message || e));
    return kvInMemory();
  }
}

function blobKv(store) {
  return {
    async get(key) {
      let raw = null;
      try { raw = await store.get(key.join(':')); } catch { return { value: null }; }
      if (!raw) return { value: null };
      let o = null;
      try { o = JSON.parse(raw); } catch { return { value: null }; }
      if (o && o.exp && o.exp < Date.now()) return { value: null };
      return { value: o ? o.n : null };
    },
    async set(key, value, opts) {
      const expireIn = (opts && opts.expireIn) || 0;
      const payload = JSON.stringify({ n: value, exp: expireIn ? Date.now() + expireIn : 0 });
      try { await store.set(key.join(':'), payload); } catch { /* 限流存储故障不该挡住反馈 */ }
    },
  };
}

export const config = { path: '/feedback' };

export default async function handler(req, context) {
  if (req.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ ok: false, error: '请求体过大（上限 6 MB）' }, 413);

  let body = null;
  try { body = await req.json(); } catch { return json({ ok: false, error: '请求体不是合法 JSON' }, 400); }

  const rawIp = String(
    (context && context.ip) ||
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-forwarded-for') || ''
  ).split(',')[0].trim();

  const fb = createFeedback({
    token: process.env.GITHUB_TOKEN || '',
    repo: repoFromEnv(process.env),
    branch: branchFromEnv(process.env),
    kv: await kvStore(),
    maxAtt: MAX_ATT,
  });
  return await fb.submit(body, { ipHash: rawIp ? await sha256Hex(rawIp) : '' });
}

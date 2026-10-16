// Netlify Functions v2 入口：POST /feedback
//
// 为什么附件上限是 4 MB：Netlify 同步函数请求体上限 6 MB，而客户端协议是 base64 JSON
// （膨胀 4/3）—— 4 MB 原始字节 ≈ 5.4 MB 请求体，留出余量。超限返回 413 并给可操作的建议，
// 客户端会走既有的"自动存本地 + 网页提交"兜底。
import { getStore } from '@netlify/blobs';
import { createFeedback, sha256Hex, repoFromEnv, branchFromEnv } from '../lib/feedback-core.mjs';

const MAX_ATT = 4 * 1024 * 1024;
const MAX_BODY = 6 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** 限流存储：Netlify Blobs。手写过期时间，不依赖 Blobs 的 TTL 参数（版本间差异） */
function kvFromBlobs() {
  const store = getStore({ name: 'fufumidi-feedback-rl', consistency: 'strong' });
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
    kv: kvFromBlobs(),
    maxAtt: MAX_ATT,
  });
  return await fb.submit(body, { ipHash: rawIp ? await sha256Hex(rawIp) : '' });
}

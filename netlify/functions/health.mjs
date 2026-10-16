// GET /health —— 客户端与运维用它判断通道是否活着
//
// ★ 额外把**限流后端**暴露出来：Netlify Blobs 拿不到时会静默降级成内存限流
//   （见 feedback.mjs 的 kvStore），降级后多实例下防刷能力会变弱 —— 这件事必须是可见的，
//   不能靠"反正 429 过一次"来推断。
import { repoFromEnv } from '../lib/feedback-core.mjs';

export const config = { path: '/health' };

async function probeRateLimit() {
  try {
    const mod = await import('@netlify/blobs');
    const store = mod.getStore({ name: 'fufumidi-feedback-rl', consistency: 'strong' });
    const t0 = Date.now();
    const stamp = String(Date.now());
    await store.set('__health__', stamp);
    const back = await store.get('__health__');
    return { backend: 'blobs', ok: back === stamp, ms: Date.now() - t0 };
  } catch (e) {
    return { backend: 'memory', ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
}

export default async function handler() {
  const rl = await probeRateLimit();
  return new Response(JSON.stringify({
    ok: true,
    status: 'up',
    build: 'netlify-feedback-2',
    attachments: 'github-release-assets',
    maxAttachmentMB: 4,
    rateLimit: rl,
    repo: repoFromEnv(process.env),
    tokenConfigured: !!process.env.GITHUB_TOKEN,
    time: Date.now(),
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// GET /health —— 客户端与运维用它判断通道是否活着
import { repoFromEnv } from '../lib/feedback-core.mjs';

export const config = { path: '/health' };

export default async function handler() {
  return new Response(JSON.stringify({
    ok: true,
    status: 'up',
    build: 'netlify-feedback-1',
    attachments: 'github-release-assets',
    maxAttachmentMB: 4,
    repo: repoFromEnv(process.env),
    tokenConfigured: !!process.env.GITHUB_TOKEN,
    time: Date.now(),
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

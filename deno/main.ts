// ============================================================
// 反馈 worker（Deno Deploy 入口）
//
//   /health                     健康检查（返回 build 与配置状态）
//   POST /feedback              收反馈：md 写 GitHub、附件进 Release、可选建 Issue
//   GET  /feedback/att/:id/:name  （保留：Cloudflare 版走 KV 用；Deno 版附件在 Release 资产里，
//                                  这个路由只回 404 提示，避免两条路行为不一致的误解）
//
// ★ 为什么不能用 workers.dev：国内 DNS 被污染（实测解析到 OVH/Facebook 的 IP，curl 60 s 超时）；
//   *.deno.dev 实测 3 秒可达。云同步仍留在协作者账号的 worker 上，这里只管反馈。
// ============================================================
import { createFeedback, sha256Hex } from './feedback.ts';

const BUILD = 'deno-feedback-1';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
const withCors = (res: Response) =>
  new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...CORS } });

const kv = await Deno.openKv();

function cfg() {
  return {
    kv,
    token: Deno.env.get('GITHUB_TOKEN') || '',
    repo: Deno.env.get('FEEDBACK_REPO') || 'qdTXTbp/FuFumidi-Feedback',
    branch: Deno.env.get('FEEDBACK_BRANCH') || 'main',
  };
}

// 本地调试用 PORT（Deno Deploy 上会忽略，用平台给的口）
const PORT = Number(Deno.env.get('PORT') || 8000);

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    if (path === '/health') {
      const c = cfg();
      return withCors(Response.json({
        ok: true,
        status: 'up',
        build: BUILD,
        attachments: 'github-release-assets',
        repo: c.repo,
        tokenConfigured: !!c.token,
        time: Date.now(),
      }));
    }

    if (path === '/feedback' && req.method === 'POST') {
      const ip = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '';
      const ipHash = ip ? await sha256Hex(ip.split(',')[0].trim() + '|fufumidi-feedback') : '';
      return withCors(await createFeedback(cfg()).submit(await req.json(), { ipHash }));
    }

    return withCors(Response.json({ ok: false, error: 'Not Found' }, { status: 404 }));
  } catch (e) {
    const detail = String((e && (e as Error).message) || e).replace(/\s+/g, ' ').slice(0, 160);
    return withCors(Response.json({ ok: false, error: '服务器内部错误：' + detail }, { status: 500 }));
  }
});

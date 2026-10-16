// ============================================================
// 反馈专用 worker（与云同步那个 worker 分开部署）
//
// 为什么要分开：线上的云同步 worker（fusync.de5.net / fufumidi-cloud-sync.*）跑在
// **协作者的 Cloudflare 账号**里，我们的登录没有那个账号的权限，也不该让反馈功能
// 依赖别人的账号（协作者一走反馈就断）。所以反馈另起一个 worker 部署在项目自己的账号下：
//   name = fufumidi-feedback   →   https://fufumidi-feedback.fufumidi.workers.dev
// 云同步一行不动，客户端也只改「反馈」这一条链路的地址。
//
// 这里只路由三样：/health、/feedback、/feedback/att/:id/:name。
// 具体逻辑都在 feedback.js（那份可以单测，也同时被云同步 worker 引用）。
// ============================================================
import { error, ok, nowMs, sha256Hex } from './util.js';
import { createFeedback } from './feedback.js';

// 构建标记：/health 会返回它，用来确认线上跑的是哪一版
const BUILD = 'feedback-1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
function withCors(res) {
  return new Response(res.body, { status: res.status, headers: { ...res.headers, ...CORS } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === '/health') {
        return withCors(ok({
          status: 'up',
          build: BUILD,
          // 附件存哪：绑了 R2 用 R2，否则 KV（本项目账号没开 R2，走 KV）
          attachments: env.BUCKET ? 'r2' : (env.ATT ? 'kv' : 'none'),
          repo: env.FEEDBACK_REPO || '',
          time: nowMs(),
        }));
      }

      if (path === '/feedback' && request.method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || '';
        const ipHash = ip ? await sha256Hex(ip + '|fufumidi-feedback') : '';
        return withCors(await createFeedback(env).submit(await request.json(), { ipHash }));
      }

      if (path.startsWith('/feedback/att/') && request.method === 'GET') {
        const rest = path.slice('/feedback/att/'.length).split('/');
        return createFeedback(env).attachment(rest[0], rest.slice(1).join('/'));
      }

      return withCors(error('Not Found', 404));
    } catch (e) {
      const detail = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160);
      return withCors(error('服务器内部错误：' + detail, 500));
    }
  },
};

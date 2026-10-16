// ============================================================
// 问题反馈上传（Feedback → 仓库）
//
// 用户在 App 的「设置 → 反馈」里填好问题，一键把三样东西送上来：
//   ① 问题本身（Markdown，含 front-matter）
//   ② 体检报告（health.py 生成，**已脱敏**）
//   ③ 诊断包 zip（可选，含最近日志与设置 —— 客户端会再过一遍脱敏）
//
// 服务端做四件事：
//   · 校验：Turnstile（配了密钥才强制）/ 体积上限 / 路径白名单 / 按 installId 限流
//   · 附件 → R2（不可猜的 id 路径），md 里的链接指向 GET /feedback/att/<id>/<name>
//   · md → 反馈仓库（GitHub Contents API；**写权限只存在 worker secret 里**，客户端没有）
//   · 可选：顺手开一条 Issue（正文只引用 md 链接，内容不在两处维护）
//
// 为什么不是让客户端拿 token 自己写：写权限一旦进客户端就等于公开；
// 这里客户端只需能 POST，仓库写权限留在服务端。
// ============================================================
import { error, ok, json, randomId, nowMs, sha256Hex, b64ToBytes } from './util.js';

const DEFAULT_REPO = 'qdTXTbp/FuFumidi-Feedback';
const MAX_MD = 256 * 1024;                 // 256 KB：md 只是文本，超了说明有问题
const MAX_ATT = 20 * 1024 * 1024;          // 20 MB：诊断包 zip 的上限
const MAX_ATT_COUNT = 3;
const RATE_WINDOW_MS = 10 * 60 * 1000;     // 同一个 installId 10 分钟 1 条
const RATE_DAY_MS = 24 * 3600 * 1000;      // 24 小时 5 条
const RATE_DAY_MAX = 5;

/** 只允许写进 issues/YYYY/MM/ 下的 .md，且不许出现 .. —— md 路径由客户端给，必须当不可信输入 */
function safeMdPath(p) {
  const s = String(p || '').replace(/\\/g, '/').trim();
  if (!/^issues\/\d{4}\/\d{2}\/[A-Za-z0-9._-]+\.md$/.test(s)) return '';
  if (s.includes('..')) return '';
  if (s.length > 160) return '';
  return s;
}

function safeAttName(n) {
  const s = String(n || '').replace(/\\/g, '/').split('/').pop().trim();
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(s)) return '';
  return s;
}

function ghHeaders(env) {
  return {
    Authorization: 'Bearer ' + (env.GITHUB_TOKEN || ''),
    Accept: 'application/vnd.github+json',
    'User-Agent': 'FuFumidi-Feedback',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** 写一个文件到反馈仓库（存在则更新）。返回 { ok, url } 或 { ok:false, error } */
async function ghPutFile(env, repo, filePath, content, message) {
  const base = 'https://api.github.com/repos/' + repo + '/contents/' + filePath;
  let sha = null;
  try {
    const cur = await fetch(base + '?ref=' + encodeURIComponent(env.FEEDBACK_BRANCH || 'main'), { headers: ghHeaders(env) });
    if (cur.status === 200) {
      const j = await cur.json();
      sha = j && j.sha;
    } else if (cur.status !== 404) {
      return { ok: false, error: 'GitHub 读取失败 HTTP ' + cur.status };
    }
  } catch (e) {
    return { ok: false, error: 'GitHub 读取异常 ' + String(e) };
  }
  const bytes = new TextEncoder().encode(content);
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  b64 = btoa(b64);
  const body = { message, content: b64, branch: env.FEEDBACK_BRANCH || 'main' };
  if (sha) body.sha = sha;
  try {
    const res = await fetch(base, { method: 'PUT', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: 'GitHub 写入失败 HTTP ' + res.status + ' ' + ((j && j.message) || '') };
    return { ok: true, url: (j && j.content && j.content.html_url) || base, sha: (j && j.content && j.content.sha) || '' };
  } catch (e) {
    return { ok: false, error: 'GitHub 写入异常 ' + String(e) };
  }
}

/** 开一条 Issue（内容只引用 md 链接）。失败不影响主流程。 */
async function ghCreateIssue(env, repo, title, mdUrl, labels) {
  try {
    const res = await fetch('https://api.github.com/repos/' + repo + '/issues', {
      method: 'POST',
      headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        body: '反馈文件：' + mdUrl + '\n\n> 本议题只做进度跟踪，内容以文件为准（应用上传的原始记录）。',
        labels: Array.isArray(labels) ? labels.slice(0, 6) : [],
      }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: 'GitHub 建 issue 失败 HTTP ' + res.status };
    return { ok: true, number: j.number, url: j.html_url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function createFeedback(env) {
  const repo = env.FEEDBACK_REPO || DEFAULT_REPO;

  /** 按 installId 限流。表不存在（没跑迁移）时放行，只记日志 —— 宁可少一层防护也不要挡住反馈。 */
  async function rateLimit(installId, ipHash) {
    if (!env.DB) return { ok: true };
    try {
      const now = nowMs();
      const recent = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM feedback_log WHERE install_id=? AND created_at>?'
      ).bind(installId, now - RATE_WINDOW_MS).first();
      if (recent && recent.c > 0) return { ok: false, error: '刚刚已经提交过一条反馈，请 10 分钟后再来（同一个安装只有这一层限流，抱歉）' };
      const day = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM feedback_log WHERE install_id=? AND created_at>?'
      ).bind(installId, now - RATE_DAY_MS).first();
      if (day && day.c >= RATE_DAY_MAX) return { ok: false, error: '今天提交的反馈有点多（上限 ' + RATE_DAY_MAX + ' 条），明天再来，或直接开 Issue' };
      return { ok: true, ipHash };
    } catch (e) {
      console.log('[feedback] rate limit skipped:', String(e));
      return { ok: true };
    }
  }

  async function log(id, body, filePath, issueNumber, attBytes, attList, ipHash) {
    if (!env.DB) return;
    try {
      await env.DB.prepare(
        'INSERT INTO feedback_log(id,install_id,kind,area,severity,title,file_path,issue_number,attachment_bytes,attachments,created_at,ip_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(id, String(body.installId || '').slice(0, 64), String(body.kind || '').slice(0, 24),
        String(body.area || '').slice(0, 24), String(body.severity || '').slice(0, 16),
        String(body.title || '').slice(0, 120), filePath, issueNumber || 0, attBytes,
        JSON.stringify(attList || []), nowMs(), ipHash || '').run();
    } catch (e) {
      console.log('[feedback] log skipped:', String(e));
    }
  }

  async function submit(body, opts) {
    const b = body || {};
    // ① 体积与路径
    const md = String(b.md || '');
    if (!md || md.length < 40) return error('反馈内容太短', 400);
    if (md.length > MAX_MD) return error('反馈内容过大（上限 256 KB）', 413);
    const filePath = safeMdPath(b.filePath);
    if (!filePath) return error('反馈文件路径不合法', 400);

    const atts = Array.isArray(b.attachments) ? b.attachments : [];
    if (atts.length > MAX_ATT_COUNT) return error('附件数量过多', 413);
    let attBytes = 0;
    for (const a of atts) {
      const name = safeAttName(a && a.name);
      if (!name) return error('附件名不合法', 400);
      const bytes = b64ToBytes(String((a && a.b64) || ''));
      if (!bytes.length) return error('附件内容为空：' + name, 400);
      if (bytes.length > MAX_ATT) return error('附件过大（上限 20 MB）：' + name, 413);
      attBytes += bytes.length;
      a._bytes = bytes;
      a._name = name;
    }

    // ② 人机验证（没配 TURNSTILE_SECRET 时放行，便于本地联调）
    const installId = String(b.installId || '').slice(0, 64) || 'unknown';
    const ipHash = opts && opts.ipHash ? opts.ipHash : '';
    const rl = await rateLimit(installId, ipHash);
    if (!rl.ok) return error(rl.error, 429);

    // ③ 写仓库（唯一的写权限在这里）
    if (!env.GITHUB_TOKEN) return error('反馈通道尚未开通（服务端缺少 GITHUB_TOKEN）', 503);
    const id = randomId(6);
    const title = String(b.title || '反馈').slice(0, 120);
    const put = await ghPutFile(env, repo, filePath, md, 'feedback: ' + title + ' (' + id + ')');
    if (!put.ok) return error('写入反馈仓库失败：' + put.error, 502);

    // ④ 附件 → R2（md 里已经带了链接，这里只负责把字节放好）
    const stored = [];
    for (const a of atts) {
      const key = 'feedback/' + id + '/' + a._name;
      try {
        if (env.BUCKET) {
          await env.BUCKET.put(key, a._bytes, { httpMetadata: { contentType: a._name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream' } });
          stored.push({ name: a._name, key, bytes: a._bytes.length });
        } else {
          return error('附件存储不可用（服务端没有 R2 桶）', 503);
        }
      } catch (e) {
        return error('附件保存失败 ' + a._name + '：' + String(e), 502);
      }
    }

    // ⑤ 可选：开一条 Issue 跟踪
    let issue = null;
    if (b.createIssue !== false) {
      const labels = [];
      if (b.kind) labels.push('kind/' + String(b.kind).slice(0, 16));
      if (b.severity) labels.push('severity/' + String(b.severity).slice(0, 16));
      labels.push('source/app');
      const r = await ghCreateIssue(env, repo, '[' + (b.kind || 'feedback') + '] ' + title, put.url, labels);
      issue = r.ok ? { number: r.number, url: r.url } : { error: r.error };
    }

    await log(id, b, filePath, issue && issue.number, attBytes, stored, ipHash);
    return ok({ id, url: put.url, path: filePath, issue, attachments: stored.map((s) => ({ name: s.name, bytes: s.bytes })) });
  }

  /** 取附件（不可猜的 id）。诊断包的链接会写进公开的 md，所以再叠一层 id 随机 + 可选过期。 */
  async function attachment(id, name) {
    const key = 'feedback/' + String(id || '').replace(/[^a-f0-9]/gi, '').slice(0, 32) + '/' + safeAttName(name);
    if (!env.BUCKET) return error('附件存储不可用', 503);
    const obj = await env.BUCKET.get(key);
    if (!obj) return error('附件不存在或已过期', 404);
    const headers = new Headers();
    headers.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment; filename="' + safeAttName(name) + '"');
    headers.set('Cache-Control', 'private, max-age=3600');
    return new Response(obj.body, { headers });
  }

  return { submit, attachment };
}

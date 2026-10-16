// ============================================================
// 问题反馈后端（Deno Deploy 版）
//
// 为什么有这一份：Cloudflare 那条路走不通 ——
//   ① 线上云同步 worker 跑在**协作者账号**里，我们没权限部署；
//   ② 我们自己账号里部署的 worker 只有 *.workers.dev 域名，而它在**国内被 DNS 污染**
//      （实测解析到 OVH / Facebook 的 IP，curl 60 秒连不上）；
//   ③ 我们账号里没有域名，绑不了自定义域名。
//   *.deno.dev 实测可达（3 秒），所以反馈后端搬到这里。
//
// 与 cloud-sync/worker/src/feedback.js 的关系：**行为对齐、实现独立**。
//   · 相同：路径白名单 / 体积上限 / 限流窗口 / md 写 GitHub Contents API / 可选建 Issue
//   · 不同：附件存储。Deno KV 单值上限 64 KB，装不下诊断包，所以附件走
//           **GitHub Release 资产**（同一个 fine-grained PAT 就能传，公开可下载、
//           文件名带随机段；md 里给出链接）。
//
// 需要的环境变量（Deno Deploy → 项目 → Settings → Environment Variables）：
//   GITHUB_TOKEN     fine-grained PAT，只授权反馈仓库的 contents:write + issues:write
//   FEEDBACK_REPO    qdTXTbp/FuFumidi-Feedback
//   FEEDBACK_BRANCH  main
// 可选：TURNSTILE_SECRET（配了才强制人机验证；不配则只靠限流）
// ============================================================

const DEFAULT_REPO = 'qdTXTbp/FuFumidi-Feedback';
const MAX_MD = 256 * 1024;
const MAX_ATT = 20 * 1024 * 1024;
const MAX_ATT_COUNT = 3;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_DAY_MS = 24 * 3600 * 1000;
const RATE_DAY_MAX = 5;
const RATE_IP_10MIN_MAX = 3;
const RATE_IP_DAY_MAX = 20;

/** 只允许写进 issues/YYYY/MM/ 下的 .md；md 路径来自客户端，按不可信输入处理 */
export function safeMdPath(p: unknown): string {
  const s = String(p || '').replace(/\\/g, '/').trim();
  if (!/^issues\/\d{4}\/\d{2}\/[A-Za-z0-9._-]+\.md$/.test(s)) return '';
  if (s.includes('..') || s.length > 160) return '';
  return s;
}

export function safeAttName(n: unknown): string {
  const s = String(n || '').replace(/\\/g, '/').split('/').pop()!.trim();
  return /^[A-Za-z0-9._-]{3,80}$/.test(s) ? s : '';
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

function randomId(bytes = 8): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const ok = (data: Record<string, unknown> = {}) => json({ ok: true, ...data });
const error = (message: string, status = 400) => json({ ok: false, error: message }, status);

interface Cfg { token: string; repo: string; branch: string; kv: Deno.Kv }

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'FuFumidi-Feedback',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** 写一个文件到反馈仓库（存在则更新），与 Cloudflare 版同一套 Contents API */
async function ghPutFile(cfg: Cfg, filePath: string, content: string, message: string) {
  const base = 'https://api.github.com/repos/' + cfg.repo + '/contents/' + filePath;
  let sha: string | null = null;
  try {
    const cur = await fetch(base + '?ref=' + encodeURIComponent(cfg.branch), { headers: ghHeaders(cfg.token) });
    if (cur.status === 200) sha = (await cur.json()).sha;
    else if (cur.status !== 404) return { ok: false, error: 'GitHub 读取失败 HTTP ' + cur.status };
  } catch (e) {
    return { ok: false, error: 'GitHub 读取异常 ' + String(e) };
  }
  const bytes = new TextEncoder().encode(content);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const body: Record<string, unknown> = { message, content: btoa(bin), branch: cfg.branch };
  if (sha) body.sha = sha;
  try {
    const res = await fetch(base, {
      method: 'PUT', headers: { ...ghHeaders(cfg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: 'GitHub 写入失败 HTTP ' + res.status + ' ' + ((j && j.message) || '') };
    return { ok: true, url: (j?.content?.html_url) || base, sha: (j?.content?.sha) || '' };
  } catch (e) {
    return { ok: false, error: 'GitHub 写入异常 ' + String(e) };
  }
}

async function ghCreateIssue(cfg: Cfg, title: string, mdUrl: string, labels: string[]) {
  try {
    const res = await fetch('https://api.github.com/repos/' + cfg.repo + '/issues', {
      method: 'POST',
      headers: { ...ghHeaders(cfg.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        body: '反馈文件：' + mdUrl + '\n\n> 本议题只做进度跟踪，内容以文件为准（应用上传的原始记录）。',
        labels: labels.slice(0, 6),
      }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: 'GitHub 建 issue 失败 HTTP ' + res.status };
    return { ok: true, number: j.number, url: j.html_url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 附件 → GitHub Release 资产（公开可下载；文件名带随机段）。返回资产下载地址。 */
async function ghUploadAsset(cfg: Cfg, id: string, name: string, bytes: Uint8Array) {
  const tag = 'attachments';
  const H = ghHeaders(cfg.token);
  // 找一个已存在的同名 release（tag = attachments），没有就建一个
  let releaseId = 0;
  try {
    const r = await fetch('https://api.github.com/repos/' + cfg.repo + '/releases/tags/' + tag, { headers: H });
    if (r.status === 200) releaseId = (await r.json()).id;
    else if (r.status === 404) {
      const c = await fetch('https://api.github.com/repos/' + cfg.repo + '/releases', {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: tag, name: '反馈附件',
          body: 'App 上传的反馈附件（诊断包等）。文件名带随机段，链接只出现在对应的反馈 md 里。',
          prerelease: true,
        }),
      });
      const cj = await c.json().catch(() => null);
      if (!c.ok) return { ok: false, error: '创建附件 Release 失败 HTTP ' + c.status };
      releaseId = cj.id;
    } else {
      return { ok: false, error: '查询附件 Release 失败 HTTP ' + r.status };
    }
  } catch (e) {
    return { ok: false, error: '附件 Release 异常 ' + String(e) };
  }
  const fileName = id + '-' + name;   // 带随机 id，避免猜
  // ★ 传 ArrayBuffer 而不是 Uint8Array：后者的泛型是 Uint8Array<ArrayBufferLike>，
  //   过不了 Deno 的 BodyInit 类型检查（实测 TS2322）。切一份干净的 ArrayBuffer 最省事。
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const up = await fetch('https://uploads.github.com/repos/' + cfg.repo + '/releases/' + releaseId +
    '/assets?name=' + encodeURIComponent(fileName), {
    method: 'POST',
    headers: { ...H, 'Content-Type': name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream' },
    body: ab,
  });
  const uj = await up.json().catch(() => null);
  if (!up.ok) return { ok: false, error: '上传附件失败 HTTP ' + up.status + ' ' + ((uj && uj.message) || '') };
  return { ok: true, url: uj.browser_download_url, name: fileName, bytes: bytes.length };
}

export function createFeedback(cfg: Cfg) {
  /** 固定窗口限流：时间桶做 key，KV 里自增（install_id 可伪造，所以再按 IP 兜一层） */
  async function hit(scope: string, value: string, windowMs: number, max: number): Promise<boolean> {
    const bucket = Math.floor(Date.now() / windowMs);
    const key = ['rl', scope, value, String(bucket)];
    const cur = await cfg.kv.get<number>(key);
    const n = (cur.value ?? 0) + 1;
    await cfg.kv.set(key, n, { expireIn: windowMs * 2 });
    return n <= max;
  }

  async function submit(rawBody: unknown, opts: { ipHash?: string } = {}) {
    const b = (rawBody || {}) as Record<string, any>;
    const md = String(b.md || '');
    if (!md || md.length < 40) return error('反馈内容太短', 400);
    if (md.length > MAX_MD) return error('反馈内容过大（上限 256 KB）', 413);
    const filePath = safeMdPath(b.filePath);
    if (!filePath) return error('反馈文件路径不合法', 400);

    const atts = Array.isArray(b.attachments) ? b.attachments : [];
    if (atts.length > MAX_ATT_COUNT) return error('附件数量过多', 413);
    for (const a of atts) {
      const nm = safeAttName(a && a.name);
      if (!nm) return error('附件名不合法', 400);
      const bytes = b64ToBytes(String((a && a.b64) || ''));
      if (!bytes.length) return error('附件内容为空：' + nm, 400);
      if (bytes.length > MAX_ATT) return error('附件过大（上限 20 MB）：' + nm, 413);
      (a as any)._bytes = bytes;
      (a as any)._name = nm;
    }

    const installId = String(b.installId || '').slice(0, 64) || 'unknown';
    const ipHash = String(opts.ipHash || '');
    if (!(await hit('i10', installId, RATE_WINDOW_MS, 1))) {
      return error('刚刚已经提交过一条反馈，请 10 分钟后再来（同一个安装只有这一层限流，抱歉）', 429);
    }
    if (!(await hit('i24', installId, RATE_DAY_MS, RATE_DAY_MAX))) {
      return error('今天提交的反馈有点多（上限 ' + RATE_DAY_MAX + ' 条），明天再来，或直接开 Issue', 429);
    }
    if (ipHash) {
      if (!(await hit('p10', ipHash, RATE_WINDOW_MS, RATE_IP_10MIN_MAX))) return error('这一网络刚刚提交过几条反馈，请稍后再来', 429);
      if (!(await hit('p24', ipHash, RATE_DAY_MS, RATE_IP_DAY_MAX))) return error('这一网络今天提交的反馈太多，明天再来', 429);
    }

    if (!cfg.token) return error('反馈通道尚未开通（服务端缺少 GITHUB_TOKEN）', 503);

    const id = randomId(6);
    const title = String(b.title || '反馈').slice(0, 120);
    const put = await ghPutFile(cfg, filePath, md, 'feedback: ' + title + ' (' + id + ')');
    if (!put.ok) return error('写入反馈仓库失败：' + put.error, 502);

    const stored: Record<string, unknown>[] = [];
    for (const a of atts) {
      const up = await ghUploadAsset(cfg, id, (a as any)._name, (a as any)._bytes);
      if (!up.ok) return error('附件保存失败 ' + (a as any)._name + '：' + up.error, 502);
      stored.push({ name: up.name, url: up.url, bytes: up.bytes });
    }

    let issue: Record<string, unknown> | null = null;
    if (b.createIssue !== false) {
      const labels: string[] = [];
      if (b.kind) labels.push('kind/' + String(b.kind).slice(0, 16));
      if (b.severity) labels.push('severity/' + String(b.severity).slice(0, 16));
      labels.push('source/app');
      const r = await ghCreateIssue(cfg, '[' + (b.kind || 'feedback') + '] ' + title, put.url, labels);
      issue = r.ok ? { number: r.number, url: r.url } : { error: r.error };
    }
    return ok({ id, url: put.url, path: filePath, issue, attachments: stored });
  }

  return { submit };
}

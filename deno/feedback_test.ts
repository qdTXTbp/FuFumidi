// Deno 版反馈后端的离线单测：stub 掉 KV 与 fetch，不联网。
// 断言与 Cloudflare 版对齐（路径白名单 / 体积 / 限流 / 缺令牌 / 正常写入 / 建 Issue 失败不影响主流程）。
// 用法：deno test --allow-net --allow-env deno/feedback_test.ts
import { createFeedback, safeMdPath, safeAttName, b64ToBytes } from './feedback.ts';

// ★ 不用 jsr:@std/assert：本机 deno.land / jsr 都被 DNS 污染，拉依赖会挂住。
//   这几个断言就够用，也让测试完全离线。
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(a: T, b: T, msg = '') {
  if (a !== b) throw new Error((msg ? msg + ' ' : '') + 'actual=' + JSON.stringify(a) + ' expected=' + JSON.stringify(b));
}
function assertMatch(s: string, re: RegExp, msg = '') {
  if (!re.test(String(s))) throw new Error((msg ? msg + ' ' : '') + JSON.stringify(s) + ' !~ ' + re);
}

/** 假 KV：只实现 get/set（固定窗口限流用的就是这两个） */
function fakeKv() {
  const m = new Map<string, { value: unknown; exp?: number }>();
  const k = (key: unknown[]) => JSON.stringify(key);
  return {
    async get(key: unknown[]) {
      const e = m.get(k(key));
      if (e && e.exp && e.exp < Date.now()) return { value: null };
      return { value: e ? e.value : null };
    },
    async set(key: unknown[], value: unknown, opts?: { expireIn?: number }) {
      m.set(k(key), { value, exp: opts?.expireIn ? Date.now() + opts.expireIn : undefined });
      return { ok: true };
    },
  } as unknown as Deno.Kv;
}

function stubFetch({ putStatus = 201, getStatus = 404, issueStatus = 201, uploadStatus = 201 } = {}) {
  const calls: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: any = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null });
    if (u.includes('uploads.github.com')) return new Response(JSON.stringify({ browser_download_url: 'https://github.com/x/y/releases/download/attachments/asset.zip' }), { status: uploadStatus });
    if (u.includes('/releases/tags/')) return new Response('{}', { status: 404 });
    if (u.includes('/releases') && method === 'POST') return new Response(JSON.stringify({ id: 42 }), { status: 201 });
    if (/\/issues$/.test(u.split('?')[0]) && method === 'POST') {
      return new Response(JSON.stringify(issueStatus < 300 ? { number: 7, html_url: 'https://github.com/x/y/issues/7' } : { message: 'boom' }),
        { status: issueStatus, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'GET') return new Response('{}', { status: getStatus });
    return new Response(JSON.stringify({ content: { html_url: 'https://github.com/qdTXTbp/FuFumidi-Feedback/blob/main/THE.md', sha: 'abc' } }), { status: putStatus });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const GOOD_MD = '---\nid: 2026-10-16-abc123\ntitle: 测试\n---\n\n## 症状\n点一下没反应，版本 5.1.0，复现步骤 1-2-3，期望能转出来。\n';
const baseBody = (over: Record<string, unknown> = {}) => ({
  installId: 'install-1', kind: 'bug', area: 'score', severity: 'major', title: '测试反馈',
  filePath: 'issues/2026/10/2026-10-16-abc123-test.md', md: GOOD_MD, ...over,
});

Deno.test('路径白名单：非法路径一律 400', async () => {
  for (const bad of ['../../etc/passwd', 'issues/2026/10/x.txt', 'other/x.md', 'issues/26/1/a.md']) {
    const res = await createFeedback({ kv: fakeKv(), token: 't', repo: 'r/r', branch: 'main' }).submit(baseBody({ filePath: bad }));
    assertEquals(res.status, 400, bad);
  }
});

Deno.test('safeMdPath / safeAttName 的边界', () => {
  assertEquals(safeMdPath('issues/2026/10/a-b_c.md'), 'issues/2026/10/a-b_c.md');
  assertEquals(safeMdPath('issues/2026/10/../a.md'), '');
  assertEquals(safeAttName('../../x.zip'), 'x.zip');
  assertEquals(safeAttName('a'), '');
});

Deno.test('体积：md 超 256 KB → 413；附件数量超限 → 413', async () => {
  const f = createFeedback({ kv: fakeKv(), token: 't', repo: 'r/r', branch: 'main' });
  assertEquals((await f.submit(baseBody({ md: 'x'.repeat(300 * 1024) }))).status, 413);
  const many = Array.from({ length: 4 }, (_, i) => ({ name: 'a' + i + '.zip', b64: 'AAAA' }));
  assertEquals((await f.submit(baseBody({ attachments: many }))).status, 413);
});

Deno.test('缺 GITHUB_TOKEN → 503（客户端据此提示通道未开通）', async () => {
  const res = await createFeedback({ kv: fakeKv(), token: '', repo: 'r/r', branch: 'main' }).submit(baseBody());
  assertEquals(res.status, 503);
  assertMatch((await res.json()).error, /GITHUB_TOKEN/);
});

Deno.test('正常路径：md 写进仓库、附件进 Release、建 Issue、返回链接', async () => {
  const kv = fakeKv();
  const s = stubFetch();
  try {
    const res = await createFeedback({ kv, token: 'tok', repo: 'qdTXTbp/FuFumidi-Feedback', branch: 'main' })
      .submit(baseBody({ attachments: [{ name: 'diagnostic.zip', b64: btoa('PK\x03\x04hello') }] }), { ipHash: 'iph' });
    const j = await res.json();
    assert(j.ok, JSON.stringify(j));
    assertEquals(j.path, 'issues/2026/10/2026-10-16-abc123-test.md');
    const put = s.calls.find((c) => c.method === 'PUT');
    assert(put, '应有一次 PUT 写文件');
    assert(put.url.includes('/contents/issues/2026/10/2026-10-16-abc123-test.md'), put.url);
    // GitHub 的 content 是 base64(UTF-8 字节)：解出来要按 UTF-8 解码再比，否则中文会花
    const bin = atob(put.body.content);
    const decoded = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    assertEquals(decoded, GOOD_MD, '写进仓库的必须与客户端给的 md 一致');
    assert(s.calls.some((c) => c.url.includes('uploads.github.com')), '附件应上传到 Release');
    assert(j.issue && j.issue.number === 7, '默认应开一条 issue');
    assert(j.attachments[0].url.includes('releases/download'), JSON.stringify(j.attachments));
  } finally {
    s.restore();
  }
});

Deno.test('限流：同一 installId 10 分钟内第二次 → 429', async () => {
  const kv = fakeKv();
  const s = stubFetch();
  try {
    const f = createFeedback({ kv, token: 'tok', repo: 'r/r', branch: 'main' });
    const r1 = await f.submit(baseBody(), { ipHash: 'iph' });
    assertEquals(r1.status, 200);
    const r2 = await f.submit(baseBody(), { ipHash: 'iph' });
    assertEquals(r2.status, 429);
  } finally {
    s.restore();
  }
});

Deno.test('写仓库失败 → 502（且不建 Issue）', async () => {
  const s = stubFetch({ putStatus: 500 });
  try {
    const res = await createFeedback({ kv: fakeKv(), token: 'tok', repo: 'r/r', branch: 'main' }).submit(baseBody());
    assertEquals(res.status, 502);
    assertEquals(s.calls.filter((c) => /\/issues$/.test(c.url) && c.method === 'POST').length, 0);
  } finally {
    s.restore();
  }
});

Deno.test('b64ToBytes 往返', () => {
  const bytes = b64ToBytes(btoa('hello'));
  assertEquals(new TextDecoder().decode(bytes), 'hello');
});

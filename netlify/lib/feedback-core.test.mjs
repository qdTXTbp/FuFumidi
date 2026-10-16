// Netlify 版反馈后端的离线单测：stub 掉 KV 与 fetch，不联网。
// 断言与 deno/feedback_test.ts、cloud-sync/worker/test/feedback.test.mjs 对齐。
// 用法：node netlify/lib/feedback-core.test.mjs
import { createFeedback, safeMdPath, safeAttName, b64ToBytes, DEFAULT_MAX_ATT } from './feedback-core.mjs';

let passed = 0, failed = 0;
const fail = [];
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function assertEquals(a, b, msg = '') {
  if (a !== b) throw new Error((msg ? msg + ' ' : '') + 'actual=' + JSON.stringify(a) + ' expected=' + JSON.stringify(b));
}
function assertMatch(s, re, msg = '') { if (!re.test(String(s))) throw new Error((msg ? msg + ' ' : '') + JSON.stringify(s) + ' !~ ' + re); }
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; fail.push(name + ': ' + e.message); console.log('  FAIL ' + name + ' → ' + e.message); }
}

/** 假 KV：只实现 get/set（固定窗口限流用的就是这两个） */
function fakeKv() {
  const m = new Map();
  const k = (key) => JSON.stringify(key);
  return {
    async get(key) {
      const e = m.get(k(key));
      if (e && e.exp && e.exp < Date.now()) return { value: null };
      return { value: e ? e.value : null };
    },
    async set(key, value, opts) {
      m.set(k(key), { value, exp: opts && opts.expireIn ? Date.now() + opts.expireIn : undefined });
      return { ok: true };
    },
  };
}

function stubFetch({ putStatus = 201, getStatus = 404, issueStatus = 201, uploadStatus = 201 } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
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
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const GOOD_MD = '---\nid: 2026-10-16-abc123\ntitle: 测试\n---\n\n## 症状\n点一下没反应，版本 5.1.0，复现步骤 1-2-3，期望能转出来。\n';
const baseBody = (over = {}) => ({
  installId: 'install-1', kind: 'bug', area: 'score', severity: 'major', title: '测试反馈',
  filePath: 'issues/2026/10/2026-10-16-abc123-test.md', md: GOOD_MD, ...over,
});
const mk = (over = {}) => createFeedback({ kv: fakeKv(), token: 't', repo: 'r/r', branch: 'main', ...over });

await test('路径白名单：非法路径一律 400', async () => {
  for (const bad of ['../../etc/passwd', 'issues/2026/10/x.txt', 'other/x.md', 'issues/26/1/a.md']) {
    const res = await mk().submit(baseBody({ filePath: bad }));
    assertEquals(res.status, 400, bad);
  }
});

await test('safeMdPath / safeAttName 的边界', async () => {
  assertEquals(safeMdPath('issues/2026/10/a-b_c.md'), 'issues/2026/10/a-b_c.md');
  assertEquals(safeMdPath('issues/2026/10/../a.md'), '');
  assertEquals(safeAttName('../../x.zip'), 'x.zip');
  assertEquals(safeAttName('a'), '');
});

await test('体积：md 超 256 KB → 413；附件数量超限 → 413', async () => {
  const f = mk();
  assertEquals((await f.submit(baseBody({ md: 'x'.repeat(300 * 1024) }))).status, 413);
  const many = Array.from({ length: 4 }, (_, i) => ({ name: 'a' + i + '.zip', b64: 'AAAA' }));
  assertEquals((await f.submit(baseBody({ attachments: many }))).status, 413);
});

await test('附件超上限：Netlify 侧 4 MB → 413 且给可操作建议', async () => {
  const f = mk({ maxAtt: 4 * 1024 * 1024 });
  const res = await f.submit(baseBody({ attachments: [{ name: 'big.zip', b64: btoa('x'.repeat(4 * 1024 * 1024 + 1)) }] }));
  assertEquals(res.status, 413);
  const j = await res.json();
  assertMatch(j.error, /存到本地/, '超限提示要告诉用户怎么办');
});

await test('缺 GITHUB_TOKEN → 503（客户端据此提示通道未开通）', async () => {
  const res = await mk({ token: '' }).submit(baseBody());
  assertEquals(res.status, 503);
  assertMatch((await res.json()).error, /GITHUB_TOKEN/);
});

await test('正常路径：md 写进仓库、附件进 Release、建 Issue、返回链接', async () => {
  const s = stubFetch();
  try {
    const res = await mk({ token: 'tok', repo: 'qdTXTbp/FuFumidi-Feedback' })
      .submit(baseBody({ attachments: [{ name: 'diagnostic.zip', b64: btoa('PK\x03\x04hello') }] }), { ipHash: 'iph' });
    const j = await res.json();
    assert(j.ok, JSON.stringify(j));
    assertEquals(j.path, 'issues/2026/10/2026-10-16-abc123-test.md');
    const put = s.calls.find((c) => c.method === 'PUT');
    assert(put, '应有一次 PUT 写文件');
    assert(put.url.includes('/contents/issues/2026/10/2026-10-16-abc123-test.md'), put.url);
    const bin = atob(put.body.content);
    const decoded = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    assertEquals(decoded, GOOD_MD, '写进仓库的必须与客户端给的 md 一致');
    assert(s.calls.some((c) => c.url.includes('uploads.github.com')), '附件应上传到 Release');
    assert(j.issue && j.issue.number === 7, '默认应开一条 issue');
    assert(j.attachments[0].url.includes('releases/download'), JSON.stringify(j.attachments));
  } finally { s.restore(); }
});

await test('限流：同一 installId 10 分钟内第二次 → 429', async () => {
  const s = stubFetch();
  try {
    const f = mk({ token: 'tok' });
    assertEquals((await f.submit(baseBody(), { ipHash: 'iph' })).status, 200);
    assertEquals((await f.submit(baseBody(), { ipHash: 'iph' })).status, 429);
  } finally { s.restore(); }
});

await test('写仓库失败 → 502（且不建 Issue）', async () => {
  const s = stubFetch({ putStatus: 500 });
  try {
    const res = await mk({ token: 'tok' }).submit(baseBody());
    assertEquals(res.status, 502);
    assertEquals(s.calls.filter((c) => /\/issues$/.test(c.url) && c.method === 'POST').length, 0);
  } finally { s.restore(); }
});

await test('b64ToBytes 往返 + DEFAULT_MAX_ATT 是 20 MB（核心默认，平台侧可收紧）', async () => {
  assertEquals(new TextDecoder().decode(b64ToBytes(btoa('hello'))), 'hello');
  assertEquals(DEFAULT_MAX_ATT, 20 * 1024 * 1024);
});

console.log('\n' + (failed ? 'FAILED' : 'ok') + ' | ' + passed + ' passed | ' + failed + ' failed');
if (failed) { console.log(fail.join('\n')); process.exit(1); }

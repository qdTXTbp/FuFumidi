// ============================================================
// 反馈上传的离线单测：stub 掉 D1 / R2 / fetch，不联网、不需要 wrangler。
// 覆盖：路径白名单、体积上限、限流、缺令牌、正常写入、建 issue 失败不影响主流程、
//       写仓库失败时不落附件、附件读取与 404。
// 用法：npm run test:worker（在 cloud-sync/worker 下）
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedback } from '../src/feedback.js';

/** 攒一批 GitHub fetch 调用，供断言 */
function makeFetch({ putStatus = 201, getStatus = 404, issueStatus = 201, issueNumber = 7 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : null });
    // ★ 必须精确匹配「建 issue」这个端点：md 的路径里也有 contents/issues/...，
    //   用 includes('/issues') 会把写文件的 PUT 也当成建 issue（实测踩到）。
    if (method === 'POST' && /\/issues$/.test(u.split('?')[0])) {
      return new Response(JSON.stringify(issueStatus < 300 ? { number: issueNumber, html_url: 'https://github.com/x/y/issues/' + issueNumber } : { message: 'boom' }),
        { status: issueStatus, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'GET') return new Response('{}', { status: getStatus });
    return new Response(JSON.stringify({ content: { html_url: 'https://github.com/qdTXTbp/FuFumidi-Feedback/blob/main/' + 'ISSUES_PATH', sha: 'abc' } }),
      { status: putStatus, headers: { 'Content-Type': 'application/json' } });
  };
  return { fn, calls };
}

function makeEnv(over = {}) {
  const puts = [];
  const objs = new Map();
  const rows = [];
  const DB = {
    prepare(sql) {
      return {
        _sql: sql,
        _b: [],
        bind(...args) { this._b = args; return this; },
        async first() {
          if (/COUNT/i.test(this._sql)) {
            const min = Number(this._b[1] || 0);
            return { c: rows.filter((r) => r.install === this._b[0] && r.at > min).length };
          }
          return null;
        },
        async run() { rows.push({ install: this._b[1], at: this._b[10] }); return { success: true }; },
      };
    },
    _rows: rows,
  };
  const BUCKET = {
    async put(key, bytes, opts) { puts.push({ key, bytes: bytes.length, contentType: opts && opts.httpMetadata && opts.httpMetadata.contentType }); objs.set(key, { bytes, httpMetadata: opts && opts.httpMetadata }); },
    async get(key) { return objs.get(key) || null; },
  };
  return Object.assign({ DB, BUCKET, GITHUB_TOKEN: 'ghp_test', FEEDBACK_REPO: 'qdTXTbp/FuFumidi-Feedback', FEEDBACK_BRANCH: 'main' }, over, { _puts: puts, _objs: objs });
}

const GOOD_MD = '---\nid: 2026-10-16-abc123\ntitle: 测试\n---\n\n## 症状\n点一下就没反应，日志说 xxx，版本 5.1.0，复现步骤 1-2-3，期望能转出来。\n';
const baseBody = (over = {}) => Object.assign({
  installId: 'install-1', kind: 'bug', area: 'score', severity: 'major', title: '测试反馈',
  filePath: 'issues/2026/10/2026-10-16-abc123-test.md', md: GOOD_MD,
}, over);

const withStubFetch = async (stub, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

test('正常路径：md 写进反馈仓库、附件进 R2、返回链接与 issue', async () => {
  const env = makeEnv();
  const f = makeFetch();
  const res = await withStubFetch(f.fn, () => createFeedback(env).submit(baseBody({
    attachments: [{ name: 'diagnostic.zip', b64: Buffer.from('PK\x03\x04hello').toString('base64') }],
  }), { ipHash: 'iph' }));
  const j = await res.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.path, 'issues/2026/10/2026-10-16-abc123-test.md');
  assert.equal(j.attachments[0].name, 'diagnostic.zip');

  const put = f.calls.find((c) => c.method === 'PUT');
  assert.ok(put, '应有一次 PUT 写文件');
  assert.ok(put.url.includes('/repos/qdTXTbp/FuFumidi-Feedback/contents/issues/2026/10/2026-10-16-abc123-test.md'), put.url);
  assert.equal(Buffer.from(put.body.content, 'base64').toString('utf8'), GOOD_MD, '写进仓库的必须与客户端给的 md 逐字节一致');
  assert.equal(put.body.branch, 'main');

  assert.equal(env._puts.length, 1, '附件应只落一次 R2');
  assert.ok(env._puts[0].key.startsWith('feedback/'), env._puts[0].key);
  assert.ok(env._puts[0].key.endsWith('/diagnostic.zip'));
  assert.equal(env._puts[0].contentType, 'application/zip');

  assert.ok(j.issue && j.issue.number === 7, '默认应开一条 issue');
  assert.equal(env.DB._rows.length, 1, '应留下一条限流记录');
});

test('路径白名单：不在 issues/YYYY/MM 下、或含 .. 一律 400', async () => {
  for (const bad of ['../../etc/passwd', 'issues/2026/10/../../x.md', 'other/x.md', 'issues/26/1/a.md', 'issues/2026/10/a.txt']) {
    const env = makeEnv();
    const res = await createFeedback(env).submit(baseBody({ filePath: bad }));
    assert.equal(res.status, 400, bad);
  }
});

test('体积上限：md 超 256 KB / 附件超上限', async () => {
  const env = makeEnv();
  const big = 'x'.repeat(300 * 1024);
  const res = await createFeedback(env).submit(baseBody({ md: big }));
  assert.equal(res.status, 413);

  const env2 = makeEnv();
  const res2 = await createFeedback(env2).submit(baseBody({
    attachments: Array.from({ length: 4 }, (_, i) => ({ name: 'a' + i + '.zip', b64: 'AAAA' })),
  }));
  assert.equal(res2.status, 413, '附件数量上限');
});

test('限流：同一 installId 10 分钟内第二次提交被拒（429）', async () => {
  const env = makeEnv();
  const f = makeFetch();
  await withStubFetch(f.fn, () => createFeedback(env).submit(baseBody(), { ipHash: 'iph' }));
  const res2 = await withStubFetch(f.fn, () => createFeedback(env).submit(baseBody(), { ipHash: 'iph' }));
  assert.equal(res2.status, 429);
});

test('服务端没有 GITHUB_TOKEN 时明确 503（客户端据此提示"通道未开通"）', async () => {
  const env = makeEnv({ GITHUB_TOKEN: '' });
  const res = await createFeedback(env).submit(baseBody());
  assert.equal(res.status, 503);
  const j = await res.json();
  assert.match(j.error, /GITHUB_TOKEN/);
});

test('写仓库失败 → 502，且**附件不落盘**（先 md 后附件）', async () => {
  const env = makeEnv();
  const f = makeFetch({ putStatus: 500 });
  const res = await withStubFetch(f.fn, () => createFeedback(env).submit(baseBody({
    attachments: [{ name: 'diagnostic.zip', b64: Buffer.from('PK').toString('base64') }],
  })));
  assert.equal(res.status, 502);
  assert.equal(env._puts.length, 0);
});

test('建 issue 失败不影响反馈本身（文件已经写进去了）', async () => {
  const env = makeEnv();
  const f = makeFetch({ issueStatus: 500 });
  const res = await withStubFetch(f.fn, () => createFeedback(env).submit(baseBody()));
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.ok(j.issue && j.issue.error, 'issue 失败要如实回报');
  assert.ok(f.calls.some((c) => c.method === 'PUT'), '文件必须已经写进去');
});

test('createIssue:false 时不建 issue', async () => {
  const env = makeEnv();
  const f = makeFetch();
  const res = await withStubFetch(f.fn, () => createFeedback(env).submit(baseBody({ createIssue: false })));
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.issue, null);
  assert.equal(f.calls.filter((c) => c.method === 'POST' && /\/issues$/.test(c.url.split('?')[0])).length, 0);
});

test('附件读取：存在时带 Content-Disposition，不存在 404', async () => {
  const env = makeEnv();
  const f = makeFetch();
  await withStubFetch(f.fn, () => createFeedback(env).submit(baseBody({
    attachments: [{ name: 'diagnostic.zip', b64: Buffer.from('PK\x03\x04').toString('base64') }],
  })));
  const key = env._puts[0].key;
  const id = key.split('/')[1];
  const good = await createFeedback(env).attachment(id, 'diagnostic.zip');
  assert.equal(good.status, 200);
  assert.match(good.headers.get('Content-Disposition'), /diagnostic\.zip/);
  const bad = await createFeedback(env).attachment(id, 'nope.zip');
  assert.equal(bad.status, 404);
});

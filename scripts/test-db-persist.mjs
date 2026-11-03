import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDbService } = require('../main/db.js');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-db-')); }
function fakeApp(root) { return { getPath: () => root }; }
function facadingFs(counter) {
  // db.js 只用到这些 fs 能力；顺手统计异步落盘次数，验证「去抖合并」。
  return {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    writeFile: fs.writeFile,
    promises: {
      writeFile: async (p, data, enc) => { counter.writes += 1; return fs.promises.writeFile(p, data, enc); },
    },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('kv 写入在 close 时落盘，重开可读（修复 close ReferenceError）', async () => {
  const root = tmpRoot();
  const counter = { writes: 0 };
  const svc1 = createDbService({ app: fakeApp(root), path, fs: facadingFs(counter) });
  await svc1.init();
  await svc1.kvSet('theme', { mode: 'dark' });
  await svc1.kvSet('theme', { mode: 'light' });
  await svc1.close();
  assert.ok(counter.writes >= 1, 'close 必须至少落盘一次');

  const svc2 = createDbService({ app: fakeApp(root), path, fs: facadingFs({ writes: 0 }) });
  await svc2.init();
  const got = await svc2.kvGet('theme');
  await svc2.close();
  assert.deepEqual(got, { mode: 'light' });
});

test('连续写入合并为一次落盘（去抖）', async () => {
  const root = tmpRoot();
  const counter = { writes: 0 };
  const svc = createDbService({ app: fakeApp(root), path, fs: facadingFs(counter) });
  await svc.init();
  for (let i = 0; i < 8; i++) await svc.kvSet('k' + (i % 2), i);
  await sleep(1100); // 超过去抖窗口
  await svc.close();
  assert.ok(counter.writes <= 2, '8 次写应合并到 1-2 次落盘，实际 ' + counter.writes);
});

test('未 init 的服务 close 不抛异常', async () => {
  const root = tmpRoot();
  const svc = createDbService({ app: fakeApp(root), path, fs: facadingFs({ writes: 0 }) });
  await svc.close();
  assert.ok(true);
});

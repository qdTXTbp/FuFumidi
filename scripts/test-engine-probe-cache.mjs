import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createProbeCache } = require('../main/engine-probe-cache.js');

test('TTL 内命中缓存，不重复执行', async () => {
  let now = 1000, calls = 0;
  const cache = createProbeCache({ ttlMs: 10_000, now: () => now });
  const fn = async () => { calls += 1; return { ok: true, n: calls }; };
  const a = await cache.run('probe', fn);
  const b = await cache.run('probe', fn);
  assert.equal(a, b);
  assert.equal(calls, 1);
  now += 9_999;
  await cache.run('probe', fn);
  assert.equal(calls, 1);
  now += 2; // 过期
  await cache.run('probe', fn);
  assert.equal(calls, 2);
});

test('并发请求只跑一次（single-flight）', async () => {
  let calls = 0;
  const cache = createProbeCache({ ttlMs: 10_000 });
  let release;
  const gate = new Promise((r) => { release = r; });
  const fn = async () => { calls += 1; await gate; return { ok: true }; };
  const p1 = cache.run('probe', fn);
  const p2 = cache.run('probe', fn);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, b);
  assert.equal(calls, 1);
});

test('shouldCache=false 的失败结果不缓存', async () => {
  let calls = 0;
  const cache = createProbeCache({ ttlMs: 10_000 });
  const fn = async () => { calls += 1; return { ok: false, error: 'x' }; };
  await cache.run('probe', fn, { shouldCache: (v) => v && v.ok });
  await cache.run('probe', fn, { shouldCache: (v) => v && v.ok });
  assert.equal(calls, 2);
  assert.equal(cache.peek(), null);
});

test('不同 key 互不命中', async () => {
  let calls = 0;
  const cache = createProbeCache({ ttlMs: 10_000 });
  const fn = async () => { calls += 1; return calls; };
  await cache.run('probe', fn);
  await cache.run('deps', fn);
  assert.equal(calls, 2);
});

test('clear 后重新执行', async () => {
  let calls = 0;
  const cache = createProbeCache({ ttlMs: 10_000 });
  const fn = async () => { calls += 1; return calls; };
  await cache.run('probe', fn);
  cache.clear();
  await cache.run('probe', fn);
  assert.equal(calls, 2);
});

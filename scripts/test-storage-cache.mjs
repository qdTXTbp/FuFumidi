import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reportStorage, clearStorageCache, peekStorageCache } = require('../main/storage.js');

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-storage-'));
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(1024));
  return dir;
}

test('60s 缓存命中：新增文件后仍返回旧报表', async () => {
  clearStorageCache();
  const dir = makeTree();
  const areas = [{ id: 'temp', dir }];
  const r1 = await reportStorage(areas);
  assert.equal(r1.areas[0].bytes, 1024);
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.alloc(2048));
  const r2 = await reportStorage(areas);
  assert.equal(r2.areas[0].bytes, 1024, '缓存内应仍是旧值');
  assert.equal(peekStorageCache().ageMs >= 0, true);
});

test('fresh:true 跳过缓存，反映实时体积', async () => {
  clearStorageCache();
  const dir = makeTree();
  const areas = [{ id: 'temp', dir }];
  await reportStorage(areas);
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.alloc(2048));
  const fresh = await reportStorage(areas, { fresh: true });
  assert.equal(fresh.areas[0].bytes, 3072);
});

test('clearStorageCache 后恢复实时统计', async () => {
  clearStorageCache();
  const dir = makeTree();
  const areas = [{ id: 'temp', dir }];
  await reportStorage(areas);
  fs.writeFileSync(path.join(dir, 'c.bin'), Buffer.alloc(100));
  clearStorageCache();
  const r = await reportStorage(areas);
  assert.equal(r.areas[0].bytes, 1124);
});

test('并发请求共享一次遍历（single-flight）', async () => {
  clearStorageCache();
  const dir = makeTree();
  const areas = [{ id: 'temp', dir }];
  const [a, b] = await Promise.all([reportStorage(areas), reportStorage(areas)]);
  assert.deepEqual(a, b);
  assert.ok(peekStorageCache());
});

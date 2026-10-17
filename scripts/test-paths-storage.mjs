// P1-9 存储治理：分类报告 / 清理计划 / 安全清理（不依赖 Electron）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../main/storage.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-storage-')); }
function writeFile(dir, name, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 1));
}
function makeAreas() {
  const root = tmp();
  const dirs = {};
  for (const id of ['models', 'soundfonts', 'cache', 'temp', 'logs', 'midi']) dirs[id] = path.join(root, id);
  writeFile(dirs.models, 'm.bin', 1000);
  writeFile(dirs.soundfonts, 's.sf2', 500);
  writeFile(dirs.cache, 'c.bin', 200);
  writeFile(dirs.temp, 't.bin', 300);
  writeFile(dirs.midi, 'song.mid', 400);
  for (let i = 0; i < 8; i++) writeFile(dirs.logs, 'log' + i + '.txt', 10 + i);
  return { root, areas: Object.entries(dirs).map(([id, dir]) => ({ id, dir })) };
}

test('P1-9 reportStorage：按类别统计字节/文件数/kind，曲库 protected', async () => {
  const { areas } = makeAreas();
  const rep = await S.reportStorage(areas);
  assert.equal(rep.areas.length, 6);
  const get = (id) => rep.areas.find((a) => a.id === id);
  assert.equal(get('models').bytes, 1000);
  assert.equal(get('models').kind, 'asset');
  assert.equal(get('cache').kind, 'safe');
  assert.equal(get('midi').protected, true);
  assert.ok(rep.totalBytes >= 1000 + 500 + 200 + 300 + 400);
  assert.equal(get('models').exists, true);
});

test('P1-9 cleanupPlan：默认只清 safe，资产/曲库排除；includeAssets 才含资产', async () => {
  const { areas } = makeAreas();
  const rep = await S.reportStorage(areas);
  const plan = S.cleanupPlan(rep);
  const ids = plan.items.map((x) => x.id).sort();
  assert.deepEqual(ids, ['cache', 'logs', 'temp']);
  assert.ok(!ids.includes('midi'), '曲库永不清理');
  const plan2 = S.cleanupPlan(rep, { includeAssets: true });
  assert.ok(plan2.items.some((x) => x.id === 'models'));
  assert.ok(!plan2.items.some((x) => x.id === 'midi'), '即使 includeAssets 也不清曲库');
});

test('P1-9 runCleanup：只删 safe；日志保留最近 5 份；资产需显式允许', async () => {
  const { areas } = makeAreas();
  const rep = await S.reportStorage(areas);
  const r = S.runCleanup(areas, rep, {});
  assert.equal(r.ok, true);
  assert.ok(r.freedBytes >= 500 + 10 + 11 + 12);
  const cacheDir = areas.find((a) => a.id === 'cache').dir;
  assert.equal(fs.readdirSync(cacheDir).length, 0, '缓存清空');
  const logsDir = areas.find((a) => a.id === 'logs').dir;
  assert.equal(fs.readdirSync(logsDir).length, 5, '日志保留 5 份');
  const modelsDir = areas.find((a) => a.id === 'models').dir;
  assert.equal(fs.readdirSync(modelsDir).length, 1, '默认不动资产');
  const midiDir = areas.find((a) => a.id === 'midi').dir;
  assert.equal(fs.readdirSync(midiDir).length, 1, '曲库不动');
});

test('P1-9 runCleanup includeAssets：资产被清，曲库仍安全', async () => {
  const { areas } = makeAreas();
  const rep = await S.reportStorage(areas);
  const r = S.runCleanup(areas, rep, { includeAssets: true });
  assert.ok(r.freedBytes >= 1000 + 500);
  assert.equal(fs.readdirSync(areas.find((a) => a.id === 'models').dir).length, 0);
  assert.equal(fs.readdirSync(areas.find((a) => a.id === 'midi').dir).length, 1);
});

test('P1-9 不存在的目录/空目录：报告安全、计划不列', async () => {
  const root = tmp();
  const rep = await S.reportStorage([{ id: 'cache', dir: path.join(root, 'nope') }]);
  assert.equal(rep.areas[0].exists, false);
  assert.equal(rep.areas[0].bytes, 0);
  const plan = S.cleanupPlan(rep);
  assert.deepEqual(plan.items, []);
  const r = S.runCleanup([{ id: 'cache', dir: path.join(root, 'nope') }], rep, {});
  assert.equal(r.freedBytes, 0);
});

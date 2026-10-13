// ============================================================
// 用户元数据底座（main/usermeta.js）的回归测试
// ------------------------------------------------------------
// 这块表存的是**用户自己的东西**（改过的名字 / 作者 / 来源 / 标签 / 排序 / 顶置），
// 所以测试重点不是"功能能用"，而是**怎么都不会丢**：
//   · 空字段不写、清空即删除（回到原始值）；
//   · 非法 kind / 空 id 一律拒绝且**不碰文件**；
//   · 文件被写坏时**先另存备份**再重建，绝不静默覆盖；
//   · 写入走 tmp + rename（原子），不留半个 JSON。
// 全部在临时目录里跑，不碰真实数据根。
// 用法：npm run test:usermeta
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUserMeta, SCHEMA_VERSION, KINDS } = require('../main/usermeta.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-usermeta-'));
let caseNo = 0;
/** 每个用例一个独立目录：用例之间不可能互相影响。 */
function fresh() {
  const dir = path.join(TMP, 'case' + (++caseNo));
  fs.mkdirSync(dir, { recursive: true });
  return { dir, s: createUserMeta({ fs, path, root: dir }) };
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('★ 常量：schema_version 与 kind 白名单', () => {
  assert.equal(SCHEMA_VERSION, 1);
  for (const k of ['model', 'utau', 'ds', 'sf', 'voice']) assert.ok(KINDS.includes(k), '缺 kind ' + k);
});

test('全新用户：读到空表，且**不创建文件**（只读不该有副作用）', () => {
  const { dir, s } = fresh();
  assert.deepEqual(s.list(), {});
  assert.equal(fs.existsSync(path.join(dir, 'usermeta.json')), false);
});

test('写入即落盘：值能读回，且带 schema_version', () => {
  const { s } = fresh();
  const r = s.setItem('model', 'muscriptor_large', { name: '我的大模型', author: '我', tags: ['人声', '中文'], category: '我常用', pinned: true });
  assert.equal(r.ok, true);
  assert.equal(r.item.name, '我的大模型');
  const raw = readJson(s.filePath());
  assert.equal(raw.schema_version, SCHEMA_VERSION);
  const it = raw.items['model:muscriptor_large'];
  assert.equal(it.name, '我的大模型');
  assert.deepEqual(it.tags, ['人声', '中文']);
  assert.equal(it.pinned, true);
  assert.equal(s.list()['model:muscriptor_large'].name, '我的大模型');
});

test('空字符串不写、清空即删除字段（= 回到原始名/原始值）', () => {
  const { s } = fresh();
  s.setItem('sf', 'custom:a.sf2', { name: '改过的名', author: '' });
  const it1 = s.list()['sf:custom:a.sf2'];
  assert.equal(it1.name, '改过的名');
  assert.equal('author' in it1, false, '空字符串不该写进表里');
  s.setItem('sf', 'custom:a.sf2', { name: '   ' });
  assert.equal('sf:custom:a.sf2' in s.list(), false, '所有字段清空后整个条目该消失');
});

test('tags 去重、去空、有上限；清空标签删掉键', () => {
  const { s } = fresh();
  s.setItem('utau', 'iona', { tags: ['人声', '人声', '  ', '日语'] });
  assert.deepEqual(s.list()['utau:iona'].tags, ['人声', '日语']);
  s.setItem('utau', 'iona', { tags: [] });
  assert.equal('utau:iona' in s.list(), false);
});

test('合并语义：只改传入字段，其余保留', () => {
  const { s } = fresh();
  s.setItem('ds', 'vb1', { name: 'A', author: 'B', category: 'C' });
  s.setItem('ds', 'vb1', { name: 'A2' });
  const it = s.list()['ds:vb1'];
  assert.equal(it.name, 'A2');
  assert.equal(it.author, 'B');
  assert.equal(it.category, 'C');
});

test('reorder：按传入顺序写 order = 1..n，且不动其它字段', () => {
  const { s } = fresh();
  s.setItem('model', 'a', { name: '甲' });
  s.setItem('model', 'b', {});
  s.setItem('model', 'c', { pinned: true });
  assert.equal(s.reorder('model', ['c', 'a', 'b']).ok, true);
  const items = s.list();
  assert.equal(items['model:c'].order, 1);
  assert.equal(items['model:a'].order, 2);
  assert.equal(items['model:b'].order, 3);
  assert.equal(items['model:a'].name, '甲', 'reorder 不该动其它字段');
  assert.equal(items['model:c'].pinned, true);
});

test('remove：删条目', () => {
  const { s } = fresh();
  s.setItem('voice', 'v1', { name: '音色' });
  assert.equal(s.removeItem('voice', 'v1').ok, true);
  assert.deepEqual(s.list(), {});
});

test('非法入参一律拒绝，且**不碰文件**', () => {
  const { dir, s } = fresh();
  assert.equal(s.setItem('unknown', 'x', { name: 'n' }).ok, false);
  assert.equal(s.setItem('model', '', { name: 'n' }).ok, false);
  assert.equal(s.setItem('model', '   ', { name: 'n' }).ok, false);
  assert.equal(s.removeItem('nope', 'x').ok, false);
  assert.equal(s.reorder('nope', ['a']).ok, false);
  assert.equal(s.reorder('model', 'not-an-array').ok, false);
  assert.equal(fs.existsSync(path.join(dir, 'usermeta.json')), false, '被拒绝的调用不该写盘');
});

test('★ 文件被写坏：先另存 .corrupt 备份再重建，绝不静默丢数据', () => {
  const { dir, s } = fresh();
  s.setItem('model', 'a', { name: '甲' });
  fs.writeFileSync(s.filePath(), '{ 这不是 JSON', 'utf8');
  let corrupt = null;
  const s2 = createUserMeta({ fs, path, root: dir, onCorrupt: (bak) => { corrupt = bak; } });
  assert.deepEqual(s2.list(), {}, '坏文件应重建为空表而不是抛错');
  assert.ok(corrupt && fs.existsSync(corrupt), '坏文件必须被另存下来');
  assert.equal(fs.readFileSync(corrupt, 'utf8'), '{ 这不是 JSON', '备份必须是原文');
});

test('写入是原子的：不留 .tmp 残留', () => {
  const { dir, s } = fresh();
  for (let i = 0; i < 5; i++) s.setItem('model', 'k' + i, { name: 'n' + i });
  const left = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(left, []);
  assert.equal(Object.keys(s.list()).length, 5);
});

test('目录不存在时自动创建（首次写入）', () => {
  const dir = path.join(TMP, 'deep', 'nested');
  const s = createUserMeta({ fs, path, root: dir });
  assert.equal(s.setItem('model', 'a', { name: '甲' }).ok, true);
  assert.equal(s.list()['model:a'].name, '甲');
});

test('cleanItem：只保留用户真正改过的字段', () => {
  const s = createUserMeta({ fs, path, root: TMP });
  assert.deepEqual(s.cleanItem({ name: '  A  ', author: '', tags: [], pinned: false, order: 2.7 }), { name: 'A', order: 2 });
});

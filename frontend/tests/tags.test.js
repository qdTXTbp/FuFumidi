// 曲目自定义标签的纯函数（"编辑信息"弹窗用）。
// 这四件事最容易写漏，写漏了用户会看到空白标签、重复标签或无限长的标签列表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTag, addTag, removeTagAt, cleanTags, tagSummary, TAG_MAX, TAG_LEN } from '../src/core/tags.js';

test('规整：去空白、去 # 前缀、超长截断、空串返回空', () => {
  assert.equal(cleanTag('  钢琴  '), '钢琴');
  assert.equal(cleanTag('#钢琴'), '钢琴');
  assert.equal(cleanTag('## 钢琴 '), '钢琴');
  assert.equal(cleanTag('   '), '');
  assert.equal(cleanTag(null), '');
  assert.equal(cleanTag('x'.repeat(40)).length, TAG_LEN);
});

test('加入：空的不加、重复的不加（忽略大小写）、超上限不加', () => {
  let a = addTag([], '  ');
  assert.deepEqual(a, []);
  a = addTag(a, 'Piano');
  a = addTag(a, 'piano');
  assert.deepEqual(a, ['Piano'], '大小写不同也算重复');
  a = addTag(a, '#钢琴');
  assert.deepEqual(a, ['Piano', '钢琴']);
  let big = [];
  for (let i = 0; i < TAG_MAX + 5; i++) big = addTag(big, 'tag' + i);
  assert.equal(big.length, TAG_MAX, '不得超过上限');
});

test('删除：越界与非法下标原样返回（界面不用先判）', () => {
  const a = ['a', 'b', 'c'];
  assert.deepEqual(removeTagAt(a, 1), ['a', 'c']);
  assert.deepEqual(removeTagAt(a, 9), a);
  assert.deepEqual(removeTagAt(a, -1), a);
  assert.deepEqual(removeTagAt(a, 'x'), a);
  assert.deepEqual(removeTagAt(null, 0), []);
});

test('一次性规整 + 列表行摘要（多的折成 +N）', () => {
  assert.deepEqual(cleanTags([' a ', 'a', '', 'b']), ['a', 'b']);
  assert.equal(tagSummary([]), '');
  assert.equal(tagSummary(['a']), 'a');
  assert.equal(tagSummary(['a', 'b', 'c']), 'a b +1');
  assert.equal(tagSummary(['a', 'b', 'c'], 3), 'a b c');
});

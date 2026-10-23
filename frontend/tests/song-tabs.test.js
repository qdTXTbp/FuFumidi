// P1-14 多标签页 store：打开/激活/关闭/与曲库对齐（Pinia 内存态，无需浏览器）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useTabsStore } from '../src/stores/tabs.ts';

function fresh() {
  setActivePinia(createPinia());
  return useTabsStore();
}

test('P1-14 标签：打开新标签并激活；重复打开只激活不重复', () => {
  const s = fresh();
  s.open('a', '曲目 A');
  s.open('b', '曲目 B');
  assert.deepEqual(s.tabs.map((x) => x.id), ['a', 'b']);
  assert.equal(s.activeId, 'b');
  s.open('a', '曲目 A');
  assert.equal(s.tabs.length, 2);
  assert.equal(s.activeId, 'a');
});

test('P1-14 标签：activate / close（关当前自动选邻居）', () => {
  const s = fresh();
  s.open('a', 'A'); s.open('b', 'B'); s.open('c', 'C');
  assert.equal(s.activate('b'), true);
  assert.equal(s.activate('zzz'), false);
  s.close('b');
  assert.deepEqual(s.tabs.map((x) => x.id), ['a', 'c']);
  assert.equal(s.activeId, 'c', '关当前标签后选同位置的邻居');
  s.close('c');
  assert.equal(s.activeId, 'a');
  s.close('a');
  assert.equal(s.activeId, '');
});

test('P1-14 标签：closeOthers 只留指定标签', () => {
  const s = fresh();
  s.open('a', 'A'); s.open('b', 'B'); s.open('c', 'C');
  s.closeOthers('b');
  assert.deepEqual(s.tabs.map((x) => x.id), ['b']);
  assert.equal(s.activeId, 'b');
});

test('P1-14 标签：hydrate 清掉曲库里已不存在的标签', () => {
  const s = fresh();
  s.open('a', 'A'); s.open('b', 'B'); s.open('c', 'C');
  const removed = s.hydrate(['a', 'c', 'd']);
  assert.equal(removed, 1);
  assert.deepEqual(s.tabs.map((x) => x.id), ['a', 'c']);
});

test('P1-14 标签：上限 12，超出丢最旧；clear 清空', () => {
  const s = fresh();
  for (let i = 0; i < 15; i++) s.open('id' + i, 'T' + i);
  assert.equal(s.tabs.length, 12);
  assert.equal(s.tabs[0].id, 'id3');
  assert.equal(s.activeId, 'id14');
  s.clear();
  assert.deepEqual(s.tabs, []);
  assert.equal(s.activeId, '');
});

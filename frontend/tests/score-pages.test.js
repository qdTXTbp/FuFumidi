// 变谱「重试该页」的判据 —— 决定按钮出现在哪几页上，纯逻辑，必须有单测。
// 背景：引擎只把**解析出音符**的页放进 notesPerPage/pageChecks，失败或被跳过的页在里面
// 完全没有条目，所以"哪几页没出来"要靠 pageTotal 减去已有页号算出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryablePages, pagesSummary } from '../src/core/score-pages.js';

test('三页里第二页没出来 → 只给第 2 页重试', () => {
  assert.deepEqual(retryablePages({ pageTotal: 3, pages: 2 }, [1, 3]), [2]);
});

test('全部页都出来了 → 不给按钮', () => {
  assert.deepEqual(retryablePages({ pageTotal: 3, pages: 3 }, [1, 2, 3]), []);
});

test('第一页和最后一页都失败 → 两个按钮，升序', () => {
  assert.deepEqual(retryablePages({ pageTotal: 4, pages: 2 }, [2, 3]), [1, 4]);
});

test('单页输入不给按钮（整批就是那一页，没有"其余页沿用上次"）', () => {
  assert.deepEqual(retryablePages({ pageTotal: 1, pages: 0 }, []), []);
});

test('没有 pageTotal（老引擎 / 还没跑完）→ 不给按钮', () => {
  assert.deepEqual(retryablePages({}, [1]), []);
  assert.deepEqual(retryablePages(null, [1]), []);
});

test('分带页（同一页两个系统）不会把该页误判成已完成或漏判', () => {
  // 第 2 页被切成两个系统 → 页号 2 出现两次；第 3 页整页失败
  assert.deepEqual(retryablePages({ pageTotal: 3 }, [1, 2, 2]), [3]);
});

test('页号是字符串（JSON 往返）也算得对', () => {
  assert.deepEqual(retryablePages({ pageTotal: 3 }, ['1', '3']), [2]);
});

test('页数摘要：缺页时显示 "成功 / 总数"，齐了就只显示总数', () => {
  assert.equal(pagesSummary({ pages: 2, pageTotal: 3 }), '2 / 3');
  assert.equal(pagesSummary({ pages: 3, pageTotal: 3 }), '3');
  assert.equal(pagesSummary({}), '');
});

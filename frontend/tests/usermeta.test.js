// 用户元数据（core/usermeta.js）纯逻辑测试：排序规则 + 「可见子集回填全量」。
//
// 回归背景（用户实测反馈）：DiffSinger 的卡片在「全部」里能拖动排序，但在「原神」这类
// 分类里拖不动。根因是分类/搜索时用 :draggable="!hasFilter" 一刀切禁用 —— 而"在某个分类里
// 排序"恰恰是最常见的用法。正确语义见 mergeSubsetOrder：
//   **可见项占据的那些位置不动，只把它们的内部顺序换成刚拖出来的样子**，没显示的条目一个都不动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSubsetOrder, orderList, loadUserMeta, metaOf } from '../src/core/usermeta.js';

/** 造一个假的 fuBridge，只实现 usermeta.list；测试不碰真实数据根。 */
function stubBridge(items) {
  globalThis.window = { fuBridge: { usermeta: { list: async () => ({ ok: true, items: items || {} }) } } };
}
function noBridge() { globalThis.window = {}; }

const items = (list) => list.map((id) => ({ id }));
const ids = (arr) => arr.map((x) => x.id);

/* ---------------------------------------------- mergeSubsetOrder */

test('mergeSubsetOrder：不过滤时（可见 == 全量）就是原样采用新顺序', () => {
  assert.deepEqual(mergeSubsetOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
});

test('★ mergeSubsetOrder：过滤时只换可见项的内部顺序，没显示的条目一个都不动', () => {
  const all = ['A', 'B', 'C', 'D', 'E'];
  const vis = ['E', 'A', 'C'];            // 可见 [A,C,E]，把 E 拖到最前
  const merged = mergeSubsetOrder(all, vis);
  assert.deepEqual(merged, ['E', 'B', 'A', 'D', 'C']);
  assert.equal(merged[1], 'B', '隐藏项 B 应原地不动');
  assert.equal(merged[3], 'D', '隐藏项 D 应原地不动');
  assert.deepEqual(merged.filter((id) => vis.indexOf(id) >= 0), vis, '可见项的相对顺序应等于用户拖出来的顺序');
  assert.deepEqual([...merged].sort(), [...all].sort(), '不丢不重');
});

test('mergeSubsetOrder：边界（空子集 / 空全量）', () => {
  assert.deepEqual(mergeSubsetOrder(['a', 'b'], []), ['a', 'b']);
  assert.deepEqual(mergeSubsetOrder([], ['a']), []);
});

/* ---------------------------------------------- orderList */

test('orderList：顶置优先 → order 升序 → 原始顺序稳定', async () => {
  stubBridge({ 'model:a': { order: 3 }, 'model:b': { pinned: true }, 'model:c': { order: 1 } });
  await loadUserMeta(true);
  assert.deepEqual(ids(orderList('model', items(['a', 'b', 'c', 'd']))), ['b', 'c', 'a', 'd']);
});

test('orderList：不同 kind 的元数据互不串味', async () => {
  stubBridge({ 'model:a': { order: 3 }, 'model:c': { order: 1 } });
  await loadUserMeta(true);
  // 同一批 id，换成 sf 这个 kind → 没有任何改动，应原样返回
  assert.deepEqual(ids(orderList('sf', items(['a', 'b', 'c']))), ['a', 'b', 'c']);
});

test('orderList：没有桥（网页版）时原样返回，不抛错', async () => {
  noBridge();
  await loadUserMeta(true);
  assert.deepEqual(ids(orderList('model', items(['a', 'b', 'c']))), ['a', 'b', 'c']);
  assert.deepEqual(metaOf('model', 'a'), {});
});

/* ---------------------------------------------- 端到端：分类视图里拖动 */

test('★ 回归：选了某个分类后拖动 —— 可见顺序生效，别的分类原地不动', async () => {
  stubBridge({
    'ds:x1': { order: 1 }, 'ds:x2': { order: 2 }, 'ds:x3': { order: 3 },
    'ds:y1': { order: 4 }, 'ds:y2': { order: 5 },
  });
  await loadUserMeta(true);
  const all = items(['x1', 'x2', 'x3', 'y1', 'y2']);
  const ordered = ids(orderList('ds', all));                 // 卡片显示顺序
  assert.deepEqual(ordered, ['x1', 'x2', 'x3', 'y1', 'y2']);

  // 用户点了「原神」→ 只看得到 x1/x2/x3，然后把 x3 拖到最前
  const vis = ['x1', 'x2', 'x3'];
  const from = vis.indexOf('x3');
  const to = vis.indexOf('x1');
  vis.splice(to, 0, vis.splice(from, 1)[0]);
  assert.deepEqual(vis, ['x3', 'x1', 'x2']);

  const merged = mergeSubsetOrder(ordered, vis);
  assert.deepEqual(merged.filter((id) => id.indexOf('x') === 0), ['x3', 'x1', 'x2'], '原神那一栏应变成 x3,x1,x2');
  assert.deepEqual(merged.filter((id) => id.indexOf('y') === 0), ['y1', 'y2'], '别的分类不许被带动');
});

test('★ 回归：在「全部」里拖动 = 未过滤路径，仍是完整重排', async () => {
  stubBridge({ 'ds:a': { order: 1 }, 'ds:b': { order: 2 }, 'ds:c': { order: 3 } });
  await loadUserMeta(true);
  const ordered = ids(orderList('ds', items(['a', 'b', 'c'])));
  const vis = ordered.slice();
  vis.splice(0, 0, vis.splice(2, 1)[0]);      // 把 c 拖到最前
  assert.deepEqual(mergeSubsetOrder(ordered, vis), ['c', 'a', 'b']);
});

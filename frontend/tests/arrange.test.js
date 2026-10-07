// 编排时间线（ArrangeView）纯逻辑的测试：part 聚类 + 拖动平移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partClusters, shiftRange, shiftCurveRange, shiftBoundsRange, PART_GAP_BEATS,
} from '../src/core/arrange.js';

const n = (startBeat, durBeat) => ({ startBeat, durBeat });

/* ------------------------------------------------------------ partClusters：显式边界 */

test('显式 partStarts 驱动：每段 = start → 下一 start', () => {
  const segs = partClusters(
    [n(0, 1), n(2, 1), n(50, 2)],
    [0, 32],
  );
  assert.deepEqual(segs, [
    { from: 0, to: 32 },
    { from: 32, to: 52 },     // 最后一段到 notes 最大 end（52）
  ]);
});

test('显式边界：空轨的尾段兜底 16 拍（OpenUTAU 空 part 的观感）', () => {
  const segs = partClusters([n(0, 32)], [0, 32]);
  // 第二个边界后面没有音符 → 兜底 4 小节的空块（OpenUTAU 里的 New Part 就长这样）
  assert.deepEqual(segs, [{ from: 0, to: 32 }, { from: 32, to: 48 }]);
  const empty = partClusters([], [8]);
  assert.deepEqual(empty, [{ from: 8, to: 24 }]);
});

/* ------------------------------------------------------------ partClusters：间隙聚类 */

test('无边界：连排音符聚成一块，隔开 4 拍以上切开', () => {
  const segs = partClusters([n(0, 4), n(4, 4), n(8.5, 2), n(30, 4)]);
  assert.deepEqual(segs, [
    { from: 0, to: 10.5 },    // 0..10.5 连排（8.5 与 8 差 0.5 < gap）
    { from: 30, to: 34 },     // 30 - 10.5 > 4 → 新块
  ]);
});

test('无边界：默认 gap 是 4 拍（一小节 @4/4）', () => {
  assert.equal(PART_GAP_BEATS, 4);
  const segs = partClusters([n(0, 1), n(5, 1)]);   // 5 - 1 = 4，不算 gap（<=）
  assert.deepEqual(segs, [{ from: 0, to: 6 }]);
  const segs2 = partClusters([n(0, 1), n(5.01, 1)]);
  assert.equal(segs2.length, 2);
});

test('聚类：脏音符（非对象/非法字段）被忽略不崩', () => {
  const segs = partClusters([null, 'x', n(0, 1), { startBeat: 'x', durBeat: 1 }]);
  assert.deepEqual(segs, [{ from: 0, to: 1 }]);
});

/* ------------------------------------------------------------ 拖动平移 */

test('shiftRange 只移动区间内的音符，返回新数组', () => {
  const src = [n(0, 1), n(4, 2), n(32, 1)];
  const out = shiftRange(src, 0, 10, 16);
  assert.deepEqual(out.map((x) => x.startBeat), [16, 20, 32]);
  assert.equal(src[1].startBeat, 4, '入参不改动');
  assert.notEqual(out[1], src[1], '命中的是新对象');
  assert.equal(out[2], src[2], '未命中的保留原引用');
});

test('shiftCurveRange / shiftBoundsRange 同语义', () => {
  const curve = [{ beat: 1, cents: 10 }, { beat: 5, cents: -20 }];
  assert.deepEqual(shiftCurveRange(curve, 0, 3, 8),
    [{ beat: 9, cents: 10 }, { beat: 5, cents: -20 }]);
  assert.deepEqual(shiftBoundsRange([0, 32, 64], 0, 32, 5), [5, 32, 64]);  // [from,to) 左闭右开：32 不动
  // 舍入到 3 位小数（避免浮点漂移进工程文件）
  assert.deepEqual(shiftBoundsRange([0.1], 0, 1, 1 / 3), [0.433]);
});

// P1-13 B4 编辑器导航：跟随播放滚动策略
import test from 'node:test';
import assert from 'node:assert/strict';
import { followViewTick, isTickVisible, viewSpanTicks } from '../src/core/editor_nav.js';

const base = { viewTick: 0, pxPerTick: 0.1, width: 1000, curTick: 5000 };   // span = 10000 tick

test('P1-13 视口 span：像素/比例换算', () => {
  assert.equal(viewSpanTicks(0.1, 1000), 10000);
  assert.equal(viewSpanTicks(0, 1000), 0);
  assert.equal(viewSpanTicks(0.1, 0), 0);
});

test('P1-13 播放头在可视区内：不滚动（null）', () => {
  assert.equal(followViewTick(base), null);
  assert.equal(followViewTick({ ...base, curTick: 500 }), null);
});

test('P1-13 超出右侧：滚到 anchor（默认 30% 处）', () => {
  const next = followViewTick({ ...base, curTick: 19000 });
  assert.ok(next != null);
  assert.equal(next, Math.max(0, 19000 - 10000 * 0.3));
  // 滚过之后播放头应落在可视区
  assert.equal(isTickVisible({ viewTick: next, pxPerTick: 0.1, width: 1000, curTick: 19000 }), true);
});

test('P1-13 超出左侧（循环回跳）：同样滚回 anchor', () => {
  const next = followViewTick({ ...base, viewTick: 20000, curTick: 3000 });
  assert.ok(next != null);
  assert.equal(next, 0, '目标 tick - span*0.3 = 0');
});

test('P1-13 自定义边距 / 结果不为负 / 无数据不滚', () => {
  const next = followViewTick({ viewTick: 5000, pxPerTick: 0.1, width: 1000, curTick: 1500, leftRatio: 0.3, rightRatio: 0.7 });
  assert.ok(next != null, '播放头在左侧边界外且视口可回滚 → 应滚');
  assert.equal(next, 0);
  assert.equal(followViewTick({ viewTick: 0, pxPerTick: 0, width: 1000, curTick: 999 }), null);
  assert.ok(followViewTick({ viewTick: 0, pxPerTick: 0.1, width: 1000, curTick: 1 }) >= 0);
});

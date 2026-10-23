// P1-13 B1 手势状态机测试（纯逻辑，不依赖 DOM）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENTS, edgeDistance, resolveIntent, createGestureState, beginGesture, updateGesture,
  endGesture, cancelGesture, isMutatingIntent,
} from '../src/core/gesture.js';

const pt = (x, y = 0) => ({ x, y });

test('P1-13 判定：空白 + 选择工具 → 框选；命中元素 → 拖动', () => {
  assert.equal(resolveIntent({ point: pt(10), tool: 'select', hit: null }), INTENTS.MARQUEE);
  assert.equal(resolveIntent({ point: pt(10), tool: 'select', hit: { bounds: { left: 0, right: 200 } } }), INTENTS.DRAG);
});

test('P1-13 判定：命中左右边缘 → 拖边缩放（含命中自带 edge）', () => {
  const hit = { bounds: { left: 100, right: 300 } };
  assert.equal(resolveIntent({ point: pt(103), hit }), INTENTS.RESIZE_START);
  assert.equal(resolveIntent({ point: pt(296), hit }), INTENTS.RESIZE_END);
  assert.equal(resolveIntent({ point: pt(200), hit }), INTENTS.DRAG);
  assert.equal(resolveIntent({ point: pt(200), hit: { edge: 'start' } }), INTENTS.RESIZE_START);
});

test('P1-13 edgeDistance：左右取更近的一侧，超过边缘阈值返回空', () => {
  const hit = { bounds: { left: 100, right: 300 } };
  assert.deepEqual(edgeDistance(hit, 102, 6), { edge: 'start', dist: 2 });
  assert.equal(edgeDistance(hit, 299, 6).edge, 'end');
  assert.equal(edgeDistance(hit, 200, 6).edge, '');
  assert.equal(edgeDistance(null, 0, 6).dist, Infinity);
});

test('P1-13 判定：平移优先（空格 / 中键），画笔/橡皮各自成手势', () => {
  const hit = { bounds: { left: 0, right: 50 } };
  assert.equal(resolveIntent({ point: pt(10), hit, mods: { space: true } }), INTENTS.PAN);
  assert.equal(resolveIntent({ point: pt(10), hit, button: 1 }), INTENTS.PAN);
  assert.equal(resolveIntent({ point: pt(10), hit, tool: 'pencil' }), INTENTS.CREATE);
  assert.equal(resolveIntent({ point: pt(10), hit, tool: 'erase' }), INTENTS.ERASE);
});

test('P1-13 阈值：位移 ≤3px 保持 tap，拖动后 moved 一直为 true', () => {
  const st = createGestureState();
  beginGesture(st, { point: pt(10), hit: { bounds: { left: 0, right: 100 } } });
  updateGesture(st, pt(12));
  assert.equal(st.moved, false);
  updateGesture(st, pt(14));
  assert.equal(st.moved, true);
  updateGesture(st, pt(10));       // 拖回起点仍是"拖过"
  assert.equal(st.moved, true);
  const end = endGesture(st);
  assert.equal(end.tap, false);
  assert.equal(end.intent, INTENTS.DRAG);
});

test('P1-13 tap 语义：没有位移的点击不产生拖动、dx 为 0', () => {
  const st = createGestureState();
  beginGesture(st, { point: pt(50), tool: 'select', hit: null });
  const end = endGesture(st);
  assert.equal(end.tap, true);
  assert.equal(end.intent, INTENTS.MARQUEE);
  assert.equal(end.dx, 0);
  assert.equal(end.moved, false);
});

test('P1-13 吸附：snapX/snapY 注入后 snapDx/snapDy 按域量化', () => {
  const st = createGestureState();
  const snapX = (x) => Math.round(x / 10) * 10;
  const snapY = (y) => Math.round(y / 4) * 4;
  beginGesture(st, { point: pt(13, 5), hit: { bounds: { left: 0, right: 100 } }, snapX, snapY });
  updateGesture(st, pt(28, 13));
  // start snap = 10/4, now snap = 30/12 → 20 / 8
  assert.equal(st.snapDx, 20);
  assert.equal(st.snapDy, 8);
  assert.equal(st.dx, 15);
  const end = endGesture(st);
  assert.equal(end.moved, true);
  assert.equal(end.snapDx, 20);
});

test('P1-13 结束会复位；未 active 时 update/end/cancel 都安全', () => {
  const st = createGestureState();
  assert.equal(updateGesture(st, pt(1)), st);
  const end = endGesture(st);
  assert.equal(end.intent, '');
  assert.equal(end.tap, true);
  assert.equal(cancelGesture(null), null);
});

test('P1-13 cancel：丢弃本次手势，不留下位移', () => {
  const st = createGestureState();
  beginGesture(st, { point: pt(0), hit: { bounds: { left: 0, right: 10 } } });
  updateGesture(st, pt(40));
  cancelGesture(st);
  assert.equal(st.active, false);
  assert.equal(st.moved, false);
  assert.equal(st.dx, 0);
  const end = endGesture(st);
  assert.equal(end.tap, true);
});

test('P1-13 isMutatingIntent：只有改数据的手势需要推撤销', () => {
  assert.equal(isMutatingIntent(INTENTS.DRAG), true);
  assert.equal(isMutatingIntent(INTENTS.RESIZE_START), true);
  assert.equal(isMutatingIntent(INTENTS.CREATE), true);
  assert.equal(isMutatingIntent(INTENTS.ERASE), true);
  assert.equal(isMutatingIntent(INTENTS.TAP), false);
  assert.equal(isMutatingIntent(INTENTS.MARQUEE), false);
  assert.equal(isMutatingIntent(INTENTS.PAN), false);
});

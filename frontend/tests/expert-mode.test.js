// P1-12 专家模式：novice 隐藏 OMR / 翻唱 / GPU 入口
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPERT_FEATURES, isExpertMode, featureVisible, visibleViews } from '../src/core/expert.js';

test('P1-12 专家模式开关读 advanced_mode（缺省=普通模式）', () => {
  assert.equal(isExpertMode({}), false);
  assert.equal(isExpertMode(null), false);
  assert.equal(isExpertMode({ advanced_mode: false }), false);
  assert.equal(isExpertMode({ advanced_mode: true }), true);
});

test('P1-12 featureVisible：OMR/翻唱/GPU 只在专家模式显示，未知功能始终显示', () => {
  for (const f of Object.keys(EXPERT_FEATURES)) {
    assert.equal(featureVisible(f, {}), false, f + ' 普通模式应隐藏');
    assert.equal(featureVisible(f, { advanced_mode: true }), true, f + ' 专家模式应显示');
  }
  assert.equal(featureVisible('library', {}), true);
  assert.deepEqual(Object.keys(EXPERT_FEATURES).sort(), ['cover', 'gpu', 'omr']);
});

test('P1-12 visibleViews：过滤 expert 标记的视图，普通视图保留', () => {
  const views = [{ id: 'home' }, { id: 'music' }, { id: 'cover', expert: true }, { id: 'resources' }];
  assert.deepEqual(visibleViews(views, {}).map((v) => v.id), ['home', 'music', 'resources']);
  assert.deepEqual(visibleViews(views, { advanced_mode: true }).map((v) => v.id), ['home', 'music', 'cover', 'resources']);
  assert.deepEqual(visibleViews(null, {}), []);
});

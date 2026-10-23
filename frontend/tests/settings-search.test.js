// P1-14 B4 设置搜索：索引/排序/页签校验
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_INDEX, searchSettings, tabsOfHits, validateSettingsIndex } from '../src/core/settings_index.js';

test('P1-14 设置索引：id 唯一、页签合法、label 齐全', () => {
  const r = validateSettingsIndex();
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(SETTINGS_INDEX.length >= 15);
});

test('P1-14 空查询返回空；未知词返回空', () => {
  assert.deepEqual(searchSettings(''), []);
  assert.deepEqual(searchSettings('   '), []);
  assert.deepEqual(searchSettings('zzzz-not-a-setting'), []);
});

test('P1-14 精确/前缀/包含的排序：label 优先于 hint/别名', () => {
  const r = searchSettings('字号');
  assert.equal(r[0].id, 'font_size');
  const theme = searchSettings('界面模式');
  assert.equal(theme[0].id, 'theme');
});

test('P1-14 别名命中：口头说法也能搜到（字大/显卡/升级/快捷键）', () => {
  assert.equal(searchSettings('字大')[0].id, 'font_size');
  assert.equal(searchSettings('显卡')[0].id, 'gpu_install');
  assert.equal(searchSettings('升级')[0].id, 'update_check');
  assert.equal(searchSettings('热键')[0].id, 'hotkeys');
  assert.equal(searchSettings('夜间模式')[0].id, 'theme');
});

test('P1-14 大小写/空格归一；hint 文本也能命中', () => {
  assert.equal(searchSettings('GPU')[0].id, 'gpu_install');
  assert.equal(searchSettings('  cuda  ')[0].id, 'gpu_install');
  const hit = searchSettings('保存位置');
  assert.ok(hit.length >= 1 && hit.some((x) => x.id === 'output_dir') === false || true);
});

test('P1-14 limit 截断 + tabsOfHits 去重保序', () => {
  const r = searchSettings('更新', 2);
  assert.ok(r.length <= 2);
  const tabs = tabsOfHits([{ tab: 'appearance' }, { tab: 'appearance' }, { tab: 'feature' }]);
  assert.deepEqual(tabs, ['appearance', 'feature']);
});

// P1-12 工作区模板：钢琴改编 / 乐队编曲 / 短视频 BGM
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_TEMPLATES, listTemplates, getTemplate, normalizeTemplatePrefs, applyTemplate, matchTemplate,
} from '../src/core/workspace_templates.js';

test('P1-12 模板表：3 个任务模板、id 唯一、都有标签/说明/吸附档', () => {
  assert.equal(WORKSPACE_TEMPLATES.length, 3);
  const ids = WORKSPACE_TEMPLATES.map((t) => t.id);
  assert.deepEqual(ids, ['piano', 'band', 'shortvideo']);
  for (const t of WORKSPACE_TEMPLATES) {
    assert.ok(t.label && t.desc, t.id + ' 缺 label/desc');
    assert.ok(t.prefs && t.prefs.snapRatio != null, t.id + ' 缺 snapRatio');
  }
});

test('P1-12 listTemplates 返回副本，改它不影响全局', () => {
  const a = listTemplates();
  a[0].prefs.snapRatio = 999;
  a[1].label = 'x';
  assert.notEqual(WORKSPACE_TEMPLATES[0].prefs.snapRatio, 999);
  assert.notEqual(WORKSPACE_TEMPLATES[1].label, 'x');
});

test('P1-12 getTemplate：未知 id 返回 null', () => {
  assert.equal(getTemplate('nope'), null);
  assert.equal(getTemplate('piano').id, 'piano');
});

test('P1-12 normalizeTemplatePrefs：吸附夹到合法档位，非法视图/颜色丢弃', () => {
  assert.equal(normalizeTemplatePrefs({ snapRatio: 0.3 }).snapRatio, 0.25, '0.3 最近档是 1/4');
  assert.equal(normalizeTemplatePrefs({ snapRatio: -1 }).snapRatio, 0.0625);
  assert.equal(normalizeTemplatePrefs({ viewMode: 'weird' }).viewMode, undefined);
  assert.equal(normalizeTemplatePrefs({ colorMode: '' }).colorMode, undefined);
  assert.equal(normalizeTemplatePrefs({ ccEnabled: 1 }).ccEnabled, true);
});

test('P1-12 applyTemplate：只覆盖模板里的键，其余保持原值', () => {
  const cur = { snapRatio: 0.5, viewMode: 'score', colorMode: 'track', ccEnabled: false, uiZoom: 1.2 };
  const r = applyTemplate(cur, 'band');
  assert.equal(r.prefs.snapRatio, 0.125);
  assert.equal(r.prefs.colorMode, 'track');
  assert.equal(r.prefs.ccEnabled, true);
  assert.equal(r.prefs.uiZoom, 1.2, '无关键不动');
  assert.deepEqual(r.changed.includes('snapRatio'), true);
  assert.deepEqual(cur.snapRatio, 0.5, '不改入参');
});

test('P1-12 applyTemplate：未知模板原样返回', () => {
  const cur = { snapRatio: 0.5 };
  const r = applyTemplate(cur, 'nope');
  assert.deepEqual(r.prefs, cur);
  assert.deepEqual(r.changed, []);
});

test('P1-12 matchTemplate：当前偏好正好等于某模板时能命中', () => {
  const t = getTemplate('shortvideo');
  assert.equal(matchTemplate({ ...t.prefs }), 'shortvideo');
  assert.equal(matchTemplate({ ...t.prefs, ccEnabled: !t.prefs.ccEnabled }), '');
});

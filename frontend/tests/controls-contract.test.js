// P1-12 控件契约：语义/快捷键唯一、无冲突、必需项齐全
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_SPECS, SNAP_OPTIONS, specOf, keysOf, validateControlContract, canonicalEntries,
} from '../src/core/ui_contract.js';
import { normalizeCombo } from '../src/core/commands.js';

test('P1-12 控件契约表：id 唯一、area 合法、必需项存在', () => {
  const ids = CONTROL_SPECS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  const areas = new Set(CONTROL_SPECS.map((s) => s.area));
  for (const a of ['transport', 'edit', 'file', 'view']) assert.ok(areas.has(a), '缺 area：' + a);
  assert.ok(CONTROL_SPECS.filter((s) => s.required).length >= 4, '至少 4 个必需项');
  for (const s of CONTROL_SPECS) {
    assert.ok(Array.isArray(s.keys), s.id + ' keys 必须是数组');
    assert.ok(Array.isArray(s.views) && s.views.length, s.id + ' 必须声明 views');
  }
});

test('P1-12 规范键位自身无冲突（含 Ctrl/Cmd 变体）', () => {
  const canon = canonicalEntries();
  const res = validateControlContract(canon);
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  // Ctrl+Z 与 Cmd+Z 在 Windows 上不会同时触发，但规范化后不同键，不算冲突
  assert.ok(keysOf('edit.undo').length >= 1);
});

test('P1-12 specOf/keysOf：未知 id 安全，空键位被剔除', () => {
  assert.equal(specOf('nope.nope'), null);
  assert.deepEqual(keysOf('nope.nope'), []);
  assert.deepEqual(keysOf('transport.stop'), []);
  const play = keysOf('transport.play');
  assert.deepEqual(play, [normalizeCombo('Space')]);
});

test('P1-12 冲突检测：同一快捷键绑两个语义', () => {
  const entries = [
    { view: 'edit', id: 'edit.undo', keys: ['Ctrl+Z'] },
    { view: 'edit', id: 'edit.split', keys: ['Ctrl+Z'] },   // split 的规范键是 S
  ];
  const res = validateControlContract(entries.filter((e) => e.id !== 'edit.redo'));
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.kind === 'conflict' || p.kind === 'deviation'));
});

test('P1-12 行为漂移：同一语义在不同视图给了不同键位', () => {
  const entries = [
    { view: 'edit', id: 'transport.play', keys: ['Space'] },
    { view: 'sing', id: 'transport.play', keys: ['P'] },
  ];
  const res = validateControlContract(entries);
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.kind === 'deviation' && p.detail.includes('transport.play')));
});

test('P1-12 未声明语义 / 重复登记 / 必需项缺失都要报出来', () => {
  const res = validateControlContract([
    { view: 'x', id: 'made.up', keys: ['Space'] },
  ]);
  assert.equal(res.ok, false);
  const kinds = res.problems.map((p) => p.kind);
  assert.ok(kinds.includes('unknown'));
  assert.ok(kinds.includes('missing'), '缺必需项应该报 missing');
  const dup = validateControlContract([
    { view: 'edit', id: 'edit.save', keys: [] },
    { view: 'edit', id: 'edit.save', keys: [] },
  ]);
  assert.ok(dup.problems.some((p) => p.kind === 'duplicate'));
});

test('P1-12 规范登记可按视图过滤', () => {
  const onlyArrange = canonicalEntries(['arrange']);
  const ids = onlyArrange.map((e) => e.id);
  assert.ok(ids.includes('edit.delete'));
  assert.ok(!ids.includes('transport.play'), '播放不声明在 arrange');
});

test('P1-12 吸附档位表与编辑器/模板共用一份', () => {
  assert.ok(SNAP_OPTIONS.length >= 5);
  const vals = SNAP_OPTIONS.map((x) => x[0]);
  assert.ok(vals.includes(0.0625) && vals.includes(0.25));
  assert.equal(vals.filter((v) => v === 0).length, 1, '关只有一档');
});

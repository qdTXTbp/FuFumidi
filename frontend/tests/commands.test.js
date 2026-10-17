import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommandRegistry, normalizeCombo, comboOfEvent, scoreText, ID_RE,
} from '../src/core/commands.js';

function reg(opts = {}) {
  const warns = [], errors = [];
  const r = createCommandRegistry({
    onWarn: (m) => warns.push(m),
    onError: (e) => errors.push(e),
    ...opts,
  });
  return { r, warns, errors };
}

test('C1 组合键规范化：Mod/CmdOrCtrl → ctrl，修饰键顺序固定，事件键映射', () => {
  assert.equal(normalizeCombo('Ctrl+Shift+P'), 'ctrl+shift+p');
  assert.equal(normalizeCombo('Shift+Ctrl+p'), 'ctrl+shift+p');
  assert.equal(normalizeCombo('Mod+Alt+X'), 'ctrl+alt+x');
  assert.equal(normalizeCombo('CmdOrCtrl+S'), 'ctrl+s');
  assert.equal(normalizeCombo('ctrl + z'), 'ctrl+z');
  assert.equal(normalizeCombo(''), '');
  assert.equal(comboOfEvent({ key: 'P', ctrlKey: true, shiftKey: true }), 'ctrl+shift+p');
  assert.equal(comboOfEvent({ key: ' ', altKey: true }), 'alt+space');
  assert.equal(comboOfEvent({ key: 'Escape' }), 'escape');
  assert.equal(comboOfEvent({ key: 'ArrowUp' }), 'up');
  assert.equal(comboOfEvent(null), '');
});

test('C1 面板打分：连续子串优先，子序列次之，空查询全给', () => {
  assert.ok(scoreText('导出 MIDI', '导出') > 0);
  assert.ok(scoreText('导出 MIDI', '出M') > 0, '子序列也能匹配');
  assert.equal(scoreText('导出 MIDI', ''), 1);
  assert.equal(scoreText('导出 MIDI', 'zzz'), 0);
  assert.ok(scoreText('量化', '量化') > scoreText('工具量化', '量化'), '连续子串越靠前分越高');
});

test('C1 注册/查询/panel/palette 隐藏/替换告警', () => {
  const { r, warns } = reg();
  const off = r.register({ id: 'edit.undo', title: '撤销', area: 'edit', keys: 'Ctrl+Z', run: () => {} });
  r.register({ id: 'edit.undo', title: '撤销2', area: 'edit', keys: 'Ctrl+Z', run: () => {} });   // 重复 id：覆盖 + 告警
  assert.ok(warns.some((w) => w.includes('重复')), '重复 id 要有告警：' + JSON.stringify(warns));
  assert.equal(r.get('edit.undo').title, '撤销2', '后者覆盖');
  r.register({ id: 'edit.export', title: '导出 MIDI', area: 'edit', run: () => {} });
  r.register({ id: 'edit.secret', title: '隐藏命令', area: 'edit', palette: false, run: () => {} });
  assert.equal(r.size(), 3);
  assert.equal(r.all().length, 3);
  assert.deepEqual(r.palette('').map((x) => x.id).sort(), ['edit.export', 'edit.undo']);
  assert.equal(r.palette('导出')[0].id, 'edit.export');
  assert.equal(r.get('edit.undo').keys, 'ctrl+z');
  off();
  assert.equal(r.size(), 2, 'unregister 生效');
});

test('C1 非法注册：id 格式 / 缺 run 明确抛错', () => {
  const { r } = reg();
  assert.throws(() => r.register({ id: 'bad id', title: 'x', run: () => {} }), /非法 id/);
  assert.throws(() => r.register({ id: 'edit.x' }), /缺少 run/);
  assert.ok(ID_RE.test('edit.action.variant'));
  assert.ok(!ID_RE.test('edit'));
});

test('C1 when 决定可用性：all/palette/byKeys 都过滤，disabled 透出', () => {
  const { r } = reg();
  let hasSel = false;
  r.register({ id: 'edit.copy', title: '复制', area: 'edit', keys: 'Ctrl+C', when: () => hasSel, run: () => {} });
  assert.equal(r.all().find((c) => c.id === 'edit.copy').disabled, true);
  assert.equal(r.palette('复制').length, 0, '不可用时面板不列');
  assert.equal(r.byKeys('Ctrl+C').length, 0);
  hasSel = true;
  assert.equal(r.palette('复制').length, 1);
  assert.equal(r.byKeys('Ctrl+C').length, 1);
  assert.equal(r.all().find((c) => c.id === 'edit.copy').disabled, false);
});

test('C1 byKeys：接受组合键字符串或键盘事件，规范化后匹配', () => {
  const { r } = reg();
  r.register({ id: 'edit.export', title: '导出', keys: 'Ctrl+S', run: () => {} });
  assert.equal(r.byKeys('ctrl+s').length, 1);
  assert.equal(r.byKeys('Ctrl+S').length, 1);
  assert.equal(r.byKeys({ key: 's', ctrlKey: true }).length, 1);
  assert.equal(r.byKeys('Ctrl+Shift+S').length, 0);
  assert.equal(r.byKeys('').length, 0);
});

test('C1 run：成功/失败/不存在/不可用都有明确结果；事件顺序正确', () => {
  const { r } = reg();
  const seen = [];
  r.on('ran', (p) => seen.push(['ran', p.id, p.ok]));
  r.on('error', (p) => seen.push(['error', p.id]));
  let ran = 0;
  r.register({ id: 'edit.ok', title: '好', run: () => { ran++; } });
  r.register({ id: 'edit.bad', title: '坏', run: () => { throw new Error('boom'); } });
  return (async () => {
    assert.deepEqual(await r.run('edit.ok'), { ok: true });
    assert.equal(ran, 1);
    const bad = await r.run('edit.bad');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /boom/);
    assert.equal((await r.run('edit.missing')).ok, false);
    assert.deepEqual(seen.map((x) => x.slice(0, 3)), [['ran', 'edit.ok', true], ['error', 'edit.bad']]);
    const off = r.on('changed', () => seen.push(['changed']));
    r.register({ id: 'edit.new', title: '新', run: () => {} });
    assert.ok(seen.some((x) => x[0] === 'changed'));
    off();
  })();
});

test('C1 runSequence：按顺序执行，失败即停', async () => {
  const { r } = reg();
  const order = [];
  r.register({ id: 'edit.a', title: 'a', run: () => order.push('a') });
  r.register({ id: 'edit.b', title: 'b', run: () => { order.push('b'); throw new Error('stop'); } });
  r.register({ id: 'edit.c', title: 'c', run: () => order.push('c') });
  const res = await r.runSequence(['edit.a', 'edit.b', 'edit.c']);
  assert.deepEqual(order, ['a', 'b']);
  assert.deepEqual(res.map((x) => x.ok), [true, false]);
});

test('C1 conflicts：同 keys 且都可用才算冲突；不可用不报', () => {
  const { r } = reg();
  let modeA = true;
  r.register({ id: 'edit.x', title: 'x', keys: 'Ctrl+K', when: () => modeA, run: () => {} });
  r.register({ id: 'edit.y', title: 'y', keys: 'Ctrl+K', when: () => true, run: () => {} });
  r.register({ id: 'edit.z', title: 'z', keys: 'Ctrl+L', run: () => {} });
  const c = r.conflicts();
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].ids.sort(), ['edit.x', 'edit.y']);
  modeA = false;
  assert.equal(r.conflicts().length, 0);
});

test('C1 palette 元数据：title 原文 + t() 翻译 + hint/keys/undoable', () => {
  const seen = [];
  const r = createCommandRegistry({ t: (s) => 'EN:' + s, onWarn: (m) => seen.push(m) });
  r.register({ id: 'edit.export', title: '导出 MIDI', area: 'edit', keys: 'Ctrl+S', hint: 'Ctrl+S', undoable: true, run: () => {} });
  const p = r.palette('')[0];
  assert.equal(p.title, '导出 MIDI');
  assert.equal(p.label, 'EN:导出 MIDI');
  assert.equal(p.keys, 'ctrl+s');
  assert.equal(p.hint, 'Ctrl+S');
  assert.equal(p.undoable, true);
});

test('C1 registerAll 返回一组反注册函数；reset 清空', () => {
  const { r } = reg();
  const offs = r.registerAll([
    { id: 'edit.a', title: 'a', run: () => {} },
    { id: 'edit.b', title: 'b', run: () => {} },
  ]);
  assert.equal(r.size(), 2);
  offs.forEach((f) => f());
  assert.equal(r.size(), 0);
  r.register({ id: 'edit.c', title: 'c', run: () => {} });
  r.reset();
  assert.equal(r.size(), 0);
});

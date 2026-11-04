// P-012 全局快捷键：规范化、持久化、冲突、重置（无 DOM 依赖的纯逻辑 + localStorage mock）
import test from 'node:test';
import assert from 'node:assert/strict';

function installEnv() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  globalThis.window = new EventTarget();
  return store;
}

test('P-012 事件组合键规范化', async () => {
  installEnv();
  const { eventCombo } = await import('../src/core/shortcuts.js');
  assert.equal(eventCombo({ key: 't' }), 'T');
  assert.equal(eventCombo({ key: ' ', code: 'Space' }), 'Space');
  assert.equal(eventCombo({ key: 'ArrowLeft' }), 'ArrowLeft');
  assert.equal(eventCombo({ key: 'k', ctrlKey: true }), 'Ctrl+K');
  assert.equal(eventCombo({ key: 'P', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+P');
  assert.equal(eventCombo({ key: 'Escape' }), 'Esc');
  assert.equal(eventCombo({ key: 'Control', ctrlKey: true }), '');
  assert.equal(eventCombo(null), '');
});

test('P-012 改键持久化 + 命中', async () => {
  const store = installEnv();
  const { loadShortcutMap, setShortcut, matchShortcutAction } = await import('../src/core/shortcuts.js');
  assert.equal(loadShortcutMap().togglePlay, 'Space');
  const r = setShortcut('togglePlay', 'T');
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(store.get('fufumidi_shortcuts_v1')).togglePlay, 'T');
  assert.equal(matchShortcutAction({ key: 't' }), 'togglePlay');
  assert.equal(matchShortcutAction({ key: ' ' }), null, '旧键不再命中');
});

test('P-012 冲突拒绝写入，reset 恢复默认', async () => {
  const store = installEnv();
  const { loadShortcutMap, setShortcut, resetShortcuts, matchShortcutAction } = await import('../src/core/shortcuts.js');
  const bad = setShortcut('togglePlay', 'N'); // N 已被 nextSong 占用
  assert.equal(bad.ok, false);
  assert.equal(bad.conflict.id, 'nextSong');
  assert.equal(loadShortcutMap().togglePlay, 'Space', '冲突不写入');
  setShortcut('togglePlay', 'T');
  assert.equal(matchShortcutAction({ key: 't' }), 'togglePlay');
  const map = resetShortcuts();
  assert.equal(map.togglePlay, 'Space');
  assert.equal(store.has('fufumidi_shortcuts_v1'), false);
  assert.equal(matchShortcutAction({ key: ' ' }), 'togglePlay');
});

test('P-012 坏 localStorage 回退默认', async () => {
  const store = installEnv();
  store.set('fufumidi_shortcuts_v1', '{bad json');
  const { loadShortcutMap } = await import('../src/core/shortcuts.js');
  assert.equal(loadShortcutMap().togglePlay, 'Space');
});

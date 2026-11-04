// 全局快捷键注册表（P-012）：录制、持久化、冲突检测。
// 只管理“窗口级”动作；编辑器画布内部的键位仍由各画布自己处理（它们有上下文）。
const STORE_KEY = 'fufumidi_shortcuts_v1';

export const SHORTCUT_ACTIONS = [
  { id: 'togglePlay', label: '播放 / 暂停', combo: 'Space' },
  { id: 'seekBack', label: '快退', combo: 'ArrowLeft' },
  { id: 'seekForward', label: '快进', combo: 'ArrowRight' },
  { id: 'nextSong', label: '下一首（任意页面都可用）', combo: 'N' },
  { id: 'prevSong', label: '上一首（任意页面都可用）', combo: 'P' },
  { id: 'cycleMode', label: '切换播放模式（顺序/随机/单曲/列表）', combo: 'O' },
  { id: 'toggleLoop', label: '切换循环', combo: 'L' },
  { id: 'toggleMetro', label: '切换节拍器', combo: 'M' },
  { id: 'palette', label: '打开命令面板', combo: 'Ctrl+K' },
  { id: 'help', label: '打开新手引导 / 帮助', combo: 'F1' },
];

export function defaultShortcutMap() {
  const m = {};
  for (const a of SHORTCUT_ACTIONS) m[a.id] = a.combo;
  return m;
}

export function loadShortcutMap() {
  const map = defaultShortcutMap();
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    for (const a of SHORTCUT_ACTIONS) {
      const v = raw && raw[a.id];
      if (typeof v === 'string' && v.trim()) map[a.id] = v.trim();
    }
  } catch (e) { /* 坏数据回退默认 */ }
  return map;
}

export function saveShortcutMap(map) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(map)); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('fufumidi-shortcuts-changed')); } catch (e) {}
}

/** 事件 → 规范化组合键（Ctrl/Meta 统一为 Ctrl；字母大写；空格/转义用可读名） */
export function eventCombo(e) {
  if (!e) return '';
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = String(e.key || '');
  if (!key || key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return '';
  if (key === ' ') key = 'Space';
  else if (key === 'Escape') key = 'Esc';
  else if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') { /* keep */ }
  else if (key.length === 1) key = key.toUpperCase();
  return mods.concat(key).join('+');
}

export function matchShortcutAction(e, map = loadShortcutMap()) {
  const combo = eventCombo(e);
  if (!combo) return null;
  for (const a of SHORTCUT_ACTIONS) {
    if ((map[a.id] || a.combo) === combo) return a.id;
  }
  return null;
}

/** 保存一个改键；冲突时不写入，返回冲突动作。 */
export function setShortcut(id, combo) {
  const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
  if (!action || !combo) return { ok: false, error: 'invalid' };
  const map = loadShortcutMap();
  for (const a of SHORTCUT_ACTIONS) {
    if (a.id !== id && (map[a.id] || a.combo) === combo) {
      return { ok: false, conflict: a, map };
    }
  }
  map[id] = combo;
  saveShortcutMap(map);
  return { ok: true, map };
}

export function resetShortcuts() {
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('fufumidi-shortcuts-changed')); } catch (e) {}
  return defaultShortcutMap();
}

// ============================================================
// 全局热键（操作系统级）
//
// 与渲染进程里的 onKey 快捷键是两件事：
//   · onKey        —— 应用内快捷键，窗口必须有焦点；分发给 UI 层处理
//   · 本模块       —— globalShortcut 注册到**操作系统**，应用在后台/失焦/最小化时依然触发
//
// 设计原则（用户要求"自己录制"）：
//   1. **默认一个都不注册** —— 系统级热键会和其他软件抢键，必须由用户显式开启；
//   2. 用户在「设置 → 快捷键 → 全局热键」里录制组合键，逐条启用；
//   3. 注册失败（被别的程序占用）如实回报，不静默失败、不覆盖别人的键；
//   4. 改完立即生效（不需要重启应用）。
// ============================================================
'use strict';
const { globalShortcut } = require('electron');

/** 可绑定的动作。id 是渲染进程与设置文件共用的稳定标识。 */
const HOTKEY_ACTIONS = [
  { id: 'toggle', label: '播放 / 暂停', fallback: 'MediaPlayPause' },
  { id: 'next', label: '下一首', fallback: 'MediaNextTrack' },
  { id: 'prev', label: '上一首', fallback: 'MediaPreviousTrack' },
  { id: 'cycleMode', label: '切换播放模式', fallback: 'MediaStop' },
];

/** 设置里持久化的形状：{ [actionId]: { accel: string, enabled: boolean } } */
function normalizeMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const a of HOTKEY_ACTIONS) {
    const it = raw[a.id];
    if (!it || typeof it !== 'object') continue;
    const accel = typeof it.accel === 'string' ? it.accel.trim() : '';
    if (!accel) continue;
    out[a.id] = { accel, enabled: it.enabled !== false };
  }
  return out;
}

function createHotkeys({ readSettings, writeSettings, getWindow }) {
  /** 上一次应用的结果，供 UI 展示「已生效 / 被占用」 */
  let state = { map: {}, active: {}, failed: {} };

  function send(channel, payload) {
    try {
      const win = getWindow && getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    } catch (e) { /* 窗口还没起来就丢弃，UI 下次 apply 时会拿到状态 */ }
  }

  function readMap() {
    try {
      const s = readSettings() || {};
      return normalizeMap(s.global_hotkeys);
    } catch (e) { return {}; }
  }

  /** 全部注销（退出前 / 重新应用前都要先清干净，否则旧键会变成幽灵热键） */
  function unregisterAll() {
    for (const a of HOTKEY_ACTIONS) {
      const it = state.map[a.id];
      if (it && it.accel) { try { globalShortcut.unregister(it.accel); } catch (e) {} }
    }
    state.active = {};
    state.failed = {};
  }

  /**
   * 按当前设置（或传入的 map）重新注册全部热键。
   * 返回 { ok, active, failed, map } —— failed 里带上系统给的失败原因，
   * UI 直接把「被占用」写在那一条上，而不是让用户猜为什么没反应。
   */
  function apply(nextMap, { persist = false } = {}) {
    const map = normalizeMap(nextMap || readMap());
    unregisterAll();
    state.map = map;
    for (const a of HOTKEY_ACTIONS) {
      const it = map[a.id];
      if (!it || !it.enabled || !it.accel) continue;
      let ok = false;
      let err = '';
      try { ok = globalShortcut.register(it.accel, () => send('hotkey:action', a.id)); }
      catch (e) { err = String((e && e.message) || e); }
      if (ok) state.active[a.id] = it.accel;
      else state.failed[a.id] = err || '注册失败（该组合键可能已被其他程序占用）';
    }
    if (persist) {
      try {
        const s = readSettings() || {};
        s.global_hotkeys = map;
        writeSettings(s);
      } catch (e) { /* 写失败不影响本次生效 */ }
    }
    const payload = { ok: Object.keys(state.failed).length === 0, ...state };
    send('hotkeys:state', payload);
    return payload;
  }

  /** 应用启动时调用：只按**已保存**的设置注册（默认空 → 一个都不注册） */
  function init() { return apply(null, { persist: false }); }

  /** 退出前必须注销，否则会留下系统级幽灵热键（重装前后都可能踩到） */
  function dispose() {
    try { globalShortcut.unregisterAll(); } catch (e) {}
    state.active = {};
    state.failed = {};
  }

  return { init, apply, dispose, readMap, HOTKEY_ACTIONS, getState: () => ({ ...state }) };
}

module.exports = { createHotkeys, HOTKEY_ACTIONS, normalizeMap };

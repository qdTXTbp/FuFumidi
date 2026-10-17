// ============================================================
// C1 CommandRegistry（v6.0.0 契约冻结版 · 实现）
// ============================================================
// 目标：菜单 / 工具栏 / 右键 / 快捷键 / 命令面板 / 宏 共用**一份命令表**，不再各写各的。
// 契约（docs/plans/2026-10-18-v6-contracts.md C1）：
//   register({ id, title, area, keys, when, run, undoable, palette }) → unregister
//   all(ctx) / palette(query, ctx) / byKeys(comboOrEvent, ctx) / conflicts(ctx)
//   run(id, ctx) -> {ok, error?}（统一 try/catch）
//   on('changed'|'ran'|'error', fn) -> off
//
// 规则：id = area.action[.variant]（ASCII，见 ID_RE）；title 是 i18n 中文原文，UI 走 t()；
//       同一 keys 且在相同 ctx 下同时可用 = 冲突（启动期告警，设置页展示）。

export const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/i;

const MOD_ALIAS = { mod: 'ctrl', cmdorctrl: 'ctrl', command: 'ctrl', control: 'ctrl', option: 'alt' };
const MOD_ORDER = ['ctrl', 'shift', 'alt', 'meta'];

/** 规范化组合键："Ctrl+Shift+P" → "ctrl+shift+p"；Mod/CmdOrCtrl → ctrl；修饰键顺序固定 */
export function normalizeCombo(combo) {
  if (!combo) return '';
  const parts = String(combo).split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const mods = [];
  let key = '';
  for (const p of parts) {
    const m = MOD_ALIAS[p] || p;
    if (MOD_ORDER.includes(m)) { if (!mods.includes(m)) mods.push(m); }
    else key = p;
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const name = key === 'esc' ? 'escape' : key === 'del' ? 'delete' : key;
  return mods.concat(name ? [name] : []).join('+');
}

/** 由 KeyboardEvent 得到规范化组合键字符串（快捷键分发用） */
export function comboOfEvent(e) {
  if (!e) return '';
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.shiftKey) mods.push('shift');
  if (e.altKey) mods.push('alt');
  if (e.metaKey) mods.push('meta');
  let key = e.key || '';
  if (key === ' ') key = 'space';
  else if (key === 'Escape') key = 'escape';
  else if (key === 'Delete' || key === 'Backspace') key = 'delete';
  else if (key === 'ArrowUp') key = 'up';
  else if (key === 'ArrowDown') key = 'down';
  else if (key === 'ArrowLeft') key = 'left';
  else if (key === 'ArrowRight') key = 'right';
  else if (key.length === 1) key = key.toLowerCase();
  return normalizeCombo(mods.concat([key]).join('+'));
}

/** 命令面板打分：连续子串 > 子序列（与旧 CommandPalette 同一套规则，移到这里统一） */
export function scoreText(label, query) {
  const s = String(label || '').toLowerCase();
  const q = String(query || '').toLowerCase().trim();
  if (!q) return 1;
  const i = s.indexOf(q);
  if (i >= 0) return 1000 - i;
  let k = 0;
  for (const ch of s) { if (ch === q[k]) k++; if (k === q.length) return 100; }
  return 0;
}

/**
 * @param {{t?:(s:string)=>string, toast?:(m:string,type?:string)=>void, onWarn?:(m:string)=>void, onError?:(e:any)=>void}} opts
 */
export function createCommandRegistry(opts = {}) {
  const t = typeof opts.t === 'function' ? opts.t : (s) => s;
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : (m) => console.warn('[commands] ' + m);
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  const toast = typeof opts.toast === 'function' ? opts.toast : null;

  const map = new Map();
  const listeners = new Map();

  function on(evt, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => { const s = listeners.get(evt); if (s) s.delete(fn); };
  }
  function emit(evt, payload) {
    const s = listeners.get(evt);
    if (!s) return;
    for (const fn of s) { try { fn(payload); } catch (e) { /* 订阅者异常不影响命令执行 */ } }
  }

  function available(cmd, ctx) {
    if (typeof cmd.when !== 'function') return true;
    try { return !!cmd.when(ctx); } catch (e) { return false; }
  }

  function register(cmd) {
    if (!cmd || typeof cmd !== 'object') throw new Error('commands.register: 需要命令对象');
    if (!ID_RE.test(String(cmd.id || ''))) throw new Error('commands.register: 非法 id（应为 area.action[.variant]）：' + cmd.id);
    if (typeof cmd.run !== 'function') throw new Error('commands.register: 缺少 run()：' + cmd.id);
    const rec = {
      id: String(cmd.id),
      title: String(cmd.title || cmd.id),
      area: String(cmd.area || String(cmd.id).split('.')[0]),
      keys: cmd.keys ? normalizeCombo(cmd.keys) : '',
      when: typeof cmd.when === 'function' ? cmd.when : null,
      run: cmd.run,
      undoable: !!cmd.undoable,
      palette: cmd.palette !== false,
      hint: cmd.hint ? String(cmd.hint) : '',
    };
    if (map.has(rec.id)) onWarn('命令 id 重复，已覆盖：' + rec.id);
    map.set(rec.id, rec);
    emit('changed', { id: rec.id, added: true });
    return () => unregister(rec.id);
  }
  function registerAll(list) { return (list || []).map(register); }
  function unregister(id) {
    const ok = map.delete(String(id));
    if (ok) emit('changed', { id: String(id), added: false });
    return ok;
  }
  function get(id) { return map.get(String(id)) || null; }
  function size() { return map.size; }
  function all(ctx) {
    return [...map.values()].map((c) => Object.assign({}, c, { disabled: !available(c, ctx) }));
  }
  function palette(query, ctx) {
    const out = [];
    for (const c of map.values()) {
      if (!c.palette) continue;
      const label = t(c.title);
      const sc = Math.max(scoreText(label, query), scoreText(c.title, query), scoreText(c.area + ' ' + label, query) * 0.5);
      if (sc > 0 && available(c, ctx)) out.push({ cmd: c, score: sc, label });
    }
    out.sort((a, b) => b.score - a.score || a.cmd.id.localeCompare(b.cmd.id));
    return out.map((x) => ({
      id: x.cmd.id, group: x.cmd.area, label: x.label, title: x.cmd.title,
      hint: x.cmd.hint || (x.cmd.keys ? x.cmd.keys.toUpperCase().replace(/CTRL/g, 'Ctrl') : ''),
      keys: x.cmd.keys, undoable: x.cmd.undoable, palette: x.cmd.palette,
    }));
  }
  function byKeys(comboOrEvent, ctx) {
    const combo = (comboOrEvent && typeof comboOrEvent === 'object' && 'key' in comboOrEvent)
      ? comboOfEvent(comboOrEvent) : normalizeCombo(comboOrEvent);
    if (!combo) return [];
    return [...map.values()].filter((c) => c.keys === combo && available(c, ctx));
  }
  function conflicts(ctx) {
    const byCombo = new Map();
    for (const c of map.values()) {
      if (!c.keys || !available(c, ctx)) continue;
      if (!byCombo.has(c.keys)) byCombo.set(c.keys, []);
      byCombo.get(c.keys).push(c.id);
    }
    const out = [];
    for (const [keys, ids] of byCombo) if (ids.length > 1) out.push({ keys, ids });
    return out;
  }
  async function run(idOrCmd, ctx) {
    const cmd = typeof idOrCmd === 'object' ? idOrCmd : map.get(String(idOrCmd));
    if (!cmd) return { ok: false, error: '命令不存在：' + idOrCmd };
    if (!available(cmd, ctx)) return { ok: false, error: '命令当前不可用：' + cmd.id };
    const started = Date.now();
    try {
      await cmd.run(ctx);
      emit('ran', { id: cmd.id, ok: true, ms: Date.now() - started });
      return { ok: true };
    } catch (e) {
      const error = String((e && e.message) || e);
      if (onError) { try { onError(e); } catch (_) {} }
      else if (toast) { try { toast(t('命令执行失败：') + error, 'warn'); } catch (_) {} }
      else console.error('[commands] ' + cmd.id + ' 失败：', e);
      emit('error', { id: cmd.id, error });
      return { ok: false, error };
    }
  }
  async function runSequence(ids, ctx) {
    const results = [];
    for (const id of ids || []) {
      const r = await run(id, ctx);
      results.push(r);
      if (!r.ok) break;
    }
    return results;
  }
  function reset() { map.clear(); emit('changed', { reset: true }); }

  return { register, registerAll, unregister, get, size, all, palette, byKeys, conflicts, run, runSequence, on, reset, available };
}

/** 应用级单例：菜单/命令面板/快捷键都从这里取（错误默认打到控制台，UI 可自行 toast） */
export const commands = createCommandRegistry({
  t: (s) => { try { return (typeof window !== 'undefined' && window.__fufumidiT) ? window.__fufumidiT(s) : s; } catch (e) { return s; } },
});

// ============================================================
// P1-14 B3 导航历史 / 深链接 / 会话恢复（纯逻辑 + 单例）
// ============================================================
// 导航历史：hash 路由的"后退/前进"栈。规则：
//   · 连续重复路径不重复入栈（切页签再切回来只算一次）；
//   · 前进后做新导航会丢弃前进栈（浏览器语义）；
//   · 上限 50 条，最旧的丢弃；
//   · back()/forward() 由调用方负责真正 router.push —— 本模块只给目标路径。
// 深链接：#/views?tab=arrange 这类路径 → {view, tab}；用于会话语义校验与"复制链接"。
// 会话恢复：只存「最近一次视图 hash + 曲目 id + 时间」，7 天内且当前还在首页时才恢复，
//           避免用户主动打开某个文件时被旧会话抢走。

export const NAV_LIMIT = 50;
export const SESSION_KEY = 'fufumidi.session.v1';
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

/** 视图 → 允许的页签（与 ViewViews/ViewResources 的 rcTabs 对应；多一个也别崩） */
export const VIEW_TABS = {
  views: ['viz', 'analyze', 'score', 'arrange'],
  resources: ['model', 'soundfonts', 'resources', 'storage'],
  singer: ['editor', 'banks'],
  transcode: ['transcribe', 'convert'],
};

/** 导航历史栈（普通对象，不依赖 Vue；调用方可自行用 callback 触发刷新） */
export function createNavHistory(opts = {}) {
  const limit = Math.max(2, Number(opts.limit) || NAV_LIMIT);
  const stack = [];
  let index = -1;
  const listeners = [];
  const state = { applying: false };   // 执行 back/forward 时置 true，路由 watcher 据此不重复入栈

  function emit() { for (const fn of listeners) { try { fn(snapshot()); } catch (e) {} } }
  function snapshot() {
    return { stack: stack.slice(), index, canBack: index > 0, canForward: index >= 0 && index < stack.length - 1 };
  }
  function current() { return index >= 0 ? stack[index] : ''; }
  function push(path) {
    const p = String(path || '');
    if (!p) return snapshot();
    if (p === current()) return snapshot();            // 连续重复不入栈
    stack.length = index + 1;                          // 丢弃前进栈
    stack.push(p);
    if (stack.length > limit) stack.shift();
    index = stack.length - 1;
    emit();
    return snapshot();
  }
  function canBack() { return index > 0; }
  function canForward() { return index >= 0 && index < stack.length - 1; }
  function back() {
    if (!canBack()) return null;
    const target = stack[index - 1];
    index -= 1;
    emit();
    return target;
  }
  function forward() {
    if (!canForward()) return null;
    const target = stack[index + 1];
    index += 1;
    emit();
    return target;
  }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
  function clear() { stack.length = 0; index = -1; emit(); }
  return { push, back, forward, canBack, canForward, current, snapshot, onChange, clear, state, get limit() { return limit; } };
}

/** 应用级单例（TopBar 与 App 共用；不放进 Pinia 是为了纯逻辑可测） */
export const navHistory = createNavHistory();

/** 去掉 hash 前缀后的纯路径（'#/views?tab=arrange' → '/views?tab=arrange'） */
export function normalizePath(hash) {
  const s = String(hash || '').trim();
  if (!s) return '';
  if (s.startsWith('#')) return s.slice(1) || '/';
  return s.startsWith('/') ? s : '/' + s;
}

/**
 * 深链接解析：#/views?tab=arrange&song=abc → {view:'views', tab:'arrange', query:{...}, valid:true}
 * 未知视图返回 {view:'', valid:false}（调用方回落首页，不抛）。
 */
export function parseDeepLink(hash) {
  const path = normalizePath(hash).split('#')[0];
  const [p, qs = ''] = path.split('?');
  const segs = p.split('/').filter(Boolean);
  const view = segs[0] || 'home';
  const query = {};
  if (qs) {
    for (const part of qs.split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      const k = decodeURIComponent(i >= 0 ? part.slice(0, i) : part);
      const v = i >= 0 ? decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' ')) : '';
      if (k) query[k] = v;
    }
  }
  const known = ['home', 'music', 'views', 'transcode', 'resources', 'singer', 'cover', 'plugins', 'about', 'edit', 'play', 'lyrics', 'viz', 'analyze', 'score', 'transcribe', 'convert', 'voicebank'];
  if (!known.includes(view)) return { view: '', tab: '', query, path: p, valid: false };
  let tab = String(query.tab || '');
  const allowed = VIEW_TABS[view];
  if (allowed && tab && !allowed.includes(tab)) tab = '';
  return { view, tab, query, path: p, valid: true };
}

/** 生成深链接（保证 tab 合法；非法 tab 忽略） */
export function buildDeepLink(view, opts = {}) {
  const v = String(view || 'home');
  const parts = [];
  let tab = String(opts.tab || '');
  const allowed = VIEW_TABS[v];
  if (allowed && tab && !allowed.includes(tab)) tab = '';
  if (tab) parts.push('tab=' + encodeURIComponent(tab));
  for (const k of Object.keys(opts.query || {})) {
    if (k === 'tab') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(opts.query[k])));
  }
  return '#/' + v + (parts.length ? '?' + parts.join('&') : '');
}

/** 会话快照清洗（损坏/过期返回 null） */
export function normalizeSession(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const hash = normalizePath(raw.hash);
  if (!hash) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || now - at > SESSION_TTL_MS || now - at < -60000) return null;
  return { hash, songId: raw.songId == null ? '' : String(raw.songId), at };
}

/** 读写会话（localStorage 不可用时静默跳过，例如隐私模式） */
export function readSession() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SESSION_KEY) : null;
    if (!raw) return null;
    return normalizeSession(JSON.parse(raw));
  } catch (e) { return null; }
}
export function writeSession(session, now = Date.now()) {
  try {
    const s = normalizeSession(Object.assign({}, session, { at: now }), now);
    if (!s || typeof localStorage === 'undefined') return false;
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    return true;
  } catch (e) { return false; }
}

// ============================================================
// cjs-loader.js —— 插件 CommonJS 加载器（纯 ESM，无 DOM / 无 fs 依赖）
//
// 用途：在 Web Worker（Tauri/WebView2）与 node --test 中执行插件入口脚本。
// 语义对齐 Electron 侧的 plugin-host.js / plugin-worker.js：
//   · 只能 require 插件目录内的相对模块（.js / .json / 目录 index.*），越界直接拒绝；
//   · 内置模块走白名单（path/util/events/url/querystring/assert/os/crypto/buffer），
//     黑名单（fs/child_process/net/...）明确报错，未知模块报「未在白名单中」；
//   · 模块缓存、循环引用（先入缓存再执行）、JSON 文件直接解析；
//   · 每个模块有 __filename / __dirname（有 rootDir 时是插件真实绝对路径）。
//
// 边界说明（与 Electron 一致）：这不是安全沙箱 —— 插件是用户主动安装的可信代码。
// 白名单/防越界是「卫生围栏」，真正隔离靠独立 Worker。
// ============================================================

export const SANDBOX_ALLOWED_BUILTINS = new Set([
  'path', 'util', 'events', 'url', 'querystring', 'assert', 'os', 'crypto', 'buffer',
]);

export const SANDBOX_DENIED_BUILTINS = new Set([
  'fs', 'child_process', 'net', 'http', 'https', 'dns', 'tls', 'worker_threads', 'cluster', 'repl', 'v8',
]);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 统一成「插件根目录相对的 POSIX 路径」；去掉 . / 前导斜杠。 */
export function normalizePluginPath(input) {
  let p = String(input == null ? '' : input).replace(/\\/g, '/');
  p = p.replace(/^\/+/, '');
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/** files 支持 [{path, content}] / Map / { path: content } 三种形态。 */
export function normalizePluginFiles(files) {
  const map = new Map();
  const add = (path, content) => {
    const key = normalizePluginPath(path);
    if (!key) return;
    map.set(key, typeof content === 'string' ? content : String(content == null ? '' : content));
  };
  if (Array.isArray(files)) {
    for (const f of files) if (f && f.path != null) add(f.path, f.content);
  } else if (files instanceof Map) {
    for (const [k, v] of files) add(k, v);
  } else if (files && typeof files === 'object') {
    for (const k of Object.keys(files)) add(k, files[k]);
  }
  return map;
}

function toPosixRoot(rootDir) {
  if (!rootDir) return '';
  return String(rootDir).replace(/\\/g, '/').replace(/\/+$/, '');
}

function posixDirname(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}

function pickCandidate(files, base) {
  const b = base || '';
  const candidates = [b, b + '.js', b + '.json'];
  if (b) candidates.push(b + '/index.js', b + '/index.json');
  else candidates.push('index.js', 'index.json');
  for (const c of candidates) {
    const id = normalizePluginPath(c);
    if (id && files.has(id)) return id;
  }
  return null;
}

function resolveFileRequest(request, parentFile, files, rootDir) {
  let req = String(request).replace(/\\/g, '/');
  const rootPosix = toPosixRoot(rootDir);
  if (rootPosix && /^[A-Za-z]:\//.test(req)) {
    const lower = req.toLowerCase();
    const rootLower = rootPosix.toLowerCase();
    if (lower === rootLower) req = '/';
    else if (lower.startsWith(rootLower + '/')) req = req.slice(rootPosix.length);
    else throw new Error('插件 require 越界：' + request);
  } else if (/^[A-Za-z]:\//.test(req) || req.startsWith('//')) {
    throw new Error('插件 require 越界：' + request);
  }
  const rooted = req.startsWith('/');
  const segments = rooted ? [] : (parentFile ? parentFile.split('/').slice(0, -1) : []);
  for (const seg of req.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!segments.length) throw new Error('插件 require 越界：' + request);
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  const id = pickCandidate(files, segments.join('/'));
  if (!id) throw new Error('插件 require 找不到模块：' + request);
  return id;
}

// ------------------------------------------------------------
// 内置模块 shim（最小实现：只覆盖插件常用面）
// ------------------------------------------------------------

/** path：Windows / POSIX 两套语义，默认跟随 process.platform。 */
export function createPathShim(platform) {
  const isWin = (platform || 'win32') === 'win32';
  const sep = isWin ? '\\' : '/';
  const delimiter = isWin ? ';' : ':';

  if (!isWin) {
    const norm = (p) => {
      if (typeof p !== 'string') throw new TypeError('path 参数必须是字符串');
      if (!p) return '.';
      const rooted = p.startsWith('/');
      const out = [];
      for (const seg of p.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') { if (out.length) out.pop(); continue; }
        out.push(seg);
      }
      return (rooted ? '/' : '') + out.join('/') || (rooted ? '/' : '.');
    };
    const join = (...args) => {
      const parts = args.filter((x) => x != null && x !== '');
      return norm(parts.length ? parts.join('/') : '.');
    };
    const dirname = (p) => {
      const s = norm(p);
      if (s === '/' || s === '.') return s;
      const i = s.lastIndexOf('/');
      return i <= 0 ? (i === 0 ? '/' : '.') : s.slice(0, i);
    };
    const basename = (p, ext) => {
      const s = String(p == null ? '' : p);
      const clean = s.length > 1 ? s.replace(/\/+$/, '') : s;
      const i = clean.lastIndexOf('/');
      let name = i < 0 ? clean : clean.slice(i + 1);
      if (ext && name.length > ext.length && name.endsWith(ext)) name = name.slice(0, -ext.length);
      return name;
    };
    const extname = (p) => {
      const name = basename(p).replace(/^\.+/, (m) => (m.length === 1 && m === '.' ? '.' : ''));
      const i = name.lastIndexOf('.');
      return i <= 0 ? '' : name.slice(i);
    };
    const isAbsolute = (p) => String(p || '').startsWith('/');
    const parse = (p) => {
      const s = String(p == null ? '' : p);
      const dir = dirname(s);
      const base = basename(s);
      const ext = extname(s);
      return { root: s.startsWith('/') ? '/' : '', dir: dir === '.' && !s.includes('/') ? '' : dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
    };
    const format = (o) => {
      const dir = o.dir || (o.root || '');
      const base = o.base || ((o.name || '') + (o.ext || ''));
      if (!dir) return base;
      return (dir.endsWith('/') ? dir : dir + '/') + base;
    };
    const resolve = (...args) => {
      const vals = args.filter((x) => x != null && x !== '');
      let rootedIdx = -1;
      for (let i = vals.length - 1; i >= 0; i--) if (String(vals[i]).startsWith('/')) { rootedIdx = i; break; }
      const parts = rootedIdx >= 0 ? vals.slice(rootedIdx) : vals;
      return norm(parts.join('/') || '.');
    };
    const relative = (from, to) => {
      const a = norm(from).split('/').filter(Boolean);
      const b = norm(to).split('/').filter(Boolean);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      const up = new Array(Math.max(0, a.length - i)).fill('..');
      const rest = b.slice(i);
      return up.concat(rest).join('/') || '.';
    };
    return { sep, delimiter, normalize: norm, join, dirname, basename, extname, isAbsolute, parse, format, resolve, relative, toNamespacedPath: (p) => p };
  }

  // ---- Windows：额外兼容 /（插件拿到的路径来自 bridge，可能混用两种分隔符） ----
  const splitWin = (p) => {
    let s = String(p == null ? '' : p).replace(/\//g, '\\');
    let root = '';
    const drive = /^([A-Za-z]:)/.exec(s);
    if (drive) { root = drive[1]; s = s.slice(root.length); }
    if (s.startsWith('\\')) { root += '\\'; s = s.replace(/^\\+/, ''); }
    const parts = s.split(/\\+/).filter(Boolean);
    return { root, parts };
  };
  const joinWin = (root, parts) => {
    const body = parts.join('\\');
    if (!root) return body || '.';
    if (root.endsWith('\\')) return root + body;
    return root + (body ? '\\' + body : '');
  };
  const normWin = (p) => {
    if (typeof p !== 'string') throw new TypeError('path 参数必须是字符串');
    if (!p) return '.';
    const { root, parts } = splitWin(p);
    const out = [];
    for (const seg of parts) {
      if (seg === '.') continue;
      if (seg === '..') { if (out.length) out.pop(); continue; }
      out.push(seg);
    }
    if (!root && !out.length) return '.';
    return joinWin(root, out);
  };
  const join = (...args) => {
    const parts = args.filter((x) => x != null && x !== '');
    if (!parts.length) return '.';
    return normWin(parts.join('\\'));
  };
  const dirname = (p) => {
    const { root, parts } = splitWin(p);
    if (!parts.length) return root || '.';
    parts.pop();
    if (!parts.length) return root || '.';
    return joinWin(root, parts);
  };
  const basename = (p, ext) => {
    const { parts } = splitWin(p);
    let name = parts.length ? parts[parts.length - 1] : '';
    if (ext && name.length > ext.length && name.endsWith(ext)) name = name.slice(0, -ext.length);
    return name;
  };
  const extname = (p) => {
    const name = basename(p);
    if (!name || name === '.' || name === '..') return '';
    const i = name.lastIndexOf('.');
    return i <= 0 ? '' : name.slice(i);
  };
  const isAbsolute = (p) => {
    const s = String(p || '');
    return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('\\') || s.startsWith('/');
  };
  const parse = (p) => {
    const s = String(p == null ? '' : p);
    const { root } = splitWin(s);
    const base = basename(s);
    const ext = extname(s);
    const dir = dirname(s);
    return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
  };
  const format = (o) => {
    const dir = o.dir || (o.root || '');
    const base = o.base || ((o.name || '') + (o.ext || ''));
    if (!dir) return base;
    if (/[\\/]$/.test(dir)) return dir + base;
    return dir + '\\' + base;
  };
  const resolve = (...args) => {
    const vals = args.filter((x) => x != null && x !== '');
    if (!vals.length) return '.';
    let start = -1;
    for (let i = vals.length - 1; i >= 0; i--) if (isAbsolute(vals[i])) { start = i; break; }
    const parts = start >= 0 ? vals.slice(start) : vals;
    if (start < 0) return normWin(parts.join('\\'));
    // 有绝对段：保留其盘符/根，其余按反斜杠拼接
    const abs = String(parts[0]).replace(/\//g, '\\');
    const rest = parts.slice(1).join('\\');
    return normWin(rest ? abs.replace(/[\\/]+$/, '') + '\\' + rest : abs);
  };
  const relative = (from, to) => {
    const a = splitWin(from);
    const b = splitWin(to);
    const sameRoot = (a.root || '').toLowerCase() === (b.root || '').toLowerCase();
    if (!sameRoot) return normWin(String(to));
    let i = 0;
    while (i < a.parts.length && i < b.parts.length && a.parts[i].toLowerCase() === b.parts[i].toLowerCase()) i++;
    const up = new Array(Math.max(0, a.parts.length - i)).fill('..');
    const rest = b.parts.slice(i);
    const all = up.concat(rest);
    return all.length ? all.join('\\') : '.';
  };
  return { sep, delimiter, normalize: normWin, join, dirname, basename, extname, isAbsolute, parse, format, resolve, relative, toNamespacedPath: (p) => p };
}

/** util：format / inspect / promisify / inherits / deprecate */
export function createUtilShim() {
  const inspect = (v, depth = 0) => {
    if (typeof v === 'string') return JSON.stringify(v);
    if (v === null || typeof v !== 'object') return String(v);
    if (depth > 4) return '[Object]';
    if (Array.isArray(v)) return '[' + v.map((x) => inspect(x, depth + 1)).join(', ') + ']';
    try {
      const keys = Object.keys(v);
      return '{ ' + keys.map((k) => k + ': ' + inspect(v[k], depth + 1)).join(', ') + ' }';
    } catch (e) { return '[Object]'; }
  };
  const format = (...args) => {
    if (!args.length) return '';
    if (typeof args[0] !== 'string') return args.map((a) => inspect(a)).join(' ');
    let i = 0;
    const head = args[0].replace(/%[sdifjoO%]/g, (m) => {
      if (m === '%%') return '%';
      i++;
      const v = args[i];
      switch (m) {
        case '%s': return typeof v === 'string' ? v : inspect(v);
        case '%d': return String(Number(v));
        case '%i': return String(parseInt(v, 10));
        case '%f': return String(parseFloat(v));
        case '%j': try { return JSON.stringify(v); } catch (e) { return '[Circular]'; }
        default: return inspect(v);
      }
    });
    return [head].concat(args.slice(i + 1).map((a) => inspect(a))).join(' ');
  };
  const promisify = (fn) => {
    if (typeof fn !== 'function') throw new TypeError('util.promisify 需要函数');
    return function (...args) {
      return new Promise((resolve, reject) => {
        fn.call(this, ...args, (err, ...rest) => {
          if (err) reject(err);
          else resolve(rest.length > 1 ? rest : rest[0]);
        });
      });
    };
  };
  const callbackify = (fn) => function (...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const p = Promise.resolve().then(() => fn.apply(this, args));
    if (!cb) return p;
    p.then((v) => cb(null, v), (e) => cb(e));
    return undefined;
  };
  return {
    format, inspect, promisify, callbackify,
    inherits: (ctor, superCtor) => {
      ctor.super_ = superCtor;
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
    },
    deprecate: (fn) => fn,
    isDeepStrictEqual: (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return a === b; } },
    types: { isPromise: (v) => !!v && typeof v.then === 'function' },
  };
}

/** events：EventEmitter（on/once/off/emit/removeAllListeners…） */
export function createEventsModule() {
  class EventEmitter {
    constructor() { this._events = Object.create(null); this._maxListeners = 10; }
    on(name, fn) { return this.addListener(name, fn); }
    addListener(name, fn) {
      if (typeof fn !== 'function') throw new TypeError('listener 必须是函数');
      const key = String(name);
      (this._events[key] || (this._events[key] = [])).push(fn);
      return this;
    }
    prependListener(name, fn) {
      const key = String(name);
      (this._events[key] || (this._events[key] = [])).unshift(fn);
      return this;
    }
    once(name, fn) {
      const wrap = (...args) => { this.removeListener(name, wrap); fn.apply(this, args); };
      return this.on(name, wrap);
    }
    off(name, fn) { return this.removeListener(name, fn); }
    removeListener(name, fn) {
      const key = String(name);
      const arr = this._events[key];
      if (!arr) return this;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length) delete this._events[key];
      return this;
    }
    removeAllListeners(name) {
      if (name == null) this._events = Object.create(null);
      else delete this._events[String(name)];
      return this;
    }
    listeners(name) { return (this._events[String(name)] || []).slice(); }
    listenerCount(name) { return (this._events[String(name)] || []).length; }
    eventNames() { return Object.keys(this._events); }
    setMaxListeners(n) { this._maxListeners = Number(n) || 10; return this; }
    getMaxListeners() { return this._maxListeners; }
    emit(name, ...args) {
      const key = String(name);
      const arr = this._events[key];
      if (!arr || !arr.length) {
        if (key === 'error') throw (args[0] instanceof Error ? args[0] : new Error('Unhandled error'));
        return false;
      }
      for (const fn of arr.slice()) fn.apply(this, args);
      return true;
    }
  }
  return { EventEmitter, default: EventEmitter, once: (emitter, name) => new Promise((res) => emitter.once(name, (...a) => res(a))) };
}

/** url / querystring / assert / os / crypto / buffer 的最小实现 */
export function createUrlShim() {
  const URLImpl = (typeof URL !== 'undefined') ? URL : class URL { constructor(u) { this.href = String(u); } toString() { return this.href; } };
  const URLSearchParamsImpl = (typeof URLSearchParams !== 'undefined') ? URLSearchParams : class URLSearchParams { constructor() {} };
  const parse = (url) => {
    try {
      const u = new URLImpl(String(url));
      return {
        href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port,
        pathname: u.pathname, search: u.search, hash: u.hash,
        query: u.search ? Object.fromEntries(u.searchParams.entries()) : {},
      };
    } catch (e) { return { href: String(url), query: {} }; }
  };
  const format = (obj) => {
    if (!obj) return '';
    if (obj instanceof URLImpl) return obj.href;
    let out = '';
    if (obj.protocol) out += String(obj.protocol).replace(/:*$/, '') + ':';
    if (obj.host || obj.hostname) out += '//' + (obj.host || obj.hostname) + (obj.port ? ':' + obj.port : '');
    out += obj.pathname || '';
    if (obj.query && typeof obj.query === 'object') {
      const qs = new URLSearchParamsImpl();
      for (const k of Object.keys(obj.query)) if (obj.query[k] !== undefined) qs.append(k, String(obj.query[k]));
      const s = qs.toString();
      if (s) out += '?' + s;
    } else if (obj.search) out += obj.search;
    if (obj.hash) out += obj.hash;
    return out;
  };
  const pathToFileURL = (p) => {
    try { return new URLImpl('file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '')); } catch (e) { return { href: 'file:///' + String(p), toString() { return this.href; } }; }
  };
  const fileURLToPath = (u) => {
    const href = typeof u === 'string' ? u : (u && u.href) || '';
    return decodeURIComponent(href.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1'));
  };
  return { URL: URLImpl, URLSearchParams: URLSearchParamsImpl, parse, format, pathToFileURL, fileURLToPath, resolve: (from, to) => { try { return new URLImpl(String(to), String(from)).href; } catch (e) { return String(to); } } };
}

export function createQuerystringShim() {
  const encode = (v) => encodeURIComponent(String(v));
  const escape = (s) => encodeURIComponent(String(s));
  const unescape = (s) => {
    try { return decodeURIComponent(String(s)); } catch (e) { return String(s); }
  };
  const stringify = (obj, sep, eq) => {
    const s = sep === undefined ? '&' : String(sep);
    const e = eq === undefined ? '=' : String(eq);
    const out = [];
    const walk = (k, v) => {
      if (v === undefined || v === null) return;
      if (Array.isArray(v)) { for (const x of v) walk(k, x); return; }
      if (typeof v === 'object') { for (const kk of Object.keys(v)) walk(k + '[' + kk + ']', v[kk]); return; }
      out.push(encode(k) + e + encode(v));
    };
    if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) walk(k, obj[k]);
    return out.join(s);
  };
  const parse = (str, sep, eq) => {
    const out = Object.create(null);
    const s = sep === undefined ? '&' : String(sep);
    const e = eq === undefined ? '=' : String(eq);
    for (const pair of String(str || '').split(s)) {
      if (!pair) continue;
      const i = pair.indexOf(e);
      const k = unescape(i < 0 ? pair : pair.slice(0, i));
      const v = unescape(i < 0 ? '' : pair.slice(i + e.length));
      if (hasOwn(out, k)) {
        if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
      } else out[k] = v;
    }
    return out;
  };
  return { stringify, parse, escape, unescape, encodeURIComponent: escape, decodeURIComponent: unescape };
}

export function createAssertShim() {
  class AssertionError extends Error {
    constructor(message) { super(message || 'Assertion failed'); this.name = 'AssertionError'; this.code = 'ERR_ASSERTION'; }
  }
  const fail = (message) => { throw new AssertionError(message); };
  const assert = (value, message) => { if (!value) fail(message); };
  const deepEqualLoose = (a, b, strict) => {
    if (strict ? a === b : a == b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return strict ? a === b : a == b;
    let ja, jb;
    try { ja = JSON.stringify(a); jb = JSON.stringify(b); } catch (e) { return false; }
    return ja === jb;
  };
  assert.ok = assert;
  assert.equal = (a, b, m) => { if (a != b) fail(m || ('期望 ' + String(a) + ' == ' + String(b))); };
  assert.notEqual = (a, b, m) => { if (a == b) fail(m || ('期望 ' + String(a) + ' != ' + String(b))); };
  assert.strictEqual = (a, b, m) => { if (a !== b) fail(m || ('期望 ' + String(a) + ' === ' + String(b))); };
  assert.notStrictEqual = (a, b, m) => { if (a === b) fail(m || ('期望 ' + String(a) + ' !== ' + String(b))); };
  assert.deepEqual = (a, b, m) => { if (!deepEqualLoose(a, b, false)) fail(m || '期望深度相等'); };
  assert.deepStrictEqual = (a, b, m) => { if (!deepEqualLoose(a, b, true)) fail(m || '期望深度严格相等'); };
  assert.throws = (fn, expected, m) => {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    if (!err) fail(m || '期望函数抛出异常');
    if (typeof expected === 'function' && expected.prototype && expected !== Error && !(err instanceof expected)) fail(m || '异常类型不符');
    if (expected instanceof RegExp && !expected.test(String(err && err.message))) fail(m || '异常消息不符');
    return err;
  };
  assert.doesNotThrow = (fn, m) => { try { fn(); } catch (e) { fail(m || ('不期望抛出异常：' + (e && e.message))); } };
  assert.rejects = async (fn, m) => {
    try { await fn(); } catch (e) { return e; }
    fail(m || '期望 Promise 拒绝');
  };
  assert.match = (value, re, m) => { if (!new RegExp(re).test(String(value))) fail(m || '字符串不匹配'); };
  assert.doesNotMatch = (value, re, m) => { if (new RegExp(re).test(String(value))) fail(m || '字符串不应匹配'); };
  assert.fail = fail;
  assert.AssertionError = AssertionError;
  return assert;
}

export function createOsShim(opts) {
  const o = opts || {};
  const platform = o.platform || 'win32';
  const arch = o.arch || 'x64';
  return {
    platform: () => platform,
    arch: () => arch,
    type: () => (platform === 'win32' ? 'Windows_NT' : platform === 'darwin' ? 'Darwin' : 'Linux'),
    release: () => '',
    version: () => '',
    hostname: () => 'fufumidi',
    homedir: () => '',
    tmpdir: () => '',
    cpus: () => [],
    totalmem: () => 0,
    freemem: () => 0,
    uptime: () => 0,
    EOL: platform === 'win32' ? '\r\n' : '\n',
  };
}

export function createCryptoShim() {
  const wc = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  const randomBytes = (size) => {
    const n = Math.max(0, Number(size) || 0);
    const out = new Uint8Array(n);
    if (wc && typeof wc.getRandomValues === 'function') wc.getRandomValues(out);
    else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  };
  const randomUUID = () => {
    if (wc && typeof wc.randomUUID === 'function') return wc.randomUUID();
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  };
  const unavailable = (name) => () => { throw new Error('插件沙箱不支持 crypto.' + name + '（Web Worker 环境）'); };
  return {
    randomUUID,
    randomBytes,
    getRandomValues: (arr) => {
      if (wc && typeof wc.getRandomValues === 'function') return wc.getRandomValues(arr);
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    },
    webcrypto: wc,
    createHash: unavailable('createHash'),
    createHmac: unavailable('createHmac'),
    pbkdf2: unavailable('pbkdf2'),
  };
}

/** Buffer 的最小实现（Uint8Array 子类 + 常用静态方法）。 */
export function createBufferClass() {
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  const utf8Encode = (str) => {
    if (encoder) return encoder.encode(String(str));
    const s = unescape(encodeURIComponent(String(str)));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const utf8Decode = (bytes) => {
    if (decoder) return decoder.decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  };
  const latin1Decode = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  const latin1Encode = (str) => {
    const s = String(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  };
  const base64Encode = (bytes) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    if (typeof btoa === 'function') return btoa(bin);
    const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += table[a >> 2] + table[((a & 3) << 4) | ((b || 0) >> 4)];
      out += b === undefined ? '=' : table[((b & 15) << 2) | ((c || 0) >> 6)];
      out += c === undefined ? '=' : table[c & 63];
    }
    return out;
  };
  const base64Decode = (str) => {
    const s = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
    if (typeof atob === 'function') {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const out = [];
    for (let i = 0; i < s.length; i += 4) {
      const n = (table.indexOf(s[i]) << 18) | (table.indexOf(s[i + 1]) << 12) | (table.indexOf(s[i + 2]) << 6) | table.indexOf(s[i + 3]);
      out.push((n >> 16) & 255);
      if (s[i + 2] !== '=') out.push((n >> 8) & 255);
      if (s[i + 3] !== '=') out.push(n & 255);
    }
    return new Uint8Array(out);
  };
  const hexEncode = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const hexDecode = (str) => {
    const s = String(str);
    const out = new Uint8Array(Math.floor(s.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16) || 0;
    return out;
  };
  const encode = (value, encoding) => {
    const enc = String(encoding || 'utf8').toLowerCase();
    if (typeof value !== 'string') return new Uint8Array(value);
    if (enc === 'base64') return base64Decode(value);
    if (enc === 'hex') return hexDecode(value);
    if (enc === 'latin1' || enc === 'binary') return latin1Encode(value);
    if (enc === 'base64url') return base64Decode(value.replace(/-/g, '+').replace(/_/g, '/'));
    return utf8Encode(value);
  };
  const decode = (bytes, encoding) => {
    const enc = String(encoding || 'utf8').toLowerCase();
    if (enc === 'base64' || enc === 'base64url') return base64Encode(bytes);
    if (enc === 'hex') return hexEncode(bytes);
    if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') return latin1Decode(bytes);
    return utf8Decode(bytes);
  };
  class BufferShim extends Uint8Array {
    static get [Symbol.species]() { return Uint8Array; }
    static from(value, encodingOrOffset, length) {
      if (typeof value === 'string') return new BufferShim(encode(value, encodingOrOffset));
      if (value instanceof ArrayBuffer) return new BufferShim(new Uint8Array(value, encodingOrOffset || 0, length == null ? undefined : length));
      if (ArrayBuffer.isView(value)) return new BufferShim(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      if (Array.isArray(value)) return new BufferShim(value);
      if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) return new BufferShim(value.data);
      throw new TypeError('Buffer.from 参数不支持');
    }
    static alloc(size, fill, encoding) {
      const n = Math.max(0, Number(size) || 0);
      const out = new BufferShim(n);
      if (typeof fill === 'string' || Array.isArray(fill) || ArrayBuffer.isView(fill)) {
        const bytes = typeof fill === 'string' ? encode(fill, encoding) : fill;
        for (let i = 0; i < n; i++) out[i] = bytes[i % Math.max(1, bytes.length)] || 0;
      } else if (fill !== undefined && fill !== null) {
        out.fill(Number(fill) || 0);
      }
      return out;
    }
    static allocUnsafe(size) { return new BufferShim(Math.max(0, Number(size) || 0)); }
    static allocUnsafeSlow(size) { return BufferShim.allocUnsafe(size); }
    static isBuffer(v) { return v instanceof BufferShim; }
    static byteLength(value, encoding) {
      if (typeof value !== 'string') return value && value.byteLength != null ? Number(value.byteLength) : 0;
      return encode(value, encoding).length;
    }
    static concat(list, totalLength) {
      const arrs = Array.from(list || []).map((x) => (x instanceof Uint8Array ? x : new Uint8Array(x)));
      const total = totalLength == null ? arrs.reduce((n, a) => n + a.length, 0) : Math.max(0, Number(totalLength) || 0);
      const out = new BufferShim(total);
      let off = 0;
      for (const a of arrs) {
        const n = Math.min(a.length, total - off);
        if (n <= 0) break;
        out.set(a.subarray(0, n), off);
        off += n;
      }
      return out;
    }
    toString(encoding, start, end) {
      const s = start == null ? 0 : Math.max(0, Number(start) || 0);
      const e = end == null ? this.length : Math.max(s, Number(end) || 0);
      return decode(this.subarray(s, e), encoding);
    }
    slice(start, end) { return new BufferShim(this.subarray(start, end)); }
    subarray(start, end) { return new BufferShim(super.subarray(start, end)); }
    equals(other) {
      if (!(other instanceof Uint8Array) || other.length !== this.length) return false;
      for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    }
    compare(other) {
      const a = this, b = other || new Uint8Array(0);
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }
    write(str, offset, length, encoding) {
      let off = offset == null ? 0 : Number(offset) || 0;
      let enc = encoding;
      if (typeof length === 'string') { enc = length; }
      const bytes = encode(String(str), enc);
      const n = Math.min(bytes.length, this.length - off);
      if (n > 0) this.set(bytes.subarray(0, n), off);
      return Math.max(0, n);
    }
    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
  }
  return BufferShim;
}

/** 组装白名单内置模块。 */
export function createBuiltins(options) {
  const o = options || {};
  const platform = o.platform || (typeof process !== 'undefined' && process.platform) || 'win32';
  const arch = o.arch || (typeof process !== 'undefined' && process.arch) || 'x64';
  const BufferCtor = o.Buffer || createBufferClass();
  const pathMod = createPathShim(platform);
  return {
    path: pathMod,
    util: createUtilShim(),
    events: createEventsModule(),
    url: createUrlShim(),
    querystring: createQuerystringShim(),
    assert: createAssertShim(),
    os: createOsShim({ platform, arch }),
    crypto: createCryptoShim(),
    buffer: {
      Buffer: BufferCtor,
      kMaxLength: 0x7fffffff,
      INSPECT_MAX_BYTES: 50,
      atob: typeof atob === 'function' ? atob : undefined,
      btoa: typeof btoa === 'function' ? btoa : undefined,
    },
  };
}

// ------------------------------------------------------------
// 模块图与执行
// ------------------------------------------------------------

function builtinFor(builtins, name) {
  if (!hasOwn(builtins, name)) throw new Error('插件 require 未在白名单中：' + name);
  return builtins[name];
}

/**
 * 创建模块加载器。
 * @param {Array|Map|object} files  插件文本文件（path 为插件根目录相对路径）
 * @param {{entry?:string, rootDir?:string, builtins?:object, platform?:string, arch?:string, Buffer?:Function}} [options]
 */
export function createModuleLoader(files, options) {
  const o = options || {};
  const map = normalizePluginFiles(files);
  const builtins = o.builtins || createBuiltins(o);
  const rootDir = o.rootDir == null ? '' : String(o.rootDir);
  const rootPosix = toPosixRoot(rootDir);
  const cache = new Map();
  const jsonCache = new Map();

  function filenameFor(id) {
    return rootPosix ? rootPosix + '/' + id : '/' + id;
  }

  function loadModule(id) {
    const cached = cache.get(id);
    if (cached) return cached.exports;
    const source = map.get(id);
    if (source == null) throw new Error('插件模块不存在：' + id);
    if (/\.json$/i.test(id)) {
      let parsed;
      if (jsonCache.has(id)) parsed = jsonCache.get(id);
      else {
        try { parsed = JSON.parse(source); } catch (e) { throw new Error('插件 JSON 解析失败：' + id + ' — ' + (e && e.message)); }
        jsonCache.set(id, parsed);
      }
      cache.set(id, { id, exports: parsed, loaded: true });
      return parsed;
    }
    const mod = { id, exports: {}, loaded: false, filename: filenameFor(id) };
    cache.set(id, mod);   // 先入缓存：允许循环 require 拿到部分 exports
    let fn;
    try {
      fn = new Function('require', 'module', 'exports', '__filename', '__dirname', source + '\n//# sourceURL=' + filenameFor(id));
    } catch (e) {
      cache.delete(id);
      throw new Error('插件脚本语法错误：' + id + ' — ' + (e && e.message));
    }
    const localRequire = (request) => requireFrom(request, id);
    try {
      fn.call(mod.exports, localRequire, mod, mod.exports, mod.filename, posixDirname(mod.filename));
    } catch (e) {
      cache.delete(id);
      throw e;
    }
    mod.loaded = true;
    return mod.exports;
  }

  function requireFrom(request, parentFile) {
    if (typeof request !== 'string' || !request) throw new Error('插件 require 参数非法');
    if (SANDBOX_DENIED_BUILTINS.has(request)) throw new Error('插件 require 被沙箱拒绝：' + request);
    if (SANDBOX_ALLOWED_BUILTINS.has(request)) return builtinFor(builtins, request);
    const rel = request === '.' || request === '..' || request.startsWith('./') || request.startsWith('../') || request.startsWith('.\\') || request.startsWith('..\\');
    const abs = request.startsWith('/') || /^[A-Za-z]:[\\/]/.test(request) || request.startsWith('\\\\');
    if (!rel && !abs) throw new Error('插件 require 未在白名单中：' + request);
    return loadModule(resolveFileRequest(request, parentFile || '', map, rootDir));
  }

  function resolveEntry(entry) {
    const wanted = normalizePluginPath(entry || 'index.js');
    const id = pickCandidate(map, wanted);
    if (!id) throw new Error('插件入口不存在：' + (entry || 'index.js'));
    return id;
  }

  return {
    files: map,
    requireFrom,
    loadModule,
    resolveEntry,
    loadEntry(entry) { return loadModule(resolveEntry(entry || o.entry || 'index.js')); },
  };
}

/** 绑定到入口目录的 require（Node createRequire 风格）。 */
export function createRequire(files, options) {
  const o = options || {};
  const loader = createModuleLoader(files, o);
  const entry = normalizePluginPath(o.entry || 'index.js');
  return (request) => loader.requireFrom(request, entry);
}

/** 加载入口模块并返回其 module.exports。 */
export function loadEntry(files, options) {
  const o = options || {};
  const loader = createModuleLoader(files, o);
  return loader.loadEntry(o.entry || 'index.js');
}

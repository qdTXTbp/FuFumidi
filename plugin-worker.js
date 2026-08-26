'use strict';
// Worker 线程内的插件宿主：每个 worker-mode 插件跑在独立线程中，
// 通过 postMessage 与主进程桥接 ctx 能力。
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const SANDBOX_ALLOWED_BUILTINS = new Set(['path','util','events','url','querystring','assert','os','crypto','buffer']);
const SANDBOX_DENIED_BUILTINS = new Set(['fs','child_process','net','http','https','dns','tls','worker_threads','cluster','repl','v8']);

function loadPluginModule(entryPath, pluginRoot) {
  const sandboxContext = vm.createContext({
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    setImmediate, clearImmediate,
    queueMicrotask,
    Buffer,
    TextEncoder, TextDecoder,
    URL, URLSearchParams,
    JSON, Math, Date,
    process: { platform: process.platform, arch: process.arch, env: {}, versions: {}, version: 'worker-sandbox', pid: 0 },
  });
  const cache = new Map();
  function load(request, parentFile) {
    if (request.startsWith('.') || path.isAbsolute(request)) {
      const base = path.resolve(parentFile ? path.dirname(parentFile) : path.dirname(entryPath), request);
      let resolved = base;
      if (!path.extname(base)) {
        if (fs.existsSync(base + '.js')) resolved = base + '.js';
        else if (fs.existsSync(base + '.json')) resolved = base + '.json';
        else resolved = base;
      }
      const r = path.resolve(resolved);
      if (r !== pluginRoot && !r.startsWith(pluginRoot + path.sep)) throw new Error('插件 require 越界：' + request);
      if (cache.has(r)) return cache.get(r).exports;
      const mod = { exports: {} };
      cache.set(r, mod);
      const codeSrc = fs.readFileSync(r, 'utf8');
      const fn = vm.runInContext('(function(require,module,exports,__filename,__dirname){' + codeSrc + '\n})', sandboxContext, { filename: r });
      fn((req) => load(req, r), mod, mod.exports, r, path.dirname(r));
      return mod.exports;
    }
    if (SANDBOX_ALLOWED_BUILTINS.has(request)) return require(request);
    if (SANDBOX_DENIED_BUILTINS.has(request)) throw new Error('插件 require 被沙箱拒绝：' + request);
    throw new Error('插件 require 未在白名单中：' + request);
  }
  return load(entryPath, null);
}

let pl = null;
let pendingEngine = null;
let listeners = [];

const post = (msg) => parentPort.postMessage(msg);

function createCtx() {
  const m = pl.manifest;
  return {
    id: pl.id,
    manifest: m,
    commands: {
      register(name, fn) { if (typeof fn === 'function') pl.commands.set(String(name), fn); },
      list() { return Array.from(pl.commands.keys()); },
    },
    events: {
      on(name, cb) { if (typeof cb !== 'function') return () => {}; const l = { name, cb }; listeners.push(l); return () => { listeners = listeners.filter(x => x !== l); }; },
      emit(name, payload) { post({ type: 'ctx:event:emit', name, payload }); },
    },
    engine: {
      run(args, opts = {}) {
        return new Promise((resolve) => {
          pendingEngine = resolve;
          post({ type: 'ctx:engine:run', args, opts });
        });
      },
    },
    settings: {
      get(key) { const base = pl.settings || {}; return key ? base[key] : base; },
      set(key, val) {
        const base = pl.settings || {};
        if (typeof key === 'object' && key !== null) Object.assign(base, key); else base[key] = val;
        pl.settings = base;
        post({ type: 'ctx:settings:set', key, val });
        return { ...base };
      },
    },
    ui: {
      broadcast(name, payload) { post({ type: 'ctx:ui', name: 'broadcast', payload }); },
      notify(text, type) { post({ type: 'ctx:ui', name: '__toast', payload: { text: String(text || ''), type: type || 'info' } }); },
    },
    log: (...args) => { post({ type: 'ctx:log', line: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') }); },
    app: {
      getSongMeta() { return pl.songMeta; },
    },
  };
}

parentPort.on('message', async (msg) => {
  if (!msg) return;
  if (msg.type === 'load') {
    try {
      const m = msg.manifest;
      const pluginRoot = path.resolve(msg.pluginDir);
      const entryPath = path.resolve(msg.pluginDir, m.entry);
      if (!entryPath.startsWith(pluginRoot + path.sep)) throw new Error('entry 越界');
      pl = {
        id: m.id,
        dir: pluginRoot,
        entryPath,
        manifest: m,
        commands: new Map(),
        settings: msg.settings || {},
        songMeta: msg.songMeta || null,
      };
      const mod = loadPluginModule(entryPath, pluginRoot);
      const ctx = createCtx();
      if (mod && typeof mod.activate === 'function') mod.activate(ctx);
      else if (typeof mod === 'function') mod(ctx);
      else throw new Error('entry 需导出 activate(ctx) 或导出函数');
      post({ type: 'ready', commands: Array.from(pl.commands.keys()) });
    } catch (e) {
      post({ type: 'load:error', error: String((e && e.message) || e) });
    }
    return;
  }
  if (msg.type === 'invoke') {
    try {
      const fn = pl && pl.commands.get(String(msg.command));
      if (!fn) post({ type: 'invoke:result', requestId: msg.requestId, ok: false, error: '命令不存在：' + msg.command });
      else {
        const r = await fn(msg.payload);
        post({ type: 'invoke:result', requestId: msg.requestId, ok: true, result: r === undefined ? null : r });
      }
    } catch (e) {
      post({ type: 'invoke:result', requestId: msg.requestId, ok: false, error: String((e && e.message) || e) });
    }
    return;
  }
  if (msg.type === 'event') {
    for (const l of listeners.slice()) {
      if (l.name === msg.name) { try { l.cb(msg.payload); } catch (e) {} }
    }
    return;
  }
  if (msg.type === 'deactivate') {
    try { const mod = loadPluginModule(pl.entryPath, pl.dir); if (mod && typeof mod.deactivate === 'function') mod.deactivate(); } catch (e) {}
    return;
  }
  if (msg.type === 'engine:result') {
    if (pendingEngine) { pendingEngine(msg.result); pendingEngine = null; }
    return;
  }
  if (msg.type === 'settings:update') {
    pl.settings = msg.settings || {};
    return;
  }
});

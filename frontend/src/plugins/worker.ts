// ============================================================
// worker.ts —— 单个插件的执行环境（Web Worker）
//
// 每个启用的插件一个独立 Worker：CommonJS 入口在 worker 里用 cjs-loader.js 执行，
// ctx 能力（commands/events/engine/settings/ui/log/app）通过 postMessage 桥回主线程。
// 这样插件里死循环、异常、大内存都只影响自己的 Worker，不会卡住界面。
//
// ★ 为什么用 Web Worker 而不是宿主 vm：Tauri 没有 Node/QuickJS，WebView2 自带 JS 引擎；
//   插件的 CommonJS 代码由 cjs-loader 的 new Function 包装执行（插件=用户主动安装的可信代码）。
// ============================================================
import {
  createBuiltins,
  createBufferClass,
  loadEntry,
} from './cjs-loader.js';

type AnyFn = (...args: any[]) => any;

interface PluginRuntime {
  id: string;
  manifest: any;
  files: any;
  dir: string;
  commands: Map<string, AnyFn>;
  listeners: Array<{ name: string; cb: AnyFn }>;
  settings: any;
  songMeta: any;
  engineSeq: number;
  mod: any;
}

const g = globalThis as any;
const nativeConsole: any = g.console;
const PLATFORM = detectPlatform();
const ARCH = detectArch();
const BufferCtor = createBufferClass();
const PAYLOAD_LIMIT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30 * 1000;
const TIMEOUT_SENTINEL = { __fufumidiTimeout: true };

let runtime: PluginRuntime | null = null;
let pluginLoaded = false;
const pendingEngine = new Map<number, { resolve: (result: any) => void; timer: any }>();

function detectPlatform(): string {
  const ua = String((g.navigator && g.navigator.userAgent) || '');
  if (/Windows/i.test(ua)) return 'win32';
  if (/Mac OS|Macintosh/i.test(ua)) return 'darwin';
  return 'linux';
}

function detectArch(): string {
  const ua = String((g.navigator && g.navigator.userAgent) || '');
  if (/arm64|aarch64/i.test(ua)) return 'arm64';
  return 'x64';
}

function post(msg: any): void {
  try {
    g.postMessage(msg);
  } catch (e) {
    // postMessage 失败（例如返回值不可结构化克隆）时退化为纯文本错误
    try { g.postMessage({ type: 'ctx:log', line: '消息发送失败：' + safeErr(e) }); } catch (_) { /* 无法通信就放弃 */ }
  }
}

function safeStr(v: any): string {
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch (e) {
    return String(v);
  }
}

function safeErr(e: any): string {
  return String((e && e.message) || e || '未知错误');
}

function emitLog(line: string): void {
  post({ type: 'ctx:log', line });
}

/** 注入 Electron 沙箱里插件能看到的全局对象（Web Worker 原生缺的那几个）。 */
function installGlobals(): void {
  if (!g.process) {
    g.process = {
      platform: PLATFORM,
      arch: ARCH,
      env: {},
      versions: { node: '0.0.0', v8: '0.0.0' },
      version: 'webworker-sandbox',
      pid: 0,
      cwd: () => '',
      nextTick: (fn: AnyFn, ...args: any[]) => queueMicrotask(() => fn(...args)),
    };
  }
  if (!g.Buffer) g.Buffer = BufferCtor;
  if (!g.setImmediate) g.setImmediate = (fn: AnyFn, ...args: any[]) => setTimeout(fn, 0, ...args);
  if (!g.clearImmediate) g.clearImmediate = (id: any) => clearTimeout(id);
  if (typeof g.structuredClone !== 'function') {
    g.structuredClone = (value: any) => JSON.parse(JSON.stringify(value === undefined ? null : value));
  }
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const wrapped: any = {};
  for (const method of methods) {
    wrapped[method] = (...args: any[]) => {
      try { if (nativeConsole && typeof nativeConsole[method] === 'function') nativeConsole[method](...args); } catch (e) { /* 控制台不可用不影响插件 */ }
      if (!pluginLoaded) return;
      const line = args.map((a: any) => (typeof a === 'string' ? a : safeStr(a))).join(' ');
      emitLog('[console.' + method + '] ' + line);
    };
  }
  g.console = wrapped;
}

function byteSize(value: any): number {
  if (value == null) return 0;
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch (e) { return Number.MAX_SAFE_INTEGER; }
  if (json == null) return 0;
  try { return new TextEncoder().encode(json).length; } catch (e) { return json.length; }
}

function createCtx(): any {
  const rt = runtime as PluginRuntime;
  return {
    id: rt.id,
    manifest: rt.manifest,
    commands: {
      register(name: any, fn: any): void {
        if (typeof fn === 'function') rt.commands.set(String(name), fn);
      },
      unregister(name: any): boolean {
        return rt.commands.delete(String(name));
      },
      list(): string[] {
        return Array.from(rt.commands.keys());
      },
      has(name: any): boolean {
        return rt.commands.has(String(name));
      },
    },
    events: {
      on(name: any, cb: any): () => void {
        if (typeof cb !== 'function') return () => {};
        const listener = { name: String(name), cb };
        rt.listeners.push(listener);
        return () => {
          rt.listeners = rt.listeners.filter((x) => x !== listener);
        };
      },
      emit(name: any, payload: any): void {
        post({ type: 'ctx:event:emit', name: String(name), payload });
      },
    },
    engine: {
      run(args: any, opts: any = {}): Promise<any> {
        return new Promise((resolve) => {
          const requestId = ++rt.engineSeq;
          const timeoutMs = Number(opts && opts.timeoutMs) || 30 * 60 * 1000;
          // 兜底：主线程若因为桥接异常没回包，最多 35 分钟必须返回，避免插件命令永远挂起
          const timer = setTimeout(() => {
            const pending = pendingEngine.get(requestId);
            if (pending) {
              pendingEngine.delete(requestId);
              pending.resolve({ code: -1, result: null, out: '', err: '引擎调用超时' });
            }
          }, timeoutMs + 5 * 60 * 1000);
          pendingEngine.set(requestId, { resolve, timer });
          post({
            type: 'ctx:engine:run',
            requestId,
            args: Array.isArray(args) ? args : [],
            opts: { script: opts && opts.script, timeoutMs: opts && opts.timeoutMs },
          });
        });
      },
    },
    settings: {
      get(key?: any): any {
        const base = rt.settings || {};
        return key == null ? base : base[String(key)];
      },
      set(key: any, val?: any): any {
        const base = Object.assign({}, rt.settings || {});
        if (key && typeof key === 'object') Object.assign(base, key);
        else if (key != null) base[String(key)] = val;
        rt.settings = base;
        post({ type: 'ctx:settings:set', key, val });
        return Object.assign({}, base);
      },
    },
    ui: {
      broadcast(name: any, payload: any): void {
        post({ type: 'ctx:ui', name: String(name), payload });
      },
      notify(text: any, type?: any): void {
        post({ type: 'ctx:ui', name: '__toast', payload: { text: String(text == null ? '' : text), type: type || 'info' } });
      },
    },
    log: (...args: any[]): void => {
      emitLog(args.map((a: any) => (typeof a === 'string' ? a : safeStr(a))).join(' '));
    },
    app: {
      getSongMeta(): any {
        return rt.songMeta || null;
      },
    },
  };
}

function postInvokeResult(requestId: any, ok: boolean, result?: any, error?: any): void {
  try {
    post({
      type: 'invoke:result',
      requestId,
      ok,
      result: ok && result === undefined ? null : result,
      error: error === undefined ? undefined : String(error),
    });
  } catch (e) {
    try {
      post({ type: 'invoke:result', requestId, ok: false, error: '命令返回值无法序列化：' + safeErr(e) });
    } catch (_) { /* 无法通信就放弃 */ }
  }
}

async function handleLoad(msg: any): Promise<void> {
  try {
    const manifest = (msg && msg.manifest) || {};
    const id = String((msg && msg.id) || manifest.id || '');
    const files = (msg && msg.files) || [];
    const dir = String((msg && msg.dir) || '');
    const builtins = createBuiltins({
      platform: PLATFORM,
      arch: ARCH,
      Buffer: BufferCtor,
    });
    const mod = loadEntry(files, {
      entry: String(manifest.entry || 'index.js'),
      rootDir: dir,
      builtins,
    });
    runtime = {
      id,
      manifest,
      files,
      dir,
      commands: new Map(),
      listeners: [],
      settings: (msg && msg.settings) || {},
      songMeta: (msg && msg.songMeta) || null,
      engineSeq: 0,
      mod,
    };
    pluginLoaded = true;
    if (!id) throw new Error('插件 manifest 缺少合法 id');
    const ctx = createCtx();
    if (mod && typeof mod.activate === 'function') {
      await Promise.resolve(mod.activate(ctx));
    } else if (typeof mod === 'function') {
      await Promise.resolve(mod(ctx));
    } else {
      throw new Error('entry 需导出 activate(ctx) 或导出函数');
    }
    post({ type: 'ready', commands: Array.from(runtime.commands.keys()) });
  } catch (e) {
    pluginLoaded = false;
    runtime = null;
    post({ type: 'load:error', error: safeErr(e) });
  }
}

async function handleInvoke(msg: any): Promise<void> {
  const requestId = msg && msg.requestId;
  try {
    if (!runtime) throw new Error('插件尚未加载完成');
    const fn = runtime.commands.get(String(msg && msg.command));
    if (typeof fn !== 'function') {
      postInvokeResult(requestId, false, undefined, '命令不存在：' + String((msg && msg.command) || ''));
      return;
    }
    const size = byteSize(msg && msg.payload);
    if (size > PAYLOAD_LIMIT) {
      postInvokeResult(requestId, false, undefined, '命令参数过大：' + size);
      return;
    }
    let timer: any = null;
    const timeout = new Promise<any>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), COMMAND_TIMEOUT_MS);
    });
    let value: any;
    try {
      value = await Promise.race([
        Promise.resolve().then(() => fn((msg && msg.payload))),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (value === TIMEOUT_SENTINEL) {
      postInvokeResult(requestId, false, undefined, '命令执行超时（30s）');
      return;
    }
    postInvokeResult(requestId, true, value);
  } catch (e) {
    emitLog('命令 ' + String((msg && msg.command) || '') + ' 出错：' + safeErr(e));
    postInvokeResult(requestId, false, undefined, safeErr(e));
  }
}

async function handleMessage(msg: any): Promise<void> {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'load':
      await handleLoad(msg);
      return;
    case 'invoke':
      await handleInvoke(msg);
      return;
    case 'event': {
      if (!runtime) return;
      const name = String(msg.name);
      for (const listener of runtime.listeners.slice()) {
        if (listener.name !== name) continue;
        try { listener.cb(msg.payload); } catch (e) { emitLog('事件 ' + name + ' 处理出错：' + safeErr(e)); }
      }
      return;
    }
    case 'settings:update': {
      if (runtime) runtime.settings = msg.settings || {};
      return;
    }
    case 'engine:result': {
      const pending = pendingEngine.get(Number(msg.requestId));
      if (pending) {
        pendingEngine.delete(Number(msg.requestId));
        clearTimeout(pending.timer);
        pending.resolve(msg.result);
      }
      return;
    }
    case 'song-meta': {
      if (runtime) runtime.songMeta = msg.songMeta || null;
      return;
    }
    case 'deactivate': {
      pluginLoaded = false;
      for (const pending of pendingEngine.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ code: -1, result: null, out: '', err: '插件已停用' });
      }
      pendingEngine.clear();
      try {
        if (runtime && runtime.mod && typeof runtime.mod.deactivate === 'function') runtime.mod.deactivate();
      } catch (e) {
        emitLog('插件卸载出错：' + safeErr(e));
      }
      runtime = null;
      post({ type: 'deactivated' });
      return;
    }
    default:
      return;
  }
}

installGlobals();

g.addEventListener('message', (ev: any) => {
  void handleMessage(ev && ev.data);
});

g.addEventListener('error', (ev: any) => {
  const err = (ev && ev.error) || (ev && ev.message) || 'Worker 未捕获错误';
  emitLog('未捕获异常：' + safeErr(err));
});

g.addEventListener('unhandledrejection', (ev: any) => {
  emitLog('未处理的 Promise 拒绝：' + safeErr(ev && ev.reason));
});

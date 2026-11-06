// ============================================================
// host.ts —— 插件宿主的浏览器侧装配（Tauri / WebView2）
//
// host-core.js 只做协议与调度；这里补三件只有浏览器能做的事：
//   1) 用真实 Web Worker 执行每个启用的插件（worker.ts）；
//   2) 把插件 renderer 脚本注入页面并捕获异常（Electron 的信任模型，失败只记日志）；
//   3) 派发 window CustomEvent，并暴露：
//        window.__fufumidi_plugin_invoke(id, cmd, payload)
//        window.__fufumidi_plugin_host = { reload, ensure, dispose }
//
// App.vue 启动时调用 ensurePluginHost({ getSongMeta })；PluginCenter 在
// rescan / 开关插件 / 安装完成后调用 window.__fufumidi_plugin_host.reload()。
// ============================================================
import { createPluginHost, PLUGIN_LOG_EVENT, PLUGIN_UI_EVENT } from './host-core.js';

type WorkerAdapter = {
  postMessage(msg: any): void;
  onMessage(cb: (msg: any) => void): void;
  onError(cb: (err: any) => void): void;
  terminate(): void;
};

export interface EnsurePluginHostOptions {
  /** 默认读 window.fuBridge；测试/特殊环境可显式传入。 */
  bridge?: any;
  /** ctx.app.getSongMeta() 的数据来源；默认读 window.__fufumidi_plugin_song_meta。 */
  getSongMeta?: () => any;
}

const hasWindow = typeof window !== 'undefined';

function pluginLog(id: string, line: string): void {
  dispatchWindowEvent(PLUGIN_LOG_EVENT, { id, line });
}

function dispatchWindowEvent(name: string, detail: any): void {
  if (!hasWindow) return;
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch (e) {
    /* 监听方异常或环境不支持 CustomEvent：不能拖垮宿主 */
  }
}

/** 真实 Web Worker 适配器（供 host-core 使用）。 */
function createWorkerAdapter(pluginId: string): WorkerAdapter {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'fufumidi-plugin-' + pluginId,
  });
  let messageHandler: (msg: any) => void = () => {};
  let errorHandler: (err: any) => void = () => {};
  worker.addEventListener('message', (ev: MessageEvent) => {
    try { messageHandler(ev.data); } catch (e) { pluginLog(pluginId, '宿主处理插件消息失败：' + String((e as any)?.message || e)); }
  });
  worker.addEventListener('error', (ev: ErrorEvent) => {
    errorHandler((ev && (ev.error || ev.message)) || 'Worker 运行时错误');
  });
  worker.addEventListener('messageerror', () => {
    errorHandler(new Error('插件 Worker 消息无法反序列化'));
  });
  return {
    postMessage(msg: any) { worker.postMessage(msg); },
    onMessage(cb: (msg: any) => void) { messageHandler = cb; },
    onError(cb: (err: any) => void) { errorHandler = cb; },
    terminate() { try { worker.terminate(); } catch (e) { /* 已终止 */ } },
  };
}

/**
 * 把插件 renderer 脚本注入页面执行。
 * 与 Electron 一致：插入 <script> 文本、立即执行；异常只记日志，不影响宿主。
 */
function injectRendererScript(info: { id: string; path: string; code: string }): void {
  if (!hasWindow || typeof document === 'undefined') return;
  if (typeof info.code !== 'string' || !info.code.trim()) {
    pluginLog(info.id, '渲染脚本为空：' + info.path);
    return;
  }
  const script = document.createElement('script');
  script.dataset.fufumidiPlugin = info.id;
  script.dataset.fufumidiPluginScript = info.path;
  script.textContent = info.code;
  // 内联脚本的运行时异常会走 window.error（而不是 appendChild 抛出），临时挂一个监听器接住
  const onError = (ev: ErrorEvent) => {
    const message = String((ev && (ev.message || (ev.error && (ev.error as any).message))) || '未知错误');
    pluginLog(info.id, '渲染脚本异常：' + message);
  };
  window.addEventListener('error', onError);
  try {
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    pluginLog(info.id, '渲染脚本注入失败：' + String((e as any)?.message || e));
  } finally {
    window.removeEventListener('error', onError);
    try { script.remove(); } catch (e) { /* 已移除 */ }
  }
}

/** renderer 脚本可以调用全局 toast()（与 Electron 文档一致）——转成应用统一提示事件。 */
function installGlobalToast(): void {
  const w = window as any;
  if (typeof w.toast === 'function') return;
  w.toast = (text: any, type?: string) => {
    dispatchWindowEvent(PLUGIN_UI_EVENT, {
      id: '*',
      name: '__toast',
      payload: { text: String(text == null ? '' : text), type: type || 'info' },
    });
  };
}

function installWindowApi(host: any): void {
  const w = window as any;
  w.__fufumidi_plugin_invoke = (id: string, cmd: string, payload?: any) => host.invoke(id, cmd, payload);
  w.__fufumidi_plugin_host = {
    reload: () => host.reload(),
    ensure: () => host.ensure(),
    dispose: () => host.dispose(),
    setSongMeta: (meta: any) => host.setSongMeta(meta),
  };
}

let hostInstance: any = null;
let hostBridge: any = null;
let ensurePromise: Promise<any> | null = null;

/**
 * 启动/获取插件宿主（全局单例）。App.vue 启动时调一次即可。
 * 不抛异常：插件平台整体不可用时只记日志，应用其它功能不受影响。
 */
export function ensurePluginHost(options: EnsurePluginHostOptions = {}): Promise<any> {
  if (!hasWindow) return Promise.resolve(null);
  const bridge = options.bridge || (window as any).fuBridge || null;
  if (hostInstance) {
    // 上一次 ensure 时桥还没注入（Tauri 初始化时序），这次桥可用：重建宿主
    if (!hostBridge && bridge) {
      try { hostInstance.dispose(); } catch (e) { /* ignore */ }
      hostInstance = null;
    } else {
      return Promise.resolve(hostInstance);
    }
  }
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const host = createPluginHost({
      bridge,
      workerFactory: ({ id }: { id: string }) => createWorkerAdapter(id),
      dispatch: dispatchWindowEvent,
      log: (detail: { id: string; line: string }) => {
        try { console.info('[plugins]', detail.id, detail.line); } catch (e) { /* 控制台不可用 */ }
      },
      injectRenderer: injectRendererScript,
      getSongMeta: options.getSongMeta || (() => (window as any).__fufumidi_plugin_song_meta || null),
    });
    installGlobalToast();
    installWindowApi(host);
    hostInstance = host;
    hostBridge = bridge;
    try {
      await host.ensure();
    } catch (e) {
      try { console.warn('[plugins] 插件宿主启动失败：', e); } catch (_) { /* ignore */ }
    }
    return host;
  })().finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
}

/** 释放全部插件 Worker（应用卸载 / 测试用）；之后可再次 ensure。 */
export function disposePluginHost(): void {
  if (hostInstance) {
    try { hostInstance.dispose(); } catch (e) { /* ignore */ }
  }
  hostInstance = null;
  hostBridge = null;
}

declare global {
  interface Window {
    __fufumidi_plugin_host?: {
      reload(): Promise<any>;
      ensure(): Promise<any>;
      dispose(): void;
      setSongMeta?(meta: any): void;
    };
    __fufumidi_plugin_invoke?: (id: string, cmd: string, payload?: any) => Promise<any>;
    __fufumidi_plugin_song_meta?: any;
    toast?: (text: any, type?: string) => void;
  }
}

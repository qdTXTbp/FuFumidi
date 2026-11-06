// ============================================================
// host-core.js —— 插件宿主（与 DOM / Worker 实现解耦，可在 node --test 里跑）
//
// 职责：
//   · 读 window.fuBridge.plugins.list()，为每个 enabled 插件 plugins.bundle(id) 并启动 Worker；
//   · invoke(id, cmd, payload)：30s 超时 + 1MB payload 上限，转发到对应 Worker 并解析结果；
//   · 处理 Worker 上行的 ctx 消息：engine.run → bridge.plugins.engineRun；
//     settings.set → bridge.getSettings/saveSettings 读改写（保留其它设置）；
//     log/ui → window CustomEvent（fufumidi:plugin-log / fuplugin:<id>:<name> / fufumidi:plugin-ui）。
//
// 浏览器侧的真实 Worker 工厂、脚本注入、事件派发都在 host.ts 里注入；
// 这样单元测试可以完全 mock bridge 与 Worker，不需要 DOM / WebView2。
// ============================================================

export const PLUGIN_LOG_EVENT = 'fufumidi:plugin-log';
export const PLUGIN_UI_EVENT = 'fufumidi:plugin-ui';

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_PAYLOAD_LIMIT_BYTES = 1024 * 1024;

function errMsg(e) {
  return String((e && e.message) || e || '未知错误');
}

/** payload 的字节大小（按 JSON 编码后的 UTF-8 长度；不可序列化视为超限）。 */
export function payloadSize(value) {
  if (value == null) return 0;
  let json;
  try { json = JSON.stringify(value); } catch (e) { return Number.MAX_SAFE_INTEGER; }
  if (json == null) return 0;
  if (typeof TextEncoder !== 'undefined') {
    try { return new TextEncoder().encode(json).length; } catch (e) { /* 回退到字符长度 */ }
  }
  return json.length;
}

/** 把引擎调用结果统一成 Electron 的 { code, result, out, err } 形状。 */
export function normalizeEngineResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return { code: -1, result: null, out: '', err: '引擎没有返回结果' };
  }
  const err = raw.err != null ? String(raw.err)
    : raw.error != null ? String(raw.error)
      : '';
  let code = -1;
  if (raw.code != null && raw.code !== '' && Number.isFinite(Number(raw.code))) code = Number(raw.code);
  else if (raw.ok === true) code = 0;
  return {
    code,
    result: raw.result === undefined ? null : raw.result,
    out: raw.out == null ? '' : String(raw.out),
    err,
  };
}

/**
 * @param {object} options
 * @param {any} options.bridge                  window.fuBridge（只需要 plugins / getSettings / saveSettings）
 * @param {(info:{id:string,manifest:any,files:any[],dir:string,settings:any})=>object} options.workerFactory  创建 Worker 适配器（见下方接口）
 * @param {(name:string, detail:any)=>void} [options.dispatch] 派发 window CustomEvent
 * @param {(detail:{id:string,line:string})=>void} [options.log] 额外日志出口（控制台）
 * @param {(info:{id:string,path:string,code:string})=>void} [options.injectRenderer]
 * @param {()=>any} [options.getSongMeta]
 * @param {number} [options.commandTimeoutMs]
 * @param {number} [options.payloadLimitBytes]
 * @param {Function} [options.setTimeoutFn]
 * @param {Function} [options.clearTimeoutFn]
 *
 * Worker 适配器接口（host.ts 用真实 Worker 实现，测试用 FakeWorker 实现）：
 *   { postMessage(msg), onMessage(cb), onError(cb), terminate() }
 */
export function createPluginHost(options) {
  const o = options || {};
  const bridge = o.bridge || null;
  const workerFactory = typeof o.workerFactory === 'function' ? o.workerFactory : null;
  const dispatch = typeof o.dispatch === 'function' ? o.dispatch : () => {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const injectRenderer = typeof o.injectRenderer === 'function' ? o.injectRenderer : null;
  const getSongMeta = typeof o.getSongMeta === 'function' ? o.getSongMeta : () => null;
  const commandTimeoutMs = Number(o.commandTimeoutMs) > 0 ? Number(o.commandTimeoutMs) : DEFAULT_COMMAND_TIMEOUT_MS;
  const payloadLimitBytes = Number(o.payloadLimitBytes) > 0 ? Number(o.payloadLimitBytes) : DEFAULT_PAYLOAD_LIMIT_BYTES;
  const later = typeof o.setTimeoutFn === 'function' ? o.setTimeoutFn : (fn, ms) => setTimeout(fn, ms);
  const cancelLater = typeof o.clearTimeoutFn === 'function' ? o.clearTimeoutFn : (timer) => clearTimeout(timer);

  const runtimes = new Map();          // id -> runtime
  const starting = new Map();          // id -> Promise<runtime|null>
  const injectedRenderers = new Set();
  let currentList = [];
  let ensured = false;
  let ensuring = null;
  let settingsChain = Promise.resolve();
  let requestSeq = 0;

  function safeDispatch(name, detail) {
    try { dispatch(name, detail); } catch (e) { /* 事件监听方异常不能影响宿主 */ }
  }

  function emitLog(id, line) {
    const detail = { id: String(id || '*'), line: String(line == null ? '' : line) };
    safeDispatch(PLUGIN_LOG_EVENT, detail);
    try { log(detail); } catch (e) { /* 日志出口异常忽略 */ }
  }

  function safeSongMeta() {
    try {
      const meta = getSongMeta();
      return meta && typeof meta === 'object' ? meta : null;
    } catch (e) { return null; }
  }

  function normalizeInfo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    if (!id) return null;
    if (!PLUGIN_ID_RE.test(id)) {
      emitLog('*', '插件 id 非法，已跳过：' + id);
      return null;
    }
    return {
      id,
      name: String(raw.name || id),
      version: String(raw.version || ''),
      author: String(raw.author || ''),
      description: String(raw.description || ''),
      enabled: raw.enabled === true || raw.enabled === 1 || raw.enabled === 'true',
      commands: Array.isArray(raw.commands) ? raw.commands.map(String) : [],
      manifest: raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : null,
    };
  }

  // ---------------- 设置：读改写，保留其它插件 / 其它顶层键 ----------------

  async function readSettings() {
    if (!bridge || typeof bridge.getSettings !== 'function') return {};
    try {
      const s = await bridge.getSettings();
      return s && typeof s === 'object' ? s : {};
    } catch (e) {
      emitLog('*', '读取设置失败：' + errMsg(e));
      return {};
    }
  }

  function pluginNamespace(settings, id) {
    const all = settings && settings.plugins && typeof settings.plugins === 'object' ? settings.plugins : {};
    const mine = all[id];
    return mine && typeof mine === 'object' ? Object.assign({}, mine) : {};
  }

  async function readPluginSettings(id) {
    return pluginNamespace(await readSettings(), id);
  }

  /**
   * 保存插件设置：读当前完整设置 → 只改 plugins[id] → 整体写回。
   * 串行化避免并发 set 互相覆盖；saveSettings 本身是顶层合并，所以必须带上完整 settings。
   */
  function writePluginSettings(id, patch) {
    const run = async () => {
      const current = await readSettings();
      const plugins = Object.assign({}, (current.plugins && typeof current.plugins === 'object') ? current.plugins : {});
      const merged = Object.assign({}, pluginNamespace(current, id), patch || {});
      plugins[id] = merged;
      const next = Object.assign({}, current, { plugins });
      if (bridge && typeof bridge.saveSettings === 'function') {
        const r = await bridge.saveSettings(next);
        if (r && r.ok === false) throw new Error(r.error || '保存设置失败');
      }
      return merged;
    };
    const task = settingsChain.then(run, run);
    settingsChain = task.catch(() => {});
    return task;
  }

  // ---------------- Worker 生命周期 ----------------

  function safePost(runtime, msg) {
    try {
      runtime.adapter.postMessage(msg);
      return true;
    } catch (e) {
      emitLog(runtime.id, '向插件 Worker 发送消息失败：' + errMsg(e));
      return false;
    }
  }

  function failPending(runtime, reason) {
    for (const pending of runtime.pending.values()) {
      try { cancelLater(pending.timer); } catch (e) { /* ignore */ }
      try { pending.resolve({ ok: false, error: reason }); } catch (e) { /* ignore */ }
    }
    runtime.pending.clear();
  }

  function injectRendererOnce(id, manifest, files) {
    const renderer = manifest && typeof manifest.renderer === 'string' ? manifest.renderer.trim() : '';
    if (!renderer) return;
    if (injectedRenderers.has(id)) return;   // 按插件 id 去重：跨 rescan / reload 不再注入
    injectedRenderers.add(id);
    if (!injectRenderer) return;
    const wanted = renderer.replace(/\\/g, '/').replace(/^\.?\//, '');
    const file = (files || []).find((f) => f && typeof f.path === 'string'
      && String(f.path).replace(/\\/g, '/').replace(/^\.?\//, '') === wanted);
    if (!file) {
      emitLog(id, '渲染脚本不存在：' + renderer);
      return;
    }
    try {
      injectRenderer({ id, path: wanted, code: String(file.content == null ? '' : file.content) });
    } catch (e) {
      emitLog(id, '渲染脚本注入失败：' + errMsg(e));
    }
  }

  async function doStart(info) {
    if (!workerFactory) {
      emitLog(info.id, '插件宿主未配置 Worker 工厂');
      return null;
    }
    let bundle;
    try {
      if (!bridge || !bridge.plugins || typeof bridge.plugins.bundle !== 'function') {
        throw new Error('当前环境不支持插件打包（bridge.plugins.bundle 缺失）');
      }
      bundle = await bridge.plugins.bundle(info.id);
    } catch (e) {
      emitLog(info.id, '插件打包失败：' + errMsg(e));
      return null;
    }
    if (!bundle || bundle.ok === false) {
      emitLog(info.id, '插件打包失败：' + ((bundle && bundle.error) || '未知错误'));
      return null;
    }
    const manifest = bundle.manifest && typeof bundle.manifest === 'object' ? bundle.manifest : (info.manifest || {});
    const files = Array.isArray(bundle.files) ? bundle.files : [];
    const dir = typeof bundle.dir === 'string' ? bundle.dir : '';
    // 注入放在 worker load 之前：activate 里立刻 ui.broadcast 的消息，渲染层监听已经就绪
    injectRendererOnce(info.id, manifest, files);
    const settings = await readPluginSettings(info.id);
    let adapter;
    try {
      adapter = workerFactory({ id: info.id, manifest, files, dir, settings });
    } catch (e) {
      emitLog(info.id, 'Worker 创建失败：' + errMsg(e));
      return null;
    }
    if (!adapter || typeof adapter.postMessage !== 'function' || typeof adapter.onMessage !== 'function') {
      emitLog(info.id, 'Worker 工厂返回的适配器不合法');
      return null;
    }
    const runtime = {
      id: info.id,
      info,
      manifest,
      files,
      dir,
      adapter,
      status: 'loading',
      error: '',
      commands: [],
      pending: new Map(),
      settings,
    };
    runtimes.set(info.id, runtime);
    adapter.onMessage((msg) => handleWorkerMessage(runtime, msg));
    if (typeof adapter.onError === 'function') {
      adapter.onError((err) => {
        emitLog(info.id, '插件 Worker 出错：' + errMsg(err));
        runtime.status = 'error';
        runtime.error = 'Worker 出错：' + errMsg(err);
        failPending(runtime, runtime.error);
      });
    }
    safePost(runtime, {
      type: 'load',
      id: info.id,
      manifest,
      files,
      dir,
      settings,
      songMeta: safeSongMeta(),
    });
    return runtime;
  }

  function startPlugin(info) {
    const existing = runtimes.get(info.id);
    if (existing) return Promise.resolve(existing);
    const pending = starting.get(info.id);
    if (pending) return pending;
    const task = doStart(info).finally(() => { starting.delete(info.id); });
    starting.set(info.id, task);
    return task;
  }

  function disposeWorkers() {
    for (const runtime of runtimes.values()) {
      runtime.status = 'deactivated';
      safePost(runtime, { type: 'deactivate' });
      try { runtime.adapter.terminate(); } catch (e) { /* Worker 已销毁 */ }
      failPending(runtime, '插件宿主已重载');
    }
    runtimes.clear();
    starting.clear();
  }

  // ---------------- Worker 上行消息 ----------------

  function handleWorkerMessage(runtime, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'ready': {
        runtime.status = 'ready';
        runtime.commands = Array.isArray(msg.commands) ? msg.commands.map(String) : [];
        emitLog(runtime.id, '已加载插件（Worker）：' + (runtime.info.name || runtime.id) + '（' + runtime.id + '）');
        return;
      }
      case 'load:error': {
        runtime.status = 'error';
        runtime.error = String(msg.error || '插件加载失败');
        emitLog(runtime.id, '插件加载失败：' + runtime.error);
        failPending(runtime, '插件加载失败：' + runtime.error);
        return;
      }
      case 'invoke:result': {
        const pending = runtime.pending.get(msg.requestId);
        if (!pending) return;
        runtime.pending.delete(msg.requestId);
        try { cancelLater(pending.timer); } catch (e) { /* ignore */ }
        const ok = !!msg.ok;
        pending.resolve({
          ok,
          result: msg.result === undefined ? null : msg.result,
          error: ok ? undefined : String(msg.error || '命令失败'),
        });
        return;
      }
      case 'ctx:engine:run': {
        void handleEngineRun(runtime, msg);
        return;
      }
      case 'ctx:settings:set': {
        void handleSettingsSet(runtime, msg);
        return;
      }
      case 'ctx:log': {
        emitLog(runtime.id, msg.line);
        return;
      }
      case 'ctx:ui': {
        emitUi(runtime.id, msg.name, msg.payload);
        return;
      }
      case 'ctx:event:emit': {
        emit(msg.name, msg.payload);
        return;
      }
      case 'deactivated': {
        runtime.status = 'deactivated';
        return;
      }
      default:
        return;
    }
  }

  async function handleEngineRun(runtime, msg) {
    let result;
    try {
      if (!bridge || !bridge.plugins || typeof bridge.plugins.engineRun !== 'function') {
        throw new Error('当前环境不支持引擎调用（bridge.plugins.engineRun 缺失）');
      }
      const args = Array.isArray(msg.args) ? msg.args : [];
      const opts = msg.opts && typeof msg.opts === 'object' ? msg.opts : {};
      const raw = await bridge.plugins.engineRun(args, { script: opts.script, timeoutMs: opts.timeoutMs, pluginDir: runtime.dir, pluginId: runtime.id });
      result = normalizeEngineResult(raw);
    } catch (e) {
      emitLog(runtime.id, '引擎调用失败：' + errMsg(e));
      result = { code: -1, result: null, out: '', err: errMsg(e) };
    }
    safePost(runtime, { type: 'engine:result', requestId: msg.requestId, result });
  }

  async function handleSettingsSet(runtime, msg) {
    const patch = {};
    if (msg.key && typeof msg.key === 'object') Object.assign(patch, msg.key);
    else if (msg.key != null) patch[String(msg.key)] = msg.val;
    try {
      const merged = await writePluginSettings(runtime.id, patch);
      safePost(runtime, { type: 'settings:update', settings: merged });
    } catch (e) {
      emitLog(runtime.id, '保存插件设置失败：' + errMsg(e));
    }
  }

  function emitUi(id, name, payload) {
    const messageName = String(name == null ? '' : name);
    // 1) Electron 渲染层协议：window.addEventListener('fuplugin:<id>:<name>', ev => ev.detail)
    safeDispatch('fuplugin:' + id + ':' + messageName, payload);
    // 2) 应用侧统一事件（PluginCenter / App 订阅；__toast 走这里弹全局提示）
    safeDispatch(PLUGIN_UI_EVENT, { id, name: messageName, payload });
  }

  /** 应用级事件广播到所有插件 Worker（ctx.events.emit / 未来的 song-loaded 等）。 */
  function emit(name, payload) {
    const eventName = String(name == null ? '' : name);
    for (const runtime of runtimes.values()) {
      if (runtime.status === 'error' || runtime.status === 'deactivated') continue;
      safePost(runtime, { type: 'event', name: eventName, payload });
    }
  }

  // ---------------- 对外 API ----------------

  /** 曲目切换时把最新 song meta 推给所有运行中的插件（ctx.app.getSongMeta 保持最新）。 */
  function setSongMeta(meta) {
    const value = meta && typeof meta === 'object' ? meta : null;
    for (const runtime of runtimes.values()) {
      if (runtime.status === 'error' || runtime.status === 'deactivated') continue;
      safePost(runtime, { type: 'song-meta', songMeta: value });
    }
  }

  function summary() {
    const plugins = [];
    for (const runtime of runtimes.values()) {
      plugins.push({
        id: runtime.id,
        name: runtime.info.name || runtime.id,
        status: runtime.status,
        commands: runtime.commands.slice(),
        error: runtime.error,
      });
    }
    return { ok: true, plugins };
  }

  async function ensure() {
    if (ensuring) return ensuring;
    if (ensured) return summary();
    ensuring = (async () => {
      let list = [];
      try {
        if (!bridge || !bridge.plugins || typeof bridge.plugins.list !== 'function') {
          throw new Error('当前环境不支持插件（bridge.plugins.list 缺失）');
        }
        const raw = await bridge.plugins.list();
        list = Array.isArray(raw) ? raw.map(normalizeInfo).filter(Boolean) : [];
      } catch (e) {
        emitLog('*', '读取插件列表失败：' + errMsg(e));
        list = [];
      }
      currentList = list;
      for (const info of list) {
        if (!info.enabled) continue;
        try {
          await startPlugin(info);
        } catch (e) {
          emitLog(info.id, '插件启动失败：' + errMsg(e));
        }
      }
      ensured = true;
      return summary();
    })();
    try {
      return await ensuring;
    } finally {
      ensuring = null;
    }
  }

  async function reload() {
    disposeWorkers();
    ensured = false;
    currentList = [];
    return ensure();
  }

  function dispose() {
    disposeWorkers();
    ensured = false;
    currentList = [];
  }

  async function invoke(id, command, payload) {
    const pluginId = String(id == null ? '' : id);
    if (!ensured) {
      try { await ensure(); } catch (e) { /* ensure 自己会记日志 */ }
    }
    const info = currentList.find((p) => p.id === pluginId) || null;
    const runtime = runtimes.get(pluginId) || null;
    if (!runtime) {
      if (!info) return { ok: false, error: '插件不存在：' + pluginId };
      return { ok: false, error: '插件未启用：' + pluginId };
    }
    if (runtime.status === 'error') {
      return { ok: false, error: '插件加载失败：' + (runtime.error || pluginId) };
    }
    if (runtime.status === 'deactivated') {
      return { ok: false, error: '插件未启用：' + pluginId };
    }
    const size = payloadSize(payload);
    if (size > payloadLimitBytes) {
      emitLog(pluginId, '命令 ' + command + ' 参数过大：' + size + ' 字节');
      return { ok: false, error: '命令参数过大：' + size };
    }
    const requestId = ++requestSeq;
    const timeoutLabel = commandTimeoutMs === DEFAULT_COMMAND_TIMEOUT_MS ? '30s' : Math.round(commandTimeoutMs) + 'ms';
    return new Promise((resolve) => {
      const timer = later(() => {
        const pending = runtime.pending.get(requestId);
        if (!pending) return;
        runtime.pending.delete(requestId);
        emitLog(pluginId, '命令 ' + String(command) + ' 执行超时（' + timeoutLabel + '）');
        resolve({ ok: false, error: '命令执行超时（' + timeoutLabel + '）' });
      }, commandTimeoutMs);
      runtime.pending.set(requestId, { resolve, timer });
      const sent = safePost(runtime, { type: 'invoke', requestId, command: String(command == null ? '' : command), payload });
      if (!sent) {
        runtime.pending.delete(requestId);
        try { cancelLater(timer); } catch (e) { /* ignore */ }
        resolve({ ok: false, error: '无法与插件 Worker 通信' });
      }
    });
  }

  return {
    ensure,
    reload,
    dispose,
    invoke,
    emit,
    setSongMeta,
    // 测试/诊断用（不属于 window 暴露的稳定 API）
    getState() {
      return {
        ensured,
        list: currentList.map((p) => ({ id: p.id, enabled: p.enabled })),
        runtimes: summary().plugins,
        injectedRenderers: Array.from(injectedRenderers),
      };
    },
  };
}

// 插件宿主测试：mock bridge + fake Worker，覆盖 enable/disable、invoke 结果/超时/错误、
// settings 读改写、engine 调用、日志/UI 事件、reload/dispose 与 renderer 注入去重。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPluginHost,
  payloadSize,
  normalizeEngineResult,
  PLUGIN_LOG_EVENT,
  PLUGIN_UI_EVENT,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_PAYLOAD_LIMIT_BYTES,
} from '../src/plugins/host-core.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makePlugin(id, extra) {
  return Object.assign({
    id,
    name: id.toUpperCase(),
    version: '1.0.0',
    author: 'tester',
    description: id + ' desc',
    enabled: true,
    commands: ['ping'],
    manifest: { id, name: id, entry: 'index.js', renderer: 'ui.js' },
    files: [
      { path: 'index.js', content: 'module.exports = { activate: function () {} };' },
      { path: 'ui.js', content: '// renderer for ' + id },
    ],
  }, extra || {});
}

function makeBridge(plugins, settings) {
  const state = {
    settings: settings === undefined
      ? { theme: 'dark', lang: 'zh', plugins: { other: { x: 1 } } }
      : JSON.parse(JSON.stringify(settings)),
    bundles: [],
    saves: [],
    engineCalls: [],
    listCalls: 0,
    engineThrows: false,
    engineRaw: null,
    saveError: '',
  };
  const bridge = {
    plugins: {
      list: async () => {
        state.listCalls += 1;
        return plugins.map((p) => Object.assign({}, p));
      },
      bundle: async (id) => {
        state.bundles.push(id);
        const plugin = plugins.find((p) => p.id === id);
        if (!plugin) return { ok: false, error: '插件不存在' };
        return { ok: true, id, dir: 'C:/plugins/' + id, manifest: plugin.manifest, files: plugin.files };
      },
      engineRun: async (args, opts) => {
        state.engineCalls.push({ args, opts });
        if (state.engineThrows) throw new Error('spawn failed');
        if (state.engineRaw) return state.engineRaw;
        return { ok: true, code: 0, result: { echo: args }, out: 'OUT', err: '' };
      },
    },
    getSettings: async () => JSON.parse(JSON.stringify(state.settings)),
    saveSettings: async (s) => {
      if (state.saveError) return { ok: false, error: state.saveError };
      state.saves.push(JSON.parse(JSON.stringify(s)));
      state.settings = JSON.parse(JSON.stringify(s));
      return { ok: true };
    },
  };
  return { bridge, state };
}

function makeWorkerFactory(opts) {
  const options = opts || {};
  const workers = [];
  function factory(info) {
    const worker = {
      info,
      sent: [],
      terminated: false,
      autoReady: options.autoReady !== false,
      onPost: null,
      messageHandler: null,
      errorHandler: null,
      postMessage(msg) {
        worker.sent.push(msg);
        if (msg.type === 'load' && worker.autoReady) {
          const commands = (info.manifest && info.manifest.commands) || [];
          queueMicrotask(() => worker.emit({ type: 'ready', commands }));
        }
        if (worker.onPost) worker.onPost(msg, worker);
      },
      onMessage(cb) { worker.messageHandler = cb; },
      onError(cb) { worker.errorHandler = cb; },
      terminate() { worker.terminated = true; },
      emit(msg) { if (worker.messageHandler) worker.messageHandler(msg); },
      emitError(err) { if (worker.errorHandler) worker.errorHandler(err); },
      lastMsg(type) { return worker.sent.filter((m) => m.type === type).pop(); },
    };
    workers.push(worker);
    return worker;
  }
  return { factory, workers };
}

function makeDispatch() {
  const events = [];
  const dispatch = (name, detail) => events.push({ name, detail });
  return { events, dispatch, of: (name) => events.filter((e) => e.name === name) };
}

function makeHost(opts) {
  const o = opts || {};
  const plugins = o.plugins || [makePlugin('p1')];
  const bridgePack = makeBridge(plugins, o.settings);
  const workerPack = o.workerFactory || makeWorkerFactory(o.workerOptions);
  const dispatchPack = makeDispatch();
  const injected = [];
  const host = createPluginHost({
    bridge: o.bridge === null ? null : bridgePack.bridge,
    workerFactory: workerPack.factory,
    dispatch: dispatchPack.dispatch,
    log: () => {},
    injectRenderer: (info) => injected.push(info),
    getSongMeta: () => ({ fileName: 'song.mid', trackCount: 2 }),
    commandTimeoutMs: o.commandTimeoutMs,
    payloadLimitBytes: o.payloadLimitBytes,
  });
  return {
    host,
    plugins,
    bridge: bridgePack.bridge,
    state: bridgePack.state,
    workers: workerPack.workers,
    events: dispatchPack.events,
    of: dispatchPack.of,
    injected,
    workerFor(id) { return workerPack.workers.filter((w) => w.info.id === id).pop(); },
  };
}

test('host：ensure 只为 enabled 插件打包并启动 Worker；renderer 按 id 注入一次', async () => {
  const h = makeHost({ plugins: [makePlugin('p1'), makePlugin('p2', { enabled: false })] });
  const result = await h.host.ensure();
  assert.equal(result.ok, true);
  assert.deepEqual(h.state.bundles, ['p1'], 'disabled 插件不应 bundle');
  assert.equal(h.workers.length, 1);
  const w = h.workers[0];
  const load = w.lastMsg('load');
  assert.equal(load.id, 'p1');
  assert.equal(load.dir, 'C:/plugins/p1');
  assert.equal(load.files.length, 2);
  assert.deepEqual(load.settings, {});
  assert.deepEqual(load.songMeta, { fileName: 'song.mid', trackCount: 2 });
  assert.equal(h.injected.length, 1);
  assert.equal(h.injected[0].id, 'p1');
  assert.match(h.injected[0].code, /renderer for p1/);
  await tick();
  const logs = h.of(PLUGIN_LOG_EVENT);
  assert.ok(logs.some((e) => String(e.detail.line).includes('已加载插件')), '应派发加载日志 CustomEvent');
  const state = h.host.getState();
  assert.equal(state.ensured, true);
  assert.equal(state.list.length, 2);
  assert.equal(state.runtimes[0].status, 'ready');
  await h.host.ensure();
  assert.equal(h.workers.length, 1, 'ensure 幂等，不重复创建 Worker');
});

test('host：bridge 缺失时不抛异常，只记日志', async () => {
  const dispatchPack = makeDispatch();
  const workerPack = makeWorkerFactory();
  const host = createPluginHost({ bridge: null, workerFactory: workerPack.factory, dispatch: dispatchPack.dispatch });
  const result = await host.ensure();
  assert.equal(result.plugins.length, 0);
  const logs = dispatchPack.of(PLUGIN_LOG_EVENT);
  assert.ok(logs.some((e) => String(e.detail.line).includes('不支持插件')));
});

test('host：非法插件 id 被拒绝（防止事件名/路径注入）', async () => {
  const h = makeHost({ plugins: [makePlugin('bad id!'), makePlugin('ok-1')] });
  await h.host.ensure();
  assert.deepEqual(h.state.bundles, ['ok-1']);
  assert.ok(h.of(PLUGIN_LOG_EVENT).some((e) => String(e.detail.line).includes('id 非法')));
});

test('host：Worker ready 后记录命令列表', async () => {
  const h = makeHost();
  await h.host.ensure();
  const w = h.workers[0];
  w.emit({ type: 'ready', commands: ['ping', 'pong'] });
  await tick();
  const rt = h.host.getState().runtimes[0];
  assert.equal(rt.status, 'ready');
  assert.deepEqual(rt.commands, ['ping', 'pong']);
});

test('host：invoke 成功返回 { ok, result }，payload 原样转发', async () => {
  const h = makeHost();
  await h.host.ensure();
  const w = h.workers[0];
  w.onPost = (msg, worker) => {
    if (msg.type === 'invoke') {
      worker.emit({ type: 'invoke:result', requestId: msg.requestId, ok: true, result: { pong: msg.command, payload: msg.payload } });
    }
  };
  const r = await h.host.invoke('p1', 'ping', { x: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { pong: 'ping', payload: { x: 1 } });
  const sent = w.lastMsg('invoke');
  assert.equal(sent.command, 'ping');
  assert.deepEqual(sent.payload, { x: 1 });
});

test('host：invoke 插件报错返回 ok=false + error', async () => {
  const h = makeHost();
  await h.host.ensure();
  h.workers[0].onPost = (msg, worker) => {
    if (msg.type === 'invoke') worker.emit({ type: 'invoke:result', requestId: msg.requestId, ok: false, error: '命令失败：boom' });
  };
  const r = await h.host.invoke('p1', 'ping', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('host：invoke 超时（30s 口径，测试用短超时）后返回错误，晚到的结果被忽略', async () => {
  const h = makeHost({ commandTimeoutMs: 25 });
  await h.host.ensure();
  const w = h.workers[0];
  w.onPost = () => {};
  const r = await h.host.invoke('p1', 'slow', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /超时/);
  assert.doesNotThrow(() => w.emit({ type: 'invoke:result', requestId: 1, ok: true, result: 1 }));
});

test('host：payload 超过 1MB 上限（测试用 32B）直接拒绝，不发 Worker', async () => {
  const h = makeHost({ payloadLimitBytes: 32 });
  await h.host.ensure();
  const w = h.workers[0];
  const before = w.sent.filter((m) => m.type === 'invoke').length;
  const r = await h.host.invoke('p1', 'big', 'x'.repeat(200));
  assert.equal(r.ok, false);
  assert.match(r.error, /参数过大/);
  assert.equal(w.sent.filter((m) => m.type === 'invoke').length, before);
});

test('host：未启用 / 不存在的插件返回明确错误', async () => {
  const h = makeHost({ plugins: [makePlugin('off', { enabled: false }), makePlugin('p1')] });
  await h.host.ensure();
  const disabled = await h.host.invoke('off', 'ping', {});
  assert.equal(disabled.ok, false);
  assert.match(disabled.error, /未启用/);
  const missing = await h.host.invoke('nope', 'ping', {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /不存在/);
});

test('host：settings.set 读改写，保留其它插件与其它顶层设置', async () => {
  const h = makeHost({
    settings: { theme: 'dark', lang: 'zh', plugins: { other: { x: 1 }, p1: { old: 1, keep: true } } },
  });
  await h.host.ensure();
  const w = h.workers[0];
  const load = w.lastMsg('load');
  assert.deepEqual(load.settings, { old: 1, keep: true }, 'worker 只看到自己的设置命名空间');

  w.emit({ type: 'ctx:settings:set', key: { a: 2 } });
  await wait(20);
  assert.equal(h.state.saves.length, 1);
  assert.deepEqual(h.state.saves[0], {
    theme: 'dark',
    lang: 'zh',
    plugins: { other: { x: 1 }, p1: { old: 1, keep: true, a: 2 } },
  });
  assert.deepEqual(w.lastMsg('settings:update').settings, { old: 1, keep: true, a: 2 });

  w.emit({ type: 'ctx:settings:set', key: 'b', val: 3 });
  await wait(20);
  assert.deepEqual(h.state.settings.plugins.p1, { old: 1, keep: true, a: 2, b: 3 });
  assert.deepEqual(h.state.settings.plugins.other, { x: 1 });
  assert.equal(h.state.settings.theme, 'dark');
  assert.equal(h.state.settings.lang, 'zh');
});

test('host：settings 保存失败只记日志，不把 settings:update 发回插件', async () => {
  const h = makeHost();
  await h.host.ensure();
  const w = h.workers[0];
  h.state.saveError = 'disk full';
  w.emit({ type: 'ctx:settings:set', key: 'a', val: 1 });
  await wait(20);
  assert.ok(h.of(PLUGIN_LOG_EVENT).some((e) => String(e.detail.line).includes('保存插件设置失败')));
  assert.equal(w.sent.filter((m) => m.type === 'settings:update').length, 0);
});

test('host：ctx.engine.run 转 bridge.plugins.engineRun，结果按 Electron 形状回包', async () => {
  const h = makeHost();
  await h.host.ensure();
  const w = h.workers[0];
  w.emit({ type: 'ctx:engine:run', requestId: 7, args: ['analyze', 'a.mid'], opts: { script: 'key_tools.py', timeoutMs: 1234 } });
  await wait(20);
  assert.deepEqual(h.state.engineCalls[0], { args: ['analyze', 'a.mid'], opts: { script: 'key_tools.py', timeoutMs: 1234, pluginDir: 'C:/plugins/p1', pluginId: 'p1' } });
  const res = w.lastMsg('engine:result');
  assert.equal(res.requestId, 7);
  assert.deepEqual(res.result, { code: 0, result: { echo: ['analyze', 'a.mid'] }, out: 'OUT', err: '' });
});

test('host：engine 调用抛异常时回 { code:-1, result:null, err } 并记日志', async () => {
  const h = makeHost();
  await h.host.ensure();
  const w = h.workers[0];
  h.state.engineThrows = true;
  w.emit({ type: 'ctx:engine:run', requestId: 8, args: [], opts: {} });
  await wait(20);
  const res = w.lastMsg('engine:result');
  assert.equal(res.result.code, -1);
  assert.equal(res.result.result, null);
  assert.match(res.result.err, /spawn failed/);
  assert.ok(h.of(PLUGIN_LOG_EVENT).some((e) => String(e.detail.line).includes('引擎调用失败')));
});

test('host：ctx.log → fufumidi:plugin-log CustomEvent', async () => {
  const h = makeHost();
  await h.host.ensure();
  h.workers[0].emit({ type: 'ctx:log', line: 'hello log' });
  await tick();
  assert.ok(h.of(PLUGIN_LOG_EVENT).some((e) => e.detail.id === 'p1' && e.detail.line === 'hello log'));
});

test('host：ui.broadcast → fuplugin:<id>:<name> + fufumidi:plugin-ui；notify 走 __toast', async () => {
  const h = makeHost();
  await h.host.ensure();
  const w = h.workers[0];
  w.emit({ type: 'ctx:ui', name: 'ready', payload: { commands: ['ping'] } });
  await tick();
  const fu = h.of('fuplugin:p1:ready');
  assert.equal(fu.length, 1);
  assert.deepEqual(fu[0].detail, { commands: ['ping'] });
  const generic = h.of(PLUGIN_UI_EVENT).pop();
  assert.equal(generic.detail.id, 'p1');
  assert.equal(generic.detail.name, 'ready');
  assert.deepEqual(generic.detail.payload, { commands: ['ping'] });

  w.emit({ type: 'ctx:ui', name: '__toast', payload: { text: '已就绪', type: 'ok' } });
  await tick();
  const toast = h.of(PLUGIN_UI_EVENT).filter((e) => e.detail.name === '__toast').pop();
  assert.deepEqual(toast.detail.payload, { text: '已就绪', type: 'ok' });
  assert.equal(h.of('fuplugin:p1:__toast').length, 1);
});

test('host：ctx.events.emit 广播到所有插件 Worker', async () => {
  const h = makeHost({ plugins: [makePlugin('p1'), makePlugin('p2')] });
  await h.host.ensure();
  const w1 = h.workerFor('p1');
  const w2 = h.workerFor('p2');
  w1.emit({ type: 'ctx:event:emit', name: 'song-loaded', payload: { fileName: 'a.mid' } });
  await tick();
  const received = w2.sent.filter((m) => m.type === 'event');
  assert.equal(received.length, 1);
  assert.equal(received[0].name, 'song-loaded');
  assert.deepEqual(received[0].payload, { fileName: 'a.mid' });
  assert.equal(w1.sent.filter((m) => m.type === 'event').length, 1, '广播包含发起插件自己（与 Electron 一致）');
});

test('host：setSongMeta 把曲目元信息推给运行中的 Worker', async () => {
  const h = makeHost();
  await h.host.ensure();
  const w = h.workers[0];
  h.host.setSongMeta({ fileName: 'b.mid', trackCount: 3 });
  await tick();
  assert.deepEqual(w.lastMsg('song-meta').songMeta, { fileName: 'b.mid', trackCount: 3 });
  h.host.setSongMeta(null);
  await tick();
  assert.equal(w.lastMsg('song-meta').songMeta, null);
});

test('host：reload 终止旧 Worker、重建新 Worker，renderer 不重复注入', async () => {
  const h = makeHost();
  await h.host.ensure();
  const oldWorker = h.workers[0];
  await h.host.reload();
  assert.equal(oldWorker.terminated, true);
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[1].info.id, 'p1');
  assert.equal(h.injected.length, 1, '同一插件 id 的 renderer 只注入一次');
  assert.equal(h.host.getState().ensured, true);
});

test('host：插件 load:error 后命令立即失败（不等 30s 超时）', async () => {
  const h = makeHost({ workerOptions: { autoReady: false } });
  await h.host.ensure();
  const w = h.workers[0];
  w.emit({ type: 'load:error', error: 'entry 需导出 activate(ctx)' });
  await wait(10);
  assert.ok(h.of(PLUGIN_LOG_EVENT).some((e) => String(e.detail.line).includes('插件加载失败')));
  const r = await h.host.invoke('p1', 'ping', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /加载失败/);
  assert.match(r.error, /activate/);
});

test('host：Worker 运行时错误标记为 error，后续命令立即失败', async () => {
  const h = makeHost({ workerOptions: { autoReady: false } });
  await h.host.ensure();
  h.workers[0].emitError(new Error('crash'));
  await wait(10);
  const r = await h.host.invoke('p1', 'ping', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /Worker 出错|加载失败/);
});

test('host：dispose 终止 Worker 并清空运行时，可再次 ensure', async () => {
  const h = makeHost();
  await h.host.ensure();
  const w = h.workers[0];
  h.host.dispose();
  assert.equal(w.terminated, true);
  assert.equal(h.host.getState().runtimes.length, 0);
  assert.equal(h.host.getState().ensured, false);
  await h.host.ensure();
  assert.equal(h.workers.length, 2);
});

test('host：payloadSize / normalizeEngineResult 纯函数口径', () => {
  assert.equal(DEFAULT_COMMAND_TIMEOUT_MS, 30000);
  assert.equal(DEFAULT_PAYLOAD_LIMIT_BYTES, 1024 * 1024);
  assert.equal(payloadSize(null), 0);
  assert.equal(payloadSize(undefined), 0);
  assert.equal(payloadSize('abc'), 5);
  assert.equal(payloadSize({ a: 1 }), 7);
  assert.deepEqual(normalizeEngineResult({ ok: true, code: 0, result: { a: 1 }, out: 'o' }), { code: 0, result: { a: 1 }, out: 'o', err: '' });
  assert.deepEqual(normalizeEngineResult({ ok: false, error: 'e' }), { code: -1, result: null, out: '', err: 'e' });
  assert.equal(normalizeEngineResult(null).code, -1);
  assert.equal(normalizeEngineResult({ ok: true }).code, 0);
});

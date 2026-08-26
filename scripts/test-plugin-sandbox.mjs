// 插件沙箱回归测试：白名单 require 放行安全模块，拒绝 fs 等危险模块。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

const require = createRequire(import.meta.url);
const PluginHost = require('../plugin-host.js');

function makeHost(settings = {}) {
  return new PluginHost({
    getSettings: () => settings,
    saveSettings: (s) => ({ ...settings, ...s }),
    spawnEngine: () => null,
    broadcast: () => {},
    getSongMeta: () => null,
  });
}

function createPlugin(root, id, entryJs) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', entry: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), entryJs);
  return dir;
}

test('sandboxed plugin can use whitelisted builtins and is invokable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-plugin-test-'));
  try {
    createPlugin(root, 'demo', `
      const path = require('path');
      module.exports = {
        activate(ctx) { ctx.commands.register('hello', async (payload) => ({ ok: true, payload, dir: path.basename(__dirname) })); },
        deactivate() {},
      };
    `);
    const host = makeHost({ plugins_enabled: ['demo'] });
    host.setRoots([root]);
    host.loadAll();
    assert.equal(host.list().length, 1);
    const r = await host.invoke('demo', 'hello', { x: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.result.dir, 'demo');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox rejects dangerous builtin require', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-plugin-test-'));
  try {
    createPlugin(root, 'bad', `require('fs'); module.exports = { activate() {} };`);
    const host = makeHost();
    host.setRoots([root]);
    host.loadAll();
    assert.equal(host.list().some(p => p.id === 'bad'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox blocks relative require escaping plugin root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-plugin-test-'));
  try {
    // 放一个 plugin 目录和一个同级危险文件
    const outside = path.join(root, 'outside.js');
    fs.writeFileSync(outside, `module.exports = 1;`);
    createPlugin(root, 'escape', `require('../outside.js'); module.exports = { activate() {} };`);
    const host = makeHost();
    host.setRoots([root]);
    host.loadAll();
    assert.equal(host.list().some(p => p.id === 'escape'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('sandbox rejects oversized command payload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-plugin-test-'));
  try {
    createPlugin(root, 'large', `
      module.exports = {
        activate(ctx) { ctx.commands.register('echo', async (p) => p); },
        deactivate() {},
      };
    `);
    const host = makeHost({ plugins_enabled: ['large'] });
    host.setRoots([root]);
    host.loadAll();
    const r = await host.invoke('large', 'echo', { data: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(r.ok, false);
    assert.match(r.error, /命令参数过大/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('sandbox can deny engine capability through permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-plugin-test-'));
  try {
    const dir = path.join(root, 'noengine');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'noengine', name: 'NoEngine', version: '1.0.0', entry: 'index.js', permissions: ['commands'] }));
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { activate(ctx) { if (!ctx.engine) throw new Error('engine disabled'); } };`);
    const host = makeHost();
    host.setRoots([root]);
    host.loadAll();
    assert.equal(host.list().some(p => p.id === 'noengine'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('worker-mode plugin runs in a separate worker thread', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-plugin-test-'));
  try {
    const dir = path.join(root, 'workerplug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'workerplug', name: 'WorkerPlug', version: '1.0.0', entry: 'index.js', sandbox: 'worker', commands: ['who'] }));
    fs.writeFileSync(path.join(dir, 'index.js'), `
      const path = require('path');
      module.exports = {
        activate(ctx) { ctx.commands.register('who', async () => ({ thread: typeof process !== 'undefined' ? process.threadId : null, dir: path.basename(__dirname) })); },
        deactivate() {},
      };
    `);
    const host = makeHost({ plugins_enabled: ['workerplug'] });
    host.setRoots([root]);
    host.loadAll();
    await new Promise(r => setTimeout(r, 250));
    const r = await host.invoke('workerplug', 'who', {});
    assert.equal(r.ok, true);
    assert.equal(r.result.dir, 'workerplug');
    assert.notEqual(r.result.thread, null);
    const wpl = host._plugins.get('workerplug');
    if (wpl && wpl.worker) await wpl.worker.terminate();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
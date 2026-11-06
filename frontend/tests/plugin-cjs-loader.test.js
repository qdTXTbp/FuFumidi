// 插件 CommonJS 加载器测试：纯函数，不依赖 DOM / 真实 Worker
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SANDBOX_ALLOWED_BUILTINS,
  SANDBOX_DENIED_BUILTINS,
  normalizePluginPath,
  createPathShim,
  createBufferClass,
  createBuiltins,
  createRequire,
  createModuleLoader,
  loadEntry,
} from '../src/plugins/cjs-loader.js';

const entry = (content, extra) => [{ path: 'index.js', content }, ...(extra || [])];

test('cjs-loader：相对 require / 省略扩展名 / JSON / 目录 index / 缓存', () => {
  const files = [
    { path: 'index.js', content: [
      "const a = require('./lib/a');",
      "const a2 = require('./lib/a.js');",
      "const conf = require('./config.json');",
      "const pkg = require('./pkg');",
      'module.exports = { a, same: a === a2, conf, pkg };',
    ].join('\n') },
    { path: 'lib/a.js', content: "const c = require('../config.json');\nexports.value = c.n[1];\nexports.tag = 'a';" },
    { path: 'config.json', content: '{"name":"mix","n":[10,20]}' },
    { path: 'pkg/index.js', content: 'module.exports = { pkg: true };' },
  ];
  const mod = loadEntry(files, { platform: 'win32' });
  assert.equal(mod.a.value, 20);
  assert.equal(mod.same, true);
  assert.equal(mod.a.tag, 'a');
  assert.equal(mod.conf.name, 'mix');
  assert.equal(mod.pkg.pkg, true);
});

test('cjs-loader：module.exports 替换与 exports 增量都生效', () => {
  const replaced = loadEntry(entry("module.exports = { via: 'module.exports' };\nexports.extra = 1;"));
  assert.equal(replaced.via, 'module.exports');
  assert.equal(replaced.extra, undefined, 'module.exports 被替换后 exports 别名不再指向它');
  const augmented = loadEntry(entry("exports.a = 1;\nexports.b = 2;"));
  assert.deepEqual(augmented, { a: 1, b: 2 });
});

test('cjs-loader：require 越界（../、盘符绝对路径、跨目录回退）一律拒绝', () => {
  const cases = [
    entry("module.exports = require('../outside.js')"),
    entry("module.exports = require('C:/Windows/system32/x.js')"),
    entry("module.exports = require('./lib/../../outside.js')"),
  ];
  for (const files of cases) {
    assert.throws(() => loadEntry(files), /越界/);
  }
});

test('cjs-loader：根目录内的绝对路径可以 require，根目录外仍然拒绝', () => {
  const files = [
    { path: 'index.js', content: "module.exports = require('C:/plugins/demo/lib/x.js');" },
    { path: 'lib/x.js', content: 'module.exports = { ok: 1 };' },
  ];
  const mod = loadEntry(files, { rootDir: 'C:/plugins/demo' });
  assert.equal(mod.ok, 1);
  const outside = [
    { path: 'index.js', content: "module.exports = require('D:/other/lib/x.js');" },
    { path: 'lib/x.js', content: 'module.exports = { ok: 1 };' },
  ];
  assert.throws(() => loadEntry(outside, { rootDir: 'C:/plugins/demo' }), /越界/);
});

test('cjs-loader：白名单内置模块可用，黑名单/未知模块明确报错', () => {
  const mod = loadEntry(entry([
    "const path = require('path');",
    "const util = require('util');",
    "const events = require('events');",
    "const url = require('url');",
    "const qs = require('querystring');",
    "const assertMod = require('assert');",
    "const os = require('os');",
    "const crypto = require('crypto');",
    "const buffer = require('buffer');",
    'module.exports = { path, util, events, url, qs, assertMod, os, crypto, buffer };',
  ].join('\n')), { platform: 'win32' });
  assert.equal(typeof mod.path.join, 'function');
  assert.equal(typeof mod.util.format, 'function');
  assert.equal(typeof mod.events.EventEmitter, 'function');
  assert.equal(typeof mod.url.parse, 'function');
  assert.equal(typeof mod.qs.stringify, 'function');
  assert.equal(typeof mod.assertMod.strictEqual, 'function');
  assert.equal(typeof mod.os.platform, 'function');
  assert.equal(typeof mod.crypto.randomUUID, 'function');
  assert.equal(typeof mod.buffer.Buffer.from, 'function');
  assert.equal(mod.os.platform(), 'win32');

  assert.throws(() => loadEntry(entry("require('fs')")), /沙箱拒绝/);
  assert.throws(() => loadEntry(entry("require('child_process')")), /沙箱拒绝/);
  assert.throws(() => loadEntry(entry("require('lodash')")), /未在白名单/);
  assert.throws(() => loadEntry(entry("require('./missing-module')")), /找不到模块/);

  for (const name of ['path', 'util', 'events', 'url', 'querystring', 'assert', 'os', 'crypto', 'buffer']) {
    assert.ok(SANDBOX_ALLOWED_BUILTINS.has(name), name + ' 应在白名单');
  }
  for (const name of ['fs', 'child_process', 'net', 'http', 'https']) {
    assert.ok(SANDBOX_DENIED_BUILTINS.has(name), name + ' 应在黑名单');
  }
});

test('path shim（win32）：插件用到的 dirname/basename/extname/join/normalize/isAbsolute', () => {
  const p = createPathShim('win32');
  assert.equal(p.sep, '\\');
  assert.equal(p.dirname('C:\\Users\\me\\song.mid'), 'C:\\Users\\me');
  assert.equal(p.dirname('C:\\song.mid'), 'C:\\');
  assert.equal(p.dirname('song.mid'), '.');
  assert.equal(p.basename('C:\\a\\b.mid'), 'b.mid');
  assert.equal(p.basename('C:\\a\\b.mid', '.mid'), 'b');
  assert.equal(p.extname('C:\\a\\b.mid'), '.mid');
  assert.equal(p.extname('C:\\a\\.hidden'), '');
  assert.equal(p.join('C:\\a', 'b', '..', 'c.js'), 'C:\\a\\c.js');
  assert.equal(p.join('a', 'b'), 'a\\b');
  assert.equal(p.normalize('C:/a//b/../c'), 'C:\\a\\c');
  assert.equal(p.normalize('a/../../b'), 'b');
  assert.equal(p.isAbsolute('C:\\x'), true);
  assert.equal(p.isAbsolute('/x'), true);
  assert.equal(p.isAbsolute('a\\b'), false);
  const parsed = p.parse('C:\\dir\\file.js');
  assert.equal(parsed.root, 'C:\\');
  assert.equal(parsed.dir, 'C:\\dir');
  assert.equal(parsed.name, 'file');
  assert.equal(parsed.ext, '.js');
  assert.equal(p.format(parsed), 'C:\\dir\\file.js');
  // Windows 插件里常见「正斜杠路径 + path.join」混用
  assert.equal(p.join('/a/b', 'c.txt'), '\\a\\b\\c.txt');
});

test('path shim（posix）：与 Node path.posix 的常用行为一致', () => {
  const p = createPathShim('linux');
  assert.equal(p.sep, '/');
  assert.equal(p.dirname('/a/b/c.js'), '/a/b');
  assert.equal(p.dirname('/'), '/');
  assert.equal(p.basename('/a/b/c.js', '.js'), 'c');
  assert.equal(p.extname('/a/b/c.js'), '.js');
  assert.equal(p.join('/a', 'b', '..', 'c.js'), '/a/c.js');
  assert.equal(p.normalize('/a//b/../c'), '/a/c');
  assert.equal(p.isAbsolute('/a'), true);
  assert.equal(p.isAbsolute('a'), false);
  assert.equal(p.parse('/d/f.txt').dir, '/d');
  assert.equal(p.format({ dir: '/d', name: 'f', ext: '.txt' }), '/d/f.txt');
  assert.equal(p.relative('/a/b', '/a/c'), '../c');
  assert.equal(p.relative('/a/b', '/a/b'), '.');
  assert.equal(p.relative('/a', '/a/b/c'), 'b/c');
});

test('buffer shim：from/toString/alloc/concat/isBuffer/byteLength', () => {
  const Buffer = createBufferClass();
  const b = Buffer.from('hi');
  assert.equal(Buffer.isBuffer(b), true);
  assert.equal(b.length, 2);
  assert.equal(b.toString('utf8'), 'hi');
  assert.equal(b.toString('base64'), 'aGk=');
  assert.equal(b.toString('hex'), '6869');
  assert.equal(Buffer.from('aGk=', 'base64').toString(), 'hi');
  assert.equal(Buffer.from('6869', 'hex').toString(), 'hi');
  assert.equal(Buffer.byteLength('hi'), 2);
  assert.equal(Buffer.byteLength('你好'), 6);
  const alloc = Buffer.alloc(3, 7);
  assert.deepEqual(Array.from(alloc), [7, 7, 7]);
  const joined = Buffer.concat([Buffer.from('ab'), Buffer.from('cd')]);
  assert.equal(joined.toString(), 'abcd');
  assert.equal(joined.equals(Buffer.from('abcd')), true);
  assert.equal(joined.compare(Buffer.from('abce')), -1);
  assert.equal(Buffer.from([1, 2, 3]).toString('hex'), '010203');
  assert.equal(Buffer.from('x').toJSON().type, 'Buffer');
});

test('events shim：on/once/off/emit/removeAllListeners/listenerCount', () => {
  const { EventEmitter } = createBuiltins({ platform: 'win32' }).events;
  const em = new EventEmitter();
  const seen = [];
  const on = (v) => seen.push(v);
  em.on('x', on);
  em.emit('x', 1);
  assert.deepEqual(seen, [1]);
  em.off('x', on);
  em.emit('x', 2);
  assert.deepEqual(seen, [1]);
  let onceCount = 0;
  em.once('y', () => { onceCount += 1; });
  em.emit('y');
  em.emit('y');
  assert.equal(onceCount, 1);
  const two = () => {};
  em.on('z', two);
  em.on('z', two);
  assert.equal(em.listenerCount('z'), 2);
  em.removeAllListeners('z');
  assert.equal(em.listenerCount('z'), 0);
  assert.throws(() => em.emit('error', new Error('boom')), /boom/);
});

test('util / querystring / assert / url shim：插件常用面可用', () => {
  const builtins = createBuiltins({ platform: 'win32' });
  assert.equal(builtins.util.format('%s=%d', 'a', 3), 'a=3');
  assert.equal(builtins.util.format('%j', { a: 1 }), '{"a":1}');
  assert.equal(builtins.util.inspect('x'), '"x"');
  assert.equal(typeof builtins.util.promisify, 'function');

  assert.equal(builtins.querystring.stringify({ a: 1, b: 'x y' }), 'a=1&b=x%20y');
  const parsedQs = builtins.querystring.parse('a=1&b=x%20y');
  assert.deepEqual({ ...parsedQs }, { a: '1', b: 'x y' });
  assert.deepEqual(builtins.querystring.parse('a=1&a=2').a, ['1', '2']);

  assert.doesNotThrow(() => builtins.assert.equal(1, 1));
  assert.throws(() => builtins.assert.strictEqual(1, '1'), /期望/);
  assert.throws(() => builtins.assert.deepEqual({ a: 1 }, { a: 2 }), /期望深度相等/);

  const parsed = builtins.url.parse('https://example.com/a?x=1#h');
  assert.equal(parsed.hostname, 'example.com');
  assert.equal(parsed.pathname, '/a');
  assert.equal(parsed.query.x, '1');
  assert.equal(parsed.hash, '#h');
  assert.equal(typeof builtins.url.format, 'function');
  assert.match(builtins.crypto.randomUUID(), /^[0-9a-f-]{36}$/i);
  assert.equal(builtins.crypto.randomBytes(8).length, 8);
  assert.throws(() => builtins.crypto.createHash('sha256'), /不支持/);
});

test('cjs-loader：__filename / __dirname 带插件根目录（rootDir）', () => {
  const files = [
    { path: 'index.js', content: "module.exports = { file: __filename, dir: __dirname, nested: require('./lib/x') };" },
    { path: 'lib/x.js', content: 'module.exports = { file: __filename, dir: __dirname };' },
  ];
  const mod = loadEntry(files, { rootDir: 'C:\\plugins\\demo' });
  assert.equal(mod.file, 'C:/plugins/demo/index.js');
  assert.equal(mod.dir, 'C:/plugins/demo');
  assert.equal(mod.nested.file, 'C:/plugins/demo/lib/x.js');
  assert.equal(mod.nested.dir, 'C:/plugins/demo/lib');
});

test('cjs-loader：循环 require 先拿部分 exports（Node 语义）', () => {
  const files = [
    { path: 'index.js', content: "module.exports = require('./a');" },
    { path: 'a.js', content: "exports.a = 1;\nconst b = require('./b');\nexports.b = b.b;\nexports.bSeesA = b.a;" },
    { path: 'b.js', content: "const a = require('./a');\nexports.a = a.a;\nexports.b = 2;" },
  ];
  const mod = loadEntry(files);
  assert.equal(mod.a, 1);
  assert.equal(mod.b, 2);
  assert.equal(mod.bSeesA, 1);
});

test('cjs-loader：JSON 解析失败 / 入口缺失给出明确错误', () => {
  assert.throws(() => loadEntry([{ path: 'index.js', content: "require('./bad.json')" }, { path: 'bad.json', content: '{oops' }]), /JSON 解析失败/);
  assert.throws(() => loadEntry([{ path: 'other.js', content: 'module.exports = 1;' }], { entry: 'index.js' }), /入口不存在/);
});

test('cjs-loader：createRequire 绑定入口目录（Node createRequire 风格）', () => {
  const files = [
    { path: 'index.js', content: 'module.exports = 0;' },
    { path: 'lib/a.js', content: 'module.exports = { n: 7 };' },
    { path: 'lib/data.json', content: '{ "n": 8 }' },
  ];
  const requireFromEntry = createRequire(files, { entry: 'index.js' });
  assert.equal(requireFromEntry('./lib/a').n, 7);
  assert.equal(requireFromEntry('./lib/data.json').n, 8);
  assert.throws(() => requireFromEntry('../x'), /越界/);
});

test('cjs-loader：normalizePluginPath 规整路径、拒绝越界段', () => {
  assert.equal(normalizePluginPath('./lib//a.js'), 'lib/a.js');
  assert.equal(normalizePluginPath('lib\\sub\\a.js'), 'lib/sub/a.js');
  assert.equal(normalizePluginPath('/index.js'), 'index.js');
  assert.equal(normalizePluginPath('a/../b/./c'), 'b/c');
  const loader = createModuleLoader([{ path: 'index.js', content: 'module.exports = 1;' }]);
  assert.equal(loader.files.get('index.js'), 'module.exports = 1;');
  assert.deepEqual(loader.loadEntry('index.js'), 1);
});

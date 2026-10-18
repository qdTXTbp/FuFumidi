// P2-1 VST3 离线宿主桥接：纯函数测试（不需要真实插件）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../main/plugin-host.js');

test('P2-1 宿主解释器候选：设置 > 环境变量 > 开发路径 > PATH', () => {
  const old = process.env.FUFUMIDI_PLUGIN_PYTHON;
  delete process.env.FUFUMIDI_PLUGIN_PYTHON;
  const c = P.candidatesPython({ 'plugin.host_python': '/x/python.exe' });
  assert.equal(c[0], '/x/python.exe');
  assert.ok(c.includes('python'));
  process.env.FUFUMIDI_PLUGIN_PYTHON = '/env/python.exe';
  const c2 = P.candidatesPython({});
  assert.equal(c2[0], '/env/python.exe');
  if (old === undefined) delete process.env.FUFUMIDI_PLUGIN_PYTHON; else process.env.FUFUMIDI_PLUGIN_PYTHON = old;
});

test('P2-1 插件目录候选：设置数组 > 环境变量(;分隔) > 开发默认', () => {
  const old = process.env.FUFUMIDI_PLUGIN_DIRS;
  delete process.env.FUFUMIDI_PLUGIN_DIRS;
  const d = P.candidatesDirs({ 'plugin.dirs': ['C:/vst', 'D:/vst2'] });
  assert.deepEqual(d.slice(0, 2), ['C:/vst', 'D:/vst2']);
  process.env.FUFUMIDI_PLUGIN_DIRS = 'E:/a;E:/b';
  const d2 = P.candidatesDirs({});
  assert.ok(d2.includes('E:/a') && d2.includes('E:/b'));
  if (old === undefined) delete process.env.FUFUMIDI_PLUGIN_DIRS; else process.env.FUFUMIDI_PLUGIN_DIRS = old;
});

test('P2-1 宿主脚本路径：开发态指向 engine/plugin_render.py', () => {
  const p = P.engineScript(null, 'E:/Midi/FuFumidi-Source');
  assert.match(p.replace(/\\/g, '/'), /engine\/plugin_render\.py$/);
});

test('P2-1 结果解析：取最后一行合法 JSON，忽略插件日志噪声', () => {
  const text = 'plugin log line\n{"ok":true,"plugins":[]}\nsome warning\n';
  assert.deepEqual(P.parseLastJson(text), { ok: true, plugins: [] });
  assert.equal(P.parseLastJson('no json here'), null);
  assert.deepEqual(P.parseLastJson('x\n{"ok":false,"error":"e"}'), { ok: false, error: 'e' });
});

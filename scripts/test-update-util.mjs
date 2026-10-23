// P0/P1 更新器自检：旧安装包/手动部署可能留下未嵌入配置的更新器（点更新报「安装包损坏」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { updaterLooksConfigured, MARKERS } = require('../main/update_util.js');

function fakeUpdater({ data = true, exe = true, size = 4096 } = {}) {
  const buf = Buffer.alloc(size, 0x4d);
  const text = [data ? 'FuFumidiData' : '', exe ? 'FuFumidi.exe' : ''].join('|');
  buf.write(text, 0, 'latin1');
  return buf;
}

test('更新器自检：同时含数据目录与主程序名才算已配置', () => {
  assert.equal(updaterLooksConfigured(fakeUpdater()), true);
  assert.equal(updaterLooksConfigured(fakeUpdater({ data: false })), false);
  assert.equal(updaterLooksConfigured(fakeUpdater({ exe: false })), false);
  assert.deepEqual(MARKERS, ['FuFumidiData', 'FuFumidi.exe']);
});

test('更新器自检：空/过小/非二进制输入一律判未配置（避免误信坏文件）', () => {
  assert.equal(updaterLooksConfigured(null), false);
  assert.equal(updaterLooksConfigured(Buffer.alloc(0)), false);
  assert.equal(updaterLooksConfigured(Buffer.from('FuFumidiData FuFumidi.exe')), false);
  assert.equal(updaterLooksConfigured(fakeUpdater({ size: 512 })), false);
});

test('更新器自检：latin1 字符串输入同样可按标记识别', () => {
  const s = 'MZ' + 'x'.repeat(2000) + 'FuFumidiData' + 'FuFumidi.exe';
  assert.equal(updaterLooksConfigured(s), true);
});

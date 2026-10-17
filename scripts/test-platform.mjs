// P2-4 跨平台路径/清单纯函数测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PLAT = require('../main/platform.js');

test('P2-4 平台表：只支持 win32/darwin/linux', () => {
  assert.deepEqual(PLAT.PLATFORMS, ['win32', 'darwin', 'linux']);
  assert.deepEqual(PLAT.pythonCandidates('plan9'), ['python3']);
});

test('P2-4 内置 Python 运行时：Windows 用 python/python.exe，mac/linux 用 python/bin/python3', () => {
  assert.equal(PLAT.pythonRuntimeRelative('win32').replace(/\\/g, '/'), 'python/python.exe');
  assert.equal(PLAT.pythonRuntimeRelative('darwin').replace(/\\/g, '/'), 'python/bin/python3');
  assert.equal(PLAT.pythonRuntimeRelative('linux').replace(/\\/g, '/'), 'python/bin/python3');
});

test('P2-4 venv 解释器：Windows Scripts/python.exe，其余 bin/python', () => {
  assert.equal(PLAT.venvPythonRelative('win32').replace(/\\/g, '/'), 'Scripts/python.exe');
  assert.equal(PLAT.venvPythonRelative('linux').replace(/\\/g, '/'), 'bin/python');
});

test('P2-4 安装包后缀与平台说明', () => {
  assert.equal(PLAT.installerExt('win32'), 'exe');
  assert.equal(PLAT.installerExt('darwin'), 'dmg');
  assert.equal(PLAT.installerExt('linux'), 'AppImage');
  assert.match(PLAT.platformNotes('darwin'), /未签名|公证/);
  assert.match(PLAT.platformNotes('win32'), /正式/);
});

test('P2-4 数据根：mac 走 Application Support，linux 走 .local/share，win 交给 paths.js', () => {
  assert.equal(PLAT.defaultDataRoot('win32', 'C:/Users/x'), '');
  assert.match(PLAT.defaultDataRoot('darwin', '/Users/x'), /Library\/Application Support\/FuFumidiData$/);
  assert.match(PLAT.defaultDataRoot('linux', '/home/x'), /\.local\/share\/FuFumidiData$/);
});

test('P2-4 冒烟清单：非 Windows 明确要求不碰 Windows 专有 API', () => {
  const win = PLAT.smokeChecklist('win32');
  const mac = PLAT.smokeChecklist('darwin');
  assert.ok(win.some((x) => /midi 输入设备/.test(x)));
  assert.ok(mac.some((x) => /Windows 专有 API/.test(x)));
  assert.ok(mac.length >= 6);
});

test('P2-4 pythonCandidates：用户配置优先，其次内置，最后系统', () => {
  const c = PLAT.pythonCandidates('linux', { configured: '/opt/py/bin/python', resourcesRoot: '/app/resources' });
  assert.equal(c[0], '/opt/py/bin/python');
  assert.equal(c[1], '/app/resources/python/bin/python3');
  assert.equal(c[2], 'python3');
});

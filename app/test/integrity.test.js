// ============================================================
// integrity.js 单元测试：模拟「用户误删相关文件」的各类场景，
// 验证检测（check）与修复（repair）行为符合预期。
// 运行：node test/integrity.test.js
// 使用 Node 内置 assert，零第三方依赖。
// ============================================================
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createIntegrity } = require('../integrity');

// ---- 临时工作区（测试后清理）----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-integrity-'));
const dataDir = path.join(root, 'data');
const userPlugins = path.join(root, 'userPlugins');
const builtinPlugins = path.join(root, 'builtinPlugins');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(userPlugins, { recursive: true });
fs.mkdirSync(builtinPlugins, { recursive: true });

const settingsPath = () => path.join(dataDir, 'settings.json');
const DEFAULT_SETTINGS = {
  theme: 'deep', accent: '', engine_path: '', engine_mode: 'universal',
  perf_mode: 'quality', output_dir: '', guide_done: false, plugins_enabled: [], lang: 'zh',
};

let disk = {};   // 内存模拟磁盘（写 settings 时不真正落盘，便于断言）
function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
}

const integrity = createIntegrity({
  getSettingsPath: settingsPath,
  getPluginsUserDir: () => userPlugins,
  getBuiltinPluginsDir: () => builtinPlugins,
  readSettings,
  writeSettings,
  defaultSettings: DEFAULT_SETTINGS,
  isPackaged: false,   // 开发模式：presets 可校验
});

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓ ' + name);
}

// 预设文件：放在 integrity.js 同级的 engine/ 下（真实项目结构）
const presetsPath = path.join(__dirname, '..', 'engine', 'presets.json');
const presetsExist = fs.existsSync(presetsPath);
const origPresets = presetsExist ? fs.readFileSync(presetsPath, 'utf8') : null;
const testPresets = JSON.stringify({ presets: {} }, null, 2);

// 统一还原 presets.json 到测试前状态（无论哪个场景失败都不会残留）
function restorePresets() {
  fs.rmSync(presetsPath, { force: true });
  if (origPresets !== null) fs.writeFileSync(presetsPath, origPresets, 'utf8');
}

try {

console.log('—— 场景 1：一切完好 ——');
(function () {
  // 预置合法 presets.json，使“一切完好”成立（engine/presets.json 缺失本身会被检测为 info 级问题）
  fs.mkdirSync(path.dirname(presetsPath), { recursive: true });
  fs.writeFileSync(presetsPath, testPresets, 'utf8');
  writeSettings({ ...DEFAULT_SETTINGS, plugins_enabled: [] });
  fs.mkdirSync(path.join(userPlugins, 'hello'), { recursive: true });
  fs.writeFileSync(path.join(userPlugins, 'hello', 'plugin.json'), JSON.stringify({ id: 'hello', entry: 'index.js' }), 'utf8');
  const r = integrity.check();
  ok('无问题 (ok=true)', r.ok === true);
  ok('issues 为空', r.issues.length === 0);
  fs.rmSync(path.join(userPlugins, 'hello'), { recursive: true, force: true });
  fs.rmSync(presetsPath, { force: true });   // 还原为“缺失”状态，供后续场景演示
})();

console.log('—— 场景 2：settings.json 缺失 ——');
(function () {
  fs.rmSync(settingsPath(), { force: true });
  const r = integrity.check();
  ok('检测到 settings-missing', r.issues.some(i => i.id === 'settings-missing'));
  const fix = integrity.repair(['settings-missing']);
  ok('修复成功', fix.ok === true && fix.results[0].ok === true);
  ok('settings.json 已重建', fs.existsSync(settingsPath()));
  ok('重建后 check 无此问题', !integrity.check().issues.some(i => i.id === 'settings-missing'));
})();

console.log('—— 场景 3：settings.json 损坏 ——');
(function () {
  fs.writeFileSync(settingsPath(), '{ this is not valid json !!!', 'utf8');
  const r = integrity.check();
  ok('检测到 settings-corrupt', r.issues.some(i => i.id === 'settings-corrupt'));
  const fix = integrity.repair(['settings-corrupt']);
  ok('修复成功', fix.ok === true && fix.results[0].ok === true);
  ok('已生成备份文件', !!fix.results[0].backup && fs.existsSync(fix.results[0].backup));
  ok('settings.json 已是合法 JSON', JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) !== null);
  ok('修复后 check 无此问题', !integrity.check().issues.some(i => i.id === 'settings-corrupt'));
})();

console.log('—— 场景 4：presets.json 缺失/损坏 ——');
(function () {
  // 无论 engine/presets.json 原本是否存在，都可测试：缺失场景直接删，损坏场景写垃圾
  fs.rmSync(presetsPath, { force: true });
  const r1 = integrity.check();
  ok('检测到 presets-missing', r1.issues.some(i => i.id === 'presets-missing'));
  const fix1 = integrity.repair(['presets-missing']);
  ok('修复成功并重建', fix1.ok === true && fs.existsSync(presetsPath));
  // 损坏场景
  fs.writeFileSync(presetsPath, 'garbage{{{', 'utf8');
  const r2 = integrity.check();
  ok('检测到 presets-corrupt', r2.issues.some(i => i.id === 'presets-corrupt'));
  const fix2 = integrity.repair(['presets-corrupt']);
  ok('损坏修复成功并带备份', fix2.ok === true && !!fix2.results[0].backup && fs.existsSync(presetsPath));
  // 还原为“缺失”状态，供打包模式场景演示
  fs.rmSync(presetsPath, { force: true });
})();

console.log('—— 场景 5：已启用插件被用户误删 ——');
(function () {
  // 造一个已启用插件，目录真实存在
  fs.mkdirSync(path.join(userPlugins, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(userPlugins, 'demo', 'plugin.json'), JSON.stringify({ id: 'demo', entry: 'index.js' }), 'utf8');
  writeSettings({ ...DEFAULT_SETTINGS, plugins_enabled: ['demo', 'ghost'] });
  // ghost 插件从未有目录 → 应被检测
  const r = integrity.check();
  ok('检测到 ghost 插件缺失', r.issues.some(i => i.id === 'plugin-missing:ghost'));
  ok('demo 插件目录存在 → 不误报', !r.issues.some(i => i.id === 'plugin-missing:demo'));
  const fix = integrity.repair(['plugin-missing:ghost']);
  ok('修复成功', fix.ok === true && fix.results[0].ok === true);
  const after = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  ok('ghost 已从 plugins_enabled 移除', !after.plugins_enabled.includes('ghost'));
  ok('demo 仍在 plugins_enabled', after.plugins_enabled.includes('demo'));
})();

console.log('—— 场景 6：打包模式跳过 presets 校验 ——');
(function () {
  const pkg = createIntegrity({
    getSettingsPath: settingsPath, getPluginsUserDir: () => userPlugins,
    getBuiltinPluginsDir: () => builtinPlugins, readSettings, writeSettings,
    defaultSettings: DEFAULT_SETTINGS, isPackaged: true,
  });
  fs.rmSync(presetsPath, { force: true });
  const r = pkg.check();
  ok('打包模式不报告 presets-missing', !r.issues.some(i => i.id === 'presets-missing'));
})();

console.log('—— 场景 7：修复未知 id 不崩溃 ——');
(function () {
  const fix = integrity.repair(['nonexistent-id']);
  ok('返回 ok=false 而非抛异常', fix.ok === false && fix.results[0].ok === false);
})();

} finally {
  // 无论测试成败都还原 presets.json + 清理临时目录
  restorePresets();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('\n全部通过：' + passed + ' 项断言 ✓');

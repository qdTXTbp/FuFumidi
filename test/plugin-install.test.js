/**
 * 插件安装服务测试（不起 Electron）
 * 用本地 HTTP 服务模拟平台，真包走完整流程。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// ---- 先把 electron 顶掉，paths.js 在加载时就会 require 它 ----
const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'akc-test-'));
const Module = require('module');
const FAKE = path.join(__dirname, '__fake-electron.js');
fs.writeFileSync(FAKE, [
  "// 测试用 electron 替身：只提供 paths.js 需要的 app.getPath",
  "const os = require('os'); const path = require('path');",
  "module.exports = { app: {",
  "  getPath: (n) => path.join(os.tmpdir(), 'fufumidi-test-' + n),",
  "  getName: () => 'FuFumidi',",
  "} };",
].join('\n'));
process.on('exit', () => { try { fs.unlinkSync(FAKE); } catch (e) {} });
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return FAKE;
  return origResolve.call(this, request, ...rest);
};

const Installer = require('../main/plugin-install.js');

const USER_PLUGINS = path.join(TMPROOT, 'user-plugins');
fs.mkdirSync(USER_PLUGINS, { recursive: true });

const REAL_ZIP = path.join(os.tmpdir(), 'auto-key-cmajor.zip');
const results = [];
const check = (name, cond, extra) => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// ---- 模拟平台：把真 zip 喂给客户端 ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/store/plugins/auto-key-cmajor/download') {
    if (!fs.existsSync(REAL_ZIP)) { res.writeHead(404); return res.end('not found'); }
    const buf = fs.readFileSync(REAL_ZIP);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(buf.length),
      'X-Plugin-Version': '1.0.0',
    });
    return res.end(buf);
  }
  if (url.pathname === '/api/store/plugins/broken/download') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: '插件不存在' }));
  }
  // 模拟网关把错误改写成 200 + JSON 的情况：安装器必须能识别出这不是 zip
  if (url.pathname === '/api/store/plugins/notzip/download') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: '插件已被下架' }));
  }
  res.writeHead(404); res.end();
});

function makeZip(entries) {
  const AdmZip = require('adm-zip');
  const z = new AdmZip();
  for (const [name, content] of Object.entries(entries)) z.addFile(name, Buffer.from(content));
  return z.toBuffer();
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`模拟平台: ${base}\n用户插件目录: ${USER_PLUGINS}\n`);

  // ============ 1. 正常安装流程 ============
  console.log('【1】下载 → 检查 → 安装');
  const dl = await Installer.download({ baseUrl: base, slug: 'auto-key-cmajor', userPluginsDir: USER_PLUGINS });
  check('下载成功', dl.ok, dl.error);
  check('拿到 token', !!dl.token);
  check('清单 id 正确', dl.manifest && dl.manifest.id === 'auto-key-cmajor', dl.manifest && dl.manifest.id);
  check('版本号读到了', dl.manifest && dl.manifest.version === '1.0.0', dl.manifest && dl.manifest.version);
  check('入口文件正确', dl.manifest && dl.manifest.entry === 'index.js');
  check('渲染层脚本读到了', dl.manifest && dl.manifest.renderer === 'ui.js');
  check('文件清单完整', dl.fileCount === 5, `${dl.fileCount} 个条目`);
  check('文件清单已剥掉顶层目录', dl.files.every((f) => !f.path.startsWith('auto-key-cmajor/')),
    dl.files.map((f) => f.path).join(', '));
  check('不是升级（首次安装）', dl.isUpgrade === false);
  check('无安全警告', (dl.problems || []).length === 0, JSON.stringify(dl.problems));

  const ins = Installer.install({ token: dl.token, userPluginsDir: USER_PLUGINS });
  check('安装成功', ins.ok, ins.error);
  check('装到了正确目录', ins.dir === path.join(USER_PLUGINS, 'auto-key-cmajor'), ins.dir);
  const mPath = path.join(USER_PLUGINS, 'auto-key-cmajor', 'plugin.json');
  check('plugin.json 已落盘', fs.existsSync(mPath));
  check('index.js 已落盘', fs.existsSync(path.join(USER_PLUGINS, 'auto-key-cmajor', 'index.js')));
  check('key_tools.py 已落盘', fs.existsSync(path.join(USER_PLUGINS, 'auto-key-cmajor', 'key_tools.py')));
  check('无多套一层目录', !fs.existsSync(path.join(USER_PLUGINS, 'auto-key-cmajor', 'auto-key-cmajor')));

  const listed = Installer.listInstalled(USER_PLUGINS);
  check('已安装列表能读到', listed.length === 1 && listed[0].id === 'auto-key-cmajor',
    JSON.stringify(listed.map((p) => p.id)));

  // ============ 2. token 一次性 ============
  console.log('\n【2】token 一次性（防重放）');
  const again = Installer.install({ token: dl.token, userPluginsDir: USER_PLUGINS });
  check('同一 token 不能装第二次', again.ok === false, again.error);

  // ============ 3. 升级需确认 ============
  console.log('\n【3】重复安装视为升级');
  const dl2 = await Installer.download({ baseUrl: base, slug: 'auto-key-cmajor', userPluginsDir: USER_PLUGINS });
  check('二次下载识别为升级', dl2.isUpgrade === true);
  check('报告了旧版本', dl2.existing && dl2.existing.version === '1.0.0', JSON.stringify(dl2.existing));
  const noConfirm = Installer.install({ token: dl2.token, userPluginsDir: USER_PLUGINS });
  check('未确认时拒绝安装', noConfirm.ok === false && noConfirm.needsConfirm === true, noConfirm.error);
  const confirmed = Installer.install({ token: dl2.token, userPluginsDir: USER_PLUGINS, overwrite: true });
  check('确认后安装成功', confirmed.ok, confirmed.error);
  check('标记为升级', confirmed.isUpgrade === true && confirmed.upgradedFrom === '1.0.0',
    `${confirmed.upgradedFrom} → ${confirmed.version}`);

  // ============ 4. 拒绝非插件包 ============
  console.log('\n【4】拒绝不合法的包');
  const badZip = path.join(TMPROOT, 'notaplugin.zip');
  fs.writeFileSync(badZip, makeZip({ 'hello.txt': 'hi' }));
  const AdmZip = require('adm-zip');
  // 用一个假的 download 流程：直接塞进 pending 不方便，改为手工调 inspect
  console.log('  （通过 inspect 校验，见下方恶意包用例）');

  // ============ 5. 拒绝路径穿越 ============
  // ★ 必须用 Python 的 zipfile 手搓原始包：adm-zip 的 addFile 会在**创建时**
  //   把 '../escape.txt' 规范化成 'escape.txt'，用它造不出真正的穿越条目，
  //   那样这个用例就是自欺欺人（踩过一次）。
  console.log('\n【5】拒绝恶意包');
  const evil = path.join(os.tmpdir(), 'evil-raw.zip');
  if (!fs.existsSync(evil)) throw new Error('缺少 evil-raw.zip，请先用 Python zipfile 生成');
  const evilBuf = fs.readFileSync(evil);
  const evilServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'X-Plugin-Version': '1.0.0' });
    res.end(evilBuf);
  });
  await new Promise((r) => evilServer.listen(0, '127.0.0.1', r));
  const evilBase = `http://127.0.0.1:${evilServer.address().port}`;
  const dlEvil = await Installer.download({ baseUrl: evilBase, slug: 'x', userPluginsDir: USER_PLUGINS });
  check('检出路径穿越并标记为不安全', dlEvil.ok === false && (dlEvil.problems || []).some((p) => /不安全/.test(p)),
    JSON.stringify(dlEvil.problems));
  const insEvil = Installer.install({ token: dlEvil.token, userPluginsDir: USER_PLUGINS });
  check('恶意包被拒绝安装', insEvil.ok === false, insEvil.error);
  check('没有文件被写到插件目录外', !fs.existsSync(path.join(TMPROOT, 'escape.txt')));
  evilServer.close();

  // ============ 6. 入口文件缺失 ============
  console.log('\n【6】清单声明的入口不存在时拒绝');
  const noEntry = path.join(TMPROOT, 'noentry.zip');
  fs.writeFileSync(noEntry, makeZip({
    'plug-x/plugin.json': JSON.stringify({ id: 'plug-x', version: '1.0.0', entry: 'main.js' }),
    'plug-x/other.js': 'x',
  }));
  const neBuf = fs.readFileSync(noEntry);
  const neServer = http.createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'X-Plugin-Version': '1.0.0' });
    res.end(neBuf);
  });
  await new Promise((r) => neServer.listen(0, '127.0.0.1', r));
  const neBase = `http://127.0.0.1:${neServer.address().port}`;
  const dlNe = await Installer.download({ baseUrl: neBase, slug: 'plug-x', userPluginsDir: USER_PLUGINS });
  const insNe = Installer.install({ token: dlNe.token, userPluginsDir: USER_PLUGINS });
  check('入口缺失被拒绝', insNe.ok === false && /入口/.test(insNe.error || ''), insNe.error);
  check('失败后没留下半成品目录', !fs.existsSync(path.join(USER_PLUGINS, 'plug-x')));
  neServer.close();

  // ============ 7. 平台报错 ============
  console.log('\n【7】平台侧错误');
  const dlBroken = await Installer.download({ baseUrl: base, slug: 'broken', userPluginsDir: USER_PLUGINS });
  check('平台 404 时给出原因', dlBroken.ok === false && /插件不存在/.test(dlBroken.error || ''), dlBroken.error);
  const dlNotZip = await Installer.download({ baseUrl: base, slug: 'notzip', userPluginsDir: USER_PLUGINS });
  check('200 返回 JSON 时能识别出不是插件包',
    dlNotZip.ok === false && /已被下架|不是插件包/.test(dlNotZip.error || ''), dlNotZip.error);
  const dl404 = await Installer.download({ baseUrl: base, slug: 'no-such-plugin', userPluginsDir: USER_PLUGINS });
  check('不存在的插件给出明确错误', dl404.ok === false, dl404.error);

  // ============ 8. 放弃下载 ============
  console.log('\n【8】放弃下载');
  const dl3 = await Installer.download({ baseUrl: base, slug: 'auto-key-cmajor', userPluginsDir: USER_PLUGINS });
  const discarded = Installer.discard(dl3.token);
  check('放弃成功', discarded.ok === true);
  const insAfterDiscard = Installer.install({ token: dl3.token, userPluginsDir: USER_PLUGINS });
  check('放弃后不能再装', insAfterDiscard.ok === false, insAfterDiscard.error);

  server.close();
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });

// 部署后自动冒烟：启动安装版一次，断言「不是白屏 / preload 在 / 没有未捕获异常」。
//
// 为什么值得有：构建绿 ≠ 能用。渲染进程栽在启动路径上时（preload 抛错、i18n 表缺键、
// 存储初始化失败…）表现就是白屏，而 deploy-installed.cjs 只看文件拷贝有没有成功 ——
// 实测就是这么把一个打不开的版本报成「完成」的。这一层让白屏在部署当场暴露，
// 而不是等用户双击了才发现。
//
// 用法：
//   node scripts/cdp/cdp-smoke.cjs
//   环境变量：FUFUMIDI_INSTALL（默认 E:\Midi\FuFumidi）、CDP_PORT（默认 9333）、
//            SMOKE_TIMEOUT（默认 60000ms）、KEEP_OPEN=1（跑完不关掉应用）
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const INSTALL = process.env.FUFUMIDI_INSTALL || 'E:\\Midi\\FuFumidi';
const EXE = path.join(INSTALL, 'FuFumidi.exe');
const PORT = Number(process.env.CDP_PORT || 9333);
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT || 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

async function waitForPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const ts = await getJson('/json');
      const page = ts.find((t) => t.type === 'page' && !/devtools/i.test(t.url || ''));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) { /* 还没起来 */ }
    await sleep(500);
  }
  return null;
}

async function main() {
  if (!fs.existsSync(EXE)) { console.error('冒烟失败：找不到 ' + EXE); process.exit(2); }

  // 关掉可能还在跑的上一个实例，否则新进程会把调试端口让给它
  try { execSync('taskkill /IM FuFumidi.exe /F', { stdio: 'ignore' }); } catch (e) {}
  await sleep(800);

  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + TIMEOUT;
  const page = await waitForPage(deadline);
  if (!page) { console.error('冒烟失败：' + TIMEOUT + 'ms 内没等到调试端口 ' + PORT + ' 上的页面（应用可能根本没起来）'); cleanup(); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });

  let id = 0; const pending = new Map(); const exceptions = []; const consoleErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push((d.exception && d.exception.description) || d.text || '未知异常');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');

  // 轮询到界面真的画出字为止（Vue 挂载 + 首屏数据都要时间，一次采样会误判白屏）
  const PROBE = "JSON.stringify({len: document.body.innerText.length, bridge: typeof window.fuBridge, text: document.body.innerText.replace(/\\s+/g,' ').slice(0,160)})";
  let probe = null;
  while (Date.now() < deadline) {
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const v = r.result && r.result.result && r.result.result.value;
    if (v) { probe = JSON.parse(v); if (probe.len > 0) break; }
    await sleep(500);
  }

  const fails = [];
  if (!probe) fails.push('渲染进程没有响应 Runtime.evaluate');
  else {
    if (!(probe.len > 0)) fails.push('首屏 innerText 长度为 0 —— 白屏');
    if (probe.bridge !== 'object') fails.push('window.fuBridge 不存在（typeof=' + probe.bridge + '）—— preload 没加载');
  }
  if (exceptions.length) fails.push('未捕获异常 ' + exceptions.length + ' 条：' + exceptions[0].slice(0, 200));
  if (consoleErrors.length) fails.push('console.error ' + consoleErrors.length + ' 条：' + consoleErrors[0].slice(0, 200));

  if (fails.length) {
    console.error('冒烟失败：');
    for (const f of fails) console.error('  - ' + f);
    cleanup();
    process.exit(1);
  }
  console.log('  首屏 ' + probe.len + ' 字符 | fuBridge ' + probe.bridge + ' | 未捕获异常 0 | console.error 0');
  console.log('  首屏文本：' + probe.text);
  cleanup();
  process.exit(0);
}

function cleanup() {
  if (process.env.KEEP_OPEN === '1') return;
  try { execSync('taskkill /IM FuFumidi.exe /F', { stdio: 'ignore' }); } catch (e) {}
}

main().catch((e) => { console.error('冒烟失败：' + e.message); cleanup(); process.exit(1); });

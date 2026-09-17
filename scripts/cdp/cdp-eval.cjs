// 通用 CDP 求值：在虚拟机里那套 FuFumidi 的渲染进程执行一段表达式并打印结果。
// 用法：$env:CDP_PORT='9330'; $env:EXPR='JSON.stringify(document.title)'; node cdp-eval.cjs
'use strict';
const fs = require('fs');
const http = require('http');
const PORT = Number(process.env.CDP_PORT || 9330);
// 表达式含引号/|| 等符号时经 PowerShell 传参会被拆坏，改用文件传递
const EXPR = process.env.EXPR_FILE ? fs.readFileSync(process.env.EXPR_FILE, 'utf8') : (process.env.EXPR || 'document.title');
const TIMEOUT = Number(process.env.EVAL_TIMEOUT || 120000);

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true }),
    sleep(TIMEOUT).then(() => null),
  ]);
  if (!r) { console.log('（求值超时 ' + TIMEOUT + 'ms）'); process.exit(2); }
  if (r.result && r.result.exceptionDetails) {
    console.log('异常: ' + ((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text));
  } else {
    const v = r.result && r.result.result && r.result.result.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  process.exit(0);
}
main().catch((e) => { console.error('异常: ' + e.message); process.exit(1); });

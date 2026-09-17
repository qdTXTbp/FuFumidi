// 冷启动路径验证：在页面脚本执行前注入「Synth 构造必失败」，看初始化失败后
//   (a) 报的是不是「注入的初始化失败」而不是 player 为 null 的崩溃
//   (b) 撤掉注入后能否重新初始化成功（半初始化单例是否会永久砖住）
// 旧实现下 (a) 会是 "Cannot read properties of null (reading 'stop')"、(b) 会失败。
'use strict';
const http = require('http');
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await send('Page.enable');
  await send('Runtime.enable');
  const ev = async (expr, t = 60000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(t).then(() => null)]);
    if (!r) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception || {}).description };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  // 在任何页面脚本之前注入：createGain 在开关打开时抛异常（Synth 构造函数第一个动作就是它）
  const src = `(() => {
    window.__injectInitFail = true;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const proto = Ctor.prototype;
    const orig = proto.createGain;
    proto.createGain = function () {
      if (window.__injectInitFail) throw new Error('注入的初始化失败');
      return orig.apply(this, arguments);
    };
  })();`;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  await send('Page.reload', { ignoreCache: true });
  await sleep(10000);

  const out = {};
  out.playerAfterFailedInit = await ev(`window.__fufumidiActivePlayer ? 'object' : String(window.__fufumidiActivePlayer)`);
  out.firstSelect = await ev(`(async () => {
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    const pick = st.songs.find(s => s.name && !/large-60k/i.test(s.name));
    try { await st.selectSong(pick.id); return 'unexpected-ok'; }
    catch (e) { return 'throw: ' + (e && e.message); }
  })()`, 90000);

  // 撤掉注入，再选一次：事务式初始化下应当能重新建起来
  out.secondSelect = await ev(`(async () => {
    window.__injectInitFail = false;
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    const pick = st.songs.find(s => s.name && !/large-60k/i.test(s.name));
    try { await st.selectSong(pick.id); return 'ok'; }
    catch (e) { return 'throw: ' + (e && e.message); }
  })()`, 90000);
  await sleep(1200);
  out.playerAfterRetry = await ev(`window.__fufumidiActivePlayer ? 'object' : String(window.__fufumidiActivePlayer)`);

  // 出声验证
  out.rms = await ev(`(async () => {
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    if (!st.playing) st.togglePlay();
    await new Promise(r => setTimeout(r, 3000));
    const syn = window.__fufumidiActivePlayer && window.__fufumidiActivePlayer.syn;
    if (!syn) return 'no-synth';
    const td = new Uint8Array(syn.analyser.fftSize);
    syn.analyser.getByteTimeDomainData(td);
    let s2 = 0; for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; s2 += v * v; }
    const r = +Math.sqrt(s2 / td.length).toFixed(4);
    if (st.playing) st.togglePlay();
    return r;
  })()`, 90000);

  await send('Page.addScriptToEvaluateOnNewDocument', { source: '/* 覆盖为无害脚本 */' });
  console.log(JSON.stringify(out, null, 2));
  let pass = 0, fail = 0;
  const check = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); } };
  console.log('');
  check('初始化失败时没有留下可用的 player 实例（不留半初始化单例）', out.playerAfterFailedInit !== 'object',
    String(out.playerAfterFailedInit) + '（null/undefined 都算「没有可用实例」）');
  check('失败以「原始错误」暴露，而不是 player 为 null 的二级崩溃',
    /注入的初始化失败/.test(String(out.firstSelect)),
    String(out.firstSelect) + '（旧实现会是 Cannot read properties of null (reading \'stop\')）');
  check('撤掉故障后可重新初始化（不会永久砖住）', out.secondSelect === 'ok', String(out.secondSelect));
  check('重试后 player 就位', out.playerAfterRetry === 'object', String(out.playerAfterRetry));
  check('重试后能正常出声', typeof out.rms === 'number' && out.rms > 0.02, 'rms=' + out.rms);
  console.log('\n===== PASS ' + pass + ' / FAIL ' + fail + ' =====');
  try { ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('异常: ' + e.message); process.exit(2); });

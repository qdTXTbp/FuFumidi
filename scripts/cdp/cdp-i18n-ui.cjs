// 多语言实测：切换 zh / en / ja / zh-Hant，核对「UTAU 声库资源」区块是否真正翻译（而非回退源文案）
'use strict';
const http = require('http');
const PORT = Number(process.env.CDP_PORT || 9223);
const hardKill = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 300000);
function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => resolve(JSON.parse(b)));
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('http timeout')); });
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
  const ev = async (expr, t = 60000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(t).then(() => null)]);
    if (r && r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text };
    return r && r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable');
  await send('Page.enable').catch(() => {});

  const CJK = /[\u4e00-\u9fff\u3040-\u30ff]/;
  const SIMP = /[声库里统默认设置视频录教程将个为这会说进过还]/;   // 简单判据：出现即为未转换/未翻译

  // 抓取资源中心「UTAU 声库资源」区块的关键可见文本
  const probe = `(async () => {
    location.hash = '#/resources?tab=resources';
    await new Promise(r => setTimeout(r, 2600));
    const secs = [...document.querySelectorAll('.res-sec')];
    const sec = secs.find(s => document.querySelector('.vbs-card') && s.contains(document.querySelector('.vbs-card')));
    const cards = [...document.querySelectorAll('.vbs-card')];
    const card = cards[2] || cards[0];   // 第三张 = 陈者（中文単独音）
    return {
      title: sec ? (sec.querySelector('.res-sec-head') || {}).innerText : '',
      cardName: card && card.querySelector('.vbs-name') ? card.querySelector('.vbs-name').innerText : '',
      lang: card && card.querySelector('.vbs-meta') ? card.querySelector('.vbs-meta').innerText : '',
      license: card && card.querySelector('.vbs-license') ? card.querySelector('.vbs-license').innerText : '',
      // 首张卡的按钮文案（用于按钮翻译校验）
      btn: (() => { const b = cards[0] ? [...cards[0].querySelectorAll('button')].map(x => x.innerText.trim()) : []; return b.join('|'); })(),
      html: (document.documentElement.getAttribute('lang') || '') + '|' + (localStorage.getItem('fufumidi_lang') || ''),
    };
  })()`;

  const results = {};
  for (const lang of ['zh', 'en', 'ja', 'zh-Hant']) {
    await ev(`localStorage.setItem('fufumidi_lang', ${JSON.stringify(lang)}); true`);
    await ev(`location.reload()`);
    await sleep(4200);
    const r = await ev(probe);
    results[lang] = r;
    console.log('[' + lang + '] ' + JSON.stringify(r));
  }

  let pass = 0, total = 0;
  const ck = (n, ok, extra) => { total++; if (ok) pass++; console.log((ok ? '  ok  ' : '  FAIL') + ' ' + n + (extra !== undefined ? ' :: ' + extra : '')); };

  const zh = results.zh, en = results.en, ja = results.ja, ht = results['zh-Hant'];

  ck('zh 显示简体源文案', zh && zh.title === 'UTAU 声库资源' && zh.cardName.includes('陈者'), zh && (zh.title + ' / ' + zh.cardName));
  ck('en 区块标题已译为英文（无 CJK）', en && en.title && !CJK.test(en.title), en && en.title);
  ck('en 卡片名已译为英文（无 CJK）', en && en.cardName && !CJK.test(en.cardName), en && en.cardName);
  ck('en 语言/录音方式已译（无 CJK）', en && en.lang && !CJK.test(en.lang), en && en.lang);
  ck('en 使用条款已译（无残留简体）', en && en.license && !SIMP.test(en.license), en && en.license);
  ck('en 按钮已译', en && /UTAU/.test(en.btn) && !CJK.test(en.btn.replace(/UTAU/g, '')), en && en.btn);
  ck('ja 区块标题已译为日文（≠ 源文案）', ja && ja.title && ja.title !== zh.title, ja && ja.title);
  ck('ja 卡片名已译（陳者）', ja && ja.cardName && /陳者/.test(ja.cardName) && ja.cardName !== zh.cardName, ja && ja.cardName);
  ck('ja 使用条款已译', ja && ja.license && ja.license !== zh.license, ja && ja.license);
  ck('zh-Hant 标题自动转繁（含「聲庫」）', ht && /聲庫/.test(ht.title), ht && ht.title);
  ck('zh-Hant 卡片名自动转繁（陳者 + 單獨音）', ht && /陳者/.test(ht.cardName) && /單獨音/.test(ht.cardName), ht && ht.cardName);
  ck('zh-Hant 条款用词已转（條款 + 無殘留簡體）', ht && /條款/.test(ht.license) && !SIMP.test(ht.license), ht && ht.license);

  // 恢复简体
  await ev(`localStorage.setItem('fufumidi_lang', 'zh'); true`);
  await ev(`location.reload()`); await sleep(3500);

  console.log('== 结果: PASS ' + pass + ' / ' + total + ' ==');
  clearTimeout(hardKill);
  process.exit(pass === total ? 0 : 1);
}
main().catch((e) => { console.error('failed:', e && e.message); process.exit(2); });

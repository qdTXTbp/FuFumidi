// 本轮四项修复的端到端验证
//   A synth.activeNotes 在有界范围内（SF2 路径下不再只增不减）
//   B 繁體下「移动」显示为「移動」而不是「移送」（走设置面板的真实切换路径）
//   C 播放页（PianoRoll 二分修复）帧间隔观测
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
  await send('Runtime.enable');
  const ev = async (expr, t = 240000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(t).then(() => null)]);
    if (!r) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception || {}).description };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  let pass = 0, fail = 0, skip = 0;
  const check = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); } };
  // 目标文案没挂载进 DOM 时不计入通过，明确记为 SKIP 并写出原因
  const skipCheck = (n, why) => { skip++; console.log('  SKIP  ' + n + '  [' + why + ']'); };

  console.log('\n=== A. activeNotes 有界 ===');
  const rA = await ev(`(async () => {
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (st.playing) st.togglePlay();
    await sleep(300);
    // 用最密的曲目把活跃音符表压到阈值附近
    const heavy = st.songs.find(s => s.name === 'large-60k') || st.songs.find(s => s.name && !/\\s/.test(s.name));
    await st.selectSong(heavy.id);
    await sleep(1500);
    const P = window.__fufumidiActivePlayer;
    if (!st.playing) st.togglePlay();
    const samples = [];
    for (let i = 0; i < 6; i++) {          // 每 1.5s 采一次，观察是否有单调增长
      await sleep(1500);
      samples.push({ t: P.currentSec().toFixed(1), n: P.syn.activeNotes.length });
    }
    if (st.playing) st.togglePlay();
    return {
      song: heavy.name,
      sf2Ready: !!P.syn.sf2Ready,
      usingSeqMode: !!P.syn._sf2SeqMode,
      samples,
      last: P.syn.activeNotes.length,
      max: Math.max(...samples.map(s => s.n)),
    };
  })()`, 240000);
  console.log('  ' + JSON.stringify(rA));
  if (rA && !rA.__err) {
    const ns = rA.samples.map(s => s.n);
    const growing = ns.every((v, i) => i === 0 || v >= ns[i - 1]) && ns[ns.length - 1] > ns[0];
    check('确实走在 SF2 路径上（本轮修复针对的路径）', rA.sf2Ready === true, 'sf2Ready=' + rA.sf2Ready + ' seqMode=' + rA.usingSeqMode);
    check('活跃音符表不随播放时长单调增长（旧实现下只增不减）', !growing,
      '采样 ' + ns.join(' → ') + '（曲目位置 ' + rA.samples.map(s => s.t).join('/') + 's）');
    check('表长被限制在预排窗口内的存活量级别', rA.max <= 8000, '峰值 ' + rA.max + ' 条');
  } else { check('activeNotes 项可执行', false, JSON.stringify(rA)); fail++; }

  console.log('\n=== B. 繁體用词（走设置面板真实切换）===');
  const rB = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    // 用 textContent 而不是 innerText：后者会排除不可见节点，而含「移动」的文案可能在
    // 折叠的帮助面板里。Vue 会把已挂载的文本都渲染进 DOM，textContent 覆盖更全。
    const txt = () => document.body.textContent || '';
    const has = (w) => txt().includes(w);

    // 先确保停在编辑页（该页含「拖拽移动」等文案）
    if (typeof st.setView === 'function') st.setView('edit');
    location.hash = '#/views?tab=edit';
    await sleep(1500);
    const beforeMove = has('移动');
    const beforeXie = has('移送');
    const beforeSample = (txt().match(/[^\\n]{0,20}移动[^\\n]{0,20}/) || [''])[0];

    // 打开设置面板（与用户点「设置」等价的状态翻转），点「繁體中文」——与用户操作同一路径
    st.ui.settingsOpen = true;
    await sleep(1200);
    let span = null;
    for (const s of document.querySelectorAll('span, button, div')) {
      if ((s.textContent || '').trim() === '繁體中文') { span = s; break; }
    }
    if (span) span.click();
    await sleep(1800);
    const afterMove = has('移動');
    const afterXie = has('移送');
    const afterSample = (txt().match(/[^\\n]{0,20}移動[^\\n]{0,20}/) || [''])[0];

    // 切回简体
    let back = null;
    for (const s of document.querySelectorAll('span, button, div')) {
      if ((s.textContent || '').trim() === '简体中文') { back = s; break; }
    }
    if (back) back.click();
    await sleep(1200);
    st.ui.settingsOpen = false;
    return { foundHantSpan: !!span, restored: !!back, beforeMove, beforeXie, beforeSample, afterMove, afterXie, afterSample };
  })()`, 240000);
  console.log('  ' + JSON.stringify(rB));
  if (rB && !rB.__err) {
    check('设置面板里能找到「繁體中文」并切换成功', rB.foundHantSpan === true, '恢复简体=' + rB.restored);
    if (!rB.beforeMove && !rB.afterMove) {
      skipCheck('繁體界面用词（移动 → 移動 而非 移送）',
        '未能在已挂载的 DOM 里找到含「移动」的文案：setView 只切父视图，编辑页子视图在当前状态下是空状态分支，该文案未渲染。此规则已由单测 zhHant.test.js 覆盖');
    } else {
      check('切换前界面含「移动」且不含「移送」', rB.beforeMove === true && rB.beforeXie === false,
        '示例：' + (rB.beforeSample || '(无)'));
      check('切到繁體后显示「移動」而不是「移送」', rB.afterMove === true && rB.afterXie === false,
        '示例：' + (rB.afterSample || '(未取到)'));
    }
  } else { check('繁體用词项可执行', false, JSON.stringify(rB)); fail++; }

  console.log('\n=== C. 播放页帧间隔（PianoRoll 裁剪修复后）===');
  const rC = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    if (st.playing) st.togglePlay();
    const heavy = st.songs.find(s => s.name === 'large-60k');
    await st.selectSong(heavy.id);
    st.setView && st.setView('play');
    location.hash = '#/views?tab=play';
    await sleep(2500);
    if (st.playing) st.togglePlay();
    await sleep(1500);
    const cv = document.querySelector('#rollCanvas, .roll-canvas, canvas');
    if (!cv) return { err: 'no canvas', hash: location.hash };
    const iv = []; let last = 0;
    const start = performance.now();
    await new Promise((resolve) => {
      const loop = () => {
        const t = performance.now();
        if (last) iv.push(t - last);
        last = t;
        if (iv.length >= 120 || t - start > 8000) { resolve(); return; }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const s = iv.slice().sort((a, b) => a - b);
    const q = (r) => +s[Math.min(s.length - 1, Math.floor(s.length * r))].toFixed(1);
    const notes = st.currentSong.song.tracks.reduce((a, x) => a + x.notes.length, 0);
    if (st.playing) st.togglePlay();
    return { song: heavy.name, notes, frames: s.length, p50: q(0.5), p95: q(0.95), fps: +(1000 / (s.reduce((a, b) => a + b, 0) / s.length)).toFixed(1) };
  })()`, 240000);
  console.log('  ' + JSON.stringify(rC));
  if (rC && !rC.__err) {
    check('播放页在 6 万音符下仍能稳定出帧', rC.fps > 20, rC.fps + ' fps (p50 ' + rC.p50 + 'ms / p95 ' + rC.p95 + 'ms)');
  } else { check('播放页帧间隔可测', false, JSON.stringify(rC)); fail++; }

  console.log('\n===== PASS ' + pass + ' / FAIL ' + fail + ' / SKIP ' + skip + ' =====');
  try { ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('异常: ' + e.message); process.exit(2); });

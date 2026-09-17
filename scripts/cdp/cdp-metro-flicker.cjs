// 本轮两项修复的端到端验证
//   A 节拍器可关闭：开启→排队→暂停→画布/音频侧确认不再有点击声响
//   B 瀑布流滚动平滑度：逐帧变化量的波动（CoV），越低越平滑
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
  let pass = 0, fail = 0;
  const check = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); } };

  console.log('\n=== A. 节拍器：关闭 / 暂停后不应再响 ===');
  const rA = await ev(`(async () => {
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = st.songs.find(s => s.name && !/large-60k/i.test(s.name));
    if (st.playing) st.togglePlay();
    await sleep(300);
    await st.selectSong(pick.id);
    await sleep(1500);
    const P = window.__fufumidiActivePlayer;

    // 开启节拍器并播放，等它把窗口内的拍点排满
    P.setMetronome(true);
    st.toggleMetro && (st.metro === false) && st.toggleMetro();
    if (!st.playing) st.togglePlay();
    await sleep(2500);
    const queued = P._metroNodes.length;

    // 统计点击声的实际电平：把 master 音量调到 0 不现实（点击声也走 master），
    // 改为直接暂停 —— 暂停后音符全停，此时若还有声音就只可能是节拍器
    P.pause();
    const stoppedLen = P._metroNodes.length;
    // 分两段看：停止瞬间的正常余音（允许有），以及之后是否持续有点击声（旧实现下
    // 58 声已排队的点击会按原时间轴每隔约 0.5s 继续响）
    const syn = P.syn;
    const sample = async (ms) => {
      let mx = 0; const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await sleep(40);
        const td = new Uint8Array(syn.analyser.fftSize);
        syn.analyser.getByteTimeDomainData(td);
        for (let k = 0; k < td.length; k++) { const dv = Math.abs(td[k] - 128); if (dv > mx) mx = dv; }
      }
      return mx;
    };
    const tailMax = await sample(300);      // 停止瞬间的余音
    const quietMax = await sample(1800);    // 之后应彻底安静

    // 灵敏度对照（负向对照）：临时插一个短促方波，确认这个采样确实读得到声音。
    // 没有这一步的话，「quietMax 很小」也可能只是采样读不到任何东西 —— 那样阈值再紧也
    // 发现不了真泄漏。读数与注入幅度是线性的：gain 0.12 经 master(0.85) 后约 0.10 幅度，
    // 实测正好读到 13/255；这里用 0.5 让读数稳定高于静音上限。
    const probeLevel = await (async () => {
      const ctx = syn.ctx;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 1000; g.gain.value = 0.5;
      o.connect(g); g.connect(syn.master);
      o.start();
      const mx = await sample(350);
      try { o.stop(); } catch (e) {}
      try { g.disconnect(); } catch (e) {}
      return mx;
    })();
    const afterProbeQuiet = await sample(600);

    P.setMetronome(false);
    return { queued, stoppedLen, tailMax, quietMax, probeLevel, afterProbeQuiet, playing: st.playing };
  })()`, 240000);
  console.log('  ' + JSON.stringify(rA));
  if (rA && !rA.__err) {
    // 阈值 8/255（约 -30 dBFS）：暂停后的残余是「已在响的音符的衰减尾巴」，实测 1~4/255；
    // 而一个节拍器点击是短促瞬态，量级远高于此。原来的阈值 2 落在尾巴的波动范围内，会偶发误报。
    const QUIET_LIMIT = 8;
    check('开启后确有拍点被预排（存在会被遗留的点击声）', rA.queued > 5, '排队 ' + rA.queued + ' 声');
    check('暂停后登记表被清空', rA.stoppedLen === 0, '剩 ' + rA.stoppedLen);
    check('采样灵敏度足够（注入短促音可被读到，读数须显著高于静音上限）', rA.probeLevel > QUIET_LIMIT * 2,
      '注入音读数 ' + rA.probeLevel + '/255（静音上限 ' + QUIET_LIMIT + '）');
    check('暂停后不再持续有点击声（1.8s 窗口内接近静音）', rA.quietMax <= QUIET_LIMIT,
      '余音段 ' + rA.tailMax + '/255，其后 ' + rA.quietMax + '/255（上限 ' + QUIET_LIMIT + '）');
  } else { check('节拍器项可执行', false, JSON.stringify(rA)); fail++; }

  console.log('\n=== B. 瀑布流滚动平滑度（逐帧变化量的波动）===');
  const rB = await ev(`(async () => {
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 场景必须固定，否则 CoV 随「当前是哪首歌、停在哪个位置、哪个布局」乱跳：
    // 之前这个探针复用已载入的曲目，于是同一份代码能测出 12.6% 也能测出 21.9%。
    const pick = (window.__probeSongKey && st.songs.find(s => s.name === window.__probeSongKey))
      || st.songs.find(s => s.name && !/large/i.test(s.name));
    if (st.playing) st.togglePlay();
    await sleep(300);
    await st.selectSong(pick.id);
    if (typeof st.setView === 'function') st.setView('viz');
    location.hash = '#/views?tab=viz';
    await sleep(2500);
    let clickedWaterfall = false;
    for (const el of document.querySelectorAll('button, .chip-btn, span, div')) {
      if ((el.textContent || '').trim() === '瀑布流' && el.children.length === 0) { el.click(); clickedWaterfall = true; break; }
    }
    await sleep(1200);
    const cv = document.getElementById('vizRoll');
    const g = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    if (typeof st.seekRatio === 'function') st.seekRatio(0.4);
    await sleep(1200);
    if (!st.playing) st.togglePlay();
    await sleep(2000);
    return await new Promise((resolve) => {
      const orig = g.clearRect.bind(g);
      let prev = null;
      const counts = [];
      g.clearRect = function (x, y, w, h) {
        if (prev && prev.w === cv.width && prev.h === cv.height) {
          const cur = g.getImageData(0, 0, cv.width, cv.height).data;
          let n = 0;
          for (let i = 0; i < cur.length; i += 4) {
            if (Math.abs(cur[i] - prev.data[i]) > 6 || Math.abs(cur[i + 1] - prev.data[i + 1]) > 6 || Math.abs(cur[i + 2] - prev.data[i + 2]) > 6) n++;
          }
          counts.push(n);
        }
        prev = { w: cv.width, h: cv.height, data: g.getImageData(0, 0, cv.width, cv.height).data };
        if (counts.length >= 40) {
          g.clearRect = orig;
          const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
          const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
          if (st.playing) st.togglePlay();
          resolve({
            frames: counts.length, mean: Math.round(mean), std: Math.round(sd),
            covPct: mean > 0 ? +(sd / mean * 100).toFixed(1) : null,
            min: Math.min(...counts), max: Math.max(...counts), dpr,
            song: pick.name, clickedWaterfall,
            canvasCss: { w: Math.round(cv.clientWidth), h: Math.round(cv.clientHeight) },
          });
          return;
        }
        return orig(x, y, w, h);
      };
    });
  })()`, 240000);
  console.log('  ' + JSON.stringify(rB));
  if (rB && !rB.__err) {
    // 空测量保护：画面没有变化（mean=0）说明播放没起来或画布没重绘，此时 CoV 是 null，
    // 直接拿去比阈值会「静默通过」（null < 14 为真）—— 必须判为无效测量。
    const valid = rB.frames === 40 && rB.mean > 0 && rB.covPct != null;
    check('平滑度测量有效（40 帧、画面确有变化）', valid,
      valid ? ('mean=' + rB.mean + ' / CoV=' + rB.covPct + '%') : JSON.stringify(rB));
    if (valid) {
      // 阈值取自同场景配对测量：修复后四次为 13.0 / 14.8 / 16.0 / 16.4%，修复前（4.2.2）为 21.3%。
      // 取 19% 让两侧各留约 2.6pp 余量：既不会因噪声误报，又能在退回「按像素吸附」时必然失败。
      check('逐帧变化量波动（CoV）低于阈值（同口径修复前 21.3%）', rB.covPct < 19, 'CoV=' + rB.covPct + '%');
    }
  } else { check('平滑度项可执行', false, JSON.stringify(rB)); fail++; }

  console.log('\n===== PASS ' + pass + ' / FAIL ' + fail + ' =====');
  try { ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('异常: ' + e.message); process.exit(2); });

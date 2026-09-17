// 帧时间基线对照用的统一测量协议。
// 口径固定：同一首歌、非沉浸的瀑布流布局、同一段 150 帧、量「相邻两次画布清屏的间隔」。
// 用法：$env:SONG='normal'|'heavy'; node cdp-frametime-probe.cjs
'use strict';
const http = require('http');
const PORT = Number(process.env.CDP_PORT || 9222);
const SONG = process.env.SONG || 'normal';
const SEEK_RATIO = String(Number(process.env.SEEK_RATIO || 0.4));
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

  const out = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
    const wantHeavy = ${SONG === 'heavy'};
    const pick = wantHeavy
      ? (st.songs.find(s => s.name === 'large-60k') || st.songs.find(s => /large/i.test(s.name)))
      : st.songs.find(s => s.name && !/large/i.test(s.name));
    if (!pick) return { err: '找不到目标曲目', names: st.songs.slice(0, 6).map(s => s.name) };

    // 统一到可视化页的瀑布流布局；若该版本支持沉浸模式，确保不处于沉浸态
    if (st.immersive === true && typeof st.setImmersive === 'function') st.setImmersive(false);
    if (st.playing) st.togglePlay();
    await sleep(400);
    await st.selectSong(pick.id);
    if (typeof st.setView === 'function') st.setView('viz');
    location.hash = '#/views?tab=viz';
    await sleep(2500);
    // 显式切到瀑布流：该布局在旧版里是组件内的 ref，不在 store，只能点界面按钮。
    // 不统一切布局的话两个版本的画布高度不同（258 vs 480），比较没有意义。
    let clickedWaterfall = false;
    for (const el of document.querySelectorAll('button, .chip-btn, span, div')) {
      if ((el.textContent || '').trim() === '瀑布流' && el.children.length === 0) { el.click(); clickedWaterfall = true; break; }
    }
    await sleep(1500);
    // 兜底：也试一下 store 里可能存在的布局字段
    for (const k of ['setVizLayout', 'setLayout']) {
      if (typeof st[k] === 'function') { try { st[k]('waterfall'); } catch (e) {} }
    }
    await sleep(800);

    const cv = document.getElementById('vizRoll');
    if (!cv) return { err: '没有 vizRoll 画布' };
    const g = cv.getContext('2d');
    // 定位到固定位置再量：歌曲不同段落屏上的音符密度差别很大，位置不同会让两次测量不可比
    const seekTo = ${SEEK_RATIO};
    const posBefore = typeof st.curSec === 'number' ? +st.curSec.toFixed(2) : null;
    let seeked = false;
    if (typeof st.seekRatio === 'function') { st.seekRatio(seekTo); seeked = true; }
    else if (typeof st.seekSec === 'function' && st.totalSec) { st.seekSec(st.totalSec * seekTo); seeked = true; }
    await sleep(1500);
    const posAfter = typeof st.curSec === 'number' ? +st.curSec.toFixed(2) : null;
    if (!st.playing) st.togglePlay();
    await sleep(800);

    const measure = () => new Promise((resolve) => {
      const orig = g.clearRect.bind(g);
      const iv = []; let last = 0;
      g.clearRect = function (x, y, w, h) {
        const t = performance.now();
        if (last) iv.push(t - last);
        last = t;
        if (iv.length >= 150) {
          g.clearRect = orig;
          const s = iv.slice().sort((a, b) => a - b);
          const q = (r) => +s[Math.min(s.length - 1, Math.floor(s.length * r))].toFixed(2);
          resolve({ p50: q(0.5), p95: q(0.95), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) });
          return;
        }
        return orig(x, y, w, h);
      };
    });

    const passes = [];
    for (let i = 0; i < 3; i++) {
      const pos = typeof st.curSec === 'number' ? +st.curSec.toFixed(1) : null;
      const r = await measure();
      passes.push(Object.assign({ atSec: pos }, r));
    }
    const notes = st.currentSong && st.currentSong.song ? st.currentSong.song.tracks.reduce((a, x) => a + x.notes.length, 0) : 0;
    const dpr = window.devicePixelRatio || 1;
    if (st.playing) st.togglePlay();
    return {
      song: pick.name, notes, clickedWaterfall,
      seek: { wanted: seekTo, seeked, posBefore, posAfter, totalSec: typeof st.totalSec === 'number' ? +st.totalSec.toFixed(2) : null },
      canvasCss: { w: Math.round(cv.clientWidth), h: Math.round(cv.clientHeight) },
      dpr, passes,
    };
  })()`, 240000);
  console.log(JSON.stringify(out, null, 1));
  try { ws.close(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('异常: ' + e.message); process.exit(2); });

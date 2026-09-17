// 可视化页「帧内绘制耗时」探针：量每帧从画布清屏到本帧最后一次绘制调用的时间跨度。
// 与帧交付间隔的区别：交付间隔被应用自带的 60fps 限流夹住（跑满即饱和），
// 帧内耗时才是能看出几毫秒级回归的量。
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const SONG = (window.__probeSong || 'heavy');
  const pick = SONG === 'heavy'
    ? (st.songs.find(s => s.name === 'large-60k') || st.songs.find(s => /large/i.test(s.name)))
    : st.songs.find(s => s.name && !/large/i.test(s.name));
  if (!pick) return { err: '找不到曲目' };

  if (st.immersive === true && typeof st.setImmersive === 'function') st.setImmersive(false);
  if (st.playing) st.togglePlay();
  await sleep(400);
  await st.selectSong(pick.id);
  if (typeof st.setView === 'function') st.setView('viz');
  location.hash = '#/views?tab=viz';
  await sleep(2500);
  let clickedWaterfall = false;
  for (const el of document.querySelectorAll('button, .chip-btn, span, div')) {
    if ((el.textContent || '').trim() === '瀑布流' && el.children.length === 0) { el.click(); clickedWaterfall = true; break; }
  }
  await sleep(1500);

  const cv = document.getElementById('vizRoll');
  if (!cv) return { err: '没有 vizRoll 画布' };
  const g = cv.getContext('2d');
  if (typeof st.seekRatio === 'function') st.seekRatio(0.4);
  await sleep(1500);

  // 探针：一帧 = 从 clearRect 到该帧最后一次绘制调用
  if (!window.__drawCost) {
    const P = CanvasRenderingContext2D.prototype;
    const D = window.__drawCost = { on: false, t0: 0, last: 0, spans: [], gaps: [], prevClear: 0, grad: 0, frames: 0 };
    const mark = () => { if (D.on) D.last = performance.now(); };
    const origClear = P.clearRect;
    P.clearRect = function (x, y, w, h) {
      if (D.on && D.t0) {
        D.spans.push(D.last - D.t0);
        D.frames++;
        const now = performance.now();
        if (D.prevClear) D.gaps.push(now - D.prevClear);
        D.prevClear = now;
        if (D.spans.length >= 150) D.on = false;
      }
      D.t0 = performance.now(); D.last = D.t0;
      return origClear.call(this, x, y, w, h);
    };
    for (const k of ['roundRect', 'fill', 'stroke', 'fillRect', 'fillText', 'arc', 'moveTo', 'lineTo']) {
      const o = P[k];
      if (!o) continue;
      P[k] = function () { mark(); return o.apply(this, arguments); };
    }
    const origGrad = P.createLinearGradient;
    P.createLinearGradient = function () { if (D.on) D.grad++; return origGrad.apply(this, arguments); };
  }
  if (!st.playing) st.togglePlay();
  const D = window.__drawCost;
  const grab = async () => {
    D.spans = []; D.gaps = []; D.prevClear = 0; D.grad = 0; D.frames = 0; D.on = true;
    const t0 = performance.now();
    while (D.on && performance.now() - t0 < 30000) await sleep(100);
    D.on = false;
    const stat = (arr) => {
      const s = arr.slice().sort((a, b) => a - b);
      const q = (r) => s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * r))].toFixed(2) : null;
      return { p50: q(0.5), p95: q(0.95), max: s.length ? +s[s.length - 1].toFixed(2) : null, mean: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) : null };
    };
    return { frames: D.frames, drawMs: stat(D.spans), clearGapMs: stat(D.gaps), gradientsPerFrame: D.frames ? +(D.grad / D.frames).toFixed(1) : null };
  };
  const playing = await grab();
  // 对照：暂停后（不再建音符节点、能量归零，但画布仍在重绘）同一指标
  if (st.playing) st.togglePlay();
  await sleep(1200);
  const paused = await grab();

  return {
    song: pick.name, clickedWaterfall,
    canvasCss: { w: Math.round(cv.clientWidth), h: Math.round(cv.clientHeight) },
    playing, paused,
  };
})()

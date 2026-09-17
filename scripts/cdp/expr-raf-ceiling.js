// 量「当前窗口状态下的刷新节奏上限」：纯 rAF 回调间隔，不做任何绘制。
// 用途：判断帧时间对照里的 16.7ms 是不是被合成器上限（遮挡节流 / 面板刷新率）截出来的。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (window.__rafProbe) return { err: '已有探针在跑' };
  window.__rafProbe = true;
  const measure = () => new Promise((resolve) => {
    const iv = []; let last = 0;
    const loop = (t) => {
      if (last) iv.push(t - last);
      last = t;
      if (iv.length >= 150) {
        const s = iv.slice().sort((a, b) => a - b);
        const q = (r) => +s[Math.min(s.length - 1, Math.floor(s.length * r))].toFixed(2);
        return resolve({ p50: q(0.5), p95: q(0.95), min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2) });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const a = await measure();
  await sleep(300);
  const b = await measure();
  window.__rafProbe = false;
  return { visibility: document.visibilityState, hasFocus: document.hasFocus(), dpr: window.devicePixelRatio, pass1: a, pass2: b };
})()

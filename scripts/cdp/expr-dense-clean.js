(async () => {
  const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const syn = window.__fufumidiActivePlayer.syn;

  // 重置之前几轮探针留下的包装，重新只挂一层
  if (syn.__clean) syn.pruneLive = syn.__clean;
  if (!syn.__clean) syn.__clean = syn.pruneLive;
  syn.pruneLive = syn.__clean;                 // 确保是原始实现
  syn.__clean = syn.pruneLive;
  syn.__stat = { expired: 0, earlyPending: 0, earlySounding: 0, earlyNoStart: 0, calls: 0, grossCreate: 0 };
  const origPrune = syn.pruneLive;
  syn.pruneLive = function (limit) {
    const before = this.live.slice();
    const t = this.ctx.currentTime;
    const r = origPrune.call(this, limit);
    const after = new Set(this.live);
    for (const x of before) {
      if (after.has(x)) continue;
      if (x.tStop <= t) { syn.__stat.expired++; continue; }
      if (x.tStart == null) syn.__stat.earlyNoStart++;
      else if (x.tStart > t) syn.__stat.earlyPending++;
      else syn.__stat.earlySounding++;
    }
    syn.__stat.calls++;
    return r;
  };
  const origOsc = syn.ctx.createOscillator.bind(syn.ctx);
  syn.ctx.createOscillator = function () { syn.__stat.grossCreate++; return origOsc(); };
  const origBuf = syn.ctx.createBufferSource.bind(syn.ctx);
  syn.ctx.createBufferSource = function () { syn.__stat.grossCreate--; return origBuf(); }; // 缓冲源不计入（噪声源）

  const it = st.songs.find(s => s.name === 'large-60k');
  if (st.playing) st.togglePlay();
  await sleep(300);
  await st.selectSong(it.id);
  await sleep(1500);

  const t = syn.ctx.currentTime;
  let pending = 0, sounding = 0, noStart = 0;
  for (const x of syn.live) {
    if (x.tStart == null) noStart++;
    else if (x.tStart > t) pending++;
    else sounding++;
  }
  const liveComposition = { liveLen: syn.live.length, pending, sounding, noStart,
                            firstKeys: syn.live[0] ? Object.keys(syn.live[0]) : null };

  Object.assign(syn.__stat, { expired: 0, earlyPending: 0, earlySounding: 0, earlyNoStart: 0, calls: 0, grossCreate: 0 });
  if (!st.playing) st.togglePlay();
  await sleep(5000);

  const a = syn.analyser;
  const td = new Uint8Array(a.fftSize);
  a.getByteTimeDomainData(td);
  let s2 = 0; for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; s2 += v * v; }
  const secs = 5;
  const out = {
    liveCompositionAtStart: liveComposition,
    rmsPlaying: +Math.sqrt(s2 / td.length).toFixed(4),
    perSec: {
      oscillatorsCreated: +(syn.__stat.grossCreate / secs).toFixed(0),
      nodesExpiredNaturally: +(syn.__stat.expired / secs).toFixed(0),
      droppedBeforeSounding: +(syn.__stat.earlyPending / secs).toFixed(1),
      droppedWhileSounding: +(syn.__stat.earlySounding / secs).toFixed(1),
      droppedNoStart: +(syn.__stat.earlyNoStart / secs).toFixed(1),
      pruneCalls: +(syn.__stat.calls / secs).toFixed(0),
    },
    liveLenEnd: syn.live.length,
  };
  if (st.playing) st.togglePlay();
  return out;
})()
